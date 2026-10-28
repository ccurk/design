// 内容运营：小程序首页的轮播图（增删改、开关、排序、上传图片），热门标签（排序、移出、添加、从大家最近在用的里挑）。
// 接口见 docs/changes-v0.3.md A、E。
import { computed, onBeforeUnmount, onMounted, reactive, watch } from '../vue.js';
import { api } from '../api.js';
import { route } from '../router.js';
import * as fmt from '../format.js';
import { focusSoon, html, openLightbox, useBanner } from '../ui.js';

const TABS = ['banners', 'tags'];
const RECENT_DAYS = 30;
const RECENT_SHOWN = 20;

function emptyBannerForm() {
  return { id: null, images: [], title: '', subtitle: '', linkKind: 'none', eventId: null, body: '', ctaLabel: '', startsAt: '', endsAt: '', enabled: true };
}

// ISO ↔ datetime-local 输入框的本地格式 "YYYY-MM-DDTHH:MM"
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function emptyTagForm() {
  return { name: '', category: 'outdoor', cover: fmt.CATEGORY_COVER.outdoor, coverTouched: false };
}

export default {
  name: 'ContentPage',
  setup() {
    const { banner, showBanner, failBanner, closeBanner } = useBanner();
    const s = reactive({
      tab: TABS.includes(route.query.tab) ? route.query.tab : 'banners',
      // 轮播图
      bLoading: true,
      bError: '',
      banners: [],
      events: {}, // 轮播图链接到的局：id → { title, startAt, status } | { missing: true }
      form: null,
      formErr: '',
      saving: false,
      uploading: false,
      evQ: '',
      evResults: [],
      evSearching: false,
      evSearched: false,
      evErr: '',
      delAsk: null,
      bBusy: false,
      // 热门标签
      tLoading: true,
      tError: '',
      hot: [],
      recent: [],
      showAllRecent: false,
      nt: emptyTagForm(),
      ntErr: '',
      ntBusy: false,
      tBusy: false,
    });

    watch(
      () => route.query.tab,
      (tab) => {
        if (TABS.includes(tab)) s.tab = tab;
      },
    );
    // 表单一改，上一次保存的错误提示就收起来
    watch(
      () => s.form,
      () => {
        s.formErr = '';
      },
      { deep: true },
    );

    const tabs = computed(() => [
      { key: 'banners', label: '首页轮播', count: s.bLoading && !s.banners.length ? null : s.banners.length },
      { key: 'tags', label: '热门标签', count: s.tLoading && !s.hot.length ? null : s.hot.length },
    ]);

    // ---- 轮播图：加载 ----

    async function loadBanners() {
      s.bError = '';
      try {
        const res = await api('/admin/banners');
        const items = (res.items || []).slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.id - b.id);
        s.banners = items;
        await loadLinkedEvents(items);
      } catch (e) {
        s.bError = e.message;
      } finally {
        s.bLoading = false;
      }
    }

    /** 链接到局的轮播图：把局的标题查出来（局被删了就标出来） */
    async function loadLinkedEvents(items) {
      const ids = [...new Set(items.map((b) => fmt.parseLink(b.link)).filter((l) => l.kind === 'event').map((l) => l.id))];
      const todo = ids.filter((id) => !s.events[id]);
      const res = await Promise.allSettled(todo.map((id) => api(`/admin/events/${id}`)));
      res.forEach((r, i) => {
        const ev = r.status === 'fulfilled' ? r.value.event : null;
        s.events[todo[i]] = ev
          ? { title: ev.title, startAt: ev.startAt, status: fmt.displayStatus(ev) }
          : { missing: true };
      });
    }

    const eventTitle = (id) => {
      const e = s.events[id];
      return e && !e.missing ? e.title : '';
    };
    /** 「局「苍山看日出」」「广场」；链接的局已经不在了就直说 */
    function linkText(link) {
      const l = fmt.parseLink(link);
      if (l.kind === 'event' && s.events[l.id] && s.events[l.id].missing) return `局 #${l.id}（这个局找不到了，换一个吧）`;
      return fmt.linkText(link, eventTitle);
    }

    // ---- 轮播图：开关、排序、删除 ----

    async function bannerOp(fn) {
      if (s.bBusy) return false;
      s.bBusy = true;
      try {
        await fn();
        return true;
      } catch (e) {
        failBanner(e, '没能保存');
        await loadBanners();
        return false;
      } finally {
        s.bBusy = false;
      }
    }

    async function toggleBanner(b) {
      const on = !b.enabled;
      const ok = await bannerOp(async () => {
        await api(`/admin/banners/${b.id}`, { method: 'PUT', body: { enabled: on } });
        await loadBanners();
      });
      if (ok) showBanner(on ? `「${b.title}」已在小程序首页展示。` : `「${b.title}」已从首页撤下（没有删掉，随时可以再打开）。`);
    }

    async function moveBanner(i, d) {
      const j = i + d;
      if (j < 0 || j >= s.banners.length) return;
      const b = s.banners[i];
      const ids = s.banners.map((x) => x.id);
      [ids[i], ids[j]] = [ids[j], ids[i]];
      const ok = await bannerOp(async () => {
        await api('/admin/banners/order', { method: 'PUT', body: { ids } });
        await loadBanners();
      });
      if (ok) {
        showBanner(`已把「${b.title}」${d < 0 ? '上移' : '下移'}到第 ${j + 1} 张。`);
        focusSoon(`#bn-${d < 0 ? 'up' : 'down'}-${b.id}`);
      }
    }

    function askDelete(b) {
      s.delAsk = b.id;
      focusSoon(`#bn-del-ask-${b.id}`);
    }
    function cancelDelete(b) {
      s.delAsk = null;
      focusSoon(`#bn-del-${b.id}`);
    }
    async function deleteBanner(b) {
      const ok = await bannerOp(async () => {
        await api(`/admin/banners/${b.id}`, { method: 'DELETE' });
        s.delAsk = null;
        if (s.form && s.form.id === b.id) s.form = null;
        await loadBanners();
      });
      if (ok) {
        showBanner(`已删掉轮播图「${b.title}」。`);
        focusSoon('#bn-add');
      }
    }

    // ---- 轮播图：添加 / 编辑 ----

    function openForm(b = null) {
      s.formErr = '';
      s.evQ = '';
      s.evResults = [];
      s.evSearched = false;
      s.evErr = '';
      s.delAsk = null;
      if (b) {
        const l = fmt.parseLink(b.link);
        s.form = {
          id: b.id,
          images: b.image ? [b.image] : [],
          title: b.title || '',
          subtitle: b.subtitle || '',
          linkKind: l.kind === 'other' ? 'none' : l.kind,
          eventId: l.kind === 'event' ? l.id : null,
          body: b.body || '',
          ctaLabel: b.ctaLabel || '',
          startsAt: toLocalInput(b.startsAt),
          endsAt: toLocalInput(b.endsAt),
          enabled: !!b.enabled,
          otherLink: l.kind === 'other' ? b.link : '',
        };
      } else {
        s.form = emptyBannerForm();
      }
      focusSoon('#bf-title');
    }

    function closeForm() {
      const id = s.form && s.form.id;
      s.form = null;
      s.formErr = '';
      focusSoon(id ? `#bn-edit-${id}` : '#bn-add');
    }

    function pickLinkKind(kind) {
      s.form.linkKind = kind;
      s.formErr = '';
      if (kind === 'event' && !s.form.eventId) focusSoon('#bf-ev-q');
    }

    let evTimer = null;
    let evSeq = 0;
    function onEvSearch() {
      clearTimeout(evTimer);
      evTimer = setTimeout(searchEvents, 300);
    }
    onBeforeUnmount(() => clearTimeout(evTimer));

    /** 能放进轮播图的局：广场上看得到的（不含撮合局、待审核、没通过、已取消的） */
    const linkable = (e) => e.source !== 'matched' && !['pending_review', 'rejected', 'cancelled'].includes(e.status);

    async function searchEvents() {
      clearTimeout(evTimer);
      const q = s.evQ.trim();
      const seq = ++evSeq;
      if (!q) {
        s.evResults = [];
        s.evSearched = false;
        return;
      }
      s.evSearching = true;
      s.evErr = '';
      try {
        const res = await api('/admin/events', { query: { q } });
        if (seq !== evSeq) return;
        s.evResults = res.items.filter(linkable).slice(0, 8);
        s.evSearched = true;
      } catch (e) {
        if (seq === evSeq) s.evErr = e.message;
      } finally {
        if (seq === evSeq) s.evSearching = false;
      }
    }

    function pickEvent(e) {
      s.form.eventId = e.id;
      s.events[e.id] = { title: e.title, startAt: e.startAt, status: fmt.displayStatus(e) };
      s.formErr = '';
      focusSoon('#bf-ev-change');
    }
    function unpickEvent() {
      s.form.eventId = null;
      focusSoon('#bf-ev-q');
    }

    async function saveBanner() {
      if (s.saving || s.uploading) return;
      const f = s.form;
      const title = f.title.trim();
      if (!f.images.length) {
        s.formErr = '先上传一张图片';
        return;
      }
      if (!title) {
        s.formErr = '标题要填';
        focusSoon('#bf-t');
        return;
      }
      if (f.linkKind === 'event' && !f.eventId) {
        s.formErr = '先搜一个局选上，或者换一种跳转';
        focusSoon('#bf-ev-q');
        return;
      }
      const link = f.linkKind === 'none' ? null : f.linkKind === 'event' ? `event:${f.eventId}` : f.linkKind;
      const hasBody = !!f.body.trim();
      const body = {
        image: f.images[0],
        title,
        subtitle: f.subtitle.trim(),
        link,
        body: f.body.trim(),
        ctaLabel: hasBody ? f.ctaLabel.trim() : '',
        ctaLink: hasBody ? link : '', // 落地页按钮跳到「点了去哪」
        startsAt: f.startsAt ? new Date(f.startsAt).toISOString() : '',
        endsAt: f.endsAt ? new Date(f.endsAt).toISOString() : '',
        enabled: f.enabled,
      };
      s.saving = true;
      s.formErr = '';
      try {
        if (f.id) await api(`/admin/banners/${f.id}`, { method: 'PUT', body });
        else await api('/admin/banners', { method: 'POST', body });
        const wasEdit = !!f.id;
        s.form = null;
        await loadBanners();
        const n = s.banners.length;
        showBanner(wasEdit ? `已保存轮播图「${title}」。` : `已添加轮播图「${title}」，排在第 ${n} 张${f.enabled ? '' : '（还没打开展示）'}。`);
        focusSoon('#bn-add');
      } catch (e) {
        s.formErr = e.message;
      } finally {
        s.saving = false;
      }
    }

    // ---- 热门标签 ----

    async function loadTags() {
      s.tError = '';
      try {
        const [hot, all] = await Promise.all([
          api('/admin/tags', { query: { scope: 'hot' } }),
          api('/admin/tags', { query: { scope: 'all', days: RECENT_DAYS } }),
        ]);
        s.hot = (hot.items || []).filter((t) => t.hot).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
        s.recent = all.items || [];
      } catch (e) {
        s.tError = e.message;
      } finally {
        s.tLoading = false;
      }
    }

    const hotIndex = (t) => s.hot.findIndex((x) => x.id === t.id);
    const recentShown = computed(() => (s.showAllRecent ? s.recent : s.recent.slice(0, RECENT_SHOWN)));

    /** 整体替换热门列表和顺序 */
    async function putHot(ids, message, focus) {
      if (s.tBusy) return false;
      s.tBusy = true;
      try {
        await api('/admin/tags/hot', { method: 'PUT', body: { ids } });
        await loadTags();
        if (message) showBanner(message.text, message.opts);
        if (focus) focusSoon(focus);
        return true;
      } catch (e) {
        failBanner(e, '没能保存');
        await loadTags();
        return false;
      } finally {
        s.tBusy = false;
      }
    }

    function moveTag(i, d) {
      const j = i + d;
      if (j < 0 || j >= s.hot.length) return;
      const t = s.hot[i];
      const ids = s.hot.map((x) => x.id);
      [ids[i], ids[j]] = [ids[j], ids[i]];
      putHot(ids, { text: `已把「${t.name}」${d < 0 ? '上移' : '下移'}到第 ${j + 1} 个。` }, `#tag-${d < 0 ? 'up' : 'down'}-${t.id}`);
    }

    function removeHot(t) {
      const before = s.hot.map((x) => x.id);
      const ids = before.filter((id) => id !== t.id);
      putHot(ids, {
        text: `已把「${t.name}」移出热门。标签还在，用户写的时候照样能用。`,
        opts: { actionLabel: '撤销', action: () => putHot(before, { text: `已把「${t.name}」放回热门。` }) },
      }, '#hot-title');
    }

    function promote(t) {
      const ids = [...s.hot.map((x) => x.id), t.id];
      putHot(ids, { text: `已把「${t.name}」加到热门，排在第 ${ids.length} 个。` }, `#recent-${t.id}`);
    }

    // 添加标签
    const ntLen = computed(() => fmt.tagLength(s.nt.name));
    function pickCategory(key) {
      s.nt.category = key;
      if (!s.nt.coverTouched) s.nt.cover = fmt.CATEGORY_COVER[key] || 'oldtown';
    }
    function pickCover(key) {
      s.nt.cover = key;
      s.nt.coverTouched = true;
    }

    async function addTag() {
      if (s.ntBusy) return;
      const name = fmt.normalizeTag(s.nt.name);
      if (!name) {
        s.ntErr = '先写标签';
        focusSoon('#nt-name');
        return;
      }
      const existing = s.recent.find((t) => fmt.normalizeTag(t.name).toLowerCase() === name.toLowerCase());
      if (existing && existing.hot) {
        s.ntErr = `「${existing.name}」已经在热门里了（第 ${hotIndex(existing) + 1} 个）`;
        focusSoon('#nt-name');
        return;
      }
      s.ntBusy = true;
      s.ntErr = '';
      try {
        if (existing) {
          // 已经有这个标签（用户用过）：直接加到热门，顺便更新分类和插画
          await api(`/admin/tags/${existing.id}`, { method: 'PUT', body: { category: s.nt.category, cover: s.nt.cover } });
          await api('/admin/tags/hot', { method: 'PUT', body: { ids: [...s.hot.map((x) => x.id), existing.id] } });
        } else {
          await api('/admin/tags', { method: 'POST', body: { name, category: s.nt.category, cover: s.nt.cover, hot: true } });
        }
        s.nt = emptyTagForm();
        await loadTags();
        const i = s.hot.findIndex((t) => fmt.normalizeTag(t.name).toLowerCase() === name.toLowerCase());
        showBanner(`已把「${name}」加到热门${i >= 0 ? `，排在第 ${i + 1} 个` : ''}。`);
        focusSoon('#nt-name');
      } catch (e) {
        // 422「这个标签不能用」、400 长度 / 字符不对：写在输入框下面
        s.ntErr = e.message;
        focusSoon('#nt-name');
        if (e.code === 'CONFLICT') loadTags();
      } finally {
        s.ntBusy = false;
      }
    }

    onMounted(() => {
      loadBanners();
      loadTags();
    });

    return {
      s,
      fmt,
      banner,
      closeBanner,
      tabs,
      loadBanners,
      linkText,
      eventTitle,
      toggleBanner,
      moveBanner,
      askDelete,
      cancelDelete,
      deleteBanner,
      openForm,
      closeForm,
      pickLinkKind,
      onEvSearch,
      searchEvents,
      pickEvent,
      unpickEvent,
      saveBanner,
      openLightbox,
      loadTags,
      hotIndex,
      recentShown,
      moveTag,
      removeHot,
      promote,
      ntLen,
      pickCategory,
      pickCover,
      addTag,
      RECENT_DAYS,
      RECENT_SHOWN,
      TAG_MAX: fmt.TAG_MAX,
      CATEGORY: fmt.CATEGORY,
      ILLUSTRATIONS: fmt.ILLUSTRATIONS,
      BANNER_LINKS: fmt.BANNER_LINKS,
    };
  },
  template: html`
<div class="page">
  <header class="page-head page-head--col">
    <h1 class="page-title" tabindex="-1" data-page-title>内容运营</h1>
    <p class="page-desc">小程序首页顶部的轮播图，和大家选「想做的事」、发起局时先看到的热门标签。这里改完，小程序马上生效。</p>
  </header>

  <StatusBanner :banner="banner" @close="closeBanner" />

  <TabList v-model="s.tab" :tabs="tabs" label="内容类型" id-prefix="content" />

  <div id="content-panel" role="tabpanel" :aria-labelledby="'content-tab-' + s.tab" class="stack-20">

    <!-- 首页轮播 -->
    <template v-if="s.tab === 'banners'">
      <section v-if="s.form" id="banner-form" class="card stack-16" aria-labelledby="bf-title">
        <div class="stack-4">
          <h2 id="bf-title" class="section-title" tabindex="-1">{{ s.form.id ? '编辑轮播图' : '添加轮播图' }}</h2>
          <p class="section-desc">横图效果最好（比如 1200×600）。标题写清楚点了能看到什么。</p>
        </div>
        <form class="stack-16" novalidate @submit.prevent="saveBanner">
          <div class="field">
            <span class="field__label">图片</span>
            <ImageUploader v-model="s.form.images" :max="1" label="轮播图" wide @busy="s.uploading = $event" />
          </div>
          <div class="form-grid">
            <div class="field field--wide">
              <label for="bf-t" class="field__label">标题</label>
              <input id="bf-t" v-model="s.form.title" type="text" class="input" maxlength="20" placeholder="比如：苍山日出" autocomplete="off">
            </div>
            <div class="field field--wide">
              <label for="bf-s" class="field__label">副标题<span class="field__hint">选填</span></label>
              <input id="bf-s" v-model="s.form.subtitle" type="text" class="input" maxlength="40" placeholder="比如：周六清晨，一起爬上去看日出" autocomplete="off">
            </div>
          </div>
          <div class="field">
            <span id="bf-link" class="field__label">点了去哪</span>
            <div class="chips" role="group" aria-labelledby="bf-link">
              <button v-for="o in BANNER_LINKS" :key="o.key" type="button" class="chip chip--sm" :aria-pressed="s.form.linkKind === o.key ? 'true' : 'false'" @click="pickLinkKind(o.key)">{{ o.label }}</button>
            </div>
            <div v-if="s.form.linkKind === 'event'" class="pick-box">
              <div v-if="s.form.eventId" class="picked">
                <span class="picked__text">已选：{{ linkText('event:' + s.form.eventId) }}<template v-if="s.events[s.form.eventId] && s.events[s.form.eventId].startAt"> · {{ fmt.dateTime(s.events[s.form.eventId].startAt) }}</template></span>
                <button id="bf-ev-change" type="button" class="btn btn--outline btn--sm" @click="unpickEvent">换一个</button>
              </div>
              <template v-else>
                <div class="search">
                  <Icon name="search" :size="18" stroke="#5B5F68" :weight="2" />
                  <input id="bf-ev-q" v-model="s.evQ" type="search" class="search__input" aria-label="搜局的标题或地点" placeholder="搜局的标题或地点" autocomplete="off" @input="onEvSearch" @keydown.enter.prevent="searchEvents">
                </div>
                <p class="small muted">只能选广场上看得到的局（撮合局只有成员能看到，不能放）。</p>
                <p v-if="s.evErr" class="form-error" role="alert">搜索失败：{{ s.evErr }}</p>
                <p v-else-if="s.evSearching" class="small muted" role="status">正在搜…</p>
                <ul v-else-if="s.evResults.length" class="pick-list" aria-label="搜到的局">
                  <li v-for="e in s.evResults" :key="e.id">
                    <button type="button" class="pick" @click="pickEvent(e)">
                      <span class="pick__title">{{ e.title }}</span>
                      <span class="pick__sub">{{ fmt.dateTime(e.startAt) }} · {{ e.place }}</span>
                      <StatusPill :status="fmt.displayStatus(e)" />
                    </button>
                  </li>
                </ul>
                <p v-else-if="s.evSearched" class="small muted" role="status">没有搜到能放进轮播图的局，换个词试试。</p>
              </template>
            </div>
          </div>
          <div class="field">
            <label for="bf-body" class="field__label">落地页正文<span class="field__hint">选填；填了就变成平台内广告落地页，点轮播图先进落地页</span></label>
            <textarea id="bf-body" v-model="s.form.body" class="input" rows="4" maxlength="2000" placeholder="介绍合作内容。留空＝不要落地页，点轮播图直接按上面的「点了去哪」跳转。"></textarea>
          </div>
          <div v-if="s.form.body.trim()" class="field">
            <label for="bf-cta" class="field__label">落地页按钮文案<span class="field__hint">选填，比如「立即参加」；按钮跳到上面选的「点了去哪」</span></label>
            <input id="bf-cta" v-model="s.form.ctaLabel" type="text" class="input" maxlength="12" placeholder="立即参加" autocomplete="off">
          </div>
          <div class="form-grid">
            <div class="field">
              <label for="bf-start" class="field__label">开始展示<span class="field__hint">选填</span></label>
              <input id="bf-start" v-model="s.form.startsAt" type="datetime-local" class="input">
            </div>
            <div class="field">
              <label for="bf-end" class="field__label">结束展示<span class="field__hint">选填，到点自动下架</span></label>
              <input id="bf-end" v-model="s.form.endsAt" type="datetime-local" class="input">
            </div>
          </div>
          <div class="switch-row">
            <span id="bf-en" class="switch-row__label">在小程序首页展示</span>
            <ToggleSwitch :checked="s.form.enabled" labelledby="bf-en" @toggle="s.form.enabled = !s.form.enabled" />
          </div>
          <p v-if="s.formErr" class="form-error" role="alert">{{ s.formErr }}</p>
          <div class="actions">
            <button type="submit" class="btn btn--primary btn--lg" :disabled="s.saving || s.uploading">{{ s.saving ? '正在保存…' : (s.form.id ? '保存' : '添加') }}</button>
            <button type="button" class="btn btn--outline btn--lg" @click="closeForm">取消</button>
          </div>
        </form>
      </section>

      <section class="card stack-16" aria-labelledby="bn-title">
        <div class="section-head">
          <div class="stack-4 grow">
            <h2 id="bn-title" class="section-title">首页轮播</h2>
            <p class="section-desc">按这里的顺序轮流展示，关掉的不展示。</p>
          </div>
          <button v-if="!s.form" id="bn-add" type="button" class="btn btn--primary" @click="openForm()"><Icon name="plus" :size="18" :weight="2.2" />添加轮播图</button>
        </div>
        <LoadState v-if="s.bLoading || s.bError" :loading="s.bLoading" :error="s.bError" compact @retry="loadBanners" />
        <div v-else-if="!s.banners.length" class="empty empty--left">
          <span class="empty__title">还没有轮播图</span>
          <span class="empty__text">添加一张，小程序首页顶部就会展示。</span>
        </div>
        <ol v-else class="banner-list">
          <li v-for="(b, i) in s.banners" :key="b.id" class="banner-row" :class="{ 'is-off': !b.enabled }">
            <button type="button" class="banner-row__img" :aria-label="'看大图：轮播图「' + b.title + '」'" @click="openLightbox([b.image], 0, '轮播图「' + b.title + '」')"><img :src="fmt.safeUrl(b.image)" alt="" loading="lazy"></button>
            <div class="banner-row__body">
              <div class="title-row">
                <span class="banner-row__no" aria-hidden="true">{{ i + 1 }}</span>
                <h3 :id="'bn-t-' + b.id" class="banner-row__title">{{ b.title }}</h3>
                <span class="pill" :class="b.enabled ? 'pill--tint' : 'pill--stone'">{{ b.enabled ? '展示中' : '已关闭' }}</span>
              </div>
              <span class="small muted">{{ b.subtitle || '没有副标题' }}</span>
              <span class="small body">{{ b.promo ? '落地页 → ' : '点了去：' }}{{ linkText(b.link) }}</span>
              <span class="small muted">曝光 {{ b.impressions }} · 点击 {{ b.clicks }}</span>
              <span v-if="b.startsAt || b.endsAt" class="small muted">排期：{{ b.startsAt ? fmt.dateTime(b.startsAt) : '现在' }} 至 {{ b.endsAt ? fmt.dateTime(b.endsAt) : '不限' }}</span>
            </div>
            <div class="banner-row__ops">
              <div class="switch-row switch-row--sm">
                <span :id="'bn-sw-' + b.id" class="switch-row__label">展示</span>
                <span :id="'bn-swn-' + b.id" class="sr-only">在首页展示「{{ b.title }}」</span>
                <ToggleSwitch :checked="!!b.enabled" :labelledby="'bn-swn-' + b.id" :busy="s.bBusy" @toggle="toggleBanner(b)" />
              </div>
              <div class="actions actions--tight">
                <button :id="'bn-up-' + b.id" type="button" class="btn btn--outline btn--sm" :aria-label="'把「' + b.title + '」上移'" :aria-disabled="i === 0 || s.bBusy ? 'true' : null" @click="i === 0 || s.bBusy || moveBanner(i, -1)">上移</button>
                <button :id="'bn-down-' + b.id" type="button" class="btn btn--outline btn--sm" :aria-label="'把「' + b.title + '」下移'" :aria-disabled="i === s.banners.length - 1 || s.bBusy ? 'true' : null" @click="i === s.banners.length - 1 || s.bBusy || moveBanner(i, 1)">下移</button>
                <button :id="'bn-edit-' + b.id" type="button" class="btn btn--outline btn--sm" :aria-label="'编辑「' + b.title + '」'" @click="openForm(b)">编辑</button>
                <button :id="'bn-del-' + b.id" type="button" class="btn btn--danger-outline btn--sm" :aria-label="'删掉「' + b.title + '」'" @click="askDelete(b)">删除</button>
              </div>
            </div>
            <div v-if="s.delAsk === b.id" class="confirm-box confirm-box--danger banner-row__ask">
              <span :id="'bn-del-ask-' + b.id" class="body-text" tabindex="-1">删掉轮播图「{{ b.title }}」？小程序首页马上就不展示了，删了不能恢复。只是暂时不想展示的话，关掉「展示」就行。</span>
              <div class="actions">
                <button type="button" class="btn btn--danger" :disabled="s.bBusy" @click="deleteBanner(b)">确定删除</button>
                <button type="button" class="btn btn--outline" @click="cancelDelete(b)">再想想</button>
              </div>
            </div>
          </li>
        </ol>
      </section>
    </template>

    <!-- 热门标签 -->
    <template v-else>
      <LoadState v-if="s.tLoading || s.tError" :loading="s.tLoading" :error="s.tError" @retry="loadTags" />
      <template v-else>
        <section class="card stack-16" aria-labelledby="hot-title">
          <div class="stack-4">
            <h2 id="hot-title" class="section-title" tabindex="-1">热门标签</h2>
            <p class="section-desc">小程序里选「想做的事」、发起局的时候，先给大家看这些，按这里的顺序。用户也可以自己写新的标签。</p>
          </div>
          <div v-if="!s.hot.length" class="empty empty--left">
            <span class="empty__title">还没有热门标签</span>
            <span class="empty__text">在下面添加，或者从「大家最近在用的标签」里挑。</span>
          </div>
          <ol v-else class="tag-list">
            <li v-for="(t, i) in s.hot" :key="t.id" class="tag-row">
              <span class="tag-row__no" aria-hidden="true">{{ i + 1 }}</span>
              <Cover :cover-key="t.cover" :width="60" />
              <div class="tag-row__body">
                <span :id="'tag-n-' + t.id" class="tag-row__name">{{ t.name }}</span>
                <span class="small muted">{{ fmt.categoryLabel(t.category) }} · 插画「{{ fmt.illustrationLabel(t.cover) || '默认' }}」 · 近 {{ RECENT_DAYS }} 天用了 {{ t.recentCount || 0 }} 次</span>
              </div>
              <div class="actions actions--tight">
                <button :id="'tag-up-' + t.id" type="button" class="btn btn--outline btn--sm" :aria-label="'把「' + t.name + '」上移'" :aria-disabled="i === 0 || s.tBusy ? 'true' : null" @click="i === 0 || s.tBusy || moveTag(i, -1)">上移</button>
                <button :id="'tag-down-' + t.id" type="button" class="btn btn--outline btn--sm" :aria-label="'把「' + t.name + '」下移'" :aria-disabled="i === s.hot.length - 1 || s.tBusy ? 'true' : null" @click="i === s.hot.length - 1 || s.tBusy || moveTag(i, 1)">下移</button>
                <button type="button" class="btn btn--ghost btn--sm" :aria-label="'把「' + t.name + '」移出热门'" :disabled="s.tBusy" @click="removeHot(t)">移出热门</button>
              </div>
            </li>
          </ol>
        </section>

        <section class="card stack-16" aria-labelledby="nt-title">
          <div class="stack-4">
            <h2 id="nt-title" class="section-title">添加热门标签</h2>
            <p class="section-desc">加进来的排在热门最后，可以再调顺序。</p>
          </div>
          <form class="stack-16" novalidate @submit.prevent="addTag">
            <div class="field">
              <label for="nt-name" class="field__label">标签<span class="field__hint" :class="{ 'text-danger': ntLen > TAG_MAX }">{{ ntLen }}/{{ TAG_MAX }} 个字</span></label>
              <input id="nt-name" v-model="s.nt.name" type="text" class="input" :class="{ 'input--error': s.ntErr }" placeholder="比如：洱海边露营" autocomplete="off"
                :aria-invalid="s.ntErr ? 'true' : null" :aria-describedby="s.ntErr ? 'nt-err' : 'nt-hint'" @input="s.ntErr = ''">
              <p v-if="s.ntErr" id="nt-err" class="form-error" role="alert">{{ s.ntErr }}</p>
              <p v-else id="nt-hint" class="small muted">1–8 个字，只能用文字、数字、空格和 · - _；会过内容审核。</p>
            </div>
            <div class="field">
              <span id="nt-cat" class="field__label">分类</span>
              <div class="chips" role="group" aria-labelledby="nt-cat">
                <button v-for="(label, key) in CATEGORY" :key="key" type="button" class="chip chip--sm" :aria-pressed="s.nt.category === key ? 'true' : 'false'" @click="pickCategory(key)">{{ label }}</button>
              </div>
            </div>
            <div class="field">
              <span id="nt-cover" class="field__label">插画<span class="field__hint">局没有照片时当封面</span></span>
              <div class="cover-grid" role="group" aria-labelledby="nt-cover">
                <button v-for="il in ILLUSTRATIONS" :key="il.key" type="button" class="cover-opt" :aria-pressed="s.nt.cover === il.key ? 'true' : 'false'" @click="pickCover(il.key)">
                  <img :src="fmt.illustrationUrl(il.key)" alt="" loading="lazy">
                  <span class="cover-opt__label">{{ il.label }}</span>
                </button>
              </div>
            </div>
            <div class="actions">
              <button type="submit" class="btn btn--primary btn--lg" :disabled="s.ntBusy">{{ s.ntBusy ? '正在添加…' : '加到热门' }}</button>
            </div>
          </form>
        </section>

        <section class="card stack-16" aria-labelledby="recent-title">
          <div class="stack-4">
            <h2 id="recent-title" class="section-title">大家最近在用的标签</h2>
            <p class="section-desc">近 {{ RECENT_DAYS }} 天大家写的「想做的事」和局的标签，用得多的排前面。觉得合适就加到热门。</p>
          </div>
          <p v-if="!s.recent.length" class="muted">最近还没有人用过标签。</p>
          <ul v-else class="tag-list">
            <li v-for="t in recentShown" :key="t.id" class="tag-row">
              <Cover :cover-key="t.cover" :width="48" />
              <div class="tag-row__body">
                <span class="tag-row__name">{{ t.name }}</span>
                <span class="small muted">{{ fmt.categoryLabel(t.category) }} · 近 {{ RECENT_DAYS }} 天 {{ t.recentCount || 0 }} 次 · 一共 {{ t.useCount || 0 }} 次{{ t.lastUsedAt ? ' · 最近一次 ' + fmt.ago(t.lastUsedAt) : '' }}</span>
              </div>
              <span v-if="t.hot" class="pill pill--tint">{{ hotIndex(t) >= 0 ? '热门第 ' + (hotIndex(t) + 1) + ' 个' : '热门' }}</span>
              <button v-else :id="'recent-' + t.id" type="button" class="btn btn--outline-primary btn--sm" :aria-label="'把「' + t.name + '」加到热门'" :disabled="s.tBusy" @click="promote(t)">加到热门</button>
            </li>
          </ul>
          <button v-if="!s.showAllRecent && s.recent.length > RECENT_SHOWN" type="button" class="text-btn" @click="s.showAllRecent = true">全部显示（{{ s.recent.length }} 个）</button>
        </section>
      </template>
    </template>
  </div>
</div>`,
};
