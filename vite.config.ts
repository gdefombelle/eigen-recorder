import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // Stamped into the bundle at build time and shown in Settings › Diagnostics.
  // Web assets live in ios/App/App/public and Xcode does not always re-embed
  // them on a plain Run, so a device can silently keep running an old bundle.
  // This makes "is the phone actually running this build?" answerable at a
  // glance instead of guessable.
  define: {
    // Local time, not toISOString(): a UTC stamp read on a phone showing local
    // time looks hours stale and sends you hunting a deployment problem that
    // isn't there.
    __BUILD_STAMP__: JSON.stringify(
      new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
        + ' local',
    ),
  },
  server: {
    // Dev proxy: /api/* → http://127.0.0.1:8100/*
    // Identical pattern to scanner-app — avoids CORS and Mixed Content.
    // Never reference the Docker container hostname here; always use localhost.
    proxy: {
      '/api': {
        target: process.env['VITE_API_TARGET'] ?? 'http://127.0.0.1:8100',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/api/, ''),
      },
      // WebSocket proxy for PCM audio stream in dev
      // ws://localhost:5173/ws/v1/knowledge-sessions/{id}/audio-stream → ws://localhost:8100/v1/...
      '/ws': {
        target: (process.env['VITE_API_TARGET'] ?? 'http://127.0.0.1:8100')
          .replace(/^https?/, 'ws'),
        ws: true,
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/ws/, ''),
      },
    },
  },
  plugins: [
    sveltekit(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      // Enable service worker in dev so Chrome shows the install button on localhost
      devOptions: {
        enabled: true,
        type: 'module',
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,ico,woff2}'],
        navigateFallback: '/index.html',
        runtimeCaching: []
      },
      manifest: {
        name: 'Eigen Pocket',
        short_name: 'EigenPkt',
        description: 'Eigen Pocket — Offline-First Audio Capture',
        theme_color: '#0d1526',
        background_color: '#070c1a',
        display: 'standalone',
        orientation: 'any',
        start_url: '/recorder',
        scope: '/',
        categories: ['productivity', 'utilities'],
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      }
    })
  ]
});
