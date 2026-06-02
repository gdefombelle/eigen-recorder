import type { CapacitorConfig } from '@capacitor/cli';

// ── Dev Live Reload ────────────────────────────────────────────────────────
// Set CAPACITOR_DEV=1 to load from local dev server instead of bundled assets.
// iPhone and MacBook must be on the same Wi-Fi network.
//
//   CAPACITOR_DEV=1 npm run cap:open   → opens Xcode, app loads from dev server
//   npm run cap:open                   → uses bundled build (production mode)
//
const DEV = process.env['CAPACITOR_DEV'] === '1';
const LOCAL_IP = '192.168.1.18';   // ← update if IP changes (check: ipconfig getifaddr en0)
const DEV_PORT = 5173;
// ──────────────────────────────────────────────────────────────────────────

const config: CapacitorConfig = {
  appId:   'com.eigenvertex.recorder',
  appName: 'Eigen Recorder',
  webDir:  'build',

  server: DEV
    ? {
        url:       `http://${LOCAL_IP}:${DEV_PORT}`,
        cleartext: true,                // allow HTTP (dev only)
      }
    : {
        androidScheme: 'https',
      },

  ios: {
    backgroundColor: '#0a0a0a',
    contentInset:    'always',
    scheme:          'eigenvertex-recorder',
  },
};

export default config;
