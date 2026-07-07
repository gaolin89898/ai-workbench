// Package routes wires the HTTP router for the relay server, porting
// crates/server/src/routes/*.rs to Go's net/http (Go 1.22 ServeMux with
// path parameters). Handlers mirror the Rust route logic one-to-one:
// same SQL, same JSON shapes (camelCase), same status codes.
package routes

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/gaolin89898/ai-workbench/backend/internal/auth"
	"github.com/gaolin89898/ai-workbench/backend/internal/db"
	"github.com/gaolin89898/ai-workbench/backend/internal/state"
)

// Handler holds the shared dependencies injected into every route handler.
// It mirrors the Arc<AppState> carried by axum handlers in the Rust server.
type Handler struct {
	DB     *db.DB
	State  *state.AppState
	Secret string
}

// NewHandler constructs a Handler with the given dependencies.
func NewHandler(d *db.DB, st *state.AppState, secret string) *Handler {
	return &Handler{DB: d, State: st, Secret: secret}
}

// Router builds the top-level http.Handler, wiring every route from
// crates/server/src/routes/mod.rs. Public routes are registered directly on
// the mux; authenticated routes are wrapped in auth.AuthMiddleware via a
// sub-mux mounted at "/". A permissive CORS middleware wraps the whole mux.
func (h *Handler) Router() http.Handler {
	mux := http.NewServeMux()

	// Public routes (no auth).
	mux.HandleFunc("GET /health", h.health)
	mux.HandleFunc("POST /auth/register", h.register)
	mux.HandleFunc("POST /auth/login", h.login)
	mux.HandleFunc("POST /desktop/login", h.loginDesktop)
	mux.HandleFunc("POST /desktop/pairing-requests", h.createDesktopPairingRequest)
	mux.HandleFunc("GET /desktop/pairing-requests/{code}", h.getDesktopPairingRequestStatus)
	mux.HandleFunc("POST /desktop/pairing-requests/{code}/approve", h.approveDesktopPairingRequest)
	mux.HandleFunc("POST /desktop/pair", h.pairDesktop)

	// Authenticated routes — wrapped in AuthMiddleware so every handler can
	// read the user id from the request context via auth.UserIDFromContext.
	authed := http.NewServeMux()
	authed.HandleFunc("POST /pairing/codes", h.createPairingCode)
	authed.HandleFunc("POST /desktop/register-device", h.registerDesktopDevice)
	authed.HandleFunc("GET /providers", h.listProviders)
	authed.HandleFunc("GET /devices", h.listDevices)
	authed.HandleFunc("GET /devices/{deviceId}", h.getDeviceDetail)
	authed.HandleFunc("PATCH /devices/{deviceId}", h.renameDevice)
	authed.HandleFunc("DELETE /devices/{deviceId}", h.deleteDevice)
	authed.HandleFunc("GET /devices/{deviceId}/sessions", h.listSessions)
	authed.HandleFunc("GET /devices/{deviceId}/providers", h.listDeviceProviders)
	authed.HandleFunc("GET /devices/{deviceId}/projects", h.listProjects)
	authed.HandleFunc("POST /devices/{deviceId}/projects", h.createProject)
	authed.HandleFunc("GET /devices/{deviceId}/ai-sessions", h.listAiSessions)
	authed.HandleFunc("POST /devices/{deviceId}/ai-sessions", h.createAiSession)
	authed.HandleFunc("GET /ai-sessions/{sessionId}", h.getAiSession)
	// 改名接口：桌面端/移动端在首条消息后调用，让 title 持久化并同步到另一端
	authed.HandleFunc("PATCH /ai-sessions/{sessionId}", h.renameAiSession)
	authed.HandleFunc("GET /activity-logs", h.listActivityLogs)
	authed.HandleFunc("GET /settings", h.getSettings)
	authed.HandleFunc("PUT /settings", h.updateSettings)
	authed.HandleFunc("GET /app/releases", h.getAppRelease)
	authed.HandleFunc("GET /admin/users", h.listManagedUsers)
	authed.HandleFunc("PATCH /admin/users/{userId}", h.updateManagedUser)
	authed.HandleFunc("POST /admin/users/{userId}/reset-password", h.resetManagedUserPassword)
	authed.HandleFunc("DELETE /admin/users/{userId}", h.deleteManagedUser)
	authed.HandleFunc("PATCH /admin/users/{userId}/toggle-disable", h.toggleDisableUser)
	authed.HandleFunc("GET /admin/users/{userId}/devices", h.listUserDevices)
	authed.HandleFunc("PATCH /admin/devices/{deviceId}", h.updateDevice)
	authed.HandleFunc("GET /admin/devices/{deviceId}/sessions", h.adminListDeviceSessions)
	authed.HandleFunc("GET /admin/app-releases", h.listAppReleases)
	authed.HandleFunc("PUT /admin/app-releases/{platform}", h.updateAppRelease)
	authed.HandleFunc("POST /admin/app-releases/{platform}/import-github", h.importGitHubAppRelease)
	// Token 用量：桌面端上报、按工具聚合查询
	authed.HandleFunc("POST /token-usage", h.reportTokenUsage)
	authed.HandleFunc("GET /token-usage/summary", h.getTokenUsageSummary)

	mux.Handle("/", auth.AuthMiddleware(h.Secret, authed))

	return corsMiddleware(mux)
}

// corsMiddleware adds permissive CORS headers and short-circuits preflight
// OPTIONS requests, mirroring the loose CORS policy used during development.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// writeJSON encodes v as JSON and writes it with the given status code.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("routes: write json: %v", err)
	}
}

// writeError writes a JSON error response {"error": message} with the given
// status code, mirroring ApiError::IntoResponse in error.rs.
func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

// writeBadRequest writes a 400 with "bad request: <msg>", matching
// ApiError::BadRequest's Display impl.
func writeBadRequest(w http.ResponseWriter, msg string) {
	writeError(w, http.StatusBadRequest, "bad request: "+msg)
}

// writeForbidden writes a 403 with "forbidden", matching ApiError::Forbidden.
func writeForbidden(w http.ResponseWriter) {
	writeError(w, http.StatusForbidden, "forbidden")
}

// writeConflict writes a 409 with "conflict: <msg>", matching
// ApiError::Conflict.
func writeConflict(w http.ResponseWriter, msg string) {
	writeError(w, http.StatusConflict, "conflict: "+msg)
}

// writeInternal writes a 500 generic error, matching the Internal Server Error
// mapping for ApiError::Sqlx / ApiError::Anyhow / ApiError::Jwt.
func writeInternal(w http.ResponseWriter) {
	writeError(w, http.StatusInternalServerError, "internal server error")
}
