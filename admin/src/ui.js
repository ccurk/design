// 通用组件：图标、头像、左侧菜单、提示条、标签页、计数器、开关、加载状态、状态标签、费用选择、
// 图片（缩略图 + 点开看大图、上传）、封面（图片或插画）。
import { computed, h, nextTick, reactive, ref, watch } from './vue.js';
import { uploadImage } from './api.js';
import { route } from './router.js';
import { badges } from './store.js';
import { AVATAR, EVENT_STATUS, FEE_OPTIONS, LEVEL, illustrationUrl, safeUrl } from './format.js';

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
  chevronLeft: [['path', { d: 'M14.5 6l-6 6 6 6' }]],
  image: [
    ['rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 3 }],
    ['circle', { cx: 9, cy: 10, r: 1.8 }],
    ['path', { d: 'M20.5 16l-5-5-8.5 8.5' }],
  ],
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
      { name: 'content', label: '内容运营', icon: 'image', count: 0 },
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

// ---- 看大图（全局一个弹窗；Esc 关闭，左右方向键切换，焦点留在弹窗里，关掉后回到点开它的缩略图）----

export const lightbox = reactive({ open: false, images: [], index: 0, label: '' });
let lightboxOpener = null;

export function openLightbox(images, index = 0, label = '图片') {
  const list = (images || []).map((u) => safeUrl(u)).filter(Boolean);
  if (!list.length) return;
  lightboxOpener = document.activeElement;
  Object.assign(lightbox, { images: list, index: Math.min(Math.max(0, index), list.length - 1), label, open: true });
}

export function closeLightbox() {
  if (!lightbox.open) return;
  lightbox.open = false;
  const el = lightboxOpener;
  lightboxOpener = null;
  nextTick(() => {
    if (el && typeof el.focus === 'function' && document.contains(el)) el.focus();
  });
}

export const Lightbox = {
  name: 'Lightbox',
  setup() {
    const root = ref(null);
    const many = computed(() => lightbox.images.length > 1);
    const current = computed(() => lightbox.images[lightbox.index] || '');
    function step(d) {
      const n = lightbox.images.length;
      lightbox.index = (lightbox.index + d + n) % n;
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeLightbox();
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && many.value) {
        e.preventDefault();
        step(e.key === 'ArrowLeft' ? -1 : 1);
      } else if (e.key === 'Tab' && root.value) {
        const els = [...root.value.querySelectorAll('button')];
        const i = els.indexOf(document.activeElement);
        e.preventDefault();
        els[e.shiftKey ? (i <= 0 ? els.length - 1 : i - 1) : (i + 1) % els.length].focus();
      }
    }
    watch(
      () => lightbox.open,
      (open) => {
        // 弹窗开着时，后面的页面不能被点到、也不会被读屏软件读到
        document.documentElement.classList.toggle('has-lightbox', open);
        const page = document.querySelector('.layout');
        if (page) page.inert = open;
        if (open) nextTick(() => root.value && root.value.querySelector('.lightbox__close').focus());
      },
    );
    return { lb: lightbox, root, many, current, step, onKey, close: closeLightbox };
  },
  template: html`
<div v-if="lb.open" ref="root" class="lightbox" role="dialog" aria-modal="true"
  :aria-label="lb.label + '，第 ' + (lb.index + 1) + ' 张，共 ' + lb.images.length + ' 张'"
  @keydown="onKey" @click.self="close">
  <img class="lightbox__img" :src="current" :alt="lb.label + ' ' + (lb.index + 1)">
  <div v-if="many" class="lightbox__bar">
    <button type="button" class="lightbox__btn" aria-label="上一张" @click="step(-1)"><Icon name="chevronLeft" :size="22" :weight="2.2" /></button>
    <span class="lightbox__count" aria-hidden="true">{{ lb.index + 1 }} / {{ lb.images.length }}</span>
    <button type="button" class="lightbox__btn" aria-label="下一张" @click="step(1)"><Icon name="chevron" :size="22" :weight="2.2" /></button>
  </div>
  <button type="button" class="lightbox__close" aria-label="关闭大图" @click="close"><Icon name="close" :size="22" :weight="2.2" /></button>
</div>`,
};

// ---- 缩略图：点了看大图 ----

export const Thumbs = {
  name: 'Thumbs',
  props: {
    images: { type: Array, default: () => [] },
    label: { type: String, default: '图片' },
    size: { type: String, default: 'md' }, // sm 56px / md 88px
  },
  setup(props) {
    const list = computed(() => props.images.map((u) => safeUrl(u)).filter(Boolean));
    const open = (i) => openLightbox(list.value, i, props.label);
    return { list, open };
  },
  template: html`
<ul v-if="list.length" class="thumbs" :class="'thumbs--' + size" :aria-label="label">
  <li v-for="(u, i) in list" :key="i">
    <button type="button" class="thumb" :aria-label="'看大图：' + label + ' ' + (i + 1)" @click="open(i)"><img :src="u" alt="" loading="lazy"></button>
  </li>
</ul>`,
};

// ---- 封面：有图用图，没有就用标签的插画 ----

export const Cover = {
  name: 'Cover',
  props: {
    image: { type: String, default: '' },
    coverKey: { type: String, default: '' },
    width: { type: Number, default: 60 },
  },
  setup(props) {
    const broken = ref(false);
    watch(
      () => props.image,
      () => {
        broken.value = false;
      },
    );
    const src = computed(() => (!broken.value && safeUrl(props.image)) || illustrationUrl(props.coverKey));
    const style = computed(() => ({ width: `${props.width}px`, height: `${Math.round((props.width * 2) / 3)}px` }));
    return { src, style, broken };
  },
  template: html`<span class="cover" :style="style" aria-hidden="true"><img v-if="src" :src="src" alt="" loading="lazy" @error="broken = true"></span>`,
};

// ---- 上传图片：选文件 → 逐张上传到 /api/admin/upload → v-model 是图片地址数组 ----

let uploaderSeq = 0;
export const ImageUploader = {
  name: 'ImageUploader',
  props: {
    modelValue: { type: Array, default: () => [] },
    max: { type: Number, default: 9 },
    label: { type: String, default: '图片' }, // 读屏用：「局的照片」
    wide: { type: Boolean, default: false }, // 轮播图：横的大预览
  },
  emits: ['update:modelValue', 'busy'],
  setup(props, { emit }) {
    const id = `upload-${++uploaderSeq}`;
    const st = reactive({ done: 0, total: 0, err: '' });
    const list = computed(() => props.modelValue.map((u) => safeUrl(u)).filter(Boolean));
    const single = computed(() => props.max === 1);
    const canAdd = computed(() => single.value || props.modelValue.length < props.max);
    const addLabel = computed(() => {
      if (st.total) return `正在上传 ${st.done + 1}/${st.total}…`;
      if (single.value) return props.modelValue.length ? '换一张' : '上传图片';
      return props.modelValue.length ? '再加几张' : '添加图片';
    });

    async function onPick(e) {
      const input = e.target;
      const files = [...(input.files || [])];
      input.value = '';
      if (!files.length || st.total) return;
      st.err = '';
      const room = single.value ? 1 : props.max - props.modelValue.length;
      const take = files.slice(0, room);
      const skipped = files.length - take.length;
      st.total = take.length;
      st.done = 0;
      emit('busy', true);
      let urls = single.value ? [] : props.modelValue.slice();
      try {
        for (const f of take) {
          const url = await uploadImage(f);
          urls = [...urls, url];
          st.done += 1;
          emit('update:modelValue', single.value ? urls : urls.slice());
        }
        if (skipped) st.err = `最多 ${props.max} 张，多出来的 ${skipped} 张没有传`;
      } catch (err) {
        st.err = err.message;
      } finally {
        st.total = 0;
        st.done = 0;
        emit('busy', false);
      }
    }

    function remove(i) {
      const urls = props.modelValue.slice();
      urls.splice(i, 1);
      emit('update:modelValue', urls);
      st.err = '';
      focusSoon(`#${id}`);
    }

    const open = (i) => openLightbox(list.value, i, props.label);
    return { id, st, list, single, canAdd, addLabel, onPick, remove, open };
  },
  template: html`
<div class="uploader">
  <ul v-if="list.length" class="thumbs" :class="wide ? 'thumbs--wide' : 'thumbs--md'" :aria-label="label">
    <li v-for="(u, i) in list" :key="u" class="thumb-item">
      <button type="button" class="thumb" :aria-label="'看大图：' + label + ' ' + (i + 1)" @click="open(i)"><img :src="u" alt="" loading="lazy"></button>
      <button v-if="!single" type="button" class="thumb-remove" :aria-label="'删掉' + label + ' ' + (i + 1)" @click="remove(i)"><Icon name="close" :size="14" :weight="2.4" /></button>
    </li>
  </ul>
  <div v-if="canAdd" class="uploader__add">
    <input :id="id" type="file" class="file-input" accept="image/jpeg,image/png,image/gif,image/webp" :multiple="!single" :aria-label="addLabel + '（' + label + '）'" :disabled="st.total > 0" @change="onPick">
    <label :for="id" class="btn btn--outline btn--sm file-btn" :class="{ 'is-busy': st.total > 0 }" aria-hidden="true"><Icon name="image" :size="16" :weight="2" />{{ addLabel }}</label>
    <span class="small muted">{{ single ? 'jpg / png / gif / webp，不超过 5MB' : '最多 ' + max + ' 张，每张不超过 5MB · 已有 ' + modelValue.length + ' 张' }}</span>
  </div>
  <p v-if="st.total" class="sr-only" role="status">{{ addLabel }}</p>
  <p v-if="st.err" class="form-error" role="alert">{{ st.err }}</p>
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
  for (const c of [Icon, Avatar, AppNav, StatusBanner, TabList, Stepper, ToggleSwitch, LoadState, StatusPill, LevelPill, FeePicker, Lightbox, Thumbs, Cover, ImageUploader]) {
    app.component(c.name, c);
  }
}
