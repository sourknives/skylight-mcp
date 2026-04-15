# Skylight MCP Server

An MCP (Model Context Protocol) server for the Skylight Calendar API. Enables AI assistants like Claude to interact with your Skylight family calendar, chores, lists, and more.

## Features

- **Calendar**: Query calendar events ("What's on my calendar today?")
- **Chores**: View and create chores ("Add emptying dishwasher to chores")
- **Lists**: View grocery and to-do lists ("What's on the grocery list?")
- **Tasks**: Add items to the task box ("Add XYZ to my task list")
- **Family**: View family members and devices
- **Rewards**: Check reward points and available rewards (Plus subscription)
- **Meals**: Manage recipes and meal plans (Plus subscription)
- **Photos**: Browse photo albums (Plus subscription)

## Installation

This package is not published to npm. Install it by cloning and building from source.

```bash
git clone https://github.com/sourknives/skylight-mcp.git
cd skylight-mcp
npm install
npm run build
```

This produces an executable at `dist/index.js`.

### Configure your MCP client

**mcp.json:**
```json
{
  "mcpServers": {
    "skylight": {
      "command": "node",
      "args": ["/absolute/path/to/skylight-mcp/dist/index.js"],
      "env": {
        "SKYLIGHT_CLIENT_ID": "your_oauth_client_id",
        "SKYLIGHT_REFRESH_TOKEN": "your_refresh_token",
        "SKYLIGHT_FINGERPRINT": "your_device_uuid",
        "SKYLIGHT_FRAME_ID": "your_frame_id"
      }
    }
  }
}
```

**Claude Code:**
```bash
claude mcp add skylight node /absolute/path/to/skylight-mcp/dist/index.js \
  -e SKYLIGHT_CLIENT_ID=your_oauth_client_id \
  -e SKYLIGHT_REFRESH_TOKEN=your_refresh_token \
  -e SKYLIGHT_FINGERPRINT=your_device_uuid \
  -e SKYLIGHT_FRAME_ID=your_frame_id
```

### Instructions for AI

Copy this into your AI's custom instructions or system prompt:

> You have access to the Skylight MCP server. Skylight is a smart family calendar display that shows calendars, chores, grocery lists, meals, and rewards. Use the Skylight tools to help manage family schedules and organization.
>
> Tips:
> - Call `get_family_members` before assigning chores to get member names
> - Grocery items default to the main grocery list if no list specified
> - Dates accept "today", "tomorrow", day names, or YYYY-MM-DD format
> - Some tools (rewards, meals, photos) require Skylight Plus subscription

## Prerequisites

- Node.js 18+
- A Skylight account with an active subscription
- Your Skylight Frame ID (see [Finding your Frame ID](#finding-your-frame-id))

## Authentication

Skylight migrated to Doorkeeper OAuth2 in early 2026. The legacy
`POST /api/sessions` email/password endpoint no longer works — the only
supported grant is `refresh_token`. You bootstrap the server once by
capturing credentials from the Skylight web app, then the server
transparently rotates and persists the refresh token across restarts.

### Capturing credentials

1. Log in at https://app.ourskylight.com in your browser.
2. Open DevTools → Console and run:

   ```js
   (async () => {
     const s = JSON.parse(localStorage['mmkv.default\\auth-storage']).state;
     const js = [...document.scripts].map(x => x.src)
       .find(x => x.includes('_expo') && x.includes('index-'));
     const txt = await fetch(js).then(r => r.text());
     const m = txt.match(/client_id[:=]\s*['"]([A-Za-z0-9_-]{8,})['"]/);
     console.log({
       SKYLIGHT_CLIENT_ID: m && m[1],
       SKYLIGHT_REFRESH_TOKEN: s.refreshToken,
       SKYLIGHT_FINGERPRINT: s.uniqueId,
     });
   })();
   ```

3. Find your frame ID by clicking your calendar — the URL becomes
   `https://ourskylight.com/calendar/{SKYLIGHT_FRAME_ID}`.

### Token persistence

On first use, the MCP exchanges your refresh token for an access token
and writes the result to a local cache file. Skylight **rotates the
refresh token on every refresh**, so the cache file is rewritten after
each exchange. Default cache location:

- Windows: `%APPDATA%\skylight-mcp\token.json`
- macOS: `~/Library/Application Support/skylight-mcp/token.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/skylight-mcp/token.json`

Override with `SKYLIGHT_CACHE_DIR`. The cache file is written with
owner-only permissions (mode 0600 on POSIX).

### Recovery

If the logs show `refresh token is invalid or revoked`, re-capture
`SKYLIGHT_REFRESH_TOKEN` from the web app, update it in your MCP host's
config, and restart. The stale cache file is cleared automatically on
the next run (via a seed-hash check).

**Known limitation:** Running two MCP processes concurrently against the
same account will burn the refresh token — the second process will see
`invalid_grant` and fail. This is not supported.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SKYLIGHT_CLIENT_ID` | Yes | OAuth client ID from the Skylight web bundle |
| `SKYLIGHT_REFRESH_TOKEN` | Yes | OAuth refresh token (seed) from the web app |
| `SKYLIGHT_FINGERPRINT` | Yes | Device UUID from the web app's auth storage |
| `SKYLIGHT_FRAME_ID` | Yes | Household/frame ID |
| `SKYLIGHT_CACHE_DIR` | No | Override for the token cache directory |
| `SKYLIGHT_TIMEZONE` | No | Default timezone (default: `America/New_York`) |

### Example .env file:

```env
SKYLIGHT_CLIENT_ID=your_oauth_client_id
SKYLIGHT_REFRESH_TOKEN=your_refresh_token
SKYLIGHT_FINGERPRINT=your_device_uuid
SKYLIGHT_FRAME_ID=your_frame_id
SKYLIGHT_TIMEZONE=America/New_York
```

## Available Tools

See `CLAUDE.md` for the full tool inventory (35+ tools across calendar, chores, lists, tasks, family, rewards, meals, and photos).

## Example Queries

Once configured, you can ask Claude things like:

- "What's on my calendar today?"
- "What chores do I need to do this week?"
- "Add 'take out trash' to my chores for tomorrow"
- "What's on the grocery list?"
- "Add milk to my task list"
- "Who are the family members on Skylight?"
- "How many reward points does each person have?"

## Development

```bash
npm run dev         # Run with hot reload
npm run build       # Compile TypeScript
npm test            # Run tests
npm run typecheck   # Type-check without emitting
npm run lint        # ESLint
```

## License

MIT

## Disclaimer

This is an unofficial integration. The Skylight API is reverse-engineered and may change without notice. Use at your own risk.
