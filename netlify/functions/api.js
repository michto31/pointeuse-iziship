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
    if (method === "POST" && path === "init") { await initDB(); return json({ ok: true, message: "DB initialized" }); }
    if (method === "POST" && path === "auth/login") return await handleLogin(body);
    if (method === "POST" && path === "auth/change-password") return await handleChangePwd(body);
    if (method === "GET" && path === "workers") return json(await sql("SELECT * FROM workers ORDER BY type, name"));
    if (method === "POST" && path === "workers") {
      if (!body.name) return err("Nom requis");
      return json(await sql1("INSERT INTO workers (name,agency,type,phone,badge,sched_in,sched_out) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *", [body.name, body.agency||"", body.type||"interim", body.phone||"", body.badge||"", body.schedIn||"08:00", body.schedOut||"16:00"]), 201);
    }
    if (method === "PUT" && seg[0] === "workers" && seg[1]) {
      var r = await sql1("UPDATE workers SET name=COALESCE($1,name),agency=COALESCE($2,agency),type=COALESCE($3,type),phone=COALESCE($4,phone),badge=COALESCE($5,badge),sched_in=COALESCE($6,sched_in),sched_out=COALESCE($7,sched_out),updated_at=NOW() WHERE id=$8 RETURNING *", [body.name, body.agency, body.type, body.phone, body.badge, body.schedIn, body.schedOut, parseInt(seg[1])]);
      return r ? json(r) : err("Introuvable", 404);
    }
    if (method === "DELETE" && seg[0] === "workers" && seg[1]) { await sql("DELETE FROM workers WHERE id=$1", [parseInt(seg[1])]); return json({ ok: true }); }

    if (method === "GET" && path === "records") {
      var date=qs.date, wid=qs.workerId, from=qs.from, to=qs.to;
      if (date && wid) return json(await sql("SELECT r.*,w.type as worker_type FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date=$1 AND r.worker_id=$2 ORDER BY r.arrival", [date, parseInt(wid)]));
      if (date) return json(await sql("SELECT r.*,w.type as worker_type FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date=$1 ORDER BY w.type,r.arrival", [date]));
      if (from && to && wid) return json(await sql("SELECT r.*,w.type as worker_type FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date>=$1 AND r.date<=$2 AND r.worker_id=$3 ORDER BY r.date,r.arrival", [from, to, parseInt(wid)]));
      if (from && to) return json(await sql("SELECT r.*,w.type as worker_type FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date>=$1 AND r.date<=$2 ORDER BY r.date,w.type,r.arrival", [from, to]));
      return json(await sql("SELECT r.*,w.type as worker_type FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date=$1 ORDER BY w.type,r.arrival", [new Date().toISOString().slice(0,10)]));
    }
    if (method === "POST" && path === "records") {
      if (!body.workerId || !body.arrival) return err("workerId et arrival requis");
      return json(await sql1("INSERT INTO records (worker_id,worker_name,agency,date,arrival,departure,breaks) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *", [body.workerId, body.workerName||"", body.agency||"", body.date, body.arrival, body.departure||null, JSON.stringify(body.breaks||[])]), 201);
    }
    if (method === "PUT" && seg[0] === "records" && seg[1]) {
      var dep = body.departure !== undefined ? body.departure : null;
      var brk = body.breaks ? JSON.stringify(body.breaks) : null;
      return json(await sql1("UPDATE records SET arrival=COALESCE($1,arrival),departure=$2,breaks=COALESCE($3::jsonb,breaks),updated_at=NOW() WHERE id=$4 RETURNING *", [body.arrival, dep, brk, parseInt(seg[1])]), 200);
    }
    if (method === "DELETE" && seg[0] === "records" && seg[1]) { await sql("DELETE FROM records WHERE id=$1", [parseInt(seg[1])]); return json({ ok: true }); }

    if (method === "GET" && path === "postes") return json(await sql("SELECT * FROM postes ORDER BY name"));
    if (method === "POST" && path === "postes") { if (!body.name) return err("Nom requis"); return json(await sql1("INSERT INTO postes (name,location) VALUES ($1,$2) RETURNING *", [body.name, body.location||""]), 201); }
    if (method === "DELETE" && seg[0] === "postes" && seg[1]) { await sql("DELETE FROM postes WHERE id=$1", [parseInt(seg[1])]); return json({ ok: true }); }

    if (method === "GET" && path === "qr-secret") {
      var row = await sql1("SELECT value FROM settings WHERE key='qr_secret'");
      if (!row) { var s = genSecret(); await sql("INSERT INTO settings (key,value) VALUES ('qr_secret',$1)", [s]); return json({ secret: s }); }
      return json({ secret: row.value });
    }
    if (method === "POST" && path === "qr-secret/regenerate") { var s = genSecret(); await sql("INSERT INTO settings (key,value) VALUES ('qr_secret',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [s]); return json({ secret: s }); }
    if (method === "POST" && path === "scan") return await handleScan(body);
    return err("Route: " + path, 404);
  } catch (e) {
    console.error("API Error:", e);
    return json({ error: e.message || "Unknown error" }, 500);
  }
};

async function initDB() {
  await sql("CREATE TABLE IF NOT EXISTS workers (id SERIAL PRIMARY KEY,name VARCHAR(255) NOT NULL,agency VARCHAR(255) DEFAULT '',type VARCHAR(20) DEFAULT 'interim',phone VARCHAR(50) DEFAULT '',badge VARCHAR(100) DEFAULT '',sched_in VARCHAR(5) DEFAULT '08:00',sched_out VARCHAR(5) DEFAULT '16:00',created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW())");
  await sql("CREATE TABLE IF NOT EXISTS records (id SERIAL PRIMARY KEY,worker_id INTEGER REFERENCES workers(id) ON DELETE CASCADE,worker_name VARCHAR(255) DEFAULT '',agency VARCHAR(255) DEFAULT '',date DATE NOT NULL,arrival VARCHAR(5),departure VARCHAR(5),breaks JSONB DEFAULT '[]',created_at TIMESTAMP DEFAULT NOW(),updated_at TIMESTAMP DEFAULT NOW())");
  await sql("CREATE TABLE IF NOT EXISTS postes (id SERIAL PRIMARY KEY,name VARCHAR(255) NOT NULL,location VARCHAR(255) DEFAULT '',created_at TIMESTAMP DEFAULT NOW())");
  await sql("CREATE TABLE IF NOT EXISTS settings (key VARCHAR(100) PRIMARY KEY,value TEXT NOT NULL)");
  if (!(await sql1("SELECT value FROM settings WHERE key='admin_password'"))) await sql("INSERT INTO settings (key,value) VALUES ('admin_password','admin')");
  if (!(await sql1("SELECT value FROM settings WHERE key='qr_secret'"))) await sql("INSERT INTO settings (key,value) VALUES ('qr_secret',$1)", [genSecret()]);
  await sql("CREATE INDEX IF NOT EXISTS idx_records_date ON records(date)");
  await sql("CREATE INDEX IF NOT EXISTS idx_records_worker ON records(worker_id)");
  await sql("CREATE INDEX IF NOT EXISTS idx_workers_badge ON workers(badge)");
}

async function handleLogin(body) {
  if (body.mode === "admin") { var r = await sql1("SELECT value FROM settings WHERE key='admin_password'"); return (!r || r.value !== body.password) ? err("Mot de passe incorrect", 401) : json({ role: "admin" }); }
  if (body.mode === "badge") { if (!body.badge) return err("Badge requis"); var w = await sql1("SELECT * FROM workers WHERE badge=$1 AND badge!=''", [body.badge]); return w ? json({ role: "employee", worker: w }) : err("Badge inconnu", 401); }
  if (body.mode === "name") { if (!body.workerId) return err("workerId requis"); var w = await sql1("SELECT * FROM workers WHERE id=$1", [parseInt(body.workerId)]); return w ? json({ role: "employee", worker: w }) : err("Introuvable", 401); }
  return err("Mode invalide");
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

function genSecret() { var c = "abcdefghijklmnopqrstuvwxyz0123456789"; var s = ""; for (var i = 0; i < 16; i++) s += c.charAt(Math.floor(Math.random()*c.length)); return s; }
