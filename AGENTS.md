# AGENTS.md

Guide for people and AI coding tools changing Couchside. Read this before editing.

## Shape

- One Cloudflare Worker (`src/index.js`) serves the static pages in `public/` and the JSON API under `/api/*`.
- One D1 (SQLite) database, binding `DB`. Tables are created on the first request after each deploy (`src/schema.js`); there are no migrations. Add columns with care: `CREATE TABLE IF NOT EXISTS` won't alter an existing table, so a new column needs an `ALTER TABLE` guarded by a check.
- No build step and no framework. Browser code is plain scripts loaded in order: `qrcode.js` → `sound.js` → `common.js` → page script.

## Files

| File | What |
|---|---|
| `src/index.js` | API router, game phases, scoring, grouping, admin actions, test players ("bots"), settings |
| `src/ai.js` | Optional AI providers for answer grouping. One function per provider; add new ones to `PROVIDERS` + `PROVIDER_IDS` and the dropdown in `admin.js` |
| `src/schema.js` | Table definitions + one-time starter questions |
| `public/js/common.js` | `h()` DOM helper, API `call()`, settings (`CFG`, `applyCfg`), rules text, host lead-in lines, finale timings |
| `public/js/play.js` | Guest phone screens |
| `public/js/tv.js` | TV screens: QR, live vote, reveal showcase, animated leaderboard, finale, printable poster (`/tv?print=1`) |
| `public/js/admin.js` | Host screens: Game, Questions (packs, import/export), Players, Settings |
| `public/js/sound.js` | Music and effects generated with WebAudio (no audio files) |
| `public/packs/*.json` | Question packs. `index.json` lists them |
| `test/smoke.mjs` | End-to-end test against a running dev server |

## Game flow

Phases: `answer` → `vote` (answers locked, host reviews groups) → `reveal` → `final` → `final_reveal`.
In `reveal`, each question has 3 steps: 0 = question up (write-ins: timed vote), 1 = TV reveal, 2 = leaderboard.
Phones only get answers at step 2, after the TV shows them.

Question kinds: `mc`, `text` (guess the host), `funny` (votes only), `number` (final only). `votable(p)` means text or funny.

## Rules worth keeping

- **Scoring is server-side only** (`scorePrompt`, `computeScores`). Never trust a client score.
- **Host answers never reach phones before their reveal step.** Check `revealSlide(…, withNames)` and `playerState` when changing what's sent.
- **Guest text is rendered with text nodes only** (`h()` never uses innerHTML for data). The only innerHTML is static SVG and the locally generated QR.
- **AI keys never leave the server.** `publicCfg()` strips `ai`; the key lives in `settings` row `ai_key` or the `AI_API_KEY` secret.
- **Polling must stay cheap.** Admin actions bump `game.ver`; guest actions bump `game.act`. TV/admin send `?v=<ver.act>`, phones `?v=<ver>`, and get `{same:true}` (2 row reads) when nothing changed. Don't add polling that skips this: a TV open all day polling a full load every 2s used ~5M D1 rows/day, the whole free allowance.
- **Demo mode (`env.DEMO === "1"`) is only for the public demo** (`demo/wrangler.toml`): no PIN, AI off, hourly wipe via the cron in `scheduled()`. Everything else must keep requiring `ADMIN_PIN`.
- Don't use other games' names, artwork or branding.

## Test

```bash
cp .dev.vars.example .dev.vars   # ADMIN_PIN=4242
npx wrangler dev                  # needs a Cloudflare login only for the AI binding; see below
npm test
```

To test without logging in to Cloudflare, copy `wrangler.toml` to `wrangler.test.toml`, delete the `[ai]` block and run `npx wrangler dev -c wrangler.test.toml`.
