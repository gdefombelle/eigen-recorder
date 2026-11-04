# Eigen Pocket 1.1 (build 6) : préparation App Store

Statut au 2026-11-04 (fin de journée). Version 1.1, build 6. Les derniers commits (scanner web PWA, privacy, correctif du manifeste)
sont locaux tant que `git push` n'a pas été fait. Le gate du scan n'a pas été passé (risques acceptés : `docs/scan-step4-gate.md`).

## 1. Avant d'archiver
- [x] Version 1.1, build 6 (`MARKETING_VERSION`, `CURRENT_PROJECT_VERSION`), `ITSAppUsesNonExemptEncryption = false`
- [x] `npm run cap:sync` et build Release iPhone (sans signature) réussis ; 435 tests, 0 erreur svelte-check
- [x] `PrivacyInfo.xcprivacy` (les deux copies) : audio, position précise, photos/vidéos et autre contenu utilisateur, tous **liés**, sans suivi
- [x] **Correctif** : ce fichier n'était pas copié dans l'app (absent des ressources du projet) ; vérifié présent dans une archive Release
- [x] Texte du micro corrigé (Stream = envoi en direct)
- [x] Archive Release iPhone générée et vérifiée en local (1.1, build 6, manifeste de confidentialité présent) ; elle n'est pas envoyée
- [ ] `git push`
- [ ] Xcode : « Any iOS Device (arm64) » → Product → Archive → Distribute App → App Store Connect
- [ ] Ne pas supprimer l'app sur l'iPhone avant d'installer un build de test (sessions locales non envoyées)

## 2. App Store Connect → Confidentialité de l'app
Les quatre types ci-dessous reflètent ce que fait l'app (tout est envoyé dans le compte de l'utilisateur, aucun suivi,
finalité « Fonctionnalités de l'app » uniquement).

| Type | Collecté | Lié à l'utilisateur | Suivi |
|---|---|---|---|
| Photos ou vidéos (photos, pages scannées) | Oui | **Oui** | Non |
| Autre contenu utilisateur (documents, PDF de scan) | Oui | **Oui** | Non |
| Données audio | Oui | **Oui** | Non |
| Position précise | Oui | **Oui** | Non |

`PrivacyInfo.xcprivacy` est maintenant aligné sur ces quatre réponses (Liées : Oui).
Questions tiers (4.3.4 de `docs/privacy-pieces-jointes.md`) : répondre selon l'infrastructure réelle (stockage objet,
éventuels fournisseurs d'IA) ; aucune pièce n'est analysée automatiquement par l'app.

## 3. Textes de la fiche (à adapter)

**Nouveautés, français**
> Pièces jointes pendant l'enregistrement : prenez une photo, choisissez des images ou des documents, ou scannez un
> document (détection des bords, PDF multipages) sans interrompre l'audio. Elles sont placées sur la timeline du record
> et envoyées automatiquement, même si le réseau revient plus tard. Statuts d'envoi plus précis, relance automatique de
> la fin de record, et les notes « Local » déjà terminées côté serveur passent désormais en « Envoyée ».

**What's New, English**
> Attachments while you record: take a photo, pick images or documents, or scan a document (edge detection,
> multi-page PDF) without interrupting the audio. They are placed on the record's timeline and sent automatically, even
> if the network comes back later. Clearer sending statuses, automatic retry when a record ends, and "Local" notes already
> finished on the server now show as "Sent".

## 4. Notes pour l'équipe de review (anglais)
> Eigen Pocket records meeting audio and lets the user attach photos, documents and document scans to a recording.
> The camera (photo or VisionKit document scanner) is only opened by the user during a recording and the audio keeps
> recording meanwhile. Photos and scans are sent to the user's own EigenVertex account. Sign-in uses the user's
> EigenVertex account: [identifiants de test à renseigner avant l'envoi].

## 5. Hors fichiers de l'app
- Politique de confidentialité : ajouter photos, documents et scans (nature, finalité, durée de conservation, sous-traitants).
- Suppression : supprimer une pièce est une suppression logique côté serveur (le fichier reste dans le stockage) ; la
  formulation de la politique et la suppression de compte doivent le refléter (règle Apple 5.1.1(v)).
- Scanner web (PWA) : intégré (composant de DocScan), vérifié sur Chrome desktop avec une caméra factice ; **non testé sur un iPhone en PWA** (micro du record pendant que la caméra tourne, OpenCV.js téléchargé au premier scan). Voir `docs/scan-step4-gate.md`.
