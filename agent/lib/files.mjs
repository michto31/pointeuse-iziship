import fs from 'node:fs/promises';

// Same implementation as netlify/functions/rh/slug.js — volontairement duppliqué
// pour que l'agent soit autonome du backend (peut tourner sans le repo back).
export function slugify(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-') || 'worker';
}

export async function mkdirp(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeBinary(filePath, buffer) {
  await fs.writeFile(filePath, buffer);
}

export async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export async function listMatching(dir, regex) {
  try {
    const names = await fs.readdir(dir);
    return names.filter(n => regex.test(n));
  } catch { return []; }
}

export async function removeFile(filePath) {
  await fs.unlink(filePath);
}
