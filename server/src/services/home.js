// 首页内容（GET /api/home）：轮播图、热门标签、大家最近在玩、精选局、本周数据。
// 不需要登录；登录了按拉黑和「谁可以报名」过滤。
import { clock, DAY } from '../clock.js';
import { homeBanners } from './banners.js';
import { eventCard, joinedCount, squareCandidates } from './events.js';
import { highlightPosts } from './posts.js';
import { hotTags } from './tags.js';

/** 近 7 天加入过局的人数、成群的局数 */
export function weekStats(db, now = clock.now()) {
  const since = new Date(now.getTime() - 7 * DAY).toISOString();
  const until = now.toISOString();
  return {
    weekPeople: Number(
      db.get('SELECT COUNT(DISTINCT user_id) AS n FROM event_members WHERE joined_at >= ? AND joined_at <= ?', since, until).n,
    ),
    weekFormed: Number(db.get('SELECT COUNT(*) AS n FROM events WHERE formed_at >= ? AND formed_at <= ?', since, until).n),
  };
}

/** 精选局：广场上最近要开始、还有名额的局，最多 6 个 */
function featuredEvents(db, viewer, limit = 6) {
  return squareCandidates(db, viewer)
    .filter((e) => joinedCount(db, e.id) < e.capacity)
    .slice(0, limit)
    .map((e) => eventCard(db, e, viewer));
}

export function homeView(db, viewer) {
  return {
    banners: homeBanners(db),
    hotTags: hotTags(db).items,
    highlights: highlightPosts(db, viewer, 10),
    featuredEvents: featuredEvents(db, viewer),
    stats: weekStats(db),
  };
}
