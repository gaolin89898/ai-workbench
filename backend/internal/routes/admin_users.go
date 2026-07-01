package routes

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/gaolin89898/ai-workbench/backend/internal/auth"
)

type adminSystemUserResponse struct {
	Id                 string     `json:"id"`
	Account            string     `json:"account"`
	Email              string     `json:"email"`
	DisplayName        string     `json:"displayName"`
	AuthMode           string     `json:"authMode"`
	Status             string     `json:"status"`
	DesktopDeviceCount int64      `json:"desktopDeviceCount"`
	OnlineDesktopCount int64      `json:"onlineDesktopCount"`
	MobileDeviceCount  int64      `json:"mobileDeviceCount"`
	OnlineMobileCount  int        `json:"onlineMobileCount"`
	LastDesktopSeenAt  *time.Time `json:"lastDesktopSeenAt"`
	LastMobileSeenAt   *time.Time `json:"lastMobileSeenAt"`
	LatestSeenAt       *time.Time `json:"latestSeenAt"`
	CreatedAt          time.Time  `json:"createdAt"`
}

type updateSystemUserRequest struct {
	Account     string `json:"account"`
	DisplayName string `json:"displayName"`
}

type resetSystemUserPasswordRequest struct {
	Password string `json:"password"`
}

func (h *Handler) listManagedUsers(w http.ResponseWriter, r *http.Request) {
	if !h.requireAdminUser(w, r) {
		return
	}

	rows, err := h.DB.Pool.Query(r.Context(),
		`SELECT
		   u.id,
		   u.email,
		   COALESCE(o.display_name, '') AS display_name,
		   CASE WHEN o.provider IS NULL THEN 'password' ELSE o.provider END AS auth_mode,
		   u.created_at,
		   COALESCE(d.desktop_device_count, 0) AS desktop_device_count,
		   COALESCE(d.online_desktop_count, 0) AS online_desktop_count,
		   d.last_desktop_seen_at,
		   COALESCE(m.mobile_device_count, 0) AS mobile_device_count,
		   m.last_mobile_seen_at,
		   GREATEST(
		     COALESCE(d.last_desktop_seen_at, u.created_at),
		     COALESCE(m.last_mobile_seen_at, u.created_at)
		   ) AS latest_seen_at
		 FROM users u
		 LEFT JOIN LATERAL (
		   SELECT provider, display_name
		   FROM user_oauth_identities
		   WHERE user_id = u.id
		   ORDER BY created_at DESC
		   LIMIT 1
		 ) o ON TRUE
		 LEFT JOIN (
		   SELECT
		     user_id,
		     COUNT(*)::BIGINT AS desktop_device_count,
		     COUNT(*) FILTER (WHERE online)::BIGINT AS online_desktop_count,
		     MAX(last_seen_at) AS last_desktop_seen_at
		   FROM desktop_devices
		   GROUP BY user_id
		 ) d ON d.user_id = u.id
		 LEFT JOIN (
		   SELECT
		     user_id,
		     COUNT(*)::BIGINT AS mobile_device_count,
		     MAX(last_seen_at) AS last_mobile_seen_at
		   FROM mobile_devices
		   GROUP BY user_id
		 ) m ON m.user_id = u.id
		 ORDER BY latest_seen_at DESC, u.created_at DESC`,
	)
	if err != nil {
		writeInternal(w)
		return
	}
	defer rows.Close()

	users := []adminSystemUserResponse{}
	for rows.Next() {
		var user adminSystemUserResponse
		if err := rows.Scan(
			&user.Id,
			&user.Email,
			&user.DisplayName,
			&user.AuthMode,
			&user.CreatedAt,
			&user.DesktopDeviceCount,
			&user.OnlineDesktopCount,
			&user.LastDesktopSeenAt,
			&user.MobileDeviceCount,
			&user.LastMobileSeenAt,
			&user.LatestSeenAt,
		); err != nil {
			writeInternal(w)
			return
		}
		user.Account = user.Email
		user.OnlineMobileCount = h.onlineMobileCount(user.Id)
		if user.OnlineDesktopCount > 0 || user.OnlineMobileCount > 0 {
			user.Status = "online"
		} else {
			user.Status = "offline"
		}
		users = append(users, user)
	}
	if err := rows.Err(); err != nil {
		writeInternal(w)
		return
	}
	writeJSON(w, http.StatusOK, users)
}

func (h *Handler) updateManagedUser(w http.ResponseWriter, r *http.Request) {
	if !h.requireAdminUser(w, r) {
		return
	}
	userID := r.PathValue("userId")

	var req updateSystemUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeBadRequest(w, "invalid request body")
		return
	}
	account := strings.ToLower(strings.TrimSpace(req.Account))
	displayName := strings.TrimSpace(req.DisplayName)
	if account == "" {
		writeBadRequest(w, "account is required")
		return
	}

	tag, err := h.DB.Pool.Exec(r.Context(),
		"UPDATE users SET email = $1 WHERE id = $2",
		account, userID,
	)
	if err != nil {
		if isPgUniqueViolation(err) {
			writeConflict(w, "account already exists")
			return
		}
		writeInternal(w)
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	if displayName != "" {
		_, err = h.DB.Pool.Exec(r.Context(),
			`UPDATE user_oauth_identities
			 SET display_name = $1
			 WHERE user_id = $2`,
			displayName, userID,
		)
		if err != nil {
			writeInternal(w)
			return
		}
	}

	user, err := h.adminUserByID(r.Context(), userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		writeInternal(w)
		return
	}
	writeJSON(w, http.StatusOK, user)
}

func (h *Handler) resetManagedUserPassword(w http.ResponseWriter, r *http.Request) {
	if !h.requireAdminUser(w, r) {
		return
	}
	userID := r.PathValue("userId")

	var req resetSystemUserPasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeBadRequest(w, "invalid request body")
		return
	}
	if len(req.Password) < 6 {
		writeBadRequest(w, "password must be at least 6 characters")
		return
	}

	passwordHash, err := auth.HashPassword(req.Password)
	if err != nil {
		writeInternal(w)
		return
	}
	tag, err := h.DB.Pool.Exec(r.Context(),
		"UPDATE users SET password_hash = $1 WHERE id = $2",
		passwordHash, userID,
	)
	if err != nil {
		writeInternal(w)
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handler) adminUserByID(ctx context.Context, userID string) (adminSystemUserResponse, error) {
	var user adminSystemUserResponse
	err := h.DB.Pool.QueryRow(ctx,
		`SELECT
		   u.id,
		   u.email,
		   COALESCE(o.display_name, '') AS display_name,
		   CASE WHEN o.provider IS NULL THEN 'password' ELSE o.provider END AS auth_mode,
		   u.created_at,
		   COALESCE(d.desktop_device_count, 0) AS desktop_device_count,
		   COALESCE(d.online_desktop_count, 0) AS online_desktop_count,
		   d.last_desktop_seen_at,
		   COALESCE(m.mobile_device_count, 0) AS mobile_device_count,
		   m.last_mobile_seen_at,
		   GREATEST(
		     COALESCE(d.last_desktop_seen_at, u.created_at),
		     COALESCE(m.last_mobile_seen_at, u.created_at)
		   ) AS latest_seen_at
		 FROM users u
		 LEFT JOIN LATERAL (
		   SELECT provider, display_name
		   FROM user_oauth_identities
		   WHERE user_id = u.id
		   ORDER BY created_at DESC
		   LIMIT 1
		 ) o ON TRUE
		 LEFT JOIN (
		   SELECT
		     user_id,
		     COUNT(*)::BIGINT AS desktop_device_count,
		     COUNT(*) FILTER (WHERE online)::BIGINT AS online_desktop_count,
		     MAX(last_seen_at) AS last_desktop_seen_at
		   FROM desktop_devices
		   GROUP BY user_id
		 ) d ON d.user_id = u.id
		 LEFT JOIN (
		   SELECT
		     user_id,
		     COUNT(*)::BIGINT AS mobile_device_count,
		     MAX(last_seen_at) AS last_mobile_seen_at
		   FROM mobile_devices
		   GROUP BY user_id
		 ) m ON m.user_id = u.id
		 WHERE u.id = $1`,
		userID,
	).Scan(
		&user.Id,
		&user.Email,
		&user.DisplayName,
		&user.AuthMode,
		&user.CreatedAt,
		&user.DesktopDeviceCount,
		&user.OnlineDesktopCount,
		&user.LastDesktopSeenAt,
		&user.MobileDeviceCount,
		&user.LastMobileSeenAt,
		&user.LatestSeenAt,
	)
	if err != nil {
		return user, err
	}
	user.Account = user.Email
	user.OnlineMobileCount = h.onlineMobileCount(user.Id)
	if user.OnlineDesktopCount > 0 || user.OnlineMobileCount > 0 {
		user.Status = "online"
	} else {
		user.Status = "offline"
	}
	return user, nil
}

func (h *Handler) requireAdminUser(w http.ResponseWriter, r *http.Request) bool {
	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return false
	}

	var email string
	err := h.DB.Pool.QueryRow(r.Context(), "SELECT email FROM users WHERE id = $1", userID).Scan(&email)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return false
		}
		writeInternal(w)
		return false
	}
	if email != "admin" {
		writeForbidden(w)
		return false
	}
	return true
}

func (h *Handler) onlineMobileCount(userID string) int {
	uid, err := uuid.Parse(userID)
	if err != nil {
		return 0
	}
	return len(h.State.GetMobilesByUser(uid))
}

func isPgUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
