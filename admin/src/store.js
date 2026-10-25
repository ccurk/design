// 左侧菜单上的待办角标：待确认的撮合方案、待处理的举报 + 待审内容、待处理的申诉。
import { reactive } from './vue.js';
import { api, auth } from './api.js';

export const badges = reactive({ proposals: 0, moderation: 0, appeals: 0 });

/** 用 /admin/stats 的结果更新角标（概览页已经拿到 stats 时直接用） */
export function applyStats(stats) {
  const t = (stats && stats.today) || {};
  badges.proposals = t.pendingProposals || 0;
  badges.moderation = (t.pendingReports || 0) + (t.pendingPosts || 0) + (t.pendingEvents || 0);
}

let running = false;
let again = false;

/**
 * 重新拉一次角标；任何操作成功后都可以调用。
 * 正在拉的时候又被调用，就等这次拉完再拉一次，保证拿到操作之后的数字。
 * 失败时安静地保留旧数字（401 已在 api() 里处理）。
 */
export async function refreshBadges() {
  if (!auth.token) return;
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    do {
      again = false;
      try {
        const [stats, appeals] = await Promise.all([api('/admin/stats'), api('/admin/appeals')]);
        applyStats(stats);
        badges.appeals = appeals.items.length;
      } catch {
        // 角标刷新失败不打扰运营
      }
    } while (again && auth.token);
  } finally {
    running = false;
  }
}
