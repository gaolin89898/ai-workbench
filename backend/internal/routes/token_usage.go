// Package routes —— token 用量相关路由。
//
// 提供两个接口：
//   - POST /token-usage         桌面端上报一次 AI turn 的 token 消耗
//   - GET  /token-usage/summary 按工具聚合查询当前用户的 token 用量
package routes

import (
	"errors"
	"net/http"

	"github.com/gaolin89898/ai-workbench/backend/internal/auth"
	"github.com/gaolin89898/ai-workbench/backend/internal/db"
	"github.com/gaolin89898/ai-workbench/backend/internal/models"
)

// tokenUsageReportRequest 桌面端上报 body。
type tokenUsageReportRequest struct {
	AiSessionId     string `json:"aiSessionId"`
	ProviderId      string `json:"providerId"`
	InputTokens     int32  `json:"inputTokens"`
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
	deviceID := auth.DeviceIDFromContext(r.Context())
	if deviceID == "" {
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

	var aiSessionID *string
	if req.AiSessionId != "" {
		aiSessionID = &req.AiSessionId
	}

	err := h.DB.InsertTokenUsage(r.Context(), models.TokenUsageInsert{
		UserId:          userID,
		DeviceId:        deviceID,
		AiSessionId:     aiSessionID,
		ProviderId:      req.ProviderId,
		InputTokens:     req.InputTokens,
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
	Providers []tokenUsageSummaryItem `json:"providers"`
	Totals    tokenUsageSummaryItem   `json:"totals"`
}

type tokenUsageSummaryItem struct {
	ProviderId      string `json:"providerId"`
	InputTokens     int64  `json:"inputTokens"`
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

	rows, err := h.DB.SumTokenUsageByProvider(r.Context(), userID)
	if err != nil {
		if errors.Is(err, db.ErrForbidden) {
			writeForbidden(w)
			return
		}
		writeInternal(w)
		return
	}

	resp := tokenUsageSummaryResponse{Providers: []tokenUsageSummaryItem{}}
	var totals tokenUsageSummaryItem
	for _, row := range rows {
		item := tokenUsageSummaryItem{
			ProviderId:      row.ProviderId,
			InputTokens:     row.InputTokens,
			OutputTokens:    row.OutputTokens,
			ReasoningTokens: row.ReasoningTokens,
			TotalTokens:     row.TotalTokens,
			TurnCount:       row.TurnCount,
		}
		resp.Providers = append(resp.Providers, item)
		totals.InputTokens += item.InputTokens
		totals.OutputTokens += item.OutputTokens
		totals.ReasoningTokens += item.ReasoningTokens
		totals.TotalTokens += item.TotalTokens
		totals.TurnCount += item.TurnCount
	}
	resp.Totals = totals
	writeJSON(w, http.StatusOK, resp)
}
