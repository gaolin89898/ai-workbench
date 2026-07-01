# 后端运维手册

Go 后端通过 Docker Compose 部署在生产服务器上，由 PostgreSQL 17 + Go 单二进制组成。

## 部署架构

| 组件 | 镜像 | 说明 |
| --- | --- | --- |
| postgres | `postgres:17` | 数据持久化到 named volume `postgres-data` |
| server | 本地构建 `ai-workbench-server` | 基于根目录 `Dockerfile` 构建 Go 后端运行镜像 |

编排文件：[docker-compose.prod.yml](../docker-compose.prod.yml)

> `backend/Dockerfile.runtime` 和 `backend/docker-compose.prod.yml` 是后端运行镜像的备用/历史部署文件；当前根目录生产部署主路径使用根目录 [docker-compose.prod.yml](../docker-compose.prod.yml)。
密钥文件：服务器上 `/opt/ai-workbench/.env`（权限 600，不入库）

## 服务器信息

| 项 | 值 |
| --- | --- |
| 地址 | `8.162.12.148` |
| 系统 | Ubuntu 24.04 |
| 项目目录 | `/opt/ai-workbench` |
| 监听端口 | `3000` |
| 数据卷 | `ai-workbench_postgres-data` |

> 阿里云安全组需放行 3000/tcp 入方向，否则外部无法访问。

## 首次部署

### 1. 服务器准备

```bash
# 安装 Docker（若未安装）
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

# 国内服务器配置镜像加速
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://dockerproxy.com",
    "https://docker.mirrors.ustc.edu.cn",
    "https://docker.nju.edu.cn"
  ]
}
EOF
systemctl restart docker
```

### 2. 拉取代码

```bash
cd /opt
git clone https://github.com/gaolin89898/ai-workbench.git ai-workbench
cd ai-workbench
```

### 3. 生成密钥

```bash
# 生成随机密钥写入 .env
PG_PASS=$(openssl rand -hex 16)
JWT_SEC=$(openssl rand -hex 32)
printf 'POSTGRES_PASSWORD=%s\nJWT_SECRET=%s\n' "$PG_PASS" "$JWT_SEC" > .env
chmod 600 .env

# 校验（仅显示前缀，确认已写入）
sed 's/=.*/=***/' .env
```

### 4. 开放防火墙

```bash
ufw allow 3000/tcp
ufw reload
```

同时在阿里云控制台 → ECS → 安全组 → 入方向添加 TCP 3000 放行规则。

### 5. 构建并启动

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

构建约需 5–8 分钟（首次需下载 Go 依赖，走 goproxy.cn）。启动后等待 postgres 健康检查通过，server 容器自动启动。

### 6. 验证

```bash
# 容器状态
docker ps --format "table {{.Names}}\t{{.Status}}"

# 本机健康检查
curl http://localhost:3000/health
# 期望：{"status":"ok"}

# 外部访问（在本机执行）
curl http://8.162.12.148:3000/health
```

## 日常运维

### 查看日志

```bash
# 实时跟随
docker logs -f ai-workbench-server-1

# 最近 100 行
docker logs --tail 100 ai-workbench-server-1

# 指定时间之后
docker logs --since 30m ai-workbench-server-1

# PostgreSQL 日志
docker logs --tail 50 ai-workbench-postgres-1
```

### 重启服务

```bash
cd /opt/ai-workbench
docker compose -f docker-compose.prod.yml restart server
```

### 停止 / 启动

```bash
docker compose -f docker-compose.prod.yml stop
docker compose -f docker-compose.prod.yml start
```

### 完全卸载（保留数据）

```bash
docker compose -f docker-compose.prod.yml down
# 删除数据卷（危险，会丢失所有数据）
# docker volume rm ai-workbench_postgres-data
```

## 更新部署

代码推送到 main 分支后，在服务器上执行：

```bash
cd /opt/ai-workbench
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

Docker 会自动复用缓存层，仅重新构建变更部分。数据库迁移由 server 启动时自动执行（读取 `MIGRATIONS_DIR=./migrations`）。

## 数据库运维

### 进入 psql

```bash
docker exec -it ai-workbench-postgres-1 psql -U remote_term -d remote_term
```

### 备份

```bash
# 逻辑备份（建议每天一次，配合 cron）
docker exec ai-workbench-postgres-1 pg_dump -U remote_term -d remote_term \
  | gzip > /opt/backup/remote_term_$(date +%Y%m%d).sql.gz

# 保留最近 7 天
find /opt/backup -name "remote_term_*.sql.gz" -mtime +7 -delete
```

### 恢复

```bash
gunzip -c /opt/backup/remote_term_20260627.sql.gz \
  | docker exec -i ai-workbench-postgres-1 psql -U remote_term -d remote_term
```

### 查看迁移状态

```bash
docker exec -it ai-workbench-postgres-1 psql -U remote_term -d remote_term \
  -c "SELECT version, applied_at FROM schema_migrations ORDER BY version;"
```

## 配置变更

环境变量在 [docker-compose.prod.yml](../docker-compose.prod.yml) 的 `server.environment` 段定义，密钥从 `.env` 注入：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 由 `.env` 拼接 | PostgreSQL 连接串 |
| `JWT_SECRET` | 由 `.env` 提供 | JWT 签名密钥 |
| `PORT` | `3000` | HTTP 监听端口 |
| `MIGRATIONS_DIR` | `./migrations` | 迁移文件目录 |
| `CORS_ORIGINS` | `*` | 允许的跨域来源，生产建议改为具体域名 |

修改后需重启：`docker compose -f docker-compose.prod.yml up -d`

## 常见问题

### 构建时 `go: downloading ... i/o timeout`

`proxy.golang.org` 被墙。根目录 Dockerfile 已配置国内 Go 代理；若仍失败，先检查服务器 DNS 和 Docker 网络。

### 外部访问 502 / 超时

1. 本机 `curl http://localhost:3000/health` 是否正常 → 排查容器
2. `ufw status` 是否放行 3000 → 排查系统防火墙
3. 阿里云安全组是否放行 3000 → 排查云安全组

### 容器反复重启

```bash
docker logs ai-workbench-server-1 --tail 50
```

常见原因：
- DATABASE_URL 错误 → 检查 `.env` 是否存在且 `POSTGRES_PASSWORD` 与 postgres 容器一致
- 迁移文件缺失 → 确认 `backend/migrations` 已挂载
- 端口占用 → `ss -tlnp | grep 3000`

### 内存不足

1.6GB 内存服务器在构建期可能 OOM。临时添加 swap：

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

## 应急联系

- 代码仓库：https://github.com/gaolin89898/ai-workbench
- 健康检查：`GET /health`
- 协议规范：[docs/protocol.md](protocol.md)
