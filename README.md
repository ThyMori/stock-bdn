# Stock BdN

PWA de suivi du parc de projecteurs (remplace l'appli AppSheet). Hors ligne, scan de QR code, trois niveaux de droits.

**Stack** : TypeScript + Vite · Supabase (Postgres + Auth + règles RLS) · service worker (vite-plugin-pwa) · IndexedDB pour le cache hors ligne · GitHub Pages.

## Ce que fait l'appli

| | Lecteur | Technicien | Admin |
|---|:-:|:-:|:-:|
| Consulter le parc, les fiches, les pannes | ✅ | ✅ | ✅ |
| Scanner un QR / chercher un n° | ✅ | ✅ | ✅ |
| Signaler une panne | ✅ | ✅ | ✅ |
| Changer l'état (dispo / SAV / en prêt), résoudre une panne | | ✅ | ✅ |
| Imprimer les étiquettes QR | | ✅ | ✅ |
| Ajouter/modifier/supprimer projecteurs, modèles, lampes, référentiels ; gérer les rôles | | | ✅ |

Les droits sont appliqués **par la base** (RLS + fonctions SQL), pas seulement par l'interface.

**Hors ligne** : la liste complète est copiée sur l'appareil. Changements d'état et signalements de pannes sont enregistrés localement (⏳) et envoyés au retour du réseau. Chaque action a un identifiant unique : la rejouer ne la double jamais. En cas de conflit sur l'état d'un projecteur, l'action la plus récente gagne. Un historique de toutes les actions est conservé côté serveur.
L'ajout de projecteurs et l'édition du catalogue demandent une connexion.

## Mise en ligne, pas à pas

### 1. Supabase (base de données)
1. Crée un compte sur supabase.com → **New project** (région UE, ex. Paris/Francfort). Note le mot de passe de la base.
2. **SQL Editor → New query** : colle tout `supabase/schema.sql` → **Run**.
3. Même chose avec `supabase/seed.sql` (tes données AppSheet : 280 projecteurs, modèles, lampes, pannes).
   *Ce fichier contient des e-mails : il n'est volontairement pas dans le dépôt (`.gitignore`).*
4. **Authentication → Providers → Email** : laisse « Email » activé, **désactive « Allow new users to sign up »** (accès sur invitation uniquement).
5. **Authentication → URL Configuration** : *Site URL* = l'adresse finale de l'appli (étape 3 ci-dessous), ex. `https://TON-COMPTE.github.io/stock-bdn/`.
6. **Authentication → Users → Add user → Create new user** : crée ton compte (e-mail + mot de passe, coche « Auto Confirm »). **Le premier compte créé devient automatiquement administrateur.**
7. **Project Settings → API** : copie *Project URL* et la clé *anon public*.

### 2. GitHub
1. Crée un dépôt (ex. `stock-bdn`) et pousse ce dossier dessus (branche `main`).
2. **Settings → Secrets and variables → Actions → onglet Variables** : ajoute
   `VITE_SUPABASE_URL` et `VITE_SUPABASE_ANON_KEY` (les valeurs de l'étape 1.7 ; la clé anon est publique par conception).
3. **Settings → Pages → Build and deployment → Source : GitHub Actions**.
4. Le push déclenche le workflow (onglet *Actions*) ; au bout d'une minute l'appli est sur `https://TON-COMPTE.github.io/stock-bdn/`.

### 3. Sur les téléphones
Ouvrir l'adresse → se connecter → *Partager / Menu ⋮ → Ajouter à l'écran d'accueil*. Ouvrir l'appli une fois en ligne pour charger les données avant de partir en tournée.

### 4. Inviter des collègues
Supabase → **Authentication → Users → Invite user**. La personne reçoit un lien, choisit son mot de passe, et arrive avec le rôle *Lecteur*. Dans l'appli : **Plus → Administration → Utilisateurs** pour la passer *Technicien* ou *Admin*.

### 5. Étiquettes
**Plus → Étiquettes QR** : choisis la plage de numéros, imprime. Le QR contient l'adresse de l'appli + le numéro, donc l'appareil photo du téléphone ouvre directement la fiche. Le scanner intégré lit aussi un QR qui contiendrait seulement le numéro (anciens stickers).

## Développement local
```bash
npm install
cp .env.example .env     # puis renseigner l'URL et la clé Supabase
npm run dev              # http://localhost:5173
npm test                 # tests de la logique (scan, file d'attente hors ligne, erreurs réseau)
npm run build            # contrôle de types + build de production
```

## Refaire la migration depuis un export AppSheet
```bash
pip install pandas odfpy openpyxl
python3 scripts/ods_to_seed.py Stock_BdN.ods supabase/seed.sql
```
Les identifiants AppSheet sont conservés. Le projecteur d'essai (n° 0, `IsTest`) est ignoré. Non repris : l'onglet « Stickers » (simple suite de numéros), « recherche » (état interne d'AppSheet), « fil des nouveautés ».

## Sauvegarde
Plan gratuit Supabase : pas de sauvegarde automatique et mise en pause après ~1 semaine sans activité. Pour un usage pro : plan Pro (sauvegardes quotidiennes) ou export régulier (`pg_dump` / Table Editor → Export CSV).
