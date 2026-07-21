# Dragon Shop Bot

A Discord shop bot (بوت متجر الرومات) for managing room sales, auctions, and add-ons on a Discord server.

## Stack

- **Runtime**: Node.js (ESM)
- **Bot**: Discord.js v14
- **API**: Express v5
- **Database**: PostgreSQL via Drizzle ORM
- **Language**: TypeScript (bundled with esbuild)
- **Package manager**: pnpm (monorepo)

## Project structure

```
artifacts/api-server/   — Express + Discord bot (main service)
lib/db/                 — Drizzle schema and DB connection
lib/api-zod/            — Zod schemas generated from OpenAPI spec
lib/api-spec/           — OpenAPI spec + orval codegen config
lib/api-client-react/   — Generated React API client
```

## How to run

The **Dragon Bot** workflow starts everything:
```
PORT=8080 pnpm --filter @workspace/api-server run dev
```

This builds the TypeScript with esbuild, then starts the server + Discord bot.

After a fresh import, run `pnpm install` and push the DB schema (`cd lib/db && pnpm run push`) before starting the workflow — the bot exits fatally on boot if the `rooms` table doesn't exist yet.

Note: this project ships `artifacts/api-server/.replit-artifact/artifact.toml` and `artifacts/mockup-sandbox/.replit-artifact/artifact.toml` from before it was exported to GitHub, but `listArtifacts()` returns empty after a fresh import — artifact registration isn't carried over by git. The "Dragon Bot" workflow was configured directly via `configureWorkflow` (not the managed artifact-workflow path) as a working stand-in.

## Required secrets

| Secret | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal |
| `OWNER_ID` | Owner's Discord User ID |
| `GUILD_ID` | Discord server (guild) ID |
| `DATABASE_URL` | Auto-managed by Replit (do not set manually) |

## Database

Replit's built-in PostgreSQL. Schema is managed with Drizzle Kit.

To push schema changes:
```
cd lib/db && pnpm run push
```

Tables: `rooms`, `purchases`, `bot_users`, `addon_prices`, `warnings`, `auction_schedules`

## Bot features

- Full shop panel with categories (stores / orders / auctions / ranks / add-ons)
- Automatic purchase ticket system with ProBot verification
- Mention balance system (@everyone / @here / @offers)
- AutoMod: bad-word blocking + mention control
- Warning + auto-ban system (3 warnings = 4-day ban)
- 21 add-on prices stored in DB, editable via `/setaddonprice`
- Room ownership transfer with 50% fee

## User preferences

<!-- Add user preferences here -->
