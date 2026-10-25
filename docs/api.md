# 活动搭子 · 接口与业务约定（v0.1）

这份文档是 **后端（server/）、小程序（miniprogram/）、后台管理（admin/）** 三方共同遵守的约定。改接口先改这里。

- 产品需求文档：<https://claude.ai/artifact/45SBAFipaH33D5a9kRveNu>
- 界面设计画布：<https://claude.ai/artifact/G8FdkQfAPt8d3nA8P6M3Yq>（源码副本在 `design/app/`、`design/admin/`）

---

## 1. 通用约定

| 项 | 约定 |
| --- | --- |
| 前缀 | 所有接口以 `/api` 开头，JSON 进出，UTF-8 |
| 用户鉴权 | `Authorization: Bearer <token>`，token 来自 `/api/auth/*` |
| 后台鉴权 | 同样是 Bearer，token 来自 `/api/admin/login`。用户 token 不能调后台接口，反之亦然 |
| 成功 | HTTP 200，直接返回对象；列表统一 `{ "items": [...], "nextCursor": 123 \| null }` |
| 失败 | HTTP 4xx/5xx，`{ "error": { "code": "...", "message": "中文说明" } }` |
| 错误码 | `UNAUTHORIZED` 401 · `FORBIDDEN` 403 · `NOT_FOUND` 404 · `VALIDATION` 400 · `CONFLICT` 409 · `CONTENT_BLOCKED` 422（内容审核不通过）· `RESTRICTED` 403（账号受限）· `TOO_MANY_REQUESTS` 429（后台密码输错太多次，同一 IP 15 分钟内 10 次）· `INTERNAL` 500 |
| 时间 | 时间点一律 ISO-8601 UTC 字符串，如 `2026-10-30T21:50:00.000Z`（= 北京时间 10-31 05:50）。业务时区固定 **Asia/Shanghai**：「今天」「周六」「上午」都按北京时间算。只有日期的字段用 `YYYY-MM-DD`（北京日期） |
| ID | 整数 |
| 分页 | `?limit=20&cursor=<上一页返回的 nextCursor>`；聊天用 `?after=<消息id>` 轮询 |

### 1.1 用户简要信息 `UserBrief`

```json
{ "id": 3, "nickname": "阿野", "avatarUrl": null, "avatarText": "野", "avatarColor": "stone", "creditRate": 98, "creditLevel": "good" }
```

- `avatarText`：昵称第一个字；「阿 / 小 / 老 / 大」开头时取第二个字（阿野 → 野）。没有头像时客户端用它画圆形头像。
- `avatarColor`：`ink | stone | accent | slate`，按 `id % 4` 依次取 `slate / accent / ink / stone`（1 栗子 = accent，3 阿野 = stone）。客户端映射：ink=#193543 白字，stone=#E3E8EC 黑字，accent=主题色（默认 #7CCAE3）黑字，slate=#2E4A5C 白字。
- `creditRate`：履约率，0–100 整数；`creditLevel`：`good | fair | restricted`（良好 / 一般 / 受限）。

### 1.2 分类与任务

| 分类 category | 包含的任务 task |
| --- | --- |
| `outdoor` 户外 | 看日出、爬山、徒步、骑行、随便走走 |
| `food` 吃饭 | 吃饭、早餐、夜市 |
| `coffee` 咖啡 | 咖啡、读书 |
| `game` 桌游 | 桌游 |
| `carpool` 拼车 | 拼车 |
| `other` 其他 | 其他任何任务 |

时间段 slot：`morning`（清晨/上午 05:00–12:00）、`afternoon`（12:00–18:00）、`evening`（18:00–23:00）、`allday`。看日出默认 `morning`。

---

## 2. 数据模型（SQLite，`server/data/dazi.db`）

| 表 | 关键字段 |
| --- | --- |
| `users` | id, openid(唯一), phone, nickname, avatar_url, bio, gender(`female`/`male`/`unknown`), pace(`slow`/`warm`/`open`), interests(JSON 数组), phone_verified, id_verified, status(`active`/`restricted`/`banned`), restricted_until, restricted_reason（受限 / 封禁的原因）, settings(JSON：sameSexOnly, checkInReminder, profileOpen), emergency_contact(JSON：name, phone), onboarded, created_at |
| `sessions` | token(PK), user_id, created_at, expires_at |
| `admin_sessions` | token(PK), created_at, expires_at |
| `intents` | 撮合意向：id, user_id, task, category, date_from, date_to, slot, area, size_min, size_max, relax_time, relax_size, status(`open`/`proposed`/`invited`/`matched`/`cancelled`/`expired`), event_id, created_at |
| `proposals` | 系统建议的局：id, task, category, date, slot, area, title, intent_ids(JSON), user_ids(JSON), score(0–100), reasons(JSON 数组), risks(JSON 数组), status(`pending`/`confirmed`/`rejected`/`expired`), event_id, created_at, reviewed_at, review_note |
| `events` | 局：id, title, category, task, description, start_at, duration_min, place, meeting_point, capacity, min_size, fee_type(`aa`/`free`/`host`/`split`), fee_estimate, require_approval, same_sex_only, gender, source(`matched`/`user`/`platform`), creator_id, status(`pending_review`/`inviting`/`open`/`formed`/`cancelled`/`rejected`), icebreaker_index, created_at |
| `event_members` | event_id, user_id, role(`host`/`member`), status(`invited`/`applied`/`joined`/`declined`/`left`/`removed`), attendance(`pending`/`yes`/`no`), arrived_at, safe_at, muted, last_read_message_id, invited_at, applied_at, joined_at, left_at, invite_expired（邀请到期没回应时为 1，status 仍是 declined） |
| `messages` | id, event_id, user_id(系统消息为 null), kind(`text`/`system`), text, created_at |
| `aa_items` | id, event_id, payer_id, name, amount, created_at |
| `aa_transfers` | event_id, from_user_id, to_user_id, status(`paid`/`confirmed`), updated_at（只存状态；金额每次实时计算） |
| `reviews` | event_id, reviewer_id, target_id, attendance(`on_time`/`late`/`no_show`), created_at |
| `review_feelings` | event_id, reviewer_id, feelings(JSON) |
| `credit_events` | id, user_id, event_id, type(`attended`/`late`/`cancel_late`/`no_show`/`admin_adjust`), source(`system`/`review`/`admin`), note, revoked, created_at |
| `appeals` | id, user_id, credit_event_id, text, status(`pending`/`approved`/`rejected`), admin_note, created_at, resolved_at |
| `reports` | id, reporter_id, target_type(`user`/`event`/`post`/`comment`/`message`), target_id, target_user_id, reason, detail, images(JSON), status(`pending`/`resolved`/`dismissed`), action, admin_note（只给后台看）, user_message（发给被处理的人的说明）, created_at, resolved_at |
| `blocks` | user_id, blocked_id, created_at（唯一） |
| `mutes` | user_id, muted_id（不看 TA 的动态） |
| `posts` | id, user_id, text, images(JSON), event_id, visibility(`public`/`event`), status(`pending`/`approved`/`rejected`/`deleted`), created_at |
| `post_likes` | post_id, user_id |
| `comments` | id, post_id, user_id, reply_to_user_id, text, status(`approved`/`deleted`), created_at |
| `notices` | 站内通知：id, user_id, type, title, body, link, read, created_at |
| `settings` | key, value（后台设置，如自动成局） |

---

## 3. 业务规则

### 3.1 信用

信用只看守不守约，不看话多不多。由 `credit_events`（未撤销的）实时计算：

| 情况 | 记录 |
| --- | --- |
| 准时到场 | `attended`（履约 +1） |
| 迟到 15 分钟以上 | `late`（算到场，但单独计数） |
| 开场前 **24 小时以上** 退出 / 轻确认说去不了 | **不记录**，不扣分 |
| 开场前 **24 小时内** 退出 / 轻确认说去不了 | `cancel_late`（临时鸽） |
| 没来也没说 | `no_show`（放鸽子） |
| 一个月内 `no_show` ≥ 2 次 | 账号 `restricted` 7 天（暂停撮合和报名） |

- **履约率** = (attended + late) ÷ (attended + late + cancel_late + no_show) × 100，取整；没有任何记录时为 100。
- **等级**：`restricted`（账号被限制，或一个月内放鸽子 ≥2）；`fair`（履约率 < 90，或一个月内有放鸽子）；其余 `good`。
- 用户可以对某条记录申诉（appeals），后台通过后该记录 `revoked=1`。
- 后台也可以直接撤销某条记录：通知本人「你的一条信用记录已撤销」（正文如「10月23日 桌游夜 · 新手友好 放鸽子」，link `credit`），这条记录上还在等处理的申诉自动通过，备注「后台已撤销这条记录」。
- 受限时记下原因（`restricted_reason`，后台可见）。**封禁不会被降级**：已封禁的账号不会因为后台限制、举报处理或自动受限变成 `restricted`，要先解封再处理。

### 3.2 撮合（系统先配好，后台过目确认）

1. 用户在首页说出「想做的事 + 什么时候」→ 生成 `intents`（status=open）。
2. **撮合引擎**每 5 分钟跑一次，另外在新意向提交时、后台点「立即撮合」时也会跑：
   - 只看 `open` 且未过期的意向，账号受限/封禁的人不参与。
   - 同一个 task；日期区间有重叠；时间段相同，或任一方是 `allday`，或开了「时间放宽到全天」；地区相同。
   - 互相拉黑的人不能在同一组；有人开了「只参加同性局」，整组必须同性（性别未知的人不进同性组）。
   - 按提交时间先后贪心组队，人数达到组内所有人 `size_min` 的最大值才成组，最多到 `size_max` 的最小值（开了「2–6 人都可以」按 2–6 算）。
   - 匹配度 `score`：基础 60；全组社交节奏相同 +10；时间段完全一致 +10；有共同兴趣 +最多 15；全员信用良好 +5，满分 100。
   - `reasons` 示例：「都想去看日出」「时间都在周六上午」「都偏慢热」「共同兴趣：咖啡、读书」。
   - `risks` 示例：「有 1 人信用一般」「2 位是第一次参加」「夜间局，集合点要选人多的地方」「全员陌生，建议选公共场所」。
   - 生成一条 `proposals`（status=pending），相关意向改为 `proposed`。
3. **后台过目**：确认时可以修改标题、集合时间、地点、集合点、费用方式和人数上限，然后「确认成局」→ 创建 `events`（source=matched，status=`inviting`），成员全部 `invited`，意向改为 `invited`，并给每个人发通知「撮合成功」。也可以「调整成员」或「退回」（意向回到 open）。
   - 人数要在大家约好的范围内：组的 `minSize` = 所有人 `size_min` 的最大值，`maxSize` = 所有人 `size_max` 的最小值（开了「2–6 人都可以」按 2–6 算）。确认时要求 人数 ≥ minSize、人数 ≤ 人数上限 ≤ maxSize（人数上限默认 = 人数），否则 `VALIDATION`。调整成员时可以暂时低于 minSize，只有确认时校验。局的 `min_size` = minSize。
4. **自动成局**（后台设置，默认关闭）：打开后，**每次撮合**都会检查所有待确认的建议（不只是这次新生成的），score ≥ 阈值且没有任何 risk 的直接确认；确认不了的（比如集合时间已过）留给后台。
5. **用户确认**：被邀请的人在「撮合成功」页点「加入这个局」→ `joined`；点「换一批」→ `declined`，意向回到 open 重新撮合，不扣分。
   - 全员加入 → 局 `formed`，群聊开启，发系统消息「满员啦，群已自动建好 · 第一次见面，慢慢来」。
   - 有人拒绝：撮合引擎可以从同条件的 open 意向里直接补邀（不再经过后台）。
   - 每个被邀请人的回应期限 = min(被邀请时间 + 24 小时, 开场前 12 小时)，过了仍未回应 → 视为放弃（成员 `declined` 且 `invite_expired=1`，后台显示为 `expired`；意向 `expired`）；没人在等回应时，已加入人数 ≥ `min_size` 就成局，否则等到最后一个人的期限后取消该局、意向退回 open，并通知「这次没凑齐，已帮你继续撮合」。
   - 后台可以「催一下」还没回复的人（见 5 的 `POST /api/admin/events/:id/remind`）。

### 3.3 局的状态

```
用户发起：pending_review ──(审核通过)──> open ──(满员)──> formed
                └─(驳回)──> rejected            ↑ 有人退出则回到 open
撮合产生：inviting ──(全员加入/到期且够人)──> formed ；不够人 → cancelled
平台局：  open（后台创建，source=platform）
任何时候：发起人或后台可取消 → cancelled
```

- 进行阶段不单独存，按时间算：`phase = upcoming | ongoing | ended`（开始 ≤ 现在 < 开始 + 时长 为 ongoing）。
- 撮合产生的局 **只有成员能看到**，不进广场；广场只展示 `open` 的用户局和平台局。
- 报名需要发起人同意的局，报名后是 `applied`，发起人同意才 `joined`。
- 满员（joined 人数 = capacity）自动变 `formed`；群聊在 formed 后开启（用户局在第一个人加入后就开启）。

### 3.4 提醒（定时任务每分钟检查一次）

| 时机 | 动作 |
| --- | --- |
| 开场前 48 小时内，出席待确认 | 生成「需要你处理 · 还去吗？」（inbox actions），只生成一次通知 |
| 局结束后 7 天内，还没评价 | 生成「去评价」（inbox actions） |
| 局结束后，开了「报平安提醒」 | 通知「到家了吗？点一下报平安」；1 小时没回应只记日志（短信通知紧急联系人留作后续） |

### 3.5 互评与信用结算

- 局结束后成员互评每个人：`on_time` / `late` / `no_show`，外加整体感受（很放松、不尴尬、下次还来、节奏刚好）。
- 每个人的结果按 **多数票**（平票按有利于被评价者），点过「我到了」的人默认准时。
- 每次有人提交评价就重算该局所有人的结果，以 `source=review` 写入 / 覆盖 credit_events（同一人同一局只保留一条）。

### 3.6 内容审核（`server/src/moderation.js`）

关键词 + 正则，返回 `{ ok, reasons[] }`：

- **联系方式**：手机号 `1[3-9]\d{9}`、微信/vx/v信/wx/QQ + 号码、网址。
- **广告**：代购、刷单、兼职、加盟、推广、返利、贷款、投资理财……
- **擦边/违法**：约炮、一夜情、援交、包养、陪睡、裸聊、色情、赌博、博彩、下注……

| 内容 | 命中后 |
| --- | --- |
| 群聊消息、评论 | 直接拒绝，返回 `CONTENT_BLOCKED`，提示「群聊里不能发联系方式或广告」 |
| 动态、用户发起的局 | 进入后台审核（status=`pending` / `pending_review`），用户看到「已发布，正在审核」 |
| 昵称、简介 | 拒绝保存 |

配置了微信 `WX_APPID/WX_SECRET` 时，可选再调用微信内容安全接口 `msgSecCheck`（后续接入，先留钩子）。

### 3.7 AA 记账

平台不经手钱，只算账：总额 = 所有记账之和；每人 = 总额 ÷ 当前 joined 人数（保留两位小数）；按「欠钱最多的人先还给垫钱最多的人」贪心生成转账清单。付款方点「我已转账」= `paid`，收款方点「确认收到」= `confirmed`。

### 3.8 举报处理（后台）

| action | 对被举报的人 | 给举报人的结果通知 |
| --- | --- | --- |
| `dismiss` | 不处理 | 「经核实暂未发现违规，感谢你的反馈」 |
| `warn` | 通知「你收到一次提醒」，正文默认「有人反馈你的言行让人不舒服，请遵守社区公约。再次违反会被限制使用。」 | 「已对对方进行警告」 |
| `delete_content` | 删掉内容（动态 / 评论 → `deleted`；群聊消息 → 换成系统提示；局 → 取消；用户 → 清空简介），并通知作者「你的一条动态（评论 / 群聊消息）因违反社区公约被删除」「你发起的局「…」因违反社区公约被取消」「你的个人简介因违反社区公约被清空」；内容本来就不在了则不通知 | 「相关内容已删除」 |
| `restrict_7d` | 受限 7 天，通知「账号暂停撮合和报名 7 天」，正文默认「原因：被举报并核实违反社区公约。到期后自动恢复。」 | 「对方已被限制使用」 |
| `ban` | 封号（清掉登录会话，撤回 open / proposed 意向），通知「账号已被封禁」 | 「对方已被封禁」 |

- `note`：只存进 `admin_note`，任何通知里都不会出现。
- `message`（可选，≤ 200 字）：写给被处理的人。warn / restrict_7d / ban 时替换上面的默认正文；delete_content 时作为删除通知的正文。不能带联系方式（手机号、微信 / QQ 号、网址），否则 `CONTENT_BLOCKED`；点名违规内容（「请不要推销代购」）没关系。
- 已封禁的账号：`restrict_7d` → `CONFLICT`「账号已封禁，先解封再处理」（整条处理不生效）；`ban` 不重复处理，举报照常结案。

---

## 4. 小程序接口

### 4.1 登录与资料

| 接口 | 说明 |
| --- | --- |
| `POST /api/auth/login` `{code}` | 微信 `wx.login` 的 code 换 openid。没配 `WX_APPID` 时进入开发模式：openid = `dev_` + code。返回 `{token, user: Me, isNew}` |
| `POST /api/auth/dev-login` `{userId?}` | 仅开发环境（`NODE_ENV != production`）。不传 userId 默认登录演示账号「栗子」。返回同上 |
| `POST /api/auth/phone` `{code}` | 手机号快速验证组件的 code 换手机号（开发模式随机生成）。返回 `{phoneMasked, phoneVerified: true}` |
| `GET /api/me` | 返回 `Me` |
| `PUT /api/me` | `{nickname?, bio?, avatarUrl?, gender?, pace?, interests?, onboarded?}` → `Me`；昵称、简介要过内容审核 |
| `GET /api/me/safety` · `PUT /api/me/safety` | `{sameSexOnly, checkInReminder, profileOpen, emergencyContact: {name, phone}\|null}`；返回时手机号打码 `phoneMasked`，并附 `blocked: UserBrief[]` |
| `GET /api/me/credit-events` | 我的信用记录列表 |
| `POST /api/credit-events/:id/appeal` `{text}` | 申诉 |

`Me`：

```json
{
  "id": 1, "nickname": "栗子", "avatarUrl": null, "avatarText": "栗", "avatarColor": "accent",
  "bio": "慢热，但很靠谱。", "gender": "female", "pace": "slow", "interests": ["看日出", "咖啡"],
  "phoneVerified": true, "idVerified": false, "status": "active", "onboarded": true,
  "credit": { "rate": 100, "level": "good", "attended": 6, "late": 0, "cancelLate": 0, "noShow": 0, "eventsCount": 6 },
  "ongoingCount": 2
}
```

### 4.2 他人主页、拉黑、不看

| 接口 | 说明 |
| --- | --- |
| `GET /api/users/:id` | `{user: UserBrief + {bio, interests, phoneVerified, idVerified}, credit: {...同 Me.credit}, commonPoints: ["都喜欢看日出"], recentEvents: [{id, title, dateLabel, sharedWithMe, ended}], blockedByMe, profileHidden}`。对方关了「同局的人可以看我的主页」且不同局时，`profileHidden=true`，只返回昵称和履约率 |
| `POST /api/blocks/:userId` · `DELETE /api/blocks/:userId` | 拉黑 / 移出黑名单 |
| `POST /api/mutes/:userId` · `DELETE /api/mutes/:userId` | 不看 TA 的动态 / 恢复 |

### 4.3 撮合意向与撮合结果

| 接口 | 说明 |
| --- | --- |
| `POST /api/intents` | `{task, when: "today"\|"tomorrow"\|"weekend"\|"YYYY-MM-DD", slot?, area?, sizeMin?, sizeMax?, label?, relaxTime?, relaxSize?}` → `Intent`（提交后立刻触发一次撮合）。`label` 是展示名，如「洱海边骑行」 |
| `GET /api/intents/mine` | `{items: Intent[]}`（open / proposed / invited 状态） |
| `GET /api/intents/:id` | `Intent` + `{similarCount, needMore, submittedAt}`。similarCount = 其他条件相同的 open 意向数 |
| `PUT /api/intents/:id` | `{relaxTime?, relaxSize?}`（也接受 PATCH；小程序的 `wx.request` 不支持 PATCH，所以用 PUT） |
| `DELETE /api/intents/:id` | 取消意向 |
| `GET /api/matches/:eventId` | 被邀请人看撮合结果：`{event: EventDetail, members: UserBrief[], commonPoints: [], myStatus, joinedCount, deadline}` |
| `POST /api/matches/:eventId/accept` | 加入这个局 → `{myStatus: "joined", eventStatus}` |
| `POST /api/matches/:eventId/decline` | 换一批 → `{ok: true, intentId}`（意向回到 open） |

`Intent`：

```json
{ "id": 7, "task": "骑行", "category": "outdoor", "title": "周日 · 洱海边骑行", "dateFrom": "2026-11-01", "dateTo": "2026-11-01",
  "slot": "afternoon", "slotLabel": "下午", "area": "古城", "sizeMin": 3, "sizeMax": 5, "relaxTime": false, "relaxSize": false,
  "status": "open", "eventId": null, "createdAt": "..." }
```

### 4.4 局

| 接口 | 说明 |
| --- | --- |
| `GET /api/events` | 广场：`?category=outdoor&limit=&cursor=` → `{items: EventCard[], nextCursor}`，按开始时间升序，只含未开始的 |
| `GET /api/events/:id` | `EventDetail`（撮合局只有成员能看） |
| `POST /api/events` | 发起局 `{title, category, task?, startAt, durationMin?, place, meetingPoint?, capacity, feeType, feeEstimate?, requireApproval, sameSexOnly, description?}` → `EventDetail`（过审核则 open，否则 pending_review） |
| `POST /api/events/:id/join` | → `{myStatus: "joined"\|"applied", eventStatus}` |
| `POST /api/events/:id/leave` | → `{penalty: "cancel_late"\|null}` |
| `POST /api/events/:id/cancel` | 发起人取消 |
| `GET /api/events/:id/applications` | 发起人看报名申请 |
| `POST /api/events/:id/applications/:userId/approve` · `/reject` | 发起人处理申请 |
| `POST /api/events/:id/attendance` `{going}` | 轻确认：去 / 去不了（去不了按 3.1 规则可能记临时鸽）→ `{attendance, penalty}` |
| `POST /api/events/:id/arrive` | 我到了 → `{arrivedAt}` |
| `POST /api/events/:id/safe` | 报平安 |
| `GET /api/events/mine` | `?tab=ongoing\|ended\|created` → `{items: MyEventCard[]}` |
| `GET /api/search` `?q=` | `{items: EventCard[]}`（标题、地点、任务模糊匹配） |
| `GET /api/search/hot` | `{terms: ["看日出", ...]}` |

`EventCard`：

```json
{ "id": 1, "title": "周六清晨 · 苍山看日出", "category": "outdoor", "task": "看日出",
  "startAt": "2026-10-30T21:50:00.000Z", "dateLabel": "周六 05:50", "place": "大理古城南门",
  "capacity": 5, "memberCount": 4, "membersPreview": [UserBrief, UserBrief, UserBrief],
  "feeLabel": "AA 约 ¥30", "source": "matched", "status": "formed", "phase": "upcoming" }
```

`EventDetail` = `EventCard` + `{description, meetingPoint, durationMin, feeType, feeEstimate, requireApproval, sameSexOnly, host: UserBrief|null, members: (UserBrief & {role})[], myStatus, myAttendance, myArrivedAt, canJoin, isFull, chatOpen}`

`MyEventCard` = `EventCard` + `{myStatus, needReview, reviewed, intentId}`（撮合中的意向也以卡片形式出现在「进行中」，`id` 为 null、带 `intentId`）。

### 4.5 群聊、局信息、AA

| 接口 | 说明 |
| --- | --- |
| `GET /api/events/:id/messages` | `?after=<id>` → `{items: Message[], icebreaker: {index, total, question}}`，只有 joined 成员能看，调用即视为已读 |
| `POST /api/events/:id/messages` `{text}` | → `Message`（审核不过返回 CONTENT_BLOCKED） |
| `POST /api/events/:id/icebreaker/next` | 换一个破冰话题（全组共享）→ `{index, total, question}` |
| `GET /api/events/:id/info` | `{event: EventDetail, members: (UserBrief & {role, isMe})[], aa: {each, openTransfers}, muted}` |
| `PUT /api/events/:id/mute` `{muted}` | 消息免打扰 |
| `GET /api/events/:id/aa` | `{items: [{id, name, payer: UserBrief, amount, mine}], total, each, memberCount, transfers: [{from: UserBrief, to: UserBrief, amount, status: "pending"\|"paid"\|"confirmed", role: "from"\|"to"\|null}]}` |
| `POST /api/events/:id/aa/items` `{name, amount}` | 记一笔（我垫付）→ 同 GET |
| `DELETE /api/events/:id/aa/items/:itemId` | 只能删自己记的 |
| `POST /api/events/:id/aa/paid` `{toUserId}` | 我已转账 → 同 GET |
| `POST /api/events/:id/aa/confirm` `{fromUserId}` | 确认收到 → 同 GET |

`Message`：`{id, kind: "text"|"system", user: UserBrief|null, text, createdAt, mine}`

破冰话题库（服务端常量，顺序轮换）：来大理以后，你最喜欢的一个瞬间是什么？ / 如果只能带一样东西上山，你会带什么？ / 最近一次觉得「刚刚好」，是什么时候？ / 有没有一首歌，一听就想到旅行？ / 你最近在读或在看什么？

### 4.6 互评

| 接口 | 说明 |
| --- | --- |
| `GET /api/events/:id/review` | `{event: EventCard, people: UserBrief[], submitted}` |
| `POST /api/events/:id/reviews` | `{attendance: {"<userId>": "on_time"\|"late"\|"no_show"}, feelings: []}` → `{ok: true}` |

### 4.7 动态（公共朋友圈）

| 接口 | 说明 |
| --- | --- |
| `GET /api/posts` | `?cursor=` → `{items: Post[], nextCursor}`（已通过的；排除拉黑、不看的人；`visibility=event` 的只给同局的人） |
| `GET /api/posts/:id` | `Post` + `{comments: Comment[]}` |
| `POST /api/posts` | `{text, images: [], eventId?, visibility}` → `Post`（`status` 可能是 pending） |
| `DELETE /api/posts/:id` | 作者删除 |
| `POST /api/posts/:id/like` · `DELETE /api/posts/:id/like` | → `{liked, likeCount}` |
| `POST /api/posts/:id/comments` `{text, replyToUserId?}` | → `Comment` |

`Post`：`{id, author: UserBrief, text, images: [url], event: {id, title}|null, likeCount, commentCount, liked, mine, status, createdAt}`
`Comment`：`{id, author: UserBrief, text, replyTo: {id, nickname}|null, createdAt, mine}`

### 4.8 举报、上传、消息中心

| 接口 | 说明 |
| --- | --- |
| `POST /api/reports` | `{targetType, targetId, reason, detail?, images?, alsoBlock?}` → `{id, status: "pending"}` |
| `POST /api/upload` | multipart，字段名 `file`，只收图片，≤ 5MB → `{url}` |
| `GET /api/inbox` | `{actions: [...], chats: [...], notices: [...]}`（见下） |
| `POST /api/notices/:id/read` · `POST /api/notices/read-all` | 标记一条 / 全部已读 |

```json
{
  "actions": [
    { "type": "match", "eventId": 1, "title": "撮合成功：周六清晨一起看日出", "deadline": "..." },
    { "type": "attendance", "eventId": 1, "title": "周六 05:50 · 苍山看日出", "startAt": "..." },
    { "type": "review", "eventId": 2, "title": "「桌游夜」结束啦" }
  ],
  "chats": [ { "eventId": 1, "title": "苍山看日出 · 5 人", "category": "outdoor", "lastMessage": { "nickname": "阿野", "text": "...", "createdAt": "..." }, "unread": 3 } ],
  "notices": [ { "id": 9, "type": "report_result", "title": "你的举报已处理", "body": "对方已被限制使用", "link": null, "read": false, "createdAt": "..." } ]
}
```

通知的 `link` 告诉客户端点了去哪：`match:<eventId>` 撮合成功页、`event:<eventId>` 局详情、`chat:<eventId>` 群聊、`review:<eventId>` 互评、`post:<postId>` 动态详情、`credit` 我的信用记录，`null` 不跳转。

通知的 `type`：`match` 撮合成功 · `match_reminder` 后台催回复 · `formed` 成局 · `match_failed` 没凑齐 · `attendance` 轻确认 · `review` 去评价 · `safe` 报平安 · `event_cancelled` · `event_approved` · `event_rejected` · `application` · `application_result` · `join` · `leave` · `post_approved` · `post_rejected` · `comment` · `aa_paid` · `aa_confirmed` · `report_result` · `warning` · `content_deleted` 内容被删 · `restricted` · `unrestricted` · `banned` · `unbanned` · `appeal_result` · `credit_revoked` 信用记录被撤销。客户端不认识的 type 按普通通知显示即可。

### 4.9 开发辅助接口（仅 `NODE_ENV` 不是 `production` 时开放）

演示登录见 4.1 的 `POST /api/auth/dev-login`。

| 接口 | 说明 |
| --- | --- |
| `POST /api/dev/clock` | `{now}` / `{advanceMinutes}` / `{reset: true}` 让服务端「穿越时间」，用来演示提醒、邀请到期、互评 |
| `POST /api/dev/tick` | `{match?}` 立刻跑一遍定时任务（提醒、邀请到期）；`match: true` 时连撮合一起跑 |

---

## 5. 后台接口（`/api/admin/*`）

列表的 `?status=` / `?level=` / `?source=` 只接受下面列出的值，其他值返回 `VALIDATION`。

| 接口 | 说明 |
| --- | --- |
| `POST /api/admin/login` `{password}` | 密码来自环境变量 `ADMIN_PASSWORD`（开发默认 `admin123`）→ `{token}`。同一 IP 15 分钟内输错 10 次 → `TOO_MANY_REQUESTS` |
| `GET /api/admin/stats` | `{today: {newUsers, newIntents, formed, pendingProposals, pendingReports, pendingPosts, pendingEvents}, yesterday: {newUsers, newIntents, formed}, week: {attendanceRate, noShowCount, eventsEnded}, prevWeek: {attendanceRate, noShowCount}, series: [{date, formed, newUsers}]}`。today / yesterday / series（近 7 天，含今天）按北京日期；`week` 是**滚动的最近 7×24 小时**（履约率和放鸽子次数按信用记录的时间算，eventsEnded = 这段时间里结束的局），`prevWeek` 是再往前的 7×24 小时，用来算「比上周」 |
| `GET /api/admin/proposals` | `?status=pending`（默认，按匹配度降序）\|`confirmed`\|`rejected`\|`expired`（这三种按处理时间倒序，最多 200 条）\|`all`（id 倒序，最多 200 条）→ `{items: Proposal[]}` |
| `POST /api/admin/proposals/:id/confirm` | `{title?, startAt?, durationMin?, place?, meetingPoint?, feeType?, feeEstimate?, capacity?}` → `{eventId}`。人数 < `minSize`、`capacity` < 人数或 > `maxSize` → `VALIDATION`（`capacity` 默认 = 人数）；组里有人互相拉黑、或剩下不到 2 人 → `CONFLICT` |
| `POST /api/admin/proposals/:id/reject` | `{note?}` → `{ok: true}`。意向回到 open；同一组人同一天不会再被原样推荐 |
| `POST /api/admin/proposals/:id/members` | `{remove: [userId], add: [intentId]}`（add 只能是 open 的意向）→ 更新后的 `Proposal`（重新计算 score / reasons / risks / minSize / maxSize）。可以调到低于 minSize（界面提示即可），只有确认时校验；至少保留 2 人 |
| `GET /api/admin/intents` | `?status=open`（默认，撮合池里还在等的）\|`proposed`（已进建议局、等后台确认的）\|`invited`\|`matched`\|`cancelled`\|`expired`（按提交时间升序，最多 300 条）\|`all`（id 倒序，最多 300 条）→ `{items: PoolIntent[]}` |
| `POST /api/admin/match/run` | 立即撮合 → `{created, autoConfirmed, backfilled, expired}`：新生成的建议数、自动确认的建议数（3.2 第 4 条）、给撮合局补邀的人数、这次标记过期的意向数 |
| `GET /api/admin/settings` · `PUT /api/admin/settings` | `{autoConfirm: {enabled, threshold}}`（默认关闭、阈值 90）。PUT 可以只传其中一项 |
| `GET /api/admin/events` | `?status=`\|`pending_review`\|`inviting`\|`open`\|`formed`\|`ended`\|`cancelled`\|`rejected` `&source=`\|`matched`\|`user`\|`platform` `&q=`（标题 / 地点 / 任务）→ `{items: AdminEventCard[]}`，按开始时间倒序，最多 300 条。`open` / `formed` 只含还没结束的；`ended` = 已经结束的 open / formed 局（开始时间 + 时长 ≤ 现在） |
| `GET /api/admin/events/:id` | `{event: EventDetail + AdminEventCard 的补充字段, members: AdminMember[], messages: Message[]（最近 50 条，后台查看时 mine 恒为 false）, aa: {total, each, itemCount}, reports: AdminReport[]}` |
| `POST /api/admin/events` | 发起平台局（字段同用户发起；同性局要带 `gender: "female"\|"male"`）→ `{eventId}` |
| `POST /api/admin/events/:id/approve` · `/reject` `{note?}` | 审核用户发起的局（驳回时 note 会发给发起人）→ `{ok, status}`；不在 pending_review → `CONFLICT` |
| `POST /api/admin/events/:id/cancel` `{reason}` | 取消局，通知所有成员 → `{ok, status}`；已取消 / 被驳回 / 已结束 → `CONFLICT` |
| `POST /api/admin/events/:id/remind` | 催一下：给还没回复（且还没过期）的被邀请人发通知「还没回复：<局标题>，<期限，如「明天 10:00」> 前点「加入」」（type `match_reminder`，link `match:<id>`）→ `{reminded: n}`；局不是邀请中的撮合局 → `CONFLICT` |
| `GET /api/admin/reports` | `?status=pending`（默认）\|`resolved`\|`dismissed`\|`all` → `{items: AdminReport[]}`（id 倒序，最多 200 条） |
| `POST /api/admin/reports/:id/resolve` | `{action: "dismiss"\|"warn"\|"delete_content"\|"restrict_7d"\|"ban", note?, message?}` → `AdminReport`。规则见 3.8：`note` 只给后台看；`message`（≤ 200 字，带联系方式 → `CONTENT_BLOCKED`）发给被处理的人。同时给举报人发处理结果通知；已处理过 → `CONFLICT` |
| `GET /api/admin/posts` | `?status=pending`（默认）\|`approved`\|`rejected`\|`deleted`\|`all` → `{items: [Post + {flags}]}`（flags = 内容审核命中的原因） |
| `POST /api/admin/posts/:id/approve` · `/reject` | `{note?}`（驳回时发给作者）→ `Post + {flags}`；不在 pending → `CONFLICT` |
| `GET /api/admin/users` | `?q=`（昵称 / 手机号 / id）`&level=good`\|`fair`\|`restricted`\|`banned` `&status=active`\|`restricted`\|`banned` → `{items: AdminUser[]}`，id 倒序，最多 500 条。`level=banned` = 被封禁的人；good / fair / restricted 按信用等级，不含被封禁的人 |
| `GET /api/admin/users/:id` | `{user: AdminUser + {bio, gender, pace, interests, phoneVerified, idVerified, restrictedUntil, onboarded, settings}, credit, creditEvents: [], reportsAgainst: AdminReport[], appeals: AdminAppeal[], events: [EventCard + {memberStatus, role}]}` |
| `POST /api/admin/users/:id/credit` | `{type, note}` 手动加一条记录；或 `{revokeId}` 撤销某条记录（3.1：通知本人，并自动通过这条记录上待处理的申诉；已撤销的不重复通知）→ `{ok, credit, creditEvents}` |
| `POST /api/admin/users/:id/restrict` `{days, reason}` · `/ban` `{reason}` · `/unban` | 账号处理 → `{ok, user: AdminUser}`。`reason` 会告诉用户，也存为 `restrictedReason`。已封禁的账号：restrict → `CONFLICT`「账号已封禁，先解封再处理」，ban → `CONFLICT`。unban 同时解除限制和封禁 |
| `GET /api/admin/appeals` · `POST /api/admin/appeals/:id/resolve` `{approve, note?}` | 申诉：`?status=pending`（默认）\|`approved`\|`rejected`\|`all` → `{items: AdminAppeal[]}`；resolve → `AdminAppeal`，note 会附在给申诉人的结果通知里；通过 = 该记录 `revoked=1` |

`Proposal`：

```json
{ "id": 2, "title": "周日上午 · 一起爬山", "task": "爬山", "category": "outdoor", "date": "2026-11-01", "dateLabel": "周日",
  "slot": "morning", "slotLabel": "上午", "area": "古城", "score": 80,
  "reasons": ["都想去爬山", "时间都在周日上午", "共同兴趣：爬山", "全员信用良好"], "risks": ["1 位是第一次参加"],
  "minSize": 3, "maxSize": 5, "status": "pending", "eventId": null, "createdAt": "...", "reviewedAt": null, "reviewNote": null,
  "members": [ { "user": UserBrief, "gender": "male", "pace": "slow", "isNew": false, "intentId": 8, "intentCreatedAt": "..." } ] }
```

- `minSize` / `maxSize`：组里所有人约好的人数范围（3.2 第 3 条）。人数比 minSize 少时界面要提示「还差 n 人」，确认会被拒。

`PoolIntent`：`{id, user: UserBrief, task, title, dateFrom, dateTo, slot, slotLabel, area, sizeMin, sizeMax, relaxTime, relaxSize, status, eventId, proposalId, isNew, createdAt, waitingHours}`。`isNew` = 这个人还没有到场记录（第一次参加）；`proposalId` / `eventId` = 所在的建议局 / 撮合局；`waitingHours` = 已经等了几个小时（取整）。

`AdminEventCard` = `EventCard` + `{creator: UserBrief|null, createdAt, reportCount, flags, reviewNote, cancelReason, formedAt, joinedCount, invitedCount, inviteDeadline}`

- `flags`：内容审核命中的原因（待审核的用户局看这个）。
- `joinedCount` 已加入人数；`invitedCount` 还没回复的被邀请人数；`inviteDeadline` 只在撮合局 `inviting` 时有值 = 最后一个被邀请人的回应期限（到点后够 min_size 成局，不够取消），其他情况为 null。

`AdminMember` = `UserBrief` + `{role, status, inviteDeadline, attendance, arrivedAt, safeAt, invitedAt, joinedAt, leftAt}`

- `status`：`invited`（还没回复）\| `joined` \| `declined`（点了换一批）\| `expired`（邀请到期没回应；用户那边看到的仍是 declined）\| `applied` \| `left` \| `removed`。
- `inviteDeadline`：这个人的回应期限 = min(被邀请时间 + 24 小时, 开场前 12 小时)；不是撮合局邀请来的为 null。

`AdminReport`：

```json
{ "id": 3, "reason": "推销 / 拉人头", "detail": "在夜市局的群里拉大家去他朋友的店", "images": [],
  "targetType": "message", "targetId": 41, "preview": "被举报内容摘要（≤120 字）",
  "context": { "eventId": 12, "eventTitle": "人民路夜市 · 边走边吃" },
  "targetUser": UserBrief & { "reportCount": 3, "status": "restricted" },
  "reporterAnonId": "用户#3a9", "status": "pending", "action": null, "adminNote": null, "message": null,
  "createdAt": "...", "resolvedAt": null }
```

- `context`：message → `{eventId, eventTitle}`；comment → `{postId, postPreview}`（动态前 40 字）；post → `{postId}`；event → `{eventId, eventTitle}`；user → `null`。内容已不存在时为 null。
- `targetUser` = `UserBrief` + `{reportCount, status}`，`status` 是当前生效的状态（限制到期后就是 active）；没有对应用户时为 null。
- `adminNote` = 处理时填的 note（只有后台能看到）；`message` = 发给被处理的人的说明（没填为 null）。
- 举报人对后台也匿名，显示为「用户#3a9」这种编号。

`AdminUser` = `UserBrief` + `{phoneMasked, status, restrictedReason, credit, createdAt, reportCount}`：`status` 是当前生效的状态；`restrictedReason` = 受限 / 封禁的原因（处理时告诉用户的那句；举报处理没填 message 时是「被举报并核实违反社区公约」/「严重违反社区公约」，自动受限是「一个月内放鸽子 2 次」），状态为 active 时为 null。

`AdminAppeal`：`{id, user: UserBrief, creditEvent: {id, type, typeLabel, source, note, eventId, eventTitle, revoked, createdAt}, text, evidence: [{text, createdAt, hoursBeforeStart}], status, adminNote, createdAt, resolvedAt}`

- `evidence`：申诉人自己在那条记录对应的局里、开场前 72 小时到开场之间发过的群聊消息（比如「发烧了去不了」），`hoursBeforeStart` 保留一位小数；记录不关联局时为 `[]`。

---

## 6. 演示数据（`npm run seed`）

与设计稿一致：用户 栗子（我，演示登录账号）、阿野、小满、木木、七七、南风、大鹏；
局：周六清晨 · 苍山看日出（撮合局，已成局，含群聊和 AA）、桌游夜 · 新手友好（已结束，待评价）、安静读书局 · 不用聊天 / 喜洲稻田边吃早餐 / 拼车去双廊 / 洱海西岸骑行（广场上的 open 局）；
意向：栗子的「周日 · 洱海边骑行」（open）、另外几条可被撮合的意向，以及 1 条待后台确认的建议局；
动态 2 条 + 评论 5 条；待处理举报 2 条；1 条申诉。
