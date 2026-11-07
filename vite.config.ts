import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// BASE_PATH vaut "/<nom-du-depot>/" sur GitHub Pages (défini dans le workflow), "/" en local.
const base = process.env.BASE_PATH || '/';

export default defineConfig({
  base,
  build: { target: 'es2020' },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Stock BdN',
        short_name: 'Stock BdN',
        description: 'Parc de projecteurs – Bouffes du Nord',
        lang: 'fr',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        id: base,
        start_url: base,
        scope: base,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        globIgnores: ['**/*latin-ext*', '**/*vietnamese*'], // le sous-ensemble « latin » couvre le français
        navigateFallback: 'index.html',
        // les appels Supabase ne sont jamais mis en cache par le service worker :
        // la donnée hors ligne est gérée par l'appli (IndexedDB).
        runtimeCaching: []
      }
    })
  ]
});
