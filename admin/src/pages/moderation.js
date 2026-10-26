// 审核与举报：举报（驳回 / 警告 / 删除内容 / 限制 7 天 / 封号）、系统拦下的动态、用户发起的待审局。
import { computed, nextTick, onMounted, reactive, watch } from '../vue.js';
import { api } from '../api.js';
import { route } from '../router.js';
import { refreshBadges } from '../store.js';
import * as fmt from '../format.js';
import { focusSoon, html, useBanner } from '../ui.js';

const TABS = ['report', 'post', 'event'];

/**
 * 处理方式（docs/api.md 3.8）。needsUser：需要有被举报的人才能用；
 * toUser：会通知被处理的人，可以写「给 TA 的说明」（不填用 fallback 那句默认说明）
 */
const ACTS = [
  { key: 'dismiss', label: '驳回', needsUser: false, desc: '内容没问题，不处理。举报人会收到「经核实暂未发现违规，感谢你的反馈」。' },
  {
    key: 'warn',
    label: '警告',
    needsUser: true,
    desc: '给 TA 发一条提醒，内容保留。',
    toUser: true,
    fallback: '有人反馈你的言行让人不舒服，请遵守社区公约。再次违反会被限制使用。',
  },
  { key: 'delete_content', label: '删除内容', needsUser: false, desc: '删掉这条内容，并提醒 TA。', toUser: true, fallback: '' },
  {
    key: 'restrict_7d',
    label: '限制 7 天',
    needsUser: true,
    desc: '7 天内不能参与撮合和报名，只能看。',
    toUser: true,
    fallback: '原因：被举报并核实违反社区公约。到期后自动恢复。',
  },
  {
    key: 'ban',
    label: '封号',
    needsUser: true,
    desc: '不能再登录。只用于严重违规：擦边、诈骗、多次骚扰。',
    toUser: true,
    fallback: '原因：严重违反社区公约',
  },
];

/** 「删除内容」时作者收到的通知标题（不填说明时只发这一句） */
const DELETE_NOTICE = {
  user: '你的个人简介因违反社区公约被清空',
  post: '你的一条动态因违反社区公约被删除',
  comment: '你的一条评论因违反社区公约被删除',
  message: '你的一条群聊消息因违反社区公约被删除',
  event: '你发起的局因违反社区公约被取消',
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
      message: '',
      msgErr: '',
      err: '',
      banAsk: false,
      rejOpen: false,
      rejWhy: '',
      rejNote: '',
      rejErr: '',
      busy: false,
    });

    function resetAction() {
      Object.assign(s, {
        act: '',
        note: '',
        message: '',
        msgErr: '',
        err: '',
        banAsk: false,
        rejOpen: false,
        rejWhy: '',
        rejNote: '',
        rejErr: '',
      });
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


    const items = computed(() => {
      if (s.tab === 'report') {
        return s.reports.map((r) => ({
          id: r.id,
          tag: r.reason,
          tagTone: fmt.reasonTone(r.reason),
          when: fmt.ago(r.createdAt),
          title: fmt.reportTitle(r),
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
    /** 不填「给 TA 的说明」时，被处理的人会收到什么 */
    const fallbackText = computed(() => {
      const a = actInfo.value;
      const r = current.value;
      if (!a || !a.toUser || !r) return '';
      if (a.key === 'delete_content') return DELETE_NOTICE[r.targetType] || '你的一条内容因违反社区公约被删除';
      return a.fallback;
    });

    function pickAct(key) {
      s.act = key;
      s.err = '';
      s.msgErr = '';
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
          body: {
            action: act.key,
            note: s.note.trim() || undefined,
            message: act.toUser ? s.message.trim() || undefined : undefined,
          },
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
        s.banAsk = false;
        if (e.code === 'CONTENT_BLOCKED') {
          // 「给 TA 的说明」里有手机号、微信号或网址
          s.msgErr = e.message;
          focusSoon('#mod-message');
        } else if (e.code === 'CONFLICT' || e.code === 'NOT_FOUND') {
          // 比如已经被别人处理了，或者对方刚被封号（不能再限制）：提示服务端的原因，并刷新最新状态
          failBanner(e, '没能处理');
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
      actInfo,
      fallbackText,
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
          <h2 id="mod-detail-title" class="detail-title" tabindex="-1">{{ fmt.reportTitle(current) }}</h2>
        </div>
        <div class="stack-8">
          <span class="label">被举报的内容</span>
          <blockquote class="quote">{{ current.preview }}</blockquote>
          <span class="small muted report-where">{{ fmt.reportWhere(current) }}</span>
        </div>
        <div class="stack-8">
          <span class="label">举报人补充</span>
          <p class="body-text">{{ current.detail || '（没有补充说明）' }}</p>
          <Thumbs :images="imagesOf(current)" label="举报截图" />
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
          <p v-if="actInfo" class="info-box">{{ actInfo.desc }}</p>
          <div v-if="actInfo && actInfo.toUser" class="field">
            <label for="mod-message" class="field__label">给 TA 的说明（会发给 TA，不填用默认说明）</label>
            <input id="mod-message" v-model="s.message" type="text" class="input" :class="{ 'input--error': s.msgErr }" maxlength="200" autocomplete="off"
              :aria-invalid="s.msgErr ? 'true' : null" :aria-describedby="s.msgErr ? 'mod-message-err' : 'mod-message-hint'" @input="s.msgErr = ''">
            <p v-if="s.msgErr" id="mod-message-err" class="form-error" role="alert">{{ s.msgErr }}</p>
            <p v-else id="mod-message-hint" class="small muted">不能写手机号、微信号或网址。不填会发：「{{ fallbackText }}」</p>
          </div>
          <div class="field">
            <label for="mod-note" class="field__label">备注（选填，只有后台能看到）</label>
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
          <span class="small body">举报人已收到处理结果通知。</span>
          <span v-if="current.message" class="small body">发给 TA 的说明：{{ current.message }}</span>
          <span v-if="current.adminNote" class="small body">备注（只有后台能看到）：{{ current.adminNote }}</span>
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
          <Thumbs :images="imagesOf(current)" :label="current.author.nickname + ' 的动态照片'" />
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
          <span class="body-text">{{ fmt.dateTime(current.startAt) }} · {{ current.place }} · 最多 {{ current.capacity }} 人 · {{ current.feeLabel }}{{ current.tag ? ' · 标签「' + current.tag + '」' : '' }}{{ current.genderLabel ? ' · ' + current.genderLabel : '' }}</span>
        </div>
        <div class="stack-8">
          <span class="label">发起人写的介绍</span>
          <LoadState v-if="!eventDetail" compact :loading="!s.detailError" :error="s.detailError" @retry="loadEventDetail" />
          <template v-else>
            <blockquote class="quote">{{ eventDetail.event.description || '（没有写介绍）' }}</blockquote>
            <Thumbs :images="eventDetail.event.images || []" :label="'「' + current.title + '」的照片'" />
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
