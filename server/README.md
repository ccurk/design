# 活动搭子 · 后端（server/）

给「活动搭子」微信小程序（`miniprogram/`）和后台管理（`admin/`）提供接口。接口与业务规则以 [`docs/api.md`](../docs/api.md) 为准，本文只说明怎么跑、怎么配、代码在哪。

- 运行环境：Node.js ≥ 22.5（内置 `node:sqlite`，不需要编译任何原生依赖）
- 技术栈：Express 5 + multer（上传）+ SQLite，纯 JavaScript（ES Modules），没有构建步骤

## 快速开始

```bash
cd server
npm install
npm run seed     # 清空数据库并写入演示数据（data/dazi.db）
npm run dev      # 开发模式启动，改代码自动重启（npm start 为普通启动）
```

启动后：

- 健康检查：<http://localhost:3000/api/health>
- 后台页面：<http://localhost:3000/admin/>（由 `admin/` 目录提供，默认密码 `admin123`）
- 演示登录：`POST /api/auth/dev-login`，不传 `userId` 即登录演示账号「栗子」

```bash
curl -s -X POST localhost:3000/api/auth/dev-login -H 'Content-Type: application/json' -d '{}'
# → { "token": "u_...", "user": { "nickname": "栗子", ... }, "isNew": false }
curl -s localhost:3000/api/inbox -H "Authorization: Bearer <token>"
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `npm start` | 启动服务（含定时任务） |
| `npm run dev` | 同上，`node --watch` 自动重启 |
| `npm run seed` | 清空数据库并写入演示数据。生产环境需要加 `-- --force` |
| `npm test` | 单元 + 接口测试（`node:test`，内存数据库，不会动 `data/`） |
| `npm run smoke` | 内存数据库 + 演示数据，随机端口启动，用 HTTP 走一遍主流程并打印 PASS / FAIL |

所有脚本都带 `--no-warnings`，用来屏蔽 `node:sqlite` 的 ExperimentalWarning。

## 环境变量

复制 `.env.example` 为 `.env` 即可，启动时会自动读取（已存在的环境变量优先）。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` 时关闭开发接口（dev-login、时间穿越）、禁用微信开发模式 |
| `PORT` | `3000` | HTTP 端口 |
| `DB_PATH` | `data/dazi.db` | SQLite 文件路径（相对 `server/`），目录会自动创建；`:memory:` 为内存库 |
| `ADMIN_PASSWORD` | 开发环境 `admin123` | 后台登录密码。没设置时开发环境会打警告；**生产环境不设置会拒绝启动** |
| `WX_APPID` / `WX_SECRET` | 空 | 小程序 AppID / AppSecret。不填 = 开发模式（见下） |
| `PUBLIC_BASE_URL` | `http://localhost:PORT` | 拼接上传图片 URL 用，生产环境填对外的 https 域名 |
| `UPLOAD_DIR` | `uploads` | 上传目录 |
| `ADMIN_DIR` | `../admin` | 后台前端目录，挂在 `/admin/*`，找不到文件时回退到 `index.html` |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `JOBS` | 开 | `JOBS=off` 时不启动定时任务 |
| `TRUST_PROXY` | 不信任 | 放在 Nginx 等反向代理后面时填（同机代理填 `loopback`，或填代理层数），后台登录限流才能按用户真实 IP 计 |

## 目录结构

```
server/
├── src/
│   ├── index.js          入口：读配置、开库、启动 HTTP 和定时任务
│   ├── app.js            createApp({ db, config })：Express 应用（CORS、静态文件、错误处理）
│   ├── config.js         环境变量与 .env 读取
│   ├── db.js             node:sqlite 封装：建表、语句缓存、事务（可嵌套）
│   ├── clock.js          全局时钟 clock.now()；测试 / 演示可以设置「现在」
│   ├── time.js           北京时间工具：「周六 05:50」「今天」「本周末」、时间段标签
│   ├── auth.js           用户 token / 后台 token（两套会话表，互不通用）
│   ├── moderation.js     内容审核 checkText(text) → { ok, reasons }
│   ├── wechat.js         code2Session / getPhoneNumber / sendSubscribeMessage（占位）
│   ├── jobs.js           定时任务：撮合每 5 分钟；提醒 + 邀请到期每分钟
│   ├── seed.js           seed(db)：演示数据（时间相对「现在」生成）
│   ├── constants.js      分类、任务、破冰话题等常量
│   ├── errors.js / validate.js / logger.js
│   ├── routes/           路由层（只做参数解析，业务在 services/）
│   │   ├── account.js    登录、我的资料、安全设置、信用记录、他人主页、拉黑
│   │   ├── matching.js   撮合意向、撮合结果
│   │   ├── events.js     广场、局、群聊、AA、互评、搜索
│   │   ├── social.js     动态、举报、上传、消息中心
│   │   ├── admin.js      /api/admin/*
│   │   └── dev.js        /api/dev/*（仅非生产环境）
│   └── services/         业务逻辑
│       ├── credit.js     信用计算、自动受限
│       ├── matchRules.js 撮合规则：兼容性、人数、日期、匹配度 / 理由 / 风险
│       ├── matching.js   撮合引擎、建议局（后台）
│       ├── invites.js    确认成局、邀请、接受 / 换一批、补邀、邀请到期
│       ├── events.js     局的视图、可见性、广场、报名、退出、轻确认
│       ├── chat.js / aa.js / reviews.js / posts.js / reports.js / appeals.js
│       ├── intents.js / intentFormat.js / myEvents.js / inbox.js / profile.js
│       ├── reminders.js  轻确认 / 去评价 / 报平安提醒
│       └── admin.js / settings.js / notices.js / users.js
├── scripts/seed.js · scripts/smoke.js
├── test/                 node:test 测试（helpers.js 提供内存库 + HTTP 工具）
├── data/                 SQLite 数据库（不提交）
└── uploads/              上传的图片（不提交），通过 /uploads/* 访问
```

## 开发模式

没配置 `WX_APPID` / `WX_SECRET`，且 `NODE_ENV` 不是 `production` 时：

- `POST /api/auth/login {code}`：不请求微信，openid = `dev_<code>`。同一个 code 就是同一个用户，方便模拟多个人。
- `POST /api/auth/phone {code}`：随机生成一个 138 开头的手机号。
- `POST /api/auth/dev-login {userId?}`：直接登录某个用户，不传则登录「栗子」。
- 时间穿越（演示「局结束后」「邀请过期」等场景）：
  - `GET /api/dev/clock` 查看服务端的「现在」
  - `POST /api/dev/clock {now: "2026-11-01T02:00:00Z"}` 跳到某个时间点（之后照常走）；`{advanceMinutes: 90}` 往后拨；`{reset: true}` 回到真实时间
  - `POST /api/dev/tick {match?: true}` 立刻跑一遍每分钟的定时任务（提醒、邀请到期），`match: true` 时连撮合一起跑

演示账号（`npm run seed` 后）：

| userId | 昵称 | 说明 |
| --- | --- | --- |
| 1 | 栗子 | 演示主账号：「周六清晨 · 苍山看日出」已成局（群聊 + AA），「桌游夜」待评价，「周日 · 洱海边骑行」撮合中，拉黑了大鹏 |
| 2–5 | 小满 / 阿野 / 七七 / 木木 | 苍山看日出的同伴；阿野在待确认的爬山建议里；木木有 1 条待处理申诉 |
| 6 | 大鹏 | 被举报、受限 7 天，有 2 条待处理举报和 1 个待审核的局 |
| 7 | 南风 | 也想周日下午骑行（再来 1 个人就能成局） |
| 8–11 | 小林 / 阿云 / 青青 / 老周 | 撮合池里的人：小林、老周和阿野组成待确认的爬山建议；阿云、青青明天下午想喝咖啡 |

演示数据里的时间都相对「现在」生成（比如苍山看日出永远是下一个周六 05:50），所以任何时候 seed 都是新鲜的。

## 业务实现要点

- **时间**：接口里的时间点都是 ISO-8601 UTC；「今天」「周六」「上午」等按北京时间（固定 +08:00）计算，与服务器时区无关。
- **撮合**：提交意向时、后台点「立即撮合」时、以及每 5 分钟各跑一次。先给有人「换一批」的撮合局补邀，再按提交时间贪心组新队。后台退回的组合（同任务、同日期、同一组人）不会再被原样推荐。
- **邀请期限**：每个被邀请人 min(邀请后 24 小时, 开场前 12 小时)。到期视为放弃（成员 `declined`，意向 `expired`）；人够 `min_size` 就成局，否则取消并把意向退回撮合池。
- **信用**：按未撤销的 `credit_events` 实时计算；互评每提交一次就重算全组结果（同一人同一局只保留一条记录）。
- **可见性**：撮合局只有成员能看；广场只有 `open` 的用户局 / 平台局；和你有拉黑关系的人发起或参加的局、动态、评论都不会出现在你这里。
- **通知 `link` 约定**：`match:<eventId>` 撮合成功页、`event:<eventId>` 局详情、`chat:<eventId>` 群聊、`review:<eventId>` 互评、`post:<postId>` 动态、`credit` 我的信用记录，`null` 表示不跳转。
- **通知 `type`**：`match` `formed` `match_failed` `attendance` `review` `safe` `event_cancelled` `event_approved` `event_rejected` `application` `application_result` `join` `leave` `post_approved` `post_rejected` `comment` `aa_paid` `aa_confirmed` `report_result` `warning` `restricted` `unrestricted` `banned` `unbanned` `appeal_result`。

### 对 docs/api.md 的补充（都是向后兼容的新增）

- 多返回了一些字段：`EventDetail` 有 `endAt`、`fullDateLabel`、`isHost`、`minSize`；他人主页有 `creditNote`（「最近一次临时鸽是 3 个月前……」）；`Me` 有 `phoneMasked`、`restrictedUntil`；`GET /api/inbox` 多一个 `unread: {actions, chats, notices, total}`；聊天列表项有 `muted`；`GET /api/events/:id/messages` 多 `chatOpen`；撮合结果的 `members` 带 `status`、`isMe`；后台列表带 `flags`（审核命中原因）等。
- 新增接口：`DELETE /api/mutes/:userId`、`POST /api/notices/read-all`，以及开发用的 `/api/dev/*`。
- `POST /api/intents` 可选 `label`（意向的展示名，如「洱海边骑行」）、`relaxTime`、`relaxSize`。
- `avatarColor` 按 `id % 4` 依次取 `slate / accent / ink / stone`（与文档示例和设计稿一致：1 栗子 = accent，3 阿野 = stone）；`avatarText` 一般取第一个字，「阿 / 小 / 老 / 大」开头的取第二个字（阿野 → 野，与文档示例一致）。
- `icebreaker.index` 从 0 开始。
- 撮合局默认人数上限 = 配到的人数，`min_size` = min(3, 人数)。
- 生产环境（`NODE_ENV=production`）没配微信时不会退回开发模式，登录会直接报错，避免任何人用任意 openid 登录。

## 上线需要准备的微信配置

1. **AppID / AppSecret**：微信公众平台 → 小程序 → 开发管理 → 开发设置。填到 `WX_APPID`、`WX_SECRET`（只放在服务器环境变量里，不要写进代码或提交到仓库）。
2. **服务器域名**：在「开发设置 → 服务器域名」里把后端的 https 域名加到 `request` 合法域名，上传图片还要加到 `uploadFile` / `downloadFile` 合法域名。`PUBLIC_BASE_URL` 设成同一个 https 地址。
3. **手机号快速验证**：小程序需要完成认证才能使用 `getPhoneNumber`（服务端调用 `wxa/business/getuserphonenumber`，access_token 已做缓存和过期重试）。
4. **订阅消息**（可选，后续接入）：在「功能 → 订阅消息」申请模板（撮合成功、出席确认、评价提醒等），再在 `src/wechat.js` 的 `sendSubscribeMessage` 里调用 `cgi-bin/message/subscribe/send`。目前只记日志。
5. **内容安全**（可选，后续接入）：`src/wechat.js` 里留了 `msgSecCheck` 钩子，可以在 `moderation.js` 的规则之外再调用微信内容安全接口。

生产部署清单：`NODE_ENV=production`、`ADMIN_PASSWORD`（足够长的随机串；同一 IP 15 分钟内输错 10 次会被锁到这 15 分钟结束）、`WX_APPID` / `WX_SECRET`、`PUBLIC_BASE_URL`，前面用 Nginx 之类做 HTTPS 反向代理并设 `TRUST_PROXY=loopback`；定期备份 `data/dazi.db`（WAL 模式，备份时连同 `-wal` 文件一起，或用 `sqlite3 .backup`）。

## 测试

```bash
npm test         # 80+ 个用例：信用、撮合、邀请流程、局的生命周期、互评结算、AA、审核、举报、鉴权、定时任务、演示数据
npm run smoke    # 主流程冒烟：登录 → 意向 → 撮合 → 确认 → 加入 → 群聊 → AA → 时间穿越 → 互评 → 信用更新
```

测试用 `createApp({ db: openDb(':memory:') })` + `app.listen(0)`，通过 `fetch` 走真实 HTTP；时间用 `clock.set()` 固定在北京时间某个周一 10:00，结果不受运行时刻和机器时区影响。
