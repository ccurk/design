# 后端部署：微信云托管

把 `server/`（Node 后端，顺带托管 `admin/` 后台）部署到**微信云托管**。选它的原因：
**自带 HTTPS 公网域名、这个域名天生能被小程序调用**，所以你「有 AppID、没备案域名」也能直接上——
**省掉自己买域名 + ICP 备案的那一大坨事**。而且它自带**托管 MySQL**，后端直接内网连，省心。

> 配套文件（已在仓库里）：根目录 `Dockerfile`、`.dockerignore`。
> 小程序侧一键切生产：`miniprogram/config.js` 的 `PROD` 开关。

---

## ⚠️ 先懂三个点（MySQL + 容器 + 定时任务）

本项目数据库用 **MySQL**（`mysql2` 连接池）。放进云托管要把下面三件事配对，否则连不上 / 丢数据 / 重复发局：

1. **开一个云托管 MySQL，并建好库**。在云托管控制台开 MySQL 实例，拿到**内网**连接信息
   （host / port / user / password），**先在控制台里建好一个数据库**（名字随意，比如 `dazi`）。
   然后把连接信息配到服务的环境变量 `MYSQL_*`（见第 4 步）。生产环境应用**不会**自动建库，必须先建好。
   → 并发问题到此解决：单个实例靠连接池就能安全地同时处理很多请求，不再有 SQLite「单写锁 / 写坏文件」那一套。

2. **上传的图片仍写本地盘**，数据库不再占本地盘了。图片目录 `UPLOAD_DIR=/data/uploads`，
   **单实例**时在云托管**挂一个持久盘到 `/data`** 即可（不挂 = 每次发版图片清零）。
   多实例时本地盘各存各的、互相看不到，正式放量后请改用**对象存储 COS**（见文末「可选增强」）。

3. **定时任务只能有一个实例在跑**。每日发运营局、过期解散、提醒这些 cron 在进程内用定时器跑。
   如果开多实例、每个实例都跑，会**重复发提醒 / 重复撮合**（每日发局本身按天幂等，重复无害，但其它不是）。
   所以：**要么单实例**（最省事，launch 期推荐）；**要么多实例但只让一个跑 cron**——
   给多出来的实例设环境变量 **`JOBS=off`**，只留一个实例不设（或设 `JOBS=on`）来跑定时任务。

> 一句话：**MySQL 让「单实例内的并发」从此安全**，这是这次迁移的目的；横向扩多实例是额外的扩容手段，
> 届时记得用 `JOBS=off` 把 cron 收敛到一个实例。launch 期用**单实例 + MySQL**就够，简单又稳。

---

## 步骤

### 1. 开通云托管、建环境、开 MySQL
- 小程序后台（mp.weixin.qq.com）→ 左侧「**云托管**」→ 开通 → 新建一个**环境**（如 `prod`）。
- 在云托管里**开一个 MySQL 实例**，记下**内网** host / port / user / password；
  进 MySQL 控制台**建一个数据库**（如 `dazi`，字符集 `utf8mb4`）。

### 2. 新建服务，用本仓库的 Dockerfile
- 新建服务（如 `dazi-api`）。
- 代码来源：接 Git 仓库，或本地上传。
- **构建方式选 Dockerfile**，**Dockerfile 路径 = `Dockerfile`（在仓库根目录）**，
  **构建目录 = 仓库根目录**（这样才能同时打包 `server/` 和 `admin/`）。

### 3. 服务配置（关键，按下面设）
- **监听端口**：`3000`（和 Dockerfile 的 `EXPOSE 3000` 一致）。
- **实例数**：launch 期设 **最小 1 / 最大 1**（最省事，cron 自然只有一个在跑）。
  以后要扛更大流量再加实例，并给多出来的实例设 `JOBS=off`（见上面第 3 点）。
- **持久化存储**：开一个**文件存储 / 持久盘**，**挂载到 `/data`**（只给上传图片用；数据库在 MySQL 里，不占这盘）。
- **规格**：最小规格够起步（0.25C/0.5G 之类），以后再调。

### 4. 环境变量（在服务的「环境变量」里加）
| 变量 | 值 | 说明 |
|---|---|---|
| `NODE_ENV` | `production` | **必须**。生产会自动禁用 dev-login、强制要 ADMIN_PASSWORD |
| `ADMIN_PASSWORD` | 你的后台密码 | **必须**，不设后台登录不了 |
| `MYSQL_HOST` | MySQL 内网地址 | **必须**，第 1 步拿到 |
| `MYSQL_PORT` | `3306` | MySQL 端口（默认 3306） |
| `MYSQL_USER` | MySQL 用户名 | **必须** |
| `MYSQL_PASSWORD` | MySQL 密码 | **必须**，建议用云托管的「**敏感环境变量**」存 |
| `MYSQL_DATABASE` | 你建的库名（如 `dazi`） | **必须**，要和第 1 步建的库一致 |
| `WX_APPID` | 你的小程序 AppID | 真实 `wx.login` 需要 |
| `WX_SECRET` | 小程序 AppSecret | 小程序后台「开发管理 → 开发设置」里拿 |
| `PUBLIC_BASE_URL` | 本服务的公网 https 域名 | 图片等返回**绝对地址**要用它（见第 6 步拿到域名后回填） |

> `UPLOAD_DIR` 已在 Dockerfile 设为 `/data/uploads`，不用再配。
> 若将来多实例，记得给额外实例加 `JOBS=off`。

### 5. 部署
- 点部署，等构建+发布完成。看日志：启动会打印 `…已启动（MySQL <host>:<port>/<db>）`，
  连不上 MySQL 会直接报错——先把 `MYSQL_*` 和「库建好了没」检查一遍。

### 6. 拿公网域名，回填 PUBLIC_BASE_URL
- 服务里开启「**公网访问**」，得到一个 https 域名（形如 `https://dazi-api-xxxx.ap-shanghai.app.tcloudbase.com`）。
- 把它填回**环境变量 `PUBLIC_BASE_URL`**，再重新部署一次（让图片绝对地址正确）。

### 7. 首次初始化数据（只做一次）
- 在云托管服务的「**控制台 / 终端**」里进容器，执行：
  ```bash
  npm run seed:cold
  ```
  这会建**运营号 + 冷启动的运营局/历史撑场面数据**（写进 MySQL，持久保留）。
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
- [ ] 云托管 MySQL 已开，库已建好（`MYSQL_DATABASE` 指定的那个）
- [ ] `MYSQL_HOST/PORT/USER/PASSWORD/DATABASE` 都配了，启动日志打印连上了 MySQL
- [ ] `NODE_ENV=production`、`ADMIN_PASSWORD`、`WX_APPID`、`WX_SECRET`、`PUBLIC_BASE_URL` 都配了
- [ ] 持久盘挂到 `/data`，重新部署后上传的图片还在
- [ ] 若多实例：只有一个实例在跑 cron（其余 `JOBS=off`）
- [ ] 公网域名能打开后台、小程序能登录（真实 `wx.login`，不是 dev-login）
- [ ] 图片能正常上传和显示（`PUBLIC_BASE_URL` 对了）
- [ ] 域名已加进小程序「服务器域名」白名单

---

## 可选增强（以后再说）
- **云调用免域名**：云托管支持小程序用 `wx.cloud.callContainer` 直连容器，**免服务器域名白名单、更安全**，
  但要改 `miniprogram/utils/request.js` 的请求层。本期先用公网域名直连，够用；以后想更稳再切。
- **对象存储**：上传图片量大、或要多实例时，`/data/uploads` 改用云存储（COS），
  图片就不依赖本地盘，多实例也能共享。
- **横向扩容**：流量上来后把实例数调大（MySQL 连接池能扛并发），
  记得给额外实例设 `JOBS=off`，让每日发局 / 提醒 / 撮合只在一个实例上跑；
  再大可以把 cron 拆成一个独立的「worker」服务（只它 `JOBS=on`，API 服务全 `JOBS=off`）。
