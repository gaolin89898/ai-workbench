package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/gaolin89898/ai-workbench/backend/internal/protocol"
)

const githubReleasesAPI = "https://api.github.com/repos/gaolin89898/ai-workbench/releases?per_page=30"
const githubReleasesURL = "https://github.com/gaolin89898/ai-workbench/releases"

var desktopTagPattern = regexp.MustCompile(`^v\d+\.\d+\.\d+$`)
var mobileTagPattern = regexp.MustCompile(`^(?:mobile-)?v(.+)$`)

type appReleaseRecord struct {
	Platform            string    `json:"platform"`
	LatestVersion       string    `json:"latestVersion"`
	MinSupportedVersion *string   `json:"minSupportedVersion"`
	DownloadUrl         *string   `json:"downloadUrl"`
	ReleaseUrl          *string   `json:"releaseUrl"`
	ReleaseNotes        *string   `json:"releaseNotes"`
	Force               bool      `json:"force"`
	Enabled             bool      `json:"enabled"`
	Source              string    `json:"source"`
	UpdatedAt           time.Time `json:"updatedAt"`
}

type appReleaseInfo struct {
	Platform            string  `json:"platform"`
	CurrentVersion      string  `json:"currentVersion"`
	LatestVersion       string  `json:"latestVersion"`
	MinSupportedVersion *string `json:"minSupportedVersion"`
	Available           bool    `json:"available"`
	Required            bool    `json:"required"`
	Force               bool    `json:"force"`
	DownloadUrl         *string `json:"downloadUrl"`
	ReleaseUrl          *string `json:"releaseUrl"`
	ReleaseNotes        *string `json:"releaseNotes"`
	Source              string  `json:"source"`
}

type updateAppReleaseRequest struct {
	LatestVersion       string  `json:"latestVersion"`
	MinSupportedVersion *string `json:"minSupportedVersion"`
	DownloadUrl         *string `json:"downloadUrl"`
	ReleaseUrl          *string `json:"releaseUrl"`
	ReleaseNotes        *string `json:"releaseNotes"`
	Force               bool    `json:"force"`
	Enabled             bool    `json:"enabled"`
}

func (h *Handler) getAppRelease(w http.ResponseWriter, r *http.Request) {
	platform := normalizeReleasePlatform(r.URL.Query().Get("platform"))
	if platform == "" {
		writeBadRequest(w, "platform must be desktop or mobile")
		return
	}
	currentVersion := strings.TrimSpace(r.URL.Query().Get("currentVersion"))
	info, err := h.resolveAppRelease(r.Context(), platform, currentVersion)
	if err != nil {
		writeInternal(w)
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (h *Handler) listAppReleases(w http.ResponseWriter, r *http.Request) {
	if !h.requireAdminUser(w, r) {
		return
	}
	rows, err := h.DB.Pool.Query(r.Context(),
		`SELECT platform, latest_version, min_supported_version, download_url, release_url, release_notes, force, enabled, source, updated_at
		   FROM app_releases ORDER BY platform`)
	if err != nil {
		writeInternal(w)
		return
	}
	defer rows.Close()
	items := []appReleaseRecord{}
	for rows.Next() {
		var item appReleaseRecord
		if err := rows.Scan(&item.Platform, &item.LatestVersion, &item.MinSupportedVersion, &item.DownloadUrl, &item.ReleaseUrl, &item.ReleaseNotes, &item.Force, &item.Enabled, &item.Source, &item.UpdatedAt); err != nil {
			writeInternal(w)
			return
		}
		items = append(items, item)
	}
	if rows.Err() != nil {
		writeInternal(w)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (h *Handler) updateAppRelease(w http.ResponseWriter, r *http.Request) {
	if !h.requireAdminUser(w, r) {
		return
	}
	platform := normalizeReleasePlatform(r.PathValue("platform"))
	if platform == "" {
		writeBadRequest(w, "platform must be desktop or mobile")
		return
	}
	var req updateAppReleaseRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeBadRequest(w, "invalid request body")
		return
	}
	req.LatestVersion = normalizeVersionText(req.LatestVersion)
	if req.Enabled && req.LatestVersion == "" {
		writeBadRequest(w, "latestVersion is required when enabled")
		return
	}
	trimPtr(&req.MinSupportedVersion)
	trimPtr(&req.DownloadUrl)
	trimPtr(&req.ReleaseUrl)
	trimPtr(&req.ReleaseNotes)

	var saved appReleaseRecord
	err := h.DB.Pool.QueryRow(r.Context(),
		`INSERT INTO app_releases (platform, latest_version, min_supported_version, download_url, release_url, release_notes, force, enabled, source, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', NOW())
		 ON CONFLICT (platform) DO UPDATE SET
		   latest_version = EXCLUDED.latest_version,
		   min_supported_version = EXCLUDED.min_supported_version,
		   download_url = EXCLUDED.download_url,
		   release_url = EXCLUDED.release_url,
		   release_notes = EXCLUDED.release_notes,
		   force = EXCLUDED.force,
		   enabled = EXCLUDED.enabled,
		   source = 'manual',
		   updated_at = NOW()
		 RETURNING platform, latest_version, min_supported_version, download_url, release_url, release_notes, force, enabled, source, updated_at`,
		platform, req.LatestVersion, req.MinSupportedVersion, req.DownloadUrl, req.ReleaseUrl, req.ReleaseNotes, req.Force, req.Enabled,
	).Scan(&saved.Platform, &saved.LatestVersion, &saved.MinSupportedVersion, &saved.DownloadUrl, &saved.ReleaseUrl, &saved.ReleaseNotes, &saved.Force, &saved.Enabled, &saved.Source, &saved.UpdatedAt)
	if err != nil {
		writeInternal(w)
		return
	}
	if saved.Enabled {
		h.broadcastAppRelease(appReleaseToInfo(saved, ""))
	}
	writeJSON(w, http.StatusOK, saved)
}

func (h *Handler) importGitHubAppRelease(w http.ResponseWriter, r *http.Request) {
	if !h.requireAdminUser(w, r) {
		return
	}
	platform := normalizeReleasePlatform(r.PathValue("platform"))
	if platform == "" {
		writeBadRequest(w, "platform must be desktop or mobile")
		return
	}
	info, err := githubReleaseInfo(r.Context(), platform, "")
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (h *Handler) resolveAppRelease(ctx context.Context, platform string, currentVersion string) (appReleaseInfo, error) {
	var record appReleaseRecord
	err := h.DB.Pool.QueryRow(ctx,
		`SELECT platform, latest_version, min_supported_version, download_url, release_url, release_notes, force, enabled, source, updated_at
		   FROM app_releases WHERE platform = $1 AND enabled = TRUE`,
		platform,
	).Scan(&record.Platform, &record.LatestVersion, &record.MinSupportedVersion, &record.DownloadUrl, &record.ReleaseUrl, &record.ReleaseNotes, &record.Force, &record.Enabled, &record.Source, &record.UpdatedAt)
	if err == nil {
		return appReleaseToInfo(record, currentVersion), nil
	}
	if err != pgx.ErrNoRows {
		return appReleaseInfo{}, err
	}
	return githubReleaseInfo(ctx, platform, currentVersion)
}

func (h *Handler) broadcastAppRelease(info appReleaseInfo) {
	msg := protocol.AppUpdateAvailable{
		BaseMessage:         protocol.BaseMessage{Type: "app.update.available"},
		Platform:            info.Platform,
		CurrentVersion:      info.CurrentVersion,
		LatestVersion:       info.LatestVersion,
		MinSupportedVersion: info.MinSupportedVersion,
		Available:           true,
		Required:            info.Required,
		Force:               info.Force,
		DownloadUrl:         info.DownloadUrl,
		ReleaseUrl:          info.ReleaseUrl,
		ReleaseNotes:        info.ReleaseNotes,
		Source:              info.Source,
	}
	data, err := protocol.MarshalMessage(msg)
	if err != nil {
		return
	}
	if info.Platform == "desktop" {
		h.State.BroadcastToAllDesktops(data)
		return
	}
	h.State.BroadcastToAllMobiles(data)
}

func appReleaseToInfo(record appReleaseRecord, currentVersion string) appReleaseInfo {
	current := normalizeVersionText(currentVersion)
	latest := normalizeVersionText(record.LatestVersion)
	available := current != "" && latest != "" && compareReleaseVersions(latest, current) > 0
	return appReleaseInfo{
		Platform:            record.Platform,
		CurrentVersion:      current,
		LatestVersion:       latest,
		MinSupportedVersion: record.MinSupportedVersion,
		Available:           available,
		Required:            isRequiredRelease(current, record.MinSupportedVersion) || (record.Force && available),
		Force:               record.Force,
		DownloadUrl:         record.DownloadUrl,
		ReleaseUrl:          record.ReleaseUrl,
		ReleaseNotes:        record.ReleaseNotes,
		Source:              record.Source,
	}
}

func githubReleaseInfo(ctx context.Context, platform string, currentVersion string) (appReleaseInfo, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, githubReleasesAPI, nil)
	if err != nil {
		return appReleaseInfo{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "ai-workbench-server-updater")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return appReleaseInfo{}, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return appReleaseInfo{}, fmt.Errorf("GitHub Releases HTTP %d", res.StatusCode)
	}
	var releases []struct {
		TagName    string `json:"tag_name"`
		HTMLURL    string `json:"html_url"`
		Body       string `json:"body"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
		Assets     []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(res.Body).Decode(&releases); err != nil {
		return appReleaseInfo{}, err
	}
	for _, release := range releases {
		if release.Draft || release.Prerelease {
			continue
		}
		if platform == "desktop" && desktopTagPattern.MatchString(release.TagName) {
			version := strings.TrimPrefix(release.TagName, "v")
			releaseURL := release.HTMLURL
			notes := release.Body
			return appReleaseToInfo(appReleaseRecord{
				Platform:      platform,
				LatestVersion: version,
				ReleaseUrl:    nilIfEmpty(releaseURL),
				ReleaseNotes:  nilIfEmpty(notes),
				Enabled:       true,
				Source:        "github",
			}, currentVersion), nil
		}
		if platform == "mobile" {
			match := mobileTagPattern.FindStringSubmatch(release.TagName)
			if len(match) != 2 {
				continue
			}
			var apkURL string
			for _, asset := range release.Assets {
				if strings.HasSuffix(asset.Name, ".apk") {
					apkURL = asset.BrowserDownloadURL
					break
				}
			}
			if apkURL == "" {
				continue
			}
			releaseURL := release.HTMLURL
			notes := release.Body
			return appReleaseToInfo(appReleaseRecord{
				Platform:      platform,
				LatestVersion: normalizeVersionText(match[1]),
				DownloadUrl:   nilIfEmpty(apkURL),
				ReleaseUrl:    nilIfEmpty(releaseURL),
				ReleaseNotes:  nilIfEmpty(notes),
				Enabled:       true,
				Source:        "github",
			}, currentVersion), nil
		}
	}
	return appReleaseInfo{
		Platform:       platform,
		CurrentVersion: normalizeVersionText(currentVersion),
		ReleaseUrl:     nilIfEmpty(githubReleasesURL),
		Source:         "github",
	}, nil
}

func normalizeReleasePlatform(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "desktop", "mobile":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return ""
	}
}

func normalizeVersionText(value string) string {
	return strings.TrimPrefix(strings.TrimSpace(value), "v")
}

func trimPtr(value **string) {
	if *value == nil {
		return
	}
	trimmed := strings.TrimSpace(**value)
	if trimmed == "" {
		*value = nil
		return
	}
	*value = &trimmed
}

func nilIfEmpty(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func isRequiredRelease(currentVersion string, minSupportedVersion *string) bool {
	if currentVersion == "" || minSupportedVersion == nil || *minSupportedVersion == "" {
		return false
	}
	return compareReleaseVersions(currentVersion, *minSupportedVersion) < 0
}

func compareReleaseVersions(left string, right string) int {
	leftParts := releaseVersionParts(left)
	rightParts := releaseVersionParts(right)
	maxLen := len(leftParts)
	if len(rightParts) > maxLen {
		maxLen = len(rightParts)
	}
	for i := 0; i < maxLen; i++ {
		a, b := 0, 0
		if i < len(leftParts) {
			a = leftParts[i]
		}
		if i < len(rightParts) {
			b = rightParts[i]
		}
		if a > b {
			return 1
		}
		if a < b {
			return -1
		}
	}
	return 0
}

func releaseVersionParts(value string) []int {
	parts := strings.FieldsFunc(normalizeVersionText(value), func(r rune) bool {
		return r == '.' || r == '+' || r == '-'
	})
	result := make([]int, 0, len(parts))
	for _, part := range parts {
		n := 0
		for _, r := range part {
			if r < '0' || r > '9' {
				break
			}
			n = n*10 + int(r-'0')
		}
		result = append(result, n)
	}
	return result
}
