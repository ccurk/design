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
# DB 和上传目录指向持久化挂载盘 /data（云托管里务必挂一个持久盘到 /data，否则重新部署数据丢失）
ENV DB_PATH=/data/dazi.db
ENV UPLOAD_DIR=/data/uploads
EXPOSE 3000

# npm start = node --no-warnings src/index.js（--no-warnings 屏蔽 node:sqlite 的实验警告）
CMD ["npm", "start"]
