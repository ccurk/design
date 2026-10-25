// 撮合池：系统配好的方案（待确认 / 已发邀请 / 已退回），确认成局、调整成员、退回；
// 右侧是「自动成局」开关和还在等的人。
import { computed, nextTick, onMounted, reactive, watch } from '../vue.js';
import { api } from '../api.js';
import { route } from '../router.js';
import { refreshBadges } from '../store.js';
import * as fmt from '../format.js';
import { focusSoon, html, useBanner } from '../ui.js';

const REJECT_REASONS = ['时间对不上', '地点太远', '成员不太合适', '夜间局不安全', '其他'];
const THRESHOLDS = [85, 90, 95];
const DAY_MS = 24 * 60 * 60 * 1000;

export default {
  name: 'MatchingPage',
  setup() {
    const { banner, showBanner, failBanner, closeBanner } = useBanner();
    const s = reactive({
      loading: true,
      loaded: false,
      error: '',
      tab: ['pending', 'invited', 'returned'].includes(route.query.tab) ? route.query.tab : 'pending',
      pending: [],
      proposedById: {}, // 已进方案的意向（带人数要求），用来算「至少几人」「最多几人」
      pool: [],
      invited: [], // [{ event, members }]
      returned: [],
      auto: { enabled: false, threshold: 90 },
      mode: null, // { id, kind: 'edit' | 'adjust' | 'reject' } 同一时间只展开一个面板
      form: {},
      formErr: '',
      rj: { reason: '', note: '', err: '' },
      busy: false,
      running: false,
      ran: false,
      savingAuto: false,
      focusId: route.query.id ? Number(route.query.id) : null,
    });

    // ---- 加载 ----

    let loadSeq = 0;
    async function load() {
      const seq = ++loadSeq;
      s.error = '';
      if (!s.loaded) s.loading = true;
      try {
        const [pending, proposed, pool, settings, inviting, returned] = await Promise.all([
          api('/admin/proposals', { query: { status: 'pending' } }),
          api('/admin/intents', { query: { status: 'proposed' } }),
          api('/admin/intents', { query: { status: 'open' } }),
          api('/admin/settings'),
          api('/admin/events', { query: { source: 'matched', status: 'inviting' } }),
          api('/admin/proposals', { query: { status: 'rejected' } }),
        ]);
        // 已发邀请：列表里没有每个人的回应状态，逐个取详情
        const details = await Promise.allSettled(inviting.items.slice(0, 30).map((e) => api(`/admin/events/${e.id}`)));
        if (seq !== loadSeq) return;
        s.pending = pending.items;
        s.proposedById = Object.fromEntries(proposed.items.map((i) => [i.id, i]));
        s.pool = pool.items;
        s.auto = settings.autoConfirm;
        s.invited = details.filter((d) => d.status === 'fulfilled').map((d) => d.value);
        s.returned = returned.items
          .slice()
          .sort((a, b) => String(b.reviewedAt || '').localeCompare(String(a.reviewedAt || '')))
          .slice(0, 30);
        s.loaded = true;
        if (s.mode && !s.pending.some((p) => p.id === s.mode.id)) s.mode = null;
      } catch (e) {
        if (seq !== loadSeq) return;
        if (s.loaded) failBanner(e, '刷新失败');
        else s.error = e.message;
      } finally {
        if (seq === loadSeq) s.loading = false;
      }
    }

    /** 调整成员后：池子和「已进方案的意向」都变了 */
    async function reloadPool() {
      const [proposed, pool] = await Promise.all([
        api('/admin/intents', { query: { status: 'proposed' } }),
        api('/admin/intents', { query: { status: 'open' } }),
      ]);
      s.proposedById = Object.fromEntries(proposed.items.map((i) => [i.id, i]));
      s.pool = pool.items;
    }

    onMounted(async () => {
      await load();
      if (s.focusId && s.pending.some((p) => p.id === s.focusId)) {
        s.tab = 'pending';
        nextTick(() => document.getElementById(`proposal-${s.focusId}`)?.scrollIntoView({ block: 'start' }));
      }
    });
    watch(
      () => route.query.tab,
      (tab) => {
        if (['pending', 'invited', 'returned'].includes(tab)) s.tab = tab;
      },
    );

    // ---- 计算 ----

    const tabs = computed(() => [
      { key: 'pending', label: '待确认', count: s.pending.length },
      { key: 'invited', label: '已发邀请', count: s.invited.length },
      { key: 'returned', label: '已退回', count: s.returned.length },
    ]);

    /** 组里每个人能接受的人数：至少 = 大家最少人数里最大的，最多 = 大家最多人数里最小的 */
    function bounds(p) {
      const intents = p.members.map((m) => s.proposedById[m.intentId]);
      if (!intents.length || intents.some((i) => !i)) return { min: 2, max: 20 };
      const min = Math.max(2, ...intents.map((i) => (i.relaxSize ? 2 : i.sizeMin)));
      const max = Math.min(20, ...intents.map((i) => (i.relaxSize ? 6 : i.sizeMax)));
      return { min, max: Math.max(max, p.members.length) };
    }
    const tooFew = (p) => p.members.length < bounds(p).min;

    const isMode = (p, kind) => !!s.mode && s.mode.id === p.id && s.mode.kind === kind;
    const isOpen = (p) => !!s.mode && s.mode.id === p.id;

    const proposalMeta = (p) => `${fmt.dateLabel(p.date)} ${p.slotLabel || fmt.SLOT[p.slot] || ''} · ${p.area}`;
    const paceLabel = (pace) => fmt.PACE[pace] || '';

    /** 池子里同一件事的人（不含已在组里的） */
    function candidates(p) {
      const inGroup = new Set(p.members.map((m) => m.user.id));
      return s.pool.filter((i) => i.task === p.task && !inGroup.has(i.user.id));
    }

    /** 候选人和这个方案对不对得上 */
    function compatNote(i, p) {
      if (p.date < i.dateFrom || p.date > i.dateTo) return `日期对不上：TA 是 ${fmt.md(i.dateFrom)}${i.dateTo !== i.dateFrom ? `–${fmt.md(i.dateTo)}` : ''}`;
      if (i.area !== p.area) return `地区不同：TA 在${i.area}`;
      const slotOk = i.slot === p.slot || i.slot === 'allday' || i.relaxTime || p.slot === 'allday';
      if (!slotOk) return `时间段不同：TA 只有${i.slotLabel}有空`;
      return '时间对得上';
    }

    const sortedPool = computed(() => s.pool.slice().sort((a, b) => b.waitingHours - a.waitingHours));

    const autoText = computed(() => {
      const fit = s.pending.filter((p) => p.score >= s.auto.threshold && !p.risks.length);
      if (!fit.length) {
        return '待确认里暂时没有达到门槛的方案。之后新配出的方案，匹配度达到门槛又没有风险提示，就会直接成局。';
      }
      const list = fit.map((p) => `「${p.title}」${p.score} 分`).join('、');
      return `待确认里有 ${fit.length} 个方案达到门槛：${list}。自动成局只管之后新配出的方案，这几个还要你手动确认。`;
    });

    // 已发邀请
    const joinedOf = (item) => item.members.filter((m) => m.status === 'joined').length;
    const activeOf = (item) => item.members.filter((m) => m.status === 'joined' || m.status === 'invited').length;
    const visibleMembers = (item) => item.members.filter((m) => m.status !== 'removed');
    const pctOf = (item) => `${activeOf(item) ? Math.round((joinedOf(item) / activeOf(item)) * 100) : 0}%`;
    function deadlineText(item) {
      const waiting = item.members.filter((m) => m.status === 'invited');
      if (!waiting.length) return '都回复了，等系统成局';
      const start = Date.parse(item.event.startAt);
      // 与服务端规则一致：邀请 24 小时内有效，离开场不到 12 小时不再等
      const t = Math.min(...waiting.map((m) => Math.min(Date.parse(m.invitedAt) + DAY_MS, start - DAY_MS / 2)));
      return `截止 ${fmt.when(new Date(t).toISOString())}`;
    }
    const INVITE_STATE = {
      joined: ['已加入', 'tag--tint'],
      invited: ['待回复', ''],
      declined: ['换了一批', 'tag--muted'],
      left: ['已退出', 'tag--muted'],
    };
    const inviteLabel = (m) => (INVITE_STATE[m.status] || [m.status])[0];
    const inviteTone = (m) => (INVITE_STATE[m.status] || ['', 'tag--muted'])[1];

    // ---- 操作 ----

    /** 跑一个会改数据的请求：同一时间只跑一个；冲突 / 已不存在时提示并刷新 */
    async function mutate(fn, prefix) {
      if (s.busy) return false;
      s.busy = true;
      try {
        await fn();
        return true;
      } catch (e) {
        if (e.code === 'CONFLICT' || e.code === 'NOT_FOUND') {
          failBanner(e, prefix);
          await load();
        } else {
          throw e;
        }
        return false;
      } finally {
        s.busy = false;
      }
    }

    function replaceProposal(updated) {
      s.pending = s.pending.map((p) => (p.id === updated.id ? updated : p));
    }

    function openMode(p, kind) {
      s.mode = { id: p.id, kind };
      s.rj = { reason: '', note: '', err: '' };
      s.formErr = '';
      focusSoon(`#panel-${kind}-${p.id}`);
    }

    function openEdit(p) {
      if (tooFew(p)) return;
      s.form = {
        title: p.title,
        date: p.date,
        time: fmt.defaultStart(p.task, p.slot),
        durationMin: fmt.defaultDuration(p.task),
        place: p.area || '',
        meetingPoint: '',
        feeType: 'aa',
        feeEstimate: '',
        capacity: p.members.length,
      };
      s.formErr = '';
      s.mode = { id: p.id, kind: 'edit' };
      focusSoon(`#f-title-${p.id}`);
    }

    function closeMode() {
      const id = s.mode && s.mode.id;
      s.mode = null;
      if (id) focusSoon(`#actions-${id} button:not([disabled])`);
    }

    async function confirm(p) {
      const f = s.form;
      const title = (f.title || '').trim();
      const place = (f.place || '').trim();
      if (!title || !f.date || !f.time || !place) {
        s.formErr = '标题、日期、开始时间和地点都要填';
        return;
      }
      if (title.length < 2) {
        s.formErr = '标题至少 2 个字';
        return;
      }
      const startAt = fmt.bjToISO(f.date, f.time);
      if (!startAt) {
        s.formErr = '日期或开始时间的格式不对';
        return;
      }
      if (Date.parse(startAt) <= Date.now()) {
        s.formErr = '开始时间已经过了，换一个以后的时间';
        return;
      }
      const body = {
        title,
        startAt,
        durationMin: Number(f.durationMin),
        place,
        meetingPoint: (f.meetingPoint || '').trim(),
        feeType: f.feeType,
        capacity: f.capacity,
      };
      if (f.feeType !== 'free' && f.feeEstimate !== '' && f.feeEstimate !== null) body.feeEstimate = Number(f.feeEstimate);
      s.formErr = '';
      const n = p.members.length;
      try {
        const ok = await mutate(async () => {
          await api(`/admin/proposals/${p.id}/confirm`, { method: 'POST', body });
          s.pending = s.pending.filter((x) => x.id !== p.id);
          s.mode = null;
          showBanner(`已发邀请给 ${n} 人：「${title}」。都点「加入」就自动成群。`, {
            actionLabel: '去看看',
            action: () => {
              s.tab = 'invited';
            },
          });
        }, '没能确认');
        if (ok) {
          refreshBadges();
          load();
        }
      } catch (e) {
        s.formErr = e.message;
      }
    }

    async function reject(p) {
      if (!s.rj.reason) {
        s.rj.err = '先选一个原因';
        return;
      }
      const extra = s.rj.note.trim();
      const note = extra ? `${s.rj.reason}：${extra}` : s.rj.reason;
      const n = p.members.length;
      try {
        const ok = await mutate(async () => {
          await api(`/admin/proposals/${p.id}/reject`, { method: 'POST', body: { note } });
          s.pending = s.pending.filter((x) => x.id !== p.id);
          s.mode = null;
          showBanner(`已退回「${p.title}」，${n} 个意向回到撮合池。`, {
            actionLabel: '去看看',
            action: () => {
              s.tab = 'returned';
            },
          });
        }, '没能退回');
        if (ok) {
          refreshBadges();
          load();
        }
      } catch (e) {
        s.rj.err = e.message;
      }
    }

    async function removeMember(p, m) {
      try {
        await mutate(async () => {
          const updated = await api(`/admin/proposals/${p.id}/members`, { method: 'POST', body: { remove: [m.user.id] } });
          replaceProposal(updated);
          await reloadPool();
          showBanner(`已把 ${m.user.nickname} 移出「${updated.title}」，TA 回到池子里继续等。现在 ${updated.members.length} 人，匹配度 ${updated.score}。`);
          focusSoon(`#panel-adjust-${p.id}`);
        }, '没能移出');
      } catch (e) {
        failBanner(e, '没能移出');
      }
    }

    async function addMember(p, intent) {
      try {
        await mutate(async () => {
          const updated = await api(`/admin/proposals/${p.id}/members`, { method: 'POST', body: { add: [intent.id] } });
          replaceProposal(updated);
          await reloadPool();
          showBanner(`已把 ${intent.user.nickname} 加进「${updated.title}」。现在 ${updated.members.length} 人，匹配度 ${updated.score}。`);
          focusSoon(`#panel-adjust-${p.id}`);
        }, '没能加进来');
      } catch (e) {
        failBanner(e, '没能加进来');
      }
    }

    async function runMatch() {
      if (s.running) return;
      s.running = true;
      try {
        const r = await api('/admin/match/run', { method: 'POST' });
        await load();
        const extra = [];
        if (r.autoConfirmed) extra.push(`其中 ${r.autoConfirmed} 个已自动成局`);
        if (r.backfilled) extra.push(`给邀请中的局补邀了 ${r.backfilled} 人`);
        if (r.expired) extra.push(`清理了 ${r.expired} 个过期意向`);
        let text = `撮合完成 · 新配出 ${r.created} 个方案`;
        if (extra.length) text += `，${extra.join('，')}。`;
        else if (!r.created) text += '，池子里的人还在等合适的同伴。';
        else text += '。';
        s.ran = true;
        showBanner(
          text,
          r.created - (r.autoConfirmed || 0) > 0
            ? {
                actionLabel: '去看看',
                action: () => {
                  s.tab = 'pending';
                },
              }
            : {},
        );
        refreshBadges();
      } catch (e) {
        failBanner(e, '撮合没跑成');
      } finally {
        s.running = false;
      }
    }

    async function saveAuto(patch, message) {
      if (s.savingAuto) return;
      s.savingAuto = true;
      try {
        const r = await api('/admin/settings', { method: 'PUT', body: { autoConfirm: patch } });
        s.auto = r.autoConfirm;
        showBanner(message(r.autoConfirm));
      } catch (e) {
        failBanner(e, '设置没保存');
      } finally {
        s.savingAuto = false;
      }
    }
    const toggleAuto = () =>
      saveAuto({ enabled: !s.auto.enabled }, (a) =>
        a.enabled
          ? `自动成局已打开：匹配度 ≥ ${a.threshold}、又没有风险提示的新方案会直接成局。`
          : '自动成局已关闭：每个方案都等你看过再发邀请。',
      );
    const setThreshold = (v) => {
      if (v === s.auto.threshold) return;
      saveAuto({ threshold: v }, (a) => `自动成局的门槛改成 ≥ ${a.threshold} 了。`);
    };

    return {
      s,
      fmt,
      banner,
      closeBanner,
      load,
      tabs,
      bounds,
      tooFew,
      isMode,
      isOpen,
      proposalMeta,
      paceLabel,
      candidates,
      compatNote,
      sortedPool,
      autoText,
      joinedOf,
      activeOf,
      visibleMembers,
      pctOf,
      deadlineText,
      inviteLabel,
      inviteTone,
      openMode,
      openEdit,
      closeMode,
      confirm,
      reject,
      removeMember,
      addMember,
      runMatch,
      toggleAuto,
      setThreshold,
      REJECT_REASONS,
      THRESHOLDS,
      DURATIONS: fmt.DURATIONS,
      today: fmt.todayStr(),
    };
  },
  template: html`
<div class="page">
  <header class="page-head">
    <div class="page-head__text page-head__text--grow">
      <h1 class="page-title" tabindex="-1" data-page-title>撮合池</h1>
      <p class="page-desc">系统每 5 分钟按「同一件事 · 时间对得上 · 同一片区域」自动配一次。你看一眼成员和风险提示，没问题就确认成局；确认后才会给每个人发邀请。</p>
    </div>
    <button type="button" class="btn btn--primary btn--head" :disabled="s.running" @click="runMatch">
      <Icon name="refresh" :size="18" :weight="2" />{{ s.running ? '正在撮合…' : (s.ran ? '再撮合一次' : '立即撮合一次') }}
    </button>
  </header>

  <StatusBanner :banner="banner" @close="closeBanner" />

  <LoadState v-if="!s.loaded" :loading="s.loading" :error="s.error" @retry="load" />
  <div v-else class="split">
    <div class="split__main">
      <TabList v-model="s.tab" :tabs="tabs" label="方案状态" id-prefix="match" />
      <div id="match-panel" role="tabpanel" :aria-labelledby="'match-tab-' + s.tab" class="stack-16">

        <!-- 待确认 -->
        <template v-if="s.tab === 'pending'">
          <div v-if="!s.pending.length" class="card empty">
            <span class="empty__title">都确认完了</span>
            <span class="empty__text">新方案配出来会出现在这里，也可以点右上角「立即撮合一次」。</span>
          </div>
          <article v-for="p in s.pending" :key="p.id" :id="'proposal-' + p.id" class="card proposal" :class="{ 'is-focus': s.focusId === p.id }" :aria-labelledby="'p-title-' + p.id">
            <div class="proposal__head">
              <div class="score" :class="{ 'is-high': p.score >= 90 }"><span class="score__num">{{ p.score }}</span><span class="score__label">匹配度</span></div>
              <div class="proposal__info">
                <div class="title-row"><h2 :id="'p-title-' + p.id" class="card-title">{{ p.title }}</h2><span class="pill pill--gray">{{ fmt.categoryLabel(p.category) }}</span></div>
                <span class="proposal__meta">{{ proposalMeta(p) }} · {{ p.members.length }} 人</span>
                <span class="proposal__made">系统配出 · {{ fmt.ago(p.createdAt) }}</span>
              </div>
            </div>

            <ul class="member-grid" aria-label="配到的人">
              <li v-for="m in p.members" :key="m.user.id" class="member">
                <Avatar :user="m.user" :size="36" />
                <div class="member__body">
                  <span class="member__name">{{ m.user.nickname }}</span>
                  <span class="tags">
                    <span class="tag">履约 {{ m.user.creditRate }}%</span>
                    <span v-if="paceLabel(m.pace)" class="tag">{{ paceLabel(m.pace) }}</span>
                    <span v-if="m.isNew" class="tag tag--tint">新人</span>
                    <span v-if="m.user.creditLevel === 'fair'" class="tag tag--warn">信用一般</span>
                    <span v-else-if="m.user.creditLevel === 'restricted'" class="tag tag--danger">信用受限</span>
                  </span>
                </div>
                <button v-if="isMode(p, 'adjust') && p.members.length > 2" type="button" class="btn btn--outline btn--sm"
                  :aria-label="'把 ' + m.user.nickname + ' 移出这个方案'" :disabled="s.busy" @click="removeMember(p, m)">移出</button>
              </li>
            </ul>

            <div class="reason-grid">
              <div class="note-box">
                <span class="note-box__title">为什么配到一起</span>
                <ul class="icon-list">
                  <li v-for="(r, i) in p.reasons" :key="i"><Icon name="check" :size="16" stroke="#193543" :weight="2.4" /><span>{{ r }}</span></li>
                </ul>
              </div>
              <div class="note-box" :class="{ 'note-box--risk': p.risks.length }">
                <span class="note-box__title">风险提示</span>
                <ul v-if="p.risks.length" class="icon-list">
                  <li v-for="(r, i) in p.risks" :key="i"><Icon name="warn" :size="16" stroke="#B26B00" :weight="2.2" /><span>{{ r }}</span></li>
                </ul>
                <ul v-else class="icon-list">
                  <li><Icon name="check" :size="16" stroke="#193543" :weight="2.4" /><span>没有发现风险</span></li>
                </ul>
              </div>
            </div>

            <!-- 调整成员 -->
            <div v-if="isMode(p, 'adjust')" class="panel panel--outline">
              <div class="panel__head">
                <span :id="'panel-adjust-' + p.id" class="panel__title" tabindex="-1">调整成员</span>
                <span class="panel__hint" :class="{ 'text-danger': tooFew(p) }">{{ tooFew(p) ? '至少 ' + bounds(p).min + ' 人才能成局，现在 ' + p.members.length + ' 人' : '现在 ' + p.members.length + ' 人 · 匹配度和风险会跟着重新算' }}</span>
              </div>
              <p class="panel__desc">点上面成员卡片里的「移出」，被移出的人回到池子里继续等。至少要留 2 个人。</p>
              <span class="panel__sub">池子里同样想{{ fmt.taskVerb(p.task) }}的人</span>
              <ul v-if="candidates(p).length" class="cand-list">
                <li v-for="c in candidates(p)" :key="c.id" class="cand">
                  <Avatar :user="c.user" :size="32" />
                  <div class="cand__body">
                    <span class="cand__name">{{ c.user.nickname }} · 履约 {{ c.user.creditRate }}%</span>
                    <span class="cand__sub">{{ c.title }} · {{ c.slotLabel }} · {{ c.area }} · {{ compatNote(c, p) }}</span>
                  </div>
                  <button type="button" class="btn btn--outline-primary btn--sm" :aria-label="'把 ' + c.user.nickname + ' 加进这个方案'" :disabled="s.busy" @click="addMember(p, c)">加进来</button>
                </li>
              </ul>
              <p v-else class="panel__desc">池子里暂时没有同样想{{ fmt.taskVerb(p.task) }}的人。</p>
              <div class="actions">
                <button type="button" class="btn btn--primary" @click="closeMode">调整好了</button>
              </div>
            </div>

            <!-- 确认成局 -->
            <form v-if="isMode(p, 'edit')" class="panel" novalidate @submit.prevent="confirm(p)">
              <div class="stack-4">
                <span class="panel__title">确认前，可以改一下细节</span>
                <span class="panel__desc">发出后，每个人会收到「撮合成功」，自己点「加入这个局」才算数；有人点「换一批」，系统会从池子里补人。</span>
              </div>
              <div class="form-grid">
                <div class="field field--full">
                  <label :for="'f-title-' + p.id" class="field__label">标题</label>
                  <input :id="'f-title-' + p.id" v-model="s.form.title" type="text" class="input" maxlength="30" autocomplete="off">
                </div>
                <div class="field field--date">
                  <label :for="'f-date-' + p.id" class="field__label">日期<span v-if="s.form.date" class="field__hint">{{ fmt.weekday(s.form.date) }}</span></label>
                  <input :id="'f-date-' + p.id" v-model="s.form.date" type="date" class="input" :min="today">
                </div>
                <div class="field field--time">
                  <label :for="'f-time-' + p.id" class="field__label">开始时间</label>
                  <input :id="'f-time-' + p.id" v-model="s.form.time" type="time" class="input">
                </div>
                <div class="field field--time">
                  <label :for="'f-dur-' + p.id" class="field__label">时长</label>
                  <select :id="'f-dur-' + p.id" v-model.number="s.form.durationMin" class="input select">
                    <option v-for="d in DURATIONS" :key="d" :value="d">{{ fmt.duration(d) }}</option>
                  </select>
                </div>
                <div class="field field--wide">
                  <label :for="'f-place-' + p.id" class="field__label">地点</label>
                  <input :id="'f-place-' + p.id" v-model="s.form.place" type="text" class="input" maxlength="40" autocomplete="off">
                </div>
                <div class="field field--wide">
                  <label :for="'f-meet-' + p.id" class="field__label">集合点<span class="field__hint">选填</span></label>
                  <input :id="'f-meet-' + p.id" v-model="s.form.meetingPoint" type="text" class="input" maxlength="60" placeholder="比如：南门城楼下" autocomplete="off">
                </div>
              </div>
              <FeePicker v-model:feeType="s.form.feeType" v-model:estimate="s.form.feeEstimate" :id-prefix="'f-' + p.id" />
              <div class="cap-row">
                <span :id="'cap-label-' + p.id" class="field__label">人数上限</span>
                <Stepper v-model="s.form.capacity" :min="p.members.length" :max="bounds(p).max" :labelledby="'cap-label-' + p.id" />
                <span class="cap-row__hint">已配 {{ p.members.length }} 人{{ s.form.capacity > p.members.length ? '，多出来的名额系统会从池子里补邀' : '' }}</span>
              </div>
              <p v-if="s.formErr" class="form-error" role="alert">{{ s.formErr }}</p>
              <div class="actions">
                <button type="submit" class="btn btn--primary btn--lg" :disabled="s.busy">{{ s.busy ? '正在发出…' : '发出邀请（' + p.members.length + ' 人）' }}</button>
                <button type="button" class="btn btn--outline btn--lg" @click="closeMode">先不发</button>
              </div>
            </form>

            <!-- 退回 -->
            <div v-if="isMode(p, 'reject')" class="panel">
              <div class="stack-4">
                <span :id="'panel-reject-' + p.id" class="panel__title" tabindex="-1">为什么退回？</span>
                <span class="panel__desc">退回后，这 {{ p.members.length }} 个意向回到池子里，系统会换个组合再配。成员不会知道被退回过。</span>
              </div>
              <div class="chips" role="group" aria-label="退回原因">
                <button v-for="r in REJECT_REASONS" :key="r" type="button" class="chip" :aria-pressed="s.rj.reason === r ? 'true' : 'false'" @click="s.rj.reason = r; s.rj.err = ''">{{ r }}</button>
              </div>
              <div class="field">
                <label :for="'rj-note-' + p.id" class="field__label">补充说明（选填，只有后台能看到）</label>
                <input :id="'rj-note-' + p.id" v-model="s.rj.note" type="text" class="input" maxlength="150" autocomplete="off">
              </div>
              <p v-if="s.rj.err" class="form-error" role="alert">{{ s.rj.err }}</p>
              <div class="actions">
                <button type="button" class="btn btn--danger-outline btn--lg" :disabled="s.busy" @click="reject(p)">确认退回</button>
                <button type="button" class="btn btn--outline btn--lg" @click="closeMode">先不退</button>
              </div>
            </div>

            <div v-if="!isOpen(p)" :id="'actions-' + p.id" class="actions">
              <button type="button" class="btn btn--primary" :disabled="tooFew(p)" @click="openEdit(p)">确认成局</button>
              <button type="button" class="btn btn--outline" @click="openMode(p, 'adjust')">调整成员</button>
              <button type="button" class="btn btn--ghost" @click="openMode(p, 'reject')">退回</button>
              <span v-if="tooFew(p)" class="text-danger small">至少 {{ bounds(p).min }} 人才能成局，先调整成员</span>
            </div>
          </article>
        </template>

        <!-- 已发邀请 -->
        <template v-else-if="s.tab === 'invited'">
          <div v-if="!s.invited.length" class="card empty">
            <span class="empty__title">还没有发出去的邀请</span>
            <span class="empty__text">确认成局后，会在这里看到每个人有没有点加入。</span>
          </div>
          <article v-for="item in s.invited" :key="item.event.id" class="card proposal" :aria-labelledby="'inv-title-' + item.event.id">
            <div class="proposal__top">
              <div class="proposal__info">
                <div class="title-row"><h2 :id="'inv-title-' + item.event.id" class="card-title">{{ item.event.title }}</h2><span class="pill pill--gray">{{ fmt.categoryLabel(item.event.category) }}</span></div>
                <span class="proposal__meta">{{ fmt.dateTime(item.event.startAt) }} · {{ item.event.place }} · {{ activeOf(item) }} 人</span>
              </div>
              <span class="pill pill--accent pill--lg">邀请中</span>
            </div>
            <div class="stack-8">
              <div class="progress-head"><span class="strong">{{ joinedOf(item) }} / {{ activeOf(item) }} 人已加入</span><span class="muted">{{ deadlineText(item) }}</span></div>
              <div class="progress" aria-hidden="true"><div class="progress__bar" :style="{ width: pctOf(item) }"></div></div>
            </div>
            <ul class="member-grid member-grid--sm" aria-label="成员">
              <li v-for="m in visibleMembers(item)" :key="m.id" class="member member--sm">
                <Avatar :user="m" :size="32" />
                <span class="member__name grow">{{ m.nickname }}</span>
                <span class="tag" :class="inviteTone(m)">{{ inviteLabel(m) }}</span>
              </li>
            </ul>
            <p class="small muted">全员加入就自动成局、建群。到截止时间已加入 {{ item.event.minSize || 3 }} 人以上也会成局；不够就取消，意向放回池子。</p>
            <div class="actions"><a class="btn btn--outline" :href="'#/events?id=' + item.event.id">在局管理里查看</a></div>
          </article>
        </template>

        <!-- 已退回 -->
        <template v-else>
          <div v-if="!s.returned.length" class="card empty">
            <span class="empty__title">没有退回过的方案</span>
          </div>
          <article v-for="p in s.returned" :key="p.id" class="card proposal" :aria-labelledby="'ret-title-' + p.id">
            <div class="proposal__top">
              <div class="proposal__info">
                <div class="title-row"><h2 :id="'ret-title-' + p.id" class="card-title">{{ p.title }}</h2><span class="pill pill--gray">{{ fmt.categoryLabel(p.category) }}</span></div>
                <span class="proposal__meta">{{ proposalMeta(p) }} · {{ p.members.length }} 人</span>
              </div>
              <span class="pill pill--stone pill--lg">已退回</span>
            </div>
            <div class="quote-box">退回原因：{{ p.reviewNote || '没有填写' }}</div>
            <span class="small muted">{{ p.reviewedAt ? fmt.ago(p.reviewedAt) + '退回 · ' : '' }}{{ p.members.length }} 个意向已回到撮合池，系统会换个组合再配。</span>
          </article>
        </template>
      </div>
    </div>

    <aside class="split__side" aria-label="撮合设置和撮合池">
      <section class="card card--aside" aria-labelledby="auto-title">
        <div class="auto-head">
          <div class="stack-4 grow">
            <h2 id="auto-title" class="aside-title">自动成局</h2>
            <p class="small muted">打开后，匹配度够高、又没有任何风险提示的方案直接成局，不用等你确认。</p>
          </div>
          <ToggleSwitch :checked="s.auto.enabled" labelledby="auto-title" :busy="s.savingAuto" @toggle="toggleAuto" />
        </div>
        <div v-if="s.auto.enabled" class="stack-10">
          <span id="th-label" class="small strong body">匹配度门槛</span>
          <div class="chips" role="group" aria-labelledby="th-label">
            <button v-for="v in THRESHOLDS" :key="v" type="button" class="chip" :aria-pressed="s.auto.threshold === v ? 'true' : 'false'" :aria-busy="s.savingAuto ? 'true' : null" @click="setThreshold(v)">≥ {{ v }}</button>
          </div>
          <p class="info-box">{{ autoText }}</p>
        </div>
        <p v-else class="info-box">已关闭：每个方案都等你看过再发邀请。刚开始建议保持关闭。</p>
      </section>

      <section class="card card--aside pool" aria-labelledby="pool-title">
        <div class="pool__head"><h2 id="pool-title" class="aside-title">还在等的人</h2><span class="small muted">{{ s.pool.length }} 人</span></div>
        <p class="small muted pool__desc">系统每 5 分钟再配一次。成局前，他们互相看不到彼此。</p>
        <ul v-if="s.pool.length" class="pool__list">
          <li v-for="q in sortedPool" :key="q.id" class="pool__item">
            <Avatar :user="q.user" :size="36" />
            <div class="pool__body">
              <span class="pool__name">{{ q.user.nickname }}</span>
              <span class="pool__intent">{{ q.title }} · {{ q.slotLabel }} · {{ q.area }}</span>
            </div>
            <div class="pool__wait">
              <span>{{ fmt.waitText(q.waitingHours) }}</span>
              <span v-if="q.waitingHours >= 24" class="pill pill--warn pill--xs">超过一天</span>
            </div>
          </li>
        </ul>
        <p v-else class="pool__empty">池子里暂时没人在等。</p>
      </section>
    </aside>
  </div>
</div>`,
};
