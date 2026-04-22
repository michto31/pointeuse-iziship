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

try {
  const client = new RhApiClient({ baseUrl: API_BASE_URL, password: ADMIN_PASSWORD });

  log.info('Login...');
  await client.login();
  log.info('Login OK');

  log.info('List workers...');
  const workers = await client.listWorkers();
  log.info(`${workers.length} worker(s) found`);

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
log.info(`SUMMARY: ${s.successes} fichier(s) écrit(s), ${s.errors} erreur(s), ${durSec}s`);

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
