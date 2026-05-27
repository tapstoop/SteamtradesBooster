# Troubleshooting

## GG.deals API Errors

### `GG.deals API error: 400 — ...`

A 400 Bad Request from the GG.deals API. The most common causes:

1. **Account not confirmed** — After registering on GG.deals, you must click the verification link in your email before the API key works. An unconfirmed account returns 400 regardless of key validity.
2. **Invalid API key** — Key is expired, revoked, or mistyped (including invisible characters from copy-paste).
3. **Invalid region code** — Supported regions: `au`, `be`, `br`, `ca`, `ch`, `de`, `dk`, `es`, `eu`, `fi`, `fr`, `gb`, `ie`, `it`, `nl`, `no`, `pl`, `se`, `us`.

The error message includes the API's response body (e.g., `GG.deals API error: 400 — Invalid API key`) plus an actionable hint for the most common cause.

### `GG.deals API error: 401/403 — ...`

Authentication/authorization failure. Check your API key in GG.deals Settings.

### `GG.deals API error: 429 — ...`

Rate limit exceeded. The extension handles this automatically by re-queuing and waiting. No user action needed — prices will appear once the rate limit resets.

### Rate Limits

- **100 IDs per minute**, **1000 IDs per hour**
- Each game per region counts as one ID (40 games × 2 regions = 80 IDs)
- Invalid requests also count against the limit
