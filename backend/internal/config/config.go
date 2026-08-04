// Package config holds runtime configuration loading.
//
// Ported from the environment-variable reads in crates/server/src/main.rs.
// Values are sourced from environment variables with sensible defaults so the
// server can run in local development without extra setup. The Rust binary
// used BIND_ADDR (default 127.0.0.1:8080); the Go port switches to a PORT
// variable (default 3000) per the migration spec.
package config

import (
	"errors"
	"os"
)

// Config groups every runtime knob the relay server reads.
type Config struct {
	DatabaseURL   string
	JWTSecret     string
	Port          string
	CORSOrigins   string
	MigrationsDir string

	// SMTP settings for the email-verification-code login flow. All four
	// (Host/Port/Username/Password) must be set for verification codes to be
	// delivered; SMTPFrom is the envelope From address.
	SMTPHost     string
	SMTPPort     string
	SMTPUsername string
	SMTPPassword string
	SMTPFrom     string
	SMTPFromName string

	// GitHub OAuth settings. ClientID + ClientSecret must be set for GitHub
	// login to be available. OAuthRedirectURL is the callback URL registered
	// in the GitHub OAuth app (usually https://<server>/auth/github/callback).
	GitHubClientID     string
	GitHubClientSecret string
	GitHubRedirectURL  string

	// Google OAuth settings. All three values must be set for Google login
	// to be available. RedirectURL is the callback URL registered in the
	// Google OAuth app (usually https://<server>/auth/google/callback).
	GoogleClientID     string
	GoogleClientSecret string
	GoogleRedirectURL  string
}

// Load reads configuration from environment variables, applying defaults for
// any that are unset or empty.
func Load() Config {
	return Config{
		DatabaseURL:   getenv("DATABASE_URL", "postgres://remote_term:remote_term@localhost:5432/remote_term"),
		JWTSecret:     getenv("JWT_SECRET", ""),
		Port:          getenv("PORT", "3000"),
		CORSOrigins:   getenv("CORS_ORIGINS", "*"),
		MigrationsDir: getenv("MIGRATIONS_DIR", "./migrations"),

		SMTPHost:     getenv("SMTP_HOST", ""),
		SMTPPort:     getenv("SMTP_PORT", "587"),
		SMTPUsername: getenv("SMTP_USERNAME", ""),
		SMTPPassword: getenv("SMTP_PASSWORD", ""),
		SMTPFrom:     getenv("SMTP_FROM", ""),
		SMTPFromName: getenv("SMTP_FROM_NAME", "CodeHub AI"),

		GitHubClientID:     getenv("GITHUB_CLIENT_ID", ""),
		GitHubClientSecret: getenv("GITHUB_CLIENT_SECRET", ""),
		GitHubRedirectURL:  getenv("GITHUB_REDIRECT_URL", ""),

		GoogleClientID:     getenv("GOOGLE_CLIENT_ID", ""),
		GoogleClientSecret: getenv("GOOGLE_CLIENT_SECRET", ""),
		GoogleRedirectURL:  getenv("GOOGLE_REDIRECT_URL", ""),
	}
}

// SMTPConfigured reports whether enough SMTP settings are present to actually
// send mail. Handlers gate on this so misconfiguration surfaces as a clear 500
// rather than a silent failure.
func (c Config) SMTPConfigured() bool {
	return c.SMTPHost != "" && c.SMTPUsername != "" && c.SMTPPassword != "" && c.SMTPFrom != ""
}

// GitHubConfigured reports whether GitHub OAuth is ready. All three values
// (ClientID/Secret/RedirectURL) must be set.
func (c Config) GitHubConfigured() bool {
	return c.GitHubClientID != "" && c.GitHubClientSecret != "" && c.GitHubRedirectURL != ""
}

// GoogleConfigured reports whether Google OAuth is ready. All three values
// (ClientID/Secret/RedirectURL) must be set.
func (c Config) GoogleConfigured() bool {
	return c.GoogleClientID != "" && c.GoogleClientSecret != "" && c.GoogleRedirectURL != ""
}

// getenv returns the value of key if it is set and non-empty, otherwise
// fallback.
func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// ValidateJWTSecret 校验 JWT 密钥强度。生产环境不允许空值、已知默认值或
// 过短的密钥——这些密钥公开或可预测，会导致任意伪造登录令牌。
func ValidateJWTSecret(secret string) error {
	if secret == "" {
		return errors.New("JWT_SECRET is not set; set a random secret of at least 32 characters")
	}
	// 历史默认值（README 曾建议 change-this-in-production）一律拒绝。
	switch secret {
	case "dev-secret-change-me", "change-this-in-production", "secret":
		return errors.New("JWT_SECRET uses a known default value; set a random secret of at least 32 characters")
	}
	if len(secret) < 32 {
		return errors.New("JWT_SECRET is too short (need at least 32 characters)")
	}
	return nil
}
