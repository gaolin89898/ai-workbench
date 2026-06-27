# 构建阶段
FROM golang:1.22-alpine AS builder

WORKDIR /build

# 复制 go.mod 和源码
COPY backend/go.mod backend/go.sum* ./
COPY backend/ ./

# 下载依赖 + 编译
RUN go mod download 2>/dev/null || true
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
