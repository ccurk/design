// 通用组件：图标、头像、左侧菜单、提示条、标签页、计数器、开关、加载状态、状态标签、费用选择。
import { computed, h, nextTick, ref } from './vue.js';
import { route } from './router.js';
import { badges } from './store.js';
import { AVATAR, EVENT_STATUS, FEE_OPTIONS, LEVEL, safeUrl } from './format.js';

/** 只是让编辑器把模板当 HTML 高亮；返回原样的字符串 */
export const html = String.raw;

// ---- 图标（线条图标，路径来自设计稿）----

const ICONS = {
  grid: [
    ['rect', { x: 3.5, y: 3.5, width: 7, height: 7, rx: 2 }],
    ['rect', { x: 13.5, y: 3.5, width: 7, height: 7, rx: 2 }],
    ['rect', { x: 3.5, y: 13.5, width: 7, height: 7, rx: 2 }],
    ['rect', { x: 13.5, y: 13.5, width: 7, height: 7, rx: 2 }],
  ],
  people: [
    ['circle', { cx: 9, cy: 8, r: 3.5 }],
    ['path', { d: 'M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5' }],
    ['path', { d: 'M15.5 4.8a3.5 3.5 0 0 1 0 6.4' }],
    ['path', { d: 'M18 14.8c1.9.7 3.1 2.4 3.5 5.2' }],
  ],
  shield: [
    ['path', { d: 'M12 3l7.5 3v5.5c0 4.6-3.1 8.2-7.5 9.5-4.4-1.3-7.5-4.9-7.5-9.5V6L12 3z' }],
    ['path', { d: 'M8.8 12l2.2 2.2 4.2-4.4' }],
  ],
  calendar: [
    ['rect', { x: 3.5, y: 5, width: 17, height: 15.5, rx: 3 }],
    ['path', { d: 'M3.5 10h17' }],
    ['path', { d: 'M8 3v4' }],
    ['path', { d: 'M16 3v4' }],
  ],
  user: [
    ['circle', { cx: 12, cy: 8, r: 4 }],
    ['path', { d: 'M4.5 20.5c1-4 3.9-6 7.5-6s6.5 2 7.5 6' }],
  ],
  logout: [
    ['path', { d: 'M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14' }],
    ['path', { d: 'M10 8l-4 4 4 4' }],
    ['path', { d: 'M6 12h10' }],
  ],
  chevron: [['path', { d: 'M9.5 6l6 6-6 6' }]],
  refresh: [
    ['path', { d: 'M20 11.5A8 8 0 0 0 6.3 6.3L4 8.5' }],
    ['path', { d: 'M4 4v4.5h4.5' }],
    ['path', { d: 'M4 12.5a8 8 0 0 0 13.7 5.2l2.3-2.2' }],
    ['path', { d: 'M20 20v-4.5h-4.5' }],
  ],
  close: [
    ['path', { d: 'M6 6l12 12' }],
    ['path', { d: 'M18 6L6 18' }],
  ],
  check: [['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]],
  warn: [
    ['path', { d: 'M12 3.5l9 16H3l9-16z' }],
    ['path', { d: 'M12 10v4' }],
    ['path', { d: 'M12 17.2v.1' }],
  ],
  plus: [
    ['path', { d: 'M12 5v14' }],
    ['path', { d: 'M5 12h14' }],
  ],
  minus: [['path', { d: 'M5 12h14' }]],
  search: [
    ['circle', { cx: 11, cy: 11, r: 6.5 }],
    ['path', { d: 'M16 16l4 4' }],
  ],
};

export const Icon = {
  name: 'Icon',
  props: {
    name: { type: String, required: true },
    size: { type: Number, default: 20 },
    stroke: { type: String, default: 'currentColor' },
    weight: { type: Number, default: 1.8 },
  },
  setup(props) {
    return () =>
      h(
        'svg',
        {
          class: 'icon',
          width: props.size,
          height: props.size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: props.stroke,
          'stroke-width': props.weight,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        (ICONS[props.name] || []).map(([tag, attrs]) => h(tag, attrs)),
      );
  },
};

// ---- 头像：有图用图，没有就用昵称里的一个字画圆 ----

export const Avatar = {
  name: 'Avatar',
  props: {
    user: { type: Object, default: null },
    size: { type: Number, default: 36 },
  },
  setup(props) {
    const broken = ref(false);
    const src = computed(() => (broken.value ? null : safeUrl(props.user && props.user.avatarUrl)));
    const style = computed(() => {
      const [bg, fg] = AVATAR[props.user && props.user.avatarColor] || AVATAR.stone;
      return {
        width: `${props.size}px`,
        height: `${props.size}px`,
        background: bg,
        color: fg,
        fontSize: `${Math.round(props.size * 0.42)}px`,
      };
    });
    return { src, style, broken };
  },
  template: html`<span class="avatar" :style="style" aria-hidden="true"><img v-if="src" :src="src" alt="" @error="broken = true"><template v-else>{{ (user && user.avatarText) || '?' }}</template></span>`,
};

// ---- 左侧菜单 ----

export const AppNav = {
  name: 'AppNav',
  emits: ['logout'],
  setup() {
    const items = computed(() => [
      { name: 'dashboard', label: '概览', icon: 'grid', count: 0 },
      { name: 'matching', label: '撮合池', icon: 'people', count: badges.proposals, aria: (n) => `撮合池，${n} 个方案等你确认` },
      { name: 'moderation', label: '审核与举报', icon: 'shield', count: badges.moderation, aria: (n) => `审核与举报，${n} 条待处理` },
      { name: 'events', label: '局管理', icon: 'calendar', count: 0 },
      { name: 'users', label: '用户与信用', icon: 'user', count: badges.appeals, aria: (n) => `用户与信用，${n} 条申诉待处理` },
    ]);
    return { items, route };
  },
  template: html`
<nav class="nav" aria-label="后台菜单">
  <div class="nav__brand">
    <span class="brand-mark" aria-hidden="true">搭</span>
    <div class="nav__brand-text"><span class="nav__brand-name">活动搭子</span><span class="nav__brand-sub">运营后台</span></div>
  </div>
  <a v-for="it in items" :key="it.name" class="nav__item" :href="'#/' + it.name"
     :aria-current="route.name === it.name ? 'page' : null"
     :aria-label="it.count ? it.aria(it.count) : null">
    <Icon :name="it.icon" :size="20" />
    <span class="nav__label">{{ it.label }}</span>
    <span v-if="it.count" class="nav__badge" aria-hidden="true">{{ it.count }}</span>
  </a>
  <div class="nav__foot">
    <button type="button" class="nav__item nav__item--quiet" @click="$emit('logout')"><Icon name="logout" :size="20" /><span>退出登录</span></button>
  </div>
</nav>`,
};

// ---- 操作结果提示条（role="status"；出错时 role="alert"）----

export function useBanner() {
  const banner = ref(null);
  let seq = 0;
  function showBanner(text, { kind = 'info', actionLabel = '', action = null } = {}) {
    banner.value = {
      id: ++seq,
      text,
      kind,
      actionLabel,
      action: action
        ? () => {
            banner.value = null;
            action();
          }
        : null,
    };
    // 提示条在页面顶部；如果已经滚出屏幕，滚回来让人看到
    nextTick(() => {
      const el = document.querySelector('.banner');
      if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'nearest' });
    });
  }
  function failBanner(err, prefix = '') {
    const msg = (err && err.message) || '出错了，请重试';
    showBanner(prefix ? `${prefix}：${msg}` : msg, { kind: 'error' });
  }
  function closeBanner() {
    banner.value = null;
  }
  return { banner, showBanner, failBanner, closeBanner };
}

export const StatusBanner = {
  name: 'StatusBanner',
  props: { banner: { type: Object, default: null } },
  emits: ['close'],
  template: html`
<div v-if="banner" :key="banner.id" class="banner" :class="{ 'banner--error': banner.kind === 'error' }" :role="banner.kind === 'error' ? 'alert' : 'status'">
  <span class="banner__text">{{ banner.text }}</span>
  <button v-if="banner.actionLabel" type="button" class="banner__action" @click="banner.action">{{ banner.actionLabel }}</button>
  <button type="button" class="banner__close" aria-label="关闭提示" @click="$emit('close')"><Icon name="close" :size="18" :weight="2" /></button>
</div>`,
};

// ---- 标签页（role="tablist"，左右方向键切换）----

export const TabList = {
  name: 'TabList',
  props: {
    tabs: { type: Array, required: true }, // [{ key, label, count }]
    modelValue: { type: String, required: true },
    label: { type: String, required: true },
    idPrefix: { type: String, required: true },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    function onKey(e, i) {
      const n = props.tabs.length;
      const map = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 };
      if (!(e.key in map)) return;
      e.preventDefault();
      const next = props.tabs[map[e.key]];
      emit('update:modelValue', next.key);
      nextTick(() => document.getElementById(`${props.idPrefix}-tab-${next.key}`)?.focus());
    }
    return { onKey };
  },
  template: html`
<div class="tabs" role="tablist" :aria-label="label">
  <button v-for="(t, i) in tabs" :key="t.key" type="button" role="tab" class="tab"
    :id="idPrefix + '-tab-' + t.key"
    :aria-selected="modelValue === t.key ? 'true' : 'false'"
    :aria-controls="idPrefix + '-panel'"
    :tabindex="modelValue === t.key ? 0 : -1"
    @click="$emit('update:modelValue', t.key)" @keydown="onKey($event, i)">
    {{ t.label }}<span v-if="t.count !== undefined && t.count !== null" class="tab__count">{{ t.count }}</span>
  </button>
</div>`,
};

// ---- 人数计数器 ----

export const Stepper = {
  name: 'Stepper',
  props: {
    modelValue: { type: Number, required: true },
    min: { type: Number, default: 2 },
    max: { type: Number, default: 20 },
    labelledby: { type: String, default: null },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    const step = (d) => {
      const v = Math.min(props.max, Math.max(props.min, props.modelValue + d));
      if (v !== props.modelValue) emit('update:modelValue', v);
    };
    return { step };
  },
  template: html`
<div class="stepper" role="group" :aria-labelledby="labelledby">
  <button type="button" class="stepper__btn" aria-label="少一个名额" :aria-disabled="modelValue <= min ? 'true' : null" @click="step(-1)"><Icon name="minus" :size="16" :weight="2.2" /></button>
  <span class="stepper__value" aria-live="polite">{{ modelValue }}</span>
  <button type="button" class="stepper__btn" aria-label="多一个名额" :aria-disabled="modelValue >= max ? 'true' : null" @click="step(1)"><Icon name="plus" :size="16" :weight="2.2" /></button>
</div>`,
};

// ---- 开关（role="switch"）----

export const ToggleSwitch = {
  name: 'ToggleSwitch',
  props: {
    checked: { type: Boolean, default: false },
    labelledby: { type: String, required: true },
    busy: { type: Boolean, default: false },
  },
  emits: ['toggle'],
  template: html`
<button type="button" role="switch" class="switch" :class="{ 'is-on': checked }"
  :aria-checked="checked ? 'true' : 'false'" :aria-labelledby="labelledby" :aria-busy="busy ? 'true' : null"
  @click="busy || $emit('toggle')"><span class="switch__track"><span class="switch__thumb"></span></span></button>`,
};

// ---- 加载中 / 加载失败 ----

export const LoadState = {
  name: 'LoadState',
  props: {
    loading: { type: Boolean, default: false },
    error: { type: String, default: '' },
    compact: { type: Boolean, default: false },
  },
  emits: ['retry'],
  template: html`
<div v-if="error" class="state state--error" :class="{ 'state--compact': compact }" role="alert">
  <span>加载失败：{{ error }}</span>
  <button type="button" class="btn btn--outline btn--sm" @click="$emit('retry')">重试</button>
</div>
<div v-else-if="loading" class="state" :class="{ 'state--compact': compact }" role="status"><span class="spinner" aria-hidden="true"></span>正在加载…</div>`,
};

// ---- 局的状态标签 / 信用等级标签 ----

export const StatusPill = {
  name: 'StatusPill',
  props: { status: { type: String, required: true } },
  setup(props) {
    const info = computed(() => EVENT_STATUS[props.status] || { label: props.status, tone: 'gray' });
    return { info };
  },
  template: html`<span class="pill" :class="'pill--' + info.tone">{{ info.label }}</span>`,
};

export const LevelPill = {
  name: 'LevelPill',
  props: { level: { type: String, required: true } },
  setup(props) {
    const info = computed(() => LEVEL[props.level] || LEVEL.good);
    return { info };
  },
  template: html`<span class="pill" :class="'pill--' + info.tone">{{ info.label }}</span>`,
};

// ---- 费用：方式 + 预计每人金额 ----

export const FeePicker = {
  name: 'FeePicker',
  props: {
    feeType: { type: String, default: 'aa' },
    estimate: { type: [String, Number], default: '' },
    idPrefix: { type: String, required: true },
  },
  emits: ['update:feeType', 'update:estimate'],
  setup() {
    return { FEE_OPTIONS };
  },
  template: html`
<div class="field">
  <span :id="idPrefix + '-fee'" class="field__label">费用</span>
  <div class="fee-row">
    <div class="chips" role="group" :aria-labelledby="idPrefix + '-fee'">
      <button v-for="o in FEE_OPTIONS" :key="o.key" type="button" class="chip" :aria-pressed="feeType === o.key ? 'true' : 'false'" @click="$emit('update:feeType', o.key)">{{ o.label }}</button>
    </div>
    <div v-if="feeType !== 'free'" class="fee-est">
      <label :for="idPrefix + '-est'" class="fee-est__label">预计每人 ¥</label>
      <input :id="idPrefix + '-est'" class="input fee-est__input" type="number" min="0" max="100000" step="1" inputmode="numeric" placeholder="选填" :value="estimate" @input="$emit('update:estimate', $event.target.value)">
    </div>
  </div>
</div>`,
};

/** 下一帧把焦点放到某个元素上（面板打开 / 关闭后，别让焦点掉回页面开头） */
export function focusSoon(selector) {
  nextTick(() => {
    const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (el && typeof el.focus === 'function') el.focus();
  });
}

export function registerUi(app) {
  for (const c of [Icon, Avatar, AppNav, StatusBanner, TabList, Stepper, ToggleSwitch, LoadState, StatusPill, LevelPill, FeePicker]) {
    app.component(c.name, c);
  }
}
