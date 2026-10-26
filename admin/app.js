// 活动搭子 · 运营后台：入口。挂载 Vue、注册通用组件、hash 路由 + 登录守卫。
import { computed, createApp, nextTick, onBeforeUnmount, onMounted, watch } from './src/vue.js';
import { auth, clearToken } from './src/api.js';
import { go, hrefOf, PAGES, route, setGuard, startRouter } from './src/router.js';
import { refreshBadges } from './src/store.js';
import { closeLightbox, html, registerUi } from './src/ui.js';
import LoginPage from './src/pages/login.js';
import DashboardPage from './src/pages/dashboard.js';
import MatchingPage from './src/pages/matching.js';
import ModerationPage from './src/pages/moderation.js';
import EventsPage from './src/pages/events.js';
import UsersPage from './src/pages/users.js';
import ContentPage from './src/pages/content.js';

const PAGE_COMPONENTS = {
  dashboard: DashboardPage,
  matching: MatchingPage,
  moderation: ModerationPage,
  events: EventsPage,
  users: UsersPage,
  content: ContentPage,
};
const TITLES = {
  login: '登录',
  dashboard: '概览',
  matching: '撮合池',
  moderation: '审核与举报',
  events: '局管理',
  users: '用户与信用',
  content: '内容运营',
};
const BADGE_REFRESH_MS = 60 * 1000;

// 没登录 → 登录页（记住原来要去哪）；登录了还在登录页 / 地址不认识 → 概览
setGuard((r) => {
  if (!auth.token) {
    if (r.name === 'login') return r;
    const next = PAGES.includes(r.name) ? hrefOf(r.name, r.query).slice(2) : '';
    return { name: 'login', query: next && next !== 'dashboard' ? { next } : {}, redirect: true };
  }
  if (!PAGES.includes(r.name)) return { name: 'dashboard', query: {}, redirect: true };
  return r;
});

const App = {
  name: 'App',
  components: { LoginPage },
  setup() {
    const page = computed(() => PAGE_COMPONENTS[route.name] || null);

    let first = true;
    watch(
      () => route.name,
      (name) => {
        closeLightbox();
        document.title = `${TITLES[name] || '运营后台'} · 活动搭子运营后台`;
        if (name !== 'login') refreshBadges();
        if (first) {
          first = false;
          return;
        }
        // 换页后：回到顶部，焦点放到新页面的标题上（读屏软件能听到换了页）
        window.scrollTo(0, 0);
        nextTick(() => {
          const h = document.querySelector('[data-page-title]');
          if (h) h.focus({ preventScroll: true });
        });
      },
      { immediate: true },
    );

    let timer = null;
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshBadges();
    };
    onMounted(() => {
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') refreshBadges();
      }, BADGE_REFRESH_MS);
      document.addEventListener('visibilitychange', onVisible);
    });
    onBeforeUnmount(() => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    });

    function logout() {
      clearToken();
      go('login');
    }
    function skipToMain() {
      const h = document.querySelector('[data-page-title]');
      if (h) h.focus();
    }

    return { route, page, logout, skipToMain };
  },
  template: html`
<LoginPage v-if="route.name === 'login'" />
<div v-else class="layout">
  <button type="button" class="skip-link" @click="skipToMain">跳到正文</button>
  <AppNav @logout="logout" />
  <main class="main">
    <component :is="page" :key="route.name" />
  </main>
</div>
<Lightbox />`,
};

startRouter();
const app = createApp(App);
registerUi(app);
app.mount('#app');
