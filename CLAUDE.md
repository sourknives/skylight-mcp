# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

MCP server enabling AI assistants to interact with the Skylight family calendar API (calendar, chores, lists, tasks, rewards).

Base API URL: `https://app.ourskylight.com`

## Commands

```bash
npm install
npm run build          # Compile TypeScript
npm run dev            # Development with hot reload (tsx watch)
npm test               # Run vitest tests
npm test -- dates      # Run single test file (matches filename)
npm run test:coverage  # Tests with coverage
npm run lint           # ESLint
npm run typecheck      # tsc --noEmit
```

## Architecture

**Two-tier tool system**:
1. `api/endpoints/*.ts` (8 modules) - Low-level HTTP wrappers for each API resource
2. `tools/*.ts` (6 modules) - MCP tool definitions with Zod parameter validation

**Tool Registration**: Each domain exports `registerXxxTools(server)` called from `server.ts`.

**Key files**:
- `config.ts` - Zod-validated env config supporting two auth methods
- `api/client.ts` - HTTP client with Bearer/Basic auth, auto-login for email/password
- `api/auth.ts` - Login endpoint for email/password authentication
- `utils/dates.ts` - Parses "today", "tomorrow", day names, YYYY-MM-DD

## Authentication

Two methods supported (validated via Zod refinement in `config.ts`):

1. **Email/Password** (recommended): Set `SKYLIGHT_EMAIL` and `SKYLIGHT_PASSWORD`. Server auto-logs in via POST /api/sessions.
2. **Manual Token**: Set `SKYLIGHT_TOKEN` and optionally `SKYLIGHT_AUTH_TYPE` (bearer/basic).

Both require `SKYLIGHT_FRAME_ID` (household identifier from API URLs like `/api/frames/{frameId}/chores`).

## MCP Tools (12 total)

| Category | Tools |
|----------|-------|
| Calendar | `get_calendar_events`, `get_source_calendars` |
| Chores | `get_chores`, `create_chore` |
| Lists | `get_lists`, `get_list_items` |
| Tasks | `create_task` |
| Family | `get_family_members`, `get_frame_info`, `get_devices` |
| Rewards | `get_rewards`, `get_reward_points` |

## Technical Details

- **Runtime**: Node.js 18+
- **Module System**: ESM (`"type": "module"`)
- **TypeScript**: ES2022 target, NodeNext module resolution, strict mode
- **API Format**: JSON:API patterns (type, id, attributes, relationships)
- **Timezone**: Defaults to America/New_York, configurable via `SKYLIGHT_TIMEZONE`

## Known Limitations

Not available in the reverse-engineered API:
- Creating calendar events (POST endpoint not documented)
- Adding items to lists (POST endpoint not documented)
- Meal plans
