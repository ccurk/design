// 局：卡片 / 详情视图、可见性、广场、发起、报名、退出、最晚退出时间、成群、轻确认、到场、报平安。
import { clock, HOUR, MINUTE } from '../clock.js';
import { AREAS, CATEGORIES, FEE_TYPES, GENDER_LIMITS, GENDER_LIMIT_LABELS, SYSTEM_MESSAGES, categoryOfTask } from '../constants.js';
import { json } from '../db.js';
import { conflict, forbidden, invalid, notFound, restricted } from '../errors.js';
import { checkAll } from '../moderation.js';
import { dateLabel, fullDateLabel, shortTitle } from '../time.js';
import { absUrl, absUrls, parseImages } from '../urls.js';
import { bool, int, isoTime, num, oneOf, str } from '../validate.js';
import { creditOf, effectiveStatus, upsertEventCredit } from './credit.js';
import { notify } from './notices.js';
import { assertNoOverlap, firstOverlap } from './overlap.js';
import { coverKeyFor, parseTag, tagKey, useTag } from './tags.js';
import { blockRelatedIds, getUser, userBrief } from './users.js';

export { shortTitle };

// ---- 基础查询 ----

export async function getEvent(db, id) {
  return await db.get('SELECT * FROM events WHERE id = ?', id);
}

export async function requireEvent(db, id) {
  const event = await getEvent(db, id);
  if (!event) throw notFound('局不存在');
  return event;
}

export async function memberRow(db, eventId, userId) {
  if (!userId) return null;
  return (await db.get('SELECT * FROM event_members WHERE event_id = ? AND user_id = ?', eventId, userId)) || null;
}

/** 已加入的成员（发起人在前，其余按加入时间） */
export async function joinedMembers(db, eventId) {
  return await db.all(
    `SELECT m.*, u.nickname FROM event_members m JOIN users u ON u.id = m.user_id
     WHERE m.event_id = ? AND m.status = 'joined'
     ORDER BY (m.role = 'host') DESC, m.joined_at, m.user_id`,
    eventId,
  );
}

export async function joinedCount(db, eventId) {
  return Number((await db.get("SELECT COUNT(*) AS n FROM event_members WHERE event_id = ? AND status = 'joined'", eventId)).n);
}

export function endAt(event) {
  return new Date(Date.parse(event.start_at) + event.duration_min * MINUTE);
}

/** upcoming | ongoing | ended（开始 ≤ 现在 < 开始 + 时长 为 ongoing） */
export function phaseOf(event, now = clock.now()) {
  const t = now.getTime();
  if (t < Date.parse(event.start_at)) return 'upcoming';
  if (t < endAt(event).getTime()) return 'ongoing';
  return 'ended';
}

export function feeLabel(event) {
  const est = event.fee_estimate ? ` 约 ¥${Number(event.fee_estimate)}` : '';
  switch (event.fee_type) {
    case 'aa':
      return `AA${est}`;
    case 'free':
      return '免费';
    case 'host':
      return '发起人请客';
    case 'split':
      return `各付各${est}`;
    default:
      return '';
  }
}

/**
 * 群聊是否开启：只在成群后（所有来源一致）。
 * 成群后有人退出、局回到 open 时，群聊照常（群已经建好了）；取消 / 驳回的局关闭。
 */
export function isChatOpen(event) {
  if (event.status === 'formed') return true;
  return event.status === 'open' && Boolean(event.formed_at);
}

export async function addSystemMessage(db, eventId, text) {
  return await db.insert('messages', { event_id: eventId, user_id: null, kind: 'system', text, created_at: clock.iso() });
}

// ---- 最晚退出时间、谁可以报名 ----

/** 默认的最晚退出时间：max(开始前 24 小时, 现在 + 30 分钟)，不晚于开始 */
export function defaultExitDeadline(startAt, now = clock.now()) {
  const start = new Date(startAt).getTime();
  return new Date(Math.min(start, Math.max(start - 24 * HOUR, now.getTime() + 30 * MINUTE)));
}

/** 局的最晚退出时间（老数据没存时按创建时间套默认规则） */
export function exitDeadlineOf(event) {
  if (event.exit_deadline) return new Date(event.exit_deadline);
  return defaultExitDeadline(event.start_at, new Date(event.created_at));
}

/** 组局有效期：建局后这么久还没凑够人就自动解散（独立于开场时间，远期的局不会一直挂在广场） */
export const ORGANIZE_TTL = 30 * 24 * HOUR;

/** 还在凑人的局是否已超过组局有效期 */
export function organizeExpired(event, now = clock.now()) {
  return now.getTime() >= Date.parse(event.created_at) + ORGANIZE_TTL;
}

export function exitDeadlinePassed(event, now = clock.now()) {
  return now.getTime() >= exitDeadlineOf(event).getTime();
}

/** 「已过最晚退出时间（10月30日 05:50），不能退出了」 */
export function exitDeadlineMessage(event) {
  return `已过最晚退出时间（${fullDateLabel(exitDeadlineOf(event))}），不能退出了`;
}

/** 谁可以报名：any / female / male（存在 same_sex_only + gender 两列里） */
export function genderLimitOf(event) {
  return event.same_sex_only && ['female', 'male'].includes(event.gender) ? event.gender : 'any';
}

const genderAllowed = (event, viewer) => {
  const limit = genderLimitOf(event);
  return limit === 'any' || viewer?.gender === limit;
};

// ---- 可见性 ----

/**
 * 能否查看这个局：
 * - 撮合局只有被邀请过 / 加入过的人能看；
 * - 待审核 / 被驳回的局只有发起人能看；
 * - 和发起人或成员有拉黑关系、或性别不符合「谁可以报名」（含性别未填）时，非成员看不到。
 */
export async function canViewEvent(db, event, viewer) {
  const m = viewer ? await memberRow(db, event.id, viewer.id) : null;
  const isCreator = viewer && event.creator_id === viewer.id;
  if (isCreator || m) return true;
  if (event.source === 'matched') return false;
  if (['pending_review', 'rejected'].includes(event.status)) return false;
  if (!genderAllowed(event, viewer)) return false;
  if (viewer) {
    const related = await blockRelatedIds(db, viewer.id);
    if (related.size) {
      if (event.creator_id && related.has(event.creator_id)) return false;
      if ((await joinedMembers(db, event.id)).some((x) => related.has(x.user_id))) return false;
    }
  }
  return true;
}

export async function requireVisibleEvent(db, eventId, viewer) {
  const event = await requireEvent(db, eventId);
  if (!(await canViewEvent(db, event, viewer))) throw notFound('局不存在或你没有权限查看');
  return event;
}

const CONFLICT_REASONS = ['已经满员了', '这个局现在不能报名了', '已经截止报名了'];

/** 报名资格检查（返回中文原因，可报名时返回 null）；时间重叠在报名时单独检查 */
async function joinBlocker(db, event, viewer, count, members) {
  if (!viewer) return '请先登录';
  if (event.source === 'matched') return '撮合局只能通过邀请加入';
  if (event.status !== 'open') return '这个局现在不能报名了';
  if (phaseOf(event) !== 'upcoming') return '局已经开始了';
  if (exitDeadlinePassed(event)) return '已经截止报名了';
  if (count >= event.capacity) return '已经满员了';
  const status = effectiveStatus(viewer);
  if (status !== 'active' || (await creditOf(db, viewer)).level === 'restricted') return '账号受限中，暂时不能报名';
  if (!genderAllowed(event, viewer)) return `这个局${GENDER_LIMIT_LABELS[genderLimitOf(event)]}报名`;
  const related = await blockRelatedIds(db, viewer.id);
  if (members.some((x) => related.has(x.user_id))) return '暂时不能加入这个局';
  return null;
}

/** 退出按钮的状态：能不能退、不能退的原因（不在局里时两者都没有） */
function leaveState(event, mine, now = clock.now()) {
  if (!mine || !['joined', 'applied', 'invited'].includes(mine.status)) return { canLeave: false, reason: null };
  if (['cancelled', 'rejected'].includes(event.status)) return { canLeave: false, reason: '这个局已经取消了' };
  if (phaseOf(event, now) === 'ended') return { canLeave: false, reason: '局已经结束了' };
  if (mine.status !== 'joined') return { canLeave: true, reason: null }; // 撤回申请 / 换一批
  if (mine.role === 'host') return { canLeave: false, reason: '你是发起人，不想办了可以取消这个局' };
  if (exitDeadlinePassed(event, now)) return { canLeave: false, reason: exitDeadlineMessage(event) };
  return { canLeave: true, reason: null };
}

// ---- 视图 ----

export async function eventCard(db, event, viewer = null, members) {
  if (members === undefined) members = await joinedMembers(db, event.id);
  const now = clock.now();
  const images = json.parse(event.images, []);
  const limit = genderLimitOf(event);
  return {
    id: event.id,
    title: event.title,
    category: event.category,
    task: event.task,
    tag: event.task,
    startAt: event.start_at,
    dateLabel: dateLabel(new Date(event.start_at), now),
    place: event.place,
    area: event.area ?? null,
    capacity: event.capacity,
    memberCount: members.length,
    membersPreview: await Promise.all(members.slice(0, 3).map((x) => userBrief(db, x.user_id, now))),
    feeLabel: feeLabel(event),
    source: event.source,
    status: event.status,
    phase: phaseOf(event, now),
    cover: images.length ? absUrl(db, images[0]) : null,
    coverKey: await coverKeyFor(db, event.task, event.category),
    genderLimit: limit,
    genderLabel: GENDER_LIMIT_LABELS[limit] ?? null,
    exitDeadline: exitDeadlineOf(event).toISOString(),
  };
}

export async function eventDetail(db, event, viewer = null) {
  const members = await joinedMembers(db, event.id);
  const card = await eventCard(db, event, viewer, members);
  const mine = viewer ? await memberRow(db, event.id, viewer.id) : null;
  const myStatus = mine?.status ?? null;
  const alreadyIn = ['joined', 'applied', 'invited'].includes(myStatus);
  const leave = leaveState(event, mine);
  return {
    ...card,
    description: event.description,
    meetingPoint: event.meeting_point,
    durationMin: event.duration_min,
    feeType: event.fee_type,
    feeEstimate: event.fee_estimate === null ? null : Number(event.fee_estimate),
    requireApproval: Boolean(event.require_approval),
    sameSexOnly: card.genderLimit !== 'any',
    host: event.source === 'user' && event.creator_id ? await userBrief(db, event.creator_id) : null,
    members: await Promise.all(members.map(async (x) => ({ ...(await userBrief(db, x.user_id)), role: x.role }))),
    myStatus,
    myAttendance: mine && myStatus === 'joined' ? mine.attendance : null,
    myArrivedAt: mine?.arrived_at ?? null,
    canJoin: !alreadyIn && (await joinBlocker(db, event, viewer, members.length, members)) === null,
    isFull: members.length >= event.capacity,
    chatOpen: isChatOpen(event),
    images: absUrls(db, json.parse(event.images, [])),
    location: json.parse(event.location, null),
    exitDeadlineLabel: fullDateLabel(exitDeadlineOf(event)),
    canLeave: leave.canLeave,
    leaveBlockedReason: leave.reason,
    remaining: Math.max(0, event.capacity - members.length),
    // 以下为补充字段
    endAt: endAt(event).toISOString(),
    fullDateLabel: fullDateLabel(new Date(event.start_at)),
    isHost: Boolean(viewer && event.creator_id === viewer.id),
    minSize: event.min_size,
  };
}

/** 报名 / 接受邀请的返回值：客户端据此显示「进入群聊」或「已加入，还差 N 人成群」 */
export async function joinResult(db, eventId, myStatus) {
  const event = await getEvent(db, eventId);
  const memberCount = await joinedCount(db, eventId);
  return {
    myStatus,
    eventStatus: event.status,
    formed: isChatOpen(event),
    remaining: Math.max(0, event.capacity - memberCount),
    memberCount,
    capacity: event.capacity,
    exitDeadline: exitDeadlineOf(event).toISOString(),
  };
}

// ---- 广场 / 搜索 ----

/** 广场上的局：open 的用户局 / 平台局，还没开始、还没过最晚退出时间；按看的人过滤性别和拉黑 */
export async function squareCandidates(db, viewer, { category = null, tag = null, source = null, area = null } = {}) {
  const now = clock.now();
  const params = [now.toISOString()];
  if (category) params.push(category);
  if (source) params.push(source);
  if (area) params.push(area);
  const rows = await db.all(
    `SELECT * FROM events WHERE status = 'open' AND source IN ('user', 'platform') AND start_at > ?
     ${category ? 'AND category = ?' : ''}
     ${source ? 'AND source = ?' : ''}
     ${area ? 'AND area = ?' : ''} ORDER BY start_at, id`,
    ...params,
  );
  const key = tag ? tagKey(tag) : '';
  const related = viewer ? await blockRelatedIds(db, viewer.id) : new Set();
  // 「只参加同性局」只约束撮合（见 matchRules.pairCompatible / docs §3.2），不作为广场 / 首页 / 搜索的浏览过滤：
  // 否则开了该设置的人这些页面几乎全空，却又允许手动加入这些混合局，自相矛盾。
  const visible = [];
  for (const e of rows) {
    if (exitDeadlinePassed(e, now)) continue;
    if (key && tagKey(e.task) !== key) continue;
    if (!genderAllowed(e, viewer)) continue;
    if (related.size) {
      if (e.creator_id && related.has(e.creator_id)) continue;
      if ((await joinedMembers(db, e.id)).some((x) => related.has(x.user_id))) continue;
    }
    visible.push(e);
  }
  return visible;
}

/** 广场排序：soon = 即将开始（默认）、new = 最新发布、filling = 快满了（报名比例高的在前） */
async function sortCandidates(db, rows, sort) {
  if (sort === 'new') return [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  if (sort === 'filling') {
    const withFill = await Promise.all(
      [...rows].map(async (e) => ({ e, fill: (await joinedCount(db, e.id)) / Math.max(1, e.capacity) })),
    );
    return withFill
      .sort((a, b) => b.fill - a.fill || (a.e.start_at < b.e.start_at ? -1 : 1))
      .map((x) => x.e);
  }
  return rows; // soon：SQL 已按 start_at 升序
}

export async function squareList(db, viewer, { category, tag, source, area, sort = 'soon', limit = 20, cursor = 0 } = {}) {
  if (category && !CATEGORIES.includes(category)) throw invalid('分类不正确');
  if (source && !['user', 'platform'].includes(source)) throw invalid('来源不正确');
  if (area && !AREAS.includes(area)) throw invalid('片区不正确');
  const all = await sortCandidates(db, await squareCandidates(db, viewer, { category, tag, source, area }), sort);
  const page = all.slice(cursor, cursor + limit);
  return {
    items: await Promise.all(page.map((e) => eventCard(db, e, viewer))),
    nextCursor: cursor + limit < all.length ? cursor + limit : null,
  };
}

/** 本周人气榜：广场可见的局里，按已加入人数排名（并列的最近开始的在前），取前 N 个 */
export async function eventRanking(db, viewer, { limit = 6 } = {}) {
  const withCount = await Promise.all(
    (await squareCandidates(db, viewer, {})).map(async (e) => ({ e, n: await joinedCount(db, e.id) })),
  );
  const ranked = withCount
    .sort((a, b) => b.n - a.n || (a.e.start_at < b.e.start_at ? -1 : 1))
    .slice(0, limit)
    .map((x) => x.e);
  return { items: await Promise.all(ranked.map((e) => eventCard(db, e, viewer))) };
}

export async function searchEvents(db, viewer, q) {
  const term = String(q || '').trim().toLowerCase();
  if (!term) return { items: [] };
  const items = (await squareCandidates(db, viewer))
    .filter((e) => [e.title, e.place, e.task, e.meeting_point, e.description].some((s) => (s || '').toLowerCase().includes(term)))
    .slice(0, 50);
  return { items: await Promise.all(items.map((e) => eventCard(db, e, viewer))) };
}

const DEFAULT_HOT = ['看日出', '安静读书', '骑行', '桌游', '拼车去双廊', '早餐'];

export async function hotTerms(db) {
  const rows = await db.all(
    `SELECT task, COUNT(*) AS n FROM (
       SELECT task FROM events WHERE status IN ('open', 'formed') AND start_at > ? AND task IS NOT NULL
       UNION ALL SELECT task FROM intents WHERE created_at > ?
     ) GROUP BY task ORDER BY n DESC LIMIT 6`,
    clock.iso(),
    new Date(clock.now().getTime() - 14 * 24 * HOUR).toISOString(),
  );
  const terms = [...new Set([...rows.map((r) => r.task), ...DEFAULT_HOT])].slice(0, 8);
  return { terms };
}

// ---- 发起 ----

const given = (v) => v !== undefined && v !== null && v !== '';

/** 地点（wx.chooseLocation 的返回）：{name, address, latitude, longitude}；名字必填，经纬度要么都有要么都没有 */
export function parseLocation(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('地点格式不正确');
  const name = str(value.name, '地点名称', { min: 1, max: 40 });
  const address = str(value.address, '详细地址', { max: 100, optional: true });
  if (given(value.latitude) !== given(value.longitude)) throw invalid('经纬度要一起填');
  const latitude = given(value.latitude) ? num(value.latitude, '纬度', { min: -90, max: 90 }) : null;
  const longitude = given(value.longitude) ? num(value.longitude, '经度', { min: -180, max: 180 }) : null;
  return { name, address: address || null, latitude, longitude };
}

/**
 * 谁可以报名：genderLimit（any / female / male）；旧字段 sameSexOnly 仍接受
 * （用户局 = 发起人的性别，平台局要带 gender）。用户局的限制必须包含发起人自己。
 */
function parseGenderLimit(body, creator) {
  let limit = oneOf(body.genderLimit, '谁可以报名', GENDER_LIMITS, { optional: true });
  if (!limit) {
    const sameSex = bool(body.sameSexOnly, '是否只限同性', { optional: true }) ?? false;
    if (!sameSex) limit = 'any';
    else if (creator) limit = creator.gender;
    else if (['female', 'male'].includes(body.gender)) limit = body.gender;
    else throw invalid('同性局需要指定 gender（female / male）');
  }
  if (creator && limit !== 'any') {
    if (!['female', 'male'].includes(creator.gender)) throw invalid('先在资料里选性别');
    if (limit !== creator.gender) throw invalid('发起人自己也要能参加');
  }
  return limit;
}

/** 发起局的参数。creator = 发起人（平台局为 null） */
export function parseEventInput(body, { creator = null } = {}) {
  const now = clock.now();
  const title = str(body.title, '标题', { min: 2, max: 30 });
  // 标签：tag；旧的 category（+ task）仍接受，只给 category 时按标题推一个默认标签
  const category = oneOf(body.category, '类型', CATEGORIES, { optional: true });
  let tag;
  if (given(body.tag)) tag = parseTag(body.tag);
  else if (given(body.task)) tag = parseTag(body.task);
  else if (category) tag = defaultTaskForCategory(category, title);
  else throw invalid('请选择标签');
  const startAt = isoTime(body.startAt, '开始时间');
  if (startAt.getTime() < now.getTime() + 30 * MINUTE) throw invalid('开始时间至少要在 30 分钟以后');
  if (startAt.getTime() > now.getTime() + 90 * 24 * HOUR) throw invalid('只能发起 90 天以内的局');
  const durationMin = int(body.durationMin, '时长', { min: 30, max: 24 * 60, optional: true }) ?? 120;
  const location = parseLocation(body.location);
  const place = str(body.place, '地点', { max: 40, optional: true }) || location?.name;
  if (!place) throw invalid('请填写地点');
  const meetingPoint = str(body.meetingPoint, '集合点', { max: 60, optional: true }) ?? '';
  const capacity = int(body.capacity, '人数', { min: 2, max: 20 });
  const minSize = int(body.minSize, '最少成群人数', { min: 2, max: capacity, optional: true }) ?? 2;
  const feeType = oneOf(body.feeType ?? 'aa', '费用方式', FEE_TYPES);
  const feeEstimate = num(body.feeEstimate, '预计费用', { min: 0, max: 100000, optional: true });
  const requireApproval = bool(body.requireApproval, '是否需要同意', { optional: true }) ?? false;
  const description = str(body.description, '说明', { max: 500, optional: true }) ?? '';
  const images = parseImages(body.images, { max: 9 });
  const exitDeadline = isoTime(body.exitDeadline, '最晚退出时间', { optional: true }) ?? defaultExitDeadline(startAt, now);
  if (exitDeadline.getTime() <= now.getTime() || exitDeadline.getTime() > startAt.getTime()) {
    throw invalid('最晚退出时间要在现在和开始时间之间');
  }
  const genderLimit = parseGenderLimit(body, creator);
  const area = oneOf(body.area, '片区', AREAS, { optional: true }) ?? null;
  return {
    title,
    category,
    tag,
    area,
    startAt,
    durationMin,
    place,
    location,
    meetingPoint,
    capacity,
    minSize,
    feeType,
    feeEstimate,
    requireApproval,
    description,
    images,
    exitDeadline,
    genderLimit,
  };
}

function defaultTaskForCategory(category, title) {
  const known = ['看日出', '爬山', '徒步', '骑行', '随便走走', '吃饭', '早餐', '夜市', '咖啡', '读书', '桌游', '拼车'];
  const hit = known.find((t) => title.includes(t) && categoryOfTask(t) === category);
  if (hit) return hit;
  return { outdoor: '随便走走', food: '吃饭', coffee: '咖啡', game: '桌游', carpool: '拼车' }[category] || '其他';
}

/** 写库用的列；tag 是 useTag 返回的标签行（分类由标签推出） */
function eventColumns(input, tag) {
  return {
    title: input.title,
    category: tag.category,
    task: tag.name,
    description: input.description,
    start_at: input.startAt.toISOString(),
    duration_min: input.durationMin,
    place: input.place,
    meeting_point: input.meetingPoint,
    capacity: input.capacity,
    min_size: input.minSize,
    fee_type: input.feeType,
    fee_estimate: input.feeEstimate,
    require_approval: input.requireApproval,
    same_sex_only: input.genderLimit !== 'any',
    gender: input.genderLimit === 'any' ? null : input.genderLimit,
    images: JSON.stringify(input.images),
    location: input.location ? JSON.stringify(input.location) : null,
    area: input.area,
    exit_deadline: input.exitDeadline.toISOString(),
  };
}

/** 用户发起局：过审核则 open，否则 pending_review；发起人自动加入（要检查时间重叠） */
/** C 再约：发起人把上次同行的人（body.invite 的 userId 列表）请回来，给每个有效用户发通知 */
async function notifyReunion(db, event, host, invite) {
  if (!Array.isArray(invite)) return;
  const seen = new Set();
  for (const raw of invite.slice(0, 20)) {
    const uid = Number(raw);
    if (!Number.isInteger(uid) || uid <= 0 || uid === host.id || seen.has(uid)) continue;
    seen.add(uid);
    if (!(await getUser(db, uid))) continue;
    await notify(db, uid, {
      type: 'reunion_invite',
      title: '有人想再约你',
      body: `${host.nickname} 发起了「${shortTitle(event.title)}」，想再约你一起，去看看吧`,
      link: `event:${event.id}`,
    });
  }
}

export async function createUserEvent(db, user, body) {
  if (effectiveStatus(user) !== 'active' || (await creditOf(db, user)).level === 'restricted') {
    throw restricted('账号受限中，暂时不能发起局');
  }
  const input = parseEventInput(body, { creator: user });
  const check = checkAll(
    input.title,
    input.description,
    input.place,
    input.meetingPoint,
    input.location?.name,
    input.location?.address,
  );
  return await db.tx(async () => {
    await assertNoOverlap(db, user.id, input.startAt, input.durationMin);
    const tag = await useTag(db, input.tag, { category: input.category });
    const now = clock.iso();
    const id = await db.insert('events', {
      ...eventColumns(input, tag),
      source: 'user',
      creator_id: user.id,
      status: check.ok ? 'open' : 'pending_review',
      moderation: JSON.stringify(check.reasons),
      created_at: now,
    });
    await db.insert('event_members', {
      event_id: id,
      user_id: user.id,
      role: 'host',
      status: 'joined',
      attendance: 'pending',
      joined_at: now,
    });
    const event = await getEvent(db, id);
    await notifyReunion(db, event, user, body.invite); // C 再约：通知上次同行的人
    return event;
  });
}

/** 平台局（后台发起）：谁可以报名不受限制 */
export async function createPlatformEvent(db, body) {
  const input = parseEventInput(body);
  return await db.tx(async () => {
    const tag = await useTag(db, input.tag, { category: input.category });
    const id = await db.insert('events', {
      ...eventColumns(input, tag),
      require_approval: 0,
      source: 'platform',
      creator_id: null,
      status: 'open',
      created_at: clock.iso(),
    });
    return await getEvent(db, id);
  });
}

// ---- 成群 ----

/** 成群的系统消息 + 给每个成员的通知（type formed，link chat:<id>） */
export async function announceFormed(db, event, { atDeadline = false } = {}) {
  await addSystemMessage(db, event.id, atDeadline ? SYSTEM_MESSAGES.formedAtDeadline : SYSTEM_MESSAGES.formed);
  const members = await joinedMembers(db, event.id);
  for (const m of members) {
    await notify(db, m.user_id, {
      type: 'formed',
      title: atDeadline ? '人数够了，群已建好' : '满员啦，群已建好',
      body: `「${shortTitle(event.title)}」${members.length} 人，群聊已开启。第一次见面，慢慢来`,
      link: `chat:${event.id}`,
    });
  }
}

/** 用户局 / 平台局成群：满员时立即，或到了最晚退出时间人数够 minSize。已经成过群的（有人退出后又满）不再重复通知 */
export async function formEvent(db, event, { atDeadline = false } = {}) {
  await db.update('events', event.id, { status: 'formed', formed_at: event.formed_at || clock.iso() });
  if (!event.formed_at) await announceFormed(db, event, { atDeadline });
}

// ---- 成员变动 ----

async function setMember(db, eventId, userId, patch) {
  const existing = await memberRow(db, eventId, userId);
  if (existing) {
    const keys = Object.keys(patch);
    await db.run(
      `UPDATE event_members SET ${keys.map((k) => `${k} = :${k}`).join(', ')} WHERE event_id = :eventId AND user_id = :userId`,
      { ...patch, eventId, userId },
    );
  } else {
    await db.insert('event_members', { event_id: eventId, user_id: userId, role: 'member', ...patch });
  }
}

/** 加入成功后的统一处理：系统消息、满员成群 */
async function afterJoined(db, event, user) {
  const count = await joinedCount(db, event.id);
  if (event.source !== 'matched') await addSystemMessage(db, event.id, `${user.nickname} 加入了这个局`);
  if (event.status === 'open' && count >= event.capacity) {
    await formEvent(db, event);
    await closePendingApplications(db, event); // 满员成群时，还挂着的报名申请一并结束（与到期成群路径一致）
  }
  return await getEvent(db, event.id);
}

/** 邀请归因：取出有效的分享人 id（真实用户、不是本人）；无效返回 null */
async function inviterFrom(db, ref, selfId) {
  const id = Number(ref);
  if (!Number.isInteger(id) || id <= 0 || id === selfId) return null;
  return (await getUser(db, id)) ? id : null;
}

/** 通知分享人「你邀请的朋友来了」（发起人本人不重复通知，他另有「有人加入」的通知） */
async function notifyInviter(db, event, joiner, inviterId) {
  if (!inviterId || inviterId === event.creator_id || inviterId === joiner.id) return;
  await notify(db, inviterId, {
    type: 'invite_joined',
    title: '你邀请的朋友来了',
    body: `${joiner.nickname} 通过你的分享加入了「${shortTitle(event.title)}」`,
    link: `event:${event.id}`,
  });
}

export async function joinEvent(db, user, eventId, body = {}) {
  return await db.tx(async () => {
    const event = await requireVisibleEvent(db, eventId, user);
    const inviterId = await inviterFrom(db, body.ref, user.id); // 邀请归因：谁分享来的
    const mine = await memberRow(db, eventId, user.id);
    if (mine && ['joined', 'applied'].includes(mine.status)) return await joinResult(db, eventId, mine.status);
    if (mine?.status === 'invited') throw conflict('你已被邀请，请在「撮合成功」页确认加入');
    const members = await joinedMembers(db, eventId);
    const reason = await joinBlocker(db, event, user, members.length, members);
    if (reason) {
      if (reason.startsWith('账号受限')) throw restricted(reason);
      if (CONFLICT_REASONS.includes(reason)) throw conflict(reason);
      if (reason === '局已经开始了') throw invalid(reason);
      throw forbidden(reason);
    }
    await assertNoOverlap(db, user.id, event.start_at, event.duration_min, { excludeEventId: eventId });
    const now = clock.iso();
    const needApproval =
      event.source === 'user' && (event.require_approval || ((await creditOf(db, user)).level === 'fair' && event.capacity >= 6));
    if (needApproval) {
      await setMember(db, eventId, user.id, { status: 'applied', role: 'member', applied_at: now, attendance: 'pending', ...(inviterId ? { invited_by: inviterId } : {}) });
      if (event.creator_id) {
        await notify(db, event.creator_id, {
          type: 'application',
          title: '有人想加入你的局',
          body: `${user.nickname} 申请加入「${event.title}」，去看看吧`,
          link: `event:${event.id}`,
        });
      }
      return await joinResult(db, eventId, 'applied');
    }
    await setMember(db, eventId, user.id, {
      status: 'joined',
      role: 'member',
      joined_at: now,
      left_at: null,
      attendance: 'pending',
      arrived_at: null,
      safe_at: null,
      ...(inviterId ? { invited_by: inviterId } : {}),
    });
    await afterJoined(db, event, user);
    if (event.creator_id && event.creator_id !== user.id) {
      await notify(db, event.creator_id, {
        type: 'join',
        title: '有人加入了你的局',
        body: `${user.nickname} 加入了「${event.title}」`,
        link: `event:${event.id}`,
      });
    }
    await notifyInviter(db, event, user, inviterId);
    return await joinResult(db, eventId, 'joined');
  });
}

/** 开场前 24 小时内（含已开始）退出 → 临时鸽 */
export function latePenalty(event, now = clock.now()) {
  return Date.parse(event.start_at) - now.getTime() < 24 * HOUR ? 'cancel_late' : null;
}

/**
 * 退出：joined → left（24 小时规则记临时鸽）；applied → 撤回申请；invited → 等同「换一批」。
 * 过了最晚退出时间，已加入的人不能退出（409）。declineInvite 由 invites.js 注入，避免循环依赖。
 */
export async function leaveEvent(db, user, eventId, { declineInvite } = {}) {
  return await db.tx(async () => {
    const event = await requireEvent(db, eventId);
    const mine = await memberRow(db, eventId, user.id);
    if (!mine || !['joined', 'applied', 'invited'].includes(mine.status)) throw invalid('你不在这个局里');
    const now = clock.now();
    const live = !['cancelled', 'rejected'].includes(event.status) && phaseOf(event, now) !== 'ended';
    if (mine.status === 'joined' && mine.role !== 'host' && live && exitDeadlinePassed(event, now)) {
      throw conflict(exitDeadlineMessage(event));
    }
    if (mine.status === 'invited' || (event.source === 'matched' && event.status === 'inviting')) {
      await declineInvite(db, user, eventId); // 还没成局：等同「换一批」，不扣分
      return { penalty: null };
    }
    if (mine.status === 'applied') {
      await setMember(db, eventId, user.id, { status: 'left', left_at: now.toISOString() });
      return { penalty: null };
    }
    if (mine.role === 'host') throw invalid('你是发起人，不想办了可以取消这个局');
    if (phaseOf(event, now) === 'ended') throw invalid('局已经结束了');
    if (['cancelled', 'rejected'].includes(event.status)) throw invalid('这个局已经取消了');

    const penalty = latePenalty(event, now);
    await setMember(db, eventId, user.id, { status: 'left', left_at: now.toISOString(), attendance: 'no' });
    if (penalty) {
      await upsertEventCredit(db, {
        userId: user.id,
        eventId,
        type: 'cancel_late',
        source: 'system',
        note: '开场前 24 小时内退出',
      });
    }
    const count = await joinedCount(db, eventId);
    if (count > 0) await addSystemMessage(db, eventId, `${user.nickname} 退出了这个局`);
    // 满员成群后有人退出：回到 open 让别人补上（群聊照常）
    if (event.source !== 'matched' && event.status === 'formed' && count < event.capacity) {
      await db.update('events', eventId, { status: 'open' });
    }
    if (event.source === 'matched') {
      await db.run(
        "UPDATE intents SET status = 'cancelled', updated_at = ? WHERE event_id = ? AND user_id = ? AND status IN ('invited', 'matched')",
        now.toISOString(),
        eventId,
        user.id,
      );
    }
    if (event.creator_id && event.creator_id !== user.id) {
      await notify(db, event.creator_id, {
        type: 'leave',
        title: '有人退出了你的局',
        body: `${user.nickname} 退出了「${event.title}」，名额空出来了`,
        link: `event:${event.id}`,
      });
    }
    return { penalty };
  });
}

/**
 * 取消局（发起人 / 后台 / 到最晚退出时间没凑齐人）。
 * notifyHost：发起人也收到「局已取消」（后台取消、没凑齐人时）；skipUserIds 里的人不发；systemText 换群里的系统消息。
 */
export async function cancelEvent(db, event, { reason, byAdmin = false, skipUserIds = [], notifyHost = byAdmin, systemText = null } = {}) {
  const now = clock.iso();
  await db.update('events', event.id, { status: 'cancelled', cancel_reason: reason || null });
  await addSystemMessage(
    db,
    event.id,
    systemText ?? (byAdmin ? `这个局已被平台取消${reason ? `：${reason}` : ''}` : '发起人取消了这个局'),
  );
  const members = await db.all(
    "SELECT * FROM event_members WHERE event_id = ? AND status IN ('joined', 'applied', 'invited')",
    event.id,
  );
  for (const m of members) {
    if (!notifyHost && m.user_id === event.creator_id) continue;
    if (skipUserIds.includes(m.user_id)) continue;
    await notify(db, m.user_id, {
      type: 'event_cancelled',
      title: '局已取消',
      body: `「${event.title}」已取消${reason ? `：${reason}` : ''}。不影响你的信用。`,
      link: `event:${event.id}`,
    });
  }
  // 撮合局取消：意向退回撮合池
  await db.run(
    "UPDATE intents SET status = 'open', event_id = NULL, proposal_id = NULL, updated_at = ? WHERE event_id = ? AND status IN ('invited', 'matched')",
    now,
    event.id,
  );
  return await getEvent(db, event.id);
}

export async function cancelByHost(db, user, eventId) {
  return await db.tx(async () => {
    const event = await requireEvent(db, eventId);
    if (event.creator_id !== user.id) throw forbidden('只有发起人可以取消这个局');
    if (['cancelled', 'rejected'].includes(event.status)) throw conflict('这个局已经取消了');
    if (phaseOf(event) === 'ended') throw invalid('局已经结束了');
    const updated = await cancelEvent(db, event, { reason: '发起人取消了这个局' });
    return { ok: true, status: updated.status };
  });
}

/**
 * 每分钟：用户局 / 平台局到了最晚退出时间还没满员（还是 open）——
 * 已加入人数 ≥ minSize 就成群，不够就取消（原因「没凑齐人」）；两种情况都通知所有人。
 * 成群时还在等发起人同意的申请一并结束（不再接受报名）。
 * 早就结束了的局（老库升级、服务停了很久）只改状态，不再发通知。
 * 另外：还没到最晚退出时间、但超过组局有效期（ORGANIZE_TTL）还没凑够人的局，也会自动解散并通知。
 */
export async function processExitDeadlines(db, now = clock.now()) {
  return await db.tx(async () => {
    const result = { formed: 0, cancelled: 0 };
    const rows = await db.all("SELECT * FROM events WHERE status = 'open' AND source IN ('user', 'platform') ORDER BY start_at, id");
    for (const event of rows) {
      const enough = (await joinedCount(db, event.id)) >= Math.max(2, event.min_size);
      if (!exitDeadlinePassed(event, now)) {
        // 还没到最晚退出时间：只处理「超过组局有效期还没凑够人」→ 自动解散并通知其他人
        if (organizeExpired(event, now) && !enough) {
          await cancelEvent(db, event, { reason: '没凑齐人', notifyHost: true, systemText: '太久没凑齐人，这个局自动解散了' });
          result.cancelled++;
        }
        continue;
      }
      if (phaseOf(event, now) === 'ended') {
        const patch = enough
          ? { status: 'formed', formed_at: event.formed_at || exitDeadlineOf(event).toISOString() }
          : { status: 'cancelled', cancel_reason: '没凑齐人' };
        await db.update('events', event.id, patch);
        result[enough ? 'formed' : 'cancelled']++;
        continue;
      }
      if (enough) {
        await formEvent(db, event, { atDeadline: true });
        await closePendingApplications(db, event);
        result.formed++;
      } else {
        await cancelEvent(db, event, {
          reason: '没凑齐人',
          notifyHost: true,
          systemText: '到最晚退出时间还没凑齐人，这个局取消了',
        });
        result.cancelled++;
      }
    }
    return result;
  });
}

async function closePendingApplications(db, event) {
  for (const m of await db.all("SELECT * FROM event_members WHERE event_id = ? AND status = 'applied'", event.id)) {
    await setMember(db, event.id, m.user_id, { status: 'declined' });
    await notify(db, m.user_id, {
      type: 'application_result',
      title: '这次没能加入',
      body: `「${event.title}」已经截止报名了，去广场看看别的局吧`,
      link: `event:${event.id}`,
    });
  }
}

// ---- 报名申请 ----

async function requireHostEvent(db, user, eventId) {
  const event = await requireEvent(db, eventId);
  if (event.creator_id !== user.id) throw forbidden('只有发起人可以处理报名申请');
  return event;
}

export async function listApplications(db, user, eventId) {
  const event = await requireHostEvent(db, user, eventId);
  const rows = await db.all(
    "SELECT * FROM event_members WHERE event_id = ? AND status = 'applied' ORDER BY applied_at",
    event.id,
  );
  return {
    items: await Promise.all(rows.map(async (m) => {
      const u = await getUser(db, m.user_id);
      return { user: { ...(await userBrief(db, u)), bio: u.bio }, appliedAt: m.applied_at };
    })),
  };
}

export async function approveApplication(db, user, eventId, applicantId) {
  return await db.tx(async () => {
    const event = await requireHostEvent(db, user, eventId);
    const m = await memberRow(db, eventId, applicantId);
    if (!m || m.status !== 'applied') throw notFound('没有这条申请');
    if (event.status !== 'open') throw conflict('这个局现在不能再加人了');
    if (exitDeadlinePassed(event)) throw conflict('已经截止报名了');
    if ((await joinedCount(db, eventId)) >= event.capacity) throw conflict('已经满员了');
    const applicant = await getUser(db, applicantId);
    // 不告诉发起人对方另一个局的细节
    if (await firstOverlap(db, applicantId, event.start_at, event.duration_min, { excludeEventId: eventId })) {
      throw conflict(`${applicant.nickname} 这个时间已经有别的局了，不能通过`);
    }
    await setMember(db, eventId, applicantId, { status: 'joined', joined_at: clock.iso(), attendance: 'pending' });
    await afterJoined(db, event, applicant);
    await notify(db, applicantId, {
      type: 'application_result',
      title: '申请通过啦',
      body: `你已加入「${event.title}」`,
      link: `event:${event.id}`,
    });
    await notifyInviter(db, event, applicant, m.invited_by); // 通过分享申请、现在被通过 → 通知分享人
    const result = await joinResult(db, eventId, 'joined');
    return { ok: true, eventStatus: result.eventStatus, memberCount: result.memberCount, formed: result.formed, remaining: result.remaining };
  });
}

export async function rejectApplication(db, user, eventId, applicantId) {
  return await db.tx(async () => {
    const event = await requireHostEvent(db, user, eventId);
    const m = await memberRow(db, eventId, applicantId);
    if (!m || m.status !== 'applied') throw notFound('没有这条申请');
    await setMember(db, eventId, applicantId, { status: 'declined' });
    await notify(db, applicantId, {
      type: 'application_result',
      title: '这次没能加入',
      body: `「${event.title}」的发起人这次没有通过申请，去广场看看别的局吧`,
      link: `event:${event.id}`,
    });
    return { ok: true };
  });
}

// ---- 轻确认、到场、报平安 ----

async function requireJoined(db, user, eventId) {
  const event = await requireEvent(db, eventId);
  const mine = await memberRow(db, eventId, user.id);
  if (!mine || mine.status !== 'joined') throw forbidden('你不在这个局里');
  return { event, mine };
}

/** 轻确认：去 / 去不了；「去不了」= 退出（过了最晚退出时间同样 409） */
export async function setAttendance(db, user, eventId, going, deps) {
  const { event, mine } = await requireJoined(db, user, eventId);
  if (phaseOf(event) === 'ended') throw invalid('局已经结束了');
  if (['cancelled', 'rejected'].includes(event.status)) throw invalid('这个局已经取消了');
  if (going) {
    await db.run("UPDATE event_members SET attendance = 'yes' WHERE event_id = ? AND user_id = ?", eventId, user.id);
    return { attendance: 'yes', penalty: null };
  }
  if (mine.role === 'host') throw invalid('你是发起人，去不了的话可以取消这个局');
  const { penalty } = await leaveEvent(db, user, eventId, deps);
  return { attendance: 'no', penalty };
}

export async function arrive(db, user, eventId) {
  const { event, mine } = await requireJoined(db, user, eventId);
  if (mine.arrived_at) return { arrivedAt: mine.arrived_at };
  const now = clock.now();
  if (now.getTime() < Date.parse(event.start_at) - 2 * HOUR) throw invalid('还没到集合时间，开场前 2 小时内再点');
  if (phaseOf(event, now) === 'ended') throw invalid('局已经结束了');
  const arrivedAt = now.toISOString();
  await db.run('UPDATE event_members SET arrived_at = ?, attendance = ? WHERE event_id = ? AND user_id = ?', arrivedAt, 'yes', eventId, user.id);
  return { arrivedAt };
}

export async function reportSafe(db, user, eventId) {
  const { event, mine } = await requireJoined(db, user, eventId);
  if (mine.safe_at) return { ok: true, safeAt: mine.safe_at };
  if (clock.now().getTime() < Date.parse(event.start_at)) throw invalid('局还没开始呢');
  const safeAt = clock.iso();
  await db.run('UPDATE event_members SET safe_at = ? WHERE event_id = ? AND user_id = ?', safeAt, eventId, user.id);
  return { ok: true, safeAt };
}
