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

## Sync OneDrive à la demande (poll-loop)

Concept : un bouton **Sync OneDrive maintenant** dans l'admin web file une demande dans la table `sync_requests` (Postgres). L'agent local `poll-loop.mjs` poll cette queue toutes les 30s et exécute `run.mjs` à la demande. Permet à un admin sans accès SSH au Mac de déclencher une sync.

### Setup token partagé

Génère un token aléatoire :

```bash
openssl rand -hex 32
```

Colle la valeur dans :
1. `agent/.env.local` : `SYNC_AGENT_TOKEN=<la-valeur>`
2. Netlify : Site settings > Environment variables > `SYNC_AGENT_TOKEN` (puis redeploy)

Sans le token, le poll-loop reçoit 401 et exit code 2 (visible dans `/tmp/rh-poll-loop-err.log`).

### Setup launchd

```bash
# Vérifie le path node attendu par le plist (par défaut /opt/homebrew/bin/node pour M1/M2)
which node
# Si différent (Intel Mac → /usr/local/bin/node), édite agent/launchd/com.iziship.poll-loop.plist

cp launchd/com.iziship.poll-loop.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.iziship.poll-loop.plist
launchctl list | grep iziship   # doit afficher com.iziship.poll-loop avec un PID

# Logs
tail -f /tmp/rh-poll-loop.log
tail -f /tmp/rh-poll-loop-err.log
```

### Stratégie C — archivage des dossiers orphelins

À chaque run (déclenché manuel, weekly, monthly, ou via poll-loop), `run.mjs` :
1. Liste tous les workers `active=true` ET `pending_admin_approval=false`
2. Liste tous les dossiers existants dans `Salariés/` et `Intérimaires/<agence>/`
3. Archive (rename) tout dossier qui ne correspond plus à un worker actif vers `_archived/<date-iso>/<chemin-original>/`

Aucun fichier n'est jamais supprimé — rollback possible en déplaçant le dossier hors de `_archived/`. La date du run sert de groupement, ce qui permet de retrouver toutes les archives d'une journée donnée.

Cas d'archivage typiques :
- Worker passé en `active=false` (départ enregistré)
- Worker renommé (le slug change → l'ancien dossier devient orphelin et part dans `_archived/`, le nouveau dossier est créé propre)
- Intérimaire qui a changé d'agence (ancien `Intérimaires/<vieille-agence>/<slug>/` archivé, nouveau dossier créé sous la bonne agence)

### Test manuel sans launchd

```bash
node poll-loop.mjs
# Ctrl+C pour arrêter
```

### Désactivation

```bash
launchctl unload ~/Library/LaunchAgents/com.iziship.poll-loop.plist
```
