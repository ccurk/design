// 官方带队申请：看申请（带队介绍 + 资质图）→ 通过 / 驳回（可写原因，会通知对方）。
import { onMounted, reactive } from '../vue.js';
import { api } from '../api.js';
import * as fmt from '../format.js';
import { html, useBanner } from '../ui.js';

export default {
  name: 'LeadersPage',
  setup() {
    const { banner, showBanner, failBanner, closeBanner } = useBanner();
    const s = reactive({ loading: true, loaded: false, error: '', items: [], busy: 0, rejId: 0, rejNote: '' });

    async function load() {
      s.error = '';
      if (!s.loaded) s.loading = true;
      try {
        const res = await api('/admin/leader-applications', { query: { status: 'pending' } });
        s.items = res.items;
        s.loaded = true;
      } catch (e) {
        if (s.loaded) failBanner(e, '刷新失败');
        else s.error = e.message;
      } finally {
        s.loading = false;
      }
    }
    onMounted(load);

    const imagesOf = (x) => (x.images || []).map((u) => fmt.safeUrl(u)).filter(Boolean);
    function openRej(id) {
      s.rejId = id;
      s.rejNote = '';
    }
    function closeRej() {
      s.rejId = 0;
      s.rejNote = '';
    }

    async function review(item, approve) {
      if (s.busy) return;
      s.busy = item.id;
      try {
        await api(`/admin/leader-applications/${item.id}/review`, {
          method: 'POST',
          body: { approve, note: approve ? undefined : s.rejNote.trim() || undefined },
        });
        s.items = s.items.filter((x) => x.id !== item.id);
        closeRej();
        showBanner(approve ? `已通过：${item.user.nickname} 成为官方带队。` : `已驳回 ${item.user.nickname} 的申请，已通知对方。`);
      } catch (e) {
        if (e.code === 'CONFLICT' || e.code === 'NOT_FOUND') {
          failBanner(e);
          load();
        } else {
          failBanner(e, '没能处理');
        }
      } finally {
        s.busy = 0;
      }
    }

    return { s, fmt, banner, closeBanner, load, imagesOf, openRej, closeRej, review };
  },
  template: html`
<div class="page">
  <header class="page-head page-head--col">
    <h1 class="page-title" tabindex="-1" data-page-title>官方带队申请</h1>
    <p class="page-desc">用户申请成为官方带队（需先完成手机号认证）。看过介绍和资质后决定是否通过；通过后对方成为官方带队，可带队组织官方局。</p>
  </header>

  <StatusBanner :banner="banner" @close="closeBanner" />

  <LoadState v-if="!s.loaded" :loading="s.loading" :error="s.error" @retry="load" />
  <div v-else class="stack-16">
    <div v-if="!s.items.length" class="card empty">
      <span class="empty__title">没有待审核的带队申请</span>
      <span class="empty__text">有人申请成为官方带队时会出现在这里。</span>
    </div>
    <section v-for="it in s.items" :key="it.id" class="card detail" aria-label="带队申请">
      <div class="person-card">
        <Avatar :user="it.user" :size="40" />
        <div class="person-card__body">
          <span class="person-card__name">{{ it.user.nickname }}</span>
          <span class="small muted">履约 {{ it.user.creditRate }}% · {{ fmt.ago(it.createdAt) }}申请</span>
        </div>
        <a class="btn btn--outline btn--sm" :href="'#/users?id=' + it.user.id">看信用记录</a>
      </div>
      <div class="stack-8">
        <span class="label">带队介绍 / 经验</span>
        <blockquote class="quote">{{ it.intro }}</blockquote>
        <Thumbs :images="imagesOf(it)" label="资质 / 相关照片" />
      </div>
      <div v-if="s.rejId !== it.id" class="actions">
        <button type="button" class="btn btn--primary btn--lg" :disabled="s.busy === it.id" @click="review(it, true)">通过，成为官方带队</button>
        <button type="button" class="btn btn--danger-outline btn--lg" @click="openRej(it.id)">驳回</button>
      </div>
      <template v-else>
        <div class="field">
          <label :for="'rej-' + it.id" class="field__label">驳回原因（选填，会发给对方）</label>
          <input :id="'rej-' + it.id" v-model="s.rejNote" type="text" class="input" maxlength="150" autocomplete="off">
        </div>
        <div class="actions">
          <button type="button" class="btn btn--danger btn--lg" :disabled="s.busy === it.id" @click="review(it, false)">确认驳回</button>
          <button type="button" class="btn btn--outline btn--lg" @click="closeRej">取消</button>
        </div>
      </template>
    </section>
  </div>
</div>`,
};
