# 活动搭子 · 微信小程序

帮大理的慢热旅人凑「局」：说出想做的事，平台撮合，人齐了自动建群，结束后互评履约（信用分）。

原生小程序（WXML / WXSS / JS），**没有框架、没有 npm、不需要构建**。基础库 ≥ 3.0.0。
界面按 `design/app/*.dc.html` 的 24 张设计稿实现，数据全部来自后端接口（约定见 `docs/api.md`，v0.3 改动见 `docs/changes-v0.3.md`）。

**v0.3（真机实测反馈后的「工业级」改版）**：首页轮播图 + 插画分类宫格 + 约搭子弹窗（上午 / 下午 / 晚上 / 都可以，或精确到分钟的时间段，可选日期，「帮我选择 · …」）+ 大家最近在玩 + 还差人的局；
标签 = 后台热门标签 + 自己添加；局的封面优先用照片，没有就用标签插画（`assets/covers/`）；发起局的时间、地点、标签、谁可以报名（女 / 男 / 不限）、最晚退出时间都是自己风格的底部弹窗，介绍可插快捷短语、最多 9 张照片；
加入先确认（含免责声明），结果分「还差 N 人成群」和「满员啦，群已建好 → 进入群聊」，群聊只在成群后开启，过了最晚退出时间「退出这个局」变灰并写明原因；
广场标签栏吸顶；动态改成双列瀑布流，详情左右滑看大图；AA 改成一次声明（垫钱的人记总数，大家平摊转给他）；时间冲突等长提示用弹窗说清楚。

---

## 一、本地跑起来

### 1. 先启动后端

```bash
cd server
npm install
npm run seed     # 写入演示数据（栗子、阿野、小满……苍山看日出、轮播图、热门标签、配图等）
npm start        # 默认 http://localhost:3000
```

演示数据里的照片（轮播图、局和动态的配图）由后端以绝对地址返回（`PUBLIC_BASE_URL`，默认 `http://localhost:<端口>`），开发者工具里直接能看到。

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
| `subscribeTemplates.formed` | `''` | 订阅消息模板 id：成群通知（加入后人齐了提醒，「同意并加入」时请求） |
| `subscribeTemplates.reminder` | `''` | 订阅消息模板 id：开始提醒 / 轻确认出席 |
| `subscribeTemplates.report` | `''` | 订阅消息模板 id：举报处理结果 |

模板 id 留空时，点「开启提醒」只会提示「已开启」，加入局时也不会弹订阅授权。

---

## 三、页面对照

| 设计稿 | 页面 | 说明 |
| --- | --- | --- |
| Login | `pages/login/login` | 欢迎页；手机号快速验证（`open-type="getPhoneNumber"` → `/api/auth/phone`）；先随便看看 → 广场 |
| Interests | `pages/interests/interests` | 选兴趣 + 社交节奏，保存后完成引导 |
| Main | `pages/home/home`（tab 撮合） | 轮播图（`/api/home`，点了按 link 跳转）、插画宫格（热门标签 + 更多 + 自己添加）→ 约搭子弹窗（想做的事 / 哪天：今天·明天·本周末·选日期 / 几点：上午·下午·晚上·都可以·指定时间段）→「帮我选择 · …」；近 7 天人气；正在为你撮合；大家最近在玩；这些局还差人；自己发起入口 |
| Waiting | `pages/waiting/waiting?id=<intentId>` | 标签插画、意向标题（含时间段）、撮合进度、放宽条件、开启提醒、取消意向；被邀请后自动跳到撮合成功 |
| Matching | `pages/match/match?eventId=` | 「加入这个局」走和局详情一样的确认弹窗 → 还差 N 人 / 满员进群；换一批；看看详情 |
| Detail | `pages/detail/detail?id=` | 照片轮播（点开看大图）或标签插画；时间、地点（有坐标可打开地图）、费用、最晚退出时间；加入确认弹窗；已加入没成群时底部是进度 +「邀请朋友」；退出这个局（过了最晚退出时间变灰并写原因）/ 撤回申请；发起人处理报名、取消局；可分享 |
| Group | `pages/group/group?id=<eventId>` | 只在成群后开启（之前显示还差几人 + 邀请朋友）；顶部 AA 卡片（谁垫付、每人多少、我要转给谁）；破冰话题、集合小任务、报平安、照片 / 位置；3 秒轮询 |
| GroupInfo | `pages/group-info/group-info?id=` | 成员、AA（谁垫付多少、几笔待转）、免打扰、举报、退出（过了最晚退出时间变灰并写原因） |
| AA | `pages/aa/aa?id=` | 每个局一笔：垫钱的人一次记下总金额 + 包含什么 → 每人多少、谁转给谁 → 我已转账 / 确认收到；有人转账前记账人能改或撤回 |
| UserProfile | `pages/user/user?id=` | 他人主页、共同点、最近的局、举报、拉黑 |
| Report | `pages/report/report?targetType=&targetId=` | 原因、说明、截图（最多 3 张，带上传进度）、同时拉黑 |
| Square | `pages/square/square`（tab 广场） | 标签栏吸顶（全部 + 热门标签，`?tag=` 筛选，切换时列表不跳）、照片优先的卡片、骨架屏、下拉刷新、触底加载、失败重试 |
| Search | `pages/search/search` | 大家在搜、最近搜过（存本机）、结果（带封面和标签） |
| Create | `pages/create/create?tag=` | 发起局：玩什么（热门标签 + 自己添加）、标题建议、开始时间 / 集合地点 / 最晚退出时间 / 谁可以报名都是底部弹窗，人数、至少几人成群、费用、需要我同意、介绍一下（快捷短语）+ 最多 9 张照片 |
| Feed | `pages/feed/feed`（tab 动态） | 双列瀑布流（第一张图作封面，没图是文字卡片）、点赞、长按 ··· 举报 / 不看 TA / 删除自己的 |
| Comments | `pages/post/post?id=` | 图片左右滑（点开看大图）、正文、来自哪个局、评论、回复 |
| Compose | `pages/compose/compose` | 发动态：文字、照片（最多 9 张，逐张上传进度）、关联局、谁能看到 |
| Messages | `pages/inbox/inbox`（tab 消息） | 需要你处理（轻确认出席 / 撮合成功 / 去评价）、局聊、通知 |
| MyEvents | `pages/my-events/my-events?tab=ongoing\|ended\|created` | 进行中（含撮合中的意向）/ 已结束 / 我发起的；成群的才能「去群聊」 |
| Review | `pages/review/review?id=` | 准时 / 迟到 / 没来 + 整体感受 |
| Profile | `pages/me/me`（tab 我的） | 资料、信用（含信用记录与申诉）、我的局、安全设置、公约、联系客服 |
| EditProfile | `pages/edit-profile/edit-profile` | 头像、昵称、简介、兴趣、节奏、性别 |
| Safety | `pages/safety/safety` | 同性局、报平安、主页可见、紧急联系人、黑名单、一键 110 |
| Rules | `pages/rules/rules?section=pact\|credit\|privacy` | 社区公约、信用怎么算、隐私与安全 |

原生能力的对应：手机号快速验证、`picker-view`（放在自己的底部弹窗里选日期 / 时 / 分）、`wx.chooseLocation` / `wx.openLocation`、
`wx.chooseMedia` + `wx.uploadFile`（`/api/upload`，`onProgressUpdate` 显示进度）、`swiper` + `wx.previewImage`（照片左右滑、看大图）、
群聊「位置」（选点后作为文字发出）、群聊「照片」（转到发动态，可选只给同局的人看）、`<button open-type="contact">` 联系客服、
`wx.makePhoneCall` 拨打 110、局详情 / 群聊 `onShareAppMessage` 分享（`<button open-type="share">` 邀请朋友）、`wx.requestSubscribeMessage` 订阅提醒、`wx.showActionSheet` / `wx.showModal`。

### 交互约定（v0.3）

- **底部弹窗一家人**：`dz-sheet` 是统一外壳（圆角白底、标题 + 关闭、底部「取消 / 确定」，深湖蓝主按钮）；时间（`dz-datetime-sheet`，精确到分钟）、时间段（`dz-timerange-sheet`）、日期（`dz-date-sheet` 月历）、地点（`dz-place-sheet`：输入框 + 大理常用地点 +「在地图上选」）、标签（`dz-tag-sheet`）、加入确认（`dz-join-sheet`）、AA（`dz-aa-sheet`）都基于它；「谁可以报名」「最晚退出时间」直接用 `dz-sheet` 写在发起页里。不用系统选择器的默认样式。首页弹窗打开时隐藏底部导航，免得挡住按钮。
- **封面**：`dz-cover` 有照片用第一张，没有用标签的插画（`coverKey` → `assets/covers/<key>.svg`），照片加载失败也退回插画。
- **主页背景**：「我的」和他人主页用 `dz-profile-cover`，页面是自定义导航栏（`navigationStyle: custom`），背景铺到状态栏下面；自己上传的照片优先，没有就用第一个兴趣的插画。往上滑过背景后出现带名字的顶栏；状态栏在浅色插画上用黑字，照片 / 深色插画上用白字并压暗顶部。「我的」点背景或「更换背景」换图（换过的可以恢复默认），编辑资料里也能换；他人主页左上角有返回，点照片看大图。
- **加载**：首屏用 `dz-skeleton` 骨架屏（形状接近真实内容）；失败给原因 + 重试；列表都能下拉刷新、触底加载（加载失败点一下重试）；刷新 / 切换筛选时先保留旧列表，回来再替换，不闪不跳。
- **错误提示**：`utils/request.js` 的 `showError`：短的用 toast；`CONFLICT`（时间重叠、过了最晚退出时间、已经有人记过 AA……）和长消息用弹窗，标题按内容给「时间冲突了」「不能退出了」「换个标签吧」等。
- **触控**：可点的元素至少 44px（88rpx）。



---

## 四、目录与约定

```
app.js / app.json / app.wxss   启动登录、全局配置、设计令牌（CSS 变量）与通用样式类
config.js                      运行配置
custom-tab-bar/                自定义底部导航（选中项：洱海蓝胶囊）
components/                    dz-avatar 头像 · dz-cover 封面（照片 / 插画）· dz-profile-cover 主页背景 + 顶栏 · dz-empty 空状态 · dz-switch 开关 · dz-skeleton 骨架屏
                               dz-event-card 局卡片 · dz-note-card 瀑布流动态卡片 · dz-uploader 多图上传
                               dz-sheet 底部弹窗外壳 · dz-datetime-sheet / dz-timerange-sheet / dz-date-sheet / dz-place-sheet /
                               dz-tag-sheet / dz-join-sheet / dz-aa-sheet
utils/request.js               wx.request 封装：Bearer token、401 自动重新登录一次、失败 toast error.message
utils/api.js                   所有接口（路径与 docs/api.md 对应）
utils/format.js                北京时间、标签（规范化、默认热门、插画 key）、时间段、金额
utils/session.js / nav.js / upload.js / native.js / posts.js
assets/icons                   SVG 线性图标（小程序的 SVG 不支持 currentColor，所以每种颜色一个文件）
assets/covers                  10 张大理主题插画（从 design/illustrations 复制）+ 登录页大图
tools/gen-assets.js            重新生成图标、复制插画：node tools/gen-assets.js
tools/check.js                 静态检查：node tools/check.js
tools/e2e/                     端到端检查（wx mock + 真实后端）：node tools/e2e/e2e.js
```

- 尺寸：1 设计 px ≈ 2rpx（设计稿宽 390）。
- 导航栏用微信默认导航栏；广场 / 动态 / 消息的大标题保留在页面里。
- `tools/` 和 `README.md` 已在 `project.config.json` 的 `packOptions.ignore` 里，不会打进小程序包。

### 静态检查

```bash
node tools/check.js
```

会检查：所有 json 能解析；页面 / 组件四件套齐全；每个 js 过 `node --check`；WXML 标签配对；
所有跳转地址指向真实页面（tab 页只能 `switchTab`）；引用的 `/assets/...` 都存在；调用的接口路径和方法都在 `docs/api.md` 里（`docs/changes-v0.3.md` 删掉的接口会报错）；
页面里调用的 `api.xxx()` 在 `utils/api.js` 里都有；WXML 绑定的事件处理函数都有定义；用到的组件都已注册。

### 端到端检查（可选）

`tools/e2e/` 用一个很小的 wx mock 原样加载页面和组件代码，请求真的发到后端，按用户的操作调用页面方法并检查结果
（首页约搭子、发起局的各个弹窗和上传、加入 → 还差 N 人 / 满员进群、撮合页加入、时间重叠 409、广场标签筛选、瀑布流和图片轮播、AA 记账转账确认、申请 → 同意、退出 / 取消、过了最晚退出时间不能退出……共 136 项）。
需要一个**刚 seed 过**的开发库（会改数据，并用 `/api/dev/clock` 临时穿越时间，结束时复原），上传目录放到临时目录，不要写进 `server/uploads`：

```bash
cd server
DB_PATH=/tmp/dz-e2e.db UPLOAD_DIR=/tmp/dz-e2e-uploads node --no-warnings scripts/seed.js
DB_PATH=/tmp/dz-e2e.db UPLOAD_DIR=/tmp/dz-e2e-uploads PORT=3500 node --no-warnings src/index.js
# 另开一个终端
cd miniprogram
BASE=http://localhost:3500 node tools/e2e/e2e.js
```

---

## 五、上线前要在微信侧准备的事

1. **服务器域名**：在小程序后台「开发管理 → 开发设置 → 服务器域名」把后端域名加到 request 和 uploadFile 合法域名。
   必须是 **HTTPS**，域名需要完成 **ICP 备案**。上传图片返回的地址（后端 `PUBLIC_BASE_URL`）也要用这个域名。
   然后把 `config.js` 的 `baseURL` 改成该域名、`devLogin` 改成 `false`。
2. **后端**：配置 `WX_APPID` / `WX_SECRET`，`NODE_ENV=production`（开发登录 `dev-login` 会自动关闭）。
3. **手机号快速验证**：`getPhoneNumber` 需要 **非个人主体（企业等）且完成微信认证** 的小程序，并按调用次数计费；个人主体或测试号拿不到手机号。
4. **订阅消息**：在后台「订阅消息」里选用模板（撮合结果、成群通知、活动提醒、举报处理结果），把模板 id 填进 `config.js` 的 `subscribeTemplates`，后端推送也要用同样的模板。
5. **服务类目与资质**：这是带用户互动（动态、评论、群聊）的社交类小程序，选择「社交」相关类目时需要提交对应资质（以微信后台当前要求为准）。
6. **用户隐私保护指引**：在后台填写，声明会用到的手机号、相册 / 拍照（选图上传）、位置（选择集合地点）、剪贴板（复制消息）等。
   `app.json` 已在 `requiredPrivateInfos` 里声明 `chooseLocation`。
7. **客服**：「联系客服」用的是 `<button open-type="contact">`，需要在后台开启客服功能并绑定客服人员。

---

## 六、已知限制

- 放宽条件用 `PUT /api/intents/:id`：`wx.request` 不支持 `PATCH`，`tools/check.js` 会拦下任何 `patch(...)` 调用。
- 瀑布流不知道图片尺寸：封面先按 1:1 占位，加载后按真实比例显示，新加载的卡片按两列的实际高度分配（已经放好的卡片不再挪动）。
- 「在地图上选」需要用户同意隐私协议里的位置信息；打不开地图时可以直接输入地点或点常用地点（这时没有坐标，详情页不显示「地图」）。
- 群聊只支持文字（接口只有 `text`）：「位置」以文字形式发出；「照片」引导去发动态（可设为只给同局的人看）。
- 群聊用 3 秒轮询，没有用 WebSocket；离开页面即停止。
- 「开启提醒」的开关状态存在本机；没有配置订阅消息模板时只是提示。
