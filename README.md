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

Chaque projecteur a un agenda : frise sur 3 mois (mois précédent, courant et suivant) (vert = libre, jaune = prêt, rouge = SAV, hachuré = à venir, flèche = sans date de fin) et liste détaillée.
- Passer un projecteur **En prêt** demande : à qui, date du prêt, retour prévu (facultatif), remarque. Passer en **SAV** : motif, début, fin prévue (facultative). Repasser **Disponible** clôt la période en cours. Fonctionne hors ligne.
- Un régisseur général peut **planifier** un prêt futur, ajouter une période passée ou corriger une date (en ligne uniquement ; ne change pas l'état courant).
- Un prêt dont le retour prévu est dépassé est signalé « en retard » (fiche et liste).

## Spectacles

Onglet « Spectacles » : catalogue des spectacles (nom, dates de début et de fin, note).

- **Créer / modifier / supprimer** un spectacle : régisseur général et admin.
- **Assigner des projecteurs** : régisseur et au-dessus, par lot (sélection dans la liste avec filtres par type, ou scan QR en continu) ou depuis la fiche d'un projecteur.
- **PAR** : la lampe requise (CP60, CP61, CP62, CP95) se précise à l'assignation ; la fiche du spectacle signale si la lampe montée diffère.
- **État « Utilisé »** (vert hachuré de bleu) : calculé, un projecteur disponible assigné à un spectacle en cours. SAV et prêt restent prioritaires.
- Un projecteur ne peut pas être assigné à deux spectacles qui se chevauchent, ni pendant un prêt ou un SAV (même sans date de fin).
- Les actions sur les spectacles demandent une connexion.

### Calendrier et régisseurs assignés (v1.1)

- Dans l'onglet « Spectacles », les boutons **Liste / Mois / Semaine** affichent les spectacles sur un calendrier. Chacun voit tous les spectacles ; ceux sur lesquels il ne peut pas agir sont **grisés**.
- Un **régisseur général** (ou admin) assigne un ou plusieurs régisseurs à un spectacle depuis sa fiche, et peut leur envoyer une **invitation par mail** : l'appli ouvre ton client mail avec le message prêt (destinataire, lien vers le spectacle). Aucun service d'envoi à configurer ; il faut appuyer sur « Envoyer » dans ton client mail.
- Un **régisseur** ne peut assigner ou retirer des projecteurs que sur les spectacles où il est assigné (règle appliquée côté base). Régisseurs généraux et admins agissent sur tous les spectacles.

### Assignation automatique (v1.9)
Un spectacle exprime des **demandes** (modèle + lampe pour les PAR + quantité) ; la base choisit les projecteurs (`reallocate_all`, déclenché par les changements d'état, de lampe, de pannes, de prêts/SAV, de dates et de demandes). Règles : on préfère les PAR déjà montés avec la bonne lampe, puis ceux à relamper ; on évite les projecteurs indisponibles (SAV/prêt aux dates du spectacle, panne ouverte, autre spectacle aux mêmes dates) ; en cas de chevauchement, le spectacle qui commence le plus tôt est prioritaire. **Changer** remplace un projecteur automatique par un autre du même modèle (le choix est « épinglé » et gardé ; **Auto** le rend à l'automatique ; ses gels suivent). « Choisir à la main » (ancien mode) reste disponible. Si la demande ne peut pas être satisfaite (`show_demands.missing`) ou si un projecteur assigné devient indisponible (`show_items.problem`), une **alerte rouge** clignotante s'affiche en haut de l'appli, sur la fiche et la liste des spectacles, et dans le PDF de prépa. Tables/fonctions : `show_demands`, `set_demand`, `swap_show_item`, `release_show_item`.

### Prêts et locations (v1.10)
Quand une demande ne peut pas être satisfaite, le bouton **Gérer** propose « Prêté par… » ou « Loué chez… » (nom, quantité, dates de livraison et de reprise). Chaque prêt/location est une fiche (`show_externals`) qui comble automatiquement le manque (l'alerte rouge disparaît), s'affiche en bleu sur la fiche, sous forme de rappel bleu dans le calendrier (« 4 × PAR64 loués chez X · jusqu'au 20/11 »), dans le PDF de prépa et dans le rapport de démontage (section « À rendre »). Pas de projecteur fictif dans le parc. RPC `add_external` / `delete_external`.

### Rapport de démontage (v1.8)
Bouton **Rapport de démontage** sur la page d'un spectacle : on choisit le prochain spectacle, l'appli compare les deux listes et génère un PDF : **à préparer** (prévus pour la suite, absents du spectacle en cours), **à conserver** (dans les deux ; pour les PAR, « CHANGER : CP60 > CP62 » en rouge si la lampe diffère ou « à préciser » si la suite ne l'indique pas) et **à ranger** (présents, absents du suivant). Les gélatines sont ignorées. Calcul côté client (`src/teardown.ts`), aucun changement en base.

### Gélatines (v1.7)
Chaque projecteur d'un spectacle peut recevoir **plusieurs gels** (référence libre ; la couleur du badge est déduite de la référence : L201 / LEE 201 = Lee, R80 / #80 = Rosco, sinon « Autre »). On les pose à l'assignation (champ facultatif appliqué à tout le lot) ou avec le bouton **Gel** de la ligne ; la croix du badge le retire. Le format est déduit de la taille du porte-filtre du modèle. Droits : les mêmes que pour assigner (régisseur assigné, RG+). Les gels disparaissent quand le projecteur quitte le spectacle. Le PDF de prépa les liste à la fin, par format de projecteur (PAR64, 613 SX / 614 SX… : les modèles de même porte-filtre sont regroupés) puis couleur, avec la quantité (RPC `add_gels` / `delete_gel`, table `show_gels`).

### Liste de prépa en PDF (v1.6)

Sur la fiche d'un spectacle, **« Générer la liste de prépa »** télécharge un PDF A4 : titre, dates, régie, récapitulatif par type, puis les projecteurs **classés par type** (n°, modèle, case à cocher « préparé »). Pour les **PAR**, la lampe requise figure en gras, avec « montée : CPxx » si la lampe actuellement montée est différente, et « EN SAV » le cas échéant. Le PDF est fabriqué dans l'appli (aucun envoi de données) ; la bibliothèque n'est chargée qu'au premier clic.

### Mur global (v1.5)

L'onglet **Mur** réunit les messages de tous les spectacles, du plus récent au plus ancien. Dans la marge de chaque message, une bande de la **couleur du spectacle** avec son **nom** (un appui ouvre le spectacle). Un menu permet de ne voir qu'un seul spectacle. Les messages qui te citent sont encadrés. La lecture seule : pour écrire, on passe par le mur du spectacle.

### Mon profil (v1.4)

Dans l'onglet **Plus**, « Modifier mon nom » permet à chacun de changer son prénom et son nom (connexion requise). Les signatures du mur et le nom dans la liste des régisseurs d'un spectacle suivent ; l'historique (journal, pannes passées) garde le nom d'époque. Le rôle et l'e-mail ne se changent pas ici.

### Mur du spectacle (v1.3)

Chaque spectacle a un **mur** (juste sous son en-tête) où tout le monde, dès le rôle technicien, peut écrire : to-do, passation de régie, planning, changements d'horaires, problèmes techniques, dézonage fumée…

- Chaque message est **signé** et porte la **couleur de son auteur** (une couleur par personne, stable). Les plus récents sont en haut.
- On peut **modifier ou effacer ses propres messages** ; un administrateur peut aussi effacer n'importe quel message (modération).
- **Citer une personne** (`@ Citer une personne`) : son nom s'affiche en pastille de couleur et le message porte « te cite » pour elle. **Citer un projecteur** (`# Citer un projecteur`, ou taper `#219`) : lien vers sa fiche, et le message apparaît aussi sur la fiche du projecteur (« Cité sur les murs »).
- Lecture et écriture demandent une connexion ; le brouillon n'est jamais perdu quand l'écran se rafraîchit.

### Changement rapide de lampe (v1.2)

Sur la fiche d'un **PAR**, quatre boutons **CP62 · CP61 · CP60 · CP95** changent la lampe d'un seul geste, dès le rôle technicien. Le changement passe par la file hors ligne (comme les états) et est journalisé (« #12 : lampe CP60 → CP62 »). Sur la fiche d'un spectacle, quand la lampe montée diffère de la lampe requise, le bouton « passer en CPxx » la corrige directement.

### Couleurs des spectacles (v1.1.1)

Chaque spectacle a une couleur (palette de 10). Elle est attribuée **automatiquement** à la création, de façon que deux spectacles qui se suivent ou se chevauchent n'aient jamais la même. Un régisseur général peut la changer dans « Modifier » ; une couleur déjà prise par le spectacle précédent, suivant ou concomitant est refusée. Si un changement de dates crée un conflit, la couleur est recalculée.

## Journal d'activité et pastille « update en cours »

- **Journal** (admin) : Plus → Journal. Fenêtre type terminal, en direct (Supabase Realtime, repli toutes les 10 s) : changements d'état, pannes (déclarée, info, modification, résolue), projecteurs créés/modifiés/supprimés, catalogue, comptes (invitation, rôle, accès, nom), connexions. Les lignes se sélectionnent et se suppriment ; la suppression laisse une ligne « JOURNAL ». Les imports faits depuis l'éditeur SQL ne génèrent pas de lignes.
- **`src/flags.ts`** : `UPDATE_PENDING = true` affiche une pastille rouge « update en cours » dans l'appli pendant qu'une mise à jour Supabase est à faire. Repasser à `false` une fois les requêtes exécutées.
