> **Archive.** Le panneau « Scan spike » et la sonde native décrits ci-dessous ont été retirés du build (dernier commit qui les contient : `bb1ff5b`).
> Seuls restent valables les outils externes : `scripts/spike/analyze-audio.py` (+ `--make-counting`) et la lecture du transcript.
> Le protocole à suivre aujourd'hui est `docs/scan-step4-gate.md`.

# Spike « Scanner un document » : continuité de l'audio

Étape 1, **bloquante** : le scanner natif (VisionKit, plugin de DocScan porté tel quel, présenté dans une
fenêtre isolée) laisse-t-il l'audio et le flux intacts pendant un record ?

**Règle d'arrêt** : si un seul critère échoue, on s'arrête, on note lequel et ce qui a été observé
(rapport JSON, sortie de l'analyse, console Xcode), et on rediscute. Rien n'est construit au-dessus tant que
ce spike n'est pas passé.

## Ce qui est mesuré, et par quoi

| Critère | Mesuré par |
|---|---|
| WebSocket connecté, sans reconnexion ni rechargement de la WebView | `webview_stable`, `stream_stayed_connected`, `stream_frames_continuous` (rapport de l'app) ; côté serveur : un seul `session_hello` sans `is_reconnect` pour l'appareil |
| Durée finale de l'audio = durée réelle ± 1 s | `analyze-audio.py`, contrôle `duration` |
| Aucun silence > 500 ms aux instants des scans | `analyze-audio.py`, contrôle `no_silence_at_scans` (fenêtre du scan ± 1,5 s) |
| Transcript serveur continu autour des scans (mode Stream) | lecture du transcript (voir 5) |
| Aucun crash du processus GPU de la WebView ; app stable après le scan | `webview_stable` (un rechargement laisse une trace même si l'écran se rouvre), console Xcode, et l'app reste utilisable (voir 4) |

Deux indicateurs sont **informatifs** (ils ne font pas échouer le spike mais sont à rapporter) :
`app_stayed_active` (l'app a-t-elle perdu l'état actif ?) et `webview_timers_not_frozen` (le fil JS de la
WebView a-t-il été gelé plus d'une seconde ?). Une interruption de la session audio iOS
(`no_audio_session_interruption`) est, elle, un critère dur.

Limite à connaître : l'horloge audio de l'app (`audio_clock_follows_wall`) est une horloge, pas un échantillon
audio. Seule l'analyse du **fichier final** prouve qu'il n'y a pas de trou.

## 1. Préparation (Mac)

```
npm run cap:sync          # build web + sync Capacitor (le plugin natif est déjà dans le projet Xcode)
npm run cap:open          # puis Cmd+R sur l'iPhone
```

Source sonore **continue** (la parole humaine a des pauses naturelles qui ressemblent à des coupures) :

```
python3 scripts/spike/analyze-audio.py --make-counting counting.aiff    # ≈ 3 min de comptage, sans silence ≥ 500 ms
```

Vérification de l'outil lui-même (8 cas synthétiques, doivent tous afficher `ok`) :

```
sh scripts/spike/analyze-audio.selftest.sh
```

Sur l'iPhone : **Réglages → Diagnostics → « Scan spike »** : cocher. Ne pas supprimer l'app.

Dans Xcode, ouvrir la console (Cmd+Shift+Y) et filtrer sur `DocumentScanner` puis `ScanSpikeProbe` : les
événements audio et de cycle de vie iOS y sont tracés. Garder la console jusqu'à la fin du test.

## 2. Déroulé (à faire deux fois : « Stream EigenVertex » PUIS « Local seulement »)

1. Choisir le mode sur l'écran de nouveau record.
2. Poser l'iPhone, lancer le chrono, lancer `afplay counting.aiff` à ~30 cm du téléphone (volume constant),
   **puis** toucher REC.
3. Ne rien faire pendant ~30 s. Puis, depuis le panneau orange « TEST SCAN », scanner :
   - vers **0:30** : bouton **1 p.** : scanner 1 page, toucher « Enregistrer » ;
   - vers **1:15** : bouton **5 p.** : scanner 5 pages, « Enregistrer » ;
   - vers **2:00** : bouton **10 p.** : scanner 10 pages, « Enregistrer ».
   Entre deux scans, laisser le record tourner sans toucher à rien.
4. À **3:00** : TERMINER. Noter la durée réelle lue sur le chrono (en secondes).

Le panneau affiche, après chaque scan, la liste des vérifications (✓ ou ✗). Les prendre en photo si un ✗ apparaît.

## 3. Récupérer les résultats

- Toucher **Copier le rapport** (l'écran du record, avant de le quitter) et coller le JSON dans un fichier
  `rapport-stream.json` (puis `rapport-local.json`). Le journal est conservé dans l'app : on peut le recopier
  plus tard depuis un nouveau record tant qu'on ne touche pas « Effacer ».
- Exporter l'audio final : **Share Audio** (AirDrop vers le Mac). C'est le fichier local.
- Mode Stream : récupérer aussi l'**audio côté serveur** si possible
  (`GET /v1/knowledge-sessions/<id>/audio`, avec votre jeton), car c'est celui que le flux a réellement produit.

## 4. Stabilité après le scan

Après le dernier scan, sans quitter l'écran du record : ajouter une photo avec le trombone, ouvrir « Tout voir »,
puis terminer le record. Rien ne doit se recharger, se figer ou se fermer. Noter toute anomalie visible
(écran blanc, rechargement, perte de l'état du record).

## 5. Analyse

```
python3 scripts/spike/analyze-audio.py audio-local.m4a  --real-seconds 180 --report rapport-local.json
python3 scripts/spike/analyze-audio.py audio-serveur.m4a --real-seconds 180 --report rapport-stream.json
```

Passer la durée réelle notée au chrono. Sortie : `PASS`/`FAIL` par critère, la liste des silences, et les
avertissements (silences hors fenêtres de scan : avec la source continue, tout silence est suspect). Code de
sortie 0 = succès.

**Seuil de silence** : `--noise-db -50` par défaut (le silence numérique d'un vrai trou est très en dessous du
bruit de la pièce). Si l'analyse signale des silences partout, y compris loin des scans, c'est le bruit de
fond qui est trop bas pour ce seuil : relancer avec `--noise-db -60` et le dire.

**Transcript (mode Stream)** : ouvrir « Open session content » du record. Le comptage doit se suivre sans
numéro manquant autour de chaque fenêtre de scan (`audioWindowMs` dans le rapport, ± 3 s). Un numéro absent
ou répété autour d'un scan est un échec.

## 6. À rapporter

Pour chacun des deux modes : le rapport JSON, la sortie de `analyze-audio.py`, la durée réelle, ce que dit le
transcript, et toute ligne de la console Xcode contenant `interruption`, `route change`, `resign`,
`media services` ou un message de fin du processus WebContent.
