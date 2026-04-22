var crypto = require("crypto");

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

// Types d'événements security_events. Non contraint en DB (TEXT libre) mais toute
// insertion doit passer par logSecurityEvent() qui vérifie le type.
var SECURITY_EVENT_TYPES = { pin_fail: true, pin_lock: true, pin_create: true, pin_reset: true, station_regen: true };
async function logSecurityEvent(eventType, workerId, stationId, details) {
  if (!SECURITY_EVENT_TYPES[eventType]) throw new Error("Invalid security event type: " + eventType);
  await sql(
    "INSERT INTO security_events (event_type, worker_id, station_id, details) VALUES ($1, $2, $3, $4::jsonb)",
    [eventType, workerId || null, stationId || null, JSON.stringify(details || {})]
  );
}

// In-process rate limiter (Map keyed by IP). Intentionally NOT persisted to DB:
// - Cold starts reset the window, so this is a best-effort slowdown on scraping,
//   not a hard boundary. That's fine for the only public list endpoint we expose
//   (worker-names, used 1-2x per legitimate session).
// - A real attacker can bypass by rotating IPs or waiting out a cold start, but
//   casual scrapers hit a 429 quickly which is the bar we want.
var rateLimitMap = new Map();
function checkRateLimit(event, maxPerMinute) {
  var h = event.headers || {};
  var fwd = h["x-forwarded-for"] || h["X-Forwarded-For"] || h["client-ip"] || "";
  var ip = fwd.split(",")[0].trim() || "unknown";
  var now = Date.now();
  var entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > 60000) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
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
    // Minimal public endpoint (id+name only) so the shared-tablet login
    // dropdown works before any auth token exists. Do NOT broaden this.
    // Rate-limited (20/min/IP, in-process) to slow scraping.
    // TODO: filter to active workers only once the workers table gains an
    // `active` / `archived` column. Currently returns all rows.
    if (method === "GET" && path === "public/worker-names") {
      if (!checkRateLimit(event, 20)) return json({ error: "Too many requests" }, 429);
      return json(await sql("SELECT id, name FROM workers ORDER BY name"));
    }

    if (method === "POST" && path === "assistant") { await requireAuth(event, "admin"); return await handleAssistant(body); }
    if (method === "POST" && path === "agent/run") { await requireAuth(event, "admin"); return await handleAgentRun(); }
    if (method === "GET" && path === "agent/observations") { await requireAuth(event, "admin"); return json(await sql("SELECT * FROM agent_memory ORDER BY created_at DESC LIMIT 50")); }
    if (method === "POST" && path === "agent/feedback") { await requireAuth(event, "admin"); await sql("UPDATE agent_memory SET feedback=$1 WHERE id=$2", [body.feedback, body.id]); return json({ ok: true }); }
    if (method === "GET" && path === "agent/runs") { await requireAuth(event, "admin"); return json(await sql("SELECT * FROM agent_runs ORDER BY run_date DESC LIMIT 20")); }

    if (method === "GET" && path === "workers") { await requireAuth(event, "admin"); return json(await sql("SELECT * FROM workers ORDER BY type, name")); }
    if (method === "POST" && path === "workers") {
      await requireAuth(event, "admin");
      if (!body.name) return err("Nom requis");
      return json(await sql1("INSERT INTO workers (name,agency,type,phone,badge,sched_in,sched_out) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *", [body.name, body.agency||"", body.type||"interim", body.phone||"", body.badge||"", body.schedIn||"08:00", body.schedOut||"16:00"]), 201);
    }
    if (method === "PUT" && seg[0] === "workers" && seg[1]) {
      await requireAuth(event, "admin");
      var r = await sql1("UPDATE workers SET name=COALESCE($1,name),agency=COALESCE($2,agency),type=COALESCE($3,type),phone=COALESCE($4,phone),badge=COALESCE($5,badge),sched_in=COALESCE($6,sched_in),sched_out=COALESCE($7,sched_out),updated_at=NOW() WHERE id=$8 RETURNING *", [body.name, body.agency, body.type, body.phone, body.badge, body.schedIn, body.schedOut, parseInt(seg[1])]);
      return r ? json(r) : err("Introuvable", 404);
    }
    if (method === "DELETE" && seg[0] === "workers" && seg[1]) { await requireAuth(event, "admin"); await sql("DELETE FROM workers WHERE id=$1", [parseInt(seg[1])]); return json({ ok: true }); }

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
