# Eigen Recorder — flux audio backend

## Note de passation pour Claude

Cette note décrit le comportement réellement présent dans le backend de
`/Users/gabrieldefombelle/Documents/eigenvertex`. Elle sépare le contrat
implémenté des décisions restantes avant de figer l’interface avec Eigen
Recorder et Eigen Companion.

Pour le contrat prioritaire de démarrage — session planifiée ou capture libre,
mapping des profils, choix microphone/system audio, Companion et idempotence —
voir [`eigen-recorder-companion-session-start-contract.md`](eigen-recorder-companion-session-start-contract.md).

## Réponse aux quatre questions ouvertes

| Question | Réponse du code actuel |
|---|---|
| Plusieurs appareils actifs dans une session ? | Oui. Le runtime est indexé par `(session_id, device_id)`, avec une queue PCM, un buffer et une session Voxtral par appareil. Réserve : ce runtime est en mémoire du processus. |
| `device_id` dans le handshake WebSocket ? | Oui. Il est obligatoire dans `?device_id=...` et le backend vérifie que le device appartient à la session. Le `device_id` JSON est secondaire ; l’URL est l’autorité. |
| Contexte Voxtral par appareil ou session ? | La transcription realtime est par appareil. Le contexte lexical métier n’est actuellement pas envoyé au chemin realtime. Le batch construit un contexte à partir de la session puis traite un appareil à la fois. |
| Que contient `capture_type` ? | Rien : aucun champ, schéma, migration ou usage trouvé. Le champ existant le plus proche est `RecordingDevice.device_type`, chaîne libre par défaut à `microphone`. |

## Flux global

Le backend propose deux chemins :

1. Realtime : Recorder → WebSocket → état runtime par appareil → Voxtral
   realtime → segments live → persistance + SSE.
2. Batch/fallback : upload de chunks → stockage objet → assemblage des chunks
   d’un appareil → Voxtral batch → transcript final.

Le WebSocket est le chemin live prioritaire. L’endpoint multipart
`/audio-chunks` reste nécessaire pour le fallback, l’upload différé et la
compatibilité.

## 1. Préparation d’une session

Séquence normale :

1. `POST /v1/knowledge-sessions`
2. `POST /v1/knowledge-sessions/{session_id}/devices`
3. `POST /v1/knowledge-sessions/{session_id}/start`
4. ouverture d’un WebSocket audio pour chaque device.

`RecordingDevice` est rattaché à une seule `KnowledgeSession`. Il porte :

- `device_name`
- `device_type` : chaîne libre, par défaut `microphone`
- `client_type` : `pwa`, `capacitor_ios`, `capacitor_android` ou `web`
- `capabilities_json`
- `status` et `last_seen_at`

Le `device_id` est un UUID serveur. Le Recorder doit le conserver après la
création du device et le réutiliser pour le WebSocket et les uploads batch.

## 2. Handshake WebSocket

Route réelle :

```
WS /v1/knowledge-sessions/{session_id}/audio-stream?device_id={device_id}
```

Le handler :

1. accepte le socket ;
2. charge la session ;
3. vérifie que `device_id` appartient à la session ;
4. ferme en `1008` avec un événement `fatal` si la session ou le device est
   inconnu ;
5. initialise le runtime au premier `session_hello`,
   `audio_frame_meta` ou message binaire.

Exemple de hello :

```json
{
  "type": "session_hello",
  "session_id": "SESSION_ID",
  "device_id": "DEVICE_ID",
  "client_type": "recorder_web",
  "audio_format": {
    "encoding": "pcm_s16le",
    "sample_rate": 16000,
    "channels": 1,
    "frame_duration_ms": 320
  }
}
```

Le backend ne compare pas les `session_id` et `device_id` du JSON avec ceux
de l’URL. Pour Claude, les paramètres de chemin/query sont canoniques ; les
identifiants JSON servent surtout au diagnostic.

Point sécurité à vérifier séparément : le handler WebSocket ne reçoit pas de
`Depends` d’autorisation analogue à `_ensure_session_access`. Il valide bien
l’existence de la session et l’appartenance du device, mais il faut confirmer
que l’authentification/session cookie ou clé API est effectivement appliquée
sur les connexions WebSocket par la couche ASGI/proxy. Cette vérification ne
change pas la séparation multi-device, mais elle doit être faite avant de
figer le contrat de production.

Après l’ouverture Voxtral, le serveur renvoie un ACK de forme :

```json
{
  "type": "ack",
  "session_id": "SESSION_ID",
  "device_id": "DEVICE_ID",
  "message": "Realtime audio session ready."
}
```

## 3. Frames PCM

Le format est strict :

- `pcm_s16le`
- 16 000 Hz
- mono
- `frame_index` strictement croissant
- JSON `audio_frame_meta` avant les octets PCM correspondants

Exemple :

```json
{
  "type": "audio_frame_meta",
  "frame_index": 42,
  "sample_rate": 16000,
  "channels": 1,
  "encoding": "pcm_s16le",
  "duration_ms": 320,
  "capture_started_ms": 13440,
  "capture_ended_ms": 13760
}
```

Le Recorder envoie ensuite un message binaire contenant les octets PCM.
Le backend mémorise une seule `PendingFrameMeta` par device. À la réception
du binaire, il valide le format, l’ordre et la non-vacuité, puis :

- ajoute les octets au `pcm_buffer` du device ;
- incrémente `frame_count` et `audio_bytes_sent` ;
- met à jour `last_frame_index` ;
- pousse les octets dans la `asyncio.Queue` de Voxtral ;
- renvoie un ACK avec `frame_index`, `frame_count` et `buffered_bytes`.

Chaque frame realtime n’est pas insérée comme ligne `AudioChunk`. Le buffer
PCM complet est archivé à la finalisation.

## 4. Multi-appareils

La clé runtime est :

```
f"{session_id}:{device_id}"
```

Chaque état possède sa propre queue, son buffer, ses compteurs, ses segments
et sa tâche de consommation Voxtral. Deux appareils actifs dans une même
session ne sont donc pas mélangés au niveau transport, buffer ou transcription.
Le cas microphone + audio système est supporté structurellement.

Réserves importantes :

1. `_RUNTIME_STATES` est un dictionnaire Python local au processus. Avec
   plusieurs workers/replicas sans affinité, le realtime n’est pas partagé.
2. Deux sockets avec le même `device_id` réutilisent le même état au lieu de
   créer deux sessions Voxtral. Le Recorder doit garantir un seul socket actif
   par device.
3. `session_commit` appelle
   `finalize_realtime_sessions_for_session(session_id)` : il finalise tous les
   devices actifs, pas seulement celui qui a envoyé le commit. Il s’agit du
   commit du contenu audio, pas encore de la clôture métier de la session ;
   celle-ci est déclenchée par le `stop` du dernier device actif.

## 5. Voxtral realtime

Pour chaque device, le backend ouvre :

```
client.audio.realtime.transcribe_stream(
    audio_stream=...,
    model=MISTRAL_AUDIO_TRANSCRIPTION_MODEL_REALTIME,
    audio_format=AudioFormat(encoding, sample_rate),
    target_streaming_delay_ms=...,
)
```

Les événements sont traités ainsi :

- `RealtimeTranscriptionSessionCreated` : runtime marqué prêt ;
- `TranscriptionStreamTextDelta` : texte partiel accumulé ;
- `TranscriptionStreamSegmentDelta` : segment normalisé et persisté ;
- `TranscriptionStreamDone` : segments finaux persistés ;
- `RealtimeTranscriptionError` : runtime désinscrit en erreur.

La diarisation fournit un `speaker_id`, normalisé en labels comme
`Speaker 1`. Les segments portent à la fois `device_id` et
`speaker_label`. La séparation des sources est donc déjà disponible côté
serveur.

### Contexte métier

Le chemin batch construit `build_knowledge_session_context_bias(session)` à
partir du titre, projet, agenda, sujet, participants et termes métier, puis le
passe à `transcribe_audio_with_voxtral(..., prompt=prompt)`.

Le chemin realtime ne passe pas ce prompt/context bias à
`transcribe_stream`. La réponse exacte est donc :

- état Voxtral : par appareil ;
- contexte métier Voxtral realtime : aucun actuellement ;
- contexte batch : dérivé de la session et appliqué à l’audio d’un appareil.

Si Claude veut un contexte realtime, le plus cohérent est de construire un
contexte au niveau session et de l’injecter dans chaque connexion device, sans
fusionner les buffers.

## 6. Transcript live et SSE

Les segments runtime sont persistés dans `transcript_segments` avec :

- `session_id`
- `device_id`
- `speaker_label`
- `start_ms` / `end_ms`
- texte, `is_final`, confiance
- `source_chunk_ids` — vide dans le realtime actuel

Le flux descendant est séparé du WebSocket :

```
GET /v1/knowledge-sessions/{session_id}/stream
```

Le générateur SSE reconstruit l’état depuis la base et ajoute les overlays
runtime en mémoire. Il regroupe d’abord les segments par `device_id`, puis
les aplatit dans une timeline triée par `start_ms`. L’interface peut donc
afficher une timeline commune tout en conservant l’origine de chaque segment.

## 7. Finalisation et archive

Lors du `session_commit`/fermeture du socket, puis lors du `stop` du dernier
device, le backend :

1. ferme la queue Voxtral ;
2. attend au plus cinq secondes la tâche d’événements ;
3. archive le buffer PCM complet du device ;
4. convertit en WAV puis en MP3 si `ffmpeg` est disponible ;
5. stocke l’artefact avec le `device_id` dans le chemin ;
6. ajoute les métadonnées à `metadata_json.audio_artifacts` ;
7. relance toujours Voxtral batch pour ce device lorsqu’il existe du PCM. Le
   realtime fournit un transcript provisoire sans diarisation ; la passe batch
   est la version de référence, supprime/remplace les segments provisoires et
   ajoute les speakers lorsque le modèle les retourne.

Le cycle métier est donc :

```
recorder Start
  -> session recording / room live
  -> PCM WebSocket + transcript provisoire
recorder Stop
  -> session_commit + fermeture WebSocket
  -> batch final + diarisation
  -> stop du dernier device
  -> session processing_offline / room processing
  -> revue utilisateur
  -> complete explicite / room replay_ready
```

Un device `connected` mais qui n’a jamais commencé à capturer ne bloque pas
la clôture : seuls les devices `connecting`, `recording` ou `paused` comptent
comme captures actives. Une coupure WebSocket reste un filet de sécurité et
ne doit pas être interprétée comme une action utilisateur équivalente à
`Stop`.

Chemin workspace :

```
workspaces/{workspace_id}/knowledge-sessions/{session_id}/recordings/{device_id}-recording.mp3
```

Session sans workspace :

```
standalone/knowledge-sessions/{session_id}/recordings/{device_id}-recording.mp3
```

La finalisation batch parcourt les devices séparément, assemble uniquement
leurs chunks, puis produit les segments finaux.

## 8. Fallback `audio-chunks`

Route :

```
POST /v1/knowledge-sessions/{session_id}/audio-chunks
```

Champs importants : `device_id`, `chunk_index`, `start_ms`, `end_ms`,
`mime_type` et le fichier multipart. La contrainte SQL est :

```
UNIQUE(session_id, device_id, chunk_index)
```

À la transcription, le backend sélectionne les chunks du même device, les
assemble dans l’ordre et appelle Voxtral batch. `device_id` peut être null,
mais cela perd la séparation multi-device ; le Recorder doit donc le fournir
dès qu’un `RecordingDevice` existe.

## 9. `capture_type`

Recherche dans le backend : aucune occurrence de `capture_type`. Il n’existe
donc pas de contrat actuel sous ce nom.

Option sans migration :

```json
{
  "device_name": "MacBook microphone",
  "device_type": "microphone",
  "client_type": "web",
  "capabilities_json": {
    "capture_type": "microphone"
  }
}
```

Ou utiliser directement `device_type = "system"` pour une capture audio
système.

Si Companion doit filtrer ou mixer durablement les sources, ajouter un champ
explicite `capture_type` dans `RecordingDevice`, avec par exemple
`microphone`, `system` et éventuellement `mixed`. Cela implique migration,
schémas API et adaptation des clients.

## 10. Décisions à figer

1. Garder `device_id` dans la query string WebSocket ; le répéter dans les
   messages JSON comme information de diagnostic.
2. Garantir un seul socket actif par device.
3. Confirmer que `session_commit` est global, ou le rendre par device.
4. Décider si le contexte lexical de session doit être ajouté au realtime.
5. Choisir `device_type` maintenant, ou introduire `capture_type` comme
   contrat produit explicite.
6. Avant le multi-worker production, partager le runtime ou imposer une
   affinité de connexion.

## Vérification v10 : trois points complémentaires

### Fermeture d’un socket et coupure réseau

Il faut distinguer deux comportements :

- `session_commit` appelle `finalize_realtime_sessions_for_session(session_id)`
  et finalise donc tous les devices actifs. C’est compatible avec Companion si
  les deux pistes doivent s’arrêter ensemble.
- une fermeture de socket, y compris une coupure réseau qui déclenche
  `WebSocketDisconnect`, passe dans le `finally` du handler et appelle
  `finalize_realtime_session(session_id, device_id)` uniquement pour le device
  de ce socket. Elle n’appelle pas la finalisation de toute la session.

Donc, si le socket système tombe, le buffer système est archivé/transcrit, mais
le socket microphone et son état runtime restent actifs. Une coupure réseau ne
termine pas automatiquement les deux pistes. Le Recorder doit reconnaitre la
perte du socket et se reconnecter avec le même `device_id`; il faut éviter
qu’une logique client envoie ensuite un `session_commit` global simplement pour
traiter cette reconnexion.

### Assemblage batch des chunks

Le batch n’utilise pas `ffmpeg` pour assembler les chunks. La fonction
`assemble_recording_device_audio` télécharge chaque objet du même device et
fait simplement :

```python
payload.extend(download_bytes_from_storage(...))
```

Cela fonctionne pour des fragments PCM conçus pour être concaténés, mais pas
pour des conteneurs indépendants `.m4a`, `.webm` ou `.flac` : concaténer leurs
octets ne produit pas un fichier audio valide. `ffmpeg` est utilisé dans le
realtime uniquement pour convertir le buffer PCM final en WAV/MP3, pas dans le
chemin `audio-chunks`.

Conclusion pour Companion : ne pas envoyer des chunks conteneurisés
indépendants en espérant que le batch les fusionne. Trois options sont
possibles :

1. envoyer un flux PCM/FLAC conçu pour une concaténation contrôlée et ajouter
   le décodage/re-encodage serveur ;
2. envoyer un seul fichier final par device ;
3. ajouter une étape serveur `ffmpeg` qui décode chaque chunk, normalise le
   format et concatène les flux audio avant Voxtral.

Un FLAC 48 kHz n’est pas accepté par le WebSocket realtime actuel, qui exige
PCM16 mono 16 kHz. En batch, il est stockable, mais il ne doit pas être découpé
en plusieurs fichiers FLAC puis concaténé tel quel.

### Attacher un artefact sans transcription

Il n’existe actuellement pas de chemin API pour uploader/attacher un artefact
audio sans transcription :

- `POST /audio-chunks` stocke le chunk puis appelle immédiatement
  `process_audio_chunk_transcription` ;
- la fermeture realtime archive le buffer puis lance le fallback batch si
  Voxtral n’a pas produit `done` ;
- `GET /audio-artifacts` ne fait que lister les métadonnées déjà présentes ;
- `GET /audio` ne fait que servir l’artefact existant ;
- `POST /audio-artifacts/{artifact_id}/analyze` analyse un artefact déjà
  attaché, mais ne l’attache pas.

Pour le cas FLAC 48 kHz, il faut donc ajouter un endpoint dédié, par exemple

```text
POST /v1/knowledge-sessions/{session_id}/audio-artifacts
```

qui stocke le fichier, renseigne `metadata_json.audio_artifacts` avec son
`device_id`, son format, sa durée et sa fréquence, mais ne déclenche ni
Voxtral ni `process_audio_chunk_transcription`. La transcription ou l’analyse
pourrait ensuite être une action explicite séparée.

## Références de code

- WebSocket/handshake : `src/api/routes/knowledge_sessions.py`,
  `realtime_audio_stream_endpoint`.
- Runtime, queue, validation PCM et finalisation :
  `src/services/knowledge_session_realtime_service.py`.
- Batch et contexte lexical :
  `src/services/knowledge_session_transcription_service.py`.
- SSE et agrégation par device :
  `src/services/knowledge_session_stream_service.py`.
- Modèles SQL :
  `src/db/models/knowledge_session.py`.
- Schémas API :
  `src/common/schemas/knowledge_session.py`.
- Architecture cible :
  `docs/knowledge-sessions-voxtral-realtime-architecture.md`.
