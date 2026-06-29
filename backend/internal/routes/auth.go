// Ported from crates/server/src/routes/auth.rs.
//
// Implements user registration/login, mobile pairing-code creation, and the
// desktop pairing-request flow (create → poll status → approve → pair). Each
// handler mirrors the Rust logic: same SQL (including FOR UPDATE row locks
// and transactions), same JSON shapes (camelCase), same status codes and
// error messages.
package routes

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/gaolin89898/ai-workbench/backend/internal/auth"
)

// ---- Request / response DTOs (serde rename_all = "camelCase" in Rust) ----

type registerRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type desktopLoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name"`
	Os       string `json:"os"`
}

// authResponse mirrors Rust AuthResponse { accessToken, refreshToken, userId }.
type authResponse struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	UserId       string `json:"userId"`
}

// pairingCodeResponse mirrors Rust PairingCodeResponse { code, expiresAt }.
type pairingCodeResponse struct {
	Code      string    `json:"code"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type pairDesktopRequest struct {
	Code string `json:"code"`
	Name string `json:"name"`
	Os   string `json:"os"`
}

// pairDesktopResponse mirrors Rust PairDesktopResponse { deviceId, accessToken }.
type pairDesktopResponse struct {
	DeviceId    string `json:"deviceId"`
	AccessToken string `json:"accessToken"`
}

type createDesktopPairingRequest struct {
	Name string `json:"name"`
	Os   string `json:"os"`
}

type desktopPairingRequestResponse struct {
	Code      string    `json:"code"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type desktopPairingStatusResponse struct {
	Status      string    `json:"status"`
	ExpiresAt   time.Time `json:"expiresAt"`
	DeviceId    *string   `json:"deviceId"`
	AccessToken *string   `json:"accessToken"`
}

// validateCredentials mirrors auth::validate_credentials: email must contain
// "@", password must be at least 6 characters.
func validateCredentials(email, password string) error {
	if !strings.Contains(email, "@") {
		return errors.New("email is invalid")
	}
	if len(password) < 6 {
		return errors.New("password must be at least 6 characters")
	}
	return nil
}

// authenticate extracts the user id from the Authorization header. Used by
// routes that sit on the public mux but still require authentication
// (approve_desktop_pairing_request). Returns ("", false) on failure.
func (h *Handler) authenticate(r *http.Request) (string, bool) {
	authHeader := r.Header.Get("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(authHeader, prefix) {
		return "", false
	}
	claims, err := auth.ParseToken(authHeader[len(prefix):], h.Secret)
	if err != nil {
		return "", false
	}
	return claims.UserID, true
}

// register mirrors auth::register. Validates credentials, hashes the password
// with argon2id, inserts the user, and returns access + refresh tokens.
// A unique-violation on the email column maps to 409 Conflict.
func (h *Handler) register(w http.ResponseWriter, r *http.Request) {
	var req registerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeBadRequest(w, "invalid request body")
		return
	}
	if err := validateCredentials(req.Email, req.Password); err != nil {
		writeBadRequest(w, err.Error())
		return
	}

	passwordHash, err := auth.HashPassword(req.Password)
	if err != nil {
		writeInternal(w)
		return
	}

	var userID string
	err = h.DB.Pool.QueryRow(r.Context(),
		"INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
		strings.ToLower(req.Email), passwordHash,
	).Scan(&userID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			writeConflict(w, "email already registered")
			return
		}
		writeInternal(w)
		return
	}

	accessToken, err := auth.GenerateAccessToken(userID, "", h.Secret)
	if err != nil {
		writeInternal(w)
		return
	}
	refreshToken, err := auth.GenerateRefreshToken(userID, h.Secret)
	if err != nil {
		writeInternal(w)
		return
	}
	writeJSON(w, http.StatusOK, authResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		UserId:       userID,
	})
}

// login mirrors auth::login. Looks up the user by email (lowercased), verifies
// the argon2 hash, and returns tokens. Wrong email or password → 401.
func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeBadRequest(w, "invalid request body")
		return
	}

	userID, ok := h.verifyUserPassword(w, r, req.Email, req.Password)
	if !ok {
		return
	}

	accessToken, err := auth.GenerateAccessToken(userID, "", h.Secret)
	if err != nil {
		writeInternal(w)
		return
	}
	refreshToken, err := auth.GenerateRefreshToken(userID, h.Secret)
	if err != nil {
		writeInternal(w)
		return
	}
	writeJSON(w, http.StatusOK, authResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		UserId:       userID,
	})
}

func (h *Handler) loginDesktop(w http.ResponseWriter, r *http.Request) {
	var req desktopLoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeBadRequest(w, "invalid request body")
		return
	}

	if err := validateCredentials(req.Email, req.Password); err != nil {
		writeBadRequest(w, err.Error())
		return
	}

	name := strings.TrimSpace(req.Name)
	osName := strings.TrimSpace(req.Os)
	if name == "" || osName == "" {
		writeBadRequest(w, "desktop name and os are required")
		return
	}

	userID, err := h.findOrCreateUser(r, req.Email, req.Password)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var deviceID string
	err = h.DB.Pool.QueryRow(r.Context(),
		`INSERT INTO desktop_devices (user_id, name, os, online, last_seen_at)
		 VALUES ($1, $2, $3, FALSE, NOW()) RETURNING id`,
		userID, name, osName,
	).Scan(&deviceID)
	if err != nil {
		writeInternal(w)
		return
	}

	token, err := auth.GenerateDesktopPairingToken(userID, deviceID, h.Secret)
	if err != nil {
		writeInternal(w)
		return
	}
	writeJSON(w, http.StatusOK, pairDesktopResponse{
		DeviceId:    deviceID,
		AccessToken: token,
	})
}

// findOrCreateUser looks up the user by email. If not found, registers a new
// user. If found, verifies the password. Returns userID on success.
func (h *Handler) findOrCreateUser(r *http.Request, email, password string) (string, error) {
	lowerEmail := strings.ToLower(email)

	var userID, passwordHash string
	err := h.DB.Pool.QueryRow(r.Context(),
		"SELECT id, password_hash FROM users WHERE email = $1",
		lowerEmail,
	).Scan(&userID, &passwordHash)

	if errors.Is(err, pgx.ErrNoRows) {
		// User doesn't exist — register them.
		hash, hashErr := auth.HashPassword(password)
		if hashErr != nil {
			return "", hashErr
		}
		var newID string
		insertErr := h.DB.Pool.QueryRow(r.Context(),
			"INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
			lowerEmail, hash,
		).Scan(&newID)
		if insertErr != nil {
			// Race condition: another request created the user between our
			// SELECT and INSERT. Re-query to get the existing record.
			err = h.DB.Pool.QueryRow(r.Context(),
				"SELECT id, password_hash FROM users WHERE email = $1",
				lowerEmail,
			).Scan(&userID, &passwordHash)
			if err != nil {
				return "", err
			}
			// Now verify the password against the existing record.
			if verifyErr := auth.VerifyPassword(passwordHash, password); verifyErr != nil {
				return "", verifyErr
			}
			return userID, nil
		}
		return newID, nil
	}

	if err != nil {
		return "", err
	}

	// User exists — verify password.
	if verifyErr := auth.VerifyPassword(passwordHash, password); verifyErr != nil {
		return "", verifyErr
	}

	return userID, nil
}

func (h *Handler) verifyUserPassword(w http.ResponseWriter, r *http.Request, email, password string) (string, bool) {
	var userID, passwordHash string
	err := h.DB.Pool.QueryRow(r.Context(),
		"SELECT id, password_hash FROM users WHERE email = $1",
		strings.ToLower(email),
	).Scan(&userID, &passwordHash)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "user not found")
			return "", false
		}
		writeInternal(w)
		return "", false
	}
	if err := auth.VerifyPassword(passwordHash, password); err != nil {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return "", false
	}
	return userID, true
}

// registerDesktopDevice 是 OAuth 登录后桌面端调用的端点：
// 用 access token 鉴权（用户已经通过钉钉拿到 token），不需要再输密码。
// 创建 desktop_devices 行并返回 deviceId，让桌面端能正常发 WebSocket 快照。
func (h *Handler) registerDesktopDevice(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req struct {
		Name string `json:"name"`
		Os   string `json:"os"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeBadRequest(w, "invalid request body")
		return
	}
	name := strings.TrimSpace(req.Name)
	osName := strings.TrimSpace(req.Os)
	if name == "" || osName == "" {
		writeBadRequest(w, "desktop name and os are required")
		return
	}

	var deviceID string
	err := h.DB.Pool.QueryRow(r.Context(),
		`INSERT INTO desktop_devices (user_id, name, os, online, last_seen_at)
		 VALUES ($1, $2, $3, FALSE, NOW()) RETURNING id`,
		userID, name, osName,
	).Scan(&deviceID)
	if err != nil {
		writeInternal(w)
		return
	}

	// 签发一个带 deviceId 的桌面专用 token，让桌面端 WS 连接能直接用
	token, err := auth.GenerateDesktopPairingToken(userID, deviceID, h.Secret)
	if err != nil {
		writeInternal(w)
		return
	}

	writeJSON(w, http.StatusOK, pairDesktopResponse{
		DeviceId:    deviceID,
		AccessToken: token,
	})
}

// createPairingCode mirrors auth::create_pairing_code. Generates an 8-char
// code valid for 10 minutes and stores it for the authenticated user.
// (Mobile-side pairing flow.)
func (h *Handler) createPairingCode(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	code := auth.GeneratePairingCode()
	expiresAt := time.Now().Add(10 * time.Minute)
	if _, err := h.DB.Pool.Exec(r.Context(),
		"INSERT INTO pairing_codes (user_id, code, expires_at) VALUES ($1, $2, $3)",
		userID, code, expiresAt,
	); err != nil {
		writeInternal(w)
		return
	}
	writeJSON(w, http.StatusOK, pairingCodeResponse{Code: code, ExpiresAt: expiresAt})
}

// createDesktopPairingRequest mirrors auth::create_desktop_pairing_request.
// The desktop client posts its name + os; the server generates a 10-minute
// code and returns it. No auth required (the desktop isn't paired yet).
func (h *Handler) createDesktopPairingRequest(w http.ResponseWriter, r *http.Request) {
	var req createDesktopPairingRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeBadRequest(w, "invalid request body")
		return
	}
	name := strings.TrimSpace(req.Name)
	os := strings.TrimSpace(req.Os)
	if name == "" || os == "" {
		writeBadRequest(w, "desktop name and os are required")
		return
	}

	code := auth.GeneratePairingCode()
	expiresAt := time.Now().Add(10 * time.Minute)
	if _, err := h.DB.Pool.Exec(r.Context(),
		"INSERT INTO desktop_pairing_requests (code, name, os, expires_at) VALUES ($1, $2, $3, $4)",
		code, name, os, expiresAt,
	); err != nil {
		writeInternal(w)
		return
	}
	writeJSON(w, http.StatusOK, desktopPairingRequestResponse{Code: code, ExpiresAt: expiresAt})
}

// getDesktopPairingRequestStatus mirrors auth::get_desktop_pairing_request_status.
// The desktop polls this endpoint with its code. Returns "pending",
// "approved" (with deviceId + accessToken), or "expired".
func (h *Handler) getDesktopPairingRequestStatus(w http.ResponseWriter, r *http.Request) {
	code := strings.TrimSpace(r.PathValue("code"))

	var (
		expiresAt      time.Time
		approvedUserID *string
		deviceID       *string
	)
	err := h.DB.Pool.QueryRow(r.Context(),
		`SELECT expires_at, approved_user_id, device_id
		 FROM desktop_pairing_requests
		 WHERE code = $1`,
		code,
	).Scan(&expiresAt, &approvedUserID, &deviceID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeBadRequest(w, "pairing request was not found")
			return
		}
		writeInternal(w)
		return
	}

	// Expired and never approved → "expired". !Before matches the Rust >=.
	if !time.Now().Before(expiresAt) && approvedUserID == nil {
		writeJSON(w, http.StatusOK, desktopPairingStatusResponse{
			Status:    "expired",
			ExpiresAt: expiresAt,
		})
		return
	}

	// Approved → issue a 180-day token carrying the approved user + device.
	if approvedUserID != nil {
		token, err := auth.GenerateDesktopPairingToken(*approvedUserID, derefString(deviceID), h.Secret)
		if err != nil {
			writeInternal(w)
			return
		}
		writeJSON(w, http.StatusOK, desktopPairingStatusResponse{
			Status:      "approved",
			ExpiresAt:   expiresAt,
			DeviceId:    deviceID,
			AccessToken: &token,
		})
		return
	}

	// Still pending.
	writeJSON(w, http.StatusOK, desktopPairingStatusResponse{
		Status:    "pending",
		ExpiresAt: expiresAt,
	})
}

// approveDesktopPairingRequest mirrors auth::approve_desktop_pairing_request.
// The mobile user (authenticated) approves a desktop pairing request by code.
// Runs in a transaction: locks the request row, creates the device, marks the
// request as approved, and returns { deviceId, accessToken }.
func (h *Handler) approveDesktopPairingRequest(w http.ResponseWriter, r *http.Request) {
	// This route sits on the public mux but requires auth — authenticate
	// manually, mirroring authenticate_headers in the Rust handler.
	userID, ok := h.authenticate(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	code := strings.TrimSpace(r.PathValue("code"))

	tx, err := h.DB.Pool.Begin(r.Context())
	if err != nil {
		writeInternal(w)
		return
	}
	defer tx.Rollback(r.Context())

	var (
		requestID string
		name      string
		os        string
	)
	err = tx.QueryRow(r.Context(),
		`SELECT id, name, os FROM desktop_pairing_requests
		 WHERE code = $1 AND used_at IS NULL AND expires_at > NOW() FOR UPDATE`,
		code,
	).Scan(&requestID, &name, &os)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeBadRequest(w, "pairing request is invalid or expired")
			return
		}
		writeInternal(w)
		return
	}

	var deviceID string
	err = tx.QueryRow(r.Context(),
		`INSERT INTO desktop_devices (user_id, name, os, online, last_seen_at)
		 VALUES ($1, $2, $3, FALSE, NOW()) RETURNING id`,
		userID, strings.TrimSpace(name), strings.TrimSpace(os),
	).Scan(&deviceID)
	if err != nil {
		writeInternal(w)
		return
	}

	if _, err := tx.Exec(r.Context(),
		`UPDATE desktop_pairing_requests
		 SET approved_user_id = $1, device_id = $2, used_at = NOW()
		 WHERE id = $3`,
		userID, deviceID, requestID,
	); err != nil {
		writeInternal(w)
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeInternal(w)
		return
	}

	token, err := auth.GenerateDesktopPairingToken(userID, deviceID, h.Secret)
	if err != nil {
		writeInternal(w)
		return
	}
	writeJSON(w, http.StatusOK, pairDesktopResponse{
		DeviceId:    deviceID,
		AccessToken: token,
	})
}

// pairDesktop mirrors auth::pair_desktop. The desktop posts a pairing code
// (obtained out-of-band from the mobile user) plus its name + os. Runs in a
// transaction: locks the code row, creates the device, marks the code as
// used, and returns { deviceId, accessToken }.
func (h *Handler) pairDesktop(w http.ResponseWriter, r *http.Request) {
	var req pairDesktopRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeBadRequest(w, "invalid request body")
		return
	}

	tx, err := h.DB.Pool.Begin(r.Context())
	if err != nil {
		writeInternal(w)
		return
	}
	defer tx.Rollback(r.Context())

	var (
		codeID string
		uid    string
	)
	err = tx.QueryRow(r.Context(),
		`SELECT id, user_id FROM pairing_codes
		 WHERE code = $1 AND used_at IS NULL AND expires_at > NOW() FOR UPDATE`,
		strings.TrimSpace(req.Code),
	).Scan(&codeID, &uid)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeBadRequest(w, "pairing code is invalid or expired")
			return
		}
		writeInternal(w)
		return
	}

	var deviceID string
	err = tx.QueryRow(r.Context(),
		`INSERT INTO desktop_devices (user_id, name, os, online, last_seen_at)
		 VALUES ($1, $2, $3, FALSE, NOW()) RETURNING id`,
		uid, strings.TrimSpace(req.Name), strings.TrimSpace(req.Os),
	).Scan(&deviceID)
	if err != nil {
		writeInternal(w)
		return
	}

	if _, err := tx.Exec(r.Context(),
		"UPDATE pairing_codes SET used_at = NOW() WHERE id = $1",
		codeID,
	); err != nil {
		writeInternal(w)
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeInternal(w)
		return
	}

	token, err := auth.GenerateDesktopPairingToken(uid, deviceID, h.Secret)
	if err != nil {
		writeInternal(w)
		return
	}
	writeJSON(w, http.StatusOK, pairDesktopResponse{
		DeviceId:    deviceID,
		AccessToken: token,
	})
}

// derefString returns the pointed-to value or "" if nil.
func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
