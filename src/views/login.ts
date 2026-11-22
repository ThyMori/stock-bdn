import { supabase } from '../supabase';

const shell = (inner: string) => `<div class="login"><div class="card stack">
  <div class="stack" style="gap:6px"><h1 class="hero">Stock BdN</h1><div class="sub">Parc de projecteurs · Bouffes du Nord</div></div>${inner}</div></div>`;

export function showLogin(root: HTMLElement, onDone: () => void) {
  let revoked = false;
  try { revoked = sessionStorage.getItem('revoked') === '1'; sessionStorage.removeItem('revoked'); } catch { /* ignore */ }
  root.innerHTML = shell(`${revoked ? '<div class="banner err">Ton accès à l\'application a été révoqué. Contacte un administrateur si c\'est une erreur.</div>' : ''}<form class="stack" id="f">
    <label class="f">E-mail<input name="email" type="email" autocomplete="username" required></label>
    <label class="f">Mot de passe<input name="pw" type="password" autocomplete="current-password" required></label>
    <button class="btn primary">Se connecter</button><div id="err" class="sub warn" role="alert"></div>
    <button type="button" class="btn small" id="forgot">Mot de passe oublié</button>
    <button type="button" class="btn small" id="signup">Demander à s'inscrire</button></form>`);
  const err = root.querySelector<HTMLElement>('#err')!;
  const form = root.querySelector<HTMLFormElement>('#f')!;
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    const fd = new FormData(form);
    const { error } = await supabase.auth.signInWithPassword({ email: String(fd.get('email')).trim(), password: String(fd.get('pw')) });
    if (error) err.textContent = /banned/i.test(error.message) ? 'Ton accès à l\'application a été révoqué. Contacte un administrateur.' : /invalid/i.test(error.message) ? 'E-mail ou mot de passe incorrect.' : error.message;
    else { void supabase.rpc('log_login'); onDone(); }
  });
  root.querySelector('#signup')!.addEventListener('click', () => showSignupRequest(root, onDone));   // ouvre le formulaire de demande
  root.querySelector('#forgot')!.addEventListener('click', async () => {
    const email = String(new FormData(form).get('email') ?? '').trim();
    if (!email) { err.textContent = 'Saisis ton e-mail ci-dessus, puis reclique.'; return; }
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: new URL(import.meta.env.BASE_URL, location.origin).href });
    err.textContent = error ? error.message : 'Un lien de réinitialisation vient de t\'être envoyé.';
  });
}

/** Formulaire « Demander à s'inscrire » : l'accès se fait sur invitation, donc c'est une demande que les administrateurs examinent. */
export function showSignupRequest(root: HTMLElement, onDone: () => void) {
  root.innerHTML = shell(`<form class="stack" id="r"><h2>Demander à s'inscrire</h2>
    <div class="sub">L'accès se fait sur invitation. Un administrateur examine ta demande et, s'il l'accepte, tu reçois un e-mail d'invitation.</div>
    <label class="f">Prénom<input name="first_name" required maxlength="60" autocomplete="given-name"></label>
    <label class="f">Nom<input name="last_name" required maxlength="60" autocomplete="family-name"></label>
    <label class="f">E-mail<input name="email" type="email" required maxlength="120" autocomplete="email"></label>
    <label class="f">Message (facultatif)<textarea name="message" rows="3" maxlength="500" placeholder="Qui es-tu, pour quel spectacle ou quelle équipe ?"></textarea></label>
    <div style="position:absolute;left:-9999px" aria-hidden="true"><input name="website" tabindex="-1" autocomplete="off"></div>
    <button class="btn primary" id="send">Envoyer la demande</button><div id="err" class="sub warn" role="alert"></div>
    <button type="button" class="btn small" id="back">‹ Retour à la connexion</button></form>`);
  const form = root.querySelector<HTMLFormElement>('#r')!;
  const err = root.querySelector<HTMLElement>('#err')!;
  root.querySelector('#back')!.addEventListener('click', () => showLogin(root, onDone));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    if (!navigator.onLine) { err.textContent = 'Il faut une connexion pour envoyer la demande.'; return; }
    const btn = root.querySelector<HTMLButtonElement>('#send')!; btn.disabled = true;   // évite le double envoi
    const fd = new FormData(form);
    const { error } = await supabase.functions.invoke('push-notify', {
      body: { action: 'signup', first_name: fd.get('first_name'), last_name: fd.get('last_name'), email: fd.get('email'), message: fd.get('message'), website: fd.get('website') }
    });
    if (error) {
      btn.disabled = false;   // le texte saisi est conservé : on peut réessayer
      let m = 'Envoi impossible pour le moment, réessaie plus tard.';
      const res = (error as { context?: Response }).context;
      if (res?.status === 404) m = 'Cette fonction n\'est pas encore disponible : préviens un administrateur.';
      else { try { const j = await res?.json(); if (j?.error) m = j.error; } catch { /* ignore */ } }
      err.textContent = m; return;
    }
    root.innerHTML = shell(`<div class="stack"><h2>Demande envoyée ✓</h2>
      <div class="sub">Un administrateur va l'examiner. Si elle est acceptée, tu recevras un e-mail d'invitation pour choisir ton mot de passe.</div>
      <button class="btn primary" id="ok">Retour à la connexion</button></div>`);
    root.querySelector('#ok')!.addEventListener('click', () => showLogin(root, onDone));
  });
}

export function showSetPassword(root: HTMLElement, onDone: () => void) {
  root.innerHTML = shell(`<form class="stack" id="f"><h2>Choisis ton mot de passe</h2>
    <label class="f">Nouveau mot de passe (8 caractères min.)<input name="pw" type="password" autocomplete="new-password" minlength="8" required></label>
    <button class="btn primary">Enregistrer</button><div id="err" class="sub warn" role="alert"></div></form>`);
  root.querySelector('#f')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = String(new FormData(e.target as HTMLFormElement).get('pw'));
    const { error } = await supabase.auth.updateUser({ password: pw });
    if (error) root.querySelector('#err')!.textContent = error.message;
    else { history.replaceState(null, '', location.pathname); onDone(); }
  });
}

export function showConfigMissing(root: HTMLElement) {
  root.innerHTML = shell(`<p>L'appli n'est pas encore reliée à Supabase.</p>
    <p class="sub">Renseigne <code>VITE_SUPABASE_URL</code> et <code>VITE_SUPABASE_ANON_KEY</code> (fichier <code>.env</code> en local, ou « Variables » du dépôt GitHub) puis reconstruis l'appli. Voir le README.</p>`);
}
