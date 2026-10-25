// 用户与信用：搜索 + 等级筛选、用户表格、用户详情（信用记录可撤销、账号限制 / 封号）、申诉处理。
import { computed, onBeforeUnmount, onMounted, reactive, watch } from '../vue.js';
import { api } from '../api.js';
import { route } from '../router.js';
import { badges, refreshBadges } from '../store.js';
import * as fmt from '../format.js';
import { focusSoon, html, useBanner } from '../ui.js';

const TABS = ['all', 'restricted', 'appeals'];
const LEVEL_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'good', label: '良好' },
  { key: 'fair', label: '一般' },
  { key: 'restricted', label: '受限' },
  { key: 'banned', label: '已封号' },
];
/** 会拉低履约率、可以撤销的记录 */
const REVOCABLE = ['late', 'cancel_late', 'no_show'];

export default {
  name: 'UsersPage',
  setup() {
    const { banner, showBanner, failBanner, closeBanner } = useBanner();
    const s = reactive({
      tab: TABS.includes(route.query.tab) ? route.query.tab : 'all',
      q: '',
      lv: 'all',
      loading: true,
      error: '',
      rows: [],
      allUsers: [], // 用来算标签页上的人数
      sel: route.query.id ? Number(route.query.id) : null,
      detail: null,
      detailLoading: false,
      detailError: '',
      showAllCredit: false,
      ask: null, // 'restrict' | 'ban'
      restrictWhy: '',
      banWhy: '',
      revokeAsk: null,
      appeals: [],
      appealsLoading: true,
      appealsError: '',
      replies: {},
      appealErr: {},
      busy: false,
    });
    if (s.sel) s.tab = 'all';

    // ---- 列表 ----

    let listSeq = 0;
    async function loadList() {
      const seq = ++listSeq;
      s.loading = true;
      s.error = '';
      try {
        // level：good / fair / restricted 按信用等级（不含封号的人），banned = 被封号的人
        const res = await api('/admin/users', { query: { q: s.q.trim() || undefined, level: s.lv === 'all' ? undefined : s.lv } });
        if (seq !== listSeq) return;
        // 「受限中」= 受限 + 封号（接口的 status 一次只能筛一种）
        s.rows = s.tab === 'restricted' ? res.items.filter((u) => u.status !== 'active') : res.items;
      } catch (e) {
        if (seq === listSeq) s.error = e.message;
      } finally {
        if (seq === listSeq) s.loading = false;
      }
    }

    async function loadCounts() {
      try {
        s.allUsers = (await api('/admin/users')).items;
      } catch {
        // 只影响标签页上的数字
      }
    }

    async function loadAppeals() {
      s.appealsError = '';
      try {
        const res = await api('/admin/appeals');
        // 这次处理过的申诉留在页面上显示结果，直到离开页面
        const handled = s.appeals.filter((a) => a.status !== 'pending' && !res.items.some((x) => x.id === a.id));
        s.appeals = [...res.items, ...handled].sort((a, b) => b.id - a.id);
        badges.appeals = res.items.length;
      } catch (e) {
        s.appealsError = e.message;
      } finally {
        s.appealsLoading = false;
      }
    }

    let searchTimer = null;
    function onSearch() {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(loadList, 300);
    }
    function searchNow() {
      clearTimeout(searchTimer);
      loadList();
    }
    onBeforeUnmount(() => clearTimeout(searchTimer));

    watch(
      () => [s.tab, s.lv],
      () => {
        if (s.tab !== 'appeals') loadList();
        else loadAppeals();
      },
    );

    onMounted(() => {
      loadList();
      loadCounts();
      loadAppeals();
      if (s.sel) openUser(s.sel); // 从别的页面带着 ?id= 过来：直接打开并滚到详情
    });

    watch(
      () => [route.query.id, route.query.tab],
      ([id, tab]) => {
        if (TABS.includes(tab) && tab !== s.tab) s.tab = tab;
        if (id && Number(id) !== s.sel) openUser(Number(id));
      },
    );

    const tabs = computed(() => [
      { key: 'all', label: '全部用户', count: s.allUsers.length },
      { key: 'restricted', label: '受限中', count: s.allUsers.filter((u) => u.status !== 'active').length },
      { key: 'appeals', label: '申诉', count: s.appeals.filter((a) => a.status === 'pending').length },
    ]);

    // ---- 详情 ----

    let detailSeq = 0;
    async function loadDetail(id = s.sel) {
      if (!id) return;
      const seq = ++detailSeq;
      s.detailLoading = true;
      s.detailError = '';
      try {
        const d = await api(`/admin/users/${id}`);
        if (seq === detailSeq) s.detail = d;
      } catch (e) {
        if (seq === detailSeq) s.detailError = e.message;
      } finally {
        if (seq === detailSeq) s.detailLoading = false;
      }
    }

    function resetAsks() {
      Object.assign(s, { ask: null, restrictWhy: '', banWhy: '', revokeAsk: null });
    }

    async function openUser(id) {
      s.sel = id;
      s.detail = null;
      s.showAllCredit = false;
      resetAsks();
      await loadDetail(id);
      focusSoon('#user-detail-title');
    }

    function toggleSel(u) {
      if (s.sel === u.id) closeDetail();
      else openUser(u.id);
    }

    function closeDetail() {
      const id = s.sel;
      s.sel = null;
      s.detail = null;
      resetAsks();
      if (id) focusSoon(`#view-${id}`);
    }

    const du = computed(() => (s.detail ? s.detail.user : null));
    const dc = computed(() => (s.detail ? s.detail.credit : null));
    const pendingAppeal = computed(() => (s.detail ? s.detail.appeals.find((a) => a.status === 'pending') || null : null));

    const typeLabel = (c) => (fmt.CREDIT_TYPE[c.type] || { label: c.typeLabel || c.type }).label;
    const typeTone = (c) => (fmt.CREDIT_TYPE[c.type] || { tone: 'gray' }).tone;
    const canRevoke = (c) => !c.revoked && REVOCABLE.includes(c.type);
    const timelineSource = (c) => `${fmt.CREDIT_SOURCE[c.source] || ''}${c.eventTitle && c.note ? ` · ${c.note}` : ''}`;
    const recordSource = (c) => `${fmt.CREDIT_SOURCE[c.source] || ''}${c.note ? ` · ${c.note}` : ''}`;

    /** 默认只列最近 6 条 + 所有需要留意的记录，其余「准时到场」折叠起来 */
    const creditRows = computed(() => {
      const all = s.detail ? s.detail.creditEvents : [];
      if (s.showAllCredit) return all;
      return all.filter((c, i) => i < 6 || c.type !== 'attended' || c.revoked);
    });
    const hiddenCount = computed(() => (s.detail ? s.detail.creditEvents.length - creditRows.value.length : 0));
    const hasIssues = computed(() => (s.detail ? s.detail.creditEvents.some((c) => c.type !== 'attended') : false));

    function askRevoke(c) {
      s.revokeAsk = c.id;
      focusSoon(`#revoke-ask-${c.id}`);
    }
    function cancelRevoke(c) {
      s.revokeAsk = null;
      focusSoon(`#revoke-${c.id}`);
    }
    const appealing = (c) => !!(c.appeal && c.appeal.status === 'pending');
    function revokeText(c) {
      const tail = appealing(c) ? '，这条记录上的申诉也会自动通过' : '';
      return `撤销后这条不再算进履约率，会通知 ${du.value.nickname}${tail}。确定吗？`;
    }

    /** 撤销一条信用记录：服务端会通知本人，并自动通过这条记录上待处理的申诉 */
    async function revoke(c) {
      if (s.busy) return;
      const user = du.value;
      const before = dc.value.rate;
      const hadAppeal = appealing(c);
      s.busy = true;
      try {
        await api(`/admin/users/${user.id}/credit`, { method: 'POST', body: { revokeId: c.id } });
        s.revokeAsk = null;
        await loadDetail(user.id);
        const after = dc.value ? dc.value.rate : before;
        showBanner(
          `已撤销 ${user.nickname} ${fmt.shortDate(c.createdAt)} 的「${typeLabel(c)}」，履约率 ${before}% → ${after}%，已通知 TA${hadAppeal ? '；这条记录上的申诉也自动通过了' : ''}。`,
        );
        loadList();
        loadCounts();
        if (hadAppeal) loadAppeals();
        refreshBadges();
      } catch (e) {
        failBanner(e, '没能撤销');
        if (e.code === 'CONFLICT' || e.code === 'NOT_FOUND') loadDetail(user.id);
      } finally {
        s.busy = false;
      }
    }

    function ask(kind) {
      s.ask = kind;
      s.restrictWhy = '';
      s.banWhy = '';
      focusSoon(kind === 'ban' ? '#ban-ask' : '#rs-why');
    }
    function cancelAsk() {
      s.ask = null;
      focusSoon('#account-actions button');
    }

    async function account(kind) {
      if (s.busy) return;
      const u = du.value;
      const name = u.nickname;
      const calls = {
        restrict: () =>
          api(`/admin/users/${u.id}/restrict`, {
            method: 'POST',
            body: { days: 7, reason: s.restrictWhy.trim() || '后台手动限制' },
          }),
        unrestrict: () => api(`/admin/users/${u.id}/unban`, { method: 'POST' }),
        ban: () => api(`/admin/users/${u.id}/ban`, { method: 'POST', body: { reason: s.banWhy.trim() || '严重违反社区公约' } }),
        unban: () => api(`/admin/users/${u.id}/unban`, { method: 'POST' }),
      };
      s.busy = true;
      try {
        await calls[kind]();
        resetAsks();
        await loadDetail(u.id);
        const until = du.value && du.value.restrictedUntil ? fmt.dateTime(du.value.restrictedUntil) : '7 天后';
        showBanner(
          {
            restrict: `已限制 ${name} 7 天（到 ${until}），已通知 TA。`,
            unrestrict: `已解除限制：${name} 可以正常参加了。`,
            ban: `已封号：${name} 不能再登录。`,
            unban: `已解封：${name} 可以重新登录了。`,
          }[kind],
        );
        loadList();
        loadCounts();
        focusSoon('#account-actions button');
      } catch (e) {
        failBanner(e, '没能处理');
        loadDetail(u.id);
      } finally {
        s.busy = false;
      }
    }

    // ---- 申诉 ----

    const hoursText = (h) => String(Math.round(Number(h) * 10) / 10);

    /** 「系统找到的证据」下面那句提示（规则见 docs/api.md 3.1：提前 24 小时以上说去不了不记录，24 小时内算临时鸽） */
    function evidenceHint(a) {
      const ce = a.creditEvent;
      if (!ce || !ce.eventId) return '这条记录没有关联具体的局，找不到群聊记录。';
      const list = a.evidence || [];
      if (!list.length) return '没找到 TA 在群里提前说过。';
      const earliest = Math.max(...list.map((m) => m.hoursBeforeStart));
      if (earliest >= 24) return '提前 24 小时以上说了，按规则不记录，建议通过。';
      const h = hoursText(earliest);
      if (ce.type === 'no_show') return `开场前 ${h} 小时才说，按规则应记「临时鸽」而不是「放鸽子」。`;
      if (ce.type === 'cancel_late') return `开场前 ${h} 小时才说，按规则记「临时鸽」没有问题。`;
      return `TA 在开场前 ${h} 小时说过，可以看看内容再决定。`;
    }

    function appealStatus(a) {
      return { pending: ['待处理', 'warn'], approved: ['已通过', 'stone'], rejected: ['已驳回', 'stone'] }[a.status] || [a.status, 'stone'];
    }

    async function resolveAppeal(a, approve) {
      if (s.busy) return;
      const reply = (s.replies[a.id] || '').trim();
      if (!approve && !reply) {
        s.appealErr[a.id] = '驳回时写一句回复，告诉 TA 为什么';
        focusSoon(`#ap-reply-${a.id}`);
        return;
      }
      s.appealErr[a.id] = '';
      const before = a.user.creditRate;
      const label = a.creditEvent ? typeLabel(a.creditEvent) : '信用';
      s.busy = true;
      try {
        const updated = await api(`/admin/appeals/${a.id}/resolve`, {
          method: 'POST',
          body: { approve, note: reply || undefined },
        });
        s.appeals = s.appeals.map((x) => (x.id === a.id ? updated : x));
        showBanner(
          approve
            ? `已通过 ${a.user.nickname} 的申诉：「${label}」已撤销，履约率 ${before}% → ${updated.user.creditRate}%，已通知 TA。`
            : `已驳回 ${a.user.nickname} 的申诉，回复已发给 TA。`,
        );
        badges.appeals = s.appeals.filter((x) => x.status === 'pending').length;
        refreshBadges();
        loadCounts();
        if (s.sel === a.user.id) loadDetail(a.user.id);
      } catch (e) {
        if (e.code === 'CONFLICT' || e.code === 'NOT_FOUND') {
          failBanner(e);
          loadAppeals();
        } else {
          s.appealErr[a.id] = e.message;
        }
      } finally {
        s.busy = false;
      }
    }

    function goAppeals() {
      s.tab = 'appeals';
      focusSoon('#users-tab-appeals');
    }
    function openFromAppeal(userId) {
      s.tab = 'all';
      openUser(userId);
    }

    return {
      s,
      fmt,
      banner,
      closeBanner,
      tabs,
      LEVEL_FILTERS,
      loadList,
      loadAppeals,
      loadDetail,
      onSearch,
      searchNow,
      toggleSel,
      closeDetail,
      du,
      dc,
      pendingAppeal,
      typeLabel,
      typeTone,
      canRevoke,
      timelineSource,
      recordSource,
      creditRows,
      hiddenCount,
      hasIssues,
      askRevoke,
      cancelRevoke,
      revokeText,
      revoke,
      ask,
      cancelAsk,
      account,
      appealStatus,
      hoursText,
      evidenceHint,
      resolveAppeal,
      goAppeals,
      openFromAppeal,
    };
  },
  template: html`
<div class="page">
  <header class="page-head page-head--col">
    <h1 class="page-title" tabindex="-1" data-page-title>用户与信用</h1>
    <p class="page-desc">信用只看守不守约，不看话多不多。撤销一条记录或通过申诉后，履约率马上重算，并通知本人。</p>
  </header>

  <StatusBanner :banner="banner" @close="closeBanner" />

  <TabList v-model="s.tab" :tabs="tabs" label="用户分类" id-prefix="users" />

  <div id="users-panel" role="tabpanel" :aria-labelledby="'users-tab-' + s.tab" class="stack-20">
    <template v-if="s.tab !== 'appeals'">
      <section class="filters filters--row" aria-label="筛选">
        <div class="search">
          <Icon name="search" :size="18" stroke="#5B5F68" :weight="2" />
          <input v-model="s.q" type="search" class="search__input" aria-label="搜昵称或手机尾号" placeholder="搜昵称或手机尾号" autocomplete="off" @input="onSearch" @keydown.enter.prevent="searchNow">
        </div>
        <div class="chips" role="group" aria-label="信用等级">
          <button v-for="f in LEVEL_FILTERS" :key="f.key" type="button" class="chip chip--sm" :aria-pressed="s.lv === f.key ? 'true' : 'false'" @click="s.lv = f.key">{{ f.label }}</button>
        </div>
      </section>

      <div class="table-wrap">
        <table class="table table--users" :aria-busy="s.loading ? 'true' : 'false'">
          <caption class="sr-only">用户列表</caption>
          <thead>
            <tr>
              <th scope="col">用户</th><th scope="col">手机</th><th scope="col">注册</th><th scope="col">履约率</th><th scope="col">到场</th>
              <th scope="col">临时鸽</th><th scope="col">放鸽子</th><th scope="col">被举报</th><th scope="col">信用</th><th scope="col"><span class="sr-only">操作</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="s.error"><td colspan="10" class="table__state" role="alert">加载失败：{{ s.error }} <button type="button" class="btn btn--outline btn--sm" @click="loadList">重试</button></td></tr>
            <tr v-else-if="s.loading && !s.rows.length"><td colspan="10" class="table__state" role="status">正在加载…</td></tr>
            <tr v-else-if="!s.rows.length"><td colspan="10" class="table__state">{{ s.tab === 'restricted' && !s.q && s.lv === 'all' ? '现在没有受限的用户。' : '没有找到符合条件的用户。' }}</td></tr>
            <template v-if="!s.error">
              <tr v-for="u in s.rows" :key="u.id" :class="{ 'is-selected': s.sel === u.id }">
                <td>
                  <span class="user-cell">
                    <Avatar :user="u" :size="32" />
                    <span class="user-cell__text">
                      <span class="user-cell__name">{{ u.nickname }}</span>
                      <span v-if="u.status !== 'active' && u.restrictedReason" class="user-cell__sub">{{ u.status === 'banned' ? '封号' : '受限' }}：{{ u.restrictedReason }}</span>
                    </span>
                  </span>
                </td>
                <td class="body">{{ u.phoneMasked || '—' }}</td>
                <td class="body">{{ fmt.shortDate(u.createdAt) }}</td>
                <td class="num strong">{{ u.credit.rate }}%</td>
                <td class="num">{{ u.credit.attended + u.credit.late }}</td>
                <td class="num">{{ u.credit.cancelLate }}</td>
                <td class="num">{{ u.credit.noShow }}</td>
                <td class="num">{{ u.reportCount }}</td>
                <td><LevelPill :level="fmt.userLevel(u)" /></td>
                <td><button :id="'view-' + u.id" type="button" class="btn btn--outline btn--sm" :aria-pressed="s.sel === u.id ? 'true' : 'false'" :aria-label="'查看 ' + u.nickname" @click="toggleSel(u)">查看</button></td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <section v-if="s.sel" id="user-detail" class="card detail" aria-label="用户详情">
        <LoadState v-if="!s.detail" :loading="s.detailLoading" :error="s.detailError" @retry="loadDetail()" />
        <template v-else>
          <div class="detail__head">
            <Avatar :user="du" :size="56" />
            <div class="stack-4 grow">
              <div class="title-row">
                <h2 id="user-detail-title" class="detail-title" tabindex="-1">{{ du.nickname }}</h2>
                <LevelPill :level="fmt.userLevel(du)" />
              </div>
              <span class="small muted">{{ du.phoneMasked || '没绑手机' }} · {{ fmt.shortDate(du.createdAt) }}注册 · {{ du.interests && du.interests.length ? '兴趣：' + du.interests.join('、') : '还没选兴趣' }}</span>
              <span class="body-text body">{{ du.bio || '还没写介绍。' }}</span>
            </div>
            <button type="button" class="icon-btn" aria-label="收起详情" @click="closeDetail"><Icon name="close" :size="18" :weight="2" /></button>
          </div>

          <div class="user-cols">
            <div class="user-cols__left">
              <div class="credit-tiles">
                <div class="credit-tile credit-tile--big"><span class="credit-tile__label">履约率</span><span class="credit-tile__big">{{ dc.rate }}%</span></div>
                <div class="credit-tile"><span class="credit-tile__label">准时</span><span class="credit-tile__num">{{ dc.attended }}</span></div>
                <div class="credit-tile"><span class="credit-tile__label">迟到</span><span class="credit-tile__num">{{ dc.late }}</span></div>
                <div class="credit-tile"><span class="credit-tile__label">临时鸽</span><span class="credit-tile__num">{{ dc.cancelLate }}</span></div>
                <div class="credit-tile"><span class="credit-tile__label">放鸽子</span><span class="credit-tile__num">{{ dc.noShow }}</span></div>
                <div class="credit-tile"><span class="credit-tile__label">被举报</span><span class="credit-tile__num">{{ du.reportCount }}</span></div>
              </div>

              <div v-if="pendingAppeal" class="hint-box">
                <span class="hint-box__text">{{ du.nickname }} 对一条「{{ pendingAppeal.creditEvent ? typeLabel(pendingAppeal.creditEvent) : '信用' }}」记录提出了申诉。</span>
                <button type="button" class="btn btn--primary btn--sm" @click="goAppeals">去处理申诉</button>
              </div>

              <div class="account-box">
                <span class="account-box__title">账号处理</span>
                <span v-if="du.status === 'restricted'" class="text-danger small">受限到 {{ fmt.dateTime(du.restrictedUntil) }}{{ du.restrictedReason ? ' · ' + du.restrictedReason : '' }}。这期间不能撮合和报名。</span>
                <span v-if="du.status === 'banned'" class="text-danger small">已封号{{ du.restrictedReason ? ' · ' + du.restrictedReason : '' }}。不能登录。</span>
                <div v-if="!s.ask" id="account-actions" class="actions actions--tight">
                  <button v-if="du.status === 'active'" type="button" class="btn btn--outline btn--sm" @click="ask('restrict')">限制 7 天</button>
                  <button v-if="du.status === 'restricted'" type="button" class="btn btn--outline btn--sm" :disabled="s.busy" @click="account('unrestrict')">解除限制</button>
                  <button v-if="du.status !== 'banned'" type="button" class="btn btn--danger-outline btn--sm" @click="ask('ban')">封号</button>
                  <button v-if="du.status === 'banned'" type="button" class="btn btn--outline btn--sm" :disabled="s.busy" @click="account('unban')">解封</button>
                </div>
                <div v-if="s.ask === 'restrict'" class="stack-8">
                  <label for="rs-why" class="field__label">限制原因（会告诉 TA）</label>
                  <input id="rs-why" v-model="s.restrictWhy" type="text" class="input input--sm" maxlength="100" placeholder="比如：多次在局里推销" autocomplete="off">
                  <div class="actions actions--tight">
                    <button type="button" class="btn btn--primary btn--sm" :disabled="s.busy" @click="account('restrict')">确认限制 7 天</button>
                    <button type="button" class="btn btn--outline btn--sm" @click="cancelAsk">算了</button>
                  </div>
                </div>
                <div v-if="s.ask === 'ban'" class="confirm-box confirm-box--danger">
                  <span id="ban-ask" class="small" tabindex="-1">封号后，{{ du.nickname }} 不能再登录，也不能参加任何局。确定吗？</span>
                  <label for="ban-why" class="field__label">封号原因（选填，会告诉 TA）</label>
                  <input id="ban-why" v-model="s.banWhy" type="text" class="input input--sm" maxlength="100" placeholder="比如：多次骚扰其他用户" autocomplete="off">
                  <div class="actions actions--tight">
                    <button type="button" class="btn btn--danger btn--sm" :disabled="s.busy" @click="account('ban')">确定封号</button>
                    <button type="button" class="btn btn--outline btn--sm" @click="cancelAsk">再想想</button>
                  </div>
                </div>
              </div>
            </div>

            <div class="user-cols__right">
              <h3 id="credit-title" class="timeline__title">信用记录</h3>
              <ul v-if="creditRows.length" class="timeline" aria-labelledby="credit-title">
                <li v-for="c in creditRows" :key="c.id" class="timeline__row">
                  <span class="timeline__date">{{ fmt.shortDate(c.createdAt) }}</span>
                  <div class="timeline__body">
                    <span class="timeline__ev" :class="{ 'is-struck': c.revoked }">{{ c.eventTitle || c.note || typeLabel(c) }}</span>
                    <span class="timeline__src">{{ timelineSource(c) }}</span>
                  </div>
                  <span class="pill" :class="['pill--' + typeTone(c), { 'is-struck': c.revoked }]">{{ typeLabel(c) }}</span>
                  <span v-if="c.revoked" class="pill pill--stone">已撤销</span>
                  <span v-else-if="c.appeal && c.appeal.status === 'pending'" class="pill pill--warn">申诉中</span>
                  <button v-if="canRevoke(c) && s.revokeAsk !== c.id" :id="'revoke-' + c.id" type="button" class="btn btn--outline btn--sm"
                    :aria-label="'撤销 ' + fmt.shortDate(c.createdAt) + ' 的「' + typeLabel(c) + '」'" @click="askRevoke(c)">撤销这条</button>
                  <div v-if="s.revokeAsk === c.id" class="revoke-ask">
                    <span :id="'revoke-ask-' + c.id" class="revoke-ask__text" tabindex="-1">{{ revokeText(c) }}</span>
                    <button type="button" class="btn btn--primary btn--sm" :disabled="s.busy" @click="revoke(c)">确定撤销</button>
                    <button type="button" class="btn btn--outline btn--sm" @click="cancelRevoke(c)">算了</button>
                  </div>
                </li>
              </ul>
              <p v-else class="timeline__more">还没有信用记录。</p>
              <p v-if="hiddenCount" class="timeline__more">更早还有 {{ hiddenCount }} 条记录，都是准时到场。<button type="button" class="text-btn" @click="s.showAllCredit = true">全部显示</button></p>
              <p v-else-if="creditRows.length && !hasIssues" class="timeline__more">最近的记录都是准时到场，没有需要处理的。</p>
            </div>
          </div>
        </template>
      </section>
    </template>

    <template v-else>
      <LoadState v-if="s.appealsLoading || (s.appealsError && !s.appeals.length)" :loading="s.appealsLoading" :error="s.appealsError" @retry="loadAppeals" />
      <div v-else-if="!s.appeals.length" class="card empty">
        <span class="empty__title">没有待处理的申诉</span>
        <span class="empty__text">用户对信用记录提出申诉后，会出现在这里。</span>
      </div>
      <template v-else>
        <article v-for="a in s.appeals" :key="a.id" class="card appeal" :aria-labelledby="'ap-title-' + a.id">
          <div class="detail__head">
            <Avatar :user="a.user" :size="48" />
            <div class="stack-4 grow">
              <div class="title-row">
                <h2 :id="'ap-title-' + a.id" class="detail-title">{{ a.user.nickname }} 的申诉</h2>
                <span class="pill" :class="'pill--' + appealStatus(a)[1]">{{ appealStatus(a)[0] }}</span>
              </div>
              <span class="small muted">{{ fmt.shortDate(a.createdAt) }} 提交 · 现在履约 {{ a.user.creditRate }}% · 信用{{ fmt.LEVEL[fmt.userLevel(a.user)].label }}</span>
            </div>
          </div>
          <div class="stack-8">
            <span class="label">申诉的记录</span>
            <div v-if="a.creditEvent" class="record-box">
              <span class="strong">{{ fmt.shortDate(a.creditEvent.createdAt) }} · {{ a.creditEvent.eventTitle || '没有关联具体的局' }}</span>
              <span class="pill" :class="['pill--' + typeTone(a.creditEvent), { 'is-struck': a.creditEvent.revoked || a.status === 'approved' }]">{{ typeLabel(a.creditEvent) }}</span>
              <span class="small muted">{{ recordSource(a.creditEvent) }}</span>
            </div>
            <p v-else class="muted">这条记录已经不存在了。</p>
          </div>
          <div class="stack-8">
            <span class="label">TA 说</span>
            <blockquote class="quote">{{ a.text }}</blockquote>
          </div>
          <div class="stack-8">
            <span class="label">系统找到的证据</span>
            <div class="evidence">
              <div v-for="(m, i) in a.evidence || []" :key="i" class="evidence__item">
                <span class="evidence__meta">群聊记录 · {{ fmt.dateTime(m.createdAt) }} · 开场前 {{ hoursText(m.hoursBeforeStart) }} 小时</span>
                <span class="evidence__text">{{ a.user.nickname }}：「{{ m.text }}」</span>
              </div>
              <span class="evidence__hint">{{ evidenceHint(a) }}</span>
            </div>
          </div>
          <div><button type="button" class="text-btn" @click="openFromAppeal(a.user.id)">看 {{ a.user.nickname }} 的全部信用记录</button></div>
          <div v-if="a.status === 'pending'" class="decide">
            <label :for="'ap-reply-' + a.id" class="field__label">回复{{ a.user.nickname }}（会用服务通知发给 TA）</label>
            <textarea :id="'ap-reply-' + a.id" v-model="s.replies[a.id]" class="input textarea" maxlength="200" placeholder="通过时可以不写；驳回时写一句原因"></textarea>
            <p v-if="s.appealErr[a.id]" class="form-error" role="alert">{{ s.appealErr[a.id] }}</p>
            <div class="actions">
              <button type="button" class="btn btn--primary btn--lg" :disabled="s.busy" @click="resolveAppeal(a, true)">通过，撤销这条记录</button>
              <button type="button" class="btn btn--outline btn--lg" :disabled="s.busy" @click="resolveAppeal(a, false)">驳回</button>
            </div>
          </div>
          <div v-else class="done-box">
            <span class="done-box__title">{{ a.status === 'approved' ? '已通过，这条记录已撤销' : '已驳回，记录保留' }}</span>
            <span class="small body">{{ a.adminNote ? '回复已发给 ' + a.user.nickname + '：' + a.adminNote : '已通知 ' + a.user.nickname + '。' }}</span>
          </div>
        </article>
        <p class="small muted">没有别的申诉了。</p>
      </template>
    </template>
  </div>
</div>`,
};
