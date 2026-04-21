# Pointeuse IziShip

Application de pointage pour gérer les arrivées, départs et pauses des salariés et intérimaires.

## Stack technique
- **Frontend** : HTML/CSS/JS vanilla (single-file)
- **Backend** : Netlify Functions (Node.js)
- **BDD** : Neon PostgreSQL via `@netlify/neon`

## Déploiement sur Netlify

### 1. Créer le site
```bash
# Dans le dossier du projet
npm install
netlify init
```

### 2. Créer la base de données Neon
1. Aller sur [neon.tech](https://neon.tech) et créer un projet
2. Copier la **connection string** PostgreSQL
3. Dans Netlify → **Site settings > Environment variables**
4. Ajouter : `DATABASE_URL` = votre connection string Neon
   (format : `postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require`)

### 3. Déployer
```bash
netlify deploy --prod
```

### 4. Initialiser la base de données
Après le premier déploiement, appeler une seule fois :
```
POST https://votre-site.netlify.app/api/init
```
Cela crée les tables `workers`, `records`, `postes`, `settings`.

## Routes API

| Méthode | Route | Description |
|---------|-------|-------------|
| POST | `/api/init` | Initialise la BDD |
| POST | `/api/auth/login` | Connexion admin/salarié |
| GET | `/api/workers` | Liste des salariés |
| POST | `/api/workers` | Ajouter un salarié |
| PUT | `/api/workers/:id` | Modifier un salarié |
| DELETE | `/api/workers/:id` | Supprimer un salarié |
| GET | `/api/records?date=YYYY-MM-DD` | Pointages du jour |
| GET | `/api/records?from=...&to=...` | Pointages sur une période |
| POST | `/api/records` | Créer un pointage |
| PUT | `/api/records/:id` | Modifier un pointage |
| DELETE | `/api/records/:id` | Supprimer un pointage |
| GET | `/api/postes` | Liste des postes |
| POST | `/api/postes` | Ajouter un poste |
| DELETE | `/api/postes/:id` | Supprimer un poste |
| GET | `/api/qr-secret` | Récupérer le secret QR |
| POST | `/api/qr-secret/regenerate` | Régénérer le secret |
| POST | `/api/scan` | Scan badge/QR (pointage intelligent) |

## Mot de passe admin
Par défaut : `admin` (modifiable via l'API)
