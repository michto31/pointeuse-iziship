#!/usr/bin/env node
// Agent RH local — poll-loop pour exécution sync à la demande depuis l'admin web.
//
// Architecture : front admin POST /api/sync/request → INSERT pending dans la
// table sync_requests. Cette boucle GET /api/sync/pending toutes les 30s,
// claim atomique → running, exécute run.mjs, POST /complete avec le résultat.
//
// Auth : header X-Sync-Agent-Token (partagé entre Netlify env et .env.local).
// Pas de session admin — token statique long suffisant pour cet usage interne.
//
// Usage : node poll-loop.mjs (Ctrl+C pour arrêter).
// Lancé en permanence via launchd (cf launchd/com.iziship.poll-loop.plist).

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { notifyMacOS } from './lib/notify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ───── Load .env.local (même parser que run.mjs) ─────
async function loadEnv() {
  const envPath = path.join(__dirname, '.env.local');
  let content;
  try { content = await fs.readFile(envPath, 'utf-8'); }
  catch (e) { throw new Error(`Cannot read ${envPath}: ${e.message}`); }
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}
await loadEnv();

const { API_BASE_URL, SYNC_AGENT_TOKEN } = process.env;
if (!API_BASE_URL) {
  console.error('[poll-loop] FATAL: API_BASE_URL absent de .env.local');
  process.exit(2);
}
if (!SYNC_AGENT_TOKEN) {
  console.error('[poll-loop] FATAL: SYNC_AGENT_TOKEN absent de .env.local. Generer via: openssl rand -hex 32');
  process.exit(2);
}

const API = API_BASE_URL.replace(/\/+$/, '');
const TOKEN_LEN = SYNC_AGENT_TOKEN.length; // log la longueur, jamais le token
const POLL_IDLE_MS = 30 * 1000;            // 30s quand pas de demande
const POLL_AFTER_RUN_MS = 5 * 1000;        // 5s après une sync (rebascule rapide)
const BACKOFF_STEPS_MS = [30000, 60000, 120000, 300000]; // erreur réseau
const HTTP_TIMEOUT_MS = 30000;

function ts() { return new Date().toISOString(); }
function log(msg) { console.log(`[${ts()}] [poll-loop] ${msg}`); }
function logErr(msg) { console.error(`[${ts()}] [poll-loop] ERR ${msg}`); }

log(`Demarrage. API=${API} token_len=${TOKEN_LEN}`);

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

async function getPending() {
  const res = await fetchWithTimeout(`${API}/api/sync/pending`, {
    headers: { 'X-Sync-Agent-Token': SYNC_AGENT_TOKEN }
  });
  if (res.status === 401) {
    logErr('401 Unauthorized — SYNC_AGENT_TOKEN invalide cote serveur. Exit 2.');
    process.exit(2);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function postComplete(syncId, payload) {
  const res = await fetchWithTimeout(`${API}/api/sync/${syncId}/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sync-Agent-Token': SYNC_AGENT_TOKEN
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.error || msg; } catch {}
    throw new Error(`postComplete ${syncId}: ${msg}`);
  }
}

// Spawn run.mjs et capture stdout/stderr. Retourne { code, stdout, stderr }.
function runChild(mode) {
  return new Promise((resolve) => {
    const child = spawn('node', ['run.mjs', `--mode=${mode}`], { cwd: __dirname });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + '\n' + e.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Parse la ligne "[summary] files_written=N archived=M" en fin de stdout.
function parseSummary(stdout) {
  const m = /\[summary\]\s+files_written=(\d+)(?:\s+archived=(\d+))?/.exec(stdout);
  if (!m) return { files_written: 0, archived: 0 };
  return { files_written: parseInt(m[1], 10), archived: parseInt(m[2] || '0', 10) };
}

async function handleSync({ sync_id, mode }) {
  log(`Sync demandee: id=${sync_id} mode=${mode}`);
  notifyMacOS('🔄 Sync RH demarre', `id=${sync_id} mode=${mode}`);

  const { code, stdout, stderr } = await runChild(mode);
  const { files_written, archived } = parseSummary(stdout);

  if (code === 0) {
    log(`Sync ${sync_id} OK: files=${files_written} archived=${archived}`);
    try {
      await postComplete(sync_id, { success: true, files_generated: files_written });
      notifyMacOS('✅ Sync RH terminee', `${files_written} fichier(s), ${archived} archive(s)`);
    } catch (e) {
      logErr(`postComplete success failed: ${e.message}`);
    }
  } else {
    const tail = (stderr || stdout).slice(-500);
    logErr(`Sync ${sync_id} FAIL code=${code} tail=${tail.replace(/\s+/g, ' ').slice(0, 200)}`);
    try {
      await postComplete(sync_id, { success: false, error_message: tail, files_generated: files_written });
      notifyMacOS('❌ Sync RH echoue', `code=${code} (${files_written} fichier(s) avant crash)`);
    } catch (e) {
      logErr(`postComplete fail report failed: ${e.message}`);
    }
  }
}

// Boucle principale avec backoff exponentiel sur erreurs reseau.
let backoffIdx = 0;
while (true) {
  let next = POLL_IDLE_MS;
  try {
    const data = await getPending();
    backoffIdx = 0; // reset backoff sur succes
    if (data && data.sync_id) {
      await handleSync(data);
      next = POLL_AFTER_RUN_MS;
    }
  } catch (e) {
    const wait = BACKOFF_STEPS_MS[Math.min(backoffIdx, BACKOFF_STEPS_MS.length - 1)];
    logErr(`getPending failed (${e.message}), backoff ${wait / 1000}s`);
    backoffIdx++;
    next = wait;
  }
  await new Promise((r) => setTimeout(r, next));
}
