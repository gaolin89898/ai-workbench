package routes

import (
	"net"
	"net/http"
	"sync"
	"time"
)

// 简单的内存固定窗口限流：按客户端 IP 限制请求速率，超限返回 429。
// 防止公开接口（注册、登录、配对、OAuth）被暴力请求刷爆。
// 生产环境应配合反向代理（nginx 等）做更细粒度的限流。

type rateBucket struct {
	count   int
	resetAt time.Time
}

type rateLimiter struct {
	mu       sync.Mutex
	buckets  map[string]*rateBucket
	limit    int
	window   time.Duration
	lastGC   time.Time
	seenKeys map[string]bool
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	return &rateLimiter{
		buckets:  make(map[string]*rateBucket),
		limit:    limit,
		window:   window,
		lastGC:   time.Now(),
		seenKeys: make(map[string]bool),
	}
}

// allow 返回该 IP 在窗口内是否还有配额。
func (l *rateLimiter) allow(ip string) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()

	// 定期清理过期桶，避免 map 无限增长。
	if now.Sub(l.lastGC) > l.window {
		for key, bucket := range l.buckets {
			if now.After(bucket.resetAt) {
				delete(l.buckets, key)
				delete(l.seenKeys, key)
			}
		}
		l.lastGC = now
	}

	bucket, ok := l.buckets[ip]
	if !ok || now.After(bucket.resetAt) {
		bucket = &rateBucket{count: 1, resetAt: now.Add(l.window)}
		l.buckets[ip] = bucket
		l.seenKeys[ip] = true
		return true
	}
	bucket.count++
	return bucket.count <= l.limit
}

func clientIP(r *http.Request) string {
	// 优先取 X-Forwarded-For（反代场景），否则用 RemoteAddr。
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		if ip := net.ParseIP(forwarded); ip != nil {
			return ip.String()
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// rateLimitMiddleware 对全部请求做 IP 限流；健康检查放行。
func rateLimitMiddleware(limiter *rateLimiter, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			next.ServeHTTP(w, r)
			return
		}
		if !limiter.allow(clientIP(r)) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":"rate limited"}`))
			return
		}
		next.ServeHTTP(w, r)
	})
}
