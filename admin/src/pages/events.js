// 局管理：搜索 + 状态 / 来源筛选，表格，详情（成员、群聊、AA、举报），取消局，审核用户发起的局，发起平台局。
import { computed, onBeforeUnmount, onMounted, reactive, watch } from '../vue.js';
import { api } from '../api.js';
import { route } from '../router.js';
import { refreshBadges } from '../store.js';
import * as fmt from '../format.js';
import { focusSoon, html, useBanner } from '../ui.js';

const STATUS_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'open', label: '招募中' },
  { key: 'inviting', label: '邀请中' },
  { key: 'formed', label: '已成局' },
  { key: 'pending_review', label: '待审核' },
  { key: 'ended', label: '已结束' },
  { key: 'cancelled', label: '已取消' },
  { key: 'rejected', label: '未通过' },
];
const SOURCE_FILTERS = [
  { key: 'all', label: '全部来源' },
  { key: 'matched', label: '撮合' },
  { key: 'user', label: '用户发起' },
  { key: 'platform', label: '平台' },
];
const CANCEL_REASONS = ['天气不好', '人数不够', '安全原因', '发起人要求', '其他'];
const REVIEW_REJECT = ['像交友或约会', '有安全风险', '广告推销', '其他'];

function emptyForm() {
  return {
    title: '',
    category: 'outdoor',
    date: fmt.addDays(fmt.todayStr(), 1),
    time: '',
    durationMin: 120,
    place: '',
    meetingPoint: '',
    capacity: 6,
    feeType: 'aa',
    feeEstimate: '',
    description: '',
  };
}

export default {
  name: 'EventsPage',
  setup() {
    const { banner, showBanner, failBanner, closeBanner } = useBanner();
    const s = reactive({
      q: '',
      fs: 'all',
      fsrc: 'all',
      loading: true,
      error: '',
      rows: [],
      sel: route.query.id ? Number(route.query.id) : null,
      detail: null,
      detailLoading: false,
      detailError: '',
      creating: false,
      nf: emptyForm(),
      nfErr: '',
      busy: false,
      cancelling: false,
      cancelWhy: '',
      cancelErr: '',
      rejOpen: false,
      rejWhy: '',
      rejErr: '',
      reminding: false,
    });

    // ---- 列表 ----

    let listSeq = 0;
    async function load() {
      const seq = ++listSeq;
      s.loading = true;
      s.error = '';
      try {
        // status=ended 是按时间算的「已结束」；open / formed 只含还没结束的（服务端处理）
        const query = {
          status: s.fs === 'all' ? undefined : s.fs,
          source: s.fsrc === 'all' ? undefined : s.fsrc,
          q: s.q.trim() || undefined,
        };
        const res = await api('/admin/events', { query });
        if (seq !== listSeq) return;
        s.rows = res.items;
      } catch (e) {
        if (seq === listSeq) s.error = e.message;
      } finally {
        if (seq === listSeq) s.loading = false;
      }
    }

    let searchTimer = null;
    function onSearch() {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(load, 300);
    }
    function searchNow() {
      clearTimeout(searchTimer);
      load();
    }
    onBeforeUnmount(() => clearTimeout(searchTimer));
    watch(() => [s.fs, s.fsrc], load);

    onMounted(() => {
      load();
      if (s.sel) openDetail(s.sel); // 从别的页面带着 ?id= 过来：直接打开并滚到详情
    });
    watch(
      () => route.query.id,
      (id) => {
        if (id && Number(id) !== s.sel) openDetail(Number(id));
      },
    );

    // ---- 详情 ----

    let detailSeq = 0;
    async function loadDetail() {
      const id = s.sel;
      if (!id) return;
      const seq = ++detailSeq;
      s.detailLoading = true;
      s.detailError = '';
      try {
        const d = await api(`/admin/events/${id}`);
        if (seq === detailSeq) s.detail = d;
      } catch (e) {
        if (seq === detailSeq) s.detailError = e.message;
      } finally {
        if (seq === detailSeq) s.detailLoading = false;
      }
    }

    function resetPanels() {
      Object.assign(s, { cancelling: false, cancelWhy: '', cancelErr: '', rejOpen: false, rejWhy: '', rejErr: '' });
    }

    async function openDetail(id) {
      s.sel = id;
      s.detail = null;
      resetPanels();
      await loadDetail();
      focusSoon('#ev-detail-title');
    }

    function toggleSel(e) {
      if (s.sel === e.id) closeDetail();
      else openDetail(e.id);
    }

    function closeDetail() {
      const id = s.sel;
      s.sel = null;
      s.detail = null;
      resetPanels();
      if (id) focusSoon(`#view-${id}`);
    }

    const ev = computed(() => (s.detail ? s.detail.event : null));
    const joinedN = computed(() => (s.detail ? s.detail.members.filter((m) => m.status === 'joined').length : 0));
    const notifyN = computed(() =>
      s.detail ? s.detail.members.filter((m) => ['joined', 'applied', 'invited'].includes(m.status)).length : 0,
    );
    const shownMembers = computed(() => (s.detail ? s.detail.members.filter((m) => m.status !== 'removed') : []));
    const recentMessages = computed(() => (s.detail ? s.detail.messages.slice(-6) : []));
    const isLive = (e) => ['open', 'inviting', 'formed'].includes(e.status) && e.phase !== 'ended';

    function byShort(e) {
      if (e.source === 'matched') return '系统撮合';
      if (e.source === 'platform') return '平台局';
      return `发起人 ${e.creator ? e.creator.nickname : '—'}`;
    }
    function byLong(e) {
      if (e.source === 'matched') return '系统撮合 · 没有发起人，只有成员能看到';
      if (e.source === 'platform') return '平台局 · 由平台张罗';
      return `用户发起 · 发起人 ${e.creator ? e.creator.nickname : '—'}`;
    }

    function memberState(m) {
      const e = ev.value;
      const OTHER = { invited: '还没回复邀请', applied: '申请加入中', declined: '没有加入', expired: '邀请过期没回复', left: '已退出' };
      if (m.status !== 'joined') return OTHER[m.status] || m.status;
      const parts = [];
      if (m.role === 'host') parts.push('发起人');
      if (e.phase === 'ended') {
        parts.push(m.arrivedAt ? '到了' : m.attendance === 'yes' ? '确认过出席' : '没确认出席');
      } else if (e.status === 'inviting') {
        parts.push('已加入');
      } else if (e.status === 'formed' || m.attendance !== 'pending') {
        parts.push({ yes: '已确认出席', no: '说了去不了' }[m.attendance] || '还没确认出席');
      } else if (m.role !== 'host') {
        parts.push('已报名');
      }
      return parts.join(' · ');
    }

    const msgCount = computed(() => {
      const n = s.detail ? s.detail.messages.length : 0;
      return n >= 50 ? '50+' : String(n);
    });
    const aaText = computed(() => {
      const aa = s.detail && s.detail.aa;
      return aa && aa.itemCount ? `${aa.itemCount} 笔 ¥${aa.total}` : '还没记账';
    });
    const cancelHint = computed(() =>
      ev.value && ev.value.source === 'matched'
        ? '取消后会通知所有成员，大家的意向放回撮合池继续配，不扣任何人的信用。'
        : '取消后会通知所有报名的人，不扣任何人的信用。',
    );

    // ---- 取消 ----

    function openCancel() {
      s.cancelling = true;
      s.cancelWhy = '';
      s.cancelErr = '';
      focusSoon('#cancel-title');
    }
    function closeCancel() {
      s.cancelling = false;
      s.cancelErr = '';
      focusSoon('#cancel-open');
    }

    async function confirmCancel() {
      if (s.busy) return;
      if (!s.cancelWhy) {
        s.cancelErr = '先选一个原因';
        return;
      }
      const e = ev.value;
      const n = notifyN.value;
      const why = s.cancelWhy;
      s.busy = true;
      try {
        await api(`/admin/events/${e.id}/cancel`, { method: 'POST', body: { reason: why } });
        resetPanels();
        const tail = e.source === 'matched' ? '，意向已放回撮合池。' : '。';
        showBanner(n ? `已取消「${e.title}」（${why}），已通知 ${n} 位成员${tail}` : `已取消「${e.title}」（${why}）${tail}`);
        await Promise.all([load(), loadDetail()]);
        refreshBadges();
      } catch (err) {
        if (err.code === 'CONFLICT' || err.code === 'NOT_FOUND') {
          failBanner(err);
          resetPanels();
          load();
          loadDetail();
        } else {
          s.cancelErr = err.message;
        }
      } finally {
        s.busy = false;
      }
    }

    // ---- 撮合局邀请中：提醒还没回复的人 ----

    async function remind() {
      if (s.reminding || !ev.value) return;
      s.reminding = true;
      try {
        const { reminded } = await api(`/admin/events/${ev.value.id}/remind`, { method: 'POST' });
        showBanner(reminded ? `已用微信服务通知提醒 ${reminded} 位还没回复的人。` : '都已回复，没有需要提醒的人。');
      } catch (e) {
        failBanner(e, '没能提醒');
        if (e.code === 'CONFLICT' || e.code === 'NOT_FOUND') {
          load();
          loadDetail();
        }
      } finally {
        s.reminding = false;
      }
    }

    // ---- 审核用户发起的局 ----

    function openRej() {
      s.rejOpen = true;
      s.rejWhy = '';
      s.rejErr = '';
      focusSoon('#ev-rej-title');
    }

    async function review(approve) {
      if (s.busy) return;
      if (!approve && !s.rejWhy) {
        s.rejErr = '先选一个原因';
        return;
      }
      const e = ev.value;
      s.busy = true;
      try {
        await api(`/admin/events/${e.id}/${approve ? 'approve' : 'reject'}`, {
          method: 'POST',
          body: approve ? {} : { note: s.rejWhy },
        });
        resetPanels();
        const who = e.creator ? e.creator.nickname : '发起人';
        showBanner(approve ? `已通过：「${e.title}」已经发到广场。` : `没有通过：已通知 ${who}，可以改了再发。`);
        await Promise.all([load(), loadDetail()]);
        refreshBadges();
      } catch (err) {
        if (approve || err.code === 'CONFLICT' || err.code === 'NOT_FOUND') {
          failBanner(err);
          load();
          loadDetail();
        } else {
          s.rejErr = err.message;
        }
      } finally {
        s.busy = false;
      }
    }

    // ---- 发起平台局 ----

    function toggleCreate() {
      s.creating = !s.creating;
      s.nfErr = '';
      if (s.creating) focusSoon('#n-title');
    }

    async function publish() {
      if (s.busy) return;
      const f = s.nf;
      const title = f.title.trim();
      const place = f.place.trim();
      if (!title || !f.date || !f.time || !place) {
        s.nfErr = '标题、日期、开始时间和地点都要填';
        return;
      }
      if (title.length < 2) {
        s.nfErr = '标题至少 2 个字';
        return;
      }
      const startAt = fmt.bjToISO(f.date, f.time);
      if (!startAt) {
        s.nfErr = '日期或开始时间的格式不对';
        return;
      }
      if (Date.parse(startAt) < Date.now() + 30 * 60 * 1000) {
        s.nfErr = '开始时间至少要在 30 分钟以后';
        return;
      }
      const body = {
        title,
        category: f.category,
        startAt,
        durationMin: Number(f.durationMin),
        place,
        meetingPoint: f.meetingPoint.trim(),
        capacity: f.capacity,
        feeType: f.feeType,
        description: f.description.trim(),
      };
      if (f.feeType !== 'free' && f.feeEstimate !== '' && f.feeEstimate !== null) body.feeEstimate = Number(f.feeEstimate);
      s.busy = true;
      s.nfErr = '';
      try {
        const { eventId } = await api('/admin/events', { method: 'POST', body });
        s.creating = false;
        s.nf = emptyForm();
        // 新局一定能在「全部」里看到
        s.fs = 'all';
        s.fsrc = 'all';
        s.q = '';
        await load();
        showBanner(`已发布到广场：「${title}」。满员会自动成群。`);
        await openDetail(eventId);
      } catch (e) {
        s.nfErr = e.message;
      } finally {
        s.busy = false;
      }
    }

    return {
      s,
      fmt,
      banner,
      closeBanner,
      load,
      onSearch,
      searchNow,
      loadDetail,
      toggleSel,
      closeDetail,
      ev,
      joinedN,
      notifyN,
      shownMembers,
      recentMessages,
      isLive,
      byShort,
      byLong,
      memberState,
      msgCount,
      aaText,
      cancelHint,
      openCancel,
      closeCancel,
      confirmCancel,
      openRej,
      review,
      remind,
      toggleCreate,
      publish,
      STATUS_FILTERS,
      SOURCE_FILTERS,
      CANCEL_REASONS,
      REVIEW_REJECT,
      CATEGORY: fmt.CATEGORY,
      DURATIONS: fmt.DURATIONS,
      today: fmt.todayStr(),
    };
  },
  template: html`
<div class="page">
  <header class="page-head">
    <div class="page-head__text page-head__text--grow">
      <h1 class="page-title" tabindex="-1" data-page-title>局管理</h1>
      <p class="page-desc">撮合出来的局、用户发起的局、平台自己办的局都在这里。撮合局只有成员能看到，不进广场。</p>
    </div>
    <button type="button" class="btn btn--primary btn--head" :aria-expanded="s.creating ? 'true' : 'false'" aria-controls="new-event" @click="toggleCreate">
      <Icon name="plus" :size="18" :weight="2.2" />发起平台局
    </button>
  </header>

  <StatusBanner :banner="banner" @close="closeBanner" />

  <section v-if="s.creating" id="new-event" class="card stack-16" aria-labelledby="new-title">
    <div class="stack-4">
      <h2 id="new-title" class="section-title">发起一个平台局</h2>
      <p class="small muted">平台局直接发到广场，谁都可以报名。没有发起人，由平台张罗；满员自动成群。</p>
    </div>
    <form class="stack-16" novalidate @submit.prevent="publish">
      <div class="field">
        <label for="n-title" class="field__label">标题</label>
        <input id="n-title" v-model="s.nf.title" type="text" class="input" maxlength="30" placeholder="比如：周六上午 · 喜洲骑行" autocomplete="off">
      </div>
      <div class="field">
        <span id="n-cat" class="field__label">分类</span>
        <div class="chips" role="group" aria-labelledby="n-cat">
          <button v-for="(label, key) in CATEGORY" :key="key" type="button" class="chip" :aria-pressed="s.nf.category === key ? 'true' : 'false'" @click="s.nf.category = key">{{ label }}</button>
        </div>
      </div>
      <div class="form-grid">
        <div class="field field--date">
          <label for="n-date" class="field__label">日期<span v-if="s.nf.date" class="field__hint">{{ fmt.weekday(s.nf.date) }}</span></label>
          <input id="n-date" v-model="s.nf.date" type="date" class="input" :min="today">
        </div>
        <div class="field field--time">
          <label for="n-time" class="field__label">开始时间</label>
          <input id="n-time" v-model="s.nf.time" type="time" class="input">
        </div>
        <div class="field field--time">
          <label for="n-dur" class="field__label">时长</label>
          <select id="n-dur" v-model.number="s.nf.durationMin" class="input select">
            <option v-for="d in DURATIONS" :key="d" :value="d">{{ fmt.duration(d) }}</option>
          </select>
        </div>
        <div class="field field--wide">
          <label for="n-place" class="field__label">地点</label>
          <input id="n-place" v-model="s.nf.place" type="text" class="input" maxlength="40" autocomplete="off">
        </div>
        <div class="field field--wide">
          <label for="n-meet" class="field__label">集合点<span class="field__hint">选填</span></label>
          <input id="n-meet" v-model="s.nf.meetingPoint" type="text" class="input" maxlength="60" autocomplete="off">
        </div>
      </div>
      <div class="form-row">
        <div class="field">
          <span id="n-cap" class="field__label">人数上限</span>
          <Stepper v-model="s.nf.capacity" :min="2" :max="20" labelledby="n-cap" />
        </div>
        <FeePicker v-model:feeType="s.nf.feeType" v-model:estimate="s.nf.feeEstimate" id-prefix="n" />
      </div>
      <div class="field">
        <label for="n-desc" class="field__label">介绍（选填）</label>
        <textarea id="n-desc" v-model="s.nf.description" class="input textarea" maxlength="500"></textarea>
      </div>
      <p v-if="s.nfErr" class="form-error" role="alert">{{ s.nfErr }}</p>
      <div class="actions">
        <button type="submit" class="btn btn--primary btn--lg" :disabled="s.busy">{{ s.busy ? '正在发布…' : '发布到广场' }}</button>
        <button type="button" class="btn btn--outline btn--lg" @click="toggleCreate">取消</button>
      </div>
    </form>
  </section>

  <section class="filters" aria-label="筛选">
    <div class="filters__row">
      <div class="search">
        <Icon name="search" :size="18" stroke="#5B5F68" :weight="2" />
        <input v-model="s.q" type="search" class="search__input" aria-label="搜标题或地点" placeholder="搜标题或地点" autocomplete="off" @input="onSearch" @keydown.enter.prevent="searchNow">
      </div>
      <div class="chips" role="group" aria-label="来源">
        <button v-for="f in SOURCE_FILTERS" :key="f.key" type="button" class="chip chip--sm" :aria-pressed="s.fsrc === f.key ? 'true' : 'false'" @click="s.fsrc = f.key">{{ f.label }}</button>
      </div>
    </div>
    <div class="chips" role="group" aria-label="状态">
      <button v-for="f in STATUS_FILTERS" :key="f.key" type="button" class="chip chip--sm" :aria-pressed="s.fs === f.key ? 'true' : 'false'" @click="s.fs = f.key">{{ f.label }}</button>
    </div>
  </section>

  <div class="table-wrap">
    <table class="table table--events" :aria-busy="s.loading ? 'true' : 'false'">
      <caption class="sr-only">局列表</caption>
      <thead>
        <tr><th scope="col">局</th><th scope="col">时间</th><th scope="col">地点</th><th scope="col">人数</th><th scope="col">来源</th><th scope="col">状态</th><th scope="col"><span class="sr-only">操作</span></th></tr>
      </thead>
      <tbody>
        <tr v-if="s.error"><td colspan="7" class="table__state" role="alert">加载失败：{{ s.error }} <button type="button" class="btn btn--outline btn--sm" @click="load">重试</button></td></tr>
        <tr v-else-if="s.loading && !s.rows.length"><td colspan="7" class="table__state" role="status">正在加载…</td></tr>
        <tr v-else-if="!s.rows.length"><td colspan="7" class="table__state">没有符合条件的局。换个筛选条件试试。</td></tr>
        <template v-if="!s.error">
          <tr v-for="e in s.rows" :key="e.id" :class="{ 'is-selected': s.sel === e.id }">
            <td>
              <div class="cell-title">
                <span class="cell-title__main">{{ e.title }}</span>
                <span class="cell-title__sub">{{ fmt.categoryLabel(e.category) }} · {{ byShort(e) }}</span>
              </div>
            </td>
            <td>{{ fmt.dateTime(e.startAt) }}</td>
            <td class="body">{{ e.place }}</td>
            <td class="num strong">{{ e.memberCount }}/{{ e.capacity }}</td>
            <td class="body small">{{ fmt.sourceLabel(e.source) }}</td>
            <td><StatusPill :status="fmt.displayStatus(e)" /></td>
            <td><button :id="'view-' + e.id" type="button" class="btn btn--outline btn--sm" :aria-pressed="s.sel === e.id ? 'true' : 'false'" :aria-label="'查看 ' + e.title" @click="toggleSel(e)">查看</button></td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>

  <section v-if="s.sel" id="event-detail" class="card detail" aria-label="局详情">
    <LoadState v-if="!s.detail" :loading="s.detailLoading" :error="s.detailError" @retry="loadDetail" />
    <template v-else>
      <div class="detail__head">
        <div class="stack-6 grow">
          <div class="title-row">
            <h2 id="ev-detail-title" class="detail-title" tabindex="-1">{{ ev.title }}</h2>
            <StatusPill :status="fmt.displayStatus(ev)" />
          </div>
          <span class="small muted">{{ fmt.categoryLabel(ev.category) }} · {{ byLong(ev) }}</span>
        </div>
        <button type="button" class="icon-btn" aria-label="收起详情" @click="closeDetail"><Icon name="close" :size="18" :weight="2" /></button>
      </div>

      <div class="info-tiles">
        <div class="info-tile"><span class="info-tile__label">时间</span><span class="info-tile__value">{{ fmt.dateTime(ev.startAt) }} · {{ fmt.duration(ev.durationMin) }}{{ ev.phase === 'ongoing' ? ' · 进行中' : '' }}</span></div>
        <div class="info-tile"><span class="info-tile__label">地点 · 集合点</span><span class="info-tile__value">{{ ev.place }}{{ ev.meetingPoint ? ' · ' + ev.meetingPoint : '' }}</span></div>
        <div class="info-tile"><span class="info-tile__label">费用</span><span class="info-tile__value">{{ ev.feeLabel || '—' }}</span></div>
        <div class="info-tile"><span class="info-tile__label">群里</span><span class="info-tile__value">{{ msgCount }} 条消息 · AA {{ aaText }} · 被举报 {{ ev.reportCount }} 次</span></div>
      </div>

      <div v-if="ev.inviteDeadline" class="invite-box">
        <span class="invite-box__text">邀请中：{{ ev.joinedCount }} 人已加入，{{ ev.invitedCount }} 人还没回复 · 截止 {{ fmt.when(ev.inviteDeadline) }}</span>
        <button type="button" class="btn btn--outline btn--sm" :disabled="s.reminding" @click="remind">{{ s.reminding ? '正在提醒…' : '提醒还没回复的人' }}</button>
      </div>
      <p v-if="ev.status === 'cancelled' && ev.cancelReason" class="info-box">取消原因：{{ ev.cancelReason }}</p>
      <p v-if="ev.status === 'rejected' && ev.reviewNote" class="info-box">没通过的原因：{{ ev.reviewNote }}</p>
      <p v-if="ev.flags && ev.flags.length" class="info-box info-box--warn">系统标记：{{ ev.flags.join('、') }}</p>
      <div v-if="ev.description" class="stack-8">
        <span class="label">介绍</span>
        <p class="body-text">{{ ev.description }}</p>
      </div>

      <div class="stack-10">
        <span class="label">成员 {{ joinedN }}/{{ ev.capacity }}</span>
        <ul v-if="shownMembers.length" class="member-grid member-grid--fixed" aria-label="成员">
          <li v-for="m in shownMembers" :key="m.id" class="member member--sm">
            <Avatar :user="m" :size="32" />
            <span class="member__body">
              <a class="member__name member__link" :href="'#/users?id=' + m.id">{{ m.nickname }}</a>
              <span class="small muted">{{ memberState(m) }}</span>
            </span>
          </li>
        </ul>
        <p v-else class="muted">还没有人报名。</p>
      </div>

      <div v-if="recentMessages.length" class="stack-8">
        <span class="label">最近的群聊</span>
        <div class="chat-box">
          <p v-for="m in recentMessages" :key="m.id" class="chat-line"><span class="strong">{{ m.user ? m.user.nickname : '系统' }}：</span>{{ m.text }}</p>
        </div>
      </div>

      <div v-if="ev.status === 'pending_review'" class="decide">
        <span class="decide__title">这个局还在等审核</span>
        <div v-if="!s.rejOpen" class="actions">
          <button type="button" class="btn btn--primary btn--lg" :disabled="s.busy" @click="review(true)">通过，发到广场</button>
          <button type="button" class="btn btn--danger-outline btn--lg" @click="openRej">不通过</button>
        </div>
        <template v-else>
          <span id="ev-rej-title" class="label" tabindex="-1">不通过的原因</span>
          <div class="chips" role="group" aria-labelledby="ev-rej-title">
            <button v-for="w in REVIEW_REJECT" :key="w" type="button" class="chip" :aria-pressed="s.rejWhy === w ? 'true' : 'false'" @click="s.rejWhy = w; s.rejErr = ''">{{ w }}</button>
          </div>
          <p class="small muted">发起人会收到通知「你发起的局没有通过审核」和原因，可以改了再发。</p>
          <p v-if="s.rejErr" class="form-error" role="alert">{{ s.rejErr }}</p>
          <div class="actions">
            <button type="button" class="btn btn--danger btn--lg" :disabled="s.busy" @click="review(false)">确认不通过</button>
            <button type="button" class="btn btn--outline btn--lg" @click="s.rejOpen = false">取消</button>
          </div>
        </template>
      </div>

      <div v-else-if="isLive(ev)" class="decide">
        <div v-if="!s.cancelling" class="row-12">
          <button id="cancel-open" type="button" class="btn btn--danger-outline btn--lg" @click="openCancel">取消这个局</button>
          <span class="small muted">{{ cancelHint }}</span>
        </div>
        <template v-else>
          <span id="cancel-title" class="decide__title" tabindex="-1">为什么取消？</span>
          <div class="chips" role="group" aria-labelledby="cancel-title">
            <button v-for="w in CANCEL_REASONS" :key="w" type="button" class="chip" :aria-pressed="s.cancelWhy === w ? 'true' : 'false'" @click="s.cancelWhy = w; s.cancelErr = ''">{{ w }}</button>
          </div>
          <p class="small muted">{{ cancelHint }}</p>
          <p v-if="s.cancelErr" class="form-error" role="alert">{{ s.cancelErr }}</p>
          <div class="actions">
            <button type="button" class="btn btn--danger btn--lg" :disabled="s.busy" @click="confirmCancel">{{ notifyN ? '确认取消，通知 ' + notifyN + ' 人' : '确认取消' }}</button>
            <button type="button" class="btn btn--outline btn--lg" @click="closeCancel">先不取消</button>
          </div>
        </template>
      </div>

      <p v-else class="readonly-note">这个局{{ fmt.EVENT_STATUS[fmt.displayStatus(ev)].label }}，只能查看。</p>
    </template>
  </section>
</div>`,
};
