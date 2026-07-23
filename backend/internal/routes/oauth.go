// Package routes — GitHub OAuth login handlers.
//
// Implements a "backend-relay + poll" flow that does NOT require deep-link /
// custom-URL-scheme support on desktop or mobile clients:
//
//  1. Client calls POST /auth/github/state → backend creates a random state,
//     stores it in oauth_states (status=pending), returns {authorizeUrl, state}.
//  2. Client opens authorizeUrl in the system browser via open_external_url.
//  3. User authorizes on github.com; GitHub redirects to GET /auth/github/callback
//     with ?code &state. The backend exchanges code→access_token, fetches the
//     GitHub user profile, find-or-creates the local user + oauth identity,
//     issues access/refresh tokens, and stores them on the oauth_states row
//     (status=done). It returns a minimal HTML page telling the user to return
//     to the app.
//  4. Client polls GET /auth/github/poll?state=... every ~1.5s. While pending
//     → {status:"pending"}; once done → {status:"done", accessToken, ...};
//     on error → {status:"error", error}.
//
// State rows live 5 minutes; stale rows are ignored.
package routes

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/gaolin89898/ai-workbench/backend/internal/auth"
)

// oauthStateTTL is how long an oauth_states row is considered live.
const oauthStateTTL = 5 * time.Minute

// githubStartRequest is the body of POST /auth/github/state. An optional
// desktop flag asks the backend to also register a desktop device and return a
// desktop pairing token (180d) instead of the standard access+refresh pair, so
// the desktop client can reuse the existing /desktop/login code path.
type githubStartRequest struct {
	Desktop bool   `json:"desktop"`
	Name    string `json:"name"`
	Os      string `json:"os"`
	MachineID string `json:"machineId"`
}

// githubStartResponse is returned to the client. The client opens authorizeUrl
// in the system browser; state is used to poll.
type githubStartResponse struct {
	AuthorizeUrl string `json:"authorizeUrl"`
	State        string `json:"state"`
}

// githubTokenResponse is the JSON GitHub returns for the access-token exchange.
type githubTokenResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	Scope       string `json:"scope"`
}

// githubUserResponse is the subset of GET /user fields we need.
type githubUserResponse struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	Name      string `json:"name"`
	Email     string `json:"email"`
	AvatarURL string `json:"avatar_url"`
}

// githubPollResponse is what the polling client receives.
type githubPollResponse struct {
	Status       string `json:"status"` // pending / done / error
	AccessToken  string `json:"accessToken,omitempty"`
	RefreshToken string `json:"refreshToken,omitempty"`
	UserId       string `json:"userId,omitempty"`
	DeviceId     string `json:"deviceId,omitempty"` // desktop flow only
	Error        string `json:"error,omitempty"`
}

// githubStart creates a random state, persists it as pending, and returns the
// GitHub authorize URL for the client to open in a browser.
func (h *Handler) githubStart(w http.ResponseWriter, r *http.Request) {
	if h.GitHubClientID == "" || h.GitHubClientSecret == "" || h.GitHubRedirectURL == "" {
		writeError(w, http.StatusBadRequest, "github oauth not configured")
		return
	}

	var req githubStartRequest
	// Body is optional; ignore decode errors so a bare POST works too.
	_ = json.NewDecoder(r.Body).Decode(&req)

	state := uuid.NewString()
	expiresAt := time.Now().Add(oauthStateTTL)

	_, err := h.DB.Pool.Exec(r.Context(),
		`INSERT INTO oauth_states (state, status, expires_at) VALUES ($1, 'pending', $2)`,
		state, expiresAt,
	)
	if err != nil {
		log.Printf("oauth start insert: %v", err)
		writeInternal(w)
		return
	}

	// We stash the desktop hint on the state row via the error column is NOT
	// ideal; instead we encode it into the state itself is risky. Simplest: use
	// a dedicated approach — store desktop flag in a session table is overkill.
	// We pass it through the GitHub "state" param as a JSON blob so the
	// callback can read it back without extra storage. But GitHub state is
	// echoed verbatim, so we keep our DB state as the single source of truth
	// and look up desktop intent from the row. To carry desktop intent we
	// append it to the state row now.
	if req.Desktop {
		_, _ = h.DB.Pool.Exec(r.Context(),
			`UPDATE oauth_states SET error = 'desktop' WHERE state = $1`,
			state,
		)
	}

	q := url.Values{}
	q.Set("client_id", h.GitHubClientID)
	q.Set("redirect_uri", h.GitHubRedirectURL)
	q.Set("scope", "read:user user:email")
	q.Set("state", state)
	authorizeURL := "https://github.com/login/oauth/authorize?" + q.Encode()

	writeJSON(w, http.StatusOK, githubStartResponse{
		AuthorizeUrl: authorizeURL,
		State:        state,
	})
}

// githubCallback handles the redirect from GitHub. It exchanges the code for
// an access token, fetches the user profile, find-or-creates the local user +
// oauth identity, and stores the result on the oauth_states row.
func (h *Handler) githubCallback(w http.ResponseWriter, r *http.Request) {
	if h.GitHubClientID == "" || h.GitHubClientSecret == "" {
		writeError(w, http.StatusBadRequest, "github oauth not configured")
		return
	}

	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	if code == "" || state == "" {
		writeBadRequest(w, "missing code or state")
		return
	}

	// Verify the state exists and is still pending+not expired.
	var (
		desktopHint *string
		expiresAt    time.Time
	)
	err := h.DB.Pool.QueryRow(r.Context(),
		`SELECT error, expires_at FROM oauth_states WHERE state = $1 AND status = 'pending'`,
		state,
	).Scan(&desktopHint, &expiresAt)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid or expired state")
		return
	}
	if !time.Now().Before(expiresAt) {
		h.markOAuthError(r.Context(), state, "state expired")
		writeError(w, http.StatusBadRequest, "state expired")
		return
	}

	// 1. Exchange code for access token.
	token, err := h.exchangeGitHubCode(r.Context(), code)
	if err != nil {
		h.markOAuthError(r.Context(), state, "token exchange failed: "+err.Error())
		writeError(w, http.StatusBadGateway, "failed to exchange code")
		return
	}

	// 2. Fetch user profile.
	ghUser, err := h.fetchGitHubUser(r.Context(), token)
	if err != nil {
		h.markOAuthError(r.Context(), state, "fetch user failed: "+err.Error())
		writeError(w, http.StatusBadGateway, "failed to fetch github user")
		return
	}

	// 3. Find or create user + oauth identity.
	ghExternalID := fmt.Sprintf("%d", ghUser.ID)
	ghDisplayName := ghUser.Name
	if ghDisplayName == "" {
		ghDisplayName = ghUser.Login
	}
	userID, err := h.findOrCreateOAuthUser(r.Context(), "github", oauthUserInfo{
		ExternalID:  ghExternalID,
		Email:       ghUser.Email,
		DisplayName: ghDisplayName,
	})
	if err != nil {
		h.markOAuthError(r.Context(), state, "create user failed: "+err.Error())
		log.Printf("oauth callback create user: %v", err)
		writeInternal(w)
		return
	}

	// 4. Determine desktop vs standard flow.
	isDesktop := desktopHint != nil && *desktopHint == "desktop"
	var accessToken, refreshToken, deviceID string
	if isDesktop {
		// Desktop flow: create/find device, issue 180d pairing token.
		// Name/Os/MachineID are not available here (the callback has no body);
		// fall back to GitHub login + platform string.
		deviceID, err = h.findOrCreateDesktopDevice(r.Context(), userID, ghUser.Login, "github", "")
		if err != nil {
			h.markOAuthError(r.Context(), state, "device create failed: "+err.Error())
			writeInternal(w)
			return
		}
		accessToken, err = auth.GenerateDesktopPairingToken(userID, deviceID, h.Secret)
		if err != nil {
			h.markOAuthError(r.Context(), state, "token sign failed: "+err.Error())
			writeInternal(w)
			return
		}
	} else {
		// Standard flow: issue access + refresh.
		accessToken, err = auth.GenerateAccessToken(userID, "", h.Secret)
		if err != nil {
			h.markOAuthError(r.Context(), state, "token sign failed: "+err.Error())
			writeInternal(w)
			return
		}
		refreshToken, err = auth.GenerateRefreshToken(userID, h.Secret)
		if err != nil {
			h.markOAuthError(r.Context(), state, "token sign failed: "+err.Error())
			writeInternal(w)
			return
		}
	}

	// 5. Store result on the state row.
	_, err = h.DB.Pool.Exec(r.Context(),
		`UPDATE oauth_states
		 SET status = 'done', user_id = $1, access_token = $2, refresh_token = NULLIF($3, ''), completed_at = NOW()
		 WHERE state = $4`,
		userID, accessToken, refreshToken, state,
	)
	if err != nil {
		log.Printf("oauth callback store result: %v", err)
		writeInternal(w)
		return
	}

	// 6. Return a friendly HTML page so the browser tab can be closed.
	writeHTML(w, http.StatusOK, `<!DOCTYPE html><html><head><meta charset="utf-8"><title>登录成功</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f7f8fa;color:#1f2329}
.box{text-align:center;padding:40px;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 8px}p{color:#86909c;margin:0}</style></head>
<body><div class="box"><h1>登录成功</h1><p>请返回 CodeHub AI 应用</p></div></body></html>`)
}

// githubPoll is polled by the client every ~1.5s. Returns pending/done/error.
func (h *Handler) githubPoll(w http.ResponseWriter, r *http.Request) {
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if state == "" {
		writeBadRequest(w, "state is required")
		return
	}

	var (
		status        string
		accessToken  sql.NullString
		refreshToken sql.NullString
		userID       sql.NullString
		errMsg       sql.NullString
	)
	err := h.DB.Pool.QueryRow(r.Context(),
		`SELECT status, access_token, refresh_token, user_id, error
		 FROM oauth_states WHERE state = $1`,
		state,
	).Scan(&status, &accessToken, &refreshToken, &userID, &errMsg)
	if err != nil {
		writeError(w, http.StatusNotFound, "state not found")
		return
	}

	resp := githubPollResponse{Status: status}
	if accessToken.Valid {
		resp.AccessToken = accessToken.String
	}
	if refreshToken.Valid {
		resp.RefreshToken = refreshToken.String
	}
	if userID.Valid {
		resp.UserId = userID.String
	}
	if errMsg.Valid && errMsg.String != "" && errMsg.String != "desktop" {
		resp.Error = errMsg.String
	}
	if status == "error" && resp.Error == "" {
		resp.Error = "github login failed"
	}
	writeJSON(w, http.StatusOK, resp)
}

// exchangeGitHubCode POSTs to https://github.com/login/oauth/access_token with
// the code, client_id, client_secret, and redirect_uri, and returns the access
// token from GitHub's response.
func (h *Handler) exchangeGitHubCode(ctx context.Context, code string) (string, error) {
	form := url.Values{}
	form.Set("client_id", h.GitHubClientID)
	form.Set("client_secret", h.GitHubClientSecret)
	form.Set("code", code)
	form.Set("redirect_uri", h.GitHubRedirectURL)

	req, err := http.NewRequestWithContext(ctx, "POST",
		"https://github.com/login/oauth/access_token",
		strings.NewReader(form.Encode()),
	)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("github token exchange: status %d: %s", resp.StatusCode, string(body))
	}

	var tokenResp githubTokenResponse
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return "", fmt.Errorf("decode token response: %w", err)
	}
	if tokenResp.AccessToken == "" {
		return "", fmt.Errorf("empty access_token in response: %s", string(body))
	}
	return tokenResp.AccessToken, nil
}

// fetchGitHubUser calls GET https://api.github.com/user with the bearer token.
func (h *Handler) fetchGitHubUser(ctx context.Context, token string) (*githubUserResponse, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.github.com/user", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("github user fetch: status %d: %s", resp.StatusCode, string(body))
	}

	var user githubUserResponse
	if err := json.Unmarshal(body, &user); err != nil {
		return nil, fmt.Errorf("decode user response: %w", err)
	}
	if user.ID == 0 {
		return nil, fmt.Errorf("empty user id in response")
	}
	return &user, nil
}

// oauthUserInfo is a provider-agnostic representation of the authenticated
// user, used by findOrCreateOAuthUser so GitHub and Google share the same
// find-or-create logic.
type oauthUserInfo struct {
	ExternalID  string
	Email       string
	DisplayName string
	AvatarURL   string
}

// findOrCreateOAuthUser looks up user_oauth_identities by (provider, external_id).
// If found, returns the bound user_id. If not, creates a user (email may be
// empty from the provider; we synthesize one) and an oauth identity row.
func (h *Handler) findOrCreateOAuthUser(ctx context.Context, provider string, info oauthUserInfo) (string, error) {
	externalID := info.ExternalID

	// 1. Check if this OAuth identity is already bound.
	var userID string
	err := h.DB.Pool.QueryRow(ctx,
		`SELECT user_id FROM user_oauth_identities WHERE provider = $1 AND external_id = $2`,
		provider, externalID,
	).Scan(&userID)
	if err == nil {
		// Optionally update display_name.
		_, _ = h.DB.Pool.Exec(ctx,
			`UPDATE user_oauth_identities SET display_name = $1 WHERE provider = $2 AND external_id = $3`,
			info.DisplayName, provider, externalID,
		)
		return userID, nil
	}
	if err != sql.ErrNoRows {
		return "", err
	}

	// 2. Not bound - create a new user.
	// The provider may hide email; synthesize a stable internal email so the
	// UNIQUE constraint on users.email is satisfied.
	email := info.Email
	if email == "" {
		email = fmt.Sprintf("%s@%s.local", externalID, provider)
	}
	email = strings.ToLower(email)

	err = h.DB.Pool.QueryRow(ctx,
		`INSERT INTO users (email, password_hash, email_verified) VALUES ($1, NULL, TRUE) RETURNING id`,
		email,
	).Scan(&userID)
	if err != nil {
		// Race: email already exists (another OAuth user with same email).
		// Reuse the existing user row and just bind the oauth identity to it.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			err = h.DB.Pool.QueryRow(ctx,
				`SELECT id FROM users WHERE email = $1`, email,
			).Scan(&userID)
			if err != nil {
				return "", err
			}
		} else {
			return "", err
		}
	}

	// 3. Bind the oauth identity.
	_, err = h.DB.Pool.Exec(ctx,
		`INSERT INTO user_oauth_identities (user_id, provider, external_id, display_name)
		 VALUES ($1, $2, $3, $4)`,
		userID, provider, externalID, info.DisplayName,
	)
	if err != nil {
		// Race on (provider, external_id) unique — re-fetch.
		err = h.DB.Pool.QueryRow(ctx,
			`SELECT user_id FROM user_oauth_identities WHERE provider = $1 AND external_id = $2`,
			provider, externalID,
		).Scan(&userID)
		if err != nil {
			return "", err
		}
	}
	return userID, nil
}

// markOAuthError sets a state row to error status.
func (h *Handler) markOAuthError(ctx context.Context, state, message string) {
	_, _ = h.DB.Pool.Exec(ctx,
		`UPDATE oauth_states SET status = 'error', error = $1, completed_at = NOW() WHERE state = $2`,
		message, state,
	)
}

// writeHTML writes an HTML response (used by the OAuth callback success page).
func writeHTML(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

// ===== Google OAuth =====

// googleStartRequest mirrors githubStartRequest.
type googleStartRequest struct {
	Desktop bool   `json:"desktop"`
	Name    string `json:"name"`
	Os      string `json:"os"`
	MachineID string `json:"machineId"`
}

// googleStartResponse mirrors githubStartResponse.
type googleStartResponse struct {
	AuthorizeUrl string `json:"authorizeUrl"`
	State        string `json:"state"`
}

// googleTokenResponse is the JSON Google returns for the access-token exchange.
type googleTokenResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int    `json:"expires_in"`
	Scope       string `json:"scope"`
	IDToken     string `json:"id_token"`
}

// googleUserResponse is the subset of GET /userinfo fields we need.
type googleUserResponse struct {
	ID         string `json:"id"`
	Email      string `json:"email"`
	Name       string `json:"name"`
	Picture    string `json:"picture"`
}

// googlePollResponse mirrors githubPollResponse.
type googlePollResponse struct {
	Status       string `json:"status"` // pending / done / error
	AccessToken  string `json:"accessToken,omitempty"`
	RefreshToken string `json:"refreshToken,omitempty"`
	UserId       string `json:"userId,omitempty"`
	DeviceId     string `json:"deviceId,omitempty"` // desktop flow only
	Error        string `json:"error,omitempty"`
}

// googleStart creates a random state, persists it as pending, and returns the
// Google authorize URL for the client to open in a browser.
func (h *Handler) googleStart(w http.ResponseWriter, r *http.Request) {
	if h.GoogleClientID == "" || h.GoogleClientSecret == "" || h.GoogleRedirectURL == "" {
		writeError(w, http.StatusBadRequest, "google oauth not configured")
		return
	}

	var req googleStartRequest
	_ = json.NewDecoder(r.Body).Decode(&req)

	state := uuid.NewString()
	expiresAt := time.Now().Add(oauthStateTTL)

	_, err := h.DB.Pool.Exec(r.Context(),
		`INSERT INTO oauth_states (state, status, expires_at) VALUES ($1, 'pending', $2)`,
		state, expiresAt,
	)
	if err != nil {
		log.Printf("oauth start insert: %v", err)
		writeInternal(w)
		return
	}

	if req.Desktop {
		_, _ = h.DB.Pool.Exec(r.Context(),
			`UPDATE oauth_states SET error = 'desktop' WHERE state = $1`,
			state,
		)
	}

	q := url.Values{}
	q.Set("client_id", h.GoogleClientID)
	q.Set("redirect_uri", h.GoogleRedirectURL)
	q.Set("response_type", "code")
	q.Set("scope", "openid email profile")
	q.Set("state", state)
	authorizeURL := "https://accounts.google.com/o/oauth2/v2/auth?" + q.Encode()

	writeJSON(w, http.StatusOK, googleStartResponse{
		AuthorizeUrl: authorizeURL,
		State:        state,
	})
}

// googleCallback handles the redirect from Google. It exchanges the code for
// an access token, fetches the user profile, find-or-creates the local user +
// oauth identity, and stores the result on the oauth_states row.
func (h *Handler) googleCallback(w http.ResponseWriter, r *http.Request) {
	if h.GoogleClientID == "" || h.GoogleClientSecret == "" {
		writeError(w, http.StatusBadRequest, "google oauth not configured")
		return
	}

	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	if code == "" || state == "" {
		writeBadRequest(w, "missing code or state")
		return
	}

	var (
		desktopHint *string
		expiresAt    time.Time
	)
	err := h.DB.Pool.QueryRow(r.Context(),
		`SELECT error, expires_at FROM oauth_states WHERE state = $1 AND status = 'pending'`,
		state,
	).Scan(&desktopHint, &expiresAt)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid or expired state")
		return
	}
	if !time.Now().Before(expiresAt) {
		h.markOAuthError(r.Context(), state, "state expired")
		writeError(w, http.StatusBadRequest, "state expired")
		return
	}

	token, err := h.exchangeGoogleCode(r.Context(), code)
	if err != nil {
		h.markOAuthError(r.Context(), state, "token exchange failed: "+err.Error())
		writeError(w, http.StatusBadGateway, "failed to exchange code")
		return
	}

	gUser, err := h.fetchGoogleUser(r.Context(), token)
	if err != nil {
		h.markOAuthError(r.Context(), state, "fetch user failed: "+err.Error())
		writeError(w, http.StatusBadGateway, "failed to fetch google user")
		return
	}

	userID, err := h.findOrCreateOAuthUser(r.Context(), "google", oauthUserInfo{
		ExternalID:  gUser.ID,
		Email:       gUser.Email,
		DisplayName: gUser.Name,
		AvatarURL:   gUser.Picture,
	})
	if err != nil {
		h.markOAuthError(r.Context(), state, "create user failed: "+err.Error())
		log.Printf("oauth callback create user: %v", err)
		writeInternal(w)
		return
	}

	isDesktop := desktopHint != nil && *desktopHint == "desktop"
	var accessToken, refreshToken, deviceID string
	if isDesktop {
		deviceID, err = h.findOrCreateDesktopDevice(r.Context(), userID, gUser.Name, "google", "")
		if err != nil {
			h.markOAuthError(r.Context(), state, "device create failed: "+err.Error())
			writeInternal(w)
			return
		}
		accessToken, err = auth.GenerateDesktopPairingToken(userID, deviceID, h.Secret)
		if err != nil {
			h.markOAuthError(r.Context(), state, "token sign failed: "+err.Error())
			writeInternal(w)
			return
		}
	} else {
		accessToken, err = auth.GenerateAccessToken(userID, "", h.Secret)
		if err != nil {
			h.markOAuthError(r.Context(), state, "token sign failed: "+err.Error())
			writeInternal(w)
			return
		}
		refreshToken, err = auth.GenerateRefreshToken(userID, h.Secret)
		if err != nil {
			h.markOAuthError(r.Context(), state, "token sign failed: "+err.Error())
			writeInternal(w)
			return
		}
	}

	_, err = h.DB.Pool.Exec(r.Context(),
		`UPDATE oauth_states
		 SET status = 'done', user_id = $1, access_token = $2, refresh_token = NULLIF($3, ''), completed_at = NOW()
		 WHERE state = $4`,
		userID, accessToken, refreshToken, state,
	)
	if err != nil {
		log.Printf("oauth callback store result: %v", err)
		writeInternal(w)
		return
	}

	writeHTML(w, http.StatusOK, `<!DOCTYPE html><html><head><meta charset="utf-8"><title>登录成功</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f7f8fa;color:#1f2329}
.box{text-align:center;padding:40px;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 8px}p{color:#86909c;margin:0}</style></head>
<body><div class="box"><h1>登录成功</h1><p>请返回 CodeHub AI 应用</p></div></body></html>`)
}

// googlePoll is polled by the client every ~1.5s. Returns pending/done/error.
func (h *Handler) googlePoll(w http.ResponseWriter, r *http.Request) {
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if state == "" {
		writeBadRequest(w, "state is required")
		return
	}

	var (
		status        string
		accessToken  sql.NullString
		refreshToken sql.NullString
		userID       sql.NullString
		errMsg       sql.NullString
	)
	err := h.DB.Pool.QueryRow(r.Context(),
		`SELECT status, access_token, refresh_token, user_id, error
		 FROM oauth_states WHERE state = $1`,
		state,
	).Scan(&status, &accessToken, &refreshToken, &userID, &errMsg)
	if err != nil {
		writeError(w, http.StatusNotFound, "state not found")
		return
	}

	resp := googlePollResponse{Status: status}
	if accessToken.Valid {
		resp.AccessToken = accessToken.String
	}
	if refreshToken.Valid {
		resp.RefreshToken = refreshToken.String
	}
	if userID.Valid {
		resp.UserId = userID.String
	}
	if errMsg.Valid && errMsg.String != "" && errMsg.String != "desktop" {
		resp.Error = errMsg.String
	}
	if status == "error" && resp.Error == "" {
		resp.Error = "google login failed"
	}
	writeJSON(w, http.StatusOK, resp)
}

// exchangeGoogleCode POSTs to https://oauth2.googleapis.com/token with the
// code, client_id, client_secret, redirect_uri, and grant_type, and returns
// the access token from Google's response.
func (h *Handler) exchangeGoogleCode(ctx context.Context, code string) (string, error) {
	form := url.Values{}
	form.Set("client_id", h.GoogleClientID)
	form.Set("client_secret", h.GoogleClientSecret)
	form.Set("code", code)
	form.Set("redirect_uri", h.GoogleRedirectURL)
	form.Set("grant_type", "authorization_code")

	req, err := http.NewRequestWithContext(ctx, "POST",
		"https://oauth2.googleapis.com/token",
		strings.NewReader(form.Encode()),
	)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("google token exchange: status %d: %s", resp.StatusCode, string(body))
	}

	var tokenResp googleTokenResponse
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return "", fmt.Errorf("decode token response: %w", err)
	}
	if tokenResp.AccessToken == "" {
		return "", fmt.Errorf("empty access_token in response: %s", string(body))
	}
	return tokenResp.AccessToken, nil
}

// fetchGoogleUser calls GET https://www.googleapis.com/oauth2/v2/userinfo with
// the bearer token.
func (h *Handler) fetchGoogleUser(ctx context.Context, token string) (*googleUserResponse, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", "https://www.googleapis.com/oauth2/v2/userinfo", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("google user fetch: status %d: %s", resp.StatusCode, string(body))
	}

	var user googleUserResponse
	if err := json.Unmarshal(body, &user); err != nil {
		return nil, fmt.Errorf("decode user response: %w", err)
	}
	if user.ID == "" {
		return nil, fmt.Errorf("empty user id in response")
	}
	return &user, nil
}
