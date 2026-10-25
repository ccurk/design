// 审核与举报：举报（驳回 / 警告 / 删除内容 / 限制 7 天 / 封号）、系统拦下的动态、用户发起的待审局。
import { computed, nextTick, onMounted, reactive, watch } from '../vue.js';
import { api } from '../api.js';
import { route } from '../router.js';
import { refreshBadges } from '../store.js';
import * as fmt from '../format.js';
import { focusSoon, html, useBanner } from '../ui.js';

const TABS = ['report', 'post', 'event'];

/** 处理方式。needsUser：需要有被举报的人才能用 */
const ACTS = [
  { key: 'dismiss', label: '驳回', needsUser: false },
  { key: 'warn', label: '警告', needsUser: true },
  { key: 'delete_content', label: '删除内容', needsUser: false },
  { key: 'restrict_7d', label: '限制 7 天', needsUser: true },
  { key: 'ban', label: '封号', needsUser: true },
];

/** 「删除内容」对不同对象实际做的事（见 server/src/services/reports.js deleteContent） */
const DELETE_DESC = {
  user: '清空 TA 的个人简介。',
  post: '删掉这条动态。',
  comment: '删掉这条评论。',
  message: '把这条群聊消息换成「一条消息因违反社区公约已被移除」。',
  event: '取消这个局，并通知报名的人。',
};

const POST_REJECT = ['包含联系方式', '广告推销', '擦边低俗', '其他'];
const EVENT_REJECT = ['像交友或约会', '有安全风险', '广告推销', '其他'];

export default {
  name: 'ModerationPage',
  setup() {
    const { banner, showBanner, failBanner, closeBanner } = useBanner();
    const s = reactive({
      tab: TABS.includes(route.query.tab) ? route.query.tab : 'report',
      loading: true,
      loaded: false,
      error: '',
      reports: [],
      posts: [],
      events: [],
      sel: { report: null, post: null, event: null },
      done: {}, // 'post:3' → '已通过' / '未通过：广告推销'（本次打开页面后处理的）
      details: {}, // 待审局的详情（介绍、集合点）
      detailError: '',
      act: '',
      note: '',
      err: '',
      banAsk: false,
      rejOpen: false,
      rejWhy: '',
      rejNote: '',
      rejErr: '',
      busy: false,
    });

    function resetAction() {
      Object.assign(s, { act: '', note: '', err: '', banAsk: false, rejOpen: false, rejWhy: '', rejNote: '', rejErr: '' });
    }

    async function load() {
      s.error = '';
      if (!s.loaded) s.loading = true;
      try {
        const [reports, posts, events] = await Promise.all([
          api('/admin/reports', { query: { status: 'pending' } }),
          api('/admin/posts', { query: { status: 'pending' } }),
          api('/admin/events', { query: { status: 'pending_review' } }),
        ]);
        s.reports = reports.items;
        s.posts = posts.items;
        s.events = events.items.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        s.loaded = true;
        const wanted = route.query.id ? Number(route.query.id) : null;
        if (wanted && listOf(s.tab).some((x) => x.id === wanted)) s.sel[s.tab] = wanted;
        for (const t of TABS) {
          if (!listOf(t).some((x) => x.id === s.sel[t])) s.sel[t] = listOf(t)[0] ? listOf(t)[0].id : null;
        }
        if (s.tab === 'event') loadEventDetail();
      } catch (e) {
        if (s.loaded) failBanner(e, '刷新失败');
        else s.error = e.message;
      } finally {
        s.loading = false;
      }
    }
    onMounted(load);
    watch(
      () => s.tab,
      () => {
        resetAction();
        if (s.tab === 'event') loadEventDetail();
      },
    );

    function listOf(tab) {
      return tab === 'report' ? s.reports : tab === 'post' ? s.posts : s.events;
    }

    const openCount = (tab) =>
      listOf(tab).filter((x) => (tab === 'report' ? x.status === 'pending' : !s.done[`${tab}:${x.id}`])).length;
    const tabs = computed(() => [
      { key: 'report', label: '举报', count: openCount('report') },
      { key: 'post', label: '动态待审', count: openCount('post') },
      { key: 'event', label: '局待审', count: openCount('event') },
    ]);

    const current = computed(() => listOf(s.tab).find((x) => x.id === s.sel[s.tab]) || null);
    const eventDetail = computed(() => (s.tab === 'event' && current.value ? s.details[current.value.id] : null));

    // ---- 列表项 ----

    function reportTitle(r) {
      const n = r.targetUser && r.targetUser.nickname;
      switch (r.targetType) {
        case 'user':
          return n ? `${n} 的个人资料` : '一位用户的资料';
        case 'post':
          return n ? `${n} 发的动态` : '一条动态';
        case 'comment':
          return n ? `${n} 的评论` : '一条评论';
        case 'message':
          return n ? `${n} 在群聊里的发言` : '一条群聊消息';
        case 'event':
          return n ? `${n} 发起的局` : '一个局';
        default:
          return '被举报的内容';
      }
    }
    const WHERE = {
      user: '被举报的是 TA 的昵称和简介',
      post: '发在「动态」',
      comment: '发在动态下面的评论里',
      message: '发在局的群聊里',
      event: '用户发起的局',
    };

    const items = computed(() => {
      if (s.tab === 'report') {
        return s.reports.map((r) => ({
          id: r.id,
          tag: r.reason,
          tagTone: fmt.reasonTone(r.reason),
          when: fmt.ago(r.createdAt),
          title: reportTitle(r),
          preview: r.preview,
          done: r.status !== 'pending',
          status: r.status !== 'pending' ? '已处理' : '待处理',
        }));
      }
      if (s.tab === 'post') {
        return s.posts.map((p) => {
          const done = s.done[`post:${p.id}`];
          return {
            id: p.id,
            tag: '动态',
            tagTone: 'gray',
            when: fmt.ago(p.createdAt),
            title: `${p.author.nickname} 发的动态`,
            preview: p.text,
            done: !!done,
            status: done ? (done.startsWith('未通过') ? '未通过' : '已通过') : '待审核',
          };
        });
      }
      return s.events.map((e) => {
        const done = s.done[`event:${e.id}`];
        return {
          id: e.id,
          tag: '用户发起的局',
          tagTone: 'gray',
          when: fmt.ago(e.createdAt),
          title: e.title,
          preview: `${fmt.dateTime(e.startAt)} · ${e.place} · 最多 ${e.capacity} 人 · ${e.feeLabel}`,
          done: !!done,
          status: done ? (done.startsWith('未通过') ? '未通过' : '已通过') : '待审核',
        };
      });
    });

    const EMPTY = {
      report: ['没有待处理的举报', '有人举报时会出现在这里，尽量 24 小时内处理完。'],
      post: ['没有待审核的动态', '包含联系方式、广告等内容的动态会被系统拦下，等你来看。'],
      event: ['没有待审核的局', '用户发起的局命中内容审核时，会在这里等你决定能不能发到广场。'],
    };

    function select(id) {
      s.sel[s.tab] = id;
      resetAction();
      if (s.tab === 'event') loadEventDetail();
      // 窄屏时详情排在列表下面：把焦点（和视线）带过去；宽屏两栏并排时焦点留在列表里，方便继续挑
      nextTick(() => {
        const list = document.querySelector('.mod-list');
        const detail = document.querySelector('.split--mod .detail');
        if (list && detail && detail.getBoundingClientRect().top > list.getBoundingClientRect().top + 8) {
          focusSoon('#mod-detail-title');
        }
      });
    }

    async function loadEventDetail() {
      const e = current.value;
      if (!e || s.details[e.id]) return;
      s.detailError = '';
      try {
        s.details[e.id] = await api(`/admin/events/${e.id}`);
      } catch (err) {
        s.detailError = err.message;
      }
    }

    // ---- 举报 ----

    const actInfo = computed(() => ACTS.find((a) => a.key === s.act) || null);
    const actDesc = computed(() => {
      const r = current.value;
      if (!s.act || !r) return '';
      return {
        dismiss: '内容没问题，不处理。举报人会收到「经核实暂未发现违规」。',
        warn: '给 TA 发一条提醒，内容保留。',
        delete_content: DELETE_DESC[r.targetType] || '删掉这条内容。',
        restrict_7d: '7 天内不能参与撮合和报名，只能看。',
        ban: '不能再登录。只用于严重违规：擦边、诈骗、多次骚扰。',
      }[s.act];
    });
    const noteLabel = computed(
      () =>
        ({
          warn: '提醒内容（选填，会发给 TA；不填就用默认的提醒）',
          restrict_7d: '限制原因（选填，会告诉 TA）',
          ban: '封号原因（选填，会告诉 TA）',
        })[s.act] || '备注（选填，只有后台能看到）',
    );

    function pickAct(key) {
      s.act = key;
      s.err = '';
      s.banAsk = false;
    }

    /**
     * 不能用的处理方式：没有被举报的人时不能警告 / 限制 / 封号；
     * 已经封号的人不能再「限制 7 天」（服务端会把封号改成受限）或重复封号
     */
    function actDisabled(a, r) {
      if (a.needsUser && !r.targetUser) return true;
      return !!r.targetUser && r.targetUser.status === 'banned' && (a.key === 'restrict_7d' || a.key === 'ban');
    }

    /** 被举报次数（受限 / 封号已经体现在前面的等级标签里） */
    function historyText(u) {
      return u.reportCount > 1 ? `一共被举报过 ${u.reportCount} 次（含这次）` : '以前没被举报过';
    }

    function submitReport(r) {
      if (!actInfo.value) {
        s.err = '先选一种处理方式';
        return;
      }
      if (s.act === 'ban') {
        s.banAsk = true;
        focusSoon('#ban-ask');
        return;
      }
      resolveReport(r);
    }

    async function resolveReport(r) {
      if (s.busy || !actInfo.value) return;
      const act = actInfo.value;
      s.busy = true;
      try {
        const updated = await api(`/admin/reports/${r.id}/resolve`, {
          method: 'POST',
          body: { action: act.key, note: s.note.trim() || undefined },
        });
        // 同一个人的其他举报也用最新的状态（比如刚被封号）
        const fresh = updated.targetUser;
        s.reports = s.reports.map((x) => {
          if (x.id === r.id) return updated;
          if (fresh && x.targetUser && x.targetUser.id === fresh.id) return { ...x, targetUser: fresh };
          return x;
        });
        resetAction();
        showBanner(
          act.key === 'ban'
            ? `已封号：${r.targetUser.nickname} 不能再登录。举报人会收到处理结果通知。`
            : `已处理：${act.label}。举报人会收到处理结果通知。`,
        );
        refreshBadges();
      } catch (e) {
        if (e.code === 'CONFLICT' || e.code === 'NOT_FOUND') {
          failBanner(e);
          load();
        } else {
          s.err = e.message;
        }
      } finally {
        s.busy = false;
      }
    }

    // ---- 动态 / 局：通过或不通过 ----

    function openRej() {
      s.rejOpen = true;
      s.rejWhy = '';
      s.rejNote = '';
      s.rejErr = '';
      focusSoon('#rej-title');
    }
    function closeRej() {
      s.rejOpen = false;
      s.rejErr = '';
      focusSoon('#decide-actions button');
    }

    async function review(kind, item, approve) {
      if (s.busy) return;
      if (!approve && !s.rejWhy) {
        s.rejErr = '先选一个原因';
        return;
      }
      const extra = s.rejNote.trim();
      const note = approve ? undefined : extra ? `${s.rejWhy}：${extra}` : s.rejWhy;
      const path = kind === 'post' ? `/admin/posts/${item.id}` : `/admin/events/${item.id}`;
      s.busy = true;
      try {
        await api(`${path}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: note ? { note } : {} });
        s.done[`${kind}:${item.id}`] = approve ? '已通过' : `未通过：${s.rejWhy}`;
        const who = kind === 'post' ? item.author.nickname : item.creator ? item.creator.nickname : '发起人';
        let text;
        if (kind === 'post') text = approve ? `已通过：${who} 的动态已经出现在「动态」里。` : `没有通过：已通知 ${who}，可以改了再发。`;
        else text = approve ? `已通过：「${item.title}」已经发到广场。` : `没有通过：已通知 ${who}，可以改了再发。`;
        resetAction();
        showBanner(text);
        refreshBadges();
      } catch (e) {
        if (e.code === 'CONFLICT' || e.code === 'NOT_FOUND') {
          failBanner(e);
          load();
        } else if (approve) {
          failBanner(e, '没能通过');
        } else {
          s.rejErr = e.message;
        }
      } finally {
        s.busy = false;
      }
    }

    const imagesOf = (x) => (x.images || []).map((u) => fmt.safeUrl(u)).filter(Boolean);
    const flagText = (flags, prefix) => (flags && flags.length ? `${prefix}：${flags.join('、')}` : '等你审核');
    const postFrom = (p) =>
      [
        p.event ? `关联的局：「${p.event.title}」` : '没有关联的局',
        p.images && p.images.length ? `带 ${p.images.length} 张照片` : '',
        p.visibility === 'event' ? '只给同局的人看' : '',
      ]
        .filter(Boolean)
        .join(' · ');
    const levelLabel = (u) => fmt.LEVEL[fmt.userLevel(u)].label;
    const rejectReasons = computed(() => (s.tab === 'event' ? EVENT_REJECT : POST_REJECT));

    return {
      s,
      fmt,
      banner,
      closeBanner,
      load,
      tabs,
      items,
      current,
      eventDetail,
      EMPTY,
      ACTS,
      select,
      reportTitle,
      WHERE,
      actDesc,
      noteLabel,
      pickAct,
      actDisabled,
      historyText,
      submitReport,
      resolveReport,
      openRej,
      closeRej,
      review,
      imagesOf,
      flagText,
      postFrom,
      levelLabel,
      rejectReasons,
      loadEventDetail,
    };
  },
  template: html`
<div class="page">
  <header class="page-head page-head--col">
    <h1 class="page-title" tabindex="-1" data-page-title>审核与举报</h1>
    <p class="page-desc">举报尽量 24 小时内处理完，结果会用微信服务通知告诉举报的人。举报人对你也只显示匿名编号。系统拦下的动态和局，要你看过才会发出来。</p>
  </header>

  <StatusBanner :banner="banner" @close="closeBanner" />

  <TabList v-model="s.tab" :tabs="tabs" label="审核类型" id-prefix="mod" />

  <LoadState v-if="!s.loaded" :loading="s.loading" :error="s.error" @retry="load" />
  <div v-else id="mod-panel" role="tabpanel" :aria-labelledby="'mod-tab-' + s.tab" class="split split--mod">
    <div class="mod-list">
      <div v-if="!items.length" class="card empty empty--left">
        <span class="empty__title">{{ EMPTY[s.tab][0] }}</span>
        <span class="empty__text">{{ EMPTY[s.tab][1] }}</span>
      </div>
      <button v-for="it in items" :key="it.id" type="button" class="mod-item" :aria-pressed="current && current.id === it.id ? 'true' : 'false'" @click="select(it.id)">
        <span class="mod-item__top">
          <span class="pill" :class="'pill--' + it.tagTone">{{ it.tag }}</span>
          <span class="mod-item__when">{{ it.when }}</span>
          <span class="pill mod-item__st" :class="it.done ? 'pill--stone' : 'pill--warn'">{{ it.status }}</span>
        </span>
        <span class="mod-item__title">{{ it.title }}</span>
        <span class="mod-item__preview">{{ it.preview }}</span>
      </button>
    </div>

    <section v-if="current" class="card detail" aria-label="详情与处理">
      <!-- 举报 -->
      <template v-if="s.tab === 'report'">
        <div class="stack-8">
          <div class="meta-row">
            <span class="pill" :class="'pill--' + fmt.reasonTone(current.reason)">{{ current.reason }}</span>
            <span class="small muted">{{ fmt.REPORT_KIND[current.targetType] || '内容' }} · {{ fmt.ago(current.createdAt) }} · 举报人：{{ current.reporterAnonId }}（匿名）</span>
          </div>
          <h2 id="mod-detail-title" class="detail-title" tabindex="-1">{{ reportTitle(current) }}</h2>
        </div>
        <div class="stack-8">
          <span class="label">被举报的内容</span>
          <blockquote class="quote">{{ current.preview }}</blockquote>
          <span class="small muted">{{ WHERE[current.targetType] }}</span>
        </div>
        <div class="stack-8">
          <span class="label">举报人补充</span>
          <p class="body-text">{{ current.detail || '（没有补充说明）' }}</p>
          <div v-if="imagesOf(current).length" class="shots">
            <a v-for="(u, i) in imagesOf(current)" :key="i" :href="u" target="_blank" rel="noopener noreferrer" class="shot"><img :src="u" :alt="'举报截图 ' + (i + 1)" loading="lazy"></a>
          </div>
        </div>
        <div v-if="current.targetUser" class="person-card">
          <Avatar :user="current.targetUser" :size="40" />
          <div class="person-card__body">
            <span class="person-card__name">被举报人 · {{ current.targetUser.nickname }}</span>
            <span class="small muted">履约 {{ current.targetUser.creditRate }}% · {{ levelLabel(current.targetUser) }} · {{ historyText(current.targetUser) }}</span>
          </div>
          <a class="btn btn--outline btn--sm" :href="'#/users?id=' + current.targetUser.id">看信用记录</a>
        </div>

        <div v-if="current.status === 'pending'" class="decide">
          <span class="decide__title">怎么处理</span>
          <div class="chips" role="group" aria-label="处理方式">
            <button v-for="a in ACTS" :key="a.key" type="button" class="chip" :class="{ 'chip--danger': a.key === 'ban' }"
              :aria-pressed="s.act === a.key ? 'true' : 'false'" :disabled="actDisabled(a, current)" @click="pickAct(a.key)">{{ a.label }}</button>
          </div>
          <p v-if="!current.targetUser" class="small muted">这条举报找不到对应的用户，只能驳回或删除内容。</p>
          <p v-else-if="current.targetUser.status === 'banned'" class="small muted">{{ current.targetUser.nickname }} 已经被封号了，不用再限制或封号。</p>
          <p v-if="actDesc" class="info-box">{{ actDesc }}</p>
          <div class="field">
            <label for="mod-note" class="field__label">{{ noteLabel }}</label>
            <input id="mod-note" v-model="s.note" type="text" class="input" maxlength="200" autocomplete="off">
          </div>
          <p v-if="s.err" class="form-error" role="alert">{{ s.err }}</p>
          <div v-if="s.banAsk" class="confirm-box confirm-box--danger">
            <span id="ban-ask" class="body-text" tabindex="-1">封号后，{{ current.targetUser.nickname }} 不能再登录，也不能参加任何局。确定吗？</span>
            <div class="actions">
              <button type="button" class="btn btn--danger" :disabled="s.busy" @click="resolveReport(current)">确定封号</button>
              <button type="button" class="btn btn--outline" @click="s.banAsk = false">再想想</button>
            </div>
          </div>
          <div v-else class="actions">
            <button type="button" class="btn btn--primary btn--lg" :disabled="s.busy" @click="submitReport(current)">{{ s.busy ? '正在处理…' : '确认处理' }}</button>
          </div>
        </div>
        <div v-else class="done-box">
          <span class="done-box__title">已处理 · {{ fmt.REPORT_ACTION[current.action] || current.action }}</span>
          <span class="small body">举报人已收到处理结果通知。{{ current.adminNote ? '备注：' + current.adminNote : '' }}</span>
        </div>
      </template>

      <!-- 动态 -->
      <template v-else-if="s.tab === 'post'">
        <div class="stack-8">
          <div class="meta-row"><span class="pill pill--warn">{{ flagText(current.flags, '自动拦下') }}</span><span class="small muted">{{ fmt.ago(current.createdAt) }}</span></div>
          <h2 id="mod-detail-title" class="detail-title" tabindex="-1">{{ current.author.nickname }} 发的动态</h2>
        </div>
        <div class="stack-8">
          <blockquote class="quote">{{ current.text }}</blockquote>
          <div v-if="imagesOf(current).length" class="shots">
            <a v-for="(u, i) in imagesOf(current)" :key="i" :href="u" target="_blank" rel="noopener noreferrer" class="shot"><img :src="u" :alt="'动态照片 ' + (i + 1)" loading="lazy"></a>
          </div>
          <span class="small muted">{{ postFrom(current) }}</span>
        </div>
        <div class="person-card">
          <Avatar :user="current.author" :size="40" />
          <div class="person-card__body">
            <span class="person-card__name">作者 · {{ current.author.nickname }}</span>
            <span class="small muted">履约 {{ current.author.creditRate }}% · {{ levelLabel(current.author) }}</span>
          </div>
          <a class="btn btn--outline btn--sm" :href="'#/users?id=' + current.author.id">看信用记录</a>
        </div>
        <div v-if="!s.done['post:' + current.id]" class="decide">
          <span class="decide__title">这条动态要发出来吗？</span>
          <div v-if="!s.rejOpen" id="decide-actions" class="actions">
            <button type="button" class="btn btn--primary btn--lg" :disabled="s.busy" @click="review('post', current, true)">通过，发出来</button>
            <button type="button" class="btn btn--danger-outline btn--lg" @click="openRej">不通过</button>
          </div>
          <template v-else>
            <span id="rej-title" class="label" tabindex="-1">不通过的原因</span>
            <div class="chips" role="group" aria-labelledby="rej-title">
              <button v-for="w in rejectReasons" :key="w" type="button" class="chip" :aria-pressed="s.rejWhy === w ? 'true' : 'false'" @click="s.rejWhy = w; s.rejErr = ''">{{ w }}</button>
            </div>
            <div class="field">
              <label for="rej-note" class="field__label">补充说明（选填，会和原因一起发给 TA）</label>
              <input id="rej-note" v-model="s.rejNote" type="text" class="input" maxlength="150" autocomplete="off">
            </div>
            <p class="small muted">作者会收到通知「你的动态没有通过审核」和原因，可以改了再发。</p>
            <p v-if="s.rejErr" class="form-error" role="alert">{{ s.rejErr }}</p>
            <div class="actions">
              <button type="button" class="btn btn--danger btn--lg" :disabled="s.busy" @click="review('post', current, false)">确认不通过</button>
              <button type="button" class="btn btn--outline btn--lg" @click="closeRej">取消</button>
            </div>
          </template>
        </div>
        <div v-else class="done-box">
          <span class="done-box__title">{{ s.done['post:' + current.id] }}</span>
          <span class="small body">已通知作者。</span>
        </div>
      </template>

      <!-- 用户发起的局 -->
      <template v-else>
        <div class="stack-8">
          <div class="meta-row"><span class="pill pill--warn">{{ flagText(current.flags, '自动标记') }}</span><span class="small muted">{{ fmt.ago(current.createdAt) }}提交</span></div>
          <h2 id="mod-detail-title" class="detail-title" tabindex="-1">{{ current.title }}</h2>
          <span class="body-text">{{ fmt.dateTime(current.startAt) }} · {{ current.place }} · 最多 {{ current.capacity }} 人 · {{ current.feeLabel }}</span>
        </div>
        <div class="stack-8">
          <span class="label">发起人写的介绍</span>
          <LoadState v-if="!eventDetail" compact :loading="!s.detailError" :error="s.detailError" @retry="loadEventDetail" />
          <template v-else>
            <blockquote class="quote">{{ eventDetail.event.description || '（没有写介绍）' }}</blockquote>
            <span v-if="eventDetail.event.meetingPoint" class="small muted">集合点：{{ eventDetail.event.meetingPoint }}</span>
          </template>
        </div>
        <div v-if="current.creator" class="person-card">
          <Avatar :user="current.creator" :size="40" />
          <div class="person-card__body">
            <span class="person-card__name">发起人 · {{ current.creator.nickname }}</span>
            <span class="small muted">履约 {{ current.creator.creditRate }}% · {{ levelLabel(current.creator) }}</span>
          </div>
          <a class="btn btn--outline btn--sm" :href="'#/users?id=' + current.creator.id">看信用记录</a>
        </div>
        <div v-if="!s.done['event:' + current.id]" class="decide">
          <span class="decide__title">这个局能发到广场吗？</span>
          <div v-if="!s.rejOpen" id="decide-actions" class="actions">
            <button type="button" class="btn btn--primary btn--lg" :disabled="s.busy" @click="review('event', current, true)">通过，发到广场</button>
            <button type="button" class="btn btn--danger-outline btn--lg" @click="openRej">不通过</button>
          </div>
          <template v-else>
            <span id="rej-title" class="label" tabindex="-1">不通过的原因</span>
            <div class="chips" role="group" aria-labelledby="rej-title">
              <button v-for="w in rejectReasons" :key="w" type="button" class="chip" :aria-pressed="s.rejWhy === w ? 'true' : 'false'" @click="s.rejWhy = w; s.rejErr = ''">{{ w }}</button>
            </div>
            <div class="field">
              <label for="rej-note" class="field__label">补充说明（选填，会和原因一起发给 TA）</label>
              <input id="rej-note" v-model="s.rejNote" type="text" class="input" maxlength="150" autocomplete="off">
            </div>
            <p class="small muted">发起人会收到通知「你发起的局没有通过审核」和原因，可以改了再发。</p>
            <p v-if="s.rejErr" class="form-error" role="alert">{{ s.rejErr }}</p>
            <div class="actions">
              <button type="button" class="btn btn--danger btn--lg" :disabled="s.busy" @click="review('event', current, false)">确认不通过</button>
              <button type="button" class="btn btn--outline btn--lg" @click="closeRej">取消</button>
            </div>
          </template>
        </div>
        <div v-else class="done-box">
          <span class="done-box__title">{{ s.done['event:' + current.id] }}</span>
          <span class="small body">已通知发起人。</span>
        </div>
      </template>
    </section>
  </div>
</div>`,
};
