# Eigen Meeting — Architecture Reference

> Technical Reference · 2025  
> SvelteKit 4 · Capacitor · iOS · PWA · WebSocket streaming

---

## 01 — System Architecture

### Surfaces

| Surface | Details |
|---|---|
| iOS App (Capacitor) | WKWebView + native plugins |
| PWA · installable | Chrome / Safari, manifest via virtual:pwa-info |
| Web Browser | Non-installed, full feature set |

Routes: `/recorder` · `/recorder/new` · `/recorder/session/[id]` · `/recorder/offline` · `/settings`

---

### Application — SvelteKit 4 · adapter-static · SSR=false

- `recorderStore` — Svelte 4 writable store, central state machine
- `authStore` — JWT in `localStorage` key `ev_token`
- Session form · Recording UI · Session history · Settings

**State machine:**
```
idle → creating → ready → recording ↔ paused → stopping → stopped / error
```

---

### Audio Capture — two parallel paths

**Stream path (authenticated + online):**
```
getUserMedia (mono, no AGC)
  → AudioContext (16 kHz hint)
  → AudioWorklet (inline blob URL)
  → downmix + resample
  → Int16Array 320 ms frames
  → WebSocket binary send
```

**Local path (always available):**
- Web: `MediaRecorder` — WebM+Opus preferred, `timeslice: 5000 ms`
- iOS native: `AVAudioRecorder` via `EigenAudioPlugin` — M4A AAC 48 kHz stereo, 5 s segments

---

### Native Bridge — Capacitor 8 *(iOS only)*

| Component | Role |
|---|---|
| `EigenAudioPlugin` (Swift + ObjC) | AVAudioRecorder, mic levels, keep-awake |
| `@capacitor/geolocation` | CLLocationManager — session location tagging |
| Screen Wake Lock API | iOS 16.4+ — keeps screen on during recording/pause |
| `UIApplication.isIdleTimerDisabled` | Fallback for < iOS 16.4 |

Web engine fallback on iOS: `getAudioEngine() === 'web'` → MediaRecorder via WKWebView.

---

### Local Storage — offline-first, no account required

**IndexedDB** · DB name: `eigen-recorder` *(frozen — see gotchas)* · via `idb` library

| Store | Key | Contents |
|---|---|---|
| `sessions` | `local_session_id` | `LocalKnowledgeSession` metadata |
| `chunks_meta` | `local_chunk_id` | `AudioChunkMetadata`, by-session index |
| `chunks_data` | `local_chunk_id` | Raw `Blob` |

Chunk lifecycle: `saved → pending_sync → uploaded`  
Audio is always written to IndexedDB **before** any upload attempt.

---

### EigenVertex API *(optional — requires account)*

| Method | Endpoint |
|---|---|
| POST | `/v1/knowledge-sessions` |
| POST | `/v1/knowledge-sessions/{id}/recorder-sync` |
| POST | `/v1/knowledge-sessions/{id}/devices` |
| POST | `/v1/knowledge-sessions/{id}/start` |
| POST | `/v1/knowledge-sessions/{id}/stop` |
| POST | `/v1/knowledge-sessions/{id}/audio-chunks` |
| WSS  | `/v1/knowledge-sessions/{id}/audio-stream?device_id=…` |
| GET  | `/v1/knowledge-sessions/recordable` |

Auth: JWT Bearer in `Authorization` header.  
API base: `https://api.eigenvertex.com/v1` (prod) · `/api/v1` via Vite proxy (dev).  
Configurable via `ev_server_url` in localStorage.

---

### Backend Services *(out of scope)*

FastAPI · PostgreSQL · S3 · Voxtral (Mistral ASR) · Qdrant · FalkorDB

---

**Legend**

- Blue left border → application / stream pipeline (always active)
- Green left border → offline-first local storage
- Dashed border → optional, requires EigenVertex account

---

## 02 — Recording Session Flow

### Stream Mode — authenticated + online

```
1. Session form → createSession()
   POST /knowledge-sessions (or /recorder-sync)
   → POST /devices · POST /start

2. Geolocation
   @capacitor/geolocation on iOS
   navigator.geolocation on web/PWA

3. PcmCapture.start()
   getUserMedia mono · AudioContext 16 kHz
   AudioWorklet inline blob URL

4. LiveStreamClient.connect()
   WSS …/audio-stream?device_id=…
   session_hello handshake · 8 s connect timeout

5. sendFrame() — every 320 ms
   ws.send(JSON meta) + ws.send(PCM16 binary)
   Reconnect: 3× linear back-off — 1.5 / 3 / 4.5 s

6. Pause → AudioContext.suspend()
   WS stays open, no frames sent
   Screen stays awake (wake lock active)

7. Stop → commit()
   session_commit message · WS close 1000
   Backup MediaRecorder.stop() → IndexedDB
   POST /stop
```

---

### Local Mode — offline-first

```
1. Session form → createSession()
   API calls skipped if offline / unauthenticated
   Draft saved to IndexedDB immediately

2. Geolocation (same as stream mode)

3a. Web: AudioRecorder.start()
    MediaRecorder · WebM+Opus · timeslice 5 000 ms

3b. iOS native: NativeAudioRecorder.start()
    EigenAudioPlugin → AVAudioRecorder
    M4A AAC 48 kHz stereo · 5 s segments

4. handleChunk() — every 5 s
   offlineStorage.saveChunk() first (always)
   then uploadAudioChunk() async if online

5. POST …/audio-chunks
   multipart/form-data
   Tracked in _inflightUploads Map
   Status: saved → pending_sync → uploaded

6. Stop → _flushUploads()
   Promise.allSettled all in-flight uploads
   Retry any saved / pending_sync chunks from IndexedDB
```

---

## 03 — Key Technical Notes

### IndexedDB name frozen at rename

The app was renamed **Eigen Recorder → Eigen Meeting** but `DB_NAME = 'eigen-recorder'` in `offlineStorage.ts` was intentionally **not** changed. Renaming it would silently orphan every recording on existing installs — the old DB stays in the browser, the new code opens a different one and sees nothing. Any future migration requires an explicit IndexedDB rename/copy strategy.

---

### PCM frames lost during WS reconnect

`sendFrame()` is a no-op when `ws.readyState !== OPEN`. With up to 3 reconnect attempts at linear back-off (1.5 / 3 / 4.5 s), up to ~13.5 s of audio can be silently lost. The backup MediaRecorder saves only at Stop, not per-frame — reconnect gaps are unrecoverable from the local copy as well.

---

### iOS geolocation: silent denial without Info.plist key

Without `NSLocationWhenInUseUsageDescription` in `Info.plist`, iOS sets `authorizationStatus` to `.denied` without any permission dialog. `requestPermissions()` returns `denied` in under 50 ms — the geo spinner flashes and disappears with no error surfaced to the user.

---

### vite-plugin-pwa ↔ adapter-static incompatibility

VitePWA's `transformIndexHtml` hook never fires on adapter-static output — the manifest `<link>` and SW script are absent from production HTML. Fix: import `pwaInfo` from `virtual:pwa-info` and inject `{@html manifestLinkTag}` via `<svelte:head>` in `+layout.svelte`, paired with `useRegisterSW()` from `virtual:pwa-register/svelte`. Without this, Chrome never offers the install button.
