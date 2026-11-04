# Scan de document : état réel et gate de l'étape 4

> ## ⚠ Ne pas passer le réglage à « activé par défaut » tant que le gate ci-dessous n'est pas passé
> L'entrée « Scanner un document » n'apparaît dans la feuille « Ajouter au record » que si
> **Réglages → Diagnostics → « Scanner un document (expérimental) »** est activé (désactivé par défaut,
> clé `ev_scan_enabled`, `src/lib/recorder/scan/scanSetting.ts`). Elle est de toute façon toujours masquée dans la PWA.
> Un build livré à d'autres utilisateurs ne montre donc pas le scan tant qu'on n'a pas décidé de le faire.
> Le panneau de test « Scan spike » et sa sonde native ont été **retirés** du build (la version livrée n'en contient plus) ;
> ils restent récupérables dans l'historique git (dernier commit qui les contient : `bb1ff5b`) si on veut refaire des mesures.

## État réel au 2026-11-04 (décision de Gabriel : on boucle sans passer le gate)

**Prouvé** (iPhone, mode Stream, record en cours, scans d'une page, mesures du panneau « Scan spike », aujourd'hui retiré) :
- horloge audio de l'app = temps réel (+13 134 ms pour +13 135 ms ; +11 724 ms pour +11 724 ms) ;
- flux resté `streaming`, frames envoyées au rythme attendu (41 pour ~40 ; 36 pour ~37) ;
- aucune interruption de la session audio, aucun reset des services média, aucun changement de route pendant le scan ;
- WebView non rechargée, aucun gel de timer notable (64 ms et 8 ms au plus), app restée active.

**Observé par Gabriel sur l'iPhone** (captures du 2026-11-04, pas de mesure automatisée) :
- la feuille affiche les 4 entrées, la bande affiche « Scan mm:ss » avec la vraie page 1 en vignette et le badge « N p. » ;
- les PDF partent (coche verte « Prêt »), sont lisibles, la vignette est dans le bon sens, et la pièce arrive dans Eigen Studio.

**NON prouvé** (rien de ceci n'a été mesuré) :
- scans de **5 et de 10 pages** (tous les scans réels faits sont d'une seule page ; deux essais « 5 p. » n'ont rendu qu'une page, cause inconnue) ;
- **analyse du fichier audio exporté** : durée à ± 1 s, silences de plus de 500 ms aux instants des scans (l'horloge de l'app n'est pas un échantillon audio) ;
- **transcript du comptage** continu autour des scans (mode Stream) ;
- **un seul `session_hello`** côté serveur (pas de reconnexion du WebSocket) ;
- **mode « Local seulement »** (micro natif) ;
- **comportement PWA** : l'ouverture de la caméra suspend-elle la page / coupe-t-elle le micro ? (entrée masquée en attendant) ;
- sur appareil : recompression sous 25 Mo, mémoire sur 10 pages, nettoyage des temporaires, reprise depuis l'arrière-plan, envoi hors ligne puis reconnexion (ces deux derniers ne sont couverts que par des tests automatisés) ;
- le faux échec du « mode avion » (flux déjà à l'arrêt avant le scan) est classé non applicable.

## Reste à faire plus tard
1. **Gate complet** (section suivante), avant d'envisager l'activation par défaut ou une release avec le scan.
2. **`PrivacyInfo.xcprivacy` et « App Privacy » d'App Store Connect** à mettre à jour avant la prochaine soumission
   (propositions non appliquées : `docs/privacy-pieces-jointes.md`, sections 2, 3 et 6).
3. **Test PWA** de la caméra et du micro (voir ci-dessus).

---

## Gate de l'étape 4 (à faire sur l'iPhone, avant tout merge ou release)

**Règle** : si un critère échoue, on ne livre pas. On garde le réglage désactivé par défaut (ou on masque l'entrée), on note lequel et ce qui a été observé, et on rediscute. Rien n'est poussé
avant.

État des preuves au 2026-11-04 (honnête) : le spike n'a mesuré que 2 scans d'**une** page en Stream. Jamais de
5 ni de 10 pages, aucune analyse du fichier audio exporté, ni transcript, ni `session_hello` serveur, ni mode Local.
Le « mode avion » du premier essai est classé non applicable (flux déjà à l'arrêt avant le scan).

## Préparation
1. `npm run cap:sync`, puis Cmd+R dans Xcode **sans supprimer l'app** (des sessions locales non envoyées seraient perdues).
2. Activer Réglages → Diagnostics → « Scanner un document (expérimental) ». Le panneau et la sonde qui mesuraient
   l'horloge audio, le flux et la session audio ne sont plus dans le build : pour ces mesures, les restaurer depuis `bb1ff5b`
   (`git checkout bb1ff5b -- <fichiers spike>`), ou se contenter de l'analyse du fichier audio, du transcript et des logs serveur.
3. Source sonore continue : `python3 scripts/spike/analyze-audio.py --make-counting counting.aiff`, puis `afplay counting.aiff`
   près du téléphone avant de toucher REC.
4. Console Xcode (Cmd+Shift+Y) filtrée sur `DocumentScanner`.

## Cas à passer : 3 scans de **vrais** documents (1, 5 et 10 pages) pendant un record de 3 min

À faire **deux fois** : « Stream EigenVertex », puis « Local seulement ».

Utiliser le vrai parcours : trombone → « Scanner un document », scanner les pages demandées (vraies feuilles, bords
visibles), toucher « Enregistrer » dans VisionKit. Scans vers 0:30 (1 page), 1:15 (5 pages), 2:00 (10 pages).
Si VisionKit s'arrête avant le nombre de pages voulu, **le noter** (pages réellement obtenues, ce que vous avez touché).

| # | Critère | Comment le mesurer | Seuil |
|---|---|---|---|
| 1 | WebSocket sans reconnexion (Stream) | logs serveur : un seul `session_hello` sans `is_reconnect` pour l'appareil | 1 hello |
| 2 | WebView non rechargée, pas de crash GPU, app stable | console Xcode, l'app reste utilisable (photo, « Tout voir », terminer) | aucun rechargement |
| 3 | Durée de l'audio final | `analyze-audio.py <audio> --real-seconds N --report rapport.json` | durée réelle ± 1 s |
| 4 | Silences aux instants des scans | même commande (fenêtre du scan ± 1,5 s) | aucun silence > 500 ms |
| 5 | Transcript continu (Stream) | « Open session content » : le comptage se suit sans numéro manquant ni répété autour de chaque scan | continu |
| 6 | Session audio | console Xcode : aucune ligne d'interruption / `route change` pendant le scan (la sonde qui rapportait catégorie/mode/options est retirée) | une interruption = échec |

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
Par mode : la sortie d'`analyze-audio.py`, la durée réelle lue au chrono, ce que
dit le transcript, les lignes de la console Xcode liées à l'audio,
les logs serveur (`session_hello`), et les mesures ci-dessus. Je réponds critère par critère, sans conclure sur un
critère non mesuré.
