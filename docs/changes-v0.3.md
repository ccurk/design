# v0.3 改动约定（三端共用）

这一轮来自用户在微信开发者工具里的实测反馈，目标是把小程序从「能跑通」提升到「能上线的工业级」：图更多、交互统一、关键流程有确认和结果反馈。
本文是后端、小程序、后台三边同时开发时的**唯一约定**。后端实现后把这些内容并入 `docs/api.md`（并在文末注明 v0.3）；字段名以本文为准，有出入先改本文。

通用：所有新文案用简体中文；时间仍是 ISO UTC，业务时区 Asia/Shanghai；图片 URL 在数据库里存相对路径 `/uploads/xxx`，接口返回时一律拼成绝对地址（`PUBLIC_BASE_URL` + 路径），客户端提交时绝对 / 相对都接受。

---

## A. 标签：热门标签（后台维护）+ 用户自己添加

- 「想做的事」（意向的 `task`）和局的「标签」（`tag`）都是自由标签，规则相同：
  - 去首尾空格、合并连续空白、NFKC；长度 1–8 个字（按字符）；只允许文字、数字、空格和 `·-_`；
  - 过内容审核（`checkText`），命中 → 422 `CONTENT_BLOCKED`「这个标签不能用」；
  - 撮合时按「规范化 key」比较（上面的处理 + 拉丁字母转小写），所以「KTV」和「ktv」能配到一起。
- 新表 `tags`：`id, name, key(唯一), category, cover, hot(0/1), sort, created_at, last_used_at`。
  - `category` ∈ outdoor / food / coffee / game / carpool / other（广场兜底和统计用）。
  - `cover` 是插画 key（见 H），没设时按分类给默认值。
  - 启动时表为空就写入默认标签；用户用到新标签时自动建一条（hot=0），并更新 `last_used_at`。
- 默认热门（按顺序）：看日出(outdoor, sunrise)、爬山(outdoor, mountain)、骑行(outdoor, cycling)、咖啡(coffee, coffee)、吃饭(food, food)、桌游(game, boardgame)、拼车(carpool, carpool)、随便走走(outdoor, oldtown)、读书(coffee, reading)、拍照(outdoor, lake)。
  非热门：徒步(outdoor, mountain)、早餐(food, food)、夜市(food, food)。
- 接口：
  - `GET /api/tags/hot`（不需登录）→ `{ items: [{ name, category, cover }] }`
  - `GET /api/admin/tags?scope=hot|all&days=30` → `{ items: [{ id, name, category, cover, hot, sort, useCount, recentCount, lastUsedAt }] }`；`all` 按 recentCount 倒序（看用户最近在用什么）
  - `POST /api/admin/tags {name, category, cover?, hot?}` · `PUT /api/admin/tags/:id {name?, category?, cover?, hot?}` · `PUT /api/admin/tags/hot {ids}`（整体替换热门列表及顺序）· `DELETE /api/admin/tags/:id`
- 局：`POST /api/events` / `POST /api/admin/events` 用 `tag`（旧的 `category` 仍接受，作兼容）；分类由标签推出。`GET /api/events?tag=xxx` 按标签筛（规范化比较）。

## B. 意向的时间：上午 / 下午 / 晚上 / 都可以 / 指定时间段（精确到分钟）

- `POST /api/intents` 二选一：`slot`（morning / afternoon / evening / allday）或 `timeFrom` + `timeTo`（"HH:MM"，北京时间，任意分钟，05:00 ≤ from < to ≤ 23:59，至少 60 分钟）；同时给 → 400。`when` 仍支持 today / tomorrow / weekend / YYYY-MM-DD（30 天内）。
- 每个意向有一个时间窗：自定义时间段，或时间段对应的窗（morning 05:00–12:00、afternoon 12:00–18:00、evening 18:00–23:00、allday 或「放宽到全天」05:00–23:00）。一组人的时间窗交集 ≥ 60 分钟才能配到一起。没人用自定义时间段时，行为和现在完全一样。
- 有人用了自定义时间段：集合时间默认取交集开始时间（向上取整到 :00 / :30，超出交集就用交集开始）；理由写「大家都有空：14:00–16:30」。
- Intent 增加 `timeFrom`、`timeTo`（不是自定义时为 null）、`timeLabel`（清晨 / 上午 / 下午 / 晚上 / "14:00–17:00" / 全天）；`title` 带上时间：「周日下午 · 骑行」「周日 14:00–17:00 · 骑行」「本周末 · 爬山」（全天不写）。
- 建议局（后台）增加 `window: {from, to}`、`windowLabel`、`defaultStartAt`（确认表单默认值）。补邀时候选人的时间窗要覆盖 [开始, 开始+60 分钟]。自定义时间段的意向在 date_to + timeTo 过期。

## C. 局：性别限制、图片、地点、最晚退出时间、成群规则、重叠检测

- **谁可以报名** `genderLimit`：any / female / male（替代「只限同性」开关；旧字段仍接受）。
  用户发起：限制必须包含发起人自己 —— 发起人性别未填 → 400「先在资料里选性别」；只选了异性 → 400「发起人自己也要能参加」。平台局任意。
  性别不符（含未填）的人看不到、也报不了名。
- **图片** `images`：0–9 张，必须是本站 `/uploads/` 的地址。
- **地点** `location`（可选）：`{name, address, latitude, longitude}`（`wx.chooseLocation` 的返回）。`place` 默认取 `location.name`。
- **最晚退出时间** `exitDeadline`（ISO）：默认 max(开始前 24 小时, 现在 + 30 分钟)，可传，需在 (现在, 开始] 之间。
  - 过了最晚退出时间：不能退出，也不能在提醒里点「去不了了」→ 409「已过最晚退出时间（10月30日 05:50），不能退出了」。
  - 用户局 / 平台局到了最晚退出时间还没满员：已加入人数 ≥ `minSize`（默认 2）→ 成群；不够 → 取消（原因「没凑齐人」）。两种情况都通知所有人。过了这个时间不再接受报名（广场也不显示）。
- **成群**：满员立即成群；群聊**只在成群后开启**（所有来源一致）。成群时给每个成员发通知（type `formed`，link `chat:<id>`）和系统消息「满员啦，群已自动建好 · 第一次见面，慢慢来」（到时间成群用「人数够了，群已自动建好 · 第一次见面，慢慢来」）。
- **加入的返回值**：`POST /api/events/:id/join` 和 `POST /api/matches/:id/accept` 返回
  `{ myStatus, eventStatus, formed, remaining, memberCount, capacity, exitDeadline }`
  （`formed` = 这次操作后已成群；`remaining` = 还差几人满员）。客户端据此显示「进入群聊」或「已加入，还差 N 人成群，人齐了通知你」。
- **重叠时间检测**：一个人已加入（joined / applied）的局，时间段 [开始, 开始+时长] 不能和新局重叠。在报名、接受撮合邀请、发起局（发起人自动加入）、发起人通过报名申请时检查，冲突 → 409「和你已加入的「苍山看日出」（10月31日 05:50–09:50）时间重叠了」（发起人通过申请时冲突的是申请人，提示改为「小林 这个时间已经有别的局了，不能通过」，不透露对方的其他局）。撮合引擎排时间时跳过有冲突的成员；后台确认建议时如有成员冲突 → 409 并写明是谁；提交意向时，如果时间窗里已经没有连续 60 分钟的空档 → 409「这个时间你已经有局了：…」。
- **EventCard** 增加：`tag`、`cover`（第一张图的绝对地址或 null）、`coverKey`（标签的插画 key）、`genderLimit`、`genderLabel`（只限女生 / 只限男生 / null）、`exitDeadline`。
- **EventDetail** 增加：`images`、`location`、`exitDeadline`、`exitDeadlineLabel`（「10月30日 05:50」）、`canLeave`、`leaveBlockedReason`、`remaining`；`chatOpen` 只在成群后为 true。

## D. AA：一次声明

- 每个局只有一笔 AA：由一个成员把总花费一次性记下（可写包含哪些），其他人按人数平摊转给他。记了就锁定，中途不能再加。
- 新表 `aa_bills`：`event_id(主键), payer_id, amount, note, created_at, updated_at`；旧的 `aa_items` 不再使用（`/aa/items` 接口删除）。
- 接口：
  - `GET /api/events/:id/aa` → `{ bill: { payer: UserBrief, amount, note, createdAt, mine, editable } | null, total, each, memberCount, transfers: [{ from, to, amount, status, role }], canDeclare }`
  - `POST /api/events/:id/aa {amount, note?}` 声明（任何已加入的成员，只能一次，已有 → 409）
  - `PUT /api/events/:id/aa {amount, note?}` · `DELETE /api/events/:id/aa`：只有记账人，且还没人点过「我已转账」
  - `POST /aa/paid`、`POST /aa/confirm` 不变
- 声明后通知其他成员：「阿野 记了这个局的 AA：共 ¥150（车费 + 早餐），每人 ¥30，转给阿野」，link `chat:<id>`。

## E. 首页内容：轮播图、大家最近在玩、精选局

- 新表 `banners`：`id, image, title, subtitle, link, sort, enabled, created_at`。`link` 用通知 link 的写法，再加 `square`（广场）、`create`（发起局）、`feed`（动态）、`rules`（社区公约）。
- `GET /api/home`（不需登录；登录了会按拉黑和性别过滤）→
  `{ banners: [{ id, image, title, subtitle, link }], hotTags: [{ name, category, cover }], highlights: [{ postId, image, text, user: UserBrief, eventTitle }], featuredEvents: [EventCard], stats: { weekPeople, weekFormed } }`
  - highlights：最近带图的公开动态，最多 10 条；featuredEvents：广场上最近要开始、有名额的局，最多 6 个；stats：近 7 天加入过局的人数、成群的局数。
- 后台：`GET /api/admin/banners` · `POST /api/admin/banners {image, title, subtitle?, link?, enabled?}` · `PUT /api/admin/banners/:id {...}` · `PUT /api/admin/banners/order {ids}` · `DELETE /api/admin/banners/:id`；
  `POST /api/admin/upload`（后台 token，multipart 字段 `file`，只收图片 ≤ 5MB）→ `{ url }`。

## F. 动态

- 图片最多 9 张（不变）。存相对路径、返回绝对地址。列表照小红书做双列瀑布流：第一张图作封面，没图的显示成文字卡片。

## G. 演示数据

- 默认标签和 3 张轮播图（苍山日出 → 苍山看日出那个局；洱海骑行 → 广场；新人第一次来 → 社区公约）。
- 局和动态配图：用 `design/illustrations/*.svg` 渲染成 PNG（放 `server/seed-assets/`，提交到仓库），seed 时复制进上传目录。动态至少 8 条，大多带 1–4 张图。
- 苍山看日出的 AA 改为阿野一次声明 ¥150（车费 + 早餐）；群聊里那句改成阿野说「车费和早餐我先垫了，一起记在 AA 里，最后大家转我就行」。
- 每个局都有合理的最晚退出时间。

## H. 插画

- `design/illustrations/<key>.svg`，统一的扁平风格（纯色、无渐变），比例 3:2（viewBox 0 0 600 400），大理主题：
  `sunrise`（苍山日出）、`mountain`（山路徒步）、`cycling`（洱海骑行）、`lake`（洱海）、`coffee`（咖啡）、`reading`（读书）、`food`（吃饭）、`boardgame`（桌游）、`carpool`（拼车）、`oldtown`（古城）。
- 小程序：局没有图片时用对应插画当封面；首页分类宫格用同一套插画的小图。

## I. 小程序交互要求（工业级）

- 时间、地点、标签、性别、最晚退出时间都用我们自己风格的底部弹窗（圆角白底、深湖蓝主按钮、取消 / 确定在底部或顶部明显位置），不用系统原生选择器的默认样式；时间精确到分钟。
- 地点弹窗：输入框 + 大理常用地点快捷选（古城南门、古城北门、人民路、才村码头、喜洲古镇、双廊、苍山索道）+「在地图上选」（`wx.chooseLocation`）+ 明显的「确定」。
- 加入：「加入」→ 确认弹窗（局的时间、地点、费用、最晚退出时间 + 免责声明）→「同意并加入」→
  不是最后一个人：「已加入，还差 N 人成群。人齐了第一时间通知你」（并请求订阅消息）；最后一个人：「满员啦，群已建好」→「进入群聊」。撮合成功页的「加入这个局」走同一个确认。
- 过了最晚退出时间，「退出这个局」变灰，写明原因。
- 广场顶部分类栏吸顶、不跟着滑走，点选时不跳动；首页按钮文字「帮我选择 · …」。
- 列表都有骨架屏 / 加载 / 空状态 / 失败重试；图片懒加载、点开可以左右滑看大图。

免责声明文案（加入确认弹窗用，可微调）：

> 活动由参与者自发组织，平台只提供信息撮合，不组织、不收费，也不对活动中的人身和财产安全承担责任。请选择公共场所见面，量力而行，注意安全；费用由大家自行 AA 结算。报名即表示你同意《社区公约》。
