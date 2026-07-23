// Package main is the entry point for the ai-workbench relay server.
//
// Ported from crates/server/src/main.rs. The bootstrapping flow is preserved
// one-to-one: load config, connect PostgreSQL, run migrations, build
// AppState, wire HTTP routes + WebSocket handlers, then serve with graceful
// shutdown on SIGINT/SIGTERM. The Rust binary used tracing_subscriber for
// logs and tower_http's TraceLayer for request tracing; the Go port uses the
// standard log package, mirroring the rest of the Go codebase. CORS is
// already applied inside routes.Handler.Router(), so no extra middleware is
// added here.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gaolin89898/ai-workbench/backend/internal/config"
	"github.com/gaolin89898/ai-workbench/backend/internal/db"
	"github.com/gaolin89898/ai-workbench/backend/internal/email"
	"github.com/gaolin89898/ai-workbench/backend/internal/routes"
	"github.com/gaolin89898/ai-workbench/backend/internal/state"
	"github.com/gaolin89898/ai-workbench/backend/internal/ws"
)

func main() {
	cfg := config.Load()

	// 1. Connect PostgreSQL.
	ctx := context.Background()
	database, err := db.New(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("db connect: %v", err)
	}
	defer database.Close()

	// 2. Run migrations (./migrations by default).
	if err := database.RunMigrations(ctx, cfg.MigrationsDir); err != nil {
		log.Fatalf("migrations: %v", err)
	}

	// 3. Build AppState.
	appState := state.NewAppState(database)

	// 4. Build routes + WebSocket handlers.
	// Construct the SMTP mailer only when fully configured; verification-code
	// login is unavailable otherwise (handlers return a clear 500).
	var mailer *email.Sender
	if cfg.SMTPConfigured() {
		mailer = email.NewSender(cfg.SMTPHost, cfg.SMTPPort, cfg.SMTPUsername, cfg.SMTPPassword, cfg.SMTPFrom, cfg.SMTPFromName)
		log.Printf("smtp configured: %s:%s from=%s", cfg.SMTPHost, cfg.SMTPPort, cfg.SMTPFrom)
	} else {
		log.Printf("warning: smtp not configured (SMTP_HOST/SMTP_USERNAME/SMTP_PASSWORD/SMTP_FROM); verification-code login unavailable")
	}
	if cfg.GitHubConfigured() {
		log.Printf("github oauth configured: client_id=%s redirect=%s", cfg.GitHubClientID, cfg.GitHubRedirectURL)
	} else {
		log.Printf("warning: github oauth not configured (GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET/GITHUB_REDIRECT_URL); github login unavailable")
	}
	routeHandler := routes.NewHandler(database, appState, cfg.JWTSecret, mailer, cfg.GitHubClientID, cfg.GitHubClientSecret, cfg.GitHubRedirectURL, cfg.GoogleClientID, cfg.GoogleClientSecret, cfg.GoogleRedirectURL)
	wsHandler := ws.NewHandler(database, appState, cfg.JWTSecret)

	mux := http.NewServeMux()
	mux.Handle("/", routeHandler.Router())
	mux.HandleFunc("GET /ws/mobile", wsHandler.HandleMobileWS)
	mux.HandleFunc("GET /ws/desktop", wsHandler.HandleDesktopWS)

	// 5. Start server.
	server := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: mux,
	}

	go func() {
		log.Printf("ai-workbench server listening on :%s", cfg.Port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	// 6. Graceful shutdown.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("shutting down...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Fatalf("shutdown: %v", err)
	}
	log.Println("server stopped")
}
