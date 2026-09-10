# Eigen Recorder & Eigen Companion — contrat de démarrage de session

## Note de passation pour Claude et les agents

Ce document aligne le démarrage d'une session entre Eigen Recorder mobile et
Eigen Companion desktop. Les captures jointes sont des références d'interface,
pas un contrat API : les libellés et les séquences ci-dessous font foi.

EigenVertex reste le système de référence. Recorder et Companion sont des
clients de capture ; ils ne créent pas une base de sessions parallèle et ne
écrivent pas directement dans un corpus.

## 1. Principe commun

Les deux clients doivent proposer exactement deux chemins au démarrage :

```text
Choisir une session planifiée
        ou
Créer une nouvelle capture
```

Dans les deux cas, le démarrage effectif suit la même séquence :

```text
résoudre ou créer la KnowledgeSession
  → déclarer un RecordingDevice par source audio
  → démarrer la session une seule fois
  → ouvrir la Room canonique
  → ouvrir le transport audio
  → envoyer les frames / chunks
```

Une session n'est jamais créée une seconde fois simplement parce que le client
a perdu sa connexion ou que l'utilisateur réouvre l'écran. Les identifiants
`session_id` et `device_id` sont conservés localement jusqu'à la fin de la
capture.

## 2. Parcours utilisateur normalisé

### Étape A — Choisir le chemin

Le premier écran doit donner une décision claire :

- `Start now` : capture immédiate, classification maintenant ou plus tard ;
- `Choose planned session` : rattacher la capture à une session déjà préparée.

Le raccourci `Start now` ne doit pas présenter un formulaire de réunion projet
complet. Une réunion de projet structurée se prépare dans Studio ou dans le
client, puis est sélectionnée comme session planifiée.

Pour une capture instantanée, les profils visibles sont :

| Profil UI | Contrat canonique |
| --- | --- |
| Notes | `session_type=voice_note`, `knowledge_intent=personal_note` |
| Candidate interview | `session_type=interview`, `interaction_subtype=candidate` |
| Expert interview | `session_type=interview`, `interaction_subtype=expert` |
| Client call | `session_type=interview`, `interaction_subtype=client` |
| Webinar | `session_type=event`, `interaction_subtype=webinar` |
| Conference | `session_type=event`, `interaction_subtype=conference` |
| Podcast | `session_type=media_capture`, `interaction_subtype=podcast` |
| Field visit | `session_type=field_visit` |
| Workshop | `session_type=meeting`, `interaction_subtype=workshop` |

`Project Meeting`, `Meeting`, `Audit Session` et `Client Interview` sont des
profils d'interface, pas de nouveaux `session_type` backend. Ils se mappent vers
`meeting` ou `interview` avec un `interaction_subtype` explicite.

### Étape B — Session planifiée ou nouvelle session

Le client appelle :

```text
GET /v1/knowledge-sessions/recordable
```

La liste peut contenir `draft`, `ready`, `recording`, `paused`,
`processing_live` et, pour compatibilité, `completed`. L'UI de démarrage ne
doit proposer comme nouvelles captures que `draft` et `ready`. Une session déjà
`recording` ou `paused` doit afficher `Resume`, jamais `Start`. Une session
`processing_offline`, `closed` ou `cancelled` ne doit pas être proposée comme
session de capture normale.

Pour une session planifiée sélectionnée :

- conserver son `session_id` ;
- ne pas recopier silencieusement titre, projet, corpus, agenda ou participants ;
- afficher ces valeurs comme contexte ;
- autoriser uniquement les corrections prévues par le contrat ;
- ne pas créer de nouvelle session.

Pour une nouvelle capture immédiate, le chemin recommandé est :

```text
POST /v1/knowledge-sessions/start-now
```

Cette route crée atomiquement la session, la Room et l'état `recording`. Elle
est préférable à un enchaînement client `POST session` puis `POST start` qui
laisserait des sessions `draft` orphelines après une coupure.

### Étape C — Les champs affichés

Les deux applications doivent utiliser les mêmes concepts et les mêmes
contraintes :

| Champ UI | Règle |
| --- | --- |
| Location | Valeur de contexte de capture ; ne pas l'utiliser comme destination projet/corpus |
| Planned session | Sélection facultative ; elle devient obligatoire uniquement pour une réunion projet structurée |
| Session type | Profil canonique ou profil mappé ; jamais une chaîne arbitraire côté API |
| Title | Obligatoire pour une session préparée ; généré par le backend pour `Start now` si absent |
| Subject | Facultatif, objectif ou thème principal |
| Agenda | Facultatif pour une capture libre, structuré ligne par ligne pour un projet |
| Participants | Un nom par ligne ou une liste structurée ; les participants distants doivent être indiqués séparément |
| Workspace / Project / Corpus | Destination de connaissance, indépendante de la source audio |
| Audio source | Microphone, system audio ou microphone + system audio |

Les premiers écrans utilisateur doivent rester en anglais pour rester alignés
avec Studio : `Start now`, `Choose a planned session`, `Session type`, `Title`,
`Subject`, `Agenda`, `Participants`, `Start recording`.

## 3. Séquence API exacte

### A. Session planifiée existante

```text
1. GET  /v1/knowledge-sessions/recordable
2. user selects session_id
3. POST /v1/knowledge-sessions/{session_id}/devices   (one per audio source)
4. POST /v1/knowledge-sessions/{session_id}/start     (only if not already live)
5. GET  /v1/knowledge-sessions/{session_id}/room      (or ensure room)
6. WS   /v1/knowledge-sessions/{session_id}/audio-stream?device_id=...
```

If the session is already `recording`, do not call `start` again; only register
or reconnect the missing device. If it is `paused`, use `resume` according to
the existing session/device state. A client retry must reuse the same device
identity whenever possible.

### B. New instant capture

```text
1. POST /v1/knowledge-sessions/start-now
2. persist returned session.id and room.id
3. POST /v1/knowledge-sessions/{session_id}/devices   (one per audio source)
4. connect WS /v1/knowledge-sessions/{session_id}/audio-stream?device_id=...
```

`start-now` already returns a session in `recording` and a live Room. Calling
`POST /{session_id}/start` again is a duplicate transition and must be avoided.

### C. Device registration

Current route:

```text
POST /v1/knowledge-sessions/{session_id}/devices
```

Payload minimum :

```json
{
  "device_name": "Eigen Recorder iPhone",
  "device_type": "microphone",
  "client_type": "capacitor_ios",
  "capabilities_json": {
    "platform": "ios",
    "app_version": "x.y.z",
    "source": "microphone",
    "encoding": "pcm_s16le",
    "sample_rate_hz": 16000,
    "channel_count": 1,
    "frame_duration_ms": 320,
    "stream_protocol": "websocket"
  }
}
```

Companion doit enregistrer un device distinct pour `system_audio` et un autre
pour `microphone` lorsqu'il capture deux flux. Le backend sait séparer les
devices au niveau transport, buffer, transcript et artefact audio.

`device_type` est actuellement une chaîne technique libre et ne doit pas être
utilisée comme le profil métier de la session. Jusqu'à l'introduction d'un
champ produit dédié, l'agent doit conserver le profil dans
`capabilities_json.source` et `session.metadata_json.capture_profile`.

Valeurs recommandées pour `capture_profile` :

```text
microphone_only
system_audio_only
system_and_microphone
```

### D. Handshake audio

Route canonique :

```text
WS /v1/knowledge-sessions/{session_id}/audio-stream?device_id={device_id}
```

Le client envoie un premier message `session_hello` :

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

Les paramètres URL sont l'autorité pour `session_id` et `device_id`. Les
valeurs JSON servent au diagnostic et ne doivent pas permettre de changer la
cible du socket.

Pour chaque frame :

1. envoyer `audio_frame_meta` avec un `frame_index` croissant ;
2. envoyer le payload binaire PCM correspondant ;
3. attendre ou traiter l'ACK sans bloquer l'interface utilisateur ;
4. persister localement les frames non confirmées pour le fallback.

Le format realtime actuel est strict : PCM signé 16 bits little-endian, mono,
16 kHz. Companion ne doit pas envoyer directement des chunks `.m4a`, `.webm`
ou des fragments FLAC indépendants sur ce socket.

## 4. Règles par client

### Eigen Recorder mobile

L'écran montré dans les captures est cohérent avec ce modèle :

- `Record now` est un raccourci vers une note, une idée ou une interview
  improvisée ;
- `Pick a planned meeting` réutilise une session existante ;
- le lieu reste un attribut de contexte ;
- le type, titre, sujet, agenda et participants enrichissent la session avant
  le premier frame ;
- les champs vocaux peuvent remplir le titre ou le sujet, mais la valeur
  confirmée par l'utilisateur est celle envoyée au backend.

Le Recorder ne doit pas exiger un projet ou un corpus pour une note ou une
capture libre. Il doit pouvoir créer une session dans l'Inbox / non assignée,
qui sera classée depuis Studio.

### Eigen Companion desktop

L'écran Companion montré dans la capture suit un autre ordre visuel, mais le
contrat est le même :

1. `Planned session` : `New session` ou session existante ;
2. `Project` : workspace/projet éventuel ;
3. `Title` : valeur par défaut éditable ;
4. `Source` : `System + Mic`, `System only`, `Mic only` ;
5. `Start capture` ;
6. `Sync queue` et `Projections` visibles comme état de synchronisation, pas
   comme deuxième système de vérité.

Les données affichées comme `Ready`, utilisateur connecté, version et file de
synchronisation sont des états Companion. Elles ne remplacent pas les états
backend `recording`, `paused`, `processing_offline` ou `completed`.

## 5. Choix de source audio et capture en ligne

Le client doit poser une question explicite lorsque le profil implique un
contenu en ligne :

> **Does this session include remote or online audio?**  
> Capture the sound from your computer to record webinars, podcasts, videos or
> remote participants accurately.

Choix :

- `No, microphone only` ;
- `Yes, system audio only` ;
- `Yes, system audio + microphone`.

Le terme `online` décrit la provenance du son, pas le champ backend
`mode=online`. Il faut donc conserver ces deux notions séparément.

### Quand recommander Eigen Companion

Sur laptop, PC ou Mac, si la session contient un webinar, podcast, conférence,
vidéo YouTube, call ou participant distant, recommander Eigen Companion :

> **Recommended: use Eigen Companion for system audio.** It captures computer
> audio directly, gives better quality and is less sensitive to room noise.
> For remote participants, Companion is required to avoid speaker/microphone
> feedback loops. You can continue with Studio recording if Companion is not
> available.

Cette recommandation ne doit pas bloquer le recorder Studio pour les webinars,
podcasts ou conférences. Pour une réunion avec participants distants, Companion
est requis dans la configuration recommandée, car le haut-parleur de l'ordinateur
réinjecte sinon le son distant dans le microphone et peut créer une boucle.

Le choix doit être conservé dans la session et dans chaque device. Il doit être
visible dans le détail de capture afin qu'un agent puisse expliquer pourquoi un
transcript est incomplet.

## 6. Participants distants

Dans les pages de planification, ajouter une question distincte :

> **Will any participants join remotely?**

Choix : `No`, `Yes`, `Not sure`.

Si `Yes` :

- afficher immédiatement la recommandation Companion ;
- expliquer le risque de boucle avec le speaker du laptop ;
- proposer `Open Eigen Companion` ou `Continue without Companion` ;
- enregistrer la décision et le niveau de confiance dans la session ;
- ne jamais prétendre que le microphone seul capture proprement les voix
  distantes.

Pour compatibilité immédiate, conserver dans `metadata_json` :

```json
{
  "remote_participants": true,
  "companion_recommended": true,
  "companion_required_for_remote_audio": true,
  "capture_profile": "system_and_microphone"
}
```

À terme, `remote_participants` et `capture_profile` doivent devenir des champs
de contrat de première classe plutôt que des clés JSON libres.

## 7. Machine d'état de démarrage

### Session

```text
draft / ready
   │ Start
   ▼
recording
   │ Pause / Resume
   ▼
paused ───────────────► recording
```

Les états `processing_offline`, `completed`, `closed` et `cancelled` ne sont
pas des états de démarrage normal. `cancelled` est réservé à l'abandon, à une
session vide ou à un zombie ; il ne doit jamais être envoyé par Recorder ou
Companion pour signaler un Stop normal.

### Device

```text
connecting → connected → recording → paused → recording
                              │
                              └──────────────→ disconnected
```

`connected` signifie que le device est connu, pas qu'il capture. Un device
enregistré mais jamais démarré ne doit pas empêcher la session de se terminer.

### Room

```text
waiting → live → processing → replay_ready
                          └──→ archived
```

Le client ne doit pas fabriquer l'état Room localement si une réponse backend
est disponible. Il peut afficher une étape transitoire `Connecting` pendant la
création du device et du socket.

## 8. Pause, reprise, perte réseau et Stop

Pause et Stop sont indépendants du transport système/microphone :

- `Pause` arrête l'envoi de nouvelles frames, conserve les buffers et passe le
  device à `paused` ;
- `Resume` reprend avec le même `device_id` et un `frame_index` monotone ;
- une reconnexion réseau reprend ou recrée le socket du même device, sans créer
  une nouvelle session ;
- `Stop` arrête localement les recorders, envoie les derniers chunks confirmés,
  puis appelle l'action de device `stop` ;
- lorsque tous les devices actifs sont arrêtés, le backend lance la finalisation
  normale de la session ;
- le client retire immédiatement le bouton de reprise et l'état `Recording`.

Routes de contrôle :

```text
POST /v1/knowledge-sessions/{session_id}/devices/{device_id}/pause
POST /v1/knowledge-sessions/{session_id}/devices/{device_id}/resume
POST /v1/knowledge-sessions/{session_id}/devices/{device_id}/stop
```

Une fermeture WebSocket due à une coupure réseau est un filet de sécurité ; elle
n'est pas équivalente à un Stop utilisateur de toute la session. L'agent doit
reconnecter le même device, sauf si le backend confirme que la session est déjà
en finalisation.

## 9. Idempotence et stockage local

Avant de démarrer, le client persiste au minimum :

```text
session_id
room_id
device_id(s)
capture_profile
last_confirmed_frame_index par device
session_start_request_id
```

Le démarrage doit être protégé par une clé d'idempotence client. Si le client
ne sait pas si `start-now` a réussi, il doit rechercher la session créée ou
réessayer avec la même clé ; il ne doit pas poster une nouvelle session.

Le stockage local sert au retry et au mode offline. Il ne devient jamais une
source concurrente de vérité : après synchronisation, l'identité canonique est
celle renvoyée par EigenVertex.

## 10. Ce que les agents ne doivent pas faire

- ne pas utiliser `mode=online` pour signifier `system_audio` ;
- ne pas créer deux sessions parce que Recorder et Companion sont tous deux
  ouverts ;
- ne pas créer un device par reconnexion réseau ;
- ne pas mélanger microphone et system audio dans un même device si les flux
  peuvent être séparés ;
- ne pas envoyer de conteneurs audio concaténés au WebSocket PCM ;
- ne pas inventer le nom d'un speaker pendant le temps réel ;
- ne pas appeler `cancel` pour un Stop normal ;
- ne pas afficher `Ready` comme si la capture backend était déjà démarrée ;
- ne pas considérer la file de synchronisation Companion comme une Inbox
  métier ;
- ne pas proposer une session `Finalizing`, `Closed` ou `Cancelled` comme
  capture nouvelle.

## 11. Contrat de sortie du démarrage

Après un démarrage réussi, le client doit pouvoir afficher :

```json
{
  "session_id": "...",
  "room_id": "...",
  "status": "recording",
  "capture_profile": "system_and_microphone",
  "devices": [
    {"device_id": "...", "source": "microphone", "status": "recording"},
    {"device_id": "...", "source": "system_audio", "status": "recording"}
  ]
}
```

La Room Studio doit ensuite recevoir le transcript live via son flux descendant
canonique. Recorder et Companion peuvent afficher un état de capture local,
mais l'indicateur `Live` du registre et la vérité de session viennent du
backend.

## 12. Critères d'acceptation pour Claude

### Session planifiée

1. sélectionner une réunion projet planifiée dans Recorder ;
2. vérifier que le même titre, agenda, participants et `session_id` sont
   conservés ;
3. démarrer microphone seul ou microphone + system audio ;
4. vérifier un device par flux ;
5. vérifier `recording` dans le backend et `Live` dans Studio ;
6. couper puis reconnecter le réseau ;
7. vérifier la reprise avec le même device, sans doublon ;
8. arrêter et vérifier le passage à la finalisation.

### Capture libre

1. choisir `Start now` puis `Notes` ou `Podcast` ;
2. vérifier la création atomique de la session et de la Room ;
3. vérifier le titre généré si l'utilisateur ne saisit rien ;
4. vérifier que la session est non assignée ou affectée à la destination
   choisie ;
5. démarrer la capture et confirmer le transcript live ;
6. arrêter sans jamais passer par `cancel`.

### Audio en ligne et participants distants

1. choisir Webinar, Podcast, Conference ou un call ;
2. poser la question sur l'audio du système ;
3. recommander Companion sur Mac/PC ;
4. choisir `system only` ou `system + microphone` ;
5. pour des participants distants, afficher le message de boucle et la
   nécessité de Companion ;
6. vérifier que le fallback Studio reste accessible pour les profils autorisés ;
7. conserver ce choix dans les métadonnées et les devices.

## 13. Inbox et suite d'alignement

Une capture libre sans projet ni corpus doit aboutir à l'Inbox EigenVertex, pas
à une session perdue :

```text
Recorder / Companion
  → KnowledgeSession non assignée
  → capture_inbox_status=pending_review ou staged_unassigned
  → Inbox Studio
  → classify / keep private / promote / archive
```

La création de l'Inbox est une étape produit séparée, mais son contrat doit
être prévu dès le démarrage : les agents doivent envoyer l'intention et la
destination éventuelle, sans inventer leur propre classement local.

## Références backend actuelles

```text
GET  /v1/knowledge-sessions/recordable
POST /v1/knowledge-sessions/start-now
POST /v1/knowledge-sessions/{session_id}/devices
POST /v1/knowledge-sessions/{session_id}/start
POST /v1/knowledge-sessions/{session_id}/pause
POST /v1/knowledge-sessions/{session_id}/resume
POST /v1/knowledge-sessions/{session_id}/devices/{device_id}/pause
POST /v1/knowledge-sessions/{session_id}/devices/{device_id}/resume
POST /v1/knowledge-sessions/{session_id}/devices/{device_id}/stop
WS   /v1/knowledge-sessions/{session_id}/audio-stream?device_id=...
GET  /v1/knowledge-sessions/{session_id}/stream
```

Le contrat audio détaillé et les limites du batch sont documentés dans
`docs/eigen-recorder-backend-audio-flow-for-claude.md`. Ce présent document
devient la référence pour le **démarrage**, le choix de source et l'alignement
Recorder/Companion.

