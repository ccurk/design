# 活动搭子 · 微信小程序

帮大理的慢热旅人凑「局」：说出想做的事，平台撮合，满员自动建群，结束后互评履约（信用分）。

原生小程序（WXML / WXSS / JS），**没有框架、没有 npm、不需要构建**。基础库 ≥ 3.0.0。
界面按 `design/app/*.dc.html` 的 24 张设计稿实现，数据全部来自后端接口（约定见 `docs/api.md`）。

---

## 一、本地跑起来

### 1. 先启动后端

```bash
cd server
npm install
npm run seed     # 写入演示数据（栗子、阿野、小满……苍山看日出等）
npm start        # 默认 http://localhost:3000
```

### 2. 用微信开发者工具打开

1. 打开「微信开发者工具」→ **导入项目** → 目录选 `miniprogram/`。
2. AppID：
   - 没有自己的小程序：选 **测试号**，或保留 `project.config.json` 里的占位 `touristappid`（游客模式）。
   - 有自己的 AppID：填上即可（手机号验证、订阅消息等能力需要正式 AppID，见第五节）。
3. 右上角 **详情 → 本地设置**，勾选 **「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」**。
   （`project.config.json` 里已经设置了 `"urlCheck": false`，一般会自动勾上。）
4. 点「编译」。开发模式下启动时会自动用演示账号「栗子」登录（`POST /api/auth/dev-login`）。

> 想体验新用户引导（欢迎页 → 选兴趣）：把 `config.js` 里的 `devLogin` 改成 `false` 后重新编译（token 按登录方式分开缓存，会自动重新登录）。
> 后端没配 `WX_APPID` 时是开发模式，`wx.login` 的 code 直接拼成 openid，于是会新建一个没完成引导的用户（token 存在本机，之后再启动还是这个用户）。
> 这一步要用测试号或自己的 AppID，游客模式（`touristappid`）下 `wx.login` 可能拿不到 code。
> 也可以保持 `devLogin: true`，把 `devUserId` 设成其他演示用户的 id（如 `3` = 阿野）换个身份看。

### 3. 真机预览

- 手机和电脑连同一个 Wi-Fi，把 `config.js` 的 `baseURL` 改成电脑的局域网地址，如 `http://192.168.1.8:3000`。
- 后端启动时设置 `PUBLIC_BASE_URL=http://192.168.1.8:3000`，否则上传图片返回的地址是 `localhost`，手机上看不到。
- 预览时在小程序右上角「···」里打开 **开发调试**，否则真机会校验合法域名。

---

## 二、配置项（`config.js`）

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `baseURL` | `http://localhost:3000` | 后端地址；上线必须是 HTTPS 合法域名 |
| `devLogin` | `true` | `true`：启动调用 `/api/auth/dev-login`；手机号验证失败也允许继续。`false`：`wx.login` → `/api/auth/login` |
| `devUserId` | `null` | 开发模式下用哪个演示用户登录，`null` = 栗子 |
| `subscribeTemplates.match` | `''` | 订阅消息模板 id：撮合结果 |
| `subscribeTemplates.reminder` | `''` | 订阅消息模板 id：开始提醒 / 轻确认出席 |
| `subscribeTemplates.report` | `''` | 订阅消息模板 id：举报处理结果 |

模板 id 留空时，点「开启提醒」只会提示「已开启」，不会真的弹出订阅授权。

---

## 三、页面对照

| 设计稿 | 页面 | 说明 |
| --- | --- | --- |
| Login | `pages/login/login` | 欢迎页；手机号快速验证（`open-type="getPhoneNumber"` → `/api/auth/phone`）；先随便看看 → 广场 |
| Interests | `pages/interests/interests` | 选兴趣 + 社交节奏，保存后完成引导 |
| Main | `pages/home/home`（tab 撮合） | 想做的事 + 什么时候 → 生成意向；正在为你撮合 |
| Waiting | `pages/waiting/waiting?id=<intentId>` | 撮合进度、放宽条件、开启提醒、取消意向；被邀请后自动跳到撮合成功 |
| Matching | `pages/match/match?eventId=` | 加入这个局 / 换一批（回到撮合中）/ 看看详情 |
| Detail | `pages/detail/detail?id=` | 局详情、加入 / 申请 / 进群 / 去评价；发起人处理报名、取消局；可分享 |
| Group | `pages/group/group?id=<eventId>` | 群聊（页面可见时每 3 秒拉新消息）、破冰话题、集合小任务「我到了」、报平安、AA / 照片 / 位置 |
| GroupInfo | `pages/group-info/group-info?id=` | 成员、AA、免打扰、举报、退出（24 小时内提示临时鸽） |
| AA | `pages/aa/aa?id=` | 记一笔、谁该转给谁、我已转账 / 确认收到 |
| UserProfile | `pages/user/user?id=` | 他人主页、共同点、最近的局、举报、拉黑 |
| Report | `pages/report/report?targetType=&targetId=` | 原因、说明、截图（最多 3 张）、同时拉黑 |
| Square | `pages/square/square`（tab 广场） | 分类筛选、下拉刷新、触底加载 |
| Search | `pages/search/search` | 大家在搜、最近搜过（存本机）、结果 |
| Create | `pages/create/create` | 发起局：时间 `picker`、地点 `wx.chooseLocation`（打不开时改为文字输入） |
| Feed | `pages/feed/feed`（tab 动态） | 点赞、··· 举报 / 不看 TA / 删除自己的 |
| Comments | `pages/post/post?id=` | 动态详情、评论、回复 |
| Compose | `pages/compose/compose` | 发动态：文字、照片（最多 6 张）、关联局、谁能看到 |
| Messages | `pages/inbox/inbox`（tab 消息） | 需要你处理（轻确认出席 / 撮合成功 / 去评价）、局聊、通知 |
| MyEvents | `pages/my-events/my-events?tab=ongoing\|ended\|created` | 进行中（含撮合中的意向）/ 已结束 / 我发起的 |
| Review | `pages/review/review?id=` | 准时 / 迟到 / 没来 + 整体感受 |
| Profile | `pages/me/me`（tab 我的） | 资料、信用（含信用记录与申诉）、我的局、安全设置、公约、联系客服 |
| EditProfile | `pages/edit-profile/edit-profile` | 头像、昵称、简介、兴趣、节奏、性别 |
| Safety | `pages/safety/safety` | 同性局、报平安、主页可见、紧急联系人、黑名单、一键 110 |
| Rules | `pages/rules/rules?section=pact\|credit\|privacy` | 社区公约、信用怎么算、隐私与安全 |

原生能力的对应：手机号快速验证、`picker`（日期 / 时间）、`wx.chooseLocation`、`wx.chooseMedia` + `wx.uploadFile`（`/api/upload`）、
群聊「位置」（选点后作为文字发出）、群聊「照片」（转到发动态，可选只给同局的人看）、`<button open-type="contact">` 联系客服、
`wx.makePhoneCall` 拨打 110、局详情 `onShareAppMessage` 分享、`wx.requestSubscribeMessage` 订阅提醒、`wx.showActionSheet` / `wx.showModal`。

---

## 四、目录与约定

```
app.js / app.json / app.wxss   启动登录、全局配置、设计令牌（CSS 变量）与通用样式类
config.js                      运行配置
custom-tab-bar/                自定义底部导航（选中项：洱海蓝胶囊）
components/                    dz-avatar 头像 · dz-cover 封面插画 · dz-empty 空状态 · dz-switch 开关
                               dz-event-card 广场卡片 · dz-post-card 动态卡片
utils/request.js               wx.request 封装：Bearer token、401 自动重新登录一次、失败 toast error.message
utils/api.js                   所有接口（路径与 docs/api.md 对应）
utils/format.js                北京时间、标签、金额
utils/session.js / nav.js / upload.js / native.js / posts.js
assets/icons, assets/covers    SVG 图标与封面（由 tools/gen-assets.js 生成，小程序的 SVG 不支持 currentColor，所以每种颜色一个文件）
tools/gen-assets.js            重新生成 SVG：node tools/gen-assets.js
tools/check.js                 静态检查：node tools/check.js
```

- 尺寸：1 设计 px ≈ 2rpx（设计稿宽 390）。
- 导航栏用微信默认导航栏；广场 / 动态 / 消息的大标题保留在页面里。
- `tools/` 和 `README.md` 已在 `project.config.json` 的 `packOptions.ignore` 里，不会打进小程序包。

### 静态检查

```bash
node tools/check.js
```

会检查：所有 json 能解析；页面 / 组件四件套齐全；每个 js 过 `node --check`；WXML 标签配对；
所有跳转地址指向真实页面（tab 页只能 `switchTab`）；引用的 `/assets/...` 都存在；调用的接口路径和方法都在 `docs/api.md` 里；
WXML 绑定的事件处理函数都有定义；用到的组件都已注册。

---

## 五、上线前要在微信侧准备的事

1. **服务器域名**：在小程序后台「开发管理 → 开发设置 → 服务器域名」把后端域名加到 request 和 uploadFile 合法域名。
   必须是 **HTTPS**，域名需要完成 **ICP 备案**。上传图片返回的地址（后端 `PUBLIC_BASE_URL`）也要用这个域名。
   然后把 `config.js` 的 `baseURL` 改成该域名、`devLogin` 改成 `false`。
2. **后端**：配置 `WX_APPID` / `WX_SECRET`，`NODE_ENV=production`（开发登录 `dev-login` 会自动关闭）。
3. **手机号快速验证**：`getPhoneNumber` 需要 **非个人主体（企业等）且完成微信认证** 的小程序，并按调用次数计费；个人主体或测试号拿不到手机号。
4. **订阅消息**：在后台「订阅消息」里选用模板（撮合结果、活动提醒、举报处理结果），把模板 id 填进 `config.js` 的 `subscribeTemplates`，后端推送也要用同样的模板。
5. **服务类目与资质**：这是带用户互动（动态、评论、群聊）的社交类小程序，选择「社交」相关类目时需要提交对应资质（以微信后台当前要求为准）。
6. **用户隐私保护指引**：在后台填写，声明会用到的手机号、相册 / 拍照（选图上传）、位置（选择集合地点）、剪贴板（复制消息）等。
   `app.json` 已在 `requiredPrivateInfos` 里声明 `chooseLocation`。
7. **客服**：「联系客服」用的是 `<button open-type="contact">`，需要在后台开启客服功能并绑定客服人员。

---

## 六、已知限制

- 放宽条件用 `PUT /api/intents/:id`：`wx.request` 不支持 `PATCH`，`tools/check.js` 会拦下任何 `patch(...)` 调用。
- 群聊只支持文字（接口只有 `text`）：「位置」以文字形式发出；「照片」引导去发动态（可设为只给同局的人看）。
- 群聊用 3 秒轮询，没有用 WebSocket；离开页面即停止。
- 「开启提醒」的开关状态存在本机；没有配置订阅消息模板时只是提示。
