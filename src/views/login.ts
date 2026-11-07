import { supabase } from '../supabase';

const shell = (inner: string) => `<div class="login"><div class="card stack">
  <div class="row"><img class="logo" src="${import.meta.env.BASE_URL}icon-192.png" alt=""><div><h1>Stock BdN</h1><div class="sub">Parc de projecteurs</div></div></div>${inner}</div></div>`;

export function showLogin(root: HTMLElement, onDone: () => void) {
  root.innerHTML = shell(`<form class="stack" id="f">
    <label class="f">E-mail<input name="email" type="email" autocomplete="username" required></label>
    <label class="f">Mot de passe<input name="pw" type="password" autocomplete="current-password" required></label>
    <button class="btn primary">Se connecter</button><div id="err" class="sub warn" role="alert"></div>
    <button type="button" class="btn small" id="forgot">Mot de passe oublié</button></form>`);
  const err = root.querySelector<HTMLElement>('#err')!;
  const form = root.querySelector<HTMLFormElement>('#f')!;
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); err.textContent = '';
    const fd = new FormData(form);
    const { error } = await supabase.auth.signInWithPassword({ email: String(fd.get('email')).trim(), password: String(fd.get('pw')) });
    if (error) err.textContent = /invalid/i.test(error.message) ? 'E-mail ou mot de passe incorrect.' : error.message;
    else onDone();
  });
  root.querySelector('#forgot')!.addEventListener('click', async () => {
    const email = String(new FormData(form).get('email') ?? '').trim();
    if (!email) { err.textContent = 'Saisis ton e-mail ci-dessus, puis reclique.'; return; }
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: new URL(import.meta.env.BASE_URL, location.origin).href });
    err.textContent = error ? error.message : 'Un lien de réinitialisation vient de t\'être envoyé.';
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
