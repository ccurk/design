// 登录：输入后台密码 → POST /api/admin/login → token 存进 localStorage。
import { nextTick, ref } from '../vue.js';
import { api, setToken } from '../api.js';
import { PAGES, route } from '../router.js';
import { html } from '../ui.js';

/** 登录后回到原来的页面（只接受后台自己的页面） */
function nextHash() {
  const next = typeof route.query.next === 'string' ? route.query.next : '';
  return PAGES.includes(next.split('?')[0]) ? `#/${next}` : '#/dashboard';
}

export default {
  name: 'LoginPage',
  setup() {
    const pw = ref('');
    const err = ref('');
    const busy = ref(false);
    const input = ref(null);

    async function submit() {
      if (busy.value) return;
      if (!pw.value) {
        err.value = '先输入密码';
        nextTick(() => input.value && input.value.focus());
        return;
      }
      busy.value = true;
      err.value = '';
      try {
        const { token } = await api('/admin/login', { method: 'POST', body: { password: pw.value } });
        setToken(token);
        window.location.hash = nextHash();
      } catch (e) {
        err.value = e.message || '登录没有成功，请重试';
        nextTick(() => input.value && input.value.focus());
      } finally {
        busy.value = false;
      }
    }

    return { pw, err, busy, input, submit };
  },
  template: html`
<div class="login">
  <main class="login__card">
    <div class="login__brand">
      <span class="brand-mark brand-mark--lg" aria-hidden="true">搭</span>
      <div class="login__brand-text"><span class="login__name">活动搭子</span><span class="login__sub">运营后台</span></div>
    </div>
    <div class="stack-8">
      <h1 class="login__title" tabindex="-1" data-page-title>登录后台</h1>
      <p class="login__desc">只给运营同学使用。在这里确认撮合、处理举报、管理局和信用。</p>
    </div>
    <form class="stack-24" novalidate @submit.prevent="submit">
      <div class="field">
        <label for="pw" class="field__label">后台密码</label>
        <input id="pw" ref="input" v-model="pw" type="password" class="input input--lg" :class="{ 'input--error': err }"
          placeholder="输入密码" autocomplete="current-password"
          :aria-invalid="err ? 'true' : null" :aria-describedby="err ? 'pw-err' : null" @input="err = ''">
        <p v-if="err" id="pw-err" class="form-error" role="alert">{{ err }}</p>
      </div>
      <button type="submit" class="btn btn--primary btn--xl btn--block" :disabled="busy">{{ busy ? '正在进入…' : '进入后台' }}</button>
    </form>
    <p class="login__foot">忘了密码？请技术同学在服务器上重新设置。</p>
  </main>
</div>`,
};
