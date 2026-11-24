// Aide intégrée (bouton « i » de l'onglet Plus) : les fonctions de l'appli dans l'ordre où on en a besoin.
// Fenêtre native : bouton Fermer en haut, touche « Retour » du téléphone, toucher le fond ; rubriques repliées au départ, dépliables.
// À mettre à jour à chaque nouvelle fonction (règle du dépôt, voir README).
import { can } from '../store';
import { APP_VERSION } from '../version';

/** Une rubrique : titre + liste de points (HTML simple, écrit ici, jamais construit à partir de texte d'utilisateur). */
interface Section { title: string; items: string[]; show?: () => boolean }

const SECTIONS: Section[] = [
  { title: 'S\'y retrouver', items: [
    '<b>Les onglets du bas</b> : <b>Parc</b> (tous les projecteurs), <b>Scan</b> (lire un QR code), <b>Spectacles</b>, <b>Mur</b> (messages), <b>Pannes</b>, <b>Plus</b> (profil, notifications, réglages).',
    '<b>En-tête</b> : toujours visible. Il montre l\'état de synchro (« À jour », actions en attente), le nombre de personnes en ligne (pastille verte, touche-la pour voir qui) et le spectacle en cours.',
    '<b>Retour</b> : la touche « Retour » du téléphone ferme d\'abord la fenêtre ouverte, puis remonte d\'un écran.',
    '<b>Hors ligne</b> : la liste des projecteurs reste consultable. Changements d\'état et pannes sont gardés sur l\'appareil (⏳) et envoyés au retour du réseau. Spectacles, feuille de patch, mur et catalogue demandent une connexion.',
    '<b>Mises à jour</b> : l\'appli cherche seule une nouvelle version. Un bandeau « Nouvelle version disponible » propose de recharger. Pour forcer la recherche : <b>Plus → Vérifier les mises à jour</b>.',
    '<b>Installer l\'appli</b> : sur l\'écran d\'accueil de ton téléphone, elle s\'ouvre en plein écran comme une vraie appli (Plus → Installer l\'application, ou le bandeau d\'installation).',
    '<b>Blocage</b> : si l\'appli ne démarre pas, un message avec le bouton « Réinitialiser et recharger » apparaît après quelques secondes.'
  ] },
  { title: 'Le parc et la fiche d\'un projecteur', items: [
    '<b>Liste</b> : recherche par numéro ou modèle (sans accents ni majuscules), filtre par état (disponible, utilisé, SAV, en prêt) et par type.',
    '<b>États</b> (mêmes couleurs partout) : <b>vert</b> disponible, <b>vert hachuré</b> utilisé (affecté à un spectacle en cours), <b>jaune</b> en prêt, <b>rouge</b> SAV.',
    '<b>Fiche</b> : état, lampe montée, historique, <b>agenda</b> (frise de 3 mois : libre, prêt, SAV), spectacles où il est affecté.',
    '<b>Utiliser le matériel d\'un autre spectacle</b> (régisseurs généraux et admins, fiche du spectacle) : recopie les projecteurs assignés d\'un autre spectacle, avec ou sans ses circuits, gélatines et accessoires. Pratique pour un spectacle léger qui repart d\'un montage précédent. Les locations et prêts ne sont pas recopiés.',
    '<b>Effacer les circuits / les gels et accessoires</b> (feuille de patch) : vide la colonne circuit (les gradas restent) ou les gélatines et accessoires, pour repartir d\'un montage déjà patché.',
    '<b>Effacer la feuille, garder les projecteurs affectés</b> (menu « Effacer… » de la feuille de patch) : supprime toutes les lignes (circuits, gradas, courbes, DMX, positions, accessoires, gélatines, états, notes, lignes sans projecteur). Les projecteurs restent affectés ; les demandes, prêts et locations ne bougent pas. Confirmation demandée, impossible d\'annuler.',
    '<b>Positions</b> : la liste de la feuille de patch est rangée par zone (Cintres, Cage de scène, FOH, Autres) pour t\'y retrouver en faisant défiler.',
    '<b>Position actuelle</b> : sur la fiche, où est le projecteur aujourd\'hui (position de la feuille de patch d\'un spectacle monté, stock dessous, stock 3e, PRÊT ou SAV).',
    '<b>Pastille bleue</b> : projecteur stocké au <b>3e</b> quand il ne joue pas. Seuls les régisseurs généraux et les admins la mettent ou l\'enlèvent (bouton sur la fiche). Filtre « Stocké au 3e » dans la liste.',
    '<b>PAR</b> : quatre boutons <b>CP62 · CP61 · CP60 · CP95</b> changent la lampe montée d\'un seul geste (technicien et plus).',
    '<b>Prêt / SAV</b> (régisseur général et admin) : on indique à qui, depuis quand, retour prévu. Repasser « Disponible » clôt la période. En passant en SAV, tu peux <b>déclarer une panne</b> en même temps.'
  ] },
  { title: 'Scanner un QR code', items: [
    'Onglet <b>Scan</b> : la caméra lit l\'étiquette collée sur le projecteur et ouvre sa fiche. La caméra demande l\'accès : autorise-le dans le navigateur.',
    'Les étiquettes s\'impriment depuis <b>Plus → Étiquettes QR</b> (régisseur général et admin). Le QR code contient l\'adresse de l\'appli : ne change pas l\'adresse après impression.',
    'Chaque QR code lu fait un petit <b>bip « caisse enregistreuse »</b> (si le son de ton téléphone est activé).',
    'Le scan sert aussi à <b>affecter un lot</b> de projecteurs à un spectacle, à <b>changer</b> un projecteur, et dans la <b>feuille de patch</b> (liste d\'ID → « Scanner un QR code… »).'
  ] },
  { title: 'Pannes', items: [
    'Depuis la fiche d\'un projecteur : <b>Signaler une panne</b> (tous les rôles). Tu peux ajouter des infos ensuite ; le régisseur et plus déclarent la panne <b>résolue</b>.',
    '<b>Panne qui ne bloque pas</b> (ex. molette cassée mais le projecteur joue encore) : dans « Signaler une panne », choisis « Oui, jusqu\'à la fin du spectacle, puis SAV ». Le projecteur reste affecté sans alerte (pastille jaune) ; le lendemain un SAV sans date de fin démarre tout seul et le projecteur n\'est plus proposé aux spectacles suivants. Le rapport de démontage liste « À envoyer en SAV ».',
    'Onglet <b>Pannes</b> : toutes les pannes ouvertes. Un projecteur en panne n\'est plus proposé aux spectacles.',
    'Quand tu remplaces un projecteur dans la feuille de patch (⇄), l\'appli te propose de déclarer la panne en même temps.'
  ] },
  { title: 'Spectacles', items: [
    '<b>Liste, mois, semaine</b> : le calendrier est glissant (1 semaine passée, 3 à venir). Le spectacle en cours brille, les passés sont ternis, chacun a sa couleur. Ceux où tu ne peux pas agir sont grisés.',
    '<b>Monté / Démonté</b> (en haut d\'un spectacle) : en cours = toujours monté ; le lendemain du dernier jour = démonté tout seul. Un régisseur général ou un admin peut le forcer avant ou après.',
    '<b>Rapport de démontage</b> : à stocker dessous, à stocker au 3e, à garder en place, à déplacer, à monter (avec provenance). <b>Liste de prépa</b> : classée par provenance (stock dessous, stock 3e, déjà monté), avec accessoires, et prêts / locations en bleu.',
    '<b>Fiche d\'un spectacle</b> : mur, régisseurs, <b>Matériel demandé</b> (objectifs de quantité) et <b>Projecteurs affectés</b> (les n° précis). Les deux sont repliés au départ.',
    '<b>Matériel demandé</b> : tu notes modèle + lampe (PAR) + quantité d\'après la fiche technique ou le plan de feu. L\'appli ne choisit aucun projecteur : elle compare avec ceux qui sont disponibles aux dates du spectacle (sans panne, SAV ou prêt), en partageant le stock avec les spectacles aux mêmes dates. Chaque ligne affiche <b>Demandé · Affectés · Disponibles</b>. S\'il en manque, l\'alerte s\'allume, et se met à jour toute seule quand une panne ou un SAV est déclaré : « Gérer » pour un <b>prêt</b>, une <b>location</b> ou une <b>substitution</b> (un autre modèle prend une part de la demande : les modèles similaires sont proposés en premier ; la demande d\'origine ne change pas, et le remplaçant consomme du stock partagé). Les n° précis s\'affectent dans « Projecteurs affectés » ou la feuille de patch ; ils comptent pour atteindre l\'objectif. <b>Gélatines demandées</b> : bouton <b>Gel</b> sous une demande, une ou plusieurs références (L201 + R119, L200, R114, L281+#132…) et le nombre de projecteurs. Une référence redemandée s\'additionne (jamais au-delà de la quantité demandée). Dans « Gélatines à couper » elles sont fusionnées avec les gels posés sur des projecteurs (le plus grand des deux). La liste de prépa a aussi une section <b>Porte-filtres</b> : un par projecteur gélatiné, même avec 2 gels, nommé par modèle.',
    '<b>Projecteurs affectés</b> : rangés <b>par modèle</b>, repliés au départ, avec « Demandé N · Affectés M » ; toucher un modèle le déploie et replie le précédent (en rouge quand il y a moins d\'affectés que demandés). « Affecter manuellement » (liste avec filtre par type, ou scan QR en continu). En scan : caméra en haut, position du lot (facultative), badges du lot, saisie d\'un n°. Pour chaque PAR, valide sa lampe (la lampe déjà montée est proposée). Un projecteur ne peut pas être dans deux spectacles qui se chevauchent, ni pendant un prêt ou un SAV.',
    '<b>Gélatines</b> : chaque projecteur peut en recevoir plusieurs (référence libre : L201, R80…). La couleur du badge est déduite de la référence.',
    '<b>PDF</b> : « Générer la liste de prépa » (projecteurs à préparer par modèle et stock, ceux déjà en place du spectacle précédent à part, gélatines à couper, accessoires à préparer) et « Rapport de démontage » (ce qu\'il faut préparer, garder, rendre pour le spectacle suivant, avec ses gélatines à couper et ses accessoires à préparer).',
    '<b>Régisseurs</b> : seul le régisseur assigné au spectacle (ou un régisseur général / admin) peut y affecter des projecteurs.'
  ] },
  { title: 'Patch / Focus', items: [
    'Bouton bleu <b>Patch / Focus</b> dans l\'en-tête d\'une fiche de spectacle : une ligne par projecteur affecté, avec circuit, grada, courbe, adresse DMX, ID, modèle, gélatines, accessoires, position, état et notes.',
    '<b>État</b> (le rond de la colonne) : <b>un clic</b> le passe en <b>vert</b> (fait), un clic de plus le décoche. <b>Un double clic</b> le passe en <b>rouge</b> (à faire) et ouvre une fenêtre pour noter ce qu\'il y a à faire. <b>Un clic sur un rouge</b> montre la note dans une bulle (sur ordinateur, le survol suffit ; « Modifier la note » est dans la bulle). <b>Un double clic sur un rouge</b> le décoche. Au clavier : Entrée = cocher / décocher, Maj + Entrée = à faire. Dans les PDF, la note est écrite en bas de page.',
    '<b>Trier</b> : touche un titre de colonne (ordinateur) ou utilise « Trier par » (téléphone). Les cases vides passent en dernier.',
    '<b>Courbe</b> : un seul choix (Linéaire par défaut, Off/On, Autre, DIRECT). Avec DIRECT, une <b>adresse DMX</b> au format univers-adresse (ex. 1-45) devient possible.',
    '<b>Sélectionner des lignes</b> (feuille de patch) : le bouton « Sélectionner » ajoute une case par ligne ; Maj + clic coche toutes les lignes entre deux cases, « Tout » coche les lignes affichées. La barre en haut indique le nombre de lignes et propose <b>Modifier…</b> (position, courbe, accessoire à ajouter ou retirer, gélatines à ajouter (plusieurs références possibles) ou à vider, état, note, vider circuit / grada / DMX) et <b>Supprimer…</b> (vider les lignes en gardant les projecteurs, ou les retirer aussi du spectacle). Tout ou rien : si une valeur est refusée, rien n\'est modifié. Le technicien ne modifie que grada, courbe et gélatines. Connexion requise, impossible d\'annuler, pas de notification.',
    '<b>Qui peut quoi</b> : tout le monde voit la feuille. Un technicien modifie la grada, la courbe et les gélatines. Le régisseur du spectacle, le régisseur général et l\'admin modifient tout, changent les ID et ajoutent ou suppriment des lignes.',
    '<b>Cellule ID</b> : choisis un autre ID du spectacle (les deux lignes échangent leurs projecteurs), <b>noID</b> (ligne sans projecteur : prêté, loué, autre), <b>Ajouter un projecteur du stock</b>, ou <b>Scanner un QR code</b> (sur téléphone, toucher l\'ID ouvre directement le scan ; la liste et noID restent dans la même fenêtre). Le bouton <b>⇄</b> remplace le projecteur par un autre du stock (l\'ancien quitte le spectacle).',
    '<b>Les gélatines et le reste de la saisie restent sur la ligne</b> (le circuit) quand l\'ID change. La liste « Projecteurs affectés » du spectacle suit.',
    '<b>Ajouter une ligne</b> : une ligne noID à remplir ; tu choisis ensuite son ID parmi les projecteurs du stock disponibles. <b>Suppr.</b> vide ou supprime une ligne (avec la question : retirer aussi le projecteur du spectacle ?).',
    '<b>Mode prépa</b> : pars d\'une feuille vide, lis le plan de feu et ajoute une ligne par projecteur (« + Ajouter une ligne », noID). Remplis position, circuit, gélatines, accessoires et le <b>modèle</b> (liste du catalogue ; pour un PAR, la lampe voulue). « Autre (texte libre) » sert si le modèle est inconnu ; le régisseur général et l\'admin peuvent <b>ajouter un modèle au catalogue</b>.',
    'Ensuite touche <b>noID</b> : la liste propose les projecteurs <b>du plus judicieux au moins judicieux</b> (même modèle, puis modèles similaires, puis les autres). Critères : disponibilité, puis, pour un PAR, la lampe déjà montée, puis la dernière position connue. Choisir ou scanner un projecteur d\'un autre modèle est accepté, mais une <b>fenêtre rouge « Modèle différent »</b> te demande de confirmer.',
    '<b>Clavier</b> : <b>Tab</b> passe à la colonne suivante, <b>Entrée</b> enregistre et descend au même champ de la ligne suivante (le contenu est sélectionné : tape par-dessus).',
    '<b>Largeur des colonnes</b> (ordinateur) : tire le bord droit d\'un titre de colonne ; double-clic pour revenir à la largeur automatique. Ton réglage est gardé sur cet ordinateur.',
    '<b>Titres abrégés</b> : c° = circuit, grad. = grada, acc. = accessoires. La largeur des colonnes suit ce qu\'elles contiennent, pas leur titre.',
    '<b>PDF</b> : la feuille de patch s\'imprime comme une page de cahier griffonnée à la main (lignes bleues, marge rouge, écriture manuscrite).',
    '<b>Matériel demandé</b> : un projecteur que tu mets dans la feuille (ID du stock, remplacement) compte pour atteindre l\'objectif du matériel demandé, sans modifier la quantité demandée.',
    '<b>À louer / à emprunter</b> : sur une ligne sans ID, choisis le modèle « Location / prêt… » puis « + À louer / à emprunter… ». La demande monte de 1 et l\'alarme « manque » joue si le stock ne suffit pas. Le matériel du décor ou de la Cie, lui, n\'est jamais compté.',
    '<b>Locations et prêts</b> : si la fiche du spectacle contient du matériel loué ou prêté, chaque ligne noID peut être rattachée à l\'une d\'elles (dans la liste des modèles, choisis « Location / prêt… » : une 2e liste apparaît pour désigner laquelle). L\'en-tête compte les lignes placées (ex. 3/4) et signale en orange ce qui manque ou dépasse. C\'est une information : rien n\'est bloqué.',
    '<b>Sur téléphone</b> : la feuille est un tableau comme sur ordinateur. Fais-le défiler vers la droite : les colonnes <b>Circuit</b> et <b>Modèle</b> et l\'en-tête restent toujours visibles.',
    '<b>Choix du PDF</b> : le bouton « PDF » demande quoi imprimer : la feuille comme à l\'écran, classée par circuits, par grada, par position (zone, puis position précise, puis projecteurs par ID), ou toutes dans un seul PDF. Les gélatines à couper et les accessoires sont dans la liste de prépa du spectacle.',
    '<b>PDF</b> : bouton « PDF », A4 paysage, avec la date et l\'heure de génération sur chaque page (important si le kit change) et la dernière modification de la feuille.'
  ] },
  { title: 'Le mur et les notifications', items: [
    '<b>Mur</b> : chaque spectacle a son mur (to-do, passation, horaires, problèmes techniques…). L\'onglet <b>Mur</b> réunit tous les messages ; un filtre permet de ne voir qu\'un spectacle. Sur la fiche d\'un spectacle, le mur est <b>replié</b> (dernier message seulement) : touche son titre pour le déplier, lire tous les messages et écrire.',
    'Chaque message est signé, avec la couleur de son auteur. <b>@</b> cite une personne (elle est notifiée), <b>#219</b> cite un projecteur (lien vers sa fiche). Tu modifies ou effaces tes propres messages.',
    '<b>Notifications</b> : Plus → Activer les notifications. Sur iPhone, l\'appli doit d\'abord être installée sur l\'écran d\'accueil (iOS 16.4 minimum).'
  ] },
  { title: 'Mon compte', items: [
    '<b>Plus</b> : modifier ton nom, changer ton e-mail (un lien de confirmation est envoyé), activer les notifications, te déconnecter.',
    '<b>Accès sur invitation</b> : pas d\'inscription libre. Sur l\'écran de connexion, « Demander à s\'inscrire » prévient les administrateurs.',
    '<b>Rôles</b> : technicien < régisseur < régisseur général < administrateur. Chaque rôle fait tout ce que font les rôles d\'avant, et les droits sont appliqués par la base, pas seulement par l\'écran.'
  ] },
  { title: 'Gestion du parc et des accès', show: () => can('regisseur_general'), items: [
    '<b>Plus → Ajouter des projecteurs</b> : nouvelles unités dans le parc. <b>Plus → Étiquettes QR</b> : imprimer les stickers.',
    '<b>Plus → Utilisateurs et droits</b> : inviter des personnes (prénom, nom, e-mail, rôle), changer un nom ou un rôle, révoquer ou rétablir un accès sans supprimer le compte. Un régisseur général gère les techniciens et les régisseurs ; l\'administrateur gère tout le monde.',
    '<b>Demandes d\'inscription</b> : les administrateurs les voient dans Utilisateurs et droits (Inviter ou Refuser) et sont prévenus par notification.',
    '<b>Spectacles</b> : création, modification, suppression, assignation des régisseurs, prêts et locations. <b>Prêt / SAV</b> d\'un projecteur : sur sa fiche.'
  ] },
  { title: 'Administration', show: () => can('admin'), items: [
    '<b>Plus → Journal</b> : qui a fait quoi, connexions et départs compris. Tu peux le purger.',
    '<b>Modèles, lampes, familles, types, douilles, porte-filtres</b> : le catalogue, dans Plus.',
    '<b>Pastille rouge « update en cours »</b> : une mise à jour de la base (Supabase) est à faire avant que la nouvelle version marche en entier.'
  ] }
];

/** Ouvre la fenêtre d'aide. */
export function openHelp(): void {
  const dlg = document.createElement('dialog'); dlg.className = 'help';
  const sections = SECTIONS.filter((s) => !s.show || s.show());
  dlg.innerHTML = `<div class="help-head"><h3 id="help-title" tabindex="-1">Tout ce que fait Stock BdN</h3>
      <button type="button" class="btn help-close" data-close aria-label="Fermer" title="Fermer">✕ Fermer</button></div>
    <p class="muted">Un tour des fonctions, dans l'ordre où tu en auras besoin. Touche un titre (›) pour déplier ou replier sa rubrique.</p>
    ${sections.map((s) => `<details class="help-section"><summary>${s.title}</summary><ul>${s.items.map((i) => `<li>${i}</li>`).join('')}</ul></details>`).join('')}
    <p class="sub help-version">Stock BdN · v${APP_VERSION}</p>`;
  document.body.appendChild(dlg);
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener('click', (e) => {   // bouton Fermer, ou toucher le fond sombre à l'extérieur de la fenêtre
    if ((e.target as HTMLElement).closest('[data-close]') || e.target === dlg) close();
  });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });   // touche « Retour » / Échap
  dlg.showModal();
  dlg.querySelector<HTMLElement>('#help-title')?.focus();   // le focus va sur le titre, pas sur le premier bouton
}
