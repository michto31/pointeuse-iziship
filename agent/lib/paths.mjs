import path from 'node:path';
import { slugify } from './files.mjs';

// Compute the target folder for a worker.
// CDI/CDD  → <root>/Salariés/<name-slug>/
// Intérim  → <root>/Intérimaires/<agency-slug>/<name-slug>/
// Accents préservés dans les deux racines ("Salariés", "Intérimaires") par symétrie
// avec le dossier existant "Salariés" dans OneDrive. Risque sync cross-OS accepté
// (Sébastien est sur Mac).
export function workerDir(rootDir, worker) {
  const isInterim = !!(worker.agency && String(worker.agency).trim());
  const nameSlug = slugify(worker.name);
  if (isInterim) {
    const agencySlug = slugify(worker.agency);
    return path.join(rootDir, 'Intérimaires', agencySlug, nameSlug);
  }
  return path.join(rootDir, 'Salariés', nameSlug);
}

// Regex pour matcher les anciennes fiches salarié à nettoyer avant d'écrire la nouvelle.
// Le nom serveur : fiche-salarie-{worker-slug}-{YYYY-MM-DD}.pdf
export function profilePattern(worker) {
  const nameSlug = slugify(worker.name);
  return new RegExp('^fiche-salarie-' + nameSlug + '-\\d{4}-\\d{2}-\\d{2}\\.pdf$');
}
