---
name: Dragon Shop Bot conventions
description: Discord bot architecture notes for the Dragon Shop bot — mention-balance systems, room ownership, admin checks.
---

- Single giant `bot.ts` handles all Discord logic. "Room channel" == purchased store. Admins = Administrator permission, not a fixed role.
- There are **two unrelated "mention" subsystems** — do not conflate them when extending:
  1. **Persistent mention-balance economy** (`offersBalance`/`hereBalance`/`everyoneBalance`/`ordersBalance`/`auctionBalance` on `bot_users`): a role (e.g. `OFFERS_ROLE_ID`, `ORDERS_ROLE_ID`, `AUCTION_ROLE_ID`) is granted while balance > 0, decremented by 1 per use detected in a room-owner's channel, exempted from AutoMod's mention-block via keyword allowlist, revoked with a cooldown after use. Purchased via `buy_mention_*` buttons → qty modal → ProBot transfer confirmation (`MentionKey` type, `pendingMentionPurchases` map).
  2. **Auction-ad announcement pricing** (`AUCTION_TYPES`/`AuctionType`, `buy_auc_mention_*`): a one-time payment to announce a *scheduled bidding auction* with a chosen mention tier (@everyone/@here/@offers). Not a balance, not tied to AutoMod exemption.
- When adding a new mention-balance type (e.g. "orders"/"auction"), it touches ~10+ call sites: role ID constant, `MentionKey` type, AutoMod keyword list, message mention-detection regex + deduction block, balance display embed (`!منشن`), `MENTION_BUY_KEYS`/`MENTION_BUY_CONFIG`/`MENTION_MODAL_CONFIG` maps, ProBot-confirmation balKey ternary, `/givebalance` command + its choices, and `/auto-publish` mentionType plumbing (type unions, validTypes, balKey ternary, mentionText ternary). Grep for `OFFERS_ROLE_ID` and `offersBalance` to find all of them.
- Per-room-tier free grants (`STATIC_ROOMS`, `offersCount`/`hereCount`/`everyoneCount`) are separate from the addon-purchase path — extending a new mention type does not require adding a per-tier grant unless explicitly requested.
