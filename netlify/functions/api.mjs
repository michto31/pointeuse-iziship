import { neon } from "@neondatabase/serverless";

const H = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};
function json(d, s) { return new Response(JSON.stringify(d), { status: s || 200, headers: H }); }
function err(m, s) { return json({ error: m }, s || 400); }

function getSQL() {
  var url = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL_UNPOOLED || process.env.NETLIFY_DATABASE_URL || "";
  if (!url) return null;
  return neon(url);
}

export default async function handler(event) {
  if (event.httpMethod === "OPTIONS") return new Response(null, { status: 204, headers: H });
  var sql = getSQL();
  if (!sql) return json({ error: "No DATABASE_URL" }, 500);

  var path = event.path.replace("/.netlify/functions/api", "").replace(/^\/+/, "");
  var method = event.httpMethod;
  var body = {};
  try { if (event.body) body = JSON.parse(event.body); } catch (e) {}
  var seg = path.split("/");
  var qs = event.queryStringParameters || {};

  try {
    if (method === "POST" && path === "init") { await initDB(sql); return json({ ok: true, message: "DB initialized" }); }
    if (method === "POST" && path === "auth/login") return await handleLogin(sql, body);
    if (method === "POST" && path === "auth/change-password") return await handleChangePwd(sql, body);

    if (method === "GET" && path === "workers") return json(await sql`SELECT * FROM workers ORDER BY type, name`);
    if (method === "POST" && path === "workers") {
      if (!body.name) return err("Nom requis");
      var rows = await sql`INSERT INTO workers (name,agency,type,phone,badge,sched_in,sched_out) VALUES (${body.name},${body.agency||""},${body.type||"interim"},${body.phone||""},${body.badge||""},${body.schedIn||"08:00"},${body.schedOut||"16:00"}) RETURNING *`;
      return json(rows[0], 201);
    }
    if (method === "PUT" && seg[0] === "workers" && seg[1]) {
      var id = parseInt(seg[1]);
      var rows = await sql`UPDATE workers SET name=COALESCE(${body.name},name), agency=COALESCE(${body.agency},agency), type=COALESCE(${body.type},type), phone=COALESCE(${body.phone},phone), badge=COALESCE(${body.badge},badge), sched_in=COALESCE(${body.schedIn},sched_in), sched_out=COALESCE(${body.schedOut},sched_out), updated_at=NOW() WHERE id=${id} RETURNING *`;
      return rows[0] ? json(rows[0]) : err("Introuvable", 404);
    }
    if (method === "DELETE" && seg[0] === "workers" && seg[1]) {
      await sql`DELETE FROM workers WHERE id=${parseInt(seg[1])}`;
      return json({ ok: true });
    }

    if (method === "GET" && path === "records") {
      var date = qs.date;
      var workerId = qs.workerId;
      var from = qs.from;
      var to = qs.to;
      if (date && workerId) return json(await sql`SELECT r.*, w.type as worker_type FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date=${date} AND r.worker_id=${parseInt(workerId)} ORDER BY r.arrival`);
      if (date) return json(await sql`SELECT r.*, w.type as worker_type FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date=${date} ORDER BY w.type, r.arrival`);
      if (from && to && workerId) return json(await sql`SELECT r.*, w.type as worker_type FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date>=${from} AND r.date<=${to} AND r.worker_id=${parseInt(workerId)} ORDER BY r.date, r.arrival`);
      if (from && to) return json(await sql`SELECT r.*, w.type as worker_type FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date>=${from} AND r.date<=${to} ORDER BY r.date, w.type, r.arrival`);
      var today = new Date().toISOString().slice(0, 10);
      return json(await sql`SELECT r.*, w.type as worker_type FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date=${today} ORDER BY w.type, r.arrival`);
    }
    if (method === "POST" && path === "records") {
      if (!body.workerId || !body.arrival) return err("workerId et arrival requis");
      var brk = JSON.stringify(body.breaks || []);
      var rows = await sql`INSERT INTO records (worker_id,worker_name,agency,date,arrival,departure,breaks) VALUES (${body.workerId},${body.workerName||""},${body.agency||""},${body.date},${body.arrival},${body.departure||null},${brk}::jsonb) RETURNING *`;
      return json(rows[0], 201);
    }
    if (method === "PUT" && seg[0] === "records" && seg[1]) {
      var rid = parseInt(seg[1]);
      var dep = body.departure !== undefined ? body.departure : null;
      var brk = body.breaks ? JSON.stringify(body.breaks) : null;
      var rows = await sql`UPDATE records SET arrival=COALESCE(${body.arrival},arrival), departure=${dep}, breaks=COALESCE(${brk}::jsonb,breaks), updated_at=NOW() WHERE id=${rid} RETURNING *`;
      return rows[0] ? json(rows[0]) : err("Introuvable", 404);
    }
    if (method === "DELETE" && seg[0] === "records" && seg[1]) {
      await sql`DELETE FROM records WHERE id=${parseInt(seg[1])}`;
      return json({ ok: true });
    }

    if (method === "GET" && path === "postes") return json(await sql`SELECT * FROM postes ORDER BY name`);
    if (method === "POST" && path === "postes") {
      if (!body.name) return err("Nom requis");
      var rows = await sql`INSERT INTO postes (name,location) VALUES (${body.name},${body.location||""}) RETURNING *`;
      return json(rows[0], 201);
    }
    if (method === "DELETE" && seg[0] === "postes" && seg[1]) {
      await sql`DELETE FROM postes WHERE id=${parseInt(seg[1])}`;
      return json({ ok: true });
    }

    if (method === "GET" && path === "qr-secret") {
      var rows = await sql`SELECT value FROM settings WHERE key='qr_secret'`;
      if (!rows[0]) { var s = genSecret(); await sql`INSERT INTO settings (key,value) VALUES ('qr_secret',${s})`; return json({ secret: s }); }
      return json({ secret: rows[0].value });
    }
    if (method === "POST" && path === "qr-secret/regenerate") {
      var s = genSecret();
      await sql`INSERT INTO settings (key,value) VALUES ('qr_secret',${s}) ON CONFLICT (key) DO UPDATE SET value=${s}`;
      return json({ secret: s });
    }

    if (method === "POST" && path === "scan") return await handleScan(sql, body);

    return err("Route: " + path, 404);
  } catch (e) {
    console.error("API Error:", e);
    return json({ error: e.message }, 500);
  }
}

async function initDB(sql) {
  await sql`CREATE TABLE IF NOT EXISTS workers (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, agency VARCHAR(255) DEFAULT '', type VARCHAR(20) DEFAULT 'interim', phone VARCHAR(50) DEFAULT '', badge VARCHAR(100) DEFAULT '', sched_in VARCHAR(5) DEFAULT '08:00', sched_out VARCHAR(5) DEFAULT '16:00', created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`;
  await sql`CREATE TABLE IF NOT EXISTS records (id SERIAL PRIMARY KEY, worker_id INTEGER REFERENCES workers(id) ON DELETE CASCADE, worker_name VARCHAR(255) DEFAULT '', agency VARCHAR(255) DEFAULT '', date DATE NOT NULL, arrival VARCHAR(5), departure VARCHAR(5), breaks JSONB DEFAULT '[]', created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`;
  await sql`CREATE TABLE IF NOT EXISTS postes (id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, location VARCHAR(255) DEFAULT '', created_at TIMESTAMP DEFAULT NOW())`;
  await sql`CREATE TABLE IF NOT EXISTS settings (key VARCHAR(100) PRIMARY KEY, value TEXT NOT NULL)`;
  var pwd = await sql`SELECT value FROM settings WHERE key='admin_password'`;
  if (!pwd[0]) await sql`INSERT INTO settings (key,value) VALUES ('admin_password','admin')`;
  var qrs = await sql`SELECT value FROM settings WHERE key='qr_secret'`;
  if (!qrs[0]) await sql`INSERT INTO settings (key,value) VALUES ('qr_secret',${genSecret()})`;
  await sql`CREATE INDEX IF NOT EXISTS idx_records_date ON records(date)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_records_worker ON records(worker_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_workers_badge ON workers(badge)`;
}

async function handleLogin(sql, body) {
  if (body.mode === "admin") {
    var r = await sql`SELECT value FROM settings WHERE key='admin_password'`;
    return (!r[0] || r[0].value !== body.password) ? err("Mot de passe incorrect", 401) : json({ role: "admin" });
  }
  if (body.mode === "badge") {
    if (!body.badge) return err("Badge requis");
    var w = await sql`SELECT * FROM workers WHERE badge=${body.badge} AND badge!=''`;
    return w[0] ? json({ role: "employee", worker: w[0] }) : err("Badge inconnu", 401);
  }
  if (body.mode === "name") {
    if (!body.workerId) return err("workerId requis");
    var w = await sql`SELECT * FROM workers WHERE id=${parseInt(body.workerId)}`;
    return w[0] ? json({ role: "employee", worker: w[0] }) : err("Introuvable", 401);
  }
  return err("Mode invalide");
}

async function handleChangePwd(sql, body) {
  var r = await sql`SELECT value FROM settings WHERE key='admin_password'`;
  if (!r[0] || r[0].value !== body.oldPassword) return err("Ancien mot de passe incorrect", 401);
  await sql`UPDATE settings SET value=${body.newPassword} WHERE key='admin_password'`;
  return json({ ok: true });
}

async function handleScan(sql, body) {
  var worker;
  if (body.badge) {
    var w = await sql`SELECT * FROM workers WHERE badge=${body.badge} AND badge!=''`;
    if (!w[0]) return json({ action: "unknown_badge", badge: body.badge });
    worker = w[0];
  } else if (body.workerId) {
    var w = await sql`SELECT * FROM workers WHERE id=${parseInt(body.workerId)}`;
    if (!w[0]) return err("Introuvable", 404);
    worker = w[0];
  } else return err("badge ou workerId requis");

  if (body.qrData) {
    var qrRow = await sql`SELECT value FROM settings WHERE key='qr_secret'`;
    var parts = body.qrData.split(":");
    if (parts.length !== 3 || parts[0] !== "iziship" || parts[1] !== ((qrRow[0] && qrRow[0].value) || ""))
      return json({ action: "invalid_qr" });
  }

  var today = new Date().toISOString().slice(0, 10);
  var now = new Date();
  var timeNow = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  var recs = await sql`SELECT * FROM records WHERE worker_id=${worker.id} AND date=${today} ORDER BY id DESC LIMIT 1`;
  var rec = recs[0];

  if (!rec || rec.departure) {
    var nr = await sql`INSERT INTO records (worker_id,worker_name,agency,date,arrival,breaks) VALUES (${worker.id},${worker.name},${worker.agency||""},${today},${timeNow},'[]'::jsonb) RETURNING *`;
    return json({ action: "arrival", time: timeNow, worker: worker, record: nr[0] });
  }
  var breaks = rec.breaks || [];
  var lb = breaks.length ? breaks[breaks.length - 1] : null;
  if (lb && !lb.end) {
    lb.end = timeNow;
    var up = await sql`UPDATE records SET breaks=${JSON.stringify(breaks)}::jsonb, updated_at=NOW() WHERE id=${rec.id} RETURNING *`;
    return json({ action: "break_end", time: timeNow, worker: worker, record: up[0] });
  }
  return json({ action: "choose", time: timeNow, worker: worker, record: rec, options: ["break_start", "departure"] });
}

function genSecret() {
  var c = "abcdefghijklmnopqrstuvwxyz0123456789";
  var s = "";
  for (var i = 0; i < 16; i++) s += c.charAt(Math.floor(Math.random() * c.length));
  return s;
}
