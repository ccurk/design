# 活动搭子后端 —— 微信云托管部署镜像
# 构建上下文 = 仓库根目录（这样能同时拷到 server/ 和 admin/，后台由 Node 直接服务）。
FROM node:22-slim

WORKDIR /app

# 先装依赖，利用镜像层缓存（package 没变就不重装）
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

# 后端源码 + 后台静态文件（admin 免构建，直接由后端托管）
COPY server/ ./server/
COPY admin/ ./admin/

WORKDIR /app/server

ENV NODE_ENV=production
ENV PORT=3000
# 数据库用 MySQL（微信云托管里开一个 MySQL 实例，拿内网连接信息）。
# 以下连接参数不要写死在镜像里，请在云托管「服务设置 → 环境变量」里配置：
#   MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE
# （MYSQL_PASSWORD 建议用云托管的「敏感环境变量」存。库不存在时应用不会自动建，
#   请先在云托管 MySQL 控制台建好 MYSQL_DATABASE 指定的库。）
#
# 上传的图片仍写本地目录；多实例时本地盘不共享，正式环境请改用对象存储（COS），
# 或给 /data 挂一个所有实例共享的持久盘。单实例可直接用挂载盘：
ENV UPLOAD_DIR=/data/uploads
EXPOSE 3000

# npm start = node --no-warnings src/index.js
CMD ["npm", "start"]
