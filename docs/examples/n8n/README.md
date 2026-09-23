# n8n Workflow: OpenWA to Discord

This example demonstrates how to receive OpenWA webhooks using n8n and forward incoming WhatsApp messages to a Discord channel using n8n's built-in HTTP Request node. No custom n8n node package is required.

## Prerequisites

1. An n8n instance.
2. A Discord Webhook URL.
3. OpenWA configured and running.

## Setup

1. **Import the Workflow**: Open n8n, click the "Import from file" option, and select the [`workflow.json`](./workflow.json) file.
2. **Environment Variable**: The workflow expects a Discord webhook URL. Define it as an environment variable in n8n (`DISCORD_WEBHOOK_URL`), or manually paste your webhook URL into the URL field of the HTTP Request node.
3. **Get the Webhook URL**: Activate the workflow and copy the **Production URL** from the OpenWA Webhook node (e.g., `https://n8n.example.com/webhook/openwa-discord`).
4. **Register in OpenWA**: Send a POST request to your OpenWA server to register the webhook URL, subscribing to the `message.received` event.

### API Key Scope

The API key used to register the webhook in OpenWA needs the **`OPERATOR`** role (or higher, such as `ADMIN`). A `VIEWER` key cannot register webhooks.

### Webhook Payload Expected

This workflow expects the standard OpenWA webhook payload for the `message.received` event. 

```json
{
  "event": "message.received",
  "timestamp": "2024-01-15T10:30:00Z",
  "sessionId": "default",
  "idempotencyKey": "a1b2c3d4e5f6...",
  "deliveryId": "9f8e7d6c5b4a...",
  "data": {
    "id": "3EB0F5A2B4C...",
    "chatId": "628123456789@c.us",
    "from": "628123456789@c.us",
    "body": "Hello!",
    "type": "text",
    "timestamp": 1705312200
  }
}
```

The workflow automatically extracts `{{ $json.body.data.from }}` and `{{ $json.body.data.body }}` to format the Discord message.
