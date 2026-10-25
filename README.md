# 活动搭子

大理的兴趣局撮合小程序，给慢热的人（i 人）用：不用发帖、不用先开口，说出想做的事和时间，系统配好同频的人，运营过目确认后发出邀请，大家都点「加入」就自动成群。

- 最小单位是「人 + 一件想做的事」，和民宿无关。
- 只组兴趣局：不做交友约会，不擦边、不推销、不经手钱（AA 只记账）。
- 用信用代替押金：信用只看守不守约（准时、迟到、临时鸽、放鸽子），提前 24 小时以上说去不了不扣分；一个月放鸽子 2 次暂停撮合 7 天。

## 仓库里有什么

| 目录 | 内容 |
| --- | --- |
| [`miniprogram/`](miniprogram/README.md) | 微信小程序，原生 WXML / WXSS / JS，不用构建，24 个页面 |
| [`server/`](server/README.md) | 后端：Node.js 22 + Express + SQLite。撮合引擎、信用规则、定时提醒、内容审核 |
| [`admin/`](admin/README.md) | 运营后台：Vue 3，不用构建，由后端挂在 `/admin/` |
| [`docs/api.md`](docs/api.md) | 三端共用的接口与业务规则 |
| `design/` | 设计稿：`app/` 是小程序 24 页，`admin/` 是后台 6 页 |

可以点着走的设计画布：<https://claude.ai/artifact/G8FdkQfAPt8d3nA8P6M3Yq>，需求文档：<https://claude.ai/artifact/45SBAFipaH33D5a9kRveNu>。这两个链接默认只有作者本人能打开，要给别人看，先在页面右上角的 Share 里共享。

## 本地跑起来

需要 Node.js 22.5 以上和[微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)。

```bash
cd server
npm install
npm run seed     # 写入演示数据：栗子、阿野、小满……苍山看日出、桌游夜等
npm run dev      # http://localhost:3000
```

- **后台**：浏览器打开 <http://localhost:3000/admin/>，开发环境密码 `admin123`。
- **小程序**：微信开发者工具 → 导入项目 → 选 `miniprogram/` 目录 → AppID 选测试号 → 右上角「详情 → 本地设置」勾选「不校验合法域名……」→ 编译。开发模式会自动用演示账号「栗子」登录。

### 走一遍核心流程：系统配好 → 你确认 → 自动成群

1. 打开后台的「撮合池」，种子数据里已经有一个系统配好的方案「周日上午 · 一起爬山」（阿野、小林、老周），能看到匹配度、为什么配到一起和风险提示。
2. 点「确认成局」，可以顺手改标题、时间、地点、集合点，然后「发出邀请」。
3. 把 `miniprogram/config.js` 里的 `devUserId` 改成 `3`（阿野）重新编译，在「消息」里会看到「撮合成功」，点进去「加入这个局」。
4. 再分别用 `8`（小林）和 `11`（老周）加入。全员加入后自动建群，群里第一条是「满员啦，群已自动建好 · 第一次见面，慢慢来」。

栗子自己的意向「周日 · 洱海边骑行」还差 1 个人，首页能看到「撮合中」。

## 测试

```bash
cd server && npm test        # 接口与业务规则测试
cd server && npm run smoke   # 起一个临时服务，用 HTTP 走一遍主流程
node miniprogram/tools/check.js   # 小程序静态检查：页面、跳转、资源、事件、接口都对得上
node admin/tools/e2e.mjs     # 后台端到端测试：用浏览器把后台每个操作点一遍（先按 admin/README.md 起一个演示数据的后端，需要 Playwright）
```

## 上线前需要准备

| 事项 | 说明 |
| --- | --- |
| 小程序账号 | 在微信公众平台注册小程序，拿到 AppID / AppSecret，填到服务器环境变量 `WX_APPID`、`WX_SECRET`。手机号快速验证（`getPhoneNumber`）需要完成认证 |
| 服务类目 | 社交类小程序可能要求额外资质，提交审核前先查一下类目要求 |
| 服务器和域名 | 国内云服务器 + 已备案（ICP）的域名 + HTTPS 证书。在小程序后台把这个域名加进 `request`、`uploadFile`、`downloadFile` 合法域名 |
| 后端配置 | `NODE_ENV=production`、`ADMIN_PASSWORD`（足够长的随机串）、`PUBLIC_BASE_URL`（对外的 https 地址）；放在 Nginx 后面时加 `TRUST_PROXY=loopback`。详见 [`server/README.md`](server/README.md) |
| 小程序配置 | `miniprogram/config.js` 的 `baseURL` 改成 https 域名，`devLogin` 改成 `false` |
| 订阅消息 | 在小程序后台申请模板（撮合结果、出席提醒、举报结果），把模板 id 填进 `config.js`；后端 `src/wechat.js` 里的发送目前只记日志 |
| 隐私与客服 | 填写用户隐私保护指引（手机号、相册、位置），开通客服 |
| 数据备份 | 定期备份 `server/data/dazi.db` |

## 现在还没有的

- 微信订阅消息和微信内容安全接口只留了接口位置，还没真正调用；内容审核目前靠关键词。
- 群聊只支持文字，每 3 秒刷新一次（没有用 WebSocket）。
- 后台只有一个共用密码，没有分账号和操作日志。
- 定时任务跑在服务进程里，只适合单台服务器；上传的图片存在本机磁盘。
