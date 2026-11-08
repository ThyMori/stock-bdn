# Stock BdN

PWA de suivi du parc de projecteurs (remplace l'appli AppSheet). Hors ligne, scan de QR code, quatre niveaux de droits.

**Stack** : TypeScript + Vite · Supabase (Postgres + Auth + règles RLS) · service worker (vite-plugin-pwa) · IndexedDB pour le cache hors ligne · GitHub Pages.

## Ce que fait l'appli

| | Technicien | Régisseur | Régisseur général | Admin |
|---|:-:|:-:|:-:|:-:|
| Consulter le parc, les fiches, les pannes, scanner un QR | ✅ | ✅ | ✅ | ✅ |
| Déclarer une panne | ✅ | ✅ | ✅ | ✅ |
| Ajouter une info à une panne | ✅ | ✅ | ✅ | ✅ |
| Modifier la description d'une panne | ses propres pannes | ✅ | ✅ | ✅ |
| Déclarer une panne résolue | | ✅ | ✅ | ✅ |
| Changer l'état d'un projecteur (prêt / SAV / OK) | | | ✅ | ✅ |
| Créer des projecteurs, imprimer les étiquettes QR | | | ✅ | ✅ |
| Inviter des utilisateurs (prénom, nom, e-mail, rôle), changer leur nom et leur rôle, révoquer / rétablir leur accès | | | ✅ (techniciens et régisseurs uniquement) | ✅ (tous) |
| Consulter / purger le journal d'activité (Plus → Journal) | | | | ✅ |
| Modifier / supprimer un projecteur, éditer modèles, lampes, référentiels | | | | ✅ |

Les droits sont appliqués **par la base** (RLS + fonctions SQL), pas seulement par l'interface. Un accès révoqué est coupé au niveau de la base.

**Hors ligne** : la liste complète est copiée sur l'appareil. Changements d'état et signalements de pannes sont enregistrés localement (⏳) et envoyés au retour du réseau. Chaque action a un identifiant unique : la rejouer ne la double jamais. En cas de conflit sur l'état d'un projecteur, l'action la plus récente gagne. Un historique de toutes les actions est conservé côté serveur. Chaque panne a sa fiche : déclarée par qui et quand, infos ajoutées, modifications de description (avec l'ancien texte), résolue par qui et quand.
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

### 4. Gérer les utilisateurs depuis l'appli (une seule fois : déployer la fonction)
Inviter et révoquer demandent la clé secrète de Supabase, qui ne doit jamais être dans l'appli. Elle reste dans une **fonction serveur** (`supabase/functions/admin-users`) :

1. **Rejouer `supabase/schema.sql`** dans le SQL Editor (le script est rejouable, il ajoute le champ « accès actif » et la protection du dernier administrateur sans toucher aux données).
2. Supabase → **Edge Functions → Deploy a new function → Via Editor** : nom **`admin-users`**, colle le contenu de `supabase/functions/admin-users/index.ts`, **Deploy**.
3. Ouvre cette fonction → **Details** (ou *Settings*) et **désactive « Verify JWT »** s'il est activé : la fonction vérifie elle-même l'identité et le rôle de l'appelant à chaque appel.
   *(Avec la CLI : `supabase functions deploy admin-users --no-verify-jwt`.)*
4. Dans **Authentication → URL Configuration**, vérifie que *Site URL* et *Redirect URLs* contiennent l'adresse de l'appli (sinon le lien de l'e-mail d'invitation ne fonctionnera pas).

Ensuite, dans l'appli : **Plus → Administration → Utilisateurs**.
- **Inviter** : e-mail + rôle → la personne reçoit un e-mail, choisit son mot de passe et arrive dans l'appli. *Renvoyer l'invitation* tant qu'elle n'a pas activé son compte.
- **Révoquer l'accès** : coupe immédiatement les droits dans la base (même si la personne a une session ouverte) et interdit toute nouvelle connexion. Le compte et l'historique sont conservés. Son appli se vide et se déconnecte à la prochaine synchronisation. **Rétablir l'accès** annule tout.
- Hiérarchie : un régisseur général ne gère que les comptes de rang inférieur (technicien, régisseur) et ne peut attribuer que ces rôles ; seul un administrateur crée ou modifie un régisseur général ou un admin.
- Garde-fous : on ne peut pas modifier son propre accès ni son propre rôle, et il reste toujours au moins un administrateur actif.

*Sans la fonction, tout le reste de l'appli fonctionne ; seule la liste des utilisateurs affichera « fonction non déployée ». On peut aussi inviter depuis Supabase (Authentication → Users → Invite user).*

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

## Agenda des projecteurs (immobilisations)

Chaque projecteur a un agenda : frise sur 6 mois (vert = libre, jaune = prêt, rouge = SAV, hachuré = à venir, flèche = sans date de fin) et liste détaillée.
- Passer un projecteur **En prêt** demande : à qui, date du prêt, retour prévu (facultatif), remarque. Passer en **SAV** : motif, début, fin prévue (facultative). Repasser **Disponible** clôt la période en cours. Fonctionne hors ligne.
- Un régisseur général peut **planifier** un prêt futur, ajouter une période passée ou corriger une date (en ligne uniquement ; ne change pas l'état courant).
- Un prêt dont le retour prévu est dépassé est signalé « en retard » (fiche et liste).

## Journal d'activité et pastille « update en cours »

- **Journal** (admin) : Plus → Journal. Fenêtre type terminal, en direct (Supabase Realtime, repli toutes les 10 s) : changements d'état, pannes (déclarée, info, modification, résolue), projecteurs créés/modifiés/supprimés, catalogue, comptes (invitation, rôle, accès, nom), connexions. Les lignes se sélectionnent et se suppriment ; la suppression laisse une ligne « JOURNAL ». Les imports faits depuis l'éditeur SQL ne génèrent pas de lignes.
- **`src/flags.ts`** : `UPDATE_PENDING = true` affiche une pastille rouge « update en cours » dans l'appli pendant qu'une mise à jour Supabase est à faire. Repasser à `false` une fois les requêtes exécutées.
