# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Pointeuse IziShip — French-language time-clock app for a logistics company. Tracks arrivals, departures and breaks for salaried staff and interim workers. UI strings, DB/API field names and code comments are in French (no accents in source) — follow that convention.

## Stack & layout

No build step, no bundler, no tests, no lint. Everything is two files:

- `public/index.html` — entire frontend as a single ~1900-line vanilla HTML/CSS/JS file. Multi-page SPA driven by `.nav-item[data-page=...]` buttons that toggle `.page#page-<name>` sections. Two roles coexist: admin view (pointage/scanner/salaries/rapport/historique/assistant/agent) and an employee view for self-scanning. Session is kept in `sessionStorage` under `pointeuse_session`.
- `netlify/functions/api.js` — single Netlify Function handling ALL `/api/*` routes via manual path/method dispatch inside one `exports.handler`. Netlify redirect `/api/*` → `/.netlify/functions/api/:splat` is defined in `netlify.toml`.

## Commands

```bash
netlify dev                 # local dev server (serves public/ + runs the function)
netlify deploy --prod       # deploy to production
curl -X POST https://<site>/api/init   # one-time: create tables & seed defaults
```

`npm install` has nothing to install — `package.json` has no dependencies. Netlify itself bundles the function with esbuild (configured in `netlify.toml`).

## Database access — important quirk

Despite the README mentioning `@netlify/neon`, `api.js` does **not** use that package. It talks to Neon's HTTP SQL endpoint directly: it parses `DATABASE_URL`, builds `https://<host>/sql`, and POSTs `{ query, params }` with the connection string in the `Neon-Connection-String` header. The response comes back as `{ fields, rows }` with rows as arrays of column values — the helper `sql()` zips them into objects. All DB access goes through `sql()` / `sql1()` in `api.js`; don't introduce a Postgres client package unless you're deliberately replacing this approach.

Env var resolution order: `DATABASE_URL` → `NETLIFY_DATABASE_URL_UNPOOLED` → `NETLIFY_DATABASE_URL`.

## Schema (created by `POST /api/init`)

- `workers` — salaried/interim staff. `type` is `'interim'` or `'cdi'`; schedules live as `sched_in`/`sched_out` `HH:MM` strings.
- `records` — one row per (worker, day). `arrival`/`departure` are `HH:MM` strings; `breaks` is a `JSONB` array of `{start, end}` objects (end `null` means break in progress).
- `postes` — physical workstations (for QR generation).
- `settings` — key/value store. Holds `admin_password` (default `'admin'`) and `qr_secret` (16-char token embedded in QR payloads as `iziship:<secret>:<posteId>`).
- `agent_memory` / `agent_runs` — power the autonomous RH agent (see below).

Times are stored as `HH:MM` strings, not timestamps. Duration math is done by splitting on `:` and converting to minutes — follow that pattern instead of introducing `Date` arithmetic on these fields.

## Scan flow (`POST /api/scan`)

Single endpoint that resolves the right action based on current state rather than the client telling it what to do:
1. No open record today (or last record has a `departure`) → create new record → `action: "arrival"`.
2. Last break has no `end` → close it → `action: "break_end"`.
3. Otherwise → respond `action: "choose"` with options `["break_start", "departure"]` so the client picks.

If `qrData` is provided, it's validated against `settings.qr_secret` before anything is written. Frontend mirrors this logic when the admin tablet scans a badge.

## Claude API integrations (require `ANTHROPIC_API_KEY`)

Two separate features both call `claude-sonnet-4-20250514` via `https://api.anthropic.com/v1/messages`:

- **`POST /api/assistant`** (`handleAssistant`) — interactive RH chat. Builds a French context block with current workers, today's records, and month-to-date stats (worked minutes, overtime, late count) and passes it as the `system` prompt alongside the user's message + history.
- **`POST /api/agent/run`** (`handleAgentRun`) — the autonomous agent. Loads workers + today + last 7 days + recent `agent_memory` (including items flagged `good`/`bad` by the director), asks Claude to return strict JSON `{observations[], summary, priority_action}`, then persists each observation to `agent_memory` and logs the run in `agent_runs`. Feedback loop: `POST /api/agent/feedback` sets `feedback='good'|'bad'` on a memory row, which is fed back into the next run's prompt so the agent reinforces approved observation types and suppresses rejected ones. Changes to the system prompt in `handleAgentRun` directly change agent behavior — treat it as production config.

## Authentication model

Token-based sessions stored in the `sessions` table (`token`, `worker_id`, `role`, `expires_at`). Tokens are issued at login via `crypto.randomUUID()`. Admin sessions have a 12h TTL; worker sessions 14h.

`POST /api/auth/login` accepts three modes:
- `admin` + password (checked against `settings.admin_password`) → `role='admin'`, `worker_id=NULL`
- `badge` (looks up worker by `workers.badge`, empty strings excluded) → `role='worker'`
- `name` + `workerId` (simple lookup, no password — intentional for the shared-tablet employee view) → `role='worker'`

Server-side enforcement lives in the `requireAuth(event, requiredRole)` helper in `api.js`. It parses `Authorization: Bearer <token>`, checks `sessions WHERE token=$1 AND expires_at>NOW()`, and throws `{status:401}` (missing/invalid/expired) or `{status:403}` (insufficient role). `requiredRole='admin'` demands exactly admin; `requiredRole='worker'` accepts worker or admin. 16 routes call it (workers, records, postes, agent/*, assistant, qr-secret/regenerate). `/api/scan` stays public because QR codes are read at physical stations before any session exists. `POST /api/init`, `/api/auth/login|logout|change-password`, and `GET /api/qr-secret` are also public.

One carve-out for the shared-tablet login flow: `GET /api/public/worker-names` returns `[{id, name, type, location, agency}]` (no badge/phone/pin/last_clock_state). `agency` is exposed so the punch tablet can filter the worker grid by intérim agency — info is semi-public (visible on badges, payslips) and the scraping-cost trade-off is acceptable. Rate-limited to 20 req/min/IP via an in-process `Map` — best-effort against scraping, resets on cold start. Do not broaden further without re-evaluating.

Client side, the `apiFetch` wrapper in `public/index.html` auto-injects `Authorization: Bearer <token>` from `localStorage['pointeuse_token']`. On a 401 it clears both `localStorage` keys (`pointeuse_token`, `pointeuse_expires`) AND `sessionStorage['pointeuse_session']` *before* throwing, then switches to the login screen with a "Session expirée" toast. At boot, if `pointeuse_expires - now < 60s` the client clears proactively to avoid races.

Default admin password is still `'admin'` — MUST be changed in production via `POST /api/auth/change-password`.

## RFID borne (Phase 6)

Pointage self-service par carte RFID EM4100 (125 kHz) via un lecteur Parallax #28340 USB branché sur un MacMini qui héberge une page borne plein écran. Lecteur validé empiriquement en avril 2026 : trame `\n + 10 chars ASCII hex uppercase + \r` en série 2400 8N1, `DTR=True` requis (sinon pas de transmission). Web Serial API côté navigateur — Chrome/Edge only, HTTPS obligatoire.

Colonne `workers.rfid_uid` (nullable) : UID EM4100 en ASCII hex uppercase (10 chars). Index UNIQUE partiel `WHERE rfid_uid IS NOT NULL` : deux workers ne peuvent pas partager le même UID, mais N workers peuvent être non-enrôlés simultanément. `GET /api/workers` expose `(rfid_uid IS NOT NULL) AS has_rfid` — le UID lui-même n'est **jamais** retourné côté client dans les listes (pattern identique à `pin_hash` / `has_pin`).

Routes Phase 6 :
- `POST /api/workers/:id/rfid` [admin] — body `{uid}`, regex `/^[0-9A-F]{10}$/`. 404 worker, 409 si UID déjà pris. Log `rfid_enroll` avec `uid_prefix` masqué.
- `DELETE /api/workers/:id/rfid` [admin] — 404 si pas de carte associée. Log `rfid_unenroll`.
- `POST /api/auth/rfid` [PUBLIC, rate-limited **10/min/IP bucket `rfid_auth`**] — body `{uid, station_token}`. Valide station → 401. Lookup worker → 404 et log `rfid_unknown_card` **avec UID complet en clair** (intentionnel, sert à l'enrôlement à chaud futur depuis le journal). `pin_locked` bloque RFID aussi → 423 + log `rfid_locked_card`. Succès : issue session worker 16h + log `rfid_clock` + return `{token, expires_at, worker:{id, name, last_clock_state}}`. Le rate-limit 429 ne log PAS d'event (sinon DoS = spam journal).

Types `security_events` ajoutés (6) : `rfid_enroll`, `rfid_unenroll`, `rfid_clock`, `rfid_unknown_card`, `rfid_locked_card`, `rfid_station_invalid`. Constante `SECURITY_EVENT_TYPES` côté `api.js` reste la source de vérité (event_type DB est TEXT libre, pas de CHECK).

Règle stricte sur les logs RFID : `uid_prefix = uid.substring(0,4) + "***"` partout SAUF dans `rfid_unknown_card.details.uid` qui reçoit l'UID complet (réservé à ce flux d'enrôlement à chaud). `checkRateLimit(event, N, bucket)` accepte un 3e argument optionnel pour isoler les seuils par endpoint — sans `bucket` on garde le comportement historique (clé = IP seule).

## Conventions when editing

- Prefer ES5-style `var` + `function` in both files — that's what the existing code uses and there's no transpile step for the function (esbuild will accept modern syntax, but the frontend runs as-is in browsers and matches the function style).
- Keep new routes inside the single dispatcher in `api.js` following the existing `if (method === "..." && path === "...")` pattern.
- Keep new UI inside `public/index.html`; add a nav button with `data-page="<name>"` and a matching `<div class="page" id="page-<name>">`. The nav wire-up loop at the bottom of the file handles show/hide.
- French user-facing strings, no accents in identifiers.
