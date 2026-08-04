package routes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/gaolin89898/ai-workbench/backend/internal/auth"
)

// newTestHandler builds a Handler without DB/State/Mailer. Tests only cover
// code paths that short-circuit before touching the DB (health, auth wall,
// CORS, unknown routes). DB-backed handler tests require PostgreSQL and are
// covered by integration tests.
func newTestHandler() *Handler {
	return &Handler{Secret: "test-secret"}
}

func doRequest(h *Handler, method, path string, opts ...func(*http.Request)) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	for _, opt := range opts {
		opt(req)
	}
	rec := httptest.NewRecorder()
	h.Router().ServeHTTP(rec, req)
	return rec
}

// generateTestToken signs an access token for a random user/device.
func generateTestToken(t *testing.T, secret string) (string, error) {
	t.Helper()
	return auth.GenerateAccessToken(uuid.New().String(), uuid.New().String(), secret)
}

func TestHealth(t *testing.T) {
	rec := doRequest(newTestHandler(), http.MethodGet, "/health")
	if rec.Code != http.StatusOK {
		t.Fatalf("health status = %d, want 200", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("health body not json: %v", err)
	}
	if body["status"] != "ok" {
		t.Errorf("health status field = %q, want ok", body["status"])
	}
}

func TestAuthedRoutesRejectMissingToken(t *testing.T) {
	h := newTestHandler()
	protected := []string{
		"/providers",
		"/devices",
		"/devices/device-1/sessions",
		"/ai-sessions/session-1",
		"/activity-logs",
		"/settings",
		"/app/releases",
		"/token-usage/summary",
		"/admin/users",
	}
	for _, path := range protected {
		rec := doRequest(h, http.MethodGet, path)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("GET %s = %d, want 401", path, rec.Code)
		}
	}
}

func TestAuthedRoutesRejectInvalidToken(t *testing.T) {
	h := newTestHandler()
	rec := doRequest(h, http.MethodGet, "/devices", func(r *http.Request) {
		r.Header.Set("Authorization", "Bearer not-a-jwt")
	})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("invalid token status = %d, want 401", rec.Code)
	}
}

func TestAuthedRoutesRejectMalformedAuthHeader(t *testing.T) {
	h := newTestHandler()
	rec := doRequest(h, http.MethodGet, "/devices", func(r *http.Request) {
		// "Token" prefix (not "Bearer ") must be rejected — case-sensitive
		// prefix match mirrors Rust's strip_prefix.
		r.Header.Set("Authorization", "Token abc")
	})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("malformed auth header status = %d, want 401", rec.Code)
	}
}

func TestAuthedRoutesAcceptValidToken(t *testing.T) {
	// A valid token must pass the auth wall and reach the handler. We test
	// the middleware directly with a stub handler to avoid DB access.
	token, err := generateTestToken(t, "test-secret")
	if err != nil {
		t.Fatalf("generate token: %v", err)
	}
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if id := auth.UserIDFromContext(r.Context()); id == "" {
			t.Error("user id missing from context after middleware")
		}
		w.WriteHeader(http.StatusOK)
	})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	auth.AuthMiddleware("test-secret", next).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("valid token status = %d, want 200", rec.Code)
	}
}

func TestCORSPreflight(t *testing.T) {
	rec := doRequest(newTestHandler(), http.MethodOptions, "/auth/login")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want *", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Methods"); !strings.Contains(got, "OPTIONS") {
		t.Errorf("Access-Control-Allow-Methods = %q, want to include OPTIONS", got)
	}
}

func TestCORSHeadersOnRegularResponse(t *testing.T) {
	rec := doRequest(newTestHandler(), http.MethodGet, "/health")
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want *", got)
	}
}

func TestUnknownRoute(t *testing.T) {	h := newTestHandler()

	t.Run("without token hits the auth wall first", func(t *testing.T) {
		// Unknown paths fall through to the "/" root handler, which is wrapped
		// in AuthMiddleware — so an unauthenticated unknown route is 401.
		rec := doRequest(h, http.MethodGet, "/no-such-route")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("unknown route status = %d, want 401 (auth wall)", rec.Code)
		}
	})

	t.Run("with valid token returns 404", func(t *testing.T) {
		token, err := generateTestToken(t, h.Secret)
		if err != nil {
			t.Fatalf("generate token: %v", err)
		}
		rec := doRequest(h, http.MethodGet, "/no-such-route", func(r *http.Request) {
			r.Header.Set("Authorization", "Bearer "+token)
		})
		if rec.Code != http.StatusNotFound {
			t.Fatalf("unknown route with token status = %d, want 404", rec.Code)
		}
	})
}

func TestRateLimit(t *testing.T) {
	h := newTestHandler()
	// 每个 Router() 新建限流器：构造一个只允许 3 次/窗口的实例。
	limiter := newRateLimiter(3, time.Minute)
	_ = h

	// 直接验证限流器本身，避免依赖路由行为。
	if !limiter.allow("10.0.0.1") || !limiter.allow("10.0.0.1") || !limiter.allow("10.0.0.1") {
		t.Fatal("first three requests should be allowed")
	}
	if limiter.allow("10.0.0.1") {
		t.Fatal("fourth request within the window should be rejected")
	}
	// 不同 IP 不受影响。
	if !limiter.allow("10.0.0.2") {
		t.Fatal("another IP should have its own budget")
	}
}

func TestRateLimitHealthBypass(t *testing.T) {
	h := newTestHandler()
	limiter := newRateLimiter(1, time.Minute)
	handler := rateLimitMiddleware(limiter, h.Router())

	// health 不占配额。
	for i := 0; i < 3; i++ {
		r := httptest.NewRequest(http.MethodGet, "/health", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, r)
		if rec.Code != http.StatusOK {
			t.Fatalf("health request %d = %d, want 200", i, rec.Code)
		}
	}
	// 其他请求超过配额后 429。
	r := httptest.NewRequest(http.MethodGet, "/auth/login", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, r)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, r)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("rate-limited request = %d, want 429", rec.Code)
	}
}
