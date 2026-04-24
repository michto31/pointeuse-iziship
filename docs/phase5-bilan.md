# Phase 5 — Bilan final

**Statut** : Phase 5 complète, livrable.
**Dernier commit** : `2728277` (cleanup dead code).
**Période** : commits `313e655` → `2728277` (17 commits).

## Objectif initial

Sécuriser le pointage par le salarié lui-même. Avant Phase 5 seul l'admin pouvait pointer pour ses salariés depuis le panneau admin — il n'existait pas de flux self-service sécurisé. Objectif : permettre au salarié de pointer seul au poste, avec preuve d'identité (PIN) et preuve de présence physique (QR du poste). Flux à 2 facteurs côté salarié — **PIN secret 4 chiffres** (ce que je sais) + **preuve de présence au poste** via un token cryptographique imprimé sur le QR au dépôt (ce que j'ai), plus un **audit trail** des actions sensibles côté admin.

## Les 7 étapes livrées

| # | Étape | Commit(s) clés |
|---|---|---|
| 1 | Migrations DB : colonnes PIN workers, colonnes security stations, table `security_events` | `313e655` |
| 2 | Endpoints stations (CRUD + verify + regenerate-token) | `e1b639d` |
| 3 | Endpoints PIN (status, create, verify, reset) + bcryptjs + timing-constant (dummy bcrypt + floor 500 ms) | `db0620f`, `cc22835`, `76c1aef`, `afb15f5` |
| 4 | Endpoint `POST /api/clock` (state machine arrival/break_start/break_end/departure) + `GET /clock/state` | `e6015db` |
| 5 | Front admin stations (CRUD + impression QR) + front salarié 5 écrans (A/B/C/D/E) + scan QR + PIN keypad + code_short fallback | `4027fc4`, `1d7e7e5` |
| 6 | Refonte écran « Qui pointe ? » — grille 2 colonnes, filtres location/contrat, fix ratio tuiles | `a10b90e` |
| 7 | Journal admin `security-events` + reset PIN depuis fiche worker + review BLOQUANT 1/2 + FIX 3/4/5/6/7 | `c345399`, `2728277` |

## Schéma DB final (Phase 5)

### Nouvelles colonnes `workers`
```sql
pin_hash           TEXT            -- bcrypt(pin), NULL = pas encore créé
pin_attempts       INT DEFAULT 0   -- compteur échecs consécutifs
pin_locked         BOOLEAN DEFAULT FALSE  -- true après 5 échecs
last_clock_state   TEXT DEFAULT 'idle'    -- idle|at_work|on_break
location           TEXT DEFAULT 'toulouse' -- filtre géographique
```

### Nouvelles colonnes `postes`
```sql
code_short    TEXT   -- code court humain (fallback si QR cassé)
secret_token  TEXT   -- token 16 chars (preuve de présence)
active        BOOLEAN DEFAULT TRUE
```

### Nouvelle colonne `records`
```sql
station_id    INT REFERENCES postes(id)  -- poste où le pointage a eu lieu
```

### Nouvelle table `security_events`
```sql
id          SERIAL PRIMARY KEY
event_type  TEXT NOT NULL  -- pin_fail|pin_lock|pin_create|pin_reset|station_regen|station_secret_view
worker_id   INT REFERENCES workers(id) ON DELETE SET NULL
station_id  INT REFERENCES postes(id)  ON DELETE SET NULL
details     JSONB DEFAULT '{}'
created_at  TIMESTAMPTZ DEFAULT NOW()
```

### Index ajoutés
- `idx_records_station` sur `records(station_id)`
- `idx_security_events_created` sur `security_events(created_at DESC)`
- `idx_security_events_type` sur `security_events(event_type)`
- `idx_workers_location_type` sur `workers(location, type)`

## Routes API ajoutées (14)

### Stations (admin)
- `GET  /api/stations`
- `POST /api/stations`
- `PUT  /api/stations/:id`
- `DELETE /api/stations/:id`
- `GET  /api/stations/:id/full` (avec `secret_token` — log un `station_secret_view`)
- `POST /api/stations/:id/regenerate-token` (log un `station_regen`)

### Stations (public, rate-limited)
- `POST /api/stations/verify` (token → `{ok, station:{id,name}}`, sans secret)

### PIN workers
- `GET  /api/workers/:id/pin/status` (retourne `has_pin`, `locked`)
- `POST /api/workers/:id/pin/create` (salarié vient de se présenter)
- `POST /api/workers/:id/pin/verify` (timing-constant 500 ms floor + dummy bcrypt, log `pin_fail`/`pin_lock`)
- `POST /api/workers/:id/pin/reset` (admin seul, log `pin_reset` avec `source:"admin_ui"`)

### Pointage
- `GET  /api/clock/state` (worker session → `idle|at_work|on_break` + last record)
- `POST /api/clock` (state machine, refuse transitions invalides via 409)

### Audit
- `GET  /api/security-events` (admin, filtres type/worker/station/from/to + pagination)

## Sécurité

- **PIN** : bcryptjs (cost 10 = ~60 ms), jamais stocké en clair, jamais exposé côté client.
- **Timing-constant verify** : dummy bcrypt sur les paths d'erreur (worker introuvable, déjà locked) + floor 500 ms. Mesures empiriques acceptées : `min_success=min_fail=737 ms`, delta médian ~100 ms (bruit réseau documenté).
- **Rate limiting in-process** : 5/min/IP sur pin/*, 10/min/IP sur stations/verify et clock/state, 20/min/IP sur public/worker-names (préexistant). Reset sur cold start — best-effort.
- **Session tokens** : UUID v4 en DB, TTL 12 h admin / 16 h worker. Validation serveur via `requireAuth()`.
- **Preuve de présence** : `secret_token` 16 chars imprimé sur le QR au dépôt, jamais en clair dans les logs (FIX du cleanup : suppression de `logTokenPrefix` qui laissait fuiter 8 chars).
- **Audit trail** : 6 event types auto-loggés dans `security_events`, consultables via `/api/security-events` côté admin.
- **Lockout** : 5 échecs PIN consécutifs → `pin_locked=true`. Seul admin peut reset.

## Stats repo

- **Commits Phase 5** : 17
- **Fichiers touchés** : 2 (`public/index.html`, `netlify/functions/api.js`) + 2 locaux (`public/vendor/jsqr.min.js`, `public/vendor/qrcode.min.js`)
- **LOC nettes** : ~+2080 (vs `313e655^`)
- **Dépendances ajoutées** : `bcryptjs` (seule nouvelle dep serveur)

## Dette technique identifiée

1. **Console logs `initData`** : le catch silencieux dans `initData` peut masquer de vraies erreurs DB au boot — aujourd'hui on swallow tout. À terme : distinguer "table déjà créée" (OK) vs "connexion refusée" (à remonter).
2. **Rate limiter in-process** : `Map` JS éphémère, reset sur cold start Netlify (toutes les ~15 min sans trafic). Pour vrai anti-abus il faudra Upstash / Redis ou similaire.
3. **Timing-constant floor à 500 ms** : compromis entre UX (latence visible) et sécurité. Delta réseau (~100 ms médian) reste mesurable par un attaquant avec assez d'échantillons — acceptable pour la menace model (brute force d'un PIN à 4 chiffres = 10 000 combos, 5 essais max avant lockout).
4. **Pas de rotation automatique des `secret_token`** : un QR compromis reste valide jusqu'à régénération manuelle.
5. **Pas de tests automatisés dans le repo**. Vérifications manuelles : `node --check` sur api.js, syntax check du `<script>` extrait d'index.html, grep apostrophes françaises dans les strings JS, tests curl manuels des endpoints après chaque étape. Checklist manuelle documentée à chaque étape dans la conversation.

## Choix conservés

- **Route `POST /api/scan` + `handleScan()`** : conservées comme fallback legacy badge (les workers Melyne et Lou Anne ont un champ `badge` rempli). Pas utilisée par le frontend actuel mais garde-fou si retour au flux badge.

## Backlog post-Phase 5

- **DNS custom** : migrer de `pointeuse-iziship.netlify.app` vers un sous-domaine iziship.co (HTTPS auto via Netlify).
- **Multi-admin** : aujourd'hui mot de passe admin unique dans `settings.admin_password`. Ajouter table `admins(id, name, pwd_hash, role, active)` + UI de gestion.
- **Photos au pointage** : capture webcam à l'arrivée (avec consentement), stockée en blob S3 / Netlify Blobs, consultable depuis la fiche record.
- **launchctl agent RH** : déclencher l'agent RH autonome via launchctl sur le MacMini plutôt qu'à la demande. Le code de l'agent existe déjà (`handleAgentRun` + tables `agent_memory` / `agent_runs`).
- **Export PDF mensuel par salarié** : pack RH auto (feuille de présence, récap heures, cumul retards). Route `/api/rh/generate` existe mais génère pour un mois/tous les salariés, pas pour un salarié individuel.
- **Notifications push** : alerter admin sur `pin_lock` ou 3+ retards consécutifs sur 7 jours.
