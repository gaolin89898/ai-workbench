// Package routes —— token 用量相关路由。
//
// 提供两个接口：
//   - POST /token-usage         桌面端上报一次 AI turn 的 token 消耗
//   - GET  /token-usage/summary 按工具聚合查询当前用户的 token 用量
package routes

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gaolin89898/ai-workbench/backend/internal/auth"
	"github.com/gaolin89898/ai-workbench/backend/internal/db"
	"github.com/gaolin89898/ai-workbench/backend/internal/models"
)

// tokenUsageReportRequest 桌面端上报 body。
type tokenUsageReportRequest struct {
	AiSessionId     string `json:"aiSessionId"`
	DeviceId        string `json:"deviceId"`
	ProviderId      string `json:"providerId"`
	InputTokens     int32  `json:"inputTokens"`
	CachedInputTokens int32  `json:"cachedInputTokens"`
	OutputTokens    int32  `json:"outputTokens"`
	ReasoningTokens int32  `json:"reasoningTokens"`
	TotalTokens     int32  `json:"totalTokens"`
}

// reportTokenUsage 写入一条 token 用量记录。
// 设备 id 从 access token 中解出（与 register-device 时的 deviceId 一致）。
func (h *Handler) reportTokenUsage(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req tokenUsageReportRequest
	if err := decodeJSON(r, &req); err != nil {
		writeBadRequest(w, err.Error())
		return
	}
	if req.ProviderId == "" {
		writeBadRequest(w, "providerId is required")
		return
	}
	deviceID := auth.DeviceIDFromContext(r.Context())
	if deviceID == "" {
		deviceID = req.DeviceId
	}
	if deviceID == "" {
		writeBadRequest(w, "deviceId is required")
		return
	}
	if err := h.DB.EnsureDeviceOwner(r.Context(), userID, deviceID); err != nil {
		if errors.Is(err, db.ErrForbidden) {
			writeForbidden(w)
			return
		}
		writeInternal(w)
		return
	}

	var aiSessionID *string
	if req.AiSessionId != "" {
		if err := h.DB.EnsureAiSessionOwner(r.Context(), userID, req.AiSessionId, deviceID); err == nil {
			aiSessionID = &req.AiSessionId
		} else if !errors.Is(err, db.ErrForbidden) {
			writeInternal(w)
			return
		}
	}

	cachedInputTokens := req.CachedInputTokens
	if cachedInputTokens < 0 || req.InputTokens <= 0 {
		cachedInputTokens = 0
	} else if cachedInputTokens > req.InputTokens {
		cachedInputTokens = req.InputTokens
	}
	err := h.DB.InsertTokenUsage(r.Context(), models.TokenUsageInsert{
		UserId:          userID,
		DeviceId:        deviceID,
		AiSessionId:     aiSessionID,
		ProviderId:      req.ProviderId,
		InputTokens:     req.InputTokens,
		CachedInputTokens: cachedInputTokens,
		OutputTokens:    req.OutputTokens,
		ReasoningTokens: req.ReasoningTokens,
		TotalTokens:     req.TotalTokens,
	})
	if err != nil {
		writeInternal(w)
		return
	}
	writeJSON(w, http.StatusNoContent, nil)
}

// tokenUsageSummaryResponse 聚合响应。
type tokenUsageSummaryResponse struct {
	Providers  []tokenUsageSummaryItem         `json:"providers"`
	Totals     tokenUsageSummaryItem           `json:"totals"`
	Daily      []models.TokenUsageDailySummary `json:"daily"`
	PeriodDays int                             `json:"periodDays"`
}

type tokenUsageSummaryItem struct {
	ProviderId      string `json:"providerId"`
	InputTokens     int64  `json:"inputTokens"`
	CachedInputTokens int64  `json:"cachedInputTokens"`
	OutputTokens    int64  `json:"outputTokens"`
	ReasoningTokens int64  `json:"reasoningTokens"`
	TotalTokens     int64  `json:"totalTokens"`
	TurnCount       int64  `json:"turnCount"`
}

// getTokenUsageSummary 返回当前用户按工具聚合的 token 用量。
func (h *Handler) getTokenUsageSummary(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	days := 30
	if requested, err := strconv.Atoi(r.URL.Query().Get("days")); err == nil && (requested == 7 || requested == 30 || requested == 90) {
		days = requested
	}
	since := time.Now().UTC().AddDate(0, 0, -(days - 1)).Truncate(24 * time.Hour)
	rows, err := h.DB.SumTokenUsageByProvider(r.Context(), userID, since)
	if err != nil {
		if errors.Is(err, db.ErrForbidden) {
			writeForbidden(w)
			return
		}
		writeInternal(w)
		return
	}

	daily, err := h.DB.SumTokenUsageByDay(r.Context(), userID, since)
	if err != nil {
		writeInternal(w)
		return
	}
	if daily == nil {
		daily = []models.TokenUsageDailySummary{}
	}
	resp := tokenUsageSummaryResponse{Providers: []tokenUsageSummaryItem{}, Daily: daily, PeriodDays: days}
	var totals tokenUsageSummaryItem
	for _, row := range rows {
		item := tokenUsageSummaryItem{
			ProviderId:      row.ProviderId,
			InputTokens:     row.InputTokens,
			CachedInputTokens: row.CachedInputTokens,
			OutputTokens:    row.OutputTokens,
			ReasoningTokens: row.ReasoningTokens,
			TotalTokens:     row.TotalTokens,
			TurnCount:       row.TurnCount,
		}
		resp.Providers = append(resp.Providers, item)
		totals.InputTokens += item.InputTokens
		totals.CachedInputTokens += item.CachedInputTokens
		totals.OutputTokens += item.OutputTokens
		totals.ReasoningTokens += item.ReasoningTokens
		totals.TotalTokens += item.TotalTokens
		totals.TurnCount += item.TurnCount
	}
	resp.Totals = totals
	writeJSON(w, http.StatusOK, resp)
}
