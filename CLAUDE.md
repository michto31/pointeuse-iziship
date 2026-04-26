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
- `POST /api/auth/rfid` [PUBLIC, rate-limited **10/min/IP bucket `rfid_auth`**] — body `{uid, station_token}`. Valide station → 401. Lookup worker → 404 et log `rfid_unknown_card` **avec UID complet en clair** (intentionnel, sert à l'enrôlement à chaud futur depuis le journal). `pin_locked` bloque RFID aussi → 423 + log `rfid_locked_card`. Succès : issue session worker 16h + log `rfid_clock` + return `{token, expires_at, worker:{id, name, last_clock_state, sched_out}}`. Le `sched_out` est exposé uniquement après auth carte+station valides (pas dans `/api/public/worker-names` qui reste minimal) et sert à l'heuristique côté borne pour décider `break_start` vs `departure` quand l'état worker est `at_work`. Le rate-limit 429 ne log PAS d'event (sinon DoS = spam journal).

Types `security_events` ajoutés (6) : `rfid_enroll`, `rfid_unenroll`, `rfid_clock`, `rfid_unknown_card`, `rfid_locked_card`, `rfid_station_invalid`. Constante `SECURITY_EVENT_TYPES` côté `api.js` reste la source de vérité (event_type DB est TEXT libre, pas de CHECK).

Règle stricte sur les logs RFID : `uid_prefix = uid.substring(0,4) + "***"` partout SAUF dans `rfid_unknown_card.details.uid` qui reçoit l'UID complet (réservé à ce flux d'enrôlement à chaud). `checkRateLimit(event, N, bucket)` accepte un 3e argument optionnel pour isoler les seuils par endpoint — sans `bucket` on garde le comportement historique (clé = IP seule).

### Page borne plein écran (Phase 6 étape 3)

URL `/borne?station_token=XXX` (ou `/?mode=borne&station_token=XXX`) sert un mode plein écran isolé du flux admin/punch mobile. Détection au boot via `BORNE_MODE` (1re ligne du `<script>`) qui ajoute `body.borne-mode` et fait skip toute la startup admin/punch. Netlify redirect `/borne → /index.html` dans `netlify.toml` permet le routing path-based ; `?mode=borne` marche sans redirect.

Cycle d'écran : `boot` (clic obligatoire pour user-gesture Web Serial + AudioContext) → `idle` (en attente carte, horloge live) → `recognized` (fond vert, "Bonjour {Prénom} ! {Action} enregistré(e) à {HH:MM}", beep 880Hz/100ms) → retour `idle` après 3s. Erreurs : `error` (fond rouge, beep 220Hz/200ms) → retour `idle` après 4s. Cas spécial `misconfig` plein écran si `station_token` absent.

Heuristique d'action côté borne (module `borne` en fin de `<script>`) :
- `last_clock_state === 'idle'` → `arrival`
- `last_clock_state === 'on_break'` → `break_end`
- `last_clock_state === 'at_work'` :
  - si `nowMinutes >= schedOutMinutes - 15` → `departure`
  - sinon → `break_start`

Limitation V1 : workers en horaires décalés passant minuit (ex. 22:00–06:00) auront un calcul incorrect (l'arithmétique `hh*60+mm` ne gère pas le wrap). Acceptable pour journée standard 09h–17h. Une refonte demande sched_in + jours de travail + timezone côté worker.

Anti-double-read : `RFID_DEDUP_MS = 2000ms` constante en tête du module — le lecteur Parallax retransmet la trame en boucle tant que la carte est présente, on ignore les répétitions du même UID dans cette fenêtre.

Persistance Web Serial : `navigator.serial.getPorts()` retourne le port précédemment autorisé pour cette origine. Au 1er boot l'admin clique "Démarrer" et choisit le port via le picker OS. Aux reloads suivants, `getPorts()` renvoie le port direct, pas de picker — mais le bouton "Démarrer" reste obligatoire (user-gesture pour AudioContext).

Wake lock : `navigator.wakeLock.request('screen')` empêche la mise en veille pendant la session borne. Silencieux si l'API n'est pas disponible (Safari < iPadOS 16.4).

Heartbeat : `setInterval` 60s sur `POST /api/init` pour garder le Mac actif côté réseau et la function Netlify warm.

Disconnect handling : `navigator.serial.addEventListener('disconnect',...)` détecte le débranchement USB → état `error` "Lecteur déconnecté". À la reconnexion (`connect` event), tente automatiquement `getPorts()` + `borneOpenPort()` pour reprendre.

### Robustesse pointages orphelins (Phase 6)

Règle métier : **1 pointage = 1 jour calendaire**. Quand un worker scanne un nouveau jour avec un record d'un jour précédent encore ouvert (`departure IS NULL`), `closeOrphanPointages(workerId)` (api.js) clôture automatiquement le record orphelin avant que la state machine ne tourne. Évite le 409 "Aucun pointage ouvert pour aujourd'hui" observé en prod (cas Aymen pointé 22:54 → scan le lendemain 00:25 refusé).

Appelée en début de `POST /api/clock` ET `POST /api/auth/rfid` (après lookup worker + pin_locked check, avant issue session). Dans le flux RFID, /api/auth/rfid re-SELECTionne `last_clock_state` après le cleanup pour renvoyer la valeur fraîche au borne — qui pourra alors envoyer la bonne action (`arrival`) au /api/clock qui suit. L'appel défensif dans /api/clock est no-op pour le flux RFID (déjà nettoyé) mais utile pour le flux PIN.

Calcul du `departure` auto : `arrival + (sched_out - sched_in)` minutes, modulo 24h pour gérer les horaires de nuit (sched_out < sched_in). Fallback **480 minutes (8h)** si schedule manquant ou invalide. Stocké en HH:MM sur le record original (la `date` reste celle de l'arrivée — pas d'invention de date différente). Si un break était ouvert, il est aussi clôturé : `break_end = break_start + 30min`.

Trace : event `pointage_orphan_closed` dans `security_events` avec `details = {worker_id, orphan_record_id, orphan_record_date, original_arrival_hhmm, auto_departure_hhmm, days_late, had_open_break, reason: 'auto_close_on_new_day'}`. L'admin peut consulter dans le journal pour corriger les heures de départ approximatives si l'estimation théorique ne colle pas. Cas multi-jours (très rare) : 1 cleanup par scan, les jours antérieurs se nettoient aux scans suivants.

Limitation V1 documentée plus haut : le calcul `(sched_out - sched_in + 1440) % 1440` gère correctement les horaires de nuit modernes mais pas les workers en horaires décalés très exotiques. Acceptable pour la flotte actuelle (CDI 09–17, intérimaires 09–18).

### Cartes intérimaires partagées (Phase 6 ext)

Concept : N cartes RFID "intérim" interchangeables, distribuées par l'admin le matin et rendues le soir. Quand une carte intérim est scannée à la borne, écran de sélection agence puis liste des intérimaires de l'agence (créables à la volée pour les nouveaux). Les cartes nominatives existantes (`workers.rfid_uid`) continuent en parallèle.

**Schéma DB ajouté** :
- `interim_cards (id, uid VARCHAR(10) UNIQUE, label, active, created_at)` : whitelist des cartes partagées. Enrôlement V1 via SQL : `INSERT INTO interim_cards (uid, label) VALUES ('XXXXXXXXXX', 'Carte 1');`
- `interim_cards_creations (card_uid, date, count, PK composite)` : compteur (carte, jour) pour limiter à 1 création/carte/jour.
- `workers.active BOOLEAN DEFAULT true` : marque les départs sans suppression. Toutes les listes filtrent `COALESCE(active, true)=true`.
- `workers.pending_admin_approval BOOLEAN DEFAULT false` : worker créé via borne, en attente. Visible dans la borne pour son propre pointage MAIS masqué dans `/api/public/worker-names` (dashboard) et le rapport tant que pending.
- `workers.created_via_borne BOOLEAN DEFAULT false` : trace l'origine.

**Workflow** :
1. Karim arrive, l'admin lui donne une carte intérim libre.
2. Karim scanne → `POST /api/auth/rfid` ne trouve pas de worker, MAIS trouve la carte dans `interim_cards` → renvoie `{type:"interim_picker", card_uid, agencies:[]}` (PAS de session).
3. Borne montre l'écran agence → Karim clique "Adecco".
4. Borne `POST /api/interim/list-by-agency` → liste des Adecco actifs+approuvés.
5a. Karim clique son nom → `POST /api/interim/clock {card_uid, station_token, worker_id}` → session worker 16h + log `rfid_clock_via_group_card`. Borne enchaîne `POST /api/clock` comme pour une carte nominative.
5b. Karim clique "+ Je suis nouveau" → formulaire (prénom, nom, téléphone) → submit → optional `POST /api/interim/fuzzy-search` (ILIKE pour pré-vérifier doublons) → si match modal "Vous êtes X ?" → soit clock sur match soit POST `/api/interim/create` → worker créé `pending_admin_approval=true`, log `worker_created_via_borne` + `rfid_clock_via_group_card`, session 16h.

**Routes Phase 6 ext** :
- `POST /api/auth/rfid` : modifié — fallback `interim_picker` si UID pas dans workers mais dans interim_cards.
- `POST /api/interim/list-by-agency` [PUBLIC, 30/min/IP bucket `interim_list`]
- `POST /api/interim/fuzzy-search` [PUBLIC, 30/min/IP bucket `interim_list`] — ILIKE simple, pas Levenshtein (extension `fuzzystrmatch` non garantie sur Neon)
- `POST /api/interim/clock` [PUBLIC, 30/min/IP bucket `interim_clock`]
- `POST /api/interim/create` [PUBLIC, 5/min/IP bucket `interim_create`] — limites : 1 création/carte/jour + 5 globales/jour
- `GET /api/admin/workers/pending` [admin] — liste des workers à valider
- `POST /api/admin/workers/:id/approve` [admin] — passe `pending_admin_approval` à false

**Anti-collision** : `POST /api/workers/:id/rfid` rejette désormais (409) une UID déjà déclarée comme carte intérim. Inverse non géré (pas de route admin pour `interim_cards` en V1) — l'admin doit vérifier manuellement avant `INSERT INTO interim_cards`.

**Event types ajoutés (5)** : `rfid_clock_via_group_card`, `worker_created_via_borne`, `worker_approved`, `interim_card_limit_exceeded`, `interim_create_global_limit_exceeded`. Les details `uid_prefix` ou `card_uid_prefix` masqués 4 chars + `***` partout.

**Limitation V1** : pas de protection contre multi-clic rapide sur le picker intérim (l'utilisateur peut cliquer 2 noms différents en succession). La state machine `/api/clock` refuse les transitions invalides → le 2e clic donne un 409 propre. Acceptable pour V1, à durcir si observé en prod.

**Sémantique des flags workers** :
- `active=false` → worker parti (préserve historique mais masqué partout)
- `pending_admin_approval=true` → worker créé via borne, attente de validation. Visible dans la borne pour son propre flux, masqué dashboard et rapport.
- Un worker peut être `active=true && pending_admin_approval=true` (nouveau, en attente) ou `active=true && pending_admin_approval=false` (validé) ou `active=false` (parti).

## Conventions when editing

- Prefer ES5-style `var` + `function` in both files — that's what the existing code uses and there's no transpile step for the function (esbuild will accept modern syntax, but the frontend runs as-is in browsers and matches the function style).
- Keep new routes inside the single dispatcher in `api.js` following the existing `if (method === "..." && path === "...")` pattern.
- Keep new UI inside `public/index.html`; add a nav button with `data-page="<name>"` and a matching `<div class="page" id="page-<name>">`. The nav wire-up loop at the bottom of the file handles show/hide.
- French user-facing strings, no accents in identifiers.
