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

### Assignation automatique (v1.9) — remplacée par la v1.46.0 (objectifs de quantité)
Un spectacle exprime des **demandes** (modèle + lampe pour les PAR + quantité) ; la base choisit les projecteurs (`reallocate_all`, déclenché par les changements d'état, de lampe, de pannes, de prêts/SAV, de dates et de demandes). Règles : on préfère les PAR déjà montés avec la bonne lampe, puis ceux à relamper ; on évite les projecteurs indisponibles (SAV/prêt aux dates du spectacle, panne ouverte, autre spectacle aux mêmes dates) ; en cas de chevauchement, le spectacle qui commence le plus tôt est prioritaire. **Changer** remplace un projecteur automatique par un autre du même modèle (le choix est « épinglé » et gardé ; **Auto** le rend à l'automatique ; ses gels suivent). « Choisir à la main » (ancien mode) reste disponible. Si la demande ne peut pas être satisfaite (`show_demands.missing`) ou si un projecteur assigné devient indisponible (`show_items.problem`), une **alerte rouge** clignotante s'affiche en haut de l'appli, sur la fiche et la liste des spectacles, et dans le PDF de prépa. Tables/fonctions : `show_demands`, `set_demand`, `swap_show_item`, `release_show_item`.

### En-tête toujours visible (v1.22.6)
Le titre « Stock BdN », la pastille « en ligne », « À jour » (et la liste des personnes en ligne quand elle est ouverte) et le bandeau du spectacle en cours restent collés en haut de l'écran pendant le défilement. Les autres bandeaux (alerte matériel, installation, notifications) défilent normalement.

### Affecter manuellement (v1.22.5)
Le bouton s'appelle « + Affecter manuellement » et la fenêtre « Ajouter des projecteurs » s'ouvre en haut de la liste « Projecteurs affectés » (dans la même carte), avec défilement jusqu'à elle.

### Étiquettes QR imprimées et zoom (v1.22.4)
- Impression des étiquettes : plus aucun bandeau (spectacle en cours, installation, mise à jour) ; le lien de l'appli (cliquable) est en en-tête.
- Zoom désactivé (`user-scalable=no`, `touch-action: pan-x pan-y`, blocage du pincement iOS). Réglage à connaître : Firefox Android peut le réactiver si « Toujours activer le zoom » est coché dans ses réglages d'accessibilité.

### Lampe pré-sélectionnée à l'ajout de PAR (v1.22.2)
Quand un lot contient un PAR (scan, saisie d'un n° ou liste), la lampe actuellement montée est pré-sélectionnée dans « Lampe requise » (modifiable) et rappelée sous la liste. À chaque PAR ajouté, sa lampe montée remplace le choix précédent (v1.22.3) ; si le lot mélange plusieurs lampes montées, un avertissement les liste.

### Fiche de spectacle : replis et texte jamais masqué (v1.22.1)
« Projecteurs affectés » (ex-« Projecteurs ») et « Matériel demandé » sont repliés à l'ouverture de la fiche (état non mémorisé) ; repliés, ils gardent leurs étiquettes d'alerte (« N indisponibles », « manque N »). Sur téléphone, les boutons Gel / Changer / Retirer passent sous le texte de chaque projecteur au lieu de le recouvrir.

### Fiche de spectacle : zones distinctes (v1.22.0)
Ordre : Mur, Régisseurs, **Projecteurs** (étiquette « manuel »), puis **Matériel demandé** (étiquette « auto », cadre en pointillés, repliable d'un appui sur son titre ; replié, il garde l'étiquette « manque N »). Chaque zone a un liseré de couleur en haut. Les types de projecteurs portent le libellé « Filtre : » (liste des projecteurs et sélecteur d'ajout).

### Fiche de spectacle : Régisseurs en dernier (v1.45.11)
Ordre actuel des zones : Mur (replié), **Projecteurs**, **Matériel demandé**, puis **Régisseurs** en dernier. (Remplace l'ordre de la v1.22.0.) Aucun changement Supabase.

### Mur repliable sur la fiche d'un spectacle (v1.45.10)
Le mur est **replié au départ** : titre « Mur (n) » + seulement le dernier message. Toucher le titre déplie : zone d'écriture + tous les messages. Pas mémorisé (replié à chaque ouverture) ; le brouillon en cours n'est pas perdu en repliant. Aucun changement Supabase.

### Substitution d'un modèle (v1.47.0)
Sur une demande qui manque : **Gérer → Substitution : un autre modèle**. On choisit le modèle de remplacement (les modèles **similaires** d'abord — liste `SIMILAR` de `src/patchSuggest.ts`, la même que pour les suggestions du patch — puis les autres, avec le nombre de projecteurs « libres » : sans panne, SAV, prêt ni autre spectacle aux dates ; indicatif, il ne tient pas compte des objectifs des autres spectacles) et la quantité.
- Table `show_substitutions` (demande, modèle, quantité). La **demande d'origine ne change pas** : « 4 × 614 SX demandés, dont 2 par 614 S ».
- Calcul (`reallocate_all`) : les remplacés ne comptent plus dans le besoin du modèle d'origine ; ils comptent dans celui du modèle de remplacement, sur le stock partagé entre spectacles. Si le remplaçant manque à son tour, le manque **réapparaît sur la demande d'origine**.
- Plusieurs substitutions possibles par demande ; chacune se retire (« Suppr. »). Quantité au plus égale à ce qui reste à couvrir (demande − prêts / locations − substitutions) ; la demande ne peut pas baisser sous ce total. Supprimer la demande supprime ses substitutions.
- Les n° précis du modèle de remplacement s'affectent comme d'habitude (« Projecteurs affectés », patch) et comptent pour l'objectif.
- Fonctions `add_substitution`, `delete_substitution` ; droits : régisseur général, admin et régisseurs assignés (comme prêts / locations) ; une ligne au journal à l'ajout et au retrait ; pas de notification. Pas de dates (vaut pour tout le spectacle), pas de lampe pour un PAR.

### Matériel demandé = objectifs de quantité (v1.46.0)
**Changement de philosophie.** Une demande (modèle, lampe pour un PAR, quantité) est un **objectif**, pris par exemple sur une fiche technique ou un plan de feu. L'appli ne choisit plus aucun projecteur : les n° précis s'affectent à la main (« Projecteurs affectés », scan, feuille de patch). Cela remplace l'assignation automatique de la v1.9 et le « projecteur du patch = matériel demandé » de la v1.36.0.

Calcul du manque (SQL `reallocate_all`, rejoué à chaque panne, SAV, prêt, changement de dates, de demande ou d'affectation), **jour par jour** sur les spectacles en cours ou à venir :
- **Capacité** d'un modèle un jour donné = ses projecteurs sans panne ouverte et sans SAV / prêt ce jour-là (une panne n'a pas de date : le projecteur est exclu dès aujourd'hui).
- **Besoin** d'un spectacle pour un modèle = le plus grand de (quantités demandées non couvertes par prêts / locations) et (projecteurs déjà affectés).
- **Disponibles** pour un spectacle (`show_demands.available`) = capacité − besoins des *autres* spectacles du jour, au pire jour de ses dates. Le stock est donc partagé entre spectacles qui se chevauchent.
- **Manque** = besoin − disponibles, sans dépasser la quantité demandée moins les projecteurs affectés utilisables ; réparti sur les demandes du modèle (la dernière ajoutée d'abord). Il s'affiche sur chaque spectacle concerné (deux spectacles qui se disputent 4 projecteurs affichent chacun « manque 4 »).
- PAR : le compte se fait par modèle (la lampe reste une information). Spectacles passés ignorés.
- Affecter ou retirer un projecteur **ne modifie plus la demande**. Les lignes de patch « à louer / à emprunter » ajoutent toujours 1 à la demande (v1.37.0).
- Fiche du spectacle : chaque ligne montre « Demandé · Affectés · Disponibles » et « manque N » / « complet ». Disparus : étiquettes « auto » / « choisi », boutons « Changer » et « Auto » (fonctions `swap_show_item` et `release_show_item` supprimées).
- **Reprise de l'existant** (au rejeu du SQL) : les projecteurs choisis automatiquement deviennent des projecteurs affectés à la main (aucun n'est retiré) ; les demandes restent comme objectifs.
- Droits et notifications inchangés : régisseur général, admin et régisseurs assignés modifient les demandes (contrôle par la base).

### SAV + panne en une fois (v1.45.7)
Fiche d'un projecteur → « SAV » : le formulaire propose **« Déclarer aussi une panne ? »** (Oui par défaut ; motif « Réparation » proposé). Si Oui, la panne est créée en même temps (description saisie, sinon le motif du SAV, sinon « Passé en SAV »). Même mécanisme que le remplacement dans la feuille de patch. Fonctionne hors ligne (file d'attente). Aucun changement Supabase.

### Référentiels modifiables (v1.45.6)
Administration → Référentiels : chaque famille, type, douille et porte-filtre a un bouton **Modifier** (nom ; pour un porte-filtre, taille et nombre de feuilles LEE / Rosco), en plus d'Ajouter / Supprimer. L'identifiant ne change pas : le nouveau nom apparaît partout (modèles, projecteurs, feuilles de patch). Un nom déjà pris est refusé (« Ce nom existe déjà »). Modèles et lampes se modifiaient déjà. Aucun changement Supabase (la règle « admin seulement » existait).

### Journal : une couleur par personne (v1.45.5)
Dans le journal (Plus → Journal), le nom de chaque personne est dans une pastille colorée, en plus de la couleur par type d'action. Couleur déduite de l'identifiant du compte (`personColor`), donc **la même que sur les murs**. Deux personnes peuvent avoir des teintes proches (12 couleurs).

### Personnes en ligne, connexions et départs au journal (v1.21.0)
- **Pastille verte** en haut à droite, visible de tous les comptes : nombre de personnes en ligne ; un appui affiche leurs noms. « En ligne » = app ouverte et visible (un signe de vie par minute, `src/presence.ts`).
- **Journal (admins seulement)** : une ligne « connexion » à l'ouverture de l'app, une ligne « départ » quand la personne ne donne plus signe de vie depuis 5 min (heure du dernier signe de vie) ou se déconnecte. Une absence de moins de 5 minutes ne fait pas de bruit.
- Le départ est détecté au signe de vie suivant de n'importe qui (aucune tâche planifiée). Si plus personne n'ouvre l'app, il apparaît à la prochaine ouverture.
- Supabase : rejouer `supabase/schema.sql` (table `presence`, fonctions `presence_ping`, `presence_leave`, `online_users`, `log_login` remplacée). Aucune fonction serveur à redéployer.
- Calendrier : le spectacle en cours a un halo ; aujourd'hui est une colonne teintée avec le numéro sur pastille rouge.

### Calendrier glissant (v1.20.0)
Spectacles → « 4 semaines » remplace « Mois » : 1 semaine passée, la semaine en cours et 3 semaines à venir, qui glissent d'une semaine à chaque flèche (« Auj. » revient à aujourd'hui). Les spectacles terminés et les jours passés sont ternis ; le spectacle en cours est mis en emphase (contour + gras). Le mode « Semaine » reçoit le même traitement.

### Ordre des spectacles (v1.19.2)
Partout (liste des Spectacles, filtre du Mur, « Assigner à un spectacle », rapport de démontage) : en cours et à venir d'abord, le prochain en premier ; puis les terminés, du plus récent au plus ancien. Les terminés sont grisés et rayés (« (terminé) » dans les menus déroulants). Règle unique : `sortShows` dans `src/logic.ts`.

### Demande d'inscription (v1.19.0)
Sur l'écran de connexion, « Demander à s'inscrire » ouvre un formulaire (prénom, nom, e-mail, message facultatif). L'accès reste sur invitation.

| Qui | Droit |
|---|---|
| Personne sans compte | envoyer une demande (via la fonction `push-notify`, action `signup`) |
| Administrateur | voir les demandes (onglet Admin → Utilisateurs), **Inviter** (choix du rôle) ou **Refuser**, être notifié par push |
| Régisseur général et autres | rien |

- Anti-abus : une seule demande en attente par e-mail, 10 demandes par heure au maximum, champ piège pour les robots. Si l'adresse a déjà un compte, la personne reçoit la même réponse (on ne révèle pas qui a un compte) mais rien n'est enregistré.
- « Inviter » envoie l'invitation habituelle (`admin-users`) puis marque la demande « invitée » ; « Refuser » l'archive sans e-mail. Les deux sont inscrits au journal.
- **Supabase** : 1) rejouer `supabase/schema.sql` (table `signup_requests`, fonctions `create_signup_request` et `resolve_signup_request`) ; 2) redéployer la fonction `push-notify` (Verify JWT reste désactivé).

## Positions, pastille bleue et montage (v1.34.0)
- **Pastille bleue** (`items.blue_dot`) : projecteur stocké au **3e** quand il ne joue pas. Fiche + liste du parc (filtre « Stocké au 3e »). Journal : « PASTILLE ». Pas de notification.
- **Interrupteur monté / démonté** (`shows.mounted`, `mounted_at`) en haut d'un spectacle : en cours = figé monté ; avant : selon l'interrupteur ; après le dernier jour : démonté automatiquement (sauf forçage « monté » postérieur à la fin). Journal : « MONTAGE ».
- **Position actuelle** d'un projecteur (fiche) : PRÊT / SAV, sinon position de la feuille de patch du spectacle monté, sinon stock 3e (pastille) ou stock dessous. Logique dans `src/position.ts`.
- **Propositions d'ID** (feuille de patch) : 1) modèle (même, puis similaire) ; 2) disponible sur toute la durée ; 3) position qu'il avait dans le spectacle juste avant (sinon stock) : 3e balcon / 2e balcon / coupole → déjà là ou stock 3e d'abord ; Px / mezza / allemande / passerelle / sol / pont coupole → déjà là, puis dessous, puis 3e ; corbeille → déjà là, 3e, dessous ; 4) lampe des PAR.
- **Rapport de démontage** : à stocker dessous, à stocker au 3e, à garder en place, à déplacer, à monter (provenance), + infos lampes PAR et « À rendre ».
- **Liste de prépa** : sections stock dessous / stock 3e / déjà monté, accessoires et position prévue, prêts et locations en bleu (accessoires des lignes rattachées cumulés).
- **Droits** : voir = tout le monde ; pastille et interrupteur = régisseur général et admin (vérifié en base).
- Non repris : l'auto-répartition (`reallocate_all`) ignore les positions (les demandes n'en ont pas).

## Projecteur du patch = matériel demandé (v1.36.0) — remplacé par la v1.46.0
- Un projecteur mis dans la feuille de patch (ID du stock, « nouvel ID », remplacement) est **compté dans le matériel demandé** : la demande « modèle + lampe » monte de 1 (créée si absente), ou, si elle avait un manque, le projecteur le comble sans changer la quantité. Il y est épinglé.
- Remplacé par un autre modèle : l'ancienne demande baisse de 1, la nouvelle monte de 1. Même modèle : rien ne change.
- Retiré du spectacle depuis la feuille : la demande baisse de 1 (jamais sous les prêts / locations déjà saisis ; supprimée à 0).
- Reprise de l'existant : les projecteurs déjà affectés à la main aux spectacles en cours ou à venir rejoignent le matériel demandé (au rejeu du SQL).
- Droits et notifications inchangés (assignés au spectacle) ; le journal garde une ligne. L'alarme « manque » est celle du matériel demandé, recalculée tout de suite.

## Colonnes redimensionnables et PDF « cahier » (v1.38.0)
- **Largeur des colonnes** (ordinateur seulement, écran > 1000 px avec souris) : poignée au bord droit de chaque titre ; tirer change la largeur, **double-clic** = largeur automatique pour cette colonne. Mémorisé sur l'ordinateur (localStorage `stockbdn.patchcols`). Sur téléphone, rien ne change (circuit + modèle = 1/3 de l'écran). Code : `src/patchCols.ts`.
- **Largeur automatique selon les valeurs** (v1.38.2) : le titre d'une colonne ne l'élargit plus (il est tronqué s'il est trop long). Titres abrégés : c° (circuit), grad. (grada), acc. (accessoires) ; le nom complet reste en infobulle et pour les lecteurs d'écran.
- **PDF de la feuille de patch** : look feuille de cahier griffonnée (papier crème, lignes bleues = une ligne du tableau, double marge rouge, écriture manuscrite **Caveat** en bleu stylo, traits et cases tremblés, focus fait = coup de surligneur). Police libre SIL OFL (`src/assets/fonts/`), téléchargée seulement à la génération ; **hors ligne ou en cas d'échec, le PDF garde le même look avec la police normale**. Code : `src/patchPdf.ts`, `src/pdfFonts.ts`, `src/handwriting.ts`. Les autres PDF (prépa, démontage, étiquettes QR) restent sobres.

## Repartir d'un autre spectacle, effacer circuits / gels (v1.43.0)
- **Fiche spectacle > « Utiliser le matériel d'un autre spectacle »** (régisseur général et admin seulement, contrôlé par la base) : recopie les projecteurs **assignés** du spectacle choisi (tous les spectacles, passés ou futurs) avec la lampe des PAR. Pas recopiés : matériel demandé, locations, prêts, lignes de patch N/C. Questions posées : garder les circuits (oui/non), garder les gélatines et accessoires (oui/non). La grada, la courbe, le DMX, la position et les notes sont toujours recopiées ; « focus fait » repart à zéro. Si le spectacle a déjà du matériel : alerte et choix **Compléter** (ajoute, l'existant n'est pas touché) ou **Remplacer** (retire d'abord les projecteurs et lignes de projecteur déjà là ; lignes N/C, locations et demandes restent). Un projecteur indisponible aux dates (autre spectacle, SAV, prêt) est sauté et listé. Fonction SQL `show_copy_from`.
- **Feuille de patch > « Effacer les circuits »** (gradas conservées) et **« Effacer les gels et accessoires »** : régisseur assigné, régisseur général, admin (technicien : non). Confirmation avant. Fonctions `patch_clear_circuits`, `patch_clear_gels_acc`.
- Tout est inscrit au journal d'activité et demande une connexion.

## Liste de prépa : refonte (v1.41.0)
Le PDF de prépa (page du spectacle) est organisé ainsi : **À préparer** (projecteurs à sortir du stock, un groupe par modèle, stock dessous avant stock 3e) ; **Présents sur le spectacle précédent** (déjà en place, à part, avec leur position actuelle et leur stockage normal dessous / 3e) ; **Prêts et locations** ; **Gélatines à couper** (d'abord par référence : Lee avant Rosco, puis par numéro ; sous chaque référence, les formats / modèles de projecteur avec leur quantité ; lignes sans projecteur comprises ; une case à cocher par référence = rouleau sorti) ; **Accessoires à préparer** (par modèle, avec les numéros de projecteurs, issus de la feuille de patch). Code : `prepSections` dans `src/prepPdf.ts`.

## PDF de la feuille de patch : 5 choix (v1.40.0, revu en v1.42.0)
Le bouton **PDF** demande d'abord quoi imprimer : **Comme à l'écran** (ordre affiché) ; **Circuit -> Grada** (classée par circuits) ; **Grada -> Circuits** (classée par grada, colonne grada en premier) ; **Par position** (zone en titre, position précise en sous-titre, projecteurs classés par ID, lignes N/C à la fin, puis « Sans position ») ; **Toutes** (les 4 précédentes dans un seul PDF). Les gélatines à couper et les accessoires ne sont plus dans ce PDF : ils sont dans la liste de prépa. Police : manuscrite pour les titres et sous-titres, Helvetica (lisible) pour les informations de dernier niveau. Code : `src/patchPdf.ts` (mise en page), `src/patchLists.ts` (zones > positions, accessoires, testés).

## Positions par zone (v1.39.0)
La liste « Position » de la feuille de patch est classée en 4 zones : **Cintres** (P0 à P10, allemande J / C), **Cage de scène** (passerelle J / C, mezza J / C), **FOH** (corbeille, 2e balcon, 3e balcon), **Autres** (pont coupole, sol, coupole, autre). Renommages : `balcon` → `2e balcon`, `3e` → `3e balcon` (les lignes existantes sont converties par le SQL). Nouveau : `P0`. « Stock 3e » (pastille bleue) reste le nom du stock, pas d'une position. Code : `POSITION_GROUPS` dans `src/patch.ts`.

## Ligne « à louer / à emprunter » (v1.37.0)
- Sur une ligne sans ID : modèle **« Location / prêt… »** → 2e liste → **« + À louer / à emprunter… »** → on choisit le modèle (et la lampe d'un PAR). La demande de matériel monte de 1 : si le stock ne suffit pas, le **manque** déclenche l'alarme habituelle ; sinon un projecteur du stock est réservé par la demande.
- Seules ces lignes comptent : le matériel du décor ou de la Cie (lignes normales, texte libre) n'entre jamais dans le matériel demandé.
- Le besoin disparaît (demande −1) si la ligne change de modèle, est supprimée, prend un vrai ID, ou se rattache à une location d'une autre demande. Rattachée à une location de la même demande : la quantité reste, la location couvre le besoin.
- Colonne `patch_lines.need_demand_id`, fonction `patch_need_set`.

## Feuille de patch : clavier (v1.35.5)
**Tab** = colonne suivante (ordre normal du navigateur) ; **Entrée** = enregistre et descend au même champ de la ligne suivante (contenu sélectionné) ; sur la dernière ligne, Entrée valide et ferme le clavier. L'ordre des lignes ne bouge pas pendant la saisie. Le curseur n'est plus perdu quand une ligne est redessinée (courbe, modèle).

## Rapport de démontage : gélatines et accessoires (v1.45.0)
Le rapport de démontage / remontage se termine par les sections **Gélatines à couper** et **Accessoires à préparer** du **spectacle suivant** (les mêmes que dans la liste de prépa, partagées via `drawGelSection` / `drawAccessorySection` dans `src/prepPdf.ts`). Elles n'apparaissent que si le spectacle suivant a des gélatines ou des accessoires.

## Colonne « État » (v1.44.0)
La colonne Focus est remplacée par **État** (rond) : vide par défaut ; **clic** = vert (fait), clic de nouveau = vide ; **double clic** = rouge (à faire) + fenêtre pour noter ce qu'il y a à faire (annuler = rien ne change) ; **clic sur un rouge** = bulle avec la note (au survol aussi sur ordinateur ; « Modifier la note » dans la bulle) ; **double clic sur un rouge** = vide (la note est effacée). Le simple clic est appliqué après 0,28 s, le temps de voir si un second clic suit ; au clavier, Entrée = cocher / décocher, Maj + Entrée = à faire. Note de 300 caractères au plus. Mêmes droits que l'ancienne case Focus (régisseur assigné, RG, admin) ; les autres peuvent lire les notes. Tri : « à faire » d'abord, puis « fait ». En-tête : « 3 faits · 2 à faire ». PDF : coche verte / croix rouge, ligne surlignée (vert / rose), note numérotée en bas de la page. Base : colonnes `patch_lines.state` et `state_note` (les anciens « focus fait » deviennent verts à la migration) ; `focus` reste synchronisé pour les anciens appareils.

## Feuille de patch / focus (v1.23.0, complétée jusqu'en v1.30.0)

Bouton bleu « Patch / Focus » dans l'en-tête d'une fiche de spectacle (`#/patch/<id>`). Une ligne par projecteur affecté, plus les lignes « sans projecteur » (N/C : prêté, loué, autre). Colonnes : circuit, grada, courbe (un seul choix : Linéaire par défaut, Off/On, Autre, DIRECT), DMX (seulement si DIRECT, `univers-adresse`), ID, modèle (lampe pour les PAR), gélatines, accessoires, position, focus, notes. Clic sur un en-tête = tri (vides toujours en dernier). Enregistrement automatique ; hors ligne = lecture seule.

| Qui | Droit sur la feuille |
|---|---|
| Technicien, régisseur non affecté au spectacle | voir ; modifier **grada**, **courbe** et **gélatines** |
| Régisseur du spectacle, RG, admin | tout : colonnes, cellule ID, ajout / suppression de lignes |

**Cellule ID** (régisseur du spectacle, RG, admin). Liste d'une ligne avec projecteur : noID, « Ajouter un projecteur du stock… » (fenêtre avec recherche), puis les ID du spectacle. Liste d'une ligne sans projecteur (et d'une ligne qu'on vient d'ajouter) : noID, ou directement les ID des projecteurs du stock disponibles aux dates du spectacle et pas encore affectés. Le bouton « + Ajouter une ligne » est au-dessus du tableau. Toutes les listes d'ID proposent aussi **« Scanner un QR code… »** (la caméra démarre seule) : un projecteur déjà dans le spectacle prend la place de celui de la ligne, un projecteur du stock disponible est ajouté ; la fenêtre ⇄ permet aussi de scanner.

| Geste | Effet sur la ligne | Le projecteur d'avant |
|---|---|---|
| Choisir un ID déjà affecté | la ligne prend ce projecteur | les deux lignes échangent leurs projecteurs |
| noID | la ligne devient « sans projecteur » (texte libre pour le modèle) | reste affecté, sur une ligne vide |
| Ajouter un projecteur du stock | la ligne prend un projecteur ajouté au spectacle (mêmes vérifications que l'affectation : dates, prêt, SAV, panne ; lampe montée des PAR) | reste affecté, sur une ligne vide |
| ⇄ | la ligne prend un projecteur du stock (changement de type possible) | retiré du spectacle ; proposition de déclarer une panne |

- **Les gélatines appartiennent à la ligne (au circuit)** : elles suivent la ligne quand on échange, ajoute, remplace un ID ou passe en noID, et la liste « Projecteurs affectés » de la fiche du spectacle est mise à jour. Une ligne sans projecteur porte ses propres gélatines (colonne `patch_lines.gels`) ; elles passent au projecteur quand la ligne en reçoit un. Elles ne figurent pas dans la liste de prépa (pas de projecteur à équiper).
- Un projecteur issu d'une demande de matériel ne peut être remplacé que par le même modèle et ne peut pas être retiré d'ici (change la demande sur la fiche du spectacle).
- Supprimer une ligne : ligne N/C = elle disparaît ; ligne d'un projecteur = on la vide, avec le choix de retirer aussi le projecteur des projecteurs affectés.
- Base : table `patch_lines` (écriture uniquement par fonctions), fonctions `set_patch_field`, `patch_set_item`, `patch_add_line`, `patch_delete_line`, `patch_add_gel`, `patch_delete_gel`.
- **Supabase** : rejouer `supabase/schema.sql` (aucune fonction Edge à redéployer).
- **PDF (v1.26.0)** : bouton « PDF » au-dessus du tableau. A4 paysage, lien de l'appli en en-tête, dans l'ordre affiché à l'écran. Chaque page porte la date et l'heure de génération (en pied de page ; en rouge sur la première page) ; la première page indique aussi la dernière modification de la feuille et son auteur. Nom du fichier : `patch-<spectacle>-AAAAMMJJ-HHMM.pdf`. Sur téléphone : fenêtre Partager / Télécharger / Ouvrir.
- **Mode prépa (v1.30.0)** : on part d'une feuille vide et on remplit les lignes noID d'après le plan de feu. Une ligne sans projecteur porte un **modèle du catalogue** (`patch_lines.model_id`, liste groupée par type) ou un texte libre (`model_text`), et pour un PAR la **lampe voulue** (`patch_lines.lamp_id`). « + Ajouter un modèle au catalogue… » (fonction `add_model`) est réservé au **régisseur général et à l'admin**. En touchant noID, la liste d'ID est **classée** (logique pure dans `src/patchSuggest.ts`, testée) : 1) même modèle, puis modèle similaire, puis autres ; 2) disponibilité (« disponible » avant « utilisé ailleurs, libre à ces dates ») ; 3) PAR : lampe déjà montée = lampe voulue ; 4) dernière position connue = position de la ligne ; 5) numéro. Chaque ID affiche la raison de son rang. Un ID d'un autre modèle est accepté, mais **après une fenêtre d'avertissement rouge bien visible (v1.31.0)** : « ⚠ MODÈLE DIFFÉRENT — la ligne prévoit un X, mais le projecteur N est un Y » (avec « modèle similaire » le cas échéant), boutons « Utiliser quand même » / « Annuler », et une courte vibration sur téléphone. Valable pour le scan d'un QR code, la liste d'ID, « Ajouter un projecteur du stock », ⇄ et le choix d'un ID déjà dans le spectacle ; aucun avertissement si la ligne n'a pas de modèle prévu. Quand la ligne reçoit un projecteur, son modèle et sa lampe voulue sont remplacés par ceux du projecteur ; pour un PAR, la lampe voulue est demandée au montage.
- **Sur téléphone (écran tactile), toucher la cellule ID ouvre directement le scan de QR code** (v1.31.1) : la caméra démarre, et la même fenêtre propose « Choisir un projecteur… », noID (ligne avec projecteur) et la liste d'ID. Sur ordinateur, la liste déroulante habituelle. Détection : `matchMedia('(pointer: coarse)')` dans `src/views/patch.ts`.
- **Scan sur téléphone (v1.31.2)** : à l'ouverture d'une fenêtre de scan sur écran tactile, le clavier est masqué (il revient si on touche le champ de filtre). Un projecteur scanné d'un **autre modèle** (affiché en rouge, mais sélectionnable) ou **indisponible pendant tout le spectacle** / QR non reconnu (refusé) déclenche un message rouge en gras et une vibration longue (`alarm` dans `src/ui/dialog.ts`, champ `scanWarn`).
- **Garde « indisponible » (v1.31.3)** : tout ID choisi ou scanné est contrôlé avec `blockedReason` (autre spectacle aux mêmes dates, prêt / SAV qui chevauche le spectacle, panne ouverte), **y compris un projecteur déjà affecté au spectacle** (avant, seuls les projecteurs du stock étaient contrôlés). Refus : fenêtre rouge « ⛔ PROJECTEUR INDISPONIBLE » avec la raison, vibration, bouton Annuler seul ; le contrôle d'indisponibilité passe avant l'avertissement « modèle différent ».
- **Lignes noID rattachées à une location / un prêt (v1.32.0)** : sur une ligne sans projecteur, (v1.35.0 : dans la liste des modèles, on choisit **« Location / prêt… »** (proposé seulement si la fiche du spectacle a des locations ou prêts) ; une 2e liste apparaît alors pour désigner laquelle ; la liste des modèles et la lampe ne sont affichées que sinon) la ligne est rattachée à l'une d'elles ; la ligne prend alors le modèle (et la lampe d'un PAR) de la demande liée. L'en-tête affiche un compteur par location : « PAR64 CP62 · loué chez X **3/4 · il en manque 1** » (orange si le nombre ne correspond pas, « ✓ » sinon). **Purement informatif : rien n'est bloqué.** Le PDF ajoute « (loué chez X) » au modèle. Une ligne qui reçoit un projecteur du stock quitte la location (le compteur baisse) ; si la location est supprimée sur la fiche du spectacle, les lignes restent, sans mention. Base : colonne `patch_lines.external_id` (clé étrangère vers `show_externals`, `on delete set null`), valeur écrite par `set_patch_field`.

| Qui | Droit |
|---|---|
| Tout le monde | voir le rattachement et le compteur |
| Régisseur du spectacle, RG, admin | rattacher / détacher une ligne (comme la cellule ID) |
| Technicien | lecture seule sur ce point |

- **Bip « caisse enregistreuse » (v1.33.0)** : chaque QR code accepté (scan d'un projecteur, lot d'un spectacle, feuille de patch, remplacement) joue un « ka-ching » (claquement + deux notes de clochette, ~0,6 s, volume modéré). Son synthétisé par l'API Web Audio dans `src/ui/beep.ts` : aucun fichier audio, marche hors ligne. Le navigateur n'autorise le son qu'après un premier toucher de l'écran ; pas de bip pour un QR refusé (vibration et message rouge seulement). Pas de réglage pour le couper pour l'instant.
- **Modèles « similaires »** (liste `SIMILAR` dans `src/patchSuggest.ts`) : ETC 25-50 / 613 · 614 SX / 614 S · 714 SX / 714 · 329 HPC / 329 HPB · 310 HPC / 306 HPC.
- **Dernière position (v1.30.0)** : calculée d'après la chronologie des spectacles (le plus récent qui a une position pour ce projecteur), pas d'après la date de saisie. Affichée dans la fiche du projecteur (« Dernière position · à jouer sur <spectacle> ») et utilisée pour classer les suggestions (spectacles commencés avant celui qu'on prépare).
- **Toujours en tableau (v1.30.7)** : plus d'affichage « fiche » sur téléphone. Le tableau défile de côté et de haut en bas dans sa propre zone ; l'en-tête, les titres de colonnes et, à gauche, les colonnes **Circuit** et **Modèle** (placé juste après Circuit) restent fixes. CSS dans `src/styles.css` (section « Feuille toujours en tableau »), hauteur du tableau calculée par `fitTable` (`src/views/patch.ts`).
- **Téléphone en paysage (v1.30.0, remplacé par la ligne ci-dessus)** : sous 1000 px de large et 520 px de haut en paysage, la feuille s'affiche en vrai tableau compact (défilement horizontal dans le tableau), bandeaux masqués et barres réduites pour laisser la place. **v1.30.2** : l'en-tête (titre, boutons, titres de colonnes) ne bouge plus ; seules les lignes défilent dans le tableau (hauteur calculée par `fitTable` dans `src/views/patch.ts`), et la règle s'applique dès que l'écran est en paysage et bas (≤ 520 px), même sur un grand écran.

| Migration | Apporte | Indispensable pour |
|---|---|---|
| `schema.sql` bloc v1.23 | `patch_lines`, `set_patch_field` | v1.23.0 |
| `schema.sql` bloc v1.24 | `patch_set_item`, `patch_add_line`, `patch_delete_line`, `patch_add_gel`, `patch_delete_gel` | v1.24.0 |
| `schema.sql` (v1.44.0) | `patch_lines.state` / `state_note` (+ reprise des anciens focus), `set_patch_field` accepte le champ `state` | v1.44.0 |
| `schema.sql` (v1.46.0) | `reallocate_all` réécrit (calcul du manque jour par jour, stock partagé), colonne `show_demands.available`, projecteurs « auto » repris comme affectés à la main, `swap_show_item` / `release_show_item` supprimées | v1.46.0 |
| `schema.sql` (v1.47.0) | table `show_substitutions`, fonctions `add_substitution` / `delete_substitution`, `reallocate_all` tient compte des substitutions | v1.47.0 |
| `schema.sql` fin de fichier (v1.43.0) | `show_copy_from`, `patch_clear_circuits`, `patch_clear_gels_acc` | v1.43.0 |
| `schema.sql` fin de fichier (v1.39.0) | positions autorisées (P0, 2e balcon, 3e balcon) + conversion des lignes `balcon` / `3e` | v1.39.0 |
| `schema.sql` fin de fichier (v1.37.0) | `patch_lines.need_demand_id`, `patch_need_set`, `demand_dec`, `set_patch_field` / `patch_set_item` / `patch_delete_line` adaptées | v1.37.0 |
| `schema.sql` fin de fichier (v1.36.0) | `demand_attach`, `demand_detach`, `patch_set_item` et `patch_delete_line` modifiées, reprise de l'existant | v1.36.0 |
| `schema.sql` (v1.35.2) | position « pont coupole » acceptée par `set_patch_field` (liste des positions) | v1.35.2 |
| `schema.sql` fin de fichier (v1.34.0) | pastille bleue `items.blue_dot`, `shows.mounted` / `mounted_at`, `set_blue_dot`, `set_show_mounted` | v1.34.0 |
| `schema.sql` fin de fichier (v1.32.0) | lignes noID rattachées à une location / un prêt : colonne `patch_lines.external_id`, `set_patch_field` (champ `external_id`), `patch_set_item` (détache la ligne) | v1.32.0 |
| `schema.sql` fin de fichier (v1.30.0) | mode prépa : colonnes `patch_lines.model_id` / `lamp_id`, `set_patch_field` étendue, `patch_item_model`, `patch_set_item` mise à jour, `add_model` | v1.30.0 |
| `schema.sql` fin de fichier (v1.27.0) | gélatines des lignes sans projecteur : colonne `patch_lines.gels`, `patch_add_line_gel`, `patch_delete_line_gel` | v1.27.0 |
| `schema.sql` fin de fichier (v1.26.1) | courbe à choix unique (anciennes saisies multiples ramenées à un choix) | v1.26.1 |
| `schema.sql` fin de fichier (v1.24.3) | positions « allemande J / C » (au lieu de J1, J2, C1, C2) et « passerelle J / C » | v1.24.4 |

### Aide intégrée, bouton « i » (v1.29.0)

Dans l'onglet **Plus**, le bouton **i** (à côté du bouton Partager) ouvre « Tout ce que fait Stock BdN » : une fenêtre avec le bouton **Fermer** toujours visible en haut, les rubriques **repliées au départ** et dépliables, fermée aussi par la touche Retour du téléphone ou en touchant le fond. Les rubriques « Gestion du parc et des accès » (régisseur général et admin) et « Administration » (admin) ne s'affichent que pour ces rôles.
- Le texte est dans `src/ui/help.ts` : **à mettre à jour à chaque nouvelle fonction**.
- Le numéro de version est dans `src/version.ts` (affiché dans Plus et dans l'aide) **et** `package.json` : les deux changent ensemble à chaque livraison.

### Déconnexion fiabilisée et garde-fou de démarrage (v1.18.1)
- Se déconnecter ne recharge plus la page deux fois (cause probable de l'écran noir sur l'appli installée).
- Si l'écran reste vide 8 s au démarrage : message + bouton « Réinitialiser et recharger » (`src/watchdog.ts`).

### Spectacle en cours et prêts regroupés au calendrier (v1.18.0)
- **Bandeau « En cours »** : sous la barre du haut, un petit bandeau rappelle le spectacle dont les dates incluent aujourd'hui (couleur du spectacle, « jusqu'au … »). Un appui ouvre sa fiche. Au-delà de 2 spectacles simultanés, une ligne « + n autres » mène à la liste.
- **Prêts / locations regroupés** (calendrier Mois et Semaine) : dès qu'une semaine compte 2 prêts / locations ou plus, ils sont résumés en une seule ligne bleue « ▸ n prêts / locations » (de la première livraison à la dernière reprise). Un appui la déplie (▾) et affiche chaque prêt ; un second appui la replie. Chaque ligne dépliée, comme les barres de spectacle, ouvre la fiche du spectacle. L'état déplié se retient par semaine, le temps de la session.

### Partager l'appli et bandeau d'installation (v1.17.0)
- **Partager** : l'icône de partage en haut de **Plus** ouvre la feuille de partage du téléphone avec l'adresse de l'appli (`APP_URL` dans `src/pdfHeader.ts`) ; sans feuille de partage (ordinateur), l'adresse est copiée (`src/share.ts`).
- **Installer** (`src/install.ts`) : tant que l'appli n'est pas installée, un bandeau en haut propose **Installer** (fenêtre native du navigateur quand il la fournit) ou **Voir comment** (guide pas à pas : iPhone/iPad, Android Chrome et Firefox, ordinateur Chrome/Edge, Mac Safari, Firefox ordinateur ; l'appareil de la personne passe en premier). **Plus tard** reporte le rappel d'une semaine, 3 fois au plus ; **Plus → Installer l'application** reste disponible. Rien n'est proposé si l'appli est déjà ouverte en mode application ou sur Firefox ordinateur. Le bandeau « active les notifications » ne s'affiche qu'une fois l'invitation à installer terminée ou reportée (sur iPhone, les notifications demandent l'appli installée).

### Bandeau « active les notifications » (v1.16.0)
Tant que les notifications ne sont pas activées sur l'appareil (et qu'elles peuvent l'être : navigateur compatible, autorisation non refusée, appli installée sur iPhone), un bandeau en haut de l'appli propose **Activer** (demande l'autorisation et abonne l'appareil en un appui) ou **Plus tard** (rappel reporté d'une semaine ; après 3 reports il ne revient plus tout seul, Plus → Notifications reste disponible). Le bandeau disparaît dès que les notifications sont actives, y compris si on les active depuis Plus.

### Agenda d'un projecteur sur 20 jours glissants (v1.15.1)
La frise de l'agenda (fiche d'un projecteur) montre 20 jours : les 5 jours précédents, aujourd'hui (trait vertical, à 1/4 de la frise) et les 14 jours à venir, avec une graduation tous les 5 jours. Les flèches ‹ › décalent de 14 jours, « Auj. » revient à aujourd'hui. Les périodes plus anciennes ou plus lointaines restent dans la liste détaillée sous la frise.

### Scanner un QR code pour « Changer » un projecteur (v1.15.0)
Dans la fenêtre « Remplacer le projecteur N » (bouton *Changer*), un bouton **Scanner le QR code** ouvre la caméra dans la fenêtre. Le projecteur lu est sélectionné dans la liste (il reste à valider avec *Remplacer*). Si le QR n'est pas un candidat valable, un message dit pourquoi (autre modèle, déjà assigné, SAV, prêt, en panne…) et le scan continue. La caméra est chargée seulement à l'ouverture (bibliothèque `qr-scanner` chargée à la demande) et exige HTTPS. Le champ `scan` des fenêtres (`src/ui/dialog.ts`) peut servir à d'autres listes.

### Bandeau de mise à jour et plus de rechargement en tirant l'écran (v1.14.0)
Quand une nouvelle version est publiée, l'appli la détecte toute seule (au retour sur l'appli, quand le réseau revient, puis toutes les 30 minutes) et affiche en haut un bandeau **« Nouvelle version disponible — Mettre à jour »**. Rien ne se recharge sans toi ; « × » masque le bandeau jusqu'à la prochaine vérification. Le service worker est passé de `autoUpdate` à `prompt` (`vite.config.ts`, `src/updates.ts`). Tirer l'écran vers le bas ne recharge plus l'appli (`overscroll-behavior-y: none`) : le bouton « À jour » de l'en-tête et le bandeau s'en chargent.

**Vérifier les mises à jour (v1.25.0)** : bouton à double flèche dans l'onglet « Plus » (carte du profil). Il interroge le serveur tout de suite et répond par un message : « Tu as déjà la dernière version », ou le bandeau « Nouvelle version disponible » apparaît. Désactivé hors ligne.

### Filtre par type dans la liste des projecteurs (v1.13.2)
Sur la page d'un spectacle, un appui sur un type (« 614 SX (4) ») filtre la liste des projecteurs assignés ; un second appui retire le filtre. Rien n'est coché par ce geste : « Tout cocher » agit ensuite sur les lignes affichées (donc sur le type filtré), et les cases déjà cochées restent cochées quand on change de filtre.

### Référence à l'appli dans les PDF (v1.13.1)
Chaque page des PDF générés (liste de prépa, rapport de démontage) porte en haut à droite « Stock BdN - stock-bdn.thierry-morin.com », cliquable (`src/pdfHeader.ts`). Si l'adresse de l'appli change, modifier `APP_URL` et `APP_LABEL` dans ce fichier.

### Changer son e-mail (v1.13)
**Plus → Changer mon e-mail** : la personne saisit sa nouvelle adresse, Supabase lui envoie un lien de confirmation (selon le réglage *Secure email change* d'Authentication → Providers → Email, il faut le confirmer sur la nouvelle adresse seulement ou sur les deux). Tant que le lien n'est pas cliqué, l'ancienne adresse reste l'identifiant de connexion ; une faute de frappe ne bloque donc personne. Une fois confirmé, un déclencheur SQL recopie la nouvelle adresse dans `profiles.email` et l'écrit au journal. Rôle, messages, citations et notifications suivent le compte, pas l'adresse. Prérequis : l'adresse de l'appli figure dans *Authentication → URL Configuration → Redirect URLs*.

### Notifications push du mur (v1.12)
Un appareil qui a activé les notifications (**Plus → Notifications → Activer**) est prévenu :
- d'un **message posté sur le mur d'un spectacle** : tous les régisseurs généraux et administrateurs, pour tous les spectacles ; les autres seulement si elles sont concernées : régisseur assigné, créateur du spectacle ou personne déjà intervenue sur son mur (quel que soit son rôle, RG compris) ;
- quand elle est **citée** (@Nom) dans n'importe quel message ;
- quand un régisseur général ou un administrateur écrit **@all** (proposé en tête de « @ Citer une personne ») : tous les comptes sont prévenus ; écrit par quelqu'un d'autre, @all n'a aucun effet.

Les **annonces admin et infos générales sont silencieuses**, sauf pour les personnes citées (ou avec @all). L'auteur n'est jamais notifié de son propre message.

Un clic sur la notification ouvre le mur ou le spectacle. Chaque message n'est notifié qu'une fois ; modifier un message ne renotifie pas. Le bouton *Envoyer un essai* vérifie toute la chaîne. Sur **iPhone**, il faut d'abord ajouter l'appli à l'écran d'accueil (iOS 16.4 minimum). À la déconnexion, l'appareil n'est plus abonné à ce compte.

Mise en place (une seule fois) :
1. Rejouer `supabase/schema.sql` (table `push_subscriptions`, fonctions `save_push_subscription`, `delete_push_subscription`, `push_targets`).
2. **Edge Functions → Deploy a new function → Via Editor** : nom **`push-notify`**, contenu de `supabase/functions/push-notify/index.ts`, puis désactiver *Verify JWT* (la fonction vérifie elle-même l'identité, comme `admin-users`).
3. **Edge Functions → Secrets** : créer `VAPID_PUBLIC_KEY` et `VAPID_PRIVATE_KEY` (paire de clés VAPID ; la clé publique est aussi dans `src/push.ts`, les deux doivent correspondre). `VAPID_SUBJECT` est facultatif.

Pour générer une nouvelle paire : `npx web-push generate-vapid-keys`, puis remplacer `VAPID_PUBLIC_KEY` dans `src/push.ts` et les deux secrets (les appareils doivent alors réactiver les notifications).

### Messages généraux sur le mur (v1.11)
Depuis l'onglet **Mur**, un administrateur poste une **annonce admin** (bandeau jaune rayé : notes de mise à jour, consignes) et un régisseur général une **info générale** (bandeau vert : vie du théâtre, utilisation du matériel). Le bandeau est fixé par le rôle de l'auteur ; ces messages n'appartiennent à aucun spectacle (`show_posts.show_id` nul, `kind` = admin / general), se filtrent via « Infos générales », se modifient et s'effacent par leur auteur (l'admin peut tout effacer). RPC `post_general_message`.

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
