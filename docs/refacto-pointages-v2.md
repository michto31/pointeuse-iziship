# Refacto pointages V2 — simplification radicale

## Objectif

Passer d'un modèle 4 actions (arrival/break_start/break_end/departure) à un modèle 1 scan = 1 timestamp neutre. Côté employé : zéro question à se poser. Côté admin : richesse maximale via interprétation des paires de scans.

## Spec

### Côté employé (borne RFID + mobile PIN)
- Un seul bouton/action : "Pointer"
- Affichage neutre : "Pointage enregistré à HH:MM"
- L'employé ne voit jamais les mots "pause", "départ", "arrivée"
- État interne idle ↔ at_work qui bascule à chaque scan

### Côté admin (rapport)
- Lecture des scans triés par heure pour chaque jour, par worker
- Si nombre PAIR : (premier=arrival, dernier=departure, paires intermédiaires=pauses)
- Si nombre IMPAIR : auto-clôture à sched_out + forfait 1h appliqué
- Vue rapport :
  - Compacte par défaut : Brut / Pauses / Net
  - Drill-down au clic : timeline complète des pointages

### Calcul temps payé (formule unifiée)
- brut = dernier_scan - premier_scan
- pauses_badgees = somme(scan[2k+1] - scan[2k]) pour k=1..n
- net = brut - pauses_badgees - (1h si pauses_badgees == 0 else 0)
- max(0, net)

### Cas d'usage
- 4 scans (9h, 12h, 13h30, 17h) → brut 8h - pause 1h30 = 6h30 net (pas de forfait, pause badgée)
- 2 scans (9h, 17h) → brut 8h - forfait 1h = 7h net
- 1 scan (9h, oubli) → auto-clôture à sched_out 17h - forfait 1h = 7h net + flag "auto-clos" dans rapport

## Impacts techniques

### Code à refacto
- borne : retirer borneDecideAction, simplifier état borne, neutraliser le label des actions
- /api/clock : remplacer state machine 4 actions par bascule idle↔at_work
- /api/auth/rfid : la réponse n'a plus besoin de sched_out
- closeOrphanPointages : adapter à la nouvelle logique (auto-close à sched_out, pas arrival+8h)
- Mobile UI (punch screen) : remplacer les 4 boutons par 1 seul
- Rapport admin : refacto complète du calcul (lit la liste de scans, applique formule)

### Schéma DB
- Option 1 : garder records.arrival/departure/breaks tel quel, ne plus écrire dans breaks
- Option 2 : nouvelle table flat punches (worker_id, date, time, station_id) + view de compatibilité
- Recommandation : Option 1 pour ce ticket, Option 2 plus tard si besoin de propreté

### Rétro-compatibilité
- Les records historiques avec breaks JSONB rempli : le nouveau rapport doit savoir les lire (lire breaks et les ajouter aux pauses détectées)
- Migration one-shot : UPDATE workers SET last_clock_state='at_work' WHERE last_clock_state='on_break' (l'état on_break n'existe plus)

## À discuter avant code
- Confirmer : Option 1 ou 2 sur le schéma
- Confirmer : on supprime les actions break_start/break_end côté API (legacy à retirer) ou on les garde pour rétrocompat avec d'éventuels intégrations futures ?
- Tester avec données réelles d'Aymen et Melyne avant déploiement

## Estimation
- 2-3 heures de dev concentré
- 1 heure de tests prod

## Ne PAS faire
- Toucher au schéma security_events (audit trail reste intact)
- Casser le flux d'enrôlement RFID (étape 2)
- Faire ce refacto en pleine semaine de production sans backup DB
