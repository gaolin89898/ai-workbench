// Package config holds runtime configuration loading.
//
// Ported from the environment-variable reads in crates/server/src/main.rs.
// Values are sourced from environment variables with sensible defaults so the
// server can run in local development without extra setup. The Rust binary
// used BIND_ADDR (default 127.0.0.1:8080); the Go port switches to a PORT
// variable (default 3000) per the migration spec.
package config

import "os"

// Config groups every runtime knob the relay server reads.
type Config struct {
	DatabaseURL   string
	JWTSecret     string
	Port          string
	CORSOrigins   string
	MigrationsDir string
}

// Load reads configuration from environment variables, applying defaults for
// any that are unset or empty.
func Load() Config {
	return Config{
		DatabaseURL:   getenv("DATABASE_URL", "postgres://remote_term:remote_term@localhost:5432/remote_term"),
		JWTSecret:     getenv("JWT_SECRET", "dev-secret-change-me"),
		Port:          getenv("PORT", "3000"),
		CORSOrigins:   getenv("CORS_ORIGINS", "*"),
		MigrationsDir: getenv("MIGRATIONS_DIR", "./migrations"),
	}
}

// getenv returns the value of key if it is set and non-empty, otherwise
// fallback.
func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
