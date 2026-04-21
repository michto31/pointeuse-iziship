// netlify/functions/api.mjs
// Pointeuse IziShip — API Backend
// Stack: Netlify Functions + Neon PostgreSQL (@neondatabase/serverless)

import { Pool } from "@neondatabase/serverless";

const dbUrl = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL || "";
console.log("DB URL:", dbUrl ? "found" : "MISSING");

let pool = null;
try { if (dbUrl) pool = new Pool({ connectionString: dbUrl }); }
catch (e) { console.error("Pool error:", e.message); }

async function q(text, params) {
  const res = await pool.query(text, params || []);
  return res.rows;
}
async function q1(text, params) { return (await q(text, params))[0] || null; }

const H = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};
function json(d, s) { return { statusCode: s || 200, headers: H, body: JSON.stringify(d) }; }
function err(m, s) { return json({ error: m }, s || 400); }

export default async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: H };
  if (!pool) return json({ error: "DATABASE_URL manquante" }, 500);

  const path = event.path.replace("/.netlify/functions/api", "").replace(/^\/+/, "");
  const method = event.httpMethod;
  let body = {};
  try { if (event.body) body = JSON.parse(event.body); } catch (e) {}
  const seg = path.split("/");
  const qs = event.queryStringParameters || {};

  try {
    if (method === "POST" && path === "init") { await initDB(); return json({ ok: true, message: "Base de donnees initialisee" }); }
    if (method === "POST" && path === "auth/login") return await handleLogin(body);
    if (method === "POST" && path === "auth/change-password") return await handleChangePwd(body);

    if (method === "GET" && path === "workers") return json(await q("SELECT * FROM workers ORDER BY type, name"));
    if (method === "POST" && path === "workers") {
      if (!body.name) return err("Nom requis");
      return json(await q1("INSERT INTO workers (name,agency,type,phone,badge,sched_in,sched_out) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [body.name, body.agency||"", body.type||"interim", body.phone||"", body.badge||"", body.schedIn||"08:00", body.schedOut||"16:00"]), 201);
    }
    if (method === "PUT" && seg[0] === "workers" && seg[1]) {
      const id = parseInt(seg[1]);
      const r = await q1("UPDATE workers SET name=COALESCE($1,name), agency=COALESCE($2,agency), type=COALESCE($3,type), phone=COALESCE($4,phone), badge=COALESCE($5,badge), sched_in=COALESCE($6,sched_in), sched_out=COALESCE($7,sched_out), updated_at=NOW() WHERE id=$8 RETURNING *",
        [body.name, body.agency, body.type, body.phone, body.badge, body.schedIn, body.schedOut, id]);
      return r ? json(r) : err("Introuvable", 404);
    }
    if (method === "DELETE" && seg[0] === "workers" && seg[1]) {
      await q("DELETE FROM workers WHERE id=$1", [parseInt(seg[1])]);
      return json({ ok: true });
    }

    if (method === "GET" && path === "records") {
      const { date, workerId, from, to } = qs;
      if (date && workerId) return json(await q("SELECT r.*, w.type as worker_type FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date=$1 AND r.worker_id=$2 ORDER BY r.arrival", [date, parseInt(workerId)]));
      if (date) return json(await q("SELECT r.*, w.type as worker_type FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date=$1 ORDER BY w.type, r.arrival", [date]));
      if (from && to && workerId) return json(await q("SELECT r.*, w.type as worker_type FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date>=$1 AND r.date<=$2 AND r.worker_id=$3 ORDER BY r.date, r.arrival", [from, to, parseInt(workerId)]));
      if (from && to) return json(await q("SELECT r.*, w.type as worker_type FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date>=$1 AND r.date<=$2 ORDER BY r.date, w.type, r.arrival", [from, to]));
      const today = new Date().toISOString().slice(0, 10);
      return json(await q("SELECT r.*, w.type as worker_type FROM records r JOIN workers w ON r.worker_id=w.id WHERE r.date=$1 ORDER BY w.type, r.arrival", [today]));
    }
    if (method === "POST" && path === "records") {
      if (!body.workerId || !body.arrival) return err("workerId et arrival requis");
      return json(await q1("INSERT INTO records (worker_id,worker_name,agency,date,arrival,departure,breaks) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [body.workerId, body.workerName||"", body.agency||"", body.date, body.arrival, body.departure||null, JSON.stringify(body.breaks||[])]), 201);
    }
    if (method === "PUT" && seg[0] === "records" && seg[1]) {
      const id = parseInt(seg[1]);
      const r = await q1("UPDATE records SET arrival=COALESCE($1,arrival), departure=$2, breaks=COALESCE($3,breaks), updated_at=NOW() WHERE id=$4 RETURNING *",
        [body.arrival, body.departure !== undefined ? body.departure : null, body.breaks ? JSON.stringify(body.breaks) : null, id]);
      return r ? json(r) : err("Introuvable", 404);
    }
    if (method === "DELETE" && seg[0] === "records" && seg[1]) {
      await q("DELETE FROM records WHERE id=$1", [parseInt(seg[1])]);
      return json({ ok: true });
    }

    if (method === "GET" && path === "postes") return json(await q("SELECT * FROM postes ORDER BY name"));
    if (method === "POST" && path === "postes") {
      if (!body.name) return err("Nom requis");
      return json(await q1("INSERT INTO postes (name,location) VALUES ($1,$2) RETURNING *", [body.name, body.location||""]), 201);
    }
    if (method === "DELETE" && seg[0] === "postes" && seg[1]) {
      await q("DELETE FROM postes WHERE id=$1", [parseInt(seg[1])]);
      return json({ ok: true });
    }

    if (method === "GET" && path === "qr-secret") {
      let row = await q1("SELECT value FROM settings WHERE key='qr_secret'");
      if (!row) { const s = genSecret(); await q("INSERT INTO settings (key,value) VALUES ('qr_secret',$1)", [s]); return json({ secret: s }); }
      return json({ secret: row.value });
    }
    if (method === "POST" && path === "qr-secret/regenerate") {
      const s = genSecret();
      await q("INSERT INTO settings (key,value) VALUES ('qr_secret',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [s]);
      return json({ secret: s });
    }

    if (method === "POST" && path === "scan") return await handleScan(body);

    return err("Route: " + path, 404);
  } catch (e) {
    console.error("API Error:", e);
    return json({ error: e.message }, 500);
  }
}

async function initDB() {
  await q(`CREATE TABLE IF NOT EXISTS workers (
    id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, agency VARCHAR(255) DEFAULT '',
    type VARCHAR(20) DEFAULT 'interim', phone VARCHAR(50) DEFAULT '', badge VARCHAR(100) DEFAULT '',
    sched_in VARCHAR(5) DEFAULT '08:00', sched_out VARCHAR(5) DEFAULT '16:00',
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS records (
    id SERIAL PRIMARY KEY, worker_id INTEGER REFERENCES workers(id) ON DELETE CASCADE,
    worker_name VARCHAR(255) DEFAULT '', agency VARCHAR(255) DEFAULT '',
    date DATE NOT NULL, arrival VARCHAR(5), departure VARCHAR(5), breaks JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS postes (
    id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, location VARCHAR(255) DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS settings (key VARCHAR(100) PRIMARY KEY, value TEXT NOT NULL)`);
  if (!(await q1("SELECT value FROM settings WHERE key='admin_password'")))
    await q("INSERT INTO settings (key,value) VALUES ('admin_password','admin')");
  if (!(await q1("SELECT value FROM settings WHERE key='qr_secret'")))
    await q("INSERT INTO settings (key,value) VALUES ('qr_secret',$1)", [genSecret()]);
  await q("CREATE INDEX IF NOT EXISTS idx_records_date ON records(date)");
  await q("CREATE INDEX IF NOT EXISTS idx_records_worker ON records(worker_id)");
  await q("CREATE INDEX IF NOT EXISTS idx_workers_badge ON workers(badge)");
}

async function handleLogin(body) {
  const { mode, password, badge, workerId } = body;
  if (mode === "admin") {
    const r = await q1("SELECT value FROM settings WHERE key='admin_password'");
    return (!r || r.value !== password) ? err("Mot de passe incorrect", 401) : json({ role: "admin" });
  }
  if (mode === "badge") {
    if (!badge) return err("Badge requis");
    const w = await q1("SELECT * FROM workers WHERE badge=$1 AND badge!=''", [badge]);
    return w ? json({ role: "employee", worker: w }) : err("Badge inconnu", 401);
  }
  if (mode === "name") {
    if (!workerId) return err("workerId requis");
    const w = await q1("SELECT * FROM workers WHERE id=$1", [parseInt(workerId)]);
    return w ? json({ role: "employee", worker: w }) : err("Introuvable", 401);
  }
  return err("Mode invalide");
}

async function handleChangePwd(body) {
  const r = await q1("SELECT value FROM settings WHERE key='admin_password'");
  if (!r || r.value !== body.oldPassword) return err("Ancien mot de passe incorrect", 401);
  await q("UPDATE settings SET value=$1 WHERE key='admin_password'", [body.newPassword]);
  return json({ ok: true });
}

async function handleScan(body) {
  const { badge, workerId, qrData } = body;
  let worker;
  if (badge) {
    worker = await q1("SELECT * FROM workers WHERE badge=$1 AND badge!=''", [badge]);
    if (!worker) return json({ action: "unknown_badge", badge });
  } else if (workerId) {
    worker = await q1("SELECT * FROM workers WHERE id=$1", [parseInt(workerId)]);
    if (!worker) return err("Introuvable", 404);
  } else return err("badge ou workerId requis");

  if (qrData) {
    const qrRow = await q1("SELECT value FROM settings WHERE key='qr_secret'");
    const parts = qrData.split(":");
    if (parts.length !== 3 || parts[0] !== "iziship" || parts[1] !== (qrRow?.value || ""))
      return json({ action: "invalid_qr" });
  }

  const today = new Date().toISOString().slice(0, 10);
  const now = new Date();
  const timeNow = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  const recs = await q("SELECT * FROM records WHERE worker_id=$1 AND date=$2 ORDER BY id DESC LIMIT 1", [worker.id, today]);
  const rec = recs[0];

  if (!rec || rec.departure) {
    const nr = await q1("INSERT INTO records (worker_id,worker_name,agency,date,arrival,breaks) VALUES ($1,$2,$3,$4,$5,'[]') RETURNING *",
      [worker.id, worker.name, worker.agency||"", today, timeNow]);
    return json({ action: "arrival", time: timeNow, worker, record: nr });
  }
  const breaks = rec.breaks || [];
  const lb = breaks.length ? breaks[breaks.length - 1] : null;
  if (lb && !lb.end) {
    lb.end = timeNow;
    const up = await q1("UPDATE records SET breaks=$1, updated_at=NOW() WHERE id=$2 RETURNING *", [JSON.stringify(breaks), rec.id]);
    return json({ action: "break_end", time: timeNow, worker, record: up });
  }
  return json({ action: "choose", time: timeNow, worker, record: rec, options: ["break_start", "departure"] });
}

function genSecret() {
  const c = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = ""; for (let i = 0; i < 16; i++) s += c.charAt(Math.floor(Math.random() * c.length));
  return s;
}
