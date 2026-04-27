#!/usr/bin/env node
// Agent RH local — génère les 4 types de docs pour tous les workers via l'API Netlify
// prod et les range dans OneDrive local (sync par OneDrive vers Sébastien).
//
// Usage:
//   node run.mjs [--mode=weekly|monthly|both] [--dry-run]
//
// weekly   : fiche salarié uniquement, à la racine du dossier worker (cleanup des
//            anciennes fiches avant écriture pour ne pas accumuler 52 par an).
// monthly  : monthly_recap + breaks_history + hours_excel pour mois courant et
//            mois précédent, dans {worker}/YYYY-MM/. Overwrite simple.
// both     : les deux (tests manuels).
// --dry-run: pas d'écriture disque, pas d'appel generateDoc. Login + listWorkers
//            exécutés quand même pour valider la chaîne auth.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RhApiClient } from './lib/api.mjs';
import { createLogger } from './lib/log.mjs';
import { mkdirp, writeBinary, listMatching, removeFile, slugify } from './lib/files.mjs';
import { workerDir, profilePattern } from './lib/paths.mjs';
import { notifyMacOS } from './lib/notify.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ───── Parse args ─────
let mode = 'weekly';
let dryRun = false;
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--mode=')) mode = a.split('=')[1];
  else if (a === '--dry-run') dryRun = true;
  else if (a === '-h' || a === '--help') {
    console.log('Usage: node run.mjs [--mode=weekly|monthly|both] [--dry-run]');
    process.exit(0);
  }
}
if (!['weekly', 'monthly', 'both'].includes(mode)) {
  console.error(`Invalid --mode: "${mode}". Expected weekly | monthly | both.`);
  process.exit(2);
}

// ───── Load .env.local (no dotenv dep — manual parser) ─────
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

const { API_BASE_URL, ADMIN_PASSWORD, ONEDRIVE_ROOT } = process.env;
if (!API_BASE_URL || !ADMIN_PASSWORD || !ONEDRIVE_ROOT) {
  console.error('Missing required env vars (API_BASE_URL, ADMIN_PASSWORD, ONEDRIVE_ROOT). See .env.example.');
  process.exit(2);
}
try { await fs.access(ONEDRIVE_ROOT); }
catch { console.error(`ONEDRIVE_ROOT does not exist: ${ONEDRIVE_ROOT}`); process.exit(2); }

// ───── Logger + periods ─────
const SINK = '/tmp/rh-agent-last-run.log';
const log = createLogger(SINK);

function yyyymm(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
const now = new Date();
const currentMonth = yyyymm(now);
const prevDate = new Date(now); prevDate.setDate(1); prevDate.setMonth(prevDate.getMonth() - 1);
const prevMonth = yyyymm(prevDate);

log.info(`Mode: ${mode}${dryRun ? ' (DRY RUN)' : ''}`);
log.info(`API: ${API_BASE_URL}`);
log.info(`Root: ${ONEDRIVE_ROOT}`);
if (mode !== 'weekly') log.info(`Periods: ${currentMonth}, ${prevMonth}`);

// ───── Main ─────
const MONTHLY_TYPES = ['monthly_recap', 'breaks_history', 'hours_excel'];
let fatal = null;
let archivedCount = 0;

// ───── Strategie C : archivage des dossiers orphelins ─────
// Avant generation, on liste tous les dossiers existants dans Salaries/ et
// Interimaires/<agence>/, et on archive (rename vers _archived/<date>/) ceux
// qui ne correspondent plus a un worker actif+approuve. Les fichiers restent
// recuperables, jamais supprimes — rollback possible en cas d'erreur.
async function archiveOrphans(activeWorkers) {
  const expected = new Set();
  for (const w of activeWorkers) {
    const isInterim = !!(w.agency && String(w.agency).trim());
    if (isInterim) {
      expected.add(path.join('Intérimaires', slugify(w.agency), slugify(w.name)));
    } else {
      expected.add(path.join('Salariés', slugify(w.name)));
    }
  }

  const today = new Date().toISOString().slice(0, 10); // 2026-04-27
  const archivedRoot = path.join(ONEDRIVE_ROOT, '_archived', today);

  // Walk : Salaries/<slug>/ et Interimaires/<agence>/<slug>/
  const sections = [
    { rel: 'Salariés', depth: 1 },
    { rel: 'Intérimaires', depth: 2 }
  ];

  for (const { rel, depth } of sections) {
    const sectionPath = path.join(ONEDRIVE_ROOT, rel);
    try { await fs.access(sectionPath); } catch { continue; } // section absente → skip

    if (depth === 1) {
      // Salaries/<slug>/
      const entries = await safeReaddir(sectionPath);
      for (const name of entries) {
        if (name.startsWith('.') || name === '_archived') continue;
        const full = path.join(sectionPath, name);
        if (!(await isDir(full))) continue;
        const relWorker = path.join(rel, name);
        if (expected.has(relWorker)) continue;
        await archiveFolder(full, path.join(archivedRoot, relWorker), relWorker);
      }
    } else {
      // Interimaires/<agence>/<slug>/
      const agencies = await safeReaddir(sectionPath);
      for (const ag of agencies) {
        if (ag.startsWith('.') || ag === '_archived') continue;
        const agencyPath = path.join(sectionPath, ag);
        if (!(await isDir(agencyPath))) continue;
        const workers = await safeReaddir(agencyPath);
        for (const name of workers) {
          if (name.startsWith('.')) continue;
          const full = path.join(agencyPath, name);
          if (!(await isDir(full))) continue;
          const relWorker = path.join(rel, ag, name);
          if (expected.has(relWorker)) continue;
          await archiveFolder(full, path.join(archivedRoot, relWorker), relWorker);
        }
      }
    }
  }
}

async function safeReaddir(p) {
  try { return await fs.readdir(p); } catch { return []; }
}
async function isDir(p) {
  try { const st = await fs.stat(p); return st.isDirectory(); } catch { return false; }
}
async function archiveFolder(src, dest, relLabel) {
  // Skip si dossier vide ou disparu
  try {
    const entries = await fs.readdir(src);
    if (!entries.length) { log.info(`  archive skip (vide): ${relLabel}`); return; }
  } catch { return; }
  if (dryRun) {
    log.info(`  [dry-run] archive ${relLabel} → _archived/${path.relative(path.join(ONEDRIVE_ROOT, '_archived'), dest)}`);
    archivedCount++;
    return;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(src, dest);
    archivedCount++;
    log.info(`  archive: ${relLabel} → _archived/${path.relative(path.join(ONEDRIVE_ROOT, '_archived'), dest)}`);
  } catch (e) {
    if (e.code === 'EXDEV') {
      // Cross-device : copie recursive + suppression
      await copyRecursive(src, dest);
      await fs.rm(src, { recursive: true, force: true });
      archivedCount++;
      log.info(`  archive (xdev): ${relLabel}`);
    } else {
      log.error(`  archive failed ${relLabel}: ${e.message}`);
    }
  }
}
async function copyRecursive(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyRecursive(s, d);
    else await fs.copyFile(s, d);
  }
}

try {
  const client = new RhApiClient({ baseUrl: API_BASE_URL, password: ADMIN_PASSWORD });

  log.info('Login...');
  await client.login();
  log.info('Login OK');

  log.info('List workers...');
  const allWorkers = await client.listWorkers();
  // Strategie C : filtre active=true ET pending_admin_approval=false. Les
  // dossiers des workers exclus seront archives (cf archiveOrphans). Les
  // fichiers ne sont plus generes pour eux non plus.
  const workers = allWorkers.filter(w => (w.active !== false) && !w.pending_admin_approval);
  const skipped = allWorkers.length - workers.length;
  log.info(`${workers.length} worker(s) actif(s) + approuve(s)${skipped ? ` (${skipped} ignore(s) : inactifs ou pending)` : ''}`);

  log.info('Archivage orphelins...');
  await archiveOrphans(workers);
  log.info(`${archivedCount} dossier(s) archive(s)`);

  for (const w of workers) {
    log.info(`─── ${w.name} (id=${w.id}, type=${w.type}, agency="${w.agency || ''}") ───`);
    const dir = workerDir(ONEDRIVE_ROOT, w);
    log.info(`  dir: ${dir}`);

    try {
      if (dryRun) {
        log.info(`  [dry-run] mkdir -p ${dir}`);
      } else {
        await mkdirp(dir);
      }

      // ─── weekly : fiche salarié, avec cleanup des anciennes fiches ───
      if (mode === 'weekly' || mode === 'both') {
        const pattern = profilePattern(w);
        const existing = await listMatching(dir, pattern);
        if (existing.length > 0) {
          if (dryRun) {
            log.info(`  [dry-run] would remove ${existing.length} old profile(s): ${existing.join(', ')}`);
          } else {
            for (const fname of existing) {
              await removeFile(path.join(dir, fname));
              log.info(`  removed old profile: ${fname}`);
            }
          }
        }

        if (dryRun) {
          log.info(`  [dry-run] POST /rh/generate {worker_profile} → ${dir}/<fiche-salarie-${slugify(w.name)}-YYYY-MM-DD.pdf>`);
        } else {
          const { filename, buffer } = await client.generateDoc({ workerId: w.id, docType: 'worker_profile' });
          const full = path.join(dir, filename);
          await writeBinary(full, buffer);
          log.success(`  wrote ${full} (${buffer.length}B)`);
        }
      }

      // ─── monthly : 3 docs × 2 mois dans {worker}/YYYY-MM/ ───
      if (mode === 'monthly' || mode === 'both') {
        for (const period of [currentMonth, prevMonth]) {
          const periodDir = path.join(dir, period);
          if (dryRun) {
            log.info(`  [dry-run] mkdir -p ${periodDir}`);
          } else {
            await mkdirp(periodDir);
          }
          for (const docType of MONTHLY_TYPES) {
            try {
              if (dryRun) {
                const ext = docType === 'hours_excel' ? 'xlsx' : 'pdf';
                log.info(`  [dry-run] POST /rh/generate {${docType}, ${period}} → ${periodDir}/<${docType}-${slugify(w.name)}-${period}.${ext}>`);
              } else {
                const { filename, buffer } = await client.generateDoc({ workerId: w.id, docType, period });
                const full = path.join(periodDir, filename);
                await writeBinary(full, buffer);
                log.success(`  wrote ${full} (${buffer.length}B)`);
              }
            } catch (e) {
              log.error(`  ${w.name} ${docType} ${period}: ${e.message}`);
            }
          }
        }
      }
    } catch (e) {
      log.error(`${w.name}: ${e.message}`);
    }
  }
} catch (e) {
  fatal = e;
  log.error(`FATAL: ${e.message}`);
}

// ───── Summary + notification ─────
const s = log.summary();
const durSec = (s.durationMs / 1000).toFixed(1);
log.info(`SUMMARY: ${s.successes} fichier(s) écrit(s), ${s.errors} erreur(s), ${archivedCount} archive(s), ${durSec}s`);

// Ligne machine-readable parsee par poll-loop.mjs (capture stdout du child).
console.log(`[summary] files_written=${s.successes} archived=${archivedCount}`);

if (!dryRun) {
  if (fatal) {
    notifyMacOS('❌ Agent RH', (fatal.message || 'Erreur inconnue').substring(0, 160));
  } else if (s.errors === 0) {
    notifyMacOS('✅ Dossiers RH générés', `${s.successes} fichier(s) (${durSec}s)`);
  } else {
    notifyMacOS('⚠️ Agent RH partiel', `${s.successes} ok, ${s.errors} erreur(s)`, `Voir ${SINK}`);
  }
}

process.exit((fatal || s.errors > 0) ? 1 : 0);
