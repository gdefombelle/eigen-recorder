# Décisions — v12

Validées le 26 août 2026.

---

## D-01 : Statut affiché = statut de transport uniquement

Le badge et le libellé de fin d'enregistrement ne doivent jamais promettre
un traitement serveur, une transcription ou un ingestion Voxtral.

Ce que le client connaît avec certitude :
- **WebSocket ouvert** — la connexion PCM est établie
- **N frames émises** — le client a envoyé N trames au serveur

Ce que le client ne connaît pas et ne doit pas afficher comme acquis :
- réception effective par le serveur
- traitement Voxtral
- transcription disponible
- état "ingested" côté EigenVertex

**Règle** : utiliser « Envoyé » ou « Transmis », jamais « Synchronisé » ni
« Synced ». Ne pas reformuler en promesse ce qui est un statut de transport.

---

## D-02 : Purge audio manuelle uniquement — règle permanente

**Aucune suppression automatique de fichiers audio locaux**, quel que soit le
statut retourné par le serveur — y compris `completed`, `ingested` ou toute
valeur future.

Justification : l'archive locale est le seul garde-fou contre une perte côté
serveur. La décision de supprimer un enregistrement local appartient
exclusivement à l'utilisateur.

**Interface** : deux actions explicites distinctes, présentées séparément :
1. **Purger l'audio** — supprime les fichiers audio (blobs) ; conserve les
   métadonnées, l'identifiant de session et l'historique de transport.
   Confirmation requise.
2. **Supprimer entièrement** — supprime la session et toutes ses données sans
   possibilité de récupération. Confirmation renforcée requise.

Cette règle n'est pas une limitation temporaire en attente d'un signal
serveur fiable. Elle est permanente.

---

## D-03 : Mode différé (F1.10) — bloqué en attente du protocole serveur

Le mode d'envoi différé est bloqué. Déblocage conditionné à la définition
du protocole serveur pour :
- **commit** : point de non-retour côté serveur
- **checksum** : vérification d'intégrité bout-en-bout
- **état `ingested`** : signal confirmant que le serveur a bien pris en charge
  les données

Point ouvert : F1.10. Aucune implémentation côté client tant que ce protocole
n'est pas spécifié et déployé.
