# Agent RH local — pointeuse-iziship

Agent Node.js qui tourne sur le Mac de David pour générer automatiquement les dossiers RH et les ranger dans OneDrive synchronisé (propagé vers Sébastien).

## Pré-requis

- macOS + Node ≥ 18 (fetch natif)
- OneDrive Bureau installé et synchronisé sur le dossier *Iziship — Sébastien Berthuy - Izilog / 02_Pôle RH*
- Mot de passe admin Netlify connu

## Setup

```bash
cd agent
cp .env.example .env.local
# Éditer .env.local et remplir ADMIN_PASSWORD + ONEDRIVE_ROOT
```

## Utilisation manuelle

```bash
# Dry-run : pas d'écriture disque, affiche ce qui serait fait
node run.mjs --mode=both --dry-run

# Fiches salariés (hebdo) — écrase les anciennes fiches à la racine de chaque dossier worker
node run.mjs --mode=weekly

# Docs mensuels (1er du mois) — 3 PDFs/XLSX × (mois courant, mois précédent)
node run.mjs --mode=monthly

# Les deux
node run.mjs --mode=both
```

Log détaillé : `/tmp/rh-agent-last-run.log` (tronqué à chaque run).

## Arborescence générée

```
{ONEDRIVE_ROOT}/
├── Salariés/
│   └── melyne-rogier/
│       ├── fiche-salarie-melyne-rogier-2026-04-22.pdf
│       ├── 2026-03/
│       │   ├── recap-mensuel-melyne-rogier-2026-03.pdf
│       │   ├── pauses-retards-melyne-rogier-2026-03.pdf
│       │   └── heures-melyne-rogier-2026-03.xlsx
│       └── 2026-04/
│           └── (idem)
└── Intérimaires/
    └── randstad/
        └── pierre-dupont/
            ├── fiche-salarie-pierre-dupont-2026-04-22.pdf
            └── 2026-03/ ...
```

## Installation launchd (à faire APRÈS validation manuelle)

Les plists sont dans `../launchd/` (gitignored, chemins absolus spécifiques à la machine).

```bash
cp ../launchd/com.iziship.rh-weekly.plist  ~/Library/LaunchAgents/
cp ../launchd/com.iziship.rh-monthly.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.iziship.rh-weekly.plist
launchctl load ~/Library/LaunchAgents/com.iziship.rh-monthly.plist
```

Pour désactiver :

```bash
launchctl unload ~/Library/LaunchAgents/com.iziship.rh-weekly.plist
launchctl unload ~/Library/LaunchAgents/com.iziship.rh-monthly.plist
```

Le plist hebdo tourne chaque lundi à 08:00, le mensuel le 1er de chaque mois à 08:00.

Logs launchd :
- `/tmp/rh-agent-weekly.log` + `.err`
- `/tmp/rh-agent-monthly.log` + `.err`
