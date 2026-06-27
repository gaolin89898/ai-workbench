# 构建阶段
FROM golang:1.22-alpine AS builder

WORKDIR /build

# 国内服务器走 goproxy.cn，避免 proxy.golang.org 被墙
ENV GOPROXY=https://goproxy.cn,direct
ENV GOSUMDB=off

# 复制 go.mod 和源码
COPY backend/go.mod backend/go.sum* ./
COPY backend/ ./

# 下载依赖 + 编译
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /ai-workbench-server ./cmd/server

# 运行阶段
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app
COPY --from=builder /ai-workbench-server .
COPY backend/migrations ./migrations

EXPOSE 3000

ENV PORT=3000
ENV MIGRATIONS_DIR=./migrations

CMD ["./ai-workbench-server"]
