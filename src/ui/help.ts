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
    '<b>PAR</b> : quatre boutons <b>CP62 · CP61 · CP60 · CP95</b> changent la lampe montée d\'un seul geste (technicien et plus).',
    '<b>Prêt / SAV</b> (régisseur général et admin) : on indique à qui, depuis quand, retour prévu. Repasser « Disponible » clôt la période.'
  ] },
  { title: 'Scanner un QR code', items: [
    'Onglet <b>Scan</b> : la caméra lit l\'étiquette collée sur le projecteur et ouvre sa fiche. La caméra demande l\'accès : autorise-le dans le navigateur.',
    'Les étiquettes s\'impriment depuis <b>Plus → Étiquettes QR</b> (régisseur général et admin). Le QR code contient l\'adresse de l\'appli : ne change pas l\'adresse après impression.',
    'Le scan sert aussi à <b>affecter un lot</b> de projecteurs à un spectacle, à <b>changer</b> un projecteur, et dans la <b>feuille de patch</b> (liste d\'ID → « Scanner un QR code… »).'
  ] },
  { title: 'Pannes', items: [
    'Depuis la fiche d\'un projecteur : <b>Signaler une panne</b> (tous les rôles). Tu peux ajouter des infos ensuite ; le régisseur et plus déclarent la panne <b>résolue</b>.',
    'Onglet <b>Pannes</b> : toutes les pannes ouvertes. Un projecteur en panne n\'est plus proposé aux spectacles.',
    'Quand tu remplaces un projecteur dans la feuille de patch (⇄), l\'appli te propose de déclarer la panne en même temps.'
  ] },
  { title: 'Spectacles', items: [
    '<b>Liste, mois, semaine</b> : le calendrier est glissant (1 semaine passée, 3 à venir). Le spectacle en cours brille, les passés sont ternis, chacun a sa couleur. Ceux où tu ne peux pas agir sont grisés.',
    '<b>Fiche d\'un spectacle</b> : mur, régisseurs, <b>Matériel demandé</b> (partie automatique) et <b>Projecteurs affectés</b> (partie manuelle). Les deux sont repliés au départ.',
    '<b>Matériel demandé</b> : tu donnes modèle + lampe (PAR) + quantité ; l\'appli choisit seule les projecteurs et s\'adapte aux pannes, prêts et changements de lampe. S\'il en manque : « Gérer » pour un <b>prêt</b> ou une <b>location</b>.',
    '<b>Projecteurs affectés</b> : « Affecter manuellement » (liste avec filtre par type, ou scan QR en continu). Pour un PAR, la lampe montée est pré-sélectionnée. Un projecteur ne peut pas être dans deux spectacles qui se chevauchent, ni pendant un prêt ou un SAV.',
    '<b>Gélatines</b> : chaque projecteur peut en recevoir plusieurs (référence libre : L201, R80…). La couleur du badge est déduite de la référence.',
    '<b>PDF</b> : « Générer la liste de prépa » et « Rapport de démontage » (ce qu\'il faut préparer, garder, rendre pour le spectacle suivant).',
    '<b>Régisseurs</b> : seul le régisseur assigné au spectacle (ou un régisseur général / admin) peut y affecter des projecteurs.'
  ] },
  { title: 'Patch / Focus', items: [
    'Bouton bleu <b>Patch / Focus</b> dans l\'en-tête d\'une fiche de spectacle : une ligne par projecteur affecté, avec circuit, grada, courbe, adresse DMX, ID, modèle, gélatines, accessoires, position, focus et notes.',
    '<b>Trier</b> : touche un titre de colonne (ordinateur) ou utilise « Trier par » (téléphone). Les cases vides passent en dernier.',
    '<b>Courbe</b> : un seul choix (Linéaire par défaut, Off/On, Autre, DIRECT). Avec DIRECT, une <b>adresse DMX</b> au format univers-adresse (ex. 1-45) devient possible.',
    '<b>Qui peut quoi</b> : tout le monde voit la feuille. Un technicien modifie la grada, la courbe et les gélatines. Le régisseur du spectacle, le régisseur général et l\'admin modifient tout, changent les ID et ajoutent ou suppriment des lignes.',
    '<b>Cellule ID</b> : choisis un autre ID du spectacle (les deux lignes échangent leurs projecteurs), <b>noID</b> (ligne sans projecteur : prêté, loué, autre), <b>Ajouter un projecteur du stock</b>, ou <b>Scanner un QR code</b>. Le bouton <b>⇄</b> remplace le projecteur par un autre du stock (l\'ancien quitte le spectacle).',
    '<b>Les gélatines et le reste de la saisie restent sur la ligne</b> (le circuit) quand l\'ID change. La liste « Projecteurs affectés » du spectacle suit.',
    '<b>Ajouter une ligne</b> : une ligne noID à remplir ; tu choisis ensuite son ID parmi les projecteurs du stock disponibles. <b>Suppr.</b> vide ou supprime une ligne (avec la question : retirer aussi le projecteur du spectacle ?).',
    '<b>Mode prépa</b> : pars d\'une feuille vide, lis le plan de feu et ajoute une ligne par projecteur (« + Ajouter une ligne », noID). Remplis position, circuit, gélatines, accessoires et le <b>modèle</b> (liste du catalogue ; pour un PAR, la lampe voulue). « Autre (texte libre) » sert si le modèle est inconnu ; le régisseur général et l\'admin peuvent <b>ajouter un modèle au catalogue</b>.',
    'Ensuite touche <b>noID</b> : la liste propose les projecteurs <b>du plus judicieux au moins judicieux</b> (même modèle, puis modèles similaires, puis les autres). Critères : disponibilité, puis, pour un PAR, la lampe déjà montée, puis la dernière position connue. Choisir un autre modèle est accepté, avec un avertissement.',
    '<b>Téléphone en paysage</b> : la feuille s\'affiche comme sur ordinateur (tableau complet, qui défile de côté si besoin).',
    '<b>PDF</b> : bouton « PDF », A4 paysage, avec la date et l\'heure de génération sur chaque page (important si le kit change) et la dernière modification de la feuille.'
  ] },
  { title: 'Le mur et les notifications', items: [
    '<b>Mur</b> : chaque spectacle a son mur (to-do, passation, horaires, problèmes techniques…). L\'onglet <b>Mur</b> réunit tous les messages ; un filtre permet de ne voir qu\'un spectacle.',
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
