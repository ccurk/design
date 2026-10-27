# 活动搭子 · 接口与业务约定（v0.3）

这份文档是 **后端（server/）、小程序（miniprogram/）、后台管理（admin/）** 三方共同遵守的约定。改接口先改这里。各版本改了什么见文末「版本记录」。

- 产品需求文档：<https://claude.ai/artifact/45SBAFipaH33D5a9kRveNu>
- 界面设计画布：<https://claude.ai/artifact/G8FdkQfAPt8d3nA8P6M3Yq>（源码副本在 `design/app/`、`design/admin/`；插画在 `design/illustrations/`）

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
| 时间 | 时间点一律 ISO-8601 UTC 字符串，如 `2026-10-30T21:50:00.000Z`（= 北京时间 10-31 05:50）。业务时区固定 **Asia/Shanghai**：「今天」「周六」「上午」都按北京时间算。只有日期的字段用 `YYYY-MM-DD`（北京日期）；一天里的时刻用 `"HH:MM"`（北京时间） |
| 图片 | 数据库里只存相对路径 `/uploads/<文件>`；接口返回时一律拼成绝对地址（`PUBLIC_BASE_URL` + 路径）。客户端提交时绝对 / 相对地址都接受：路径是 `/uploads/<文件>` 的就当作本站上传的图片（开发时手机和电脑访问后端的地址常常不一样，所以不比较域名）；老数据里存的绝对地址也换成当前的 `PUBLIC_BASE_URL` 返回 |
| ID | 整数 |
| 分页 | `?limit=20&cursor=<上一页返回的 nextCursor>`；聊天用 `?after=<消息id>` 轮询 |

### 1.1 用户简要信息 `UserBrief`

```json
{ "id": 3, "nickname": "阿野", "avatarUrl": null, "avatarText": "野", "avatarColor": "stone", "creditRate": 98, "creditLevel": "good" }
```

- `avatarUrl`：本站上传的头像是绝对地址；微信等外站头像原样返回；没有头像为 null。
- `avatarText`：昵称第一个字；「阿 / 小 / 老 / 大」开头时取第二个字（阿野 → 野）。没有头像时客户端用它画圆形头像。
- `avatarColor`：`ink | stone | accent | slate`，按 `id % 4` 依次取 `slate / accent / ink / stone`（1 栗子 = accent，3 阿野 = stone）。客户端映射：ink=#193543 白字，stone=#E3E8EC 黑字，accent=主题色（默认 #7CCAE3）黑字，slate=#2E4A5C 白字。
- `creditRate`：履约率，0–100 整数；`creditLevel`：`good | fair | restricted`（良好 / 一般 / 受限）。

### 1.2 标签、分类与时间段

「想做的事」（意向的 `task`）和局的「标签」（`tag`）是同一套**自由标签**：可以从热门标签里选，也可以自己写。

- **规则**：NFKC → 去首尾空格 → 合并连续空白；1–8 个字（按字符数）；只允许文字、数字、空格和 `·` `-` `_`；不合格 → `VALIDATION`（如「标签最多 8 个字」「想做的事只能用文字、数字、空格和 ·-_」）。要过内容审核（`checkText`），命中 → 422 `CONTENT_BLOCKED`「这个标签不能用」。
- **key**：规范化后的名字再把拉丁字母转小写。撮合、`?tag=` 筛选、重复意向检查都按 key 比较，所以「KTV」和「ktv」是同一个标签。
- **用户自己加的标签**：标签表里没有的标签，第一次被用到（提交意向、发起局）时自动建一条（不是热门），之后每次用到都更新 `last_used_at`。保存时用标签表里的写法（输入 ktv、表里是 KTV 时存 KTV）。
- 每个标签有一个**分类** `category`（广场兜底和统计用）和一张**插画** `cover`（插画 key，没设时按分类给默认插画）。新标签的分类：发起局时带了旧字段 `category` 就用它，否则按下表的默认标签推，都对不上算 `other`。
- 标签表为空时（新库、老库第一次升级到 v0.3）启动会写入下面 13 个默认标签；老库同时按已有的意向和局补上 `last_used_at`。热门列表和顺序由后台维护（见 5 的标签接口）。

| 分类 category | 默认标签（★ = 默认热门）及其插画 | 没设插画时的默认插画 |
| --- | --- | --- |
| `outdoor` 户外 | ★看日出 sunrise、★爬山 mountain、★骑行 cycling、★随便走走 oldtown、★拍照 lake、徒步 mountain | `mountain` |
| `food` 吃饭 | ★吃饭 food、早餐 food、夜市 food | `food` |
| `coffee` 咖啡 | ★咖啡 coffee、★读书 reading | `coffee` |
| `game` 桌游 | ★桌游 boardgame | `boardgame` |
| `carpool` 拼车 | ★拼车 carpool | `carpool` |
| `other` 其他 | 对不上的自定义标签 | `oldtown` |

默认热门的顺序：看日出、爬山、骑行、咖啡、吃饭、桌游、拼车、随便走走、读书、拍照。

插画 key（`design/illustrations/<key>.svg`，扁平风格，3:2）：`sunrise` 苍山日出 · `mountain` 山路徒步 · `cycling` 洱海骑行 · `lake` 洱海 · `coffee` 咖啡 · `reading` 读书 · `food` 吃饭 · `boardgame` 桌游 · `carpool` 拼车 · `oldtown` 古城。局没有图片时客户端用它的 `coverKey` 对应的插画当封面。

**时间段与时间窗**：每个意向有一个时间窗（北京时间）。

| 意向怎么写 | 时间窗 | `timeLabel` |
| --- | --- | --- |
| `slot: "morning"` | 05:00–12:00 | 上午（看日出、早餐显示「清晨」） |
| `slot: "afternoon"` | 12:00–18:00 | 下午 |
| `slot: "evening"` | 18:00–23:00 | 晚上 |
| `slot: "allday"` | 05:00–23:00 | 全天 |
| `timeFrom` + `timeTo`（自定义时间段，精确到分钟） | 如 14:00–17:00。要求 05:00 ≤ 开始 < 结束 ≤ 23:59，至少 60 分钟 | 「14:00–17:00」 |

- 开了「时间放宽到全天」：时间窗扩到至少 05:00–23:00（自定义时间段取两者的并），`timeLabel` 不变。
- 不传 slot 也不传时间段：按任务给默认时间段（看日出 / 早餐 → morning，夜市 → evening，其他 → allday）。
- 用自定义时间段时意向的 `slot` 是按开始时刻推出的时间段（< 12:00 上午、< 18:00 下午、其余晚上），只用来起标题，展示请用 `timeLabel`。

---

## 2. 数据模型（SQLite，`server/data/dazi.db`）

| 表 | 关键字段 |
| --- | --- |
| `users` | id, openid(唯一), phone, nickname, avatar_url（本站上传的存相对路径）, bio, gender(`female`/`male`/`unknown`), pace(`slow`/`warm`/`open`), interests(JSON 数组), phone_verified, id_verified, status(`active`/`restricted`/`banned`), restricted_until, restricted_reason（受限 / 封禁的原因）, settings(JSON：sameSexOnly, checkInReminder, profileOpen), emergency_contact(JSON：name, phone), onboarded, created_at |
| `sessions` | token(PK), user_id, created_at, expires_at |
| `admin_sessions` | token(PK), created_at, expires_at |
| `intents` | 撮合意向：id, user_id, task（标签名）, category, label, date_from, date_to, slot, time_from, time_to（自定义时间段 `"HH:MM"`，不是自定义时为 null）, area, size_min, size_max, relax_time, relax_size, status(`open`/`proposed`/`invited`/`matched`/`cancelled`/`expired`), event_id, proposal_id, created_at |
| `proposals` | 系统建议的局：id, task, category, date, slot, area, title, intent_ids(JSON), user_ids(JSON), score(0–100), reasons(JSON 数组), risks(JSON 数组), status(`pending`/`confirmed`/`rejected`/`expired`), event_id, created_at, reviewed_at, review_note。时间窗交集和默认集合时间按当前成员的意向实时算 |
| `events` | 局：id, title, category（由标签推出）, task（标签名）, description, start_at, duration_min, place, meeting_point, capacity, min_size（成群最少人数）, fee_type(`aa`/`free`/`host`/`split`), fee_estimate, require_approval, same_sex_only + gender（= 谁可以报名 genderLimit：0 + null 为 any，1 + `female`/`male` 为只限女生 / 男生）, images(JSON，相对路径), location(JSON：name, address, latitude, longitude), exit_deadline（最晚退出时间）, source(`matched`/`user`/`platform`), creator_id, status(`pending_review`/`inviting`/`open`/`formed`/`cancelled`/`rejected`), formed_at（成群时间）, icebreaker_index, created_at |
| `event_members` | event_id, user_id, role(`host`/`member`), status(`invited`/`applied`/`joined`/`declined`/`left`/`removed`), attendance(`pending`/`yes`/`no`), arrived_at, safe_at, muted, last_read_message_id, invited_at, applied_at, joined_at, left_at, invite_expired（邀请到期没回应时为 1，status 仍是 declined） |
| `messages` | id, event_id, user_id(系统消息为 null), kind(`text`/`system`), text, created_at |
| `aa_bills` | 每个局一笔 AA：event_id(PK), payer_id（记账人）, amount（总额）, note（包含哪些）, created_at, updated_at。（v0.1 的 `aa_items` 不再使用，旧数据不迁移） |
| `aa_transfers` | event_id, from_user_id, to_user_id, status(`paid`/`confirmed`), updated_at（只存状态；金额每次实时计算） |
| `reviews` | event_id, reviewer_id, target_id, attendance(`on_time`/`late`/`no_show`), created_at |
| `review_feelings` | event_id, reviewer_id, feelings(JSON) |
| `credit_events` | id, user_id, event_id, type(`attended`/`late`/`cancel_late`/`no_show`/`admin_adjust`), source(`system`/`review`/`admin`), note, revoked, created_at |
| `appeals` | id, user_id, credit_event_id, text, status(`pending`/`approved`/`rejected`), admin_note, created_at, resolved_at |
| `reports` | id, reporter_id, target_type(`user`/`event`/`post`/`comment`/`message`), target_id, target_user_id, reason, detail, images(JSON), status(`pending`/`resolved`/`dismissed`), action, admin_note（只给后台看）, user_message（发给被处理的人的说明）, created_at, resolved_at |
| `blocks` | user_id, blocked_id, created_at（唯一） |
| `mutes` | user_id, muted_id（不看 TA 的动态） |
| `posts` | id, user_id, text, images(JSON，相对路径), event_id, visibility(`public`/`event`), status(`pending`/`approved`/`rejected`/`deleted`), created_at |
| `post_likes` | post_id, user_id |
| `comments` | id, post_id, user_id, reply_to_user_id, text, status(`approved`/`deleted`), created_at |
| `notices` | 站内通知：id, user_id, type, title, body, link, read, created_at |
| `settings` | key, value（后台设置，如自动成局） |
| `tags` | 标签：id, name, key(唯一，见 1.2), category, cover（插画 key，null = 按分类默认）, hot(0/1), sort（热门里的顺序）, created_at, last_used_at |
| `banners` | 首页轮播图：id, image（相对路径）, title, subtitle, link, sort, enabled, created_at |

---

## 3. 业务规则

### 3.1 信用

信用只看守不守约，不看话多不多。由 `credit_events`（未撤销的）实时计算：

| 情况 | 记录 |
| --- | --- |
| 准时到场 | `attended`（履约 +1） |
| 迟到 15 分钟以上 | `late`（算到场，但单独计数） |
| 开场前 **24 小时以上** 退出 / 轻确认说去不了 | **不记录**，不扣分 |
| 开场前 **24 小时内** 退出 / 轻确认说去不了 | `cancel_late`（临时鸽）。默认的最晚退出时间就是开场前 24 小时（3.3），只有发起人把最晚退出时间设得更晚、或局是开场前一天内才发起的，才会走到这条 |
| 没来也没说 | `no_show`（放鸽子） |
| 一个月内 `no_show` ≥ 2 次 | 账号 `restricted` 7 天（暂停撮合和报名） |

- **履约率** = (attended + late) ÷ (attended + late + cancel_late + no_show) × 100，取整；没有任何记录时为 100。
- **等级**：`restricted`（账号被限制，或一个月内放鸽子 ≥2）；`fair`（履约率 < 90，或一个月内有放鸽子）；其余 `good`。
- 用户可以对某条记录申诉（appeals），后台通过后该记录 `revoked=1`。
- 后台也可以直接撤销某条记录：通知本人「你的一条信用记录已撤销」（正文如「10月23日 桌游夜 · 新手友好 放鸽子」，link `credit`），这条记录上还在等处理的申诉自动通过，备注「后台已撤销这条记录」。
- 受限时记下原因（`restricted_reason`，后台可见）。**封禁不会被降级**：已封禁的账号不会因为后台限制、举报处理或自动受限变成 `restricted`，要先解封再处理。

### 3.2 撮合（系统先配好，后台过目确认）

1. 用户在首页说出「想做的事 + 什么时候」→ 生成 `intents`（status=open）。时间可以是时间段，也可以是精确到分钟的自定义时间段（1.2）。
2. **撮合引擎**每 5 分钟跑一次，另外在新意向提交时、后台点「立即撮合」时也会跑：
   - 只看 `open` 且未过期的意向，账号受限/封禁的人不参与。意向在最后一天的时间窗结束时过期（自定义时间段 = `date_to` 的 `timeTo`；时间段的和以前一样：上午 12:00、下午 18:00、晚上 / 全天 23:00）。
   - **同一个标签**（按 key 比较）；日期区间有重叠；**时间窗交集 ≥ 60 分钟**；地区相同。只用时间段（没人用自定义时间段）时，这条和以前的规则完全一样：时间段相同，或任一方是 `allday`，或开了「时间放宽到全天」。两两交集都 ≥ 60 分钟时整组交集也 ≥ 60 分钟。
   - 互相拉黑的人不能在同一组；有人开了「只参加同性局」，整组必须同性（性别未知的人不进同性组）。
   - 按提交时间先后贪心组队，人数达到组内所有人 `size_min` 的最大值才成组，最多到 `size_max` 的最小值（开了「2–6 人都可以」按 2–6 算）。
   - **排时间**：在所有人日期区间的交集里，选第一个默认集合时刻在 2 小时以后的日子。默认集合时刻：没人用自定义时间段时按任务和时间段（看日出 05:50、早餐 08:30、上午 09:00、下午 15:00、晚上 19:00、全天 10:00）；有人用了自定义时间段时取**时间窗交集的开始时间，向上取整到 :00 / :30**，取整后剩下不到 60 分钟就用交集开始（交集 14:10–16:00 → 14:30；14:10–15:20 → 14:10）。
   - 排时间时，和自己已加入（joined / applied）的局时间重叠的人先跳过（意向留在撮合池里，等下一次），剩下的人还够数才生成建议（3.9）。
   - 匹配度 `score`：基础 60；全组社交节奏相同 +10；时间段完全一致 +10（有人用了自定义时间段时：大家的时间窗完全一样才 +10）；有共同兴趣 +最多 15；全员信用良好 +5，满分 100。
   - `reasons` 示例：「都想去看日出」「时间都在周六上午」（有人用了自定义时间段时换成「大家都有空：14:00–16:30」）「都偏慢热」「共同兴趣：咖啡、读书」。
   - `risks` 示例：「有 1 人信用一般」「2 位是第一次参加」「夜间局，集合点要选人多的地方」「全员陌生，建议选公共场所」。
   - 生成一条 `proposals`（status=pending），相关意向改为 `proposed`。建议带 `window`（时间窗交集）、`windowLabel`、`defaultStartAt`（确认表单的默认集合时间）。
3. **后台过目**：确认时可以修改标题、集合时间、时长、地点（含 location）、集合点、费用方式、人数上限、最晚退出时间，然后「确认成局」→ 创建 `events`（source=matched，status=`inviting`，最晚退出时间默认按 3.3），成员全部 `invited`，意向改为 `invited`，并给每个人发通知「撮合成功」。也可以「调整成员」或「退回」（意向回到 open）。
   - 人数要在大家约好的范围内：组的 `minSize` = 所有人 `size_min` 的最大值，`maxSize` = 所有人 `size_max` 的最小值（开了「2–6 人都可以」按 2–6 算）。确认时要求 人数 ≥ minSize、人数 ≤ 人数上限 ≤ maxSize（人数上限默认 = 人数），否则 `VALIDATION`。调整成员时可以暂时低于 minSize，只有确认时校验。局的 `min_size` = minSize。
   - 有成员在这个时间已经加入了别的局 → `CONFLICT`，写明是谁（「阿野 和已加入的「苍山看日出」（10月31日 05:50–09:50）时间重叠了」，多个人用「；」隔开）。
4. **自动成局**（后台设置，默认关闭）：打开后，**每次撮合**都会检查所有待确认的建议（不只是这次新生成的），score ≥ 阈值且没有任何 risk 的直接确认；确认不了的（比如集合时间已过、有人时间冲突）留给后台。
5. **用户确认**：被邀请的人在「撮合成功」页点「加入这个局」→ `joined`；点「换一批」→ `declined`，意向回到 open 重新撮合，不扣分。加入时同样检查时间重叠（3.9）。
   - 全员加入 → 局 `formed`，群聊开启，发系统消息「满员啦，群已自动建好 · 第一次见面，慢慢来」（加入人数没到人数上限时用「人数够了，群已自动建好 · 第一次见面，慢慢来」），并给每个成员发通知（type `formed`，link `chat:<id>`）。
   - 有人拒绝：撮合引擎可以从同条件的 open 意向里直接补邀（不再经过后台）：同标签、同地区、日期包含开场日、**时间窗覆盖 [开始, 开始 + 60 分钟]**、符合「谁可以报名」、没有时间重叠。
   - 每个被邀请人的回应期限 = min(被邀请时间 + 24 小时, 开场前 12 小时)，过了仍未回应 → 视为放弃（成员 `declined` 且 `invite_expired=1`，后台显示为 `expired`；意向 `expired`）；没人在等回应时，已加入人数 ≥ `min_size` 就成局，否则等到最后一个人的期限后取消该局、意向退回 open，并通知「这次没凑齐，已帮你继续撮合」。
   - 已经点了「加入」、还在等别人的人，过了最晚退出时间也不能再「换一批」（409，同 3.3 的退出规则）；还没回复的人随时可以换一批。
   - 后台可以「催一下」还没回复的人（见 5 的 `POST /api/admin/events/:id/remind`）。

### 3.3 局的状态、成群和最晚退出时间

```
用户发起：pending_review ──(审核通过)──> open ──(满员，或到最晚退出时间且人数 ≥ minSize)──> formed
                └─(驳回)──> rejected       └─(到最晚退出时间人数 < minSize)──> cancelled（没凑齐人）
                                           formed 后、最晚退出时间前有人退出 → 回到 open 继续招人（群聊照常）
撮合产生：inviting ──(全员加入 / 邀请到期且够人)──> formed ；不够人 → cancelled
平台局：  open（后台创建，source=platform），之后和用户局一样
任何时候：发起人或后台可取消 → cancelled
```

- 进行阶段不单独存，按时间算：`phase = upcoming | ongoing | ended`（开始 ≤ 现在 < 开始 + 时长 为 ongoing）。
- 撮合产生的局 **只有成员能看到**，不进广场；广场只展示 `open`、还没开始、还没过最晚退出时间的用户局和平台局。
- 报名需要发起人同意的局，报名后是 `applied`，发起人同意才 `joined`。
- **谁可以报名 `genderLimit`**：`any` / `female` / `male`（替代 v0.1 的「只限同性」开关，旧字段仍接受）。
  - 用户发起：限制必须包含发起人自己——发起人性别未填 → `VALIDATION`「先在资料里选性别」；只选了异性 → `VALIDATION`「发起人自己也要能参加」。平台局（后台发起）可以任意设。
  - 性别不符（含未填性别、未登录）的人看不到这个局，也报不了名（详情 404）。
- **最晚退出时间 `exitDeadline`**：发起时可以传，要在 (现在, 开始] 之间；不传默认 max(开始前 24 小时, 现在 + 30 分钟)。撮合局在后台确认时按同样规则（确认时可以改）。
  - 过了最晚退出时间：已加入的人不能退出，也不能在提醒里点「去不了了」→ `CONFLICT`「已过最晚退出时间（10月30日 05:50），不能退出了」。详情里 `canLeave=false`，`leaveBlockedReason` 写明原因。撤回报名申请、没回复的撮合邀请换一批不受影响。
  - 用户局 / 平台局到了最晚退出时间还没满员（还是 open）：已加入人数 ≥ `minSize`（默认 2）→ 成群（系统消息「人数够了，群已自动建好 · 第一次见面，慢慢来」）；不够 → 取消（原因「没凑齐人」）。两种情况都通知所有人（包括发起人）。成群时还在等同意的报名申请一并结束（通知「已经截止报名了」）。由每分钟的定时任务处理；早就结束了的局（老库升级）只改状态，不再发通知。
  - 过了最晚退出时间不再接受报名（`CONFLICT`「已经截止报名了」，发起人也不能再通过申请），广场和首页也不再显示。
- **成群**：满员（joined 人数 = capacity）立即成群；或到最晚退出时间人数够（见上）。成群时给每个成员发通知（type `formed`，link `chat:<id>`，标题「满员啦，群已建好」/「人数够了，群已建好」），并发系统消息「满员啦，群已自动建好 · 第一次见面，慢慢来」（到时间成群用「人数够了，群已自动建好 · 第一次见面，慢慢来」）。成群后有人退出、局回到 open 又满员时不再重复通知。
- **群聊只在成群后开启**（所有来源一致）：`chatOpen` = 局是 `formed`，或成过群（`formed_at` 有值）后有人退出回到 `open`。没成群前可以看到系统消息，但不能发言（`FORBIDDEN`「群聊还没开启，成群后就能聊了」），也不出现在消息中心的局聊列表里。
- 时间重叠的规则见 3.9。

### 3.4 提醒与定时任务（每分钟检查一次）

| 时机 | 动作 |
| --- | --- |
| 开场前 48 小时内，出席待确认 | 生成「需要你处理 · 还去吗？」（inbox actions），只生成一次通知 |
| 局结束后 7 天内，还没评价 | 生成「去评价」（inbox actions） |
| 局结束后，开了「报平安提醒」 | 通知「到家了吗？点一下报平安」；1 小时没回应只记日志（短信通知紧急联系人留作后续） |
| 用户局 / 平台局到了最晚退出时间还是 open | 人数 ≥ minSize 成群，否则取消（3.3） |
| 撮合局邀请到期 | 见 3.2 第 5 条 |

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
| 动态、用户发起的局（含地点名称和地址） | 进入后台审核（status=`pending` / `pending_review`），用户看到「已发布，正在审核」 |
| 昵称、简介 | 拒绝保存 |
| 标签（想做的事、局的标签、后台新建的标签） | 直接拒绝，`CONTENT_BLOCKED`「这个标签不能用」 |
| AA 说明 | 直接拒绝，`CONTENT_BLOCKED`「AA 说明里不能有联系方式或广告」 |

配置了微信 `WX_APPID/WX_SECRET` 时，可选再调用微信内容安全接口 `msgSecCheck`（后续接入，先留钩子）。

### 3.7 AA 记账

平台不经手钱，只算账。**每个局只有一笔 AA**：由一个已加入的成员把总花费一次性记下（可以写包含哪些，如「车费 + 早餐」），其他人按人数平摊转给 TA。

- 记了就锁定，别人不能再记第二笔（`CONFLICT`）。记账人在还没有人点过「我已转账」（或收款人确认收到）之前可以改金额 / 说明，或者撤回；之后不能再改。
- 每人 = 总额 ÷ 当前 joined 人数（保留两位小数）；转账清单 = 其他每个 joined 成员各转「每人」给记账人（记账人如果已经退出，不再分摊，但仍然要拿回垫付的钱）。付款方点「我已转账」= `paid`，收款方点「确认收到」= `confirmed`。
- 记账后通知其他成员（type `aa_bill`，link `chat:<id>`）：「阿野 记了这个局的 AA：共 ¥150（车费 + 早餐），每人 ¥30，转给阿野」；改了、撤回了也会通知（「阿野 改了这个局的 AA：…」「阿野 撤回了这个局的 AA」）。

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

### 3.9 时间重叠

一个人已加入（`joined`）或申请中（`applied`）的局（不含已取消 / 被驳回的），时间段 [开始, 开始 + 时长) 不能和新局重叠；首尾相接不算重叠。被邀请（`invited`）还没加入的撮合局不算。

| 时机 | 冲突时 |
| --- | --- |
| 报名（`POST /api/events/:id/join`）、接受撮合邀请、发起局（发起人自动加入） | `CONFLICT`「和你已加入的「苍山看日出」（10月31日 05:50–09:50）时间重叠了」（标题去掉「周六清晨 · 」这类时间前缀；跨天时写出结束日期） |
| 发起人通过报名申请（检查申请人） | `CONFLICT`「小林 这个时间已经有别的局了，不能通过」（不透露对方的其他局） |
| 后台确认建议 | `CONFLICT`，写明是谁（3.2 第 3 条） |
| 撮合引擎排时间、补邀 | 跳过有冲突的人（3.2） |
| 提交意向 | 时间窗里（日期区间内任何一天）已经没有连续 60 分钟的空档 → `CONFLICT`「这个时间你已经有局了：「读书局」（10月31日 14:00–17:00）」（最多列 2 个局） |

---

## 4. 小程序接口

### 4.1 登录与资料

| 接口 | 说明 |
| --- | --- |
| `POST /api/auth/login` `{code}` | 微信 `wx.login` 的 code 换 openid。没配 `WX_APPID` 时进入开发模式：openid = `dev_` + code。返回 `{token, user: Me, isNew}` |
| `POST /api/auth/dev-login` `{userId?}` | 仅开发环境（`NODE_ENV != production`）。不传 userId 默认登录演示账号「栗子」。返回同上 |
| `POST /api/auth/phone` `{code}` | 手机号快速验证组件的 code 换手机号（开发模式随机生成）。返回 `{phoneMasked, phoneVerified: true}` |
| `GET /api/me` | 返回 `Me` |
| `PUT /api/me` | `{nickname?, bio?, avatarUrl?, coverUrl?, gender?, pace?, interests?, onboarded?}` → `Me`；昵称、简介要过内容审核。`avatarUrl` 用 `/api/upload` 返回的地址（绝对 / 相对都行，存相对路径），或其他 http(s) 地址。`coverUrl` 是主页背景图，只收本站上传的图片，传 `null` 恢复默认 |
| `GET /api/me/safety` · `PUT /api/me/safety` | `{sameSexOnly, checkInReminder, profileOpen, emergencyContact: {name, phone}\|null}`；返回时手机号打码 `phoneMasked`，并附 `blocked: UserBrief[]` |
| `GET /api/me/credit-events` | 我的信用记录列表 |
| `POST /api/credit-events/:id/appeal` `{text}` | 申诉 |
| `GET /api/leader-application` | 我的官方带队申请状态：`{isLeader, application: {id, intro, images, status(`pending`/`approved`/`rejected`), note, createdAt, reviewedAt}\|null}` |
| `POST /api/leader-application` `{intro, images?}` | 申请成为官方带队（需先完成手机号认证）：`intro` 10–500 字，`images` 最多 9 张。返回同上。一次只能有一个待审核申请 |

`Me`：

```json
{
  "id": 1, "nickname": "栗子", "avatarUrl": null, "avatarText": "栗", "avatarColor": "accent",
  "bio": "慢热，但很靠谱。", "gender": "female", "pace": "slow", "interests": ["看日出", "咖啡"],
  "phoneVerified": true, "idVerified": false, "status": "active", "onboarded": true,
  "credit": { "rate": 100, "level": "good", "attended": 6, "late": 0, "cancelLate": 0, "noShow": 0, "eventsCount": 6 },
  "ongoingCount": 2,
  "coverUrl": null, "coverKey": "sunrise"
}
```

- `coverUrl`：主页背景图（自己上传的，绝对地址），没设置为 null；`coverKey`：没设置时客户端显示的默认插画（第一个兴趣对应标签的插画，没有兴趣为 `lake`）。

### 4.2 他人主页、拉黑、不看

| 接口 | 说明 |
| --- | --- |
| `GET /api/users/:id` | `{user: UserBrief + {bio, interests, phoneVerified, idVerified, coverUrl, coverKey}, credit: {...同 Me.credit}, commonPoints: ["都喜欢看日出"], recentEvents: [{id, title, dateLabel, sharedWithMe, ended}], blockedByMe, profileHidden}`。对方关了「同局的人可以看我的主页」且不同局时，`profileHidden=true`，只返回昵称和履约率 |
| `POST /api/blocks/:userId` · `DELETE /api/blocks/:userId` | 拉黑 / 移出黑名单 |
| `POST /api/mutes/:userId` · `DELETE /api/mutes/:userId` | 不看 TA 的动态 / 恢复 |

### 4.3 撮合意向与撮合结果

| 接口 | 说明 |
| --- | --- |
| `POST /api/intents` | `{task, when: "today"\|"tomorrow"\|"weekend"\|"YYYY-MM-DD", slot? \| timeFrom? + timeTo?, area?, sizeMin?, sizeMax?, label?, relaxTime?, relaxSize?}` → `Intent`（提交后立刻触发一次撮合）。`task` 是标签（规则见 1.2）；`when` 只能选 30 天以内；`slot`（morning / afternoon / evening / allday）和 `timeFrom` + `timeTo`（`"HH:MM"`，北京时间，任意分钟，05:00 ≤ timeFrom < timeTo ≤ 23:59，至少 60 分钟）二选一，同时给 → `VALIDATION`「时间段和具体时间只能选一个」，只给一个 → 「请同时填写开始和结束时间」，都不给按任务给默认时间段。时间已经过去 → `VALIDATION`；同一个标签、日期有重叠的意向已经在撮合中 → `CONFLICT`；时间窗里已经没有空档 → `CONFLICT`（3.9）。`label` 是展示名，如「洱海边骑行」 |
| `GET /api/intents/mine` | `{items: Intent[]}`（open / proposed / invited 状态） |
| `GET /api/intents/:id` | `Intent` + `{similarCount, needMore, submittedAt}`。similarCount = 其他条件相同（能和我配到一起）的 open 意向数 |
| `PUT /api/intents/:id` | `{relaxTime?, relaxSize?}`（也接受 PATCH；小程序的 `wx.request` 不支持 PATCH，所以用 PUT） |
| `DELETE /api/intents/:id` | 取消意向 |
| `GET /api/matches/:eventId` | 被邀请人看撮合结果：`{event: EventDetail, members: UserBrief[], commonPoints: [], myStatus, joinedCount, deadline}` |
| `POST /api/matches/:eventId/accept` | 加入这个局 → `JoinResult`（见 4.4）。和已加入的局时间重叠 → `CONFLICT`（3.9） |
| `POST /api/matches/:eventId/decline` | 换一批 → `{ok: true, intentId}`（意向回到 open）。已经加入、过了最晚退出时间 → `CONFLICT` |

`Intent`：

```json
{ "id": 7, "task": "骑行", "category": "outdoor", "title": "周日 14:00–17:00 · 洱海边骑行", "dateFrom": "2026-11-01", "dateTo": "2026-11-01",
  "slot": "afternoon", "slotLabel": "下午", "timeFrom": "14:00", "timeTo": "17:00", "timeLabel": "14:00–17:00",
  "area": "古城", "sizeMin": 3, "sizeMax": 5, "relaxTime": false, "relaxSize": false,
  "status": "open", "eventId": null, "createdAt": "..." }
```

- `timeFrom` / `timeTo`：自定义时间段，不是自定义时为 null。`timeLabel`：清晨 / 上午 / 下午 / 晚上 / 全天，或「14:00–17:00」。
- `title` 带上时间：「周日下午 · 骑行」「周日 14:00–17:00 · 骑行」「本周末 · 爬山」（全天不写时间）。日期部分是「今天 / 明天 / 周日 / 本周末 / 11月8日」。

### 4.4 局

| 接口 | 说明 |
| --- | --- |
| `GET /api/events` | 广场：`?category=outdoor&tag=骑行&limit=&cursor=` → `{items: EventCard[], nextCursor}`，按开始时间升序，只含 open、还没开始、还没过最晚退出时间的局。`tag` 按规范化后的 key 比较（`?tag=ktv` 也能筛出「KTV」）；`category` 和 `tag` 可以一起用 |
| `GET /api/events/:id` | `EventDetail`（撮合局只有成员能看；性别不符的人看不到） |
| `POST /api/events` | 发起局 `{title, tag, startAt, durationMin?, place?, location?, meetingPoint?, capacity, minSize?, feeType, feeEstimate?, requireApproval, genderLimit?, images?, exitDeadline?, description?, invite?}` → `EventDetail`（过审核则 open，否则 pending_review）。`invite` 是「再约」时上次同行的 userId 列表，发布后给他们发「有人想再约你」通知。字段说明见下 |
| `POST /api/events/:id/join` `{ref?}` | 报名 → `JoinResult`。`ref` 是分享人的 userId（邀请归因：加入后通知分享人「你邀请的朋友来了」）。不能报名时：满员 / 已经截止报名 / 状态不对 → `CONFLICT`，时间重叠 → `CONFLICT`（3.9），已经开始 → `VALIDATION`，账号受限 → `RESTRICTED` |
| `POST /api/events/:id/leave` | → `{penalty: "cancel_late"\|null}`。过了最晚退出时间 → `CONFLICT`「已过最晚退出时间（10月30日 05:50），不能退出了」 |
| `POST /api/events/:id/cancel` | 发起人取消 |
| `GET /api/events/:id/applications` | 发起人看报名申请 |
| `POST /api/events/:id/applications/:userId/approve` · `/reject` | 发起人处理申请。approve → `{ok, eventStatus, memberCount, formed, remaining}`；过了最晚退出时间 → `CONFLICT`「已经截止报名了」；申请人时间冲突 → `CONFLICT`（3.9） |
| `POST /api/events/:id/attendance` `{going}` | 轻确认：去 / 去不了（去不了 = 退出，按 3.1 规则可能记临时鸽；过了最晚退出时间 → `CONFLICT`）→ `{attendance, penalty}` |
| `POST /api/events/:id/arrive` | 我到了 → `{arrivedAt}` |
| `POST /api/events/:id/safe` | 报平安 |
| `GET /api/events/mine` | `?tab=ongoing\|ended\|created` → `{items: MyEventCard[]}` |
| `GET /api/search` `?q=` | `{items: EventCard[]}`（标题、地点、标签、集合点模糊匹配；范围同广场） |
| `GET /api/search/hot` | `{terms: ["看日出", ...]}` |

发起局的字段：

- `tag`：标签（1.2），分类由标签推出。旧的 `category`（可以带 `task`）仍接受：只给 `category` 时按标题推一个默认标签（标题里有「读书」就是读书，否则户外 → 随便走走、吃饭 → 吃饭、咖啡 → 咖啡、桌游 → 桌游、拼车 → 拼车）。都不给 → `VALIDATION`「请选择标签」。
- `place` / `location`：`location` 可选，是 `wx.chooseLocation` 的返回 `{name, address, latitude, longitude}`（name 1–40 字必填，address ≤ 100 字，经纬度要么都给要么都不给）。`place`（≤ 40 字）不给时取 `location.name`；两个都没有 → `VALIDATION`「请填写地点」。
- `images`：0–9 张，必须是本站 `/uploads/` 的地址（先 `POST /api/upload`），否则 `VALIDATION`「图片地址不正确，请先上传」。
- `genderLimit`：`any`（默认）/ `female` / `male`，规则见 3.3。旧字段 `sameSexOnly: true` 等于「只限发起人的性别」。
- `exitDeadline`：ISO 时间，要在 (现在, 开始] 之间，不传默认 max(开始前 24 小时, 现在 + 30 分钟)。
- `minSize`：到最晚退出时间成群的最少人数，2 ≤ minSize ≤ capacity，默认 2。
- 其余同 v0.1：`startAt` 至少 30 分钟以后、90 天以内；`durationMin` 30–1440（默认 120）；`capacity` 2–20；`feeType` aa / free / host / split。发起人自动加入，和发起人已加入的局时间重叠 → `CONFLICT`。

`JoinResult`（报名、接受撮合邀请的返回值）：

```json
{ "myStatus": "joined", "eventStatus": "open", "formed": false, "remaining": 2, "memberCount": 3, "capacity": 5, "exitDeadline": "2026-10-30T21:50:00.000Z" }
```

- `myStatus`：`joined`，或需要发起人同意的局是 `applied`。`formed`：这次操作后已经成群（= 群聊已开启）。`remaining`：还差几人满员（capacity − memberCount）。客户端据此显示「进入群聊」或「已加入，还差 N 人成群，人齐了通知你」。重复调用返回当前状态。

`EventCard`：

```json
{ "id": 1, "title": "周六清晨 · 苍山看日出", "category": "outdoor", "task": "看日出", "tag": "看日出",
  "startAt": "2026-10-30T21:50:00.000Z", "dateLabel": "周六 05:50", "place": "大理古城南门",
  "capacity": 5, "memberCount": 4, "membersPreview": [UserBrief, UserBrief, UserBrief],
  "feeLabel": "AA 约 ¥30", "source": "matched", "status": "formed", "phase": "upcoming",
  "cover": "https://api.example.com/uploads/seed-sunrise.png", "coverKey": "sunrise",
  "genderLimit": "any", "genderLabel": null, "exitDeadline": "2026-10-29T21:50:00.000Z" }
```

- `tag`：标签（和 `task` 相同，`task` 是旧字段名）。`cover`：第一张图片的绝对地址，没有图片为 null。`coverKey`：标签的插画 key（没有标签记录时按分类给默认插画），没有图片时用它当封面。
- `genderLimit`：`any | female | male`；`genderLabel`：「只限女生」/「只限男生」/ null。`exitDeadline`：最晚退出时间。

`EventDetail` = `EventCard` + `{description, meetingPoint, durationMin, feeType, feeEstimate, requireApproval, sameSexOnly, host: UserBrief|null, members: (UserBrief & {role})[], myStatus, myAttendance, myArrivedAt, canJoin, isFull, chatOpen, images, location, exitDeadlineLabel, canLeave, leaveBlockedReason, remaining}`

- `images`：图片绝对地址数组。`location`：`{name, address, latitude, longitude}`（没填的为 null）或 null。
- `exitDeadlineLabel`：「10月30日 05:50」。`remaining`：还差几人满员。
- `canLeave`：现在能不能退出（已加入的成员、还没过最晚退出时间；申请中 / 被邀请的人可以撤回 / 换一批）；`leaveBlockedReason`：不能退出的原因（「已过最晚退出时间（10月30日 05:50），不能退出了」「你是发起人，不想办了可以取消这个局」「局已经结束了」「这个局已经取消了」），不在局里时为 null。
- `chatOpen`：只在成群后为 true（3.3）。`sameSexOnly` = `genderLimit != "any"`（兼容旧字段）。
- 另有补充字段：`endAt`、`fullDateLabel`、`isHost`、`minSize`。

`MyEventCard` = `EventCard` + `{myStatus, needReview, reviewed, intentId}`（撮合中的意向也以卡片形式出现在「进行中」，`id` 为 null、带 `intentId`、`timeFrom`、`timeTo`、`timeLabel`，`dateLabel` 如「周日 14:00–17:00」，`cover` 为 null、`exitDeadline` 为 null）。

### 4.5 群聊、局信息、AA

| 接口 | 说明 |
| --- | --- |
| `GET /api/events/:id/messages` | `?after=<id>` → `{items: Message[], icebreaker: {index, total, question}, chatOpen}`，只有 joined 成员能看，调用即视为已读 |
| `POST /api/events/:id/messages` `{text}` | → `Message`（审核不过返回 CONTENT_BLOCKED；还没成群 → FORBIDDEN「群聊还没开启，成群后就能聊了」） |
| `POST /api/events/:id/icebreaker/next` | 换一个破冰话题（全组共享）→ `{index, total, question}` |
| `GET /api/events/:id/info` | `{event: EventDetail, members: (UserBrief & {role, isMe})[], aa: {each, openTransfers}, muted}` |
| `PUT /api/events/:id/mute` `{muted}` | 消息免打扰 |
| `GET /api/events/:id/aa` | `AAView`（见下），只有 joined 成员能看 |
| `POST /api/events/:id/aa` `{amount, note?}` | 记 AA：任何已加入的成员，每个局只能一笔，已经有了 → `CONFLICT`「这个局已经有人记过 AA 了」。amount 0.01–100000、最多两位小数；note 写包含哪些（≤ 40 字，带联系方式 / 广告 → CONTENT_BLOCKED）。通知其他成员（3.7）→ `AAView` |
| `PUT /api/events/:id/aa` `{amount, note?}` | 改：只有记账人（否则 FORBIDDEN），且还没人点过「我已转账」（否则 `CONFLICT`「已经有人转账了，不能再改」）→ `AAView` |
| `DELETE /api/events/:id/aa` | 撤回：条件同 PUT → `AAView`（bill 为 null，又可以重新记） |
| `POST /api/events/:id/aa/paid` `{toUserId}` | 我已转账 → `AAView` |
| `POST /api/events/:id/aa/confirm` `{fromUserId}` | 确认收到 → `AAView` |

`AAView`：

```json
{ "bill": { "payer": UserBrief, "amount": 150, "note": "车费 + 早餐", "createdAt": "...", "mine": false, "editable": false },
  "total": 150, "each": 30, "memberCount": 5,
  "transfers": [ { "from": UserBrief, "to": UserBrief, "amount": 30, "status": "pending", "role": "from" } ],
  "canDeclare": false }
```

- `bill`：还没人记账时为 null。`mine`：我是记账人；`editable`：我是记账人、局没取消、还没人点过「我已转账」。
- `transfers[].status`：`pending | paid | confirmed`；`role`：`from`（我要转）/ `to`（转给我）/ null。
- `canDeclare`：还没有账单且局没取消（我能记）。v0.1 的 `items` 和 `/aa/items` 接口已删除。

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
| `POST /api/posts` | `{text, images: [], eventId?, visibility}` → `Post`（`status` 可能是 pending）。images 最多 9 张，必须是本站 `/uploads/` 的地址（绝对 / 相对都行），存相对路径 |
| `DELETE /api/posts/:id` | 作者删除 |
| `POST /api/posts/:id/like` · `DELETE /api/posts/:id/like` | → `{liked, likeCount}` |
| `POST /api/posts/:id/comments` `{text, replyToUserId?}` | → `Comment` |

`Post`：`{id, author: UserBrief, text, images: [url], event: {id, title}|null, likeCount, commentCount, liked, mine, status, createdAt}`（`images` 是绝对地址；列表照小红书做双列瀑布流：第一张图作封面，没图的显示成文字卡片）
`Comment`：`{id, author: UserBrief, text, replyTo: {id, nickname}|null, createdAt, mine}`

### 4.8 举报、上传、消息中心

| 接口 | 说明 |
| --- | --- |
| `POST /api/reports` | `{targetType, targetId, reason, detail?, images?, alsoBlock?}` → `{id, status: "pending"}` |
| `POST /api/upload` | multipart，字段名 `file`，只收图片（jpg / png / gif / webp），≤ 5MB → `{url}`（绝对地址；提交回来时绝对 / 相对都行） |
| `GET /api/inbox` | `{actions: [...], chats: [...], notices: [...]}`（见下；chats 只含已经成群的局） |
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

通知的 `link` 告诉客户端点了去哪：`match:<eventId>` 撮合成功页、`event:<eventId>` 局详情、`chat:<eventId>` 群聊、`review:<eventId>` 互评、`post:<postId>` 动态详情、`credit` 我的信用记录，`null` 不跳转。（首页轮播图的 link 还可以是 `square` / `create` / `feed` / `rules`，见 4.10。）

通知的 `type`：`match` 撮合成功 · `match_reminder` 后台催回复 · `formed` 成群（标题「满员啦，群已建好」或「人数够了，群已建好」，link `chat:<id>`）· `match_failed` 没凑齐 · `attendance` 轻确认 · `review` 去评价 · `safe` 报平安 · `event_cancelled`（含到最晚退出时间没凑齐人）· `event_approved` · `event_rejected` · `application` · `application_result`（含截止报名时结束的申请）· `join` · `leave` · `post_approved` · `post_rejected` · `comment` · `aa_bill` 有人记了 / 改了 / 撤回了 AA · `aa_paid` · `aa_confirmed` · `report_result` · `warning` · `content_deleted` 内容被删 · `restricted` · `unrestricted` · `banned` · `unbanned` · `appeal_result` · `credit_revoked` 信用记录被撤销。客户端不认识的 type 按普通通知显示即可。

### 4.9 开发辅助接口（仅 `NODE_ENV` 不是 `production` 时开放）

演示登录见 4.1 的 `POST /api/auth/dev-login`。

| 接口 | 说明 |
| --- | --- |
| `POST /api/dev/clock` | `{now}` / `{advanceMinutes}` / `{reset: true}` 让服务端「穿越时间」，用来演示提醒、邀请到期、最晚退出时间、互评 |
| `POST /api/dev/tick` | `{match?}` 立刻跑一遍每分钟的定时任务（邀请到期、最晚退出时间、提醒）→ `{now, deadlines, exitDeadlines: {formed, cancelled}, reminders, match}`；`match: true` 时连撮合一起跑 |

### 4.10 首页与标签

| 接口 | 说明 |
| --- | --- |
| `GET /api/home` | 首页内容（不需要登录；登录了按拉黑和「谁可以报名」过滤）→ `Home`（见下） |
| `GET /api/tags/hot` | 热门标签（不需要登录，按后台排的顺序）→ `{items: [{name, category, cover}]}`；`cover` 是插画 key |

`Home`：

```json
{
  "banners": [ { "id": 1, "image": "https://.../uploads/seed-sunrise.png", "title": "苍山日出", "subtitle": "周六清晨，古城南门集合，一起上山看日出", "link": "event:1" } ],
  "hotTags": [ { "name": "看日出", "category": "outdoor", "cover": "sunrise" } ],
  "highlights": [ { "postId": 12, "image": "https://.../uploads/seed-sunrise.png", "text": "凌晨爬起来真的值……", "user": UserBrief, "eventTitle": "周二清晨 · 苍山看日出" } ],
  "featuredEvents": [ EventCard ],
  "stats": { "weekPeople": 23, "weekFormed": 4 }
}
```

- `banners`：后台开着的轮播图，按顺序。`link` 用通知 link 的写法，另外 `square` = 广场、`create` = 发起局、`feed` = 动态、`rules` = 社区公约；null 不跳转。
- `hotTags`：同 `GET /api/tags/hot`。
- `highlights`「大家最近在玩」：最近带图的公开动态（已通过，排除拉黑和不看的人），最多 10 条；`image` 是第一张图，`eventTitle` 是关联的局（没有为 null）。
- `featuredEvents` 精选局：广场上（范围同 `GET /api/events`）最近要开始、还有名额的局，最多 6 个。
- `stats`：`weekPeople` = 近 7 天加入过局的人数（按加入时间，去重），`weekFormed` = 近 7 天成群的局数。

---

## 5. 后台接口（`/api/admin/*`）

列表的 `?status=` / `?level=` / `?source=` / `?scope=` 只接受下面列出的值，其他值返回 `VALIDATION`。

| 接口 | 说明 |
| --- | --- |
| `POST /api/admin/login` `{password}` | 密码来自环境变量 `ADMIN_PASSWORD`（开发默认 `admin123`）→ `{token}`。同一 IP 15 分钟内输错 10 次 → `TOO_MANY_REQUESTS` |
| `GET /api/admin/stats` | `{today: {newUsers, newIntents, formed, pendingProposals, pendingReports, pendingPosts, pendingEvents}, yesterday: {newUsers, newIntents, formed}, week: {attendanceRate, noShowCount, eventsEnded}, prevWeek: {attendanceRate, noShowCount}, series: [{date, formed, newUsers}]}`。today / yesterday / series（近 7 天，含今天）按北京日期；`week` 是**滚动的最近 7×24 小时**（履约率和放鸽子次数按信用记录的时间算，eventsEnded = 这段时间里结束的局），`prevWeek` 是再往前的 7×24 小时，用来算「比上周」 |
| `GET /api/admin/proposals` | `?status=pending`（默认，按匹配度降序）\|`confirmed`\|`rejected`\|`expired`（这三种按处理时间倒序，最多 200 条）\|`all`（id 倒序，最多 200 条）→ `{items: Proposal[]}` |
| `POST /api/admin/proposals/:id/confirm` | `{title?, startAt?, durationMin?, place?, location?, meetingPoint?, feeType?, feeEstimate?, capacity?, exitDeadline?, images?, description?}` → `{eventId}`。`startAt` 默认 = `defaultStartAt`；`exitDeadline` 默认按 3.3；`location` / `images` 规则同发起局。人数 < `minSize`、`capacity` < 人数或 > `maxSize` → `VALIDATION`（`capacity` 默认 = 人数）；组里有人互相拉黑、或剩下不到 2 人 → `CONFLICT`；有成员时间冲突 → `CONFLICT` 并写明是谁（3.2） |
| `POST /api/admin/proposals/:id/reject` | `{note?}` → `{ok: true}`。意向回到 open；同一组人同一天不会再被原样推荐 |
| `POST /api/admin/proposals/:id/members` | `{remove: [userId], add: [intentId]}`（add 只能是 open 的意向）→ 更新后的 `Proposal`（重新计算 score / reasons / risks / minSize / maxSize / window）。可以调到低于 minSize（界面提示即可），只有确认时校验；至少保留 2 人 |
| `GET /api/admin/intents` | `?status=open`（默认，撮合池里还在等的）\|`proposed`（已进建议局、等后台确认的）\|`invited`\|`matched`\|`cancelled`\|`expired`（按提交时间升序，最多 300 条）\|`all`（id 倒序，最多 300 条）→ `{items: PoolIntent[]}` |
| `POST /api/admin/match/run` | 立即撮合 → `{created, autoConfirmed, backfilled, expired}`：新生成的建议数、自动确认的建议数（3.2 第 4 条）、给撮合局补邀的人数、这次标记过期的意向数 |
| `GET /api/admin/settings` · `PUT /api/admin/settings` | `{autoConfirm: {enabled, threshold}}`（默认关闭、阈值 90）。PUT 可以只传其中一项 |
| `GET /api/admin/events` | `?status=`\|`pending_review`\|`inviting`\|`open`\|`formed`\|`ended`\|`cancelled`\|`rejected` `&source=`\|`matched`\|`user`\|`platform` `&q=`（标题 / 地点 / 标签）→ `{items: AdminEventCard[]}`，按开始时间倒序，最多 300 条。`open` / `formed` 只含还没结束的；`ended` = 已经结束的 open / formed 局（开始时间 + 时长 ≤ 现在） |
| `GET /api/admin/events/:id` | `{event: EventDetail + AdminEventCard 的补充字段, members: AdminMember[], messages: Message[]（最近 50 条，后台查看时 mine 恒为 false）, aa: AdminAA, reports: AdminReport[]}` |
| `POST /api/admin/events` | 发起平台局，字段同用户发起（`tag`、`genderLimit` 可以任意设、`images`、`location`、`exitDeadline`、`minSize`……；旧的同性局写法 `sameSexOnly: true` + `gender: "female"\|"male"` 仍接受）→ `{eventId}` |
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
| `GET /api/admin/tags` | `?scope=all`（默认，全部标签，按最近 `days` 天的使用次数倒序，再按总次数、最近使用时间）\|`hot`（热门标签，按顺序）`&days=30`（1–365）→ `{items: AdminTag[]}` |
| `POST /api/admin/tags` | `{name, category, cover?, hot?}` → `AdminTag`。名字规则同 1.2（审核不过 → `CONTENT_BLOCKED`）；同名（同 key）已存在 → `CONFLICT`「已经有这个标签了」；`hot: true` 时排在热门的最后 |
| `PUT /api/admin/tags/hot` | `{ids: [tagId]}` 整体替换热门列表及顺序：ids 里的按顺序成为热门，其余都不是热门 → `{items: AdminTag[]}`（同 `?scope=hot`）。有不存在的 id → `NOT_FOUND`，重复 → `VALIDATION` |
| `PUT /api/admin/tags/:id` | `{name?, category?, cover?, hot?}` → `AdminTag`。改名不影响已经用了旧名字的局和意向；`cover: null` 恢复按分类的默认插画；`hot: true` 时排在热门的最后 |
| `DELETE /api/admin/tags/:id` | → `{ok: true}`。删掉后如果有人再用这个标签，会自动重新建一条（不是热门） |
| `GET /api/admin/banners` | 全部轮播图（含停用的），按顺序 → `{items: AdminBanner[]}` |
| `POST /api/admin/banners` | `{image, title, subtitle?, link?, enabled?}` → `AdminBanner`。image 必须是本站上传的图片（先 `POST /api/admin/upload`）；title 1–20 字；subtitle ≤ 40 字；link 写法见 4.10，不对 → `VALIDATION`；enabled 默认 true；新的排在最后 |
| `PUT /api/admin/banners/order` | `{ids: [bannerId]}` → `{items: AdminBanner[]}`：ids 里的按顺序排在前面，没列出的保持原来的先后排在后面 |
| `PUT /api/admin/banners/:id` | `{image?, title?, subtitle?, link?, enabled?}` → `AdminBanner` |
| `DELETE /api/admin/banners/:id` | → `{ok: true}` |
| `POST /api/admin/upload` | 后台上传图片：multipart，字段名 `file`，只收图片（jpg / png / gif / webp），≤ 5MB → `{url}`（绝对地址） |

`Proposal`：

```json
{ "id": 2, "title": "周日上午 · 一起爬山", "task": "爬山", "category": "outdoor", "date": "2026-11-01", "dateLabel": "周日",
  "slot": "morning", "slotLabel": "上午", "window": { "from": "05:00", "to": "12:00" }, "windowLabel": "上午",
  "defaultStartAt": "2026-11-01T01:00:00.000Z", "area": "古城", "score": 80,
  "reasons": ["都想去爬山", "时间都在周日上午", "共同兴趣：爬山", "全员信用良好"], "risks": ["1 位是第一次参加"],
  "minSize": 3, "maxSize": 5, "status": "pending", "eventId": null, "createdAt": "...", "reviewedAt": null, "reviewNote": null,
  "members": [ { "user": UserBrief, "gender": "male", "pace": "slow", "isNew": false, "intentId": 8, "intentCreatedAt": "...", "timeLabel": "上午" } ] }
```

- `minSize` / `maxSize`：组里所有人约好的人数范围（3.2 第 3 条）。人数比 minSize 少时界面要提示「还差 n 人」，确认会被拒。
- `window`：当前成员时间窗的交集（`"HH:MM"`）；`windowLabel`：有人用了自定义时间段时是「14:10–16:00」，否则是时间段（清晨 / 上午 / 下午 / 晚上 / 全天）。`defaultStartAt`：确认表单里集合时间的默认值（3.2 的默认集合时刻，落在 `date` 那天）。`members[].timeLabel`：每个人自己选的时间。

`PoolIntent`：`{id, user: UserBrief, task, title, dateFrom, dateTo, slot, slotLabel, timeFrom, timeTo, timeLabel, area, sizeMin, sizeMax, relaxTime, relaxSize, status, eventId, proposalId, isNew, createdAt, waitingHours}`。`isNew` = 这个人还没有到场记录（第一次参加）；`proposalId` / `eventId` = 所在的建议局 / 撮合局；`waitingHours` = 已经等了几个小时（取整）；时间字段同 `Intent`。

`AdminEventCard` = `EventCard` + `{creator: UserBrief|null, createdAt, reportCount, flags, reviewNote, cancelReason, formedAt, joinedCount, invitedCount, inviteDeadline}`

- `flags`：内容审核命中的原因（待审核的用户局看这个）。
- `joinedCount` 已加入人数；`invitedCount` 还没回复的被邀请人数；`inviteDeadline` 只在撮合局 `inviting` 时有值 = 最后一个被邀请人的回应期限（到点后够 min_size 成局，不够取消），其他情况为 null。
- `cancelReason`：取消原因（到最晚退出时间没凑齐人的是「没凑齐人」）。

`AdminMember` = `UserBrief` + `{role, status, inviteDeadline, attendance, arrivedAt, safeAt, invitedAt, joinedAt, leftAt}`

- `status`：`invited`（还没回复）\| `joined` \| `declined`（点了换一批）\| `expired`（邀请到期没回应；用户那边看到的仍是 declined）\| `applied` \| `left` \| `removed`。
- `inviteDeadline`：这个人的回应期限 = min(被邀请时间 + 24 小时, 开场前 12 小时)；不是撮合局邀请来的为 null。

`AdminAA`：`{total, each, memberCount, itemCount, bill: {payer: UserBrief, amount, note, createdAt}|null, transfers: [{from: UserBrief, to: UserBrief, amount, status}]}`（`itemCount` 是旧字段，有账单时为 1，否则 0）

`AdminTag`：`{id, name, category, cover, hot, sort, useCount, recentCount, lastUsedAt}`

- `cover`：插画 key（没设时是按分类的默认插画）；`hot`：true / false（提交时也接受 1 / 0）；`sort`：热门里的顺序（从 0 开始，非热门为 0）。
- `useCount`：撮合意向 + 用户发起的局里用到这个标签（按 key）的总次数；`recentCount`：其中最近 `days` 天（默认 30）的次数；`lastUsedAt`：最近一次用到的时间，没用过为 null。

`AdminBanner`：`{id, image, title, subtitle, link, sort, enabled, createdAt}`（`image` 是绝对地址，`subtitle` / `link` 没填为 null）

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

与设计稿一致，所有时间相对「现在」生成：

- 用户：栗子（我，演示登录账号）、小满、阿野、七七、木木、大鹏、南风、小林、阿云、青青、老周。
- 默认的 13 个标签（10 个热门），`last_used_at` 和使用次数按下面的意向和局算出来；3 张轮播图：苍山日出 → `event:<苍山看日出>`（撮合局，只有成员能打开，比如栗子）、洱海骑行 → `square`、新人第一次来 → `rules`。
- 局：周六清晨 · 苍山看日出（撮合局，已成群，含群聊和 AA：阿野一次记下 ¥150「车费 + 早餐」，5 人每人 ¥30，木木已经转过；群里阿野说「车费和早餐我先垫了，一起记在 AA 里，最后大家转我就行」）、桌游夜 · 新手友好（已结束、到最晚退出时间成群，待评价）、几个已结束已评价的历史局、安静读书局 · 不用聊天 / 喜洲稻田边吃早餐 / 拼车去双廊 / 洱海西岸骑行（广场上的 open 局，带地点）、1 个待审核的局。每个局都有配图（待审核的除外）和合理的最晚退出时间（已成群的是开始前 24 小时；广场上的还在报名，演示时不会马上截止）。
- 配图：`design/illustrations/*.svg` 用 `server/scripts/render-seed-images.mjs`（Playwright）渲染成 1200×800 的 PNG，放在 `server/seed-assets/`（提交到仓库）；seed 时复制进上传目录，文件名 `seed-<key>.png`。
- 意向：栗子的「周日下午 · 洱海边骑行」（open，还差 1 人）、另外几条可被撮合的意向，以及 1 条待后台确认的建议局（周日上午 · 一起爬山）。
- 动态 10 条（9 条带 1–4 张图）+ 评论 5 条；待处理举报 2 条；1 条申诉。

---

## 版本记录

### v0.3（来自真机实测反馈，详见 `docs/changes-v0.3.md`）

- **标签**：想做的事 / 局的标签都是自由标签，有统一的规范化和 key；新表 `tags`（后台维护热门列表），`GET /api/tags/hot`，后台标签增删改和热门排序；发起局用 `tag`，`GET /api/events?tag=`（1.2、5）。
- **意向时间**：时间段之外可以填精确到分钟的自定义时间段（`timeFrom` / `timeTo`），撮合按时间窗交集 ≥ 60 分钟；Intent 增加 `timeFrom` / `timeTo` / `timeLabel`，标题带时间；建议局增加 `window` / `windowLabel` / `defaultStartAt`；补邀要覆盖 [开始, 开始 + 60 分钟]（1.2、3.2、4.3）。
- **局**：`genderLimit` 替代只限同性；`images`、`location`；最晚退出时间 `exitDeadline`（过了不能退出、不能报名，到点成群或取消）；成群规则统一，群聊只在成群后开启；报名 / 接受邀请返回 `JoinResult`；时间重叠检测；EventCard / EventDetail 增加对应字段（3.3、3.9、4.4）。
- **AA**：每个局只有一笔，一次声明（新表 `aa_bills`，`POST/PUT/DELETE /api/events/:id/aa`，删除 `/aa/items`）（3.7、4.5）。后台局详情的 `aa` 增加 `memberCount`、`bill`、`transfers`。
- **首页**：`GET /api/home`（轮播图、热门标签、大家最近在玩、精选局、本周数据）；新表 `banners`，后台轮播图增删改排序，`POST /api/admin/upload`（4.10、5）。
- **图片**：库里存相对路径，返回绝对地址，提交时绝对 / 相对都接受（1）。
- **演示数据**：插画配图、轮播图、10 条动态、单笔 AA、最晚退出时间（6）。

### v0.1

- 首版：登录与资料、撮合（系统配好、后台过目）、局与群聊、AA、互评与信用、动态、举报、消息中心、后台。
