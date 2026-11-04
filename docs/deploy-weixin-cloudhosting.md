# 后端部署：微信云托管

把 `server/`（Node 后端，顺带托管 `admin/` 后台）部署到**微信云托管**。选它的原因：
**自带 HTTPS 公网域名、这个域名天生能被小程序调用**，所以你「有 AppID、没备案域名」也能直接上——
**省掉自己买域名 + ICP 备案的那一大坨事**。

> 配套文件（已在仓库里）：根目录 `Dockerfile`、`.dockerignore`。
> 小程序侧一键切生产：`miniprogram/config.js` 的 `PROD` 开关。

---

## ⚠️ 两个必须先懂的点（SQLite + 容器）

本项目用 **SQLite（单文件数据库）**。放进容器有两条硬约束，配错 = 丢数据：

1. **只能单实例**：SQLite 是单文件、单写入。云托管默认会自动扩容到多实例，多个实例各写各的文件 →
   **数据分裂**。所以服务的实例数必须设 **最小 1 / 最大 1**，关掉自动扩缩容。
   （好处：你的定时任务——每日发局、过期解散、提醒——也需要一个常驻实例才会跑，正好一致。）
2. **必须挂持久盘**：容器磁盘是临时的，**每次重新部署都会重置**。数据库和上传的图片必须放到
   **持久化挂载盘**。`Dockerfile` 已把 `DB_PATH=/data/dazi.db`、`UPLOAD_DIR=/data/uploads` 指到
   `/data`，你在云托管里**挂一个持久盘到 `/data`** 即可。不挂 = 每次发版数据清零。

> 这两条是 launch 期够用的方案。等你用户量大了，SQLite 单实例是瓶颈，到时再迁到云托管的
> **MySQL / 托管数据库**（要改 `server/src/db.js` 的数据层，是另一个工程）。

---

## 步骤

### 1. 开通云托管、建环境
- 小程序后台（mp.weixin.qq.com）→ 左侧「**云托管**」→ 开通 → 新建一个**环境**（如 `prod`）。

### 2. 新建服务，用本仓库的 Dockerfile
- 新建服务（如 `dazi-api`）。
- 代码来源：接 Git 仓库，或本地上传。
- **构建方式选 Dockerfile**，**Dockerfile 路径 = `Dockerfile`（在仓库根目录）**，
  **构建目录 = 仓库根目录**（这样才能同时打包 `server/` 和 `admin/`）。

### 3. 服务配置（关键，按下面设）
- **监听端口**：`3000`（和 Dockerfile 的 `EXPOSE 3000` 一致）。
- **实例数**：**最小 1、最大 1**（SQLite 单写，必须；也保证定时任务常驻）。
- **持久化存储**：开一个**文件存储 / 持久盘**，**挂载到 `/data`**。
- **规格**：最小规格够起步（0.25C/0.5G 之类），以后再调。

### 4. 环境变量（在服务的「环境变量」里加）
| 变量 | 值 | 说明 |
|---|---|---|
| `NODE_ENV` | `production` | **必须**。生产会自动禁用 dev-login、强制要 ADMIN_PASSWORD |
| `ADMIN_PASSWORD` | 你的后台密码 | **必须**，不设后台登录不了 |
| `WX_APPID` | 你的小程序 AppID | 真实 `wx.login` 需要 |
| `WX_SECRET` | 小程序 AppSecret | 小程序后台「开发管理 → 开发设置」里拿 |
| `PUBLIC_BASE_URL` | 本服务的公网 https 域名 | 图片等返回**绝对地址**要用它（见第 6 步拿到域名后回填） |

> `DB_PATH` / `UPLOAD_DIR` 已在 Dockerfile 设好（`/data/...`），不用再配。

### 5. 部署
- 点部署，等构建+发布完成。看日志有没有报错（启动会打印警告提醒你 dev 接口状态等）。

### 6. 拿公网域名，回填 PUBLIC_BASE_URL
- 服务里开启「**公网访问**」，得到一个 https 域名（形如 `https://dazi-api-xxxx.ap-shanghai.app.tcloudbase.com`）。
- 把它填回**环境变量 `PUBLIC_BASE_URL`**，再重新部署一次（让图片绝对地址正确）。

### 7. 首次初始化数据（只做一次）
- 在云托管服务的「**控制台 / 终端**」里进容器，执行：
  ```bash
  npm run seed:cold
  ```
  这会建**运营号 + 冷启动的运营局/历史撑场面数据**（挂了持久盘才会留存）。
- 后台登录：`https://你的公网域名/`（admin 由后端托管），用 `ADMIN_PASSWORD` 登录。

### 8. 小程序指向生产
1. 改 `miniprogram/config.js`：
   - `const PROD = true;`
   - `prodBaseURL` 填第 6 步的公网 https 域名。
2. 小程序后台「开发管理 → 开发设置 → **服务器域名**」把这个域名加到：
   **request、uploadFile、downloadFile** 合法域名。
3. 用微信开发者工具**预览 / 上传体验版**验证（取消勾选「不校验合法域名」后仍正常，才算对）。
4. 一切 OK → 提交审核、发布，流程见 [`docs/launch-weixin.md`](./launch-weixin.md)。

---

## 验证清单
- [ ] 服务实例数 = 最小 1 / 最大 1
- [ ] 持久盘挂到 `/data`，重新部署后数据还在（发个测试局，重部署，看还在不在）
- [ ] `NODE_ENV=production`、`ADMIN_PASSWORD`、`WX_APPID`、`WX_SECRET`、`PUBLIC_BASE_URL` 都配了
- [ ] 公网域名能打开后台、小程序能登录（真实 `wx.login`，不是 dev-login）
- [ ] 图片能正常上传和显示（`PUBLIC_BASE_URL` 对了）
- [ ] 域名已加进小程序「服务器域名」白名单

---

## 可选增强（以后再说）
- **云调用免域名**：云托管支持小程序用 `wx.cloud.callContainer` 直连容器，**免服务器域名白名单、更安全**，
  但要改 `miniprogram/utils/request.js` 的请求层。本期先用公网域名直连，够用；以后想更稳再切。
- **对象存储**：上传图片量大后，`/data/uploads` 可改用云存储（COS），减轻持久盘压力。
- **数据库升级**：用户量上来后 SQLite 单实例换成托管 MySQL（改数据层）。
