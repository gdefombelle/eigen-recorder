# Scan de document : gate de l'étape 4 (à faire sur l'iPhone, avant tout merge ou release)

**Règle** : si un critère échoue, on ne livre pas. On masque l'entrée (`SCAN_ENTRY_ENABLED = false` dans
`src/lib/recorder/scan/scanEngine.ts`), on note lequel et ce qui a été observé, et on rediscute. Rien n'est poussé
avant.

État des preuves au 2026-11-04 (honnête) : le spike n'a mesuré que 2 scans d'**une** page en Stream. Jamais de
5 ni de 10 pages, aucune analyse du fichier audio exporté, ni transcript, ni `session_hello` serveur, ni mode Local.
Le « mode avion » du premier essai est classé non applicable (flux déjà à l'arrêt avant le scan).

## Préparation
1. `npm run cap:sync`, puis Cmd+R dans Xcode **sans supprimer l'app** (des sessions locales non envoyées seraient perdues).
2. Réglages → Diagnostics → cocher « Scan spike » : la sonde reste active et rapporte, avant et après chaque scan,
   la catégorie, le mode et les options de la session audio (contrôle `audio_session_config_unchanged`). La session
   audio n'est **pas** modifiée : on regarde d'abord si le son change.
3. Source sonore continue : `python3 scripts/spike/analyze-audio.py --make-counting counting.aiff`, puis `afplay counting.aiff`
   près du téléphone avant de toucher REC.
4. Console Xcode (Cmd+Shift+Y) filtrée sur `DocumentScanner` puis `ScanSpikeProbe`.

## Cas à passer : 3 scans de **vrais** documents (1, 5 et 10 pages) pendant un record de 3 min

À faire **deux fois** : « Stream EigenVertex », puis « Local seulement ».

Utiliser le vrai parcours : trombone → « Scanner un document », scanner les pages demandées (vraies feuilles, bords
visibles), toucher « Enregistrer » dans VisionKit. Scans vers 0:30 (1 page), 1:15 (5 pages), 2:00 (10 pages).
Si VisionKit s'arrête avant le nombre de pages voulu, **le noter** (pages réellement obtenues, ce que vous avez touché).

| # | Critère | Comment le mesurer | Seuil |
|---|---|---|---|
| 1 | WebSocket sans reconnexion (Stream) | logs serveur : un seul `session_hello` sans `is_reconnect` pour l'appareil | 1 hello |
| 2 | WebView non rechargée, pas de crash GPU, app stable | panneau (`webview_stable`), console Xcode, l'app reste utilisable (photo, « Tout voir », terminer) | aucun rechargement |
| 3 | Durée de l'audio final | `analyze-audio.py <audio> --real-seconds N --report rapport.json` | durée réelle ± 1 s |
| 4 | Silences aux instants des scans | même commande (fenêtre du scan ± 1,5 s) | aucun silence > 500 ms |
| 5 | Transcript continu (Stream) | « Open session content » : le comptage se suit sans numéro manquant ni répété autour de chaque scan | continu |
| 6 | Session audio | rapport : `audio_session_config_unchanged`, `no_audio_session_interruption` | à rapporter ; une interruption = échec |

## Mesures de la fonction elle-même (à noter, 1 / 5 / 10 pages, dans les deux modes)
- **Temps par page** : de « Enregistrer » dans VisionKit jusqu'à l'apparition de la carte « Scan mm:ss » dans la bande.
- **Taille du PDF** : affichée dans la liste (Tout voir) ; si elle dépasse 25 Mo, l'app a dû recompresser : un message le dit.
- **Mémoire** : Xcode → onglet Debug navigator → Memory pendant le scan de 10 pages ; noter le pic. Aucun avertissement mémoire.
- **Fichiers temporaires nettoyés** : après le scan, `eigen-scan` du dossier temporaire de l'app doit être vide
  (Xcode → Window → Devices and Simulators → l'app → Download Container → `tmp/eigen-scan/`).
- **Annulation** : annuler dans VisionKit après quelques pages (VisionKit demande lui-même de confirmer l'abandon) : rien n'est ajouté.
- **Reprise depuis l'arrière-plan** : lancer un scan, passer l'app en arrière-plan puis revenir : ni plantage, ni scan fantôme.
- **Hors ligne puis reconnexion** : mode avion, scanner (carte « En attente » / « Hors ligne »), couper le mode avion et
  ouvrir l'app : la pièce part une fois, statut « Prêt », un seul fichier côté serveur.
- **Bornes de l'offset** : la pièce est placée à l'instant d'ouverture de la feuille (début) ; `end_offset_ms` = fermeture du scanner.
  Dans « Tout voir », la carte indique l'instant d'ouverture.
- **Cas à part, trop gros** : un scan de beaucoup de pages (30+) doit soit tenir sous 25 Mo après recompression, soit
  afficher « Le scan fait N Mo, même à qualité réduite (limite : 25 Mo). Scannez moins de pages à la fois. » sans rien ajouter.

## À me renvoyer
Par mode : le rapport JSON (« Copier le rapport »), la sortie d'`analyze-audio.py`, la durée réelle lue au chrono, ce que
dit le transcript, les lignes de la console Xcode contenant `interruption`, `route change`, `resign`, `media services`,
les logs serveur (`session_hello`), et les mesures ci-dessus. Je réponds critère par critère, sans conclure sur un
critère non mesuré.
