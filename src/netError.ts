// Messages d'erreur réseau lisibles (logique pure, sans réseau ni écran, donc testable).

/** Vrai si le message ressemble à une coupure réseau du navigateur (Chrome, Firefox, Safari) plutôt qu'à une erreur du serveur. */
export const isNetworkMessage = (msg: string): boolean => /failed to fetch|networkerror|network request failed|load failed|fetch failed|network error/i.test(msg);

/** Remplace le message technique (« TypeError: Failed to fetch ») par une phrase claire. `action` = true pour une action de l'utilisateur (pas une synchro). */
export function friendlyError(msg: string, action = false): string {
  if (!isNetworkMessage(msg)) return msg;
  return action
    ? "Réseau trop faible ou coupé : l'action n'a pas été envoyée. Réessaie quand la connexion est meilleure."
    : 'Réseau trop faible ou coupé : synchro impossible pour le moment. Touche « À jour » pour réessayer.';
}
