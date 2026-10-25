// 概览：今天的数字、近 7 天成局数（柱状图 / 表格）、等你确认的局、待处理的举报、需要留意的事。
import { computed, onBeforeUnmount, onMounted, reactive, ref } from '../vue.js';
import { api } from '../api.js';
import { applyStats, badges } from '../store.js';
import * as fmt from '../format.js';
import { html } from '../ui.js';

const CHART_H = 192; // 图的高度（px），分 3 格
const REFRESH_MS = 5 * 60 * 1000;

/** 纵轴每格的刻度：让最高的柱子落在 2/3 ~ 满格之间 */
function niceStep(top) {
  const raw = Math.max(1, Math.ceil(top / 3));
  for (let mag = 1; ; mag *= 10) {
    for (const s of [1, 2, 3, 4, 5, 6, 8]) if (s * mag >= raw) return s * mag;
  }
}

export default {
  name: 'DashboardPage',
  setup() {
    const s = reactive({
      loading: true,
      error: '',
      stats: null,
      proposals: [],
      reports: [],
      appeals: [],
      intents: [],
      restricted: [],
    });
    const view = ref('chart');
    const hot = ref(-1);

    async function load() {
      s.error = '';
      if (!s.stats) s.loading = true;
      try {
        const [stats, proposals, reports, appeals, intents, restricted] = await Promise.all([
          api('/admin/stats'),
          api('/admin/proposals'),
          api('/admin/reports'),
          api('/admin/appeals'),
          api('/admin/intents'),
          api('/admin/users', { query: { status: 'restricted' } }),
        ]);
        Object.assign(s, {
          stats,
          proposals: proposals.items,
          reports: reports.items,
          appeals: appeals.items,
          intents: intents.items,
          restricted: restricted.items,
        });
        applyStats(stats);
        badges.appeals = appeals.items.length;
      } catch (e) {
        s.error = e.message;
      } finally {
        s.loading = false;
      }
    }

    let timer = null;
    onMounted(() => {
      load();
      timer = setInterval(load, REFRESH_MS);
    });
    onBeforeUnmount(() => clearInterval(timer));

    const today = computed(() => (s.stats ? s.stats.today : {}));
    const todayText = computed(() => {
      const p = fmt.bj(new Date());
      return `${p.m} 月 ${p.d} 日 · ${fmt.weekday(p.date)}`;
    });

    // 和昨天、和前 7 天比（week 是滚动的最近 7×24 小时，prevWeek 是再往前 7×24 小时）
    const deltas = computed(() => {
      const st = s.stats;
      if (!st || !st.yesterday || !st.prevWeek) return { users: '', intents: '', rate: '', noShow: '' };
      const noShow = st.week.noShowCount - st.prevWeek.noShowCount;
      return {
        users: fmt.compare(st.today.newUsers - st.yesterday.newUsers, '昨天'),
        intents: fmt.compare(st.today.newIntents - st.yesterday.newIntents, '昨天'),
        rate: fmt.compare(st.week.attendanceRate - st.prevWeek.attendanceRate, '前 7 天', ' 个百分点'),
        noShow: noShow === 0 ? '和前 7 天一样' : `比前 7 天${noShow > 0 ? '多' : '少'} ${Math.abs(noShow)} 次`,
      };
    });

    const chart = computed(() => {
      const series = (s.stats && s.stats.series) || [];
      const top = Math.max(0, ...series.map((x) => x.formed));
      const step = niceStep(top);
      const max = step * 3;
      const last = series.length - 1;
      const bars = series.map((x, i) => {
        const isToday = i === last;
        const h = Math.round((x.formed / max) * CHART_H);
        const labeled = isToday || (top > 0 && x.formed === top);
        const long = `${fmt.md(x.date)} ${isToday ? '今天' : fmt.weekday(x.date)}`;
        const tip = `${isToday ? '今天到目前' : long} · 成局 ${x.formed} 个`;
        return {
          date: x.date,
          formed: x.formed,
          h,
          labeled,
          isToday,
          tip,
          d: fmt.slash(x.date),
          w: isToday ? '今天' : fmt.weekday(x.date),
          dateLong: isToday ? `${long}（到目前）` : long,
          tipClass: i === 0 ? 'is-first' : isToday ? 'is-last' : '',
        };
      });
      return {
        bars,
        ticks: [0, step, step * 2, step * 3],
        total: series.reduce((sum, x) => sum + x.formed, 0),
        today: last >= 0 ? series[last].formed : 0,
      };
    });

    const otherPending = computed(() => {
      const parts = [];
      if (today.value.pendingPosts) parts.push(`${today.value.pendingPosts} 条动态`);
      if (today.value.pendingEvents) parts.push(`${today.value.pendingEvents} 个用户发起的局`);
      return parts.join('、');
    });

    const longWaiting = computed(() => s.intents.filter((i) => i.waitingHours >= 24).length);

    const watchItems = computed(() => {
      const items = [];
      for (const a of s.appeals.slice(0, 2)) {
        const type = a.creditEvent ? fmt.CREDIT_TYPE[a.creditEvent.type]?.label || a.creditEvent.typeLabel : '信用';
        items.push({ key: `a${a.id}`, href: '#/users?tab=appeals', text: `${a.user.nickname} 对一条「${type}」记录提出申诉` });
      }
      if (s.appeals.length > 2) {
        items.push({ key: 'a-more', href: '#/users?tab=appeals', text: `还有 ${s.appeals.length - 2} 条申诉等你处理` });
      }
      for (const u of s.restricted.slice(0, 2)) {
        const why = u.restrictedReason ? `：${u.restrictedReason}` : '';
        items.push({ key: `u${u.id}`, href: `#/users?id=${u.id}`, text: `${u.nickname} 账号受限中${why}` });
      }
      if (longWaiting.value) {
        items.push({ key: 'wait', href: '#/matching', text: `${longWaiting.value} 个人等了超过一天还没配上` });
      }
      return items;
    });

    return { s, view, hot, load, today, todayText, deltas, chart, otherPending, watchItems, fmt };
  },
  template: html`
<div class="page page--dash">
  <header class="page-head">
    <div class="page-head__text">
      <h1 class="page-title" tabindex="-1" data-page-title>概览</h1>
      <p class="page-desc">{{ todayText }} · 每 5 分钟更新一次</p>
    </div>
    <a v-if="today.pendingProposals" href="#/matching" class="btn btn--primary">去确认 {{ today.pendingProposals }} 个局<Icon name="chevron" :size="18" :weight="2" /></a>
  </header>

  <LoadState v-if="!s.stats" :loading="s.loading" :error="s.error" @retry="load" />
  <template v-else>
    <p v-if="s.error" class="state state--error state--compact" role="alert">刷新失败：{{ s.error }} <button type="button" class="btn btn--outline btn--sm" @click="load">重试</button></p>

    <section class="kpis" aria-label="今天的数字">
      <div class="kpi">
        <span class="kpi__label">今日新用户</span>
        <span class="kpi__value">{{ today.newUsers }}</span>
        <span class="kpi__sub">{{ deltas.users }}</span>
      </div>
      <div class="kpi">
        <span class="kpi__label">今日新意向</span>
        <span class="kpi__value">{{ today.newIntents }}</span>
        <span class="kpi__sub">{{ deltas.intents }}</span>
      </div>
      <a href="#/matching" class="kpi kpi--link">
        <span class="kpi__label">等你确认的局</span>
        <span class="kpi__value">{{ today.pendingProposals }}</span>
        <span class="kpi__more">去撮合池<Icon name="chevron" :size="14" :weight="2.2" /></span>
      </a>
      <a href="#/moderation" class="kpi kpi--link">
        <span class="kpi__label">待处理举报</span>
        <span class="kpi__value">{{ today.pendingReports }}</span>
        <span class="kpi__more">{{ today.pendingPosts + today.pendingEvents ? '另有 ' + (today.pendingPosts + today.pendingEvents) + ' 条内容待审' : '去审核' }}<Icon name="chevron" :size="14" :weight="2.2" /></span>
      </a>
      <div class="kpi">
        <span class="kpi__label">近 7 天履约率</span>
        <span class="kpi__value">{{ s.stats.week.attendanceRate }}%</span>
        <span class="kpi__sub">{{ deltas.rate }}</span>
      </div>
    </section>

    <section class="card chart-card" aria-labelledby="trend-title">
      <div class="chart-card__head">
        <div class="stack-4">
          <h2 id="trend-title" class="section-title">近 7 天成局数</h2>
          <p class="section-desc">撮合局和用户发起的局都算 · 这 7 天共 {{ chart.total }} 个，今天到目前 {{ chart.today }} 个</p>
        </div>
        <div class="seg" role="group" aria-label="显示方式">
          <button type="button" class="seg__btn" :aria-pressed="view === 'chart' ? 'true' : 'false'" @click="view = 'chart'">图表</button>
          <button type="button" class="seg__btn" :aria-pressed="view === 'table' ? 'true' : 'false'" @click="view = 'table'; hot = -1">表格</button>
        </div>
      </div>

      <div v-if="view === 'chart'" class="chart">
        <div class="chart__body">
          <div class="chart__axis" aria-hidden="true">
            <span v-for="(t, i) in chart.ticks" :key="i" class="chart__tick" :style="{ bottom: (i * 64 - 7) + 'px' }">{{ t }}</span>
          </div>
          <div class="chart__plot">
            <div v-for="i in 3" :key="'g' + i" class="chart__grid" :style="{ bottom: (i * 64) + 'px' }" aria-hidden="true"></div>
            <div class="chart__base" aria-hidden="true"></div>
            <div class="chart__bars">
              <button v-for="(b, i) in chart.bars" :key="b.date" type="button" class="chart__hit" :class="{ 'is-hot': hot === i }"
                :aria-label="b.tip"
                @mouseenter="hot = i" @mouseleave="hot = -1" @focus="hot = i" @blur="hot = -1"
                @click="hot = hot === i ? -1 : i" @keydown.esc="hot = -1">
                <span class="chart__bar" :style="{ height: b.h + 'px' }" aria-hidden="true"></span>
                <span v-if="b.labeled" class="chart__value" :style="{ bottom: (b.h + 6) + 'px' }" aria-hidden="true">{{ b.formed }}</span>
                <span v-if="hot === i" class="chart__tip" :class="b.tipClass" role="tooltip" :style="{ bottom: (b.h + (b.labeled ? 30 : 10)) + 'px' }">{{ b.tip }}</span>
              </button>
            </div>
          </div>
        </div>
        <div class="chart__days" aria-hidden="true">
          <span v-for="b in chart.bars" :key="b.date" class="chart__day" :class="{ 'is-today': b.isToday }"><span>{{ b.d }}</span><span>{{ b.w }}</span></span>
        </div>
      </div>

      <table v-else class="mini-table">
        <caption class="sr-only">近 7 天成局数</caption>
        <thead><tr><th scope="col">日期</th><th scope="col" class="num">成局数</th></tr></thead>
        <tbody>
          <tr v-for="b in chart.bars" :key="b.date"><td>{{ b.dateLong }}</td><td class="num">{{ b.formed }}</td></tr>
        </tbody>
        <tfoot><tr><th scope="row">合计</th><td class="num">{{ chart.total }}</td></tr></tfoot>
      </table>
    </section>

    <div class="dash-lists">
      <section class="card list-card" aria-labelledby="todo-match">
        <div class="list-card__head">
          <h2 id="todo-match" class="list-title">等你确认的局</h2>
          <a href="#/matching" class="text-link">全部 {{ s.proposals.length }} 个</a>
        </div>
        <a v-for="p in s.proposals.slice(0, 3)" :key="p.id" :href="'#/matching?id=' + p.id" class="list-row">
          <span class="mini-score" :class="{ 'is-high': p.score >= 90 }"><span class="mini-score__num">{{ p.score }}</span><span class="mini-score__label">匹配度</span></span>
          <span class="list-row__body">
            <span class="list-row__title">{{ p.title }}</span>
            <span class="list-row__sub">{{ p.members.length }} 人 · {{ p.risks.length ? p.risks.length + ' 条风险提示' : '没有风险提示' }}</span>
          </span>
          <Icon name="chevron" :size="18" stroke="#858C94" :weight="2" />
        </a>
        <p v-if="!s.proposals.length" class="list-empty">都确认完了，没有等你确认的局。</p>
      </section>

      <section class="card list-card" aria-labelledby="todo-report">
        <div class="list-card__head">
          <h2 id="todo-report" class="list-title">待处理的举报</h2>
          <a href="#/moderation" class="text-link">去处理</a>
        </div>
        <a v-for="r in s.reports.slice(0, 3)" :key="r.id" :href="'#/moderation?tab=report&id=' + r.id" class="list-row list-row--col">
          <span class="meta-row"><span class="pill" :class="'pill--' + fmt.reasonTone(r.reason)">{{ r.reason }}</span><span class="list-row__sub">{{ fmt.reportWho(r) }} · {{ fmt.ago(r.createdAt) }}</span></span>
          <span class="list-row__preview">{{ r.preview }}</span>
        </a>
        <p v-if="!s.reports.length" class="list-empty">没有待处理的举报。</p>
        <p v-if="otherPending" class="list-foot">另有 {{ otherPending }}等你审核</p>
      </section>

      <section class="card list-card" aria-labelledby="watch">
        <div class="list-card__head"><h2 id="watch" class="list-title">需要留意</h2></div>
        <a v-for="w in watchItems" :key="w.key" :href="w.href" class="list-row">
          <span class="list-row__text">{{ w.text }}</span>
          <Icon name="chevron" :size="18" stroke="#858C94" :weight="2" />
        </a>
        <p v-if="!watchItems.length" class="list-empty">暂时没有需要留意的事。</p>
        <p class="list-foot list-foot--body">近 7 天放鸽子 {{ s.stats.week.noShowCount }} 次，{{ deltas.noShow }} · 结束了 {{ s.stats.week.eventsEnded }} 个局</p>
      </section>
    </div>
  </template>
</div>`,
};
