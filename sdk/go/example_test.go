package openwa_test

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	openwa "github.com/rmyndharis/OpenWA/sdk/go"
)

func ExampleNew() {
	client, err := openwa.New("http://localhost:2785", "owa_k1_…")
	if err != nil {
		log.Fatal(err)
	}

	ctx := context.Background()
	// Sessions are addressed by the UUID that Create returns, not by name. Create a
	// session once; afterwards, find its ID with Sessions.List and a Name filter.
	session, err := client.Sessions.Create(ctx, openwa.CreateSessionRequest{Name: "my-session"})
	if err != nil {
		log.Fatal(err)
	}
	if _, err := client.Sessions.Start(ctx, session.ID); err != nil {
		log.Fatal(err)
	}

	res, err := client.Messages.SendText(ctx, session.ID, openwa.SendTextRequest{
		ChatID: "628123456789@c.us",
		Text:   "Hello from the OpenWA Go SDK!",
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(res.MessageID)
}

func ExampleClient_typedErrors() {
	client, _ := openwa.New("http://localhost:2785", "owa_k1_…")
	sessionID := "…" // the UUID that Sessions.Create returned, not the session name

	_, err := client.Messages.SendText(context.Background(), sessionID, openwa.SendTextRequest{
		ChatID: "628123456789@c.us",
		Text:   "hi",
	})
	switch {
	case errors.Is(err, openwa.ErrConflict):
		// Engine not ready (409) — retry after the session reaches "ready".
	case errors.Is(err, openwa.ErrNotFound):
		// Unknown session (404).
	case err != nil:
		var apiErr *openwa.APIError
		if errors.As(err, &apiErr) {
			log.Printf("API %d: %s", apiErr.StatusCode, apiErr.Message)
		}
	}
}

func ExampleWithRetry() {
	// Opt into automatic retries with exponential backoff, and inject a custom
	// per-request timeout — dependencies flow through functional options.
	client, _ := openwa.New("http://localhost:2785", "owa_k1_…",
		openwa.WithRetry(openwa.DefaultRetryPolicy()),
		openwa.WithTimeout(15*time.Second),
	)
	_ = client
}

func ExampleClient_webhookEvents() {
	client, _ := openwa.New("http://localhost:2785", "owa_k1_…")
	sessionID := "…" // the UUID that Sessions.Create returned, not the session name

	// Subscribe to the group and call events with the Event* constants — they
	// are the exact wire values, so a typo is a compile error, not a silent
	// no-delivery.
	_, err := client.Webhooks.Create(context.Background(), sessionID, openwa.CreateWebhookRequest{
		URL: "https://example.com/hook",
		Events: []string{
			openwa.EventGroupJoin,
			openwa.EventGroupLeave,
			openwa.EventGroupUpdate,
			openwa.EventCallReceived,
		},
	})
	if err != nil {
		log.Fatal(err)
	}
}
