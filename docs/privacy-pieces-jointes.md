# Pièces jointes — confidentialité App Store (à valider, rien d'appliqué)

Statut : **proposition**. Aucun fichier du dépôt n'a été modifié pour cela.
**À faire avant la prochaine soumission** : appliquer `PrivacyInfo.xcprivacy` et mettre à jour « App Privacy » dans App Store Connect (non fait ; voir aussi la section 6 pour le scan).
Rédigé pour la resoumission qui inclut les pièces jointes (photos et documents
ajoutés pendant un record).

Limite : je n'ai pas accès à App Store Connect. Les intitulés ci-dessous suivent
la taxonomie publique d'Apple telle que je la connais ; vérifiez le libellé exact
dans l'interface avant de cocher.

---

## 1. Ce que fait la fonctionnalité (faits vérifiés dans le code)

| Fait | Source |
|---|---|
| Photos prises avec la caméra ou choisies dans la photothèque, documents (PDF, Word, Excel, PowerPoint) choisis dans Fichiers | `attachmentPicker.ts` |
| Les photos sont ré-encodées en JPEG (côté long ≤ 2048 px) : **les métadonnées EXIF, dont le GPS, ne sont pas conservées** | `imagePrep.ts` (passage par canvas) |
| Fichier copié dans IndexedDB sur l'appareil dès l'ajout, puis **envoyé au compte EigenVertex** de l'utilisateur dès que la session existe côté serveur et que le réseau est là | `attachmentQueue.ts` |
| Envoi automatique, sans geste supplémentaire de l'utilisateur (contrairement à l'audio en mode « Local seulement », qui attend le partage) | idem : la file part dès que `knowledge_session_id` existe |
| Destination serveur : `session` (par défaut, le client n'envoie pas `destination_mode`) → fichier stocké dans le stockage objet, rattaché à la session ; pas d'ingestion dans un corpus ni de traitement automatique | `knowledge_sessions.py` (POST `/attachments`) |
| **Suppression = suppression logique** : `deleted_at` est posé, `storage_deleted: false`, le fichier **reste dans le stockage objet** pour une pièce relationnelle | `knowledge_sessions.py`, DELETE `/attachments/{id}` |
| Aucun tracking, aucun SDK publicitaire ajouté. Nouveau plugin natif : `@capacitor/camera` (dépend de `ion-ios-camera`) | `Package.swift`, `Package.resolved` |

---

## 2. `PrivacyInfo.xcprivacy` — modifications exactes proposées

Il existe **deux copies identiques** du fichier (vérifié avec `diff`) :
`ios/App/PrivacyInfo.xcprivacy` et `ios/App/App/PrivacyInfo.xcprivacy`.
Appliquer la même modification aux deux.

### 2.1 Ajouter dans `NSPrivacyCollectedDataTypes` (après l'entrée « Precise location »)

```xml
        <!-- Photos prises ou choisies pendant un record — envoyées au compte EigenVertex -->
        <dict>
            <key>NSPrivacyCollectedDataType</key>
            <string>NSPrivacyCollectedDataTypePhotosorVideos</string>
            <key>NSPrivacyCollectedDataTypeLinked</key>
            <true/>
            <key>NSPrivacyCollectedDataTypeTracking</key>
            <false/>
            <key>NSPrivacyCollectedDataTypePurposes</key>
            <array>
                <string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
            </array>
        </dict>

        <!-- Documents (PDF, Word, Excel, PowerPoint) joints à un record — envoyés au compte EigenVertex -->
        <dict>
            <key>NSPrivacyCollectedDataType</key>
            <string>NSPrivacyCollectedDataTypeOtherUserContent</string>
            <key>NSPrivacyCollectedDataTypeLinked</key>
            <true/>
            <key>NSPrivacyCollectedDataTypeTracking</key>
            <false/>
            <key>NSPrivacyCollectedDataTypePurposes</key>
            <array>
                <string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
            </array>
        </dict>
```

### 2.2 Décision à prendre : `Linked` à `true` ou `false` ?

- Les entrées existantes (audio, position) sont à **`false`**.
- Je propose **`true`** pour les nouvelles : les pièces sont envoyées dans le
  compte authentifié de l'utilisateur, donc rattachées à son identité. Apple
  définit « lié à l'utilisateur » comme une donnée associée à son compte ou à
  son appareil.
- **Incohérence à traiter** : la même logique s'applique à l'audio et à la
  position (envoyés au compte). Si `true` est le bon choix pour les photos, il
  l'est probablement aussi pour l'audio et la position. Je n'ai pas modifié
  les entrées existantes ; c'est une déclaration qui engage l'éditeur.
  Recommandation : aligner les quatre sur la réalité, et répondre de la même
  façon dans App Store Connect (section 3).

### 2.3 Ce qui n'a pas besoin de changer

- `NSPrivacyAccessedAPITypes` : la bibliothèque caméra embarque son propre
  manifeste (`ion-ios-camera`) qui déclare `FileTimestamp` (raisons `C617.1` et
  `3B52.1`) et, de son côté, `PhotosorVideos` avec `Linked = false`. Xcode
  agrège les manifestes des paquets ; rien à ajouter pour les API « required reason ».
- `NSPrivacyTracking` reste à `false`, `NSPrivacyTrackingDomains` reste vide.
- `Info.plist` : `NSCameraUsageDescription` et `NSPhotoLibraryUsageDescription`
  sont déjà ajoutés (commit `adf7ce2`).
- Remarque : le manifeste de la bibliothèque dit `Linked = false` pour les
  photos. C'est la déclaration de la bibliothèque, pas celle de votre app ;
  l'étiquette affichée dans l'App Store dépend de vos réponses dans App Store
  Connect, pas de ce fichier.

---

## 3. App Store Connect → « Confidentialité de l'app » (App Privacy)

Chemin : App Store Connect → votre app → *Confidentialité de l'app* → *Modifier*
(section *Types de données*).

### 3.1 Questions générales

| Question | Réponse |
|---|---|
| Collectez-vous des données de cette app ? | **Oui** (déjà le cas) |

### 3.2 Types de données à ajouter

Catégorie **Contenu de l'utilisateur** :

| Type de données | Collecté | Lié à l'utilisateur | Utilisé pour le suivi | Finalités à cocher |
|---|---|---|---|---|
| **Photos ou vidéos** | Oui | **Oui** (recommandé, cf. 2.2) | **Non** | **Fonctionnalités de l'app** uniquement |
| **Autre contenu utilisateur** (documents) | Oui | **Oui** (recommandé, cf. 2.2) | **Non** | **Fonctionnalités de l'app** uniquement |

Ne **pas** cocher : Publicité tierce, Publicité personnalisée, Analyses,
Marketing, Personnalisation.

### 3.3 Types déjà déclarés à revérifier dans la même passe

| Type | À vérifier |
|---|---|
| **Données audio** (Contenu de l'utilisateur) | « Lié à l'utilisateur » cohérent avec les photos (cf. 2.2) |
| **Position précise** (Position) | idem |

### 3.4 Question de fond à confirmer avant de répondre

Pour **chaque** type, Apple demande si la donnée est partagée avec des **tiers**
(y compris un fournisseur d'IA ou d'OCR). Aujourd'hui, côté code, une pièce de
destination `session` n'est ni ingérée ni analysée : elle est seulement
stockée. **Je n'ai pas pu vérifier** quel stockage objet ni quels sous-traitants
l'infrastructure EigenVertex utilise en production. Si un tiers traite ou
héberge ces fichiers, la réponse et la politique de confidentialité doivent le
refléter. L'état « Traitement · lecture du texte » de la maquette n'est
déclenché par aucun code actuel pour ce type de destination ; si cette lecture
est ajoutée plus tard (ingestion en corpus), refaire cette vérification.

---

## 4. Points à traiter hors fichiers de l'app

1. **Suppression réelle des fichiers (important).** Supprimer une pièce dans
   l'app ne fait qu'une suppression logique côté serveur ; le fichier reste dans
   le stockage objet (`storage_deleted: false`). Si la politique de
   confidentialité ou la suppression de compte promet l'effacement des
   contenus, il faut soit un nettoyage côté serveur, soit une formulation exacte
   (« supprimé de votre vue, effacé du stockage sous X jours »). Apple (règle
   5.1.1(v)) attend que la suppression de compte supprime les données associées.
2. **Politique de confidentialité** : ajouter les photos et documents joints
   (nature, finalité, durée de conservation, sous-traitants éventuels) et
   vérifier que l'URL renseignée dans App Store Connect pointe vers la version à jour.
3. **Notes pour l'équipe de review** : mentionner que la caméra n'est utilisée
   que pendant un enregistrement, à l'initiative de l'utilisateur, et que
   l'enregistrement audio continue pendant la prise de vue.
4. **Textes de permission** (déjà dans `Info.plist`, en anglais comme les autres) :
   - Caméra : « Eigen Pocket uses the camera to photograph whiteboards and documents during a recording so they can be attached to it. The audio keeps recording while you shoot. »
   - Photothèque : « Eigen Pocket lets you attach photos from your library to a recording. Only the photos you pick are used. »
5. **Photothèque** : le sélecteur natif (PHPicker) n'exige pas d'autorisation
   d'accès à la bibliothèque ; la clé `NSPhotoLibraryUsageDescription` est
   présente par précaution et n'entraîne aucune collecte supplémentaire.

---

## 5. Ordre conseillé

1. Décider `Linked` (2.2) et le périmètre des entrées existantes.
2. Répondre aux questions 3.4 (sous-traitants) et 4.1 (suppression réelle).
3. Appliquer 2.1 aux deux copies de `PrivacyInfo.xcprivacy`.
4. Mettre à jour App Privacy dans App Store Connect (3.2, 3.3).
5. Mettre à jour la politique de confidentialité (4.2).
6. Archiver, soumettre, ajouter les notes de review (4.3).

---

## 6. Ajout : « Scanner un document » (quatrième type de pièce jointe)

Statut : **proposition**, rien d'appliqué. Les conclusions des sections 2 à 5 s'appliquent telles quelles.

| Fait | Source |
|---|---|
| Le scan utilise le scanner système (VisionKit) : détection des bords, correction de perspective et choix des pages se font **sur l'appareil** | `DocumentScannerPlugin.swift` |
| L'assemblage du PDF et la vignette de la page 1 sont produits **sur l'appareil** (JPEG 2000 px, qualité 0,8, recompression locale si le fichier dépasse 25 Mo). Aucun service tiers, aucun envoi pendant le scan | `ScanPDF.swift` |
| Les fichiers intermédiaires sont écrits dans le dossier temporaire de l'app, puis **supprimés** dès que l'app les a lus ; un balayage supprime ceux qui auraient survécu à un plantage (plus d'une heure) | `ScanTemp` dans `ScanPDF.swift`, `cleanup` |
| **Rien ne quitte le téléphone avant l'envoi de la pièce jointe** : le PDF suit ensuite exactement le chemin des autres pièces (copie locale dans IndexedDB, puis envoi au compte EigenVertex dès que la session existe côté serveur et que le réseau est là) | `attachmentQueue.ts` |
| Champ ajouté à l'envoi : `capture_source=scan` (provenance, sans donnée personnelle) | `attachmentApi.ts` |
| Aucune nouvelle permission : le scanner réutilise la permission caméra déjà déclarée (`NSCameraUsageDescription`) | `Info.plist` |
| Aucune lecture automatique (OCR / IA) côté Pocket : le fichier est seulement stocké, comme une pièce `session` | choix produit du 2026-11-04 |

Conséquences pour les déclarations :
- **Pas de nouveau type de donnée** : un scan est un document (PDF) donc « Autre contenu utilisateur » ; il contient des images de pages, donc « Photos ou vidéos » est déjà couvert par 2.1 / 3.2. Les mêmes réponses (Lié à l'utilisateur, pas de suivi, finalité Fonctionnalités de l'app) s'appliquent.
- **Notes pour l'équipe de review (4.3)** : ajouter que le scanner de documents n'est utilisé qu'à l'initiative de l'utilisateur pendant un enregistrement, et que l'enregistrement audio continue pendant le scan (à ne l'écrire qu'une fois le gate de l'étape 4 passé).
- **Suppression réelle (4.1)** : la limite signalée s'applique aussi aux scans (suppression logique côté serveur, le fichier reste dans le stockage objet).
