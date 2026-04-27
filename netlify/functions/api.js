var crypto = require("crypto");
var bcrypt = require("bcryptjs");

var H = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS"
};

function json(d, s) { return { statusCode: s || 200, headers: H, body: JSON.stringify(d) }; }
function err(m, s) { return json({ error: m }, s || 400); }

var DB_URL = "";
function getDbUrl() {
  if (DB_URL) return DB_URL;
  DB_URL = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL_UNPOOLED || process.env.NETLIFY_DATABASE_URL || "";
  return DB_URL;
}

async function sql(query, params) {
  var url = getDbUrl();
  if (!url) throw new Error("No DATABASE_URL");
  var u = new URL(url);
  var endpoint = "https://" + u.hostname + "/sql";
  var res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Neon-Connection-String": url },
    body: JSON.stringify({ query: query, params: params || [] })
  });
  if (!res.ok) { var t = await res.text(); throw new Error("DB " + res.status + ": " + t.substring(0, 200)); }
  var data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  var fields = data.fields || [];
  var rows = data.rows || [];
  return rows.map(function (row) {
    if (!Array.isArray(row)) return row;
    var obj = {};
    for (var i = 0; i < fields.length; i++) { obj[fields[i].name] = row[i]; }
    return obj;
  });
}
async function sql1(q, p) { return (await sql(q, p))[0] || null; }

function authError(status, message) { var e = new Error(message); e.status = status; return e; }

// ─── Phase 5 — state machine du pointage worker ─────────────────────────
// Transitions valides pour workers.last_clock_state. Pas de CHECK en DB (souplesse
// pour ajouter de nouveaux états), donc TOUTE écriture de last_clock_state passe
// par setClockState() qui valide la valeur. Interdiction de UPDATE direct dans
// les autres routes — discipline de code.
var CLOCK_STATES = { idle: true, at_work: true, on_break: true };
async function setClockState(workerId, newState) {
  if (!CLOCK_STATES[newState]) throw new Error("Invalid clock state: " + newState);
  await sql("UPDATE workers SET last_clock_state=$1 WHERE id=$2", [newState, parseInt(workerId)]);
}

// ─── Phase 6 — auto-clôture des pointages orphelins ──────────────────────
// Règle métier : 1 pointage = 1 jour calendaire. Si un worker scanne un
// nouveau jour avec un record d'un jour précédent encore ouvert (departure
// IS NULL), on auto-clôture le record orphelin avant de traiter le scan.
// Évite le 409 "Aucun pointage ouvert pour aujourd'hui" + remet l'état
// worker à 'idle' pour que la state machine accepte la nouvelle arrival.
//
// Implémentation : 1 cleanup par appel (pas de récursion sur multi-jours,
// rare). Departure auto = arrival + (sched_out - sched_in) minutes,
// fallback 480 (8h) si schedule manquant ou invalide. Wrap-around 24h pour
// supporter les horaires de nuit (sched_out < sched_in).
function hhmmToMin(s) {
  var p = String(s).split(":");
  return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
}
function minToHHMM(m) {
  m = ((m % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}
function computeShiftDuration(schedIn, schedOut) {
  if (!schedIn || !schedOut) return 480;
  if (!/^\d{2}:\d{2}$/.test(schedIn) || !/^\d{2}:\d{2}$/.test(schedOut)) return 480;
  var d = (hhmmToMin(schedOut) - hhmmToMin(schedIn) + 1440) % 1440;
  return d === 0 ? 480 : d;
}
function daysBetweenISO(today, orphanDate) {
  var t = new Date(today + "T00:00:00Z").getTime();
  var o = new Date(orphanDate + "T00:00:00Z").getTime();
  return Math.round((t - o) / (24 * 3600 * 1000));
}

async function closeOrphanPointages(workerId) {
  if (!workerId) return;
  // Trouve le record le plus récent encore ouvert (departure NULL).
  var orphan = await sql1(
    "SELECT id, date, arrival, breaks, station_id FROM records " +
    "WHERE worker_id=$1 AND departure IS NULL " +
    "ORDER BY date DESC, id DESC LIMIT 1",
    [workerId]
  );
  if (!orphan) return;

  var orphanDateStr = String(orphan.date).substring(0, 10);
  var todayParis = getParisDate();
  // Comparaison lex sur YYYY-MM-DD : si le record est aujourd'hui (ou plus tard,
  // improbable), pas un orphan — on laisse le flux normal le gérer.
  if (orphanDateStr >= todayParis) return;

  // Cas dégénéré : record ouvert sans arrival valide. On log l'anomalie sans
  // tenter de calculer un departure (l'admin verra l'event et corrigera).
  if (!orphan.arrival || !/^\d{2}:\d{2}$/.test(orphan.arrival)) {
    await logSecurityEvent("pointage_orphan_closed", workerId, orphan.station_id || null, {
      worker_id: workerId,
      orphan_record_id: orphan.id,
      orphan_record_date: orphanDateStr,
      original_arrival_hhmm: orphan.arrival || null,
      auto_departure_hhmm: null,
      days_late: daysBetweenISO(todayParis, orphanDateStr),
      had_open_break: false,
      reason: "auto_close_failed_no_arrival"
    });
    return;
  }

  var workerSched = await sql1("SELECT sched_in, sched_out FROM workers WHERE id=$1", [workerId]);
  var duration = computeShiftDuration(
    workerSched && workerSched.sched_in,
    workerSched && workerSched.sched_out
  );
  var arrivalMin = hhmmToMin(orphan.arrival);
  var autoDepartureHHMM = minToHHMM(arrivalMin + duration);

  // Si un break était ouvert, le clôturer avant le departure (break_end =
  // break_start + 30min, fallback : arrival+1min si start invalide).
  var breaks = orphan.breaks;
  if (typeof breaks === "string") { try { breaks = JSON.parse(breaks); } catch (e) { breaks = []; } }
  if (!Array.isArray(breaks)) breaks = [];
  var hadOpenBreak = breaks.length > 0 && !breaks[breaks.length - 1].end;
  if (hadOpenBreak) {
    var lastBreak = breaks[breaks.length - 1];
    if (lastBreak.start && /^\d{2}:\d{2}$/.test(lastBreak.start)) {
      breaks[breaks.length - 1].end = minToHHMM(hhmmToMin(lastBreak.start) + 30);
    } else {
      breaks[breaks.length - 1].end = minToHHMM(arrivalMin + 1);
    }
  }

  // UPDATE record + reset worker → idle. Pas de transaction explicite (Neon
  // HTTP n'en a pas natif) — si le 2e UPDATE échoue, le record est déjà clos
  // mais le state worker reste at_work : le scan en cours échouera, l'admin
  // verra l'event orphan_closed et pourra corriger à la main.
  await sql(
    "UPDATE records SET departure=$1, breaks=$2::jsonb, updated_at=NOW() WHERE id=$3",
    [autoDepartureHHMM, JSON.stringify(breaks), orphan.id]
  );
  await setClockState(workerId, "idle");

  await logSecurityEvent("pointage_orphan_closed", workerId, orphan.station_id || null, {
    worker_id: workerId,
    orphan_record_id: orphan.id,
    orphan_record_date: orphanDateStr,
    original_arrival_hhmm: orphan.arrival,
    auto_departure_hhmm: autoDepartureHHMM,
    days_late: daysBetweenISO(todayParis, orphanDateStr),
    had_open_break: hadOpenBreak,
    reason: "auto_close_on_new_day"
  });
}

// Types d'événements security_events. Non contraint en DB (TEXT libre) mais toute
// insertion doit passer par logSecurityEvent() qui vérifie le type.
var SECURITY_EVENT_TYPES = { pin_fail: true, pin_lock: true, pin_create: true, pin_reset: true, station_regen: true, station_secret_view: true, rfid_enroll: true, rfid_unenroll: true, rfid_clock: true, rfid_unknown_card: true, rfid_locked_card: true, rfid_station_invalid: true, pointage_orphan_closed: true, rfid_clock_via_group_card: true, worker_created_via_borne: true, worker_approved: true, interim_card_limit_exceeded: true, interim_create_global_limit_exceeded: true };
async function logSecurityEvent(eventType, workerId, stationId, details) {
  if (!SECURITY_EVENT_TYPES[eventType]) throw new Error("Invalid security event type: " + eventType);
  await sql(
    "INSERT INTO security_events (event_type, worker_id, station_id, details) VALUES ($1, $2, $3, $4::jsonb)",
    [eventType, workerId || null, stationId || null, JSON.stringify(details || {})]
  );
}

// ─── Phase 5 — Stations : code_short et secret_token ─────────────────────
// Alphabet sans ambiguïté visuelle (exclu : 0 O 1 I L) — 31 chars, entropie 31^10
// ≈ 8e14 pour le code XXX-XXX-XXXX, largement suffisant pour quelques centaines
// de stations. Le secret_token utilise randomBytes(64) → 128 chars hex.
var STATION_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function genStationCode() {
  function seg(n) {
    var bytes = crypto.randomBytes(n);
    var out = "";
    for (var i = 0; i < n; i++) out += STATION_ALPHABET.charAt(bytes[i] % STATION_ALPHABET.length);
    return out;
  }
  return seg(3) + "-" + seg(3) + "-" + seg(4);
}
function genStationSecret() { return crypto.randomBytes(64).toString("hex"); }

// Normalise l'input utilisateur en saisie manuelle de code_short.
// Adaptation vs spec initiale (trim() → strip aussi les tirets de bord)
// pour accepter p.ex. " TLS-SAL-4782 " → "TLS-SAL-4782".
function normalizeStationCode(s) {
  return String(s || "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase();
}

// Insert avec retry sur collision (astronomiquement improbable, mais filet de
// sécurité + log explicite si ça arrivait un jour pour détecter un bug DB).
async function insertStationUnique(name) {
  for (var attempt = 0; attempt < 5; attempt++) {
    var code = genStationCode();
    var existing = await sql1("SELECT id FROM postes WHERE code_short=$1", [code]);
    if (existing) continue;
    var secret = genStationSecret();
    try {
      var row = await sql1(
        "INSERT INTO postes (name, code_short, secret_token, active) VALUES ($1, $2, $3, true) " +
        "RETURNING id, name, code_short, secret_token, active, created_at",
        [name, code, secret]
      );
      if (row) return row;
    } catch (e) {
      // Race rarissime entre SELECT et INSERT (UNIQUE index filet de secours).
      var msg = (e && e.message) || "";
      if (/unique|duplicate|23505|idx_postes_code_short/i.test(msg)) continue;
      throw e;
    }
  }
  console.error("[" + new Date().toISOString() + "] STATION_CODE_COLLISION_SATURATION name=" + JSON.stringify(name) + " — 5 collisions consécutives. Alphabet saturé improbable, vérifier la DB.");
  var err = new Error("STATION_CODE_COLLISION_SATURATION");
  err.status = 500;
  throw err;
}

// ─── Phase 5 — Clock (pointage) : helpers ──────────────────────────────

// Formatte l'heure courante en HH:MM (timezone Europe/Paris). Cohérent avec
// le format existant de records.arrival / departure / breaks[].start/end.
function getParisHHMM() {
  return new Date().toLocaleTimeString("fr-FR", {
    timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit"
  });
}

// Date du jour en YYYY-MM-DD, timezone Europe/Paris.
// Astuce : locale "sv-SE" (suédois) donne le format ISO naturellement.
function getParisDate() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
}

// Exécute un batch de queries Neon en UNE transaction HTTP (pattern déjà
// utilisé pour le seed de records Phase 2). Atomic : toutes les queries
// réussissent ou tout rollback côté Neon.
async function sqlTx(queries) {
  var url = getDbUrl();
  if (!url) throw new Error("No DATABASE_URL");
  var u = new URL(url);
  var endpoint = "https://" + u.hostname + "/sql";
  var res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Neon-Connection-String": url,
      "Neon-Batch-Isolation-Level": "Serializable"
    },
    body: JSON.stringify({ queries: queries })
  });
  if (!res.ok) { var t = await res.text(); throw new Error("DB TX " + res.status + ": " + t.substring(0, 200)); }
  var data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  // Normalise chaque result.rows en tableau d'objets (comme sql() le fait).
  return (data.results || []).map(function (r) {
    var fields = r.fields || [];
    var rows = r.rows || [];
    return rows.map(function (row) {
      if (!Array.isArray(row)) return row;
      var obj = {};
      for (var i = 0; i < fields.length; i++) obj[fields[i].name] = row[i];
      return obj;
    });
  });
}

// Transitions state machine pour /api/clock. Noms d'action en anglais pour
// rester cohérent avec CLOCK_STATES.
var STATE_TRANSITIONS = {
  arrival:     { from: ["idle"],                to: "at_work" },
  break_start: { from: ["at_work"],             to: "on_break" },
  break_end:   { from: ["on_break"],            to: "at_work" },
  departure:   { from: ["at_work", "on_break"], to: "idle" }
};

function allowedActionsFor(state) {
  var out = [];
  for (var act in STATE_TRANSITIONS) {
    if (STATE_TRANSITIONS[act].from.indexOf(state) >= 0) out.push(act);
  }
  return out;
}

// ─── Phase 5 — PIN workers : helpers ────────────────────────────────────

// Vérifie un station_token : renvoie {id} si valide ET active=true, null sinon.
// Utilisé par pin/status, pin/create, pin/verify (proof-of-presence physique).
async function verifyStationToken(token) {
  if (!token || typeof token !== "string") return null;
  var row = await sql1("SELECT id FROM postes WHERE secret_token=$1 AND active=true", [token.trim()]);
  return row || null;
}

// Délai constant-time pour pin/verify : attend au moins minMs depuis startTime.
// Pas d'await gratuit si déjà écoulé (pas de piège async, setTimeout seulement
// si wait > 0).
function respondAfterDelay(startTime, minMs) {
  var elapsed = Date.now() - startTime;
  var wait = minMs - elapsed;
  if (wait <= 0) return Promise.resolve();
  return new Promise(function (r) { setTimeout(r, wait); });
}

// Version "sûre" d'un worker pour les réponses de session (pas de fuite
// pin_hash, pin_attempts, pin_locked).
function safeWorker(w) {
  return {
    id: w.id,
    name: w.name,
    type: w.type,
    agency: w.agency || "",
    sched_in: w.sched_in,
    sched_out: w.sched_out,
    last_clock_state: w.last_clock_state || "idle"
  };
}

// Dummy hash précalculé au chargement du module. Utilisé pour équilibrer le coût
// CPU des chemins "rapides" de pin/verify (qui autrement sautent bcrypt) avec les
// chemins "lents" (wrong PIN / correct PIN). Sans ça, un attaquant peut distinguer
// "station invalide" (pas de bcrypt, ~50ms) de "wrong PIN" (bcrypt ~100ms).
var DUMMY_BCRYPT_HASH = bcrypt.hashSync("dummy-never-matches-by-design", 10);

// Exécute un bcrypt.compare "de leurre" avec DUMMY_BCRYPT_HASH pour consommer
// le même temps CPU que la branche réelle. try/catch silencieux — on ne se soucie
// pas du résultat, uniquement du temps passé.
async function runDummyBcrypt(pin) {
  try { await bcrypt.compare(String(pin || ""), DUMMY_BCRYPT_HASH); } catch (e) {}
}

// Logic principale de pin/verify, extrait dans une fonction pour pouvoir
// envelopper l'appel du dispatcher dans un Date.now() + respondAfterDelay.
// Retourne :
//   - { ok: true, token, expires_at, worker } si succès
//   - null sinon (toutes les erreurs — binary response)
// Les effets de bord (increment attempts, set locked, logSecurityEvent) se
// font ici avant le return. Le timing-floor se fait APRÈS cette fonction,
// côté dispatcher, pour couvrir tous les chemins. En plus, chaque chemin d'échec
// rapide exécute runDummyBcrypt() pour rapprocher le coût CPU de celui du
// bcrypt.compare réel (chemin match OK / wrong PIN).
async function handlePinVerifyInner(event, body, seg) {
  var pin = body && body.pin;
  var workerId = parseInt(seg[1]);
  if (!workerId || workerId <= 0) { await runDummyBcrypt(pin); return null; }
  if (!pin || !/^\d{6}$/.test(String(pin))) { await runDummyBcrypt(pin); return null; }
  var station = await verifyStationToken(body && body.station_token);
  if (!station) { await runDummyBcrypt(pin); return null; }
  var worker = await sql1("SELECT * FROM workers WHERE id=$1", [workerId]);
  if (!worker) { await runDummyBcrypt(pin); return null; }
  if (!worker.pin_hash) { await runDummyBcrypt(pin); return null; }
  if (worker.pin_locked) {
    await runDummyBcrypt(pin);
    await logSecurityEvent("pin_fail", worker.id, station.id, { reason: "attempted_on_locked" });
    return null;
  }
  var match = false;
  try { match = await bcrypt.compare(String(pin), worker.pin_hash); } catch (e) { match = false; }
  if (match) {
    await sql("UPDATE workers SET pin_attempts=0 WHERE id=$1", [worker.id]);
    var sess = await issueSession("worker", worker.id, 16);
    return { ok: true, token: sess.token, expires_at: sess.expires_at, worker: safeWorker(worker) };
  }
  // Fail path — atomic increment with auto-lock à 3
  // LEAST(..., 3) plafonne, pin_locked passe true à 3ème fail.
  // WHERE pin_locked=false empêche un déjà-locked de monter encore (ceinture+bretelles).
  var updated = await sql1(
    "UPDATE workers SET pin_attempts = LEAST(pin_attempts + 1, 3), " +
    "pin_locked = CASE WHEN pin_attempts + 1 >= 3 THEN true ELSE false END " +
    "WHERE id=$1 AND pin_locked=false " +
    "RETURNING pin_attempts, pin_locked",
    [worker.id]
  );
  var attempts = updated ? updated.pin_attempts : worker.pin_attempts;
  await logSecurityEvent("pin_fail", worker.id, station.id, { attempts: attempts });
  if (updated && updated.pin_locked) {
    await logSecurityEvent("pin_lock", worker.id, station.id, { attempts: 3 });
  }
  return null;
}

// In-process rate limiter (Map keyed by IP). Intentionally NOT persisted to DB:
// - Cold starts reset the window, so this is a best-effort slowdown on scraping,
//   not a hard boundary. That's fine for the only public list endpoint we expose
//   (worker-names, used 1-2x per legitimate session).
// - A real attacker can bypass by rotating IPs or waiting out a cold start, but
//   casual scrapers hit a 429 quickly which is the bar we want.
var rateLimitMap = new Map();
// 3e param `bucket` (optionnel) : namespace de la clé IP. Sans bucket, on
// garde le comportement historique (clé=ip). Avec bucket, la clé devient
// "bucket:ip" — utile pour isoler un endpoint sensible (ex. auth/rfid à
// 10/min) d'un autre qui partage le même seuil (ex. public/worker-names
// 20/min) pour que saturation de l'un ne bloque pas l'autre.
function checkRateLimit(event, maxPerMinute, bucket) {
  var h = event.headers || {};
  var fwd = h["x-forwarded-for"] || h["X-Forwarded-For"] || h["client-ip"] || "";
  var ip = fwd.split(",")[0].trim() || "unknown";
  var key = bucket ? (bucket + ":" + ip) : ip;
  var now = Date.now();
  var entry = rateLimitMap.get(key);
  if (!entry || now - entry.windowStart > 60000) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    // Opportunistic cleanup to cap memory on long-lived instances
    if (rateLimitMap.size > 1000) {
      for (var k of rateLimitMap.keys()) { if (now - rateLimitMap.get(k).windowStart > 60000) rateLimitMap.delete(k); }
    }
    return true;
  }
  entry.count++;
  return entry.count <= maxPerMinute;
}

async function requireAuth(event, requiredRole) {
  var headers = event.headers || {};
  var authHeader = headers.authorization || headers.Authorization || "";
  var m = /^Bearer\s+(.+)$/.exec(authHeader.trim());
  if (!m) throw authError(401, "unauthorized");
  var token = m[1].trim();
  var s = await sql1("SELECT worker_id, role FROM sessions WHERE token=$1 AND expires_at>NOW()", [token]);
  if (!s) throw authError(401, "unauthorized");
  if (requiredRole === "admin" && s.role !== "admin") throw authError(403, "forbidden");
  return s;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: H, body: "" };
  var dbUrl = getDbUrl();
  if (!dbUrl) return json({ error: "No DATABASE_URL" }, 500);

  var path = (event.path || "").replace("/.netlify/functions/api", "").replace(/^\/api\//, "").replace(/^\/+/, "");
  var method = event.httpMethod;
  var body = {};
  try { if (event.body) body = JSON.parse(event.body); } catch (e) {}
  var seg = path.split("/");
  var qs = event.queryStringParameters || {};

  try {
    // Public: /api/init is left unauthenticated because it is idempotent
    // (CREATE TABLE IF NOT EXISTS) and must be callable on a fresh deploy
    // before any admin account/session exists.
    if (method === "POST" && path === "init") { await initDB(); return json({ ok: true, message: "DB initialized" }); }
    if (method === "POST" && path === "auth/login") return await handleLogin(body);
    if (method === "POST" && path === "auth/logout") return await handleLogout(event, body);
    if (method === "POST" && path === "auth/change-password") return await handleChangePwd(body);

    // POST /api/auth/rfid [PUBLIC, 10/min/IP bucket rfid_auth] — Phase 6
    // Body: {uid, station_token}. Ordre de validation strict :
    //   1. Format UID → 400. 2. Station valide → sinon log station_invalid + 401.
    //   3. Worker existe avec ce UID → sinon log unknown_card (avec UID CLAIR
    //      intentionnel pour enrôlement à chaud futur) + 404. 4. pin_locked
    //      bloque aussi RFID → log locked_card + 423. 5. Issue session worker
    //      16h + log rfid_clock + return token.
    // Rate-limit 429 ne logue PAS d'event (sinon DoS = spam du journal).
    if (method === "POST" && path === "auth/rfid") {
      if (!checkRateLimit(event, 10, "rfid_auth")) return json({ error: "Too many requests" }, 429);
      var rfidAuthUid = String((body && body.uid) || "").trim().toUpperCase();
      if (!/^[0-9A-F]{10}$/.test(rfidAuthUid)) return err("Format UID invalide");
      var rfidAuthPrefix = rfidAuthUid.substring(0, 4) + "***";
      var rfidAuthStationToken = String((body && body.station_token) || "").trim();
      var rfidAuthStation = await sql1("SELECT id FROM postes WHERE secret_token=$1 AND active=true", [rfidAuthStationToken]);
      if (!rfidAuthStation) {
        await logSecurityEvent("rfid_station_invalid", null, null, { uid_prefix: rfidAuthPrefix, reason: "invalid_token" });
        return err("Station invalide", 401);
      }
      var rfidAuthWorker = await sql1("SELECT id, name, pin_locked, last_clock_state, sched_out FROM workers WHERE rfid_uid=$1 AND COALESCE(active, true)=true", [rfidAuthUid]);
      if (!rfidAuthWorker) {
        // Fallback Phase 6 ext : la carte n'est pas une carte personnelle, mais
        // peut être une carte intérimaire partagée. Si oui, retourne un picker
        // (pas de session ici — la session sera créée par /api/interim/clock
        // ou /api/interim/create après que le worker aura été choisi).
        var interimCard = await sql1("SELECT id FROM interim_cards WHERE uid=$1 AND active=true", [rfidAuthUid]);
        if (interimCard) {
          var agencies = await sql(
            "SELECT DISTINCT agency FROM workers " +
            "WHERE type='interim' AND agency IS NOT NULL AND agency<>'' AND COALESCE(active, true)=true " +
            "ORDER BY agency"
          );
          return json({
            type: "interim_picker",
            card_uid: rfidAuthUid,
            agencies: agencies.map(function (a) { return a.agency; })
          });
        }
        await logSecurityEvent("rfid_unknown_card", null, rfidAuthStation.id, { uid: rfidAuthUid, reason: "no_match" });
        return err("Carte inconnue", 404);
      }
      if (rfidAuthWorker.pin_locked) {
        await logSecurityEvent("rfid_locked_card", rfidAuthWorker.id, rfidAuthStation.id, { uid_prefix: rfidAuthPrefix });
        return err("Carte verrouillée", 423);
      }
      // Phase 6 — auto-clôture des records orphelins du jour précédent (cf
      // closeOrphanPointages). Si nettoyage : worker passe en 'idle' avant la
      // suite, donc le borne pourra envoyer 'arrival' au /api/clock qui suit.
      await closeOrphanPointages(rfidAuthWorker.id);
      // Re-SELECT last_clock_state pour refléter l'éventuel cleanup ci-dessus
      // (la valeur en mémoire sur rfidAuthWorker peut être stale).
      var rfidAuthFresh = await sql1("SELECT last_clock_state FROM workers WHERE id=$1", [rfidAuthWorker.id]);
      var rfidAuthState = (rfidAuthFresh && rfidAuthFresh.last_clock_state) || "idle";
      var rfidAuthSess = await issueSession("worker", rfidAuthWorker.id, 16);
      await logSecurityEvent("rfid_clock", rfidAuthWorker.id, rfidAuthStation.id, { uid_prefix: rfidAuthPrefix });
      return json({
        token: rfidAuthSess.token,
        expires_at: rfidAuthSess.expires_at,
        worker: { id: rfidAuthWorker.id, name: rfidAuthWorker.name, last_clock_state: rfidAuthState, sched_out: rfidAuthWorker.sched_out || "16:00" }
      });
    }

    // ═══ Phase 6 ext — flux cartes intérimaires partagées ═══════════════
    // 4 routes publiques rate-limitées + 2 routes admin. La carte intérimaire
    // a été reconnue par /api/auth/rfid qui a renvoyé un picker — la borne
    // navigue ensuite via list-by-agency, fuzzy-search (sur le formulaire de
    // création uniquement), puis clock OU create.

    // POST /api/interim/list-by-agency [PUBLIC, 30/min/IP bucket interim_list]
    // body : {card_uid, station_token, agency} → liste des intérimaires de
    // l'agence (active=true, pending_admin_approval=false).
    if (method === "POST" && path === "interim/list-by-agency") {
      if (!checkRateLimit(event, 30, "interim_list")) return json({ error: "Too many requests" }, 429);
      var ilCardUid = String((body && body.card_uid) || "").trim().toUpperCase();
      var ilStationToken = String((body && body.station_token) || "").trim();
      var ilAgency = String((body && body.agency) || "").trim();
      if (!ilCardUid || !ilStationToken || !ilAgency) return err("card_uid, station_token et agency requis");
      var ilStation = await verifyStationToken(ilStationToken);
      if (!ilStation) return err("Station invalide", 401);
      var ilCard = await sql1("SELECT id FROM interim_cards WHERE uid=$1 AND active=true", [ilCardUid]);
      if (!ilCard) return err("Carte intérimaire inconnue", 401);
      // Phase 6 ext fix : on inclut les pending (Q1=A) — un worker créé via borne
      // doit pouvoir re-pointer le même jour avant validation admin. Le filtre
      // pending=false reste sur /api/public/worker-names (page publique).
      var ilWorkers = await sql(
        "SELECT id, name, last_clock_state, COALESCE(pending_admin_approval, false) AS pending_admin_approval FROM workers " +
        "WHERE type='interim' AND agency=$1 AND COALESCE(active, true)=true " +
        "ORDER BY name",
        [ilAgency]
      );
      return json({ workers: ilWorkers });
    }

    // POST /api/interim/fuzzy-search [PUBLIC, 30/min/IP bucket interim_list]
    // body : {card_uid, station_token, first_name, last_name} → matches ILIKE
    // pour pré-vérifier doublons AVANT POST /api/interim/create.
    if (method === "POST" && path === "interim/fuzzy-search") {
      if (!checkRateLimit(event, 30, "interim_list")) return json({ error: "Too many requests" }, 429);
      var fsCardUid = String((body && body.card_uid) || "").trim().toUpperCase();
      var fsStationToken = String((body && body.station_token) || "").trim();
      var fsFirst = String((body && body.first_name) || "").trim();
      var fsLast = String((body && body.last_name) || "").trim();
      if (!fsCardUid || !fsStationToken) return err("card_uid et station_token requis");
      var fsStation = await verifyStationToken(fsStationToken);
      if (!fsStation) return err("Station invalide", 401);
      var fsCard = await sql1("SELECT id FROM interim_cards WHERE uid=$1 AND active=true", [fsCardUid]);
      if (!fsCard) return err("Carte intérimaire inconnue", 401);
      if (!fsFirst && !fsLast) return json({ matches: [] });
      // ILIKE pattern : '%first%last%' tolère casse, espaces et inversions partielles.
      // Fuzzystrmatch (Levenshtein) pas garanti sur Neon — V1 ILIKE simple suffit.
      var fsParts = [];
      if (fsFirst) fsParts.push(fsFirst);
      if (fsLast) fsParts.push(fsLast);
      var fsPattern = "%" + fsParts.join("%") + "%";
      // Phase 6 ext fix : on inclut les pending (Q1=A) pour cohérence avec
      // /api/interim/list-by-agency — sinon un worker tout juste créé serait
      // détecté comme doublon "absent" et permettrait de le re-créer.
      var fsMatches = await sql(
        "SELECT id, name, agency FROM workers " +
        "WHERE type='interim' AND COALESCE(active, true)=true " +
        "AND name ILIKE $1 " +
        "ORDER BY name LIMIT 5",
        [fsPattern]
      );
      return json({ matches: fsMatches });
    }

    // POST /api/interim/clock [PUBLIC, 30/min/IP bucket interim_clock]
    // body : {card_uid, station_token, worker_id} → close orphans + issue
    // session worker 16h. Le borne enchaîne avec POST /api/clock.
    if (method === "POST" && path === "interim/clock") {
      if (!checkRateLimit(event, 30, "interim_clock")) return json({ error: "Too many requests" }, 429);
      var icCardUid = String((body && body.card_uid) || "").trim().toUpperCase();
      var icStationToken = String((body && body.station_token) || "").trim();
      var icWorkerId = parseInt(body && body.worker_id, 10);
      if (!icCardUid || !icStationToken || !icWorkerId) return err("card_uid, station_token et worker_id requis");
      var icStation = await verifyStationToken(icStationToken);
      if (!icStation) return err("Station invalide", 401);
      var icCard = await sql1("SELECT id FROM interim_cards WHERE uid=$1 AND active=true", [icCardUid]);
      if (!icCard) return err("Carte intérimaire inconnue", 401);
      var icWorker = await sql1(
        "SELECT id, name, agency, pin_locked, last_clock_state, sched_out FROM workers " +
        "WHERE id=$1 AND type='interim' AND COALESCE(active, true)=true",
        [icWorkerId]
      );
      if (!icWorker) return err("Intérimaire introuvable ou inactif", 404);
      if (icWorker.pin_locked) return err("Compte verrouillé", 423);
      // Auto-clôture des records orphelins du jour précédent (cf closeOrphanPointages).
      await closeOrphanPointages(icWorker.id);
      var icFresh = await sql1("SELECT last_clock_state FROM workers WHERE id=$1", [icWorker.id]);
      var icState = (icFresh && icFresh.last_clock_state) || "idle";
      var icSess = await issueSession("worker", icWorker.id, 16);
      await logSecurityEvent("rfid_clock_via_group_card", icWorker.id, icStation.id, {
        card_uid_prefix: icCardUid.substring(0, 4) + "***",
        picked_worker_id: icWorker.id,
        picked_worker_name: icWorker.name,
        agency: icWorker.agency || ""
      });
      return json({
        token: icSess.token,
        expires_at: icSess.expires_at,
        worker: { id: icWorker.id, name: icWorker.name, last_clock_state: icState, sched_out: icWorker.sched_out || "17:00" }
      });
    }

    // POST /api/interim/create [PUBLIC, 5/min/IP bucket interim_create]
    // body : {card_uid, station_token, first_name, last_name, phone, agency}
    // Crée un worker intérimaire avec pending_admin_approval=true. Limites :
    // 1 création/carte/jour + 5 créations globales/jour (anti-abus).
    if (method === "POST" && path === "interim/create") {
      if (!checkRateLimit(event, 5, "interim_create")) return json({ error: "Too many requests" }, 429);
      var iCreateCardUid = String((body && body.card_uid) || "").trim().toUpperCase();
      var iCreateStationToken = String((body && body.station_token) || "").trim();
      var iCreateFirst = String((body && body.first_name) || "").trim();
      var iCreateLast = String((body && body.last_name) || "").trim();
      var iCreatePhone = String((body && body.phone) || "").trim();
      var iCreateAgency = String((body && body.agency) || "").trim();
      if (!iCreateCardUid || !iCreateStationToken || !iCreateFirst || !iCreateLast || !iCreatePhone || !iCreateAgency) {
        return err("Tous les champs requis (card_uid, station_token, first_name, last_name, phone, agency)");
      }
      if (!/^[+\d\s.\-()]{6,30}$/.test(iCreatePhone)) return err("Format téléphone invalide");
      var iCreateStation = await verifyStationToken(iCreateStationToken);
      if (!iCreateStation) return err("Station invalide", 401);
      var iCreateCard = await sql1("SELECT id FROM interim_cards WHERE uid=$1 AND active=true", [iCreateCardUid]);
      if (!iCreateCard) return err("Carte intérimaire inconnue", 401);
      // Agence existante (au moins 1 worker actif dans cette agence)
      var iCreateAgencyCheck = await sql1(
        "SELECT 1 FROM workers WHERE type='interim' AND agency=$1 AND COALESCE(active, true)=true LIMIT 1",
        [iCreateAgency]
      );
      if (!iCreateAgencyCheck) return err("Agence inconnue", 400);
      var iCreateToday = getParisDate();
      // Limite par carte (1/jour)
      var iCreateCardCount = await sql1(
        "SELECT count FROM interim_cards_creations WHERE card_uid=$1 AND date=$2",
        [iCreateCardUid, iCreateToday]
      );
      if (iCreateCardCount && iCreateCardCount.count >= 1) {
        await logSecurityEvent("interim_card_limit_exceeded", null, iCreateStation.id, {
          card_uid_prefix: iCreateCardUid.substring(0, 4) + "***",
          attempted_name: iCreateFirst + " " + iCreateLast,
          attempted_agency: iCreateAgency
        });
        return err("Limite de création atteinte pour cette carte aujourd'hui", 429);
      }
      // Limite globale (5/jour, basée sur created_at converti en heure de Paris)
      var iCreateGlobalCount = await sql1(
        "SELECT COUNT(*)::int AS n FROM workers " +
        "WHERE COALESCE(created_via_borne, false)=true " +
        "AND (created_at AT TIME ZONE 'Europe/Paris')::date = $1::date",
        [iCreateToday]
      );
      if (iCreateGlobalCount && iCreateGlobalCount.n >= 5) {
        await logSecurityEvent("interim_create_global_limit_exceeded", null, iCreateStation.id, {
          card_uid_prefix: iCreateCardUid.substring(0, 4) + "***",
          current_count: iCreateGlobalCount.n
        });
        return err("Limite globale de créations atteinte aujourd'hui", 429);
      }
      var iCreateName = iCreateFirst + " " + iCreateLast;
      var iCreateNew = await sql1(
        "INSERT INTO workers (name, type, agency, phone, sched_in, sched_out, last_clock_state, active, pending_admin_approval, created_via_borne) " +
        "VALUES ($1, 'interim', $2, $3, '09:00', '17:00', 'idle', true, true, true) " +
        "RETURNING id, name, agency, sched_out, last_clock_state",
        [iCreateName, iCreateAgency, iCreatePhone]
      );
      // Increment compteur carte (atomic via ON CONFLICT)
      await sql(
        "INSERT INTO interim_cards_creations (card_uid, date, count) VALUES ($1, $2, 1) " +
        "ON CONFLICT (card_uid, date) DO UPDATE SET count = interim_cards_creations.count + 1",
        [iCreateCardUid, iCreateToday]
      );
      await logSecurityEvent("worker_created_via_borne", iCreateNew.id, iCreateStation.id, {
        card_uid_prefix: iCreateCardUid.substring(0, 4) + "***",
        new_worker_id: iCreateNew.id,
        name: iCreateName,
        agency: iCreateAgency
      });
      // La création vaut un pointage immédiat → log aussi rfid_clock_via_group_card
      await logSecurityEvent("rfid_clock_via_group_card", iCreateNew.id, iCreateStation.id, {
        card_uid_prefix: iCreateCardUid.substring(0, 4) + "***",
        picked_worker_id: iCreateNew.id,
        picked_worker_name: iCreateName,
        agency: iCreateAgency,
        via_creation: true
      });
      var iCreateSess = await issueSession("worker", iCreateNew.id, 16);
      return json({
        token: iCreateSess.token,
        expires_at: iCreateSess.expires_at,
        worker: { id: iCreateNew.id, name: iCreateName, last_clock_state: "idle", sched_out: iCreateNew.sched_out || "17:00" }
      }, 201);
    }

    // GET /api/admin/workers/pending [admin] — liste des workers créés via
    // borne en attente de validation.
    if (method === "GET" && path === "admin/workers/pending") {
      await requireAuth(event, "admin");
      var pendingWorkers = await sql(
        "SELECT id, name, agency, phone, type, sched_in, sched_out, last_clock_state, " +
        "COALESCE(created_via_borne, false) AS created_via_borne, created_at " +
        "FROM workers WHERE COALESCE(pending_admin_approval, false)=true " +
        "ORDER BY created_at DESC"
      );
      return json({ workers: pendingWorkers });
    }

    // POST /api/admin/workers/:id/approve [admin] — passe un worker pending à
    // approuvé. Visible immédiatement sur le dashboard "Qui pointe" et le
    // rapport RH.
    if (method === "POST" && seg[0] === "admin" && seg[1] === "workers" && seg[2] && seg[3] === "approve" && !seg[4]) {
      var approveAuth = await requireAuth(event, "admin");
      var approveWorkerId = parseInt(seg[2], 10);
      if (!approveWorkerId) return err("Worker ID invalide");
      var approveResult = await sql1(
        "UPDATE workers SET pending_admin_approval=false, updated_at=NOW() " +
        "WHERE id=$1 AND COALESCE(pending_admin_approval, false)=true " +
        "RETURNING id, name",
        [approveWorkerId]
      );
      if (!approveResult) return err("Worker introuvable ou déjà approuvé", 404);
      await logSecurityEvent("worker_approved", approveWorkerId, null, {
        admin_worker_id: approveAuth.worker_id,
        worker_name: approveResult.name
      });
      return json({ ok: true });
    }

    // Minimal public endpoint pour la grille d'accueil du flow salarié (Phase 5).
    // Renvoie id, name, type (contract kind), location (site physique).
    // Type et location sont nécessaires côté client pour les segmented controls
    // Salariés/Intérimaires × Location. Rate-limited 20/min/IP contre scraping.
    // Phase 6 ext : filtre les workers active=false (départs) ET les pending
    // (créations borne non encore validées par l'admin) — pas de pollution
    // de la liste publique tant que l'admin n'a pas approuvé.
    if (method === "GET" && path === "public/worker-names") {
      if (!checkRateLimit(event, 20)) return json({ error: "Too many requests" }, 429);
      return json(await sql("SELECT id, name, type, location, agency FROM workers WHERE COALESCE(pending_admin_approval, false)=false AND COALESCE(active, true)=true ORDER BY name"));
    }

    if (method === "POST" && path === "assistant") { await requireAuth(event, "admin"); return await handleAssistant(body); }
    if (method === "POST" && path === "agent/run") { await requireAuth(event, "admin"); return await handleAgentRun(); }
    if (method === "GET" && path === "agent/observations") { await requireAuth(event, "admin"); return json(await sql("SELECT * FROM agent_memory ORDER BY created_at DESC LIMIT 50")); }
    if (method === "POST" && path === "agent/feedback") { await requireAuth(event, "admin"); await sql("UPDATE agent_memory SET feedback=$1 WHERE id=$2", [body.feedback, body.id]); return json({ ok: true }); }
    if (method === "GET" && path === "agent/runs") { await requireAuth(event, "admin"); return json(await sql("SELECT * FROM agent_runs ORDER BY run_date DESC LIMIT 20")); }

    if (method === "GET" && path === "workers") { await requireAuth(event, "admin"); return json(await sql("SELECT id, name, agency, type, phone, badge, sched_in, sched_out, location, pin_attempts, pin_locked, last_clock_state, (pin_hash IS NOT NULL) AS has_pin, (rfid_uid IS NOT NULL) AS has_rfid, COALESCE(active, true) AS active, COALESCE(pending_admin_approval, false) AS pending_admin_approval, COALESCE(created_via_borne, false) AS created_via_borne, created_at, updated_at FROM workers ORDER BY type, name")); }
    if (method === "POST" && path === "workers") {
      await requireAuth(event, "admin");
      if (!body.name) return err("Nom requis");
      return json(await sql1("INSERT INTO workers (name,agency,type,phone,badge,sched_in,sched_out,location) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *", [body.name, body.agency||"", body.type||"interim", body.phone||"", body.badge||"", body.schedIn||"08:00", body.schedOut||"16:00", body.location||"toulouse"]), 201);
    }
    if (method === "PUT" && seg[0] === "workers" && seg[1]) {
      await requireAuth(event, "admin");
      var r = await sql1("UPDATE workers SET name=COALESCE($1,name),agency=COALESCE($2,agency),type=COALESCE($3,type),phone=COALESCE($4,phone),badge=COALESCE($5,badge),sched_in=COALESCE($6,sched_in),sched_out=COALESCE($7,sched_out),location=COALESCE($8,location),updated_at=NOW() WHERE id=$9 RETURNING *", [body.name, body.agency, body.type, body.phone, body.badge, body.schedIn, body.schedOut, body.location, parseInt(seg[1])]);
      return r ? json(r) : err("Introuvable", 404);
    }
    if (method === "DELETE" && seg[0] === "workers" && seg[1] && !seg[2]) { await requireAuth(event, "admin"); await sql("DELETE FROM workers WHERE id=$1", [parseInt(seg[1])]); return json({ ok: true }); }

    if (method === "GET" && path === "records") {
      await requireAuth(event, "admin");
      var date=qs.date, wid=qs.workerId, from=qs.from, to=qs.to;
      if (date && wid) return json(await sql("SELECT r.*,w.type as worker_type FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date=$1 AND r.worker_id=$2 ORDER BY r.arrival", [date, parseInt(wid)]));
      if (date) return json(await sql("SELECT r.*,w.type as worker_type FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date=$1 ORDER BY w.type,r.arrival", [date]));
      if (from && to && wid) return json(await sql("SELECT r.*,w.type as worker_type FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date>=$1 AND r.date<=$2 AND r.worker_id=$3 ORDER BY r.date,r.arrival", [from, to, parseInt(wid)]));
      if (from && to) return json(await sql("SELECT r.*,w.type as worker_type FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date>=$1 AND r.date<=$2 ORDER BY r.date,w.type,r.arrival", [from, to]));
      return json(await sql("SELECT r.*,w.type as worker_type FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date=$1 ORDER BY w.type,r.arrival", [new Date().toISOString().slice(0,10)]));
    }
    if (method === "POST" && path === "records") {
      await requireAuth(event, "admin");
      if (!body.workerId || !body.arrival) return err("workerId et arrival requis");
      return json(await sql1("INSERT INTO records (worker_id,worker_name,agency,date,arrival,departure,breaks) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *", [body.workerId, body.workerName||"", body.agency||"", body.date, body.arrival, body.departure||null, JSON.stringify(body.breaks||[])]), 201);
    }
    if (method === "PUT" && seg[0] === "records" && seg[1]) {
      await requireAuth(event, "admin");
      var dep = body.departure !== undefined ? body.departure : null;
      var brk = body.breaks ? JSON.stringify(body.breaks) : null;
      return json(await sql1("UPDATE records SET arrival=COALESCE($1,arrival),departure=$2,breaks=COALESCE($3::jsonb,breaks),updated_at=NOW() WHERE id=$4 RETURNING *", [body.arrival, dep, brk, parseInt(seg[1])]), 200);
    }
    if (method === "DELETE" && seg[0] === "records" && seg[1]) { await requireAuth(event, "admin"); await sql("DELETE FROM records WHERE id=$1", [parseInt(seg[1])]); return json({ ok: true }); }

    if (method === "GET" && path === "postes") { await requireAuth(event, "admin"); return json(await sql("SELECT * FROM postes ORDER BY name")); }
    if (method === "POST" && path === "postes") { await requireAuth(event, "admin"); if (!body.name) return err("Nom requis"); return json(await sql1("INSERT INTO postes (name,location) VALUES ($1,$2) RETURNING *", [body.name, body.location||""]), 201); }
    if (method === "DELETE" && seg[0] === "postes" && seg[1]) { await requireAuth(event, "admin"); await sql("DELETE FROM postes WHERE id=$1", [parseInt(seg[1])]); return json({ ok: true }); }

    // ═══ Phase 5 — Stations (postes étendus avec code_short + secret_token) ═══
    // Les anciens routes /api/postes restent actifs pour ne pas casser l'UI admin
    // legacy (refondue à l'étape 5). Les routes /api/stations sont les nouvelles.

    // GET /api/stations — liste + nb de pointages 30j (JOIN records.station_id).
    // NE renvoie JAMAIS secret_token (visible uniquement à la création et au regen).
    if (method === "GET" && path === "stations") {
      await requireAuth(event, "admin");
      return json(await sql(
        "SELECT p.id, p.name, p.code_short, p.active, p.created_at, " +
        "  COUNT(r.id) FILTER (WHERE r.date >= CURRENT_DATE - INTERVAL '30 days')::int AS records_30d " +
        "FROM postes p LEFT JOIN records r ON r.station_id = p.id " +
        "GROUP BY p.id ORDER BY p.active DESC, p.name"
      ));
    }

    // POST /api/stations — crée une station avec code_short + secret_token auto-générés.
    // La réponse 201 inclut explicitement secret_token (seul moment où l'admin le voit,
    // hors regenerate-token).
    if (method === "POST" && path === "stations") {
      await requireAuth(event, "admin");
      if (!body.name || !String(body.name).trim()) return err("Nom requis");
      var newStation = await insertStationUnique(String(body.name).trim());
      return json(newStation, 201);
    }

    // PUT /api/stations/:id — rename et/ou toggle active.
    // Ne touche pas au secret_token (nécessite l'endpoint regenerate-token dédié).
    if (method === "PUT" && seg[0] === "stations" && seg[1] && !seg[2]) {
      await requireAuth(event, "admin");
      var updated = await sql1(
        "UPDATE postes SET name = COALESCE($1, name), active = COALESCE($2, active) " +
        "WHERE id = $3 RETURNING id, name, code_short, active",
        [body.name ? String(body.name).trim() : null, typeof body.active === "boolean" ? body.active : null, parseInt(seg[1])]
      );
      return updated ? json(updated) : err("Introuvable", 404);
    }

    // DELETE /api/stations/:id — soft delete (active=false). Pas de DELETE hard :
    // on préserve les FK records.station_id historiques.
    if (method === "DELETE" && seg[0] === "stations" && seg[1] && !seg[2]) {
      await requireAuth(event, "admin");
      var softDel = await sql1("UPDATE postes SET active=false WHERE id=$1 RETURNING id", [parseInt(seg[1])]);
      return softDel ? json({ ok: true, soft_deleted: true, id: softDel.id }) : err("Introuvable", 404);
    }

    // GET /api/stations/:id/full [admin] — row complet AVEC secret_token.
    // Utilisé UNIQUEMENT par l'UI admin au moment d'imprimer un QR pour un poste
    // existant. Chaque consultation est loggée dans security_events pour forensic
    // ("qui a vu ce secret et quand").
    if (method === "GET" && seg[0] === "stations" && seg[1] && seg[2] === "full") {
      var fullAuth = await requireAuth(event, "admin");
      var fullRow = await sql1("SELECT id, name, code_short, secret_token, active, created_at FROM postes WHERE id=$1", [parseInt(seg[1])]);
      if (!fullRow) return err("Introuvable", 404);
      await logSecurityEvent("station_secret_view", null, fullRow.id, {
        admin_worker_id: fullAuth.worker_id,
        station_name: fullRow.name
      });
      return json(fullRow);
    }

    // POST /api/stations/:id/regenerate-token — régénère code_short ET secret_token.
    // Journalise dans security_events. Réponse inclut le nouveau secret (seul moment
    // de visibilité après ce regen).
    if (method === "POST" && seg[0] === "stations" && seg[1] && seg[2] === "regenerate-token") {
      var authInfo = await requireAuth(event, "admin");
      var stationId = parseInt(seg[1]);
      var existingStation = await sql1("SELECT id, name FROM postes WHERE id=$1", [stationId]);
      if (!existingStation) return err("Introuvable", 404);
      var newCode = null;
      for (var i = 0; i < 5; i++) {
        var candidate = genStationCode();
        var collision = await sql1("SELECT id FROM postes WHERE code_short=$1 AND id!=$2", [candidate, stationId]);
        if (!collision) { newCode = candidate; break; }
      }
      if (!newCode) {
        console.error("[" + new Date().toISOString() + "] STATION_CODE_COLLISION_SATURATION (regen) id=" + stationId + " name=" + JSON.stringify(existingStation.name));
        return err("Collision code_short (saturation)", 500);
      }
      var newSecret = genStationSecret();
      var regenRow = await sql1(
        "UPDATE postes SET code_short=$1, secret_token=$2 WHERE id=$3 " +
        "RETURNING id, name, code_short, secret_token, active",
        [newCode, newSecret, stationId]
      );
      await logSecurityEvent("station_regen", null, stationId, {
        station_name: existingStation.name,
        admin_worker_id: authInfo.worker_id
      });
      return json(regenRow);
    }

    // POST /api/stations/verify [public, rate-limited 10/min/IP] — accepte
    // {token} (depuis URL du QR) OU {code_short} (saisie manuelle, normalisée).
    // Rejette 404 si inconnu, 403 si station.active=false.
    // Réponse différentielle (principe du moindre privilège) :
    //  - input {token}       → {ok, station:{id, name}}               (client a déjà le token)
    //  - input {code_short}  → {ok, station:{id, name, secret_token}} (fallback manuel
    //    où le client a besoin du secret_token pour les appels pin/* et clock suivants).
    // Justification : le code_short et le secret_token sont tous deux imprimés ensemble
    // sur le QR physique au dépôt, donc connaître l'un établit la même preuve de présence
    // physique que l'autre. Rate-limited 10/min/IP suffisant vs brute force du code_short
    // (alphabet 31 chars, format XXX-XXX-XXXX, entropie 31^10 ≈ 8e14).
    if (method === "POST" && path === "stations/verify") {
      if (!checkRateLimit(event, 10)) return json({ error: "Too many requests" }, 429);
      var verifyToken = body.token && String(body.token).trim();
      var verifyCode = body.code_short ? normalizeStationCode(body.code_short) : null;
      if (!verifyToken && !verifyCode) return err("token ou code_short requis");
      var viaCode = !verifyToken && !!verifyCode;
      var stationRow;
      if (verifyToken) {
        stationRow = await sql1("SELECT id, name, active FROM postes WHERE secret_token=$1", [verifyToken]);
      } else {
        stationRow = await sql1("SELECT id, name, active, secret_token FROM postes WHERE code_short=$1", [verifyCode]);
      }
      if (!stationRow) return err("Station inconnue", 404);
      if (!stationRow.active) return err("Station désactivée", 403);
      var stationPayload = { id: stationRow.id, name: stationRow.name };
      if (viaCode) stationPayload.secret_token = stationRow.secret_token;
      return json({ ok: true, station: stationPayload });
    }

    // ═══ Phase 5 — PIN workers ═══

    // GET /api/workers/:id/pin/status [public+station] — renvoie {has_pin, locked}
    // pour que le front sache s'il faut proposer "créer PIN" ou "saisir PIN".
    // station_token passé en header X-Station-Token (pas en query pour éviter
    // logs/CDN/history qui pourraient fuiter le secret).
    if (method === "GET" && seg[0] === "workers" && seg[1] && seg[2] === "pin" && seg[3] === "status") {
      if (!checkRateLimit(event, 10)) return json({ error: "Too many requests" }, 429);
      var hdrs = event.headers || {};
      var pinStatusStation = await verifyStationToken(hdrs["x-station-token"] || hdrs["X-Station-Token"]);
      if (!pinStatusStation) return err("Station invalide", 401);
      var pinStatusWorker = await sql1("SELECT pin_hash, pin_locked FROM workers WHERE id=$1", [parseInt(seg[1])]);
      if (!pinStatusWorker) return err("Worker introuvable", 404);
      return json({ has_pin: !!pinStatusWorker.pin_hash, locked: !!pinStatusWorker.pin_locked });
    }

    // POST /api/workers/:id/pin/create [public+station, 5/min] — crée le PIN
    // du worker SSI pin_hash IS NULL. UPDATE atomique (WHERE pin_hash IS NULL).
    // Sur succès : log pin_create + issue session worker 16h.
    if (method === "POST" && seg[0] === "workers" && seg[1] && seg[2] === "pin" && seg[3] === "create") {
      if (!checkRateLimit(event, 5)) return json({ error: "Too many requests" }, 429);
      var pcWorkerId = parseInt(seg[1]);
      if (!pcWorkerId || pcWorkerId <= 0) return err("id invalide", 400);
      var newPin = body && body.pin;
      if (!newPin || !/^\d{6}$/.test(String(newPin))) return err("PIN invalide (6 chiffres requis)", 400);
      var pcStation = await verifyStationToken(body && body.station_token);
      if (!pcStation) return err("Station invalide", 401);
      var pcExisting = await sql1("SELECT id, pin_hash FROM workers WHERE id=$1", [pcWorkerId]);
      if (!pcExisting) return err("Worker introuvable", 404);
      if (pcExisting.pin_hash) return err("Configuration PIN déjà effectuée", 409);
      var pcHash = await bcrypt.hash(String(newPin), 10);
      // UPDATE atomique avec garde WHERE pin_hash IS NULL (race-condition-safe)
      var pcUpdated = await sql1(
        "UPDATE workers SET pin_hash=$1, pin_attempts=0, pin_locked=false " +
        "WHERE id=$2 AND pin_hash IS NULL " +
        "RETURNING id, name, type, agency, sched_in, sched_out, last_clock_state",
        [pcHash, pcWorkerId]
      );
      if (!pcUpdated) return err("Configuration PIN déjà effectuée", 409);
      await logSecurityEvent("pin_create", pcWorkerId, pcStation.id, { first_time: true });
      var pcSess = await issueSession("worker", pcWorkerId, 16);
      return json({
        ok: true,
        token: pcSess.token,
        expires_at: pcSess.expires_at,
        worker: safeWorker(pcUpdated)
      }, 201);
    }

    // POST /api/workers/:id/pin/verify [public+station, 5/min] — constant-time 200ms
    // Réponse binary : 200 {token,...} ou 401 {error:"PIN incorrect"}. Tout chemin
    // d'échec passe par handlePinVerifyInner qui log + maj état, puis délai ici.
    if (method === "POST" && seg[0] === "workers" && seg[1] && seg[2] === "pin" && seg[3] === "verify") {
      if (!checkRateLimit(event, 5)) return json({ error: "Too many requests" }, 429);
      var pvStart = Date.now();
      var pvResult = await handlePinVerifyInner(event, body, seg);
      // Floor constant-time à 500ms. Empiriquement validé en prod
      // avec n=10 samples : min_success = min_fail = 737ms (plancher
      // commun établi). Le delta médian observé (~100ms) provient
      // de la variance réseau/Lambda sur les queues, pas d'un leak
      // côté serveur. Un attaquant aurait besoin de >1000 samples
      // sur même IP pour extraire le signal, ce qui prend >3h vu
      // le rate-limit 5/min/IP — détectable bien avant exploitation.
      await respondAfterDelay(pvStart, 500);
      if (pvResult && pvResult.ok) return json(pvResult, 200);
      return json({ error: "PIN incorrect" }, 401);
    }

    // GET /api/clock/state [auth worker] — renvoie le state machine courant + les
    // actions autorisées + infos worker sûres. Utilisé par le front salarié pour
    // skip l'écran PIN quand un token worker valide est en localStorage (shortcut
    // UX) — le worker clique sa tuile, si token valide → GET state → goto action.
    // Pas de logging (appelé à chaque entrée rapide), pas de rate limit (auth worker).
    if (method === "GET" && path === "clock/state") {
      var stateAuth = await requireAuth(event, "worker");
      var stateWorkerId = stateAuth.worker_id;
      if (!stateWorkerId) return err("Session sans worker_id", 401);
      var stateWorker = await sql1(
        "SELECT id, name, type, agency, last_clock_state FROM workers WHERE id=$1",
        [stateWorkerId]
      );
      if (!stateWorker) return err("Worker introuvable", 404);
      var stateCurrent = stateWorker.last_clock_state || "idle";
      return json({
        last_clock_state: stateCurrent,
        allowed_actions: allowedActionsFor(stateCurrent),
        worker: {
          id: stateWorker.id,
          name: stateWorker.name,
          type: stateWorker.type,
          agency: stateWorker.agency || ""
        }
      });
    }

    // POST /api/clock [auth worker] — pointage arrivée/départ/pauses.
    // Worker identité = session (pas de worker_id dans le body, évite dup source de bug).
    // station_token (pas station_id) = preuve de présence physique à CHAQUE clock.
    // State machine appliquée avant tout écrit. Atomicité record + workers.last_clock_state
    // via sqlTx (batch transaction Neon Serializable).
    if (method === "POST" && path === "clock") {
      var clkAuth = await requireAuth(event, "worker");
      var clkWorkerId = clkAuth.worker_id;
      if (!clkWorkerId) return err("Session sans worker_id", 401);

      var clkAction = body && body.action;
      if (!STATE_TRANSITIONS[clkAction]) return err("action invalide (attendu: " + Object.keys(STATE_TRANSITIONS).join(", ") + ")", 400);

      var clkStation = await verifyStationToken(body && body.station_token);
      if (!clkStation) return err("Station invalide", 401);

      // Phase 6 — auto-clôture défensive des records orphelins. Le borne RFID
      // a déjà fait l'appel via /api/auth/rfid juste avant, donc c'est un no-op
      // pour ce flux. Reste utile pour le flux PIN qui passe directement ici
      // (le worker peut alors enchaîner en 'arrival' après reset → 'idle').
      await closeOrphanPointages(clkWorkerId);

      // Source de vérité = DB workers.last_clock_state (pas la session, qui pourrait dater).
      var clkWorker = await sql1("SELECT id, name, agency, last_clock_state FROM workers WHERE id=$1", [clkWorkerId]);
      if (!clkWorker) return err("Worker introuvable", 404);
      var clkCurrentState = clkWorker.last_clock_state || "idle";

      // Validation transition
      var clkSpec = STATE_TRANSITIONS[clkAction];
      if (clkSpec.from.indexOf(clkCurrentState) < 0) {
        return json({
          error: "Action invalide pour l'état actuel",
          current_state: clkCurrentState,
          allowed_actions: allowedActionsFor(clkCurrentState)
        }, 409);
      }
      var clkNewState = clkSpec.to;
      var clkTime = getParisHHMM();
      var clkDate = getParisDate();

      if (clkAction === "arrival") {
        // INSERT nouveau record + UPDATE state. Plusieurs records par jour autorisés
        // (journée split 9h-12h / 14h-18h).
        var arrivalTx = await sqlTx([
          {
            query: "INSERT INTO records (worker_id, worker_name, agency, date, arrival, station_id, breaks) " +
                   "VALUES ($1, $2, $3, $4, $5, $6, '[]'::jsonb) RETURNING *",
            params: [clkWorkerId, clkWorker.name, clkWorker.agency || "", clkDate, clkTime, clkStation.id]
          },
          {
            query: "UPDATE workers SET last_clock_state=$1 WHERE id=$2 RETURNING id",
            params: [clkNewState, clkWorkerId]
          }
        ]);
        return json({ ok: true, action: clkAction, new_state: clkNewState, record: arrivalTx[0][0] }, 201);
      }

      // Non-arrival actions : on update la ligne ouverte du jour (ORDER BY id DESC LIMIT 1
      // gère le cas d'une journée split avec un record de matin fermé + un record après-midi ouvert).
      var openRec = await sql1(
        "SELECT * FROM records WHERE worker_id=$1 AND date=$2 AND departure IS NULL " +
        "ORDER BY id DESC LIMIT 1",
        [clkWorkerId, clkDate]
      );
      if (!openRec) {
        return json({
          error: "Aucun pointage ouvert pour aujourd'hui",
          current_state: clkCurrentState,
          allowed_actions: allowedActionsFor(clkCurrentState)
        }, 409);
      }
      // breaks peut revenir en string JSON selon le driver — normaliser.
      var clkBreaks = openRec.breaks;
      if (typeof clkBreaks === "string") { try { clkBreaks = JSON.parse(clkBreaks); } catch (e) { clkBreaks = []; } }
      if (!Array.isArray(clkBreaks)) clkBreaks = [];

      if (clkAction === "break_start") {
        clkBreaks.push({ start: clkTime });
        var bsTx = await sqlTx([
          {
            query: "UPDATE records SET breaks=$1::jsonb, updated_at=NOW() WHERE id=$2 RETURNING *",
            params: [JSON.stringify(clkBreaks), openRec.id]
          },
          {
            query: "UPDATE workers SET last_clock_state=$1 WHERE id=$2 RETURNING id",
            params: [clkNewState, clkWorkerId]
          }
        ]);
        return json({ ok: true, action: clkAction, new_state: clkNewState, record: bsTx[0][0] });
      }

      if (clkAction === "break_end") {
        if (clkBreaks.length === 0 || clkBreaks[clkBreaks.length - 1].end) {
          return err("Aucune pause ouverte à fermer", 409);
        }
        clkBreaks[clkBreaks.length - 1].end = clkTime;
        var beTx = await sqlTx([
          {
            query: "UPDATE records SET breaks=$1::jsonb, updated_at=NOW() WHERE id=$2 RETURNING *",
            params: [JSON.stringify(clkBreaks), openRec.id]
          },
          {
            query: "UPDATE workers SET last_clock_state=$1 WHERE id=$2 RETURNING id",
            params: [clkNewState, clkWorkerId]
          }
        ]);
        return json({ ok: true, action: clkAction, new_state: clkNewState, record: beTx[0][0] });
      }

      // departure — si state=on_break, auto-ferme la pause ouverte avec auto_closed:true
      // (flag lu plus tard par le module RH pour afficher un warning dans les PDFs).
      var autoClosedBreak = false;
      if (clkCurrentState === "on_break" && clkBreaks.length > 0 && !clkBreaks[clkBreaks.length - 1].end) {
        clkBreaks[clkBreaks.length - 1].end = clkTime;
        clkBreaks[clkBreaks.length - 1].auto_closed = true;
        autoClosedBreak = true;
      }
      var depTx = await sqlTx([
        {
          query: "UPDATE records SET departure=$1, breaks=$2::jsonb, updated_at=NOW() WHERE id=$3 RETURNING *",
          params: [clkTime, JSON.stringify(clkBreaks), openRec.id]
        },
        {
          query: "UPDATE workers SET last_clock_state=$1 WHERE id=$2 RETURNING id",
          params: [clkNewState, clkWorkerId]
        }
      ]);
      return json({
        ok: true,
        action: clkAction,
        new_state: clkNewState,
        record: depTx[0][0],
        auto_closed_break: autoClosedBreak
      });
    }

    // GET /api/security-events [admin] — journal audit PIN + stations.
    // Query params (tous optionnels) : type, worker_id, station_id, from, to, limit, offset.
    // LEFT JOIN workers + postes pour inclure worker_name et station_name dans
    // la réponse (évite N+1 lookups côté front). NULL reste NULL (event sans
    // worker ou station), géré côté UI.
    if (method === "GET" && path === "security-events") {
      await requireAuth(event, "admin");
      var seWhere = ["1=1"];
      var seParams = [];
      var sePi = 1;
      if (qs.type) { seWhere.push("se.event_type = $" + sePi++); seParams.push(qs.type); }
      if (qs.worker_id) { seWhere.push("se.worker_id = $" + sePi++); seParams.push(parseInt(qs.worker_id)); }
      if (qs.station_id) { seWhere.push("se.station_id = $" + sePi++); seParams.push(parseInt(qs.station_id)); }
      if (qs.from) { seWhere.push("se.created_at >= $" + sePi++); seParams.push(qs.from); }
      if (qs.to) { seWhere.push("se.created_at < ($" + sePi++ + "::date + INTERVAL '1 day')"); seParams.push(qs.to); }
      var seLimit = Math.min(500, parseInt(qs.limit || "50"));
      var seOffset = parseInt(qs.offset || "0");
      if (isNaN(seLimit) || seLimit < 1) seLimit = 50;
      if (isNaN(seOffset) || seOffset < 0) seOffset = 0;
      seParams.push(seLimit);
      var seLimitIdx = sePi++;
      seParams.push(seOffset);
      var seOffsetIdx = sePi;
      var seRows = await sql(
        "SELECT se.id, se.event_type, se.worker_id, se.station_id, se.details, se.created_at, " +
        "w.name AS worker_name, p.name AS station_name " +
        "FROM security_events se " +
        "LEFT JOIN workers w ON w.id = se.worker_id " +
        "LEFT JOIN postes p ON p.id = se.station_id " +
        "WHERE " + seWhere.join(" AND ") +
        " ORDER BY se.created_at DESC " +
        "LIMIT $" + seLimitIdx + " OFFSET $" + seOffsetIdx,
        seParams
      );
      return json({ events: seRows, limit: seLimit, offset: seOffset });
    }

    // POST /api/workers/:id/pin/reset [admin] — wipe pin_hash + attempts + lock
    // Après reset, le prochain pointage du worker va passer par pin/create.
    if (method === "POST" && seg[0] === "workers" && seg[1] && seg[2] === "pin" && seg[3] === "reset") {
      var resetAuth = await requireAuth(event, "admin");
      var prWorkerId = parseInt(seg[1]);
      var prUpdated = await sql1(
        "UPDATE workers SET pin_hash=NULL, pin_attempts=0, pin_locked=false WHERE id=$1 RETURNING id",
        [prWorkerId]
      );
      if (!prUpdated) return err("Worker introuvable", 404);
      await logSecurityEvent("pin_reset", prWorkerId, null, {
        triggered_by: "admin",
        admin_worker_id: resetAuth.worker_id,
        source: "admin_ui"
      });
      return json({ ok: true });
    }

    // POST /api/workers/:id/rfid [admin] — Phase 6
    // Body: {uid} (10 chars hex uppercase). Rejette 400 si format KO, 404 si
    // worker introuvable, 409 si UID déjà pris par un autre worker.
    // Log rfid_enroll avec uid_prefix (4 premiers chars + ***). JAMAIS l'UID
    // complet en log (réservé à rfid_unknown_card pour enrôlement à chaud).
    if (method === "POST" && seg[0] === "workers" && seg[1] && seg[2] === "rfid" && !seg[3]) {
      var rfidEnrollAuth = await requireAuth(event, "admin");
      var rfidEnrollWorkerId = parseInt(seg[1]);
      if (!rfidEnrollWorkerId) return err("Worker ID invalide");
      var rfidEnrollUid = String((body && body.uid) || "").trim().toUpperCase();
      if (!/^[0-9A-F]{10}$/.test(rfidEnrollUid)) return err("Format UID invalide");
      var rfidEnrollWorker = await sql1("SELECT id FROM workers WHERE id=$1", [rfidEnrollWorkerId]);
      if (!rfidEnrollWorker) return err("Worker introuvable", 404);
      // Anti-collision Phase 6 ext : refuser une UID déjà déclarée comme carte
      // intérimaire partagée (sinon /api/auth/rfid donnerait toujours priorité
      // au worker, mais on évite l'état corrompu en amont).
      var rfidEnrollInterim = await sql1("SELECT id FROM interim_cards WHERE uid=$1", [rfidEnrollUid]);
      if (rfidEnrollInterim) return err("Cette carte est déjà déclarée comme carte intérimaire partagée", 409);
      var rfidEnrollTaken = await sql1("SELECT id FROM workers WHERE rfid_uid=$1 AND id<>$2", [rfidEnrollUid, rfidEnrollWorkerId]);
      if (rfidEnrollTaken) return err("Carte déjà associée à un autre salarié", 409);
      await sql("UPDATE workers SET rfid_uid=$1, updated_at=NOW() WHERE id=$2", [rfidEnrollUid, rfidEnrollWorkerId]);
      var rfidEnrollPrefix = rfidEnrollUid.substring(0, 4) + "***";
      await logSecurityEvent("rfid_enroll", rfidEnrollWorkerId, null, {
        admin_worker_id: rfidEnrollAuth.worker_id,
        uid_prefix: rfidEnrollPrefix
      });
      return json({ ok: true, uid_prefix: rfidEnrollPrefix });
    }

    // DELETE /api/workers/:id/rfid [admin] — Phase 6
    // 404 si worker introuvable OU si pas de carte associée. UPDATE set NULL.
    // Log rfid_unenroll avec uid_prefix de l'ancienne carte.
    if (method === "DELETE" && seg[0] === "workers" && seg[1] && seg[2] === "rfid" && !seg[3]) {
      var rfidUnenrollAuth = await requireAuth(event, "admin");
      var rfidUnenrollWorkerId = parseInt(seg[1]);
      if (!rfidUnenrollWorkerId) return err("Worker ID invalide");
      var rfidUnenrollCurrent = await sql1("SELECT rfid_uid FROM workers WHERE id=$1", [rfidUnenrollWorkerId]);
      if (!rfidUnenrollCurrent) return err("Worker introuvable", 404);
      if (!rfidUnenrollCurrent.rfid_uid) return err("Aucune carte associée", 404);
      await sql("UPDATE workers SET rfid_uid=NULL, updated_at=NOW() WHERE id=$1", [rfidUnenrollWorkerId]);
      await logSecurityEvent("rfid_unenroll", rfidUnenrollWorkerId, null, {
        admin_worker_id: rfidUnenrollAuth.worker_id,
        uid_prefix: rfidUnenrollCurrent.rfid_uid.substring(0, 4) + "***"
      });
      return json({ ok: true });
    }

    if (method === "GET" && path === "qr-secret") {
      var row = await sql1("SELECT value FROM settings WHERE key='qr_secret'");
      if (!row) { var s = genSecret(); await sql("INSERT INTO settings (key,value) VALUES ('qr_secret',$1)", [s]); return json({ secret: s }); }
      return json({ secret: row.value });
    }
    if (method === "POST" && path === "qr-secret/regenerate") { await requireAuth(event, "admin"); var s = genSecret(); await sql("INSERT INTO settings (key,value) VALUES ('qr_secret',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [s]); return json({ secret: s }); }
    if (method === "POST" && path === "scan") return await handleScan(body);

    if (method === "POST" && path === "rh/generate") {
      await requireAuth(event, "admin");
      var rh = require("./rh/generate");
      return await rh.handle(event, body, sql);
    }

    return err("Route: " + path, 404);
  } catch (e) {
    if (e && e.status) return json({ error: e.message }, e.status);
    console.error("API Error:", e);
    return json({ error: e.message || "Unknown error" }, 500);
  }
};

async function initDB() {
  await sql("CREATE TABLE IF NOT EXISTS workers (id SERIAL PRIMARY KEY,name VARCHAR(255) NOT NULL,agency VARCHAR(255) DEFAULT '',type VARCHAR(20) DEFAULT 'interim',phone VARCHAR(50) DEFAULT '',badge VARCHAR(100) DEFAULT '',sched_in VARCHAR(5) DEFAULT '08:00',sched_out VARCHAR(5) DEFAULT '16:00',created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW())");
  await sql("CREATE TABLE IF NOT EXISTS records (id SERIAL PRIMARY KEY,worker_id INTEGER REFERENCES workers(id) ON DELETE CASCADE,worker_name VARCHAR(255) DEFAULT '',agency VARCHAR(255) DEFAULT '',date DATE NOT NULL,arrival VARCHAR(5),departure VARCHAR(5),breaks JSONB DEFAULT '[]',created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW())");
  await sql("CREATE TABLE IF NOT EXISTS postes (id SERIAL PRIMARY KEY,name VARCHAR(255) NOT NULL,location VARCHAR(255) DEFAULT '',created_at TIMESTAMP DEFAULT NOW())");
  await sql("CREATE TABLE IF NOT EXISTS settings (key VARCHAR(100) PRIMARY KEY,value TEXT NOT NULL)");
  await sql("CREATE TABLE IF NOT EXISTS agent_memory (id SERIAL PRIMARY KEY,type VARCHAR(50) NOT NULL,content TEXT NOT NULL,importance INTEGER DEFAULT 5,feedback VARCHAR(20) DEFAULT 'pending',created_at TIMESTAMP DEFAULT NOW())");
  await sql("CREATE TABLE IF NOT EXISTS agent_runs (id SERIAL PRIMARY KEY,run_date TIMESTAMP DEFAULT NOW(),observations_count INTEGER DEFAULT 0,actions_taken TEXT DEFAULT '',duration_ms INTEGER DEFAULT 0)");
  await sql("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY,worker_id INT NULL REFERENCES workers(id) ON DELETE CASCADE,role TEXT NOT NULL CHECK (role IN ('admin','worker')),created_at TIMESTAMPTZ DEFAULT NOW(),expires_at TIMESTAMPTZ NOT NULL)");
  if (!(await sql1("SELECT value FROM settings WHERE key='admin_password'"))) await sql("INSERT INTO settings (key,value) VALUES ('admin_password','admin')");
  if (!(await sql1("SELECT value FROM settings WHERE key='qr_secret'"))) await sql("INSERT INTO settings (key,value) VALUES ('qr_secret',$1)", [genSecret()]);
  await sql("CREATE INDEX IF NOT EXISTS idx_records_date ON records(date)");
  await sql("CREATE INDEX IF NOT EXISTS idx_records_worker ON records(worker_id)");
  await sql("CREATE INDEX IF NOT EXISTS idx_workers_badge ON workers(badge)");
  await sql("CREATE INDEX IF NOT EXISTS idx_agent_memory_type ON agent_memory(type)");
  await sql("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)");

  // ═══ Phase 5 — pointage sécurisé : PIN + stations + audit ═══

  // 1) Workers : PIN (hash bcrypt) + state machine pour cohérence actions
  await sql("ALTER TABLE workers ADD COLUMN IF NOT EXISTS pin_hash TEXT");
  await sql("ALTER TABLE workers ADD COLUMN IF NOT EXISTS pin_attempts INT DEFAULT 0");
  await sql("ALTER TABLE workers ADD COLUMN IF NOT EXISTS pin_locked BOOLEAN DEFAULT FALSE");
  await sql("ALTER TABLE workers ADD COLUMN IF NOT EXISTS last_clock_state TEXT DEFAULT 'idle'");

  // 2) Postes : extension pour Phase 5 (code_short, secret_token, active).
  // Nullable au départ : les postes existants auront NULL tant qu'un admin
  // ne clique pas "Activer / générer QR". Les postes avec NULL ne peuvent
  // pas servir au pointage (endpoint /stations/verify les rejette).
  await sql("ALTER TABLE postes ADD COLUMN IF NOT EXISTS code_short TEXT");
  await sql("ALTER TABLE postes ADD COLUMN IF NOT EXISTS secret_token TEXT");
  await sql("ALTER TABLE postes ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE");
  // UNIQUE partiel : contraint seulement les valeurs non-NULL pour que les
  // postes legacy (NULL) ne rentrent pas en conflit.
  await sql("CREATE UNIQUE INDEX IF NOT EXISTS idx_postes_code_short ON postes(code_short) WHERE code_short IS NOT NULL");
  await sql("CREATE UNIQUE INDEX IF NOT EXISTS idx_postes_secret_token ON postes(secret_token) WHERE secret_token IS NOT NULL");

  // 3) Records : trace du poste de pointage. Nullable pour les records
  // historiques pré-Phase 5 qui n'avaient pas l'info.
  await sql("ALTER TABLE records ADD COLUMN IF NOT EXISTS station_id INT REFERENCES postes(id) ON DELETE SET NULL");
  await sql("CREATE INDEX IF NOT EXISTS idx_records_station ON records(station_id)");

  // 4) Security events : audit trail pour actions sensibles.
  // event_type attendu : pin_fail | pin_lock | pin_create | pin_reset | station_regen
  // Pas de CHECK CONSTRAINT pour pouvoir ajouter de nouveaux types sans migration.
  // Liste canonique dans la constante CLOCK_STATES / SECURITY_EVENT_TYPES côté code.
  await sql("CREATE TABLE IF NOT EXISTS security_events (id SERIAL PRIMARY KEY, event_type TEXT NOT NULL, worker_id INT REFERENCES workers(id) ON DELETE SET NULL, station_id INT REFERENCES postes(id) ON DELETE SET NULL, details JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT NOW())");
  await sql("CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at DESC)");
  await sql("CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type)");

  // ═══ Phase 5.1 — site/location physique des workers ═══
  // Ajout d'une colonne `location` (free-text, défaut 'toulouse') pour filtrer
  // la grille des workers par site dans l'écran "Qui pointe ?". Distinct de
  // `agency` existant qui reste réservé au nom de la boîte d'intérim (Randstad,
  // Adecco, etc.) pour les workers type='interim'.
  await sql("ALTER TABLE workers ADD COLUMN IF NOT EXISTS location TEXT DEFAULT 'toulouse'");
  await sql("CREATE INDEX IF NOT EXISTS idx_workers_location_type ON workers(location, type)");

  // ═══ Phase 6 — RFID : association carte ↔ worker ═══
  // Colonne rfid_uid : UID EM4100 en ASCII hex uppercase (10 chars) ou NULL.
  // UNIQUE partiel : plusieurs workers peuvent avoir NULL simultanément (pas
  // encore enrôlés), mais deux workers ne peuvent pas partager le même UID.
  // Format validé côté route (regex /^[0-9A-F]{10}$/), pas de CHECK en DB.
  await sql("ALTER TABLE workers ADD COLUMN IF NOT EXISTS rfid_uid TEXT");
  await sql("CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_rfid_uid ON workers(rfid_uid) WHERE rfid_uid IS NOT NULL");

  // ═══ Phase 6 ext — cartes intérimaires partagées + workflow approbation ═══
  // workers.active : marque les workers "partis" sans les supprimer (préserve
  //   l'historique). Default true. Filtre toutes les listes côté front.
  // workers.pending_admin_approval : worker créé via borne, en attente de
  //   validation admin. Visible dans la borne (pour son propre pointage) mais
  //   masqué dans le dashboard "Qui pointe" et le rapport RH tant que pending.
  // workers.created_via_borne : trace l'origine de la création (≠ admin manuel).
  await sql("ALTER TABLE workers ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true");
  await sql("ALTER TABLE workers ADD COLUMN IF NOT EXISTS pending_admin_approval BOOLEAN DEFAULT false");
  await sql("ALTER TABLE workers ADD COLUMN IF NOT EXISTS created_via_borne BOOLEAN DEFAULT false");

  // interim_cards : whitelist des cartes RFID partagées (distribuées le matin
  //   à l'équipe intérim, rendues le soir). Différent de workers.rfid_uid qui
  //   est une carte personnelle. uid VARCHAR(10) = 10 chars hex EM4100.
  await sql("CREATE TABLE IF NOT EXISTS interim_cards (id SERIAL PRIMARY KEY, uid VARCHAR(10) UNIQUE NOT NULL, label TEXT, active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW())");
  await sql("CREATE INDEX IF NOT EXISTS idx_interim_cards_uid_active ON interim_cards(uid) WHERE active=true");

  // interim_cards_creations : compteur (carte, jour) pour limiter la création
  //   à 1 nouveau worker par carte par jour (anti-abus). PK composite.
  await sql("CREATE TABLE IF NOT EXISTS interim_cards_creations (card_uid VARCHAR(10) NOT NULL, date DATE NOT NULL, count INT DEFAULT 0, PRIMARY KEY (card_uid, date))");
}

async function issueSession(role, workerId, hours) {
  var token = crypto.randomUUID();
  var row = await sql1(
    "INSERT INTO sessions (token, worker_id, role, expires_at) VALUES ($1, $2, $3, NOW() + ($4 || ' hours')::interval) RETURNING token, role, worker_id, expires_at",
    [token, workerId, role, String(hours)]
  );
  return row;
}

async function handleLogin(body) {
  if (body.mode === "admin") {
    var r = await sql1("SELECT value FROM settings WHERE key='admin_password'");
    if (!r || r.value !== body.password) return err("Mot de passe incorrect", 401);
    var s = await issueSession("admin", null, 12);
    return json({ role: "admin", worker_id: null, token: s.token, expires_at: s.expires_at });
  }
  if (body.mode === "badge") {
    if (!body.badge) return err("Badge requis");
    var w = await sql1("SELECT * FROM workers WHERE badge=$1 AND badge!=''", [body.badge]);
    if (!w) return err("Badge inconnu", 401);
    var s = await issueSession("worker", w.id, 14);
    return json({ role: "worker", worker_id: w.id, token: s.token, expires_at: s.expires_at, worker: w });
  }
  if (body.mode === "name") {
    if (!body.workerId) return err("workerId requis");
    var w = await sql1("SELECT * FROM workers WHERE id=$1", [parseInt(body.workerId)]);
    if (!w) return err("Introuvable", 401);
    var s = await issueSession("worker", w.id, 14);
    return json({ role: "worker", worker_id: w.id, token: s.token, expires_at: s.expires_at, worker: w });
  }
  return err("Mode invalide");
}

async function handleLogout(event, body) {
  var token = null;
  if (body && body.token) token = body.token;
  if (!token) {
    var headers = event.headers || {};
    var authHeader = headers.authorization || headers.Authorization || "";
    var m = /^Bearer\s+(.+)$/.exec(authHeader.trim());
    if (m) token = m[1].trim();
  }
  if (token) await sql("DELETE FROM sessions WHERE token=$1", [token]);
  // Opportunistic GC of expired sessions (cheap, keeps table small)
  await sql("DELETE FROM sessions WHERE expires_at<NOW()");
  return json({ ok: true });
}

async function handleChangePwd(body) {
  var r = await sql1("SELECT value FROM settings WHERE key='admin_password'");
  if (!r || r.value !== body.oldPassword) return err("Ancien mot de passe incorrect", 401);
  await sql("UPDATE settings SET value=$1 WHERE key='admin_password'", [body.newPassword]);
  return json({ ok: true });
}

async function handleScan(body) {
  var worker;
  if (body.badge) { worker = await sql1("SELECT * FROM workers WHERE badge=$1 AND badge!=''", [body.badge]); if (!worker) return json({ action: "unknown_badge", badge: body.badge }); }
  else if (body.workerId) { worker = await sql1("SELECT * FROM workers WHERE id=$1", [parseInt(body.workerId)]); if (!worker) return err("Introuvable", 404); }
  else return err("badge ou workerId requis");
  if (body.qrData) { var qrRow = await sql1("SELECT value FROM settings WHERE key='qr_secret'"); var parts = body.qrData.split(":"); if (parts.length !== 3 || parts[0] !== "iziship" || parts[1] !== ((qrRow && qrRow.value) || "")) return json({ action: "invalid_qr" }); }
  var today = new Date().toISOString().slice(0,10);
  var now = new Date();
  var timeNow = String(now.getHours()).padStart(2,"0") + ":" + String(now.getMinutes()).padStart(2,"0");
  var recs = await sql("SELECT * FROM records WHERE worker_id=$1 AND date=$2 ORDER BY id DESC LIMIT 1", [worker.id, today]);
  var rec = recs[0];
  if (!rec || rec.departure) { var nr = await sql1("INSERT INTO records (worker_id,worker_name,agency,date,arrival,breaks) VALUES ($1,$2,$3,$4,$5,'[]'::jsonb) RETURNING *", [worker.id, worker.name, worker.agency||"", today, timeNow]); return json({ action: "arrival", time: timeNow, worker: worker, record: nr }); }
  var breaks = rec.breaks || [];
  var lb = breaks.length ? breaks[breaks.length-1] : null;
  if (lb && !lb.end) { lb.end = timeNow; var up = await sql1("UPDATE records SET breaks=$1::jsonb,updated_at=NOW() WHERE id=$2 RETURNING *", [JSON.stringify(breaks), rec.id]); return json({ action: "break_end", time: timeNow, worker: worker, record: up }); }
  return json({ action: "choose", time: timeNow, worker: worker, record: rec, options: ["break_start","departure"] });
}

async function handleAssistant(body) {
  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return err("ANTHROPIC_API_KEY non configuree", 500);
  var message = body.message;
  if (!message) return err("Message requis");

  var today = new Date().toISOString().slice(0, 10);
  var monthStart = today.substring(0, 8) + "01";

  var workers = await sql("SELECT id,name,agency,type,sched_in,sched_out FROM workers ORDER BY type,name");
  var todayRecs = await sql("SELECT r.*,w.name as wname,w.type as wtype FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date=$1 ORDER BY w.type,r.arrival", [today]);
  var monthRecs = await sql("SELECT r.worker_id,r.worker_name,r.date,r.arrival,r.departure,r.breaks,w.type as wtype,w.sched_in,w.sched_out FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date>=$1 AND r.date<=$2 ORDER BY r.date", [monthStart, today]);

  var context = "DONNEES POINTEUSE IZISHIP au " + today + ":\n\n";
  context += "SALARIES (" + workers.length + "):\n";
  workers.forEach(function(w) { context += "- " + w.name + " | " + w.type + " | " + (w.agency||"") + " | horaires " + w.sched_in + "-" + w.sched_out + "\n"; });

  context += "\nPOINTAGES AUJOURD'HUI (" + todayRecs.length + "):\n";
  todayRecs.forEach(function(r) {
    var brk = 0;
    if (r.breaks && Array.isArray(r.breaks)) { r.breaks.forEach(function(b) { if (b.start && b.end) { var s = parseInt(b.start.split(":")[0])*60+parseInt(b.start.split(":")[1]); var e = parseInt(b.end.split(":")[0])*60+parseInt(b.end.split(":")[1]); brk += e-s; } }); }
    context += "- " + (r.wname||r.worker_name) + " (" + (r.wtype||"") + "): arr=" + (r.arrival||"?") + " dep=" + (r.departure||"en cours") + " pause=" + brk + "min\n";
  });

  context += "\nSTATISTIQUES DU MOIS:\n";
  var statsPerWorker = {};
  monthRecs.forEach(function(r) {
    if (!r.departure) return;
    var key = r.worker_name || r.worker_id;
    if (!statsPerWorker[key]) statsPerWorker[key] = { type: r.wtype, days: 0, totalMin: 0, lateCount: 0, overtimeMin: 0 };
    var arr = parseInt(r.arrival.split(":")[0])*60+parseInt(r.arrival.split(":")[1]);
    var dep = parseInt(r.departure.split(":")[0])*60+parseInt(r.departure.split(":")[1]);
    var brk = 0;
    if (r.breaks && Array.isArray(r.breaks)) { r.breaks.forEach(function(b) { if (b.start && b.end) { var s = parseInt(b.start.split(":")[0])*60+parseInt(b.start.split(":")[1]); var e = parseInt(b.end.split(":")[0])*60+parseInt(b.end.split(":")[1]); brk += e-s; } }); }
    var worked = dep - arr - brk;
    var schedIn = parseInt((r.sched_in||"08:00").split(":")[0])*60+parseInt((r.sched_in||"08:00").split(":")[1]);
    var schedOut = parseInt((r.sched_out||"16:00").split(":")[0])*60+parseInt((r.sched_out||"16:00").split(":")[1]);
    var expected = schedOut - schedIn;
    statsPerWorker[key].days++;
    statsPerWorker[key].totalMin += worked;
    if (arr > schedIn + 5) statsPerWorker[key].lateCount++;
    if (worked > expected) statsPerWorker[key].overtimeMin += worked - expected;
  });

  Object.keys(statsPerWorker).forEach(function(name) {
    var s = statsPerWorker[name];
    var h = Math.floor(s.totalMin/60); var m = s.totalMin%60;
    var oh = Math.floor(s.overtimeMin/60); var om = s.overtimeMin%60;
    context += "- " + name + " (" + s.type + "): " + s.days + "j, " + h + "h" + String(m).padStart(2,"0") + " total, " + oh + "h" + String(om).padStart(2,"0") + " heures sup, " + s.lateCount + " retards\n";
  });

  var messages = [];
  if (body.history && Array.isArray(body.history)) {
    body.history.forEach(function(h) { messages.push({ role: h.role, content: h.content }); });
  }
  messages.push({ role: "user", content: message });

  var claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: "Tu es l'assistant RH de l'entreprise IziShip (logistique). Tu analyses les donnees de pointage et reponds aux questions du directeur en francais. Sois concis, precis et utilise des chiffres. Donne des recommandations actionnables. Voici les donnees actuelles:\n\n" + context,
      messages: messages
    })
  });

  if (!claudeRes.ok) {
    var errText = await claudeRes.text();
    console.error("Claude API error:", errText);
    return err("Erreur Claude API: " + claudeRes.status, 500);
  }

  var claudeData = await claudeRes.json();
  var reply = "";
  if (claudeData.content && claudeData.content.length > 0) { reply = claudeData.content[0].text || ""; }
  return json({ reply: reply });
}

// ═══ AGENT RH AUTONOME — LE CERVEAU ═══
async function handleAgentRun() {
  var startTime = Date.now();
  var apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return err("ANTHROPIC_API_KEY non configuree", 500);

  var today = new Date().toISOString().slice(0, 10);
  var weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  var monthStart = today.substring(0, 8) + "01";

  // 1. Collecter les données fraîches
  var workers = await sql("SELECT id,name,agency,type,sched_in,sched_out FROM workers ORDER BY type,name");
  var todayRecs = await sql("SELECT r.*,w.name as wname,w.type as wtype,w.sched_in,w.sched_out FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date=$1", [today]);
  var weekRecs = await sql("SELECT r.*,w.name as wname,w.type as wtype,w.sched_in,w.sched_out FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date>=$1 AND r.date<=$2 ORDER BY r.date", [weekAgo, today]);

  // 2. Lire la mémoire (observations passées + feedback du directeur)
  var recentMemory = await sql("SELECT type,content,importance,feedback,created_at FROM agent_memory ORDER BY created_at DESC LIMIT 30");
  var goodMemory = await sql("SELECT type,content,importance,feedback,created_at FROM agent_memory WHERE feedback='good' ORDER BY created_at DESC LIMIT 10");

  // 3. Construire le contexte complet pour le cerveau
  var context = "=== DONNEES ENTREPRISE IZISHIP AU " + today + " ===\n\n";

  context += "EFFECTIF (" + workers.length + " salaries):\n";
  var interimCount = 0, cdiCount = 0;
  workers.forEach(function(w) {
    if (w.type === "interim") interimCount++;
    else cdiCount++;
    context += "- " + w.name + " | " + w.type + " | agence: " + (w.agency||"N/A") + " | horaires prevus: " + w.sched_in + "-" + w.sched_out + "\n";
  });
  context += "Total: " + interimCount + " interimaires, " + cdiCount + " CDI/CDD\n";

  context += "\n--- POINTAGES AUJOURD'HUI (" + todayRecs.length + ") ---\n";
  todayRecs.forEach(function(r) {
    var brk = 0;
    if (r.breaks && Array.isArray(r.breaks)) { r.breaks.forEach(function(b) { if (b.start && b.end) { var s = parseInt(b.start.split(":")[0])*60+parseInt(b.start.split(":")[1]); var e = parseInt(b.end.split(":")[0])*60+parseInt(b.end.split(":")[1]); brk += e-s; } }); }
    var schedIn = parseInt((r.sched_in||"08:00").split(":")[0])*60+parseInt((r.sched_in||"08:00").split(":")[1]);
    var arrMin = r.arrival ? parseInt(r.arrival.split(":")[0])*60+parseInt(r.arrival.split(":")[1]) : 0;
    var late = arrMin > schedIn + 5 ? " [RETARD +" + (arrMin - schedIn) + "min]" : "";
    context += "- " + (r.wname||r.worker_name) + " (" + (r.wtype||"") + "): arr=" + (r.arrival||"?") + late + " dep=" + (r.departure||"en cours") + " pause=" + brk + "min\n";
  });

  // Stats semaine
  context += "\n--- STATISTIQUES SEMAINE (7 derniers jours) ---\n";
  var weekStats = {};
  weekRecs.forEach(function(r) {
    if (!r.departure) return;
    var key = r.wname || r.worker_name || r.worker_id;
    if (!weekStats[key]) weekStats[key] = { type: r.wtype, days: 0, totalMin: 0, lateCount: 0, overtimeMin: 0, absences: 0, dates: [] };
    var arr = parseInt(r.arrival.split(":")[0])*60+parseInt(r.arrival.split(":")[1]);
    var dep = parseInt(r.departure.split(":")[0])*60+parseInt(r.departure.split(":")[1]);
    var brk = 0;
    if (r.breaks && Array.isArray(r.breaks)) { r.breaks.forEach(function(b) { if (b.start && b.end) { var s = parseInt(b.start.split(":")[0])*60+parseInt(b.start.split(":")[1]); var e = parseInt(b.end.split(":")[0])*60+parseInt(b.end.split(":")[1]); brk += e-s; } }); }
    var worked = dep - arr - brk;
    var schedIn = parseInt((r.sched_in||"08:00").split(":")[0])*60+parseInt((r.sched_in||"08:00").split(":")[1]);
    var schedOut = parseInt((r.sched_out||"16:00").split(":")[0])*60+parseInt((r.sched_out||"16:00").split(":")[1]);
    weekStats[key].days++;
    weekStats[key].totalMin += worked;
    weekStats[key].dates.push(r.date);
    if (arr > schedIn + 5) weekStats[key].lateCount++;
    if (worked > (schedOut - schedIn)) weekStats[key].overtimeMin += worked - (schedOut - schedIn);
  });
  Object.keys(weekStats).forEach(function(name) {
    var s = weekStats[name];
    context += "- " + name + " (" + s.type + "): " + s.days + " jours, " + Math.floor(s.totalMin/60) + "h" + String(s.totalMin%60).padStart(2,"0") + " total, " + Math.floor(s.overtimeMin/60) + "h" + String(s.overtimeMin%60).padStart(2,"0") + " heures sup, " + s.lateCount + " retards\n";
  });

  // Absences (salariés sans pointage aujourd'hui)
  var presentIds = {};
  todayRecs.forEach(function(r) { presentIds[r.worker_id] = true; });
  var absent = workers.filter(function(w) { return !presentIds[w.id]; });
  if (absent.length > 0) {
    context += "\nABSENTS AUJOURD'HUI: " + absent.map(function(w) { return w.name + " (" + w.type + ")"; }).join(", ") + "\n";
  }

  // Mémoire
  context += "\n=== MA MEMOIRE (observations passees) ===\n";
  if (recentMemory.length === 0) {
    context += "Aucune observation precedente. C'est ma premiere execution.\n";
  } else {
    recentMemory.forEach(function(m) {
      var fb = m.feedback === "good" ? " [APPROUVE PAR DIRECTEUR]" : m.feedback === "bad" ? " [REJETE PAR DIRECTEUR - ne plus faire ce type d'observation]" : "";
      context += "- [" + m.type + "] " + m.content.substring(0, 200) + fb + "\n";
    });
  }

  if (goodMemory.length > 0) {
    context += "\nOBSERVATIONS QUE LE DIRECTEUR A APPROUVEES (a reproduire):\n";
    goodMemory.forEach(function(m) { context += "- " + m.content.substring(0, 150) + "\n"; });
  }

  // 4. Envoyer au cerveau (Claude) pour raisonnement
  var claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: "Tu es un employe RH autonome chez IziShip (logistique/entreposage). Tu travailles 24h/24 pour le directeur David.\n\nTon role:\n- Analyser les donnees de pointage en continu\n- Detecter les anomalies, tendances, risques\n- Proposer des actions concretes\n- Apprendre du feedback du directeur\n\nREGLES:\n1. Si le directeur a APPROUVE une observation, fais-en plus du meme type\n2. Si le directeur a REJETE une observation, ne refais JAMAIS ce type\n3. Sois proactif — ne te contente pas de decrire, RECOMMANDE des actions\n4. Priorise: retards recurrents, heures sup excessives, absences inexpliquees, desequilibres interim/CDI\n5. Pense comme un vrai RH: cout, risque juridique, bien-etre des salaries\n\nReponds UNIQUEMENT en JSON valide avec cette structure:\n{\n  \"observations\": [\n    {\"type\": \"alerte|tendance|recommandation|rapport\", \"content\": \"texte\", \"importance\": 1-10, \"action_suggested\": \"action concrete ou null\"}\n  ],\n  \"summary\": \"resume en 2 phrases de ta analyse\",\n  \"priority_action\": \"l'action la plus urgente a faire ou null\"\n}",
      messages: [{ role: "user", content: context }]
    })
  });

  if (!claudeRes.ok) {
    var errText = await claudeRes.text();
    console.error("Agent Claude error:", errText);
    return err("Agent error: " + claudeRes.status, 500);
  }

  var claudeData = await claudeRes.json();
  var rawReply = "";
  if (claudeData.content && claudeData.content.length > 0) { rawReply = claudeData.content[0].text || ""; }

  // 5. Parser la réponse et stocker en mémoire
  var agentResponse;
  try {
    var cleaned = rawReply.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    agentResponse = JSON.parse(cleaned);
  } catch (e) {
    agentResponse = { observations: [{ type: "rapport", content: rawReply, importance: 5, action_suggested: null }], summary: rawReply.substring(0, 200), priority_action: null };
  }

  var obsCount = 0;
  if (agentResponse.observations && Array.isArray(agentResponse.observations)) {
    for (var i = 0; i < agentResponse.observations.length; i++) {
      var obs = agentResponse.observations[i];
      await sql("INSERT INTO agent_memory (type,content,importance) VALUES ($1,$2,$3)", [obs.type || "observation", (obs.content || "") + (obs.action_suggested ? "\n>> ACTION: " + obs.action_suggested : ""), obs.importance || 5]);
      obsCount++;
    }
  }

  // Stocker le résumé
  if (agentResponse.summary) {
    await sql("INSERT INTO agent_memory (type,content,importance) VALUES ($1,$2,$3)", ["resume_run", agentResponse.summary + (agentResponse.priority_action ? "\n>> PRIORITE: " + agentResponse.priority_action : ""), 8]);
  }

  // Log du run
  var duration = Date.now() - startTime;
  await sql("INSERT INTO agent_runs (observations_count,actions_taken,duration_ms) VALUES ($1,$2,$3)", [obsCount, agentResponse.priority_action || "aucune", duration]);

  return json({
    ok: true,
    observations: obsCount,
    summary: agentResponse.summary || "",
    priority_action: agentResponse.priority_action || null,
    duration_ms: duration
  });
}

function genSecret() { var c = "abcdefghijklmnopqrstuvwxyz0123456789"; var s = ""; for (var i = 0; i < 16; i++) s += c.charAt(Math.floor(Math.random()*c.length)); return s; }
