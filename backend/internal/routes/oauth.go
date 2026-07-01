// Package routes: OAuth handlers for third-party login.
//
// 钉钉扫码登录（网站应用）流程：
//  1. 客户端 GET /oauth/dingtalk/start
//     → 服务端生成 state，存到 oauthSessions + 设置 cookie
//     → 返回 { authUrl, state }，客户端用 BrowserWindow/系统浏览器打开
//  2. 用户在钉钉扫码确认 → 钉钉回调 /oauth/dingtalk/callback?code=...&state=...
//     → 服务端校验 state、换 accessToken、拉用户信息、查/建本地用户、签发 JWT
//     → 结果存到 oauthSessions[state]，并返回给浏览器一个简单的 HTML 提示页
//  3. 客户端用 state 轮询 GET /oauth/dingtalk/poll?state=...
//     → pending: 服务端仍在等钉钉回调
//     → success: 返回 { accessToken, refreshToken, userId, displayName, provider }
//     → error: 返回错误信息
//     → expired: 超过 10 分钟
//
// 凭证通过环境变量 DINGTALK_CLIENT_ID/SECRET/REDIRECT_URL 注入。三者任一为空
// 时 start/callback/poll 都返回 503。
package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/gaolin89898/ai-workbench/backend/internal/auth"
)

// 钉钉 OAuth 接口地址。
const (
	dingTalkAuthURL     = "https://login.dingtalk.com/oauth2/auth"
	dingTalkTokenURL    = "https://api.dingtalk.com/v1.0/oauth2/userAccessToken"
	dingTalkUserInfoURL = "https://api.dingtalk.com/v1.0/contact/users/me"
)

// stateExpire 授权 state 的有效期。回调时按此窗口校验。
const stateExpire = 10 * time.Minute

// oauthSessionStatus 表示一次 OAuth 会话的当前状态。
type oauthSessionStatus string

const (
	oauthStatusPending oauthSessionStatus = "pending"
	oauthStatusSuccess oauthSessionStatus = "success"
	oauthStatusError   oauthSessionStatus = "error"
	oauthStatusExpired oauthSessionStatus = "expired"
)

// oauthSession 是服务端保存的 OAuth 会话。state 作为 key。
type oauthSession struct {
	status     oauthSessionStatus
	result     oauthCallbackResponse
	errMessage string
	createdAt  time.Time
}

// oauthSessions 是进程内的 OAuth 会话缓存。多副本部署需要换成 Redis；
// 单实例部署足够。sync.RWMutex 保护并发访问。
var oauthSessions = struct {
	sync.RWMutex
	m map[string]*oauthSession
}{m: make(map[string]*oauthSession)}

// oauthStartResponse 返回给客户端的 start 信息。
type oauthStartResponse struct {
	AuthURL string `json:"authUrl"`
	State   string `json:"state"`
}

// dingTalkTokenResponse 钉钉 userAccessToken 接口的响应。
type dingTalkTokenResponse struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	ExpiresIn    int64  `json:"expiresIn"`
}

// dingTalkTokenRequest is the JSON body expected by DingTalk's
// userAccessToken endpoint.
type dingTalkTokenRequest struct {
	ClientID     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
	Code         string `json:"code"`
	GrantType    string `json:"grantType"`
}

// dingTalkUserInfo 钉钉 /contact/users/me 接口的响应（只关心部分字段）。
type dingTalkUserInfo struct {
	Nick    string `json:"nick"`
	UnionID string `json:"unionId"`
	OpenID  string `json:"openId"`
	Email   string `json:"email"`
	Mobile  string `json:"mobile"`
}

// oauthCallbackResponse 给客户端的最终响应：包含可保存的本地 token。
type oauthCallbackResponse struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	UserID       string `json:"userId"`
	DisplayName  string `json:"displayName"`
	Provider     string `json:"provider"`
}

// oauthPollResponse 轮询接口的响应。
type oauthPollResponse struct {
	Status oauthSessionStatus `json:"status"`
	oauthCallbackResponse
	Error string `json:"error,omitempty"`
}

// dingTalkOAuthStart 生成授权 URL，并把 state 写入服务端会话。
// 客户端拿到 authUrl 后用 BrowserWindow/系统浏览器打开。
func (h *Handler) dingTalkOAuthStart(w http.ResponseWriter, r *http.Request) {
	cfg := h.oauthDingTalkConfig()
	if cfg == nil {
		writeError(w, http.StatusServiceUnavailable, "dingtalk oauth not configured")
		return
	}

	state := auth.GeneratePairingCode()

	// 把 state 写入会话表，等 callback 填充结果。
	oauthSessions.Lock()
	oauthSessions.m[state] = &oauthSession{
		status:    oauthStatusPending,
		createdAt: time.Now(),
	}
	// 顺手清理过期会话，避免内存泄漏
	for k, v := range oauthSessions.m {
		if time.Since(v.createdAt) > stateExpire {
			delete(oauthSessions.m, k)
		}
	}
	oauthSessions.Unlock()

	// 同时也写 cookie 一份。callback 时优先用会话表，cookie 作为兜底。
	http.SetCookie(w, &http.Cookie{
		Name:     "dingtalk_oauth_state",
		Value:    state,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(stateExpire.Seconds()),
	})

	// 构造授权 URL。prompt=consent 强制每次都扫码，避免缓存导致调试困难。
	q := url.Values{}
	q.Set("client_id", cfg.DingTalkClientID)
	q.Set("redirect_uri", cfg.DingTalkRedirectURL)
	q.Set("response_type", "code")
	q.Set("scope", "openid")
	q.Set("state", state)
	q.Set("prompt", "consent")
	authURL := dingTalkAuthURL + "?" + q.Encode()

	writeJSON(w, http.StatusOK, oauthStartResponse{AuthURL: authURL, State: state})
}

// dingTalkOAuthCallback 处理钉钉回调。查/建用户并签发 token，
// 然后把结果存到 oauthSessions[state]，并返回一个简单的 HTML 提示页给浏览器。
func (h *Handler) dingTalkOAuthCallback(w http.ResponseWriter, r *http.Request) {
	cfg := h.oauthDingTalkConfig()
	if cfg == nil {
		writeError(w, http.StatusServiceUnavailable, "dingtalk oauth not configured")
		return
	}

	code := strings.TrimSpace(r.URL.Query().Get("code"))
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if code == "" || state == "" {
		writeBadRequest(w, "missing code or state")
		return
	}

	// 校验 state 在会话表中存在
	oauthSessions.RLock()
	session, ok := oauthSessions.m[state]
	oauthSessions.RUnlock()
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid or expired oauth state")
		return
	}
	if time.Since(session.createdAt) > stateExpire {
		setOAuthSession(state, &oauthSession{status: oauthStatusExpired, createdAt: session.createdAt})
		writeError(w, http.StatusBadRequest, "oauth state expired")
		return
	}

	// 1. 用 code 换 accessToken
	tokenResp, err := exchangeDingTalkToken(r.Context(), cfg.DingTalkClientID, cfg.DingTalkClientSecret, code)
	if err != nil {
		setOAuthSession(state, &oauthSession{
			status:     oauthStatusError,
			errMessage: err.Error(),
			createdAt:  session.createdAt,
		})
		writeOAuthCallbackFailure(w, "登录失败", "钉钉授权校验失败，请回到 AI 工作台重试。")
		return
	}

	// 2. 拉 unionId 等用户信息
	userInfo, err := fetchDingTalkUserInfo(r.Context(), tokenResp.AccessToken)
	if err != nil {
		setOAuthSession(state, &oauthSession{
			status:     oauthStatusError,
			errMessage: err.Error(),
			createdAt:  session.createdAt,
		})
		writeOAuthCallbackFailure(w, "登录失败", "无法获取钉钉用户信息，请回到 AI 工作台重试。")
		return
	}
	externalID := userInfo.UnionID
	if externalID == "" {
		externalID = userInfo.OpenID
	}
	if externalID == "" {
		setOAuthSession(state, &oauthSession{
			status:     oauthStatusError,
			errMessage: "dingtalk returned no user identifier",
			createdAt:  session.createdAt,
		})
		writeOAuthCallbackFailure(w, "登录失败", "钉钉没有返回可绑定的用户标识，请联系管理员检查应用权限。")
		return
	}

	// 3. 查/建本地用户
	userID, displayName, err := h.findOrCreateOAuthUser(r.Context(), "dingtalk", externalID, userInfo.Nick, userInfo.Email)
	if err != nil {
		setOAuthSession(state, &oauthSession{
			status:     oauthStatusError,
			errMessage: err.Error(),
			createdAt:  session.createdAt,
		})
		writeOAuthCallbackFailure(w, "登录失败", "本地账号绑定失败，请回到 AI 工作台重试。")
		return
	}

	// 4. 签发本地 token
	accessToken, err := auth.GenerateAccessToken(userID, "", h.Secret)
	if err != nil {
		setOAuthSession(state, &oauthSession{
			status:     oauthStatusError,
			errMessage: "token sign failed",
			createdAt:  session.createdAt,
		})
		writeOAuthCallbackFailure(w, "登录失败", "本地登录凭证生成失败，请回到 AI 工作台重试。")
		return
	}
	refreshToken, err := auth.GenerateRefreshToken(userID, h.Secret)
	if err != nil {
		setOAuthSession(state, &oauthSession{
			status:     oauthStatusError,
			errMessage: "refresh token sign failed",
			createdAt:  session.createdAt,
		})
		writeOAuthCallbackFailure(w, "登录失败", "本地刷新凭证生成失败，请回到 AI 工作台重试。")
		return
	}

	result := oauthCallbackResponse{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		UserID:       userID,
		DisplayName:  displayName,
		Provider:     "dingtalk",
	}
	setOAuthSession(state, &oauthSession{
		status:    oauthStatusSuccess,
		result:    result,
		createdAt: session.createdAt,
	})

	// 给浏览器一个友好的提示页（用户已扫码完成，可关闭此页面）
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, `<!doctype html><html><head><meta charset="utf-8"><title>登录成功</title>`+
		`<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;`+
		`display:flex;align-items:center;justify-content:center;height:100vh;margin:0;`+
		`background:#f8fafc;color:#0f172a}main{text-align:center}h1{color:#22c55e;font-size:48px;margin:0}`+
		`p{color:#64748b;margin-top:8px}</style></head><body><main>`+
		`<h1>✓</h1><p>登录成功，请回到 AI 工作台应用</p></main>`+
		`<script>setTimeout(()=>window.close(),3000)</script></body></html>`)
}

func writeOAuthCallbackFailure(w http.ResponseWriter, title, message string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, `<!doctype html><html><head><meta charset="utf-8"><title>`+
		html.EscapeString(title)+`</title>`+
		`<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;`+
		`display:flex;align-items:center;justify-content:center;height:100vh;margin:0;`+
		`background:#f8fafc;color:#0f172a}main{text-align:center;max-width:520px;padding:24px}`+
		`h1{color:#ef4444;font-size:28px;margin:0 0 10px}p{color:#64748b;margin:0;line-height:1.6}</style>`+
		`</head><body><main><h1>`+html.EscapeString(title)+`</h1><p>`+html.EscapeString(message)+`</p></main>`+
		`<script>setTimeout(()=>window.close(),5000)</script></body></html>`)
}

// dingTalkOAuthPoll 客户端用 state 轮询登录结果。
// 状态：pending / success / error / expired。
func (h *Handler) dingTalkOAuthPoll(w http.ResponseWriter, r *http.Request) {
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if state == "" {
		writeBadRequest(w, "missing state")
		return
	}

	oauthSessions.RLock()
	session, ok := oauthSessions.m[state]
	oauthSessions.RUnlock()

	if !ok {
		writeJSON(w, http.StatusOK, oauthPollResponse{Status: oauthStatusExpired, Error: "session not found"})
		return
	}

	// 超时判断
	if time.Since(session.createdAt) > stateExpire {
		writeJSON(w, http.StatusOK, oauthPollResponse{Status: oauthStatusExpired, Error: "timeout"})
		return
	}

	switch session.status {
	case oauthStatusPending:
		writeJSON(w, http.StatusOK, oauthPollResponse{Status: oauthStatusPending})
	case oauthStatusSuccess:
		writeJSON(w, http.StatusOK, oauthPollResponse{
			Status:                oauthStatusSuccess,
			oauthCallbackResponse: session.result,
		})
		// 成功后清掉会话，避免重复消费
		oauthSessions.Lock()
		delete(oauthSessions.m, state)
		oauthSessions.Unlock()
	case oauthStatusError:
		writeJSON(w, http.StatusOK, oauthPollResponse{Status: oauthStatusError, Error: session.errMessage})
		oauthSessions.Lock()
		delete(oauthSessions.m, state)
		oauthSessions.Unlock()
	default:
		writeJSON(w, http.StatusOK, oauthPollResponse{Status: oauthStatusExpired, Error: "unknown status"})
		oauthSessions.Lock()
		delete(oauthSessions.m, state)
		oauthSessions.Unlock()
	}
}

// setOAuthSession 写入会话状态。
func setOAuthSession(state string, session *oauthSession) {
	oauthSessions.Lock()
	oauthSessions.m[state] = session
	oauthSessions.Unlock()
}

// oauthDingTalkConfig 返回钉钉配置；任一字段为空则返回 nil。
func (h *Handler) oauthDingTalkConfig() *OAuthConfig {
	cfg := h.OAuthConfig
	if cfg == nil {
		return nil
	}
	if cfg.DingTalkClientID == "" || cfg.DingTalkClientSecret == "" || cfg.DingTalkRedirectURL == "" {
		return nil
	}
	return cfg
}

// exchangeDingTalkToken 用 authorizationCode 换 userAccessToken。
func exchangeDingTalkToken(ctx context.Context, clientID, clientSecret, authCode string) (*dingTalkTokenResponse, error) {
	body, err := dingTalkTokenRequestBody(clientID, clientSecret, authCode)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, dingTalkTokenURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("dingtalk token http %d: %s", resp.StatusCode, string(raw))
	}
	var out dingTalkTokenResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("decode token response: %w", err)
	}
	if out.AccessToken == "" {
		return nil, errors.New("dingtalk returned empty accessToken")
	}
	return &out, nil
}

func dingTalkTokenRequestBody(clientID, clientSecret, authCode string) ([]byte, error) {
	return json.Marshal(dingTalkTokenRequest{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		Code:         authCode,
		GrantType:    "authorization_code",
	})
}

// fetchDingTalkUserInfo 用 accessToken 拉 /contact/users/me。
func fetchDingTalkUserInfo(ctx context.Context, accessToken string) (*dingTalkUserInfo, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, dingTalkUserInfoURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-acs-dingtalk-access-token", accessToken)
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("dingtalk userinfo http %d: %s", resp.StatusCode, string(raw))
	}
	var out dingTalkUserInfo
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("decode userinfo: %w", err)
	}
	return &out, nil
}

// findOrCreateOAuthUser 按 provider+externalId 查 user_oauth_identities。
// 已绑定：直接返回 user_id。
// 未绑定：建新 users 行（无 email 时用 provider+externalId 凑一个占位邮箱，
//
//	password_hash 留 NULL），再插 user_oauth_identities。
//
// 若 OAuth 返回的 email 已被密码登录用户占用，会自动合并到该用户。
func (h *Handler) findOrCreateOAuthUser(ctx context.Context, provider, externalID, displayName, email string) (string, string, error) {
	// 1. 已绑定？
	var userID string
	err := h.DB.Pool.QueryRow(ctx,
		`SELECT user_id FROM user_oauth_identities WHERE provider = $1 AND external_id = $2`,
		provider, externalID,
	).Scan(&userID)
	if err == nil {
		return userID, displayName, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", "", err
	}

	// 2. 未绑定。若 OAuth 返回了 email，尝试按 email 找现有用户合并。
	displayName = strings.TrimSpace(displayName)
	if displayName == "" {
		displayName = fmt.Sprintf("%s用户_%s", provider, shortExternalID(externalID))
	}

	tx, err := h.DB.Pool.Begin(ctx)
	if err != nil {
		return "", "", err
	}
	defer tx.Rollback(ctx)

	finalEmail := strings.ToLower(strings.TrimSpace(email))
	if finalEmail == "" {
		// 钉钉没返回 email 时用占位 email，保证 UNIQUE 约束不冲突。
		finalEmail = fmt.Sprintf("%s_%s@oauth.local", provider, externalID)
	}

	// 先看 email 是否已被占用
	var existingUserID string
	err = tx.QueryRow(ctx, "SELECT id FROM users WHERE email = $1", finalEmail).Scan(&existingUserID)
	if err == nil {
		// 已有同邮箱用户，直接绑定 OAuth 到该用户
		_, bindErr := tx.Exec(ctx,
			`INSERT INTO user_oauth_identities (user_id, provider, external_id, display_name)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (provider, external_id) DO NOTHING`,
			existingUserID, provider, externalID, displayName,
		)
		if bindErr != nil {
			return "", "", bindErr
		}
		if err := tx.Commit(ctx); err != nil {
			return "", "", err
		}
		return existingUserID, displayName, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", "", err
	}

	// 3. 建新用户（password_hash 为 NULL，纯 OAuth 账号）
	err = tx.QueryRow(ctx,
		`INSERT INTO users (email, password_hash) VALUES ($1, NULL) RETURNING id`,
		finalEmail,
	).Scan(&userID)
	if err != nil {
		return "", "", fmt.Errorf("create oauth user: %w", err)
	}

	_, err = tx.Exec(ctx,
		`INSERT INTO user_oauth_identities (user_id, provider, external_id, display_name)
		 VALUES ($1, $2, $3, $4)`,
		userID, provider, externalID, displayName,
	)
	if err != nil {
		return "", "", fmt.Errorf("bind oauth identity: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return "", "", err
	}
	return userID, displayName, nil
}

func shortExternalID(externalID string) string {
	if len(externalID) <= 8 {
		return externalID
	}
	return externalID[:8]
}
