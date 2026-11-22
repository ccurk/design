#!/usr/bin/env bash
# 把测试用的 MySQL 跑起来（容器/worker 重启后用它恢复）。幂等。
set -e

# 1) dockerd
if ! docker info >/dev/null 2>&1; then
  echo "启动 dockerd…"
  (dockerd >/tmp/dockerd.log 2>&1 &)
  for i in $(seq 1 15); do docker info >/dev/null 2>&1 && break; sleep 1; done
fi

# 2) 镜像（重启后会丢，按需重拉；docker.io 偶发 429，重试几次）
if ! docker images --format '{{.Repository}}:{{.Tag}}' | grep -q '^mysql:8.0$'; then
  echo "拉取 mysql:8.0（约 1GB，可能要等）…"
  for i in 1 2 3 4 5; do docker pull mysql:8.0 && break || { echo "第 $i 次失败，等 10s 重试"; sleep 10; }; done
fi

# 3) 容器
if ! docker ps --format '{{.Names}}' | grep -q '^dazi-mysql$'; then
  docker rm -f dazi-mysql >/dev/null 2>&1 || true
  docker run -d --name dazi-mysql \
    -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=dazi \
    -p 3306:3306 mysql:8.0 --default-authentication-plugin=mysql_native_password >/dev/null
fi

# 4) 等就绪
echo -n "等待 MySQL 就绪"
for i in $(seq 1 60); do
  if docker exec dazi-mysql mysqladmin ping -uroot -proot --silent >/dev/null 2>&1; then echo " —— OK"; exit 0; fi
  echo -n "."; sleep 2
done
echo " —— 超时"; exit 1
