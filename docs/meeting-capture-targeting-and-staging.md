# Eigen Meeting - cible de connaissance, réunions et staging des captures

Version 1.0 - 20 août 2026  
Statut : proposition de contrat produit et technique

## 1. Objet du document

Ce document fixe le comportement commun des trois surfaces de capture :

- Eigen Meeting / recorder intégré à Studio (`app.eigenvertex.com`) ;
- Eigen Meeting installé en PWA ou via Capacitor ;
- Eigen Companion pour laptop, y compris les réunions avec participants distants.

Il traite les captures audio, les entretiens, les notes vocales et les réunions. Il distingue les règles métier à implémenter des éléments déjà présents dans l'architecture de capture fournie.

## 2. Décision structurante

Une capture ne doit jamais être routée vers un corpus uniquement parce qu'elle a été enregistrée pendant une réunion, ni uniquement parce qu'elle provient d'une surface donnée.

Le routage repose sur quatre propriétés indépendantes :

| Propriété | Question | Exemples |
|---|---|---|
| `capture_kind` | Qu'est-ce que l'utilisateur est en train de capter ? | `meeting`, `expert_interview`, `voice_note`, `other` |
| `knowledge_intent` | Pourquoi cette capture existe-t-elle ? | `operate_project`, `collect_knowledge`, `personal_note`, `undecided` |
| `target_type` | Où le contenu doit-il vivre ? | `project`, `corpus`, `inbox` |
| `promotion_policy` | Que fait-on du contenu produit ? | `project_outputs`, `corpus_candidate`, `private_until_review` |

La `KnowledgeSession` reste l'objet canonique de capture. Le fait qu'elle soit techniquement créée avant que la cible soit connue est normal : une session peut exister en staging avec `target_type = inbox`.

## 3. Vocabulaire canonique

### 3.1 Workspace

Le workspace est le périmètre de sécurité et de possession. Toute session authentifiée doit avoir un `workspace_id`. Une session locale non authentifiée peut être conservée dans le stockage local jusqu'à synchronisation ; au moment de la synchronisation, elle doit recevoir un workspace explicite.

Le workspace n'est pas automatiquement un corpus. Il constitue le contenant d'accès ; le corpus est une cible documentaire choisie dans ce workspace.

### 3.2 Projet

Un projet est un contexte opérationnel. Il porte les réunions, les participants, les décisions, les actions, les risques et l'état temporel du travail.

Chaque projet doit avoir exactement un corpus documentaire principal, créé automatiquement lors de la création du projet. Ce corpus est la résolution par défaut d'une capture dont la cible est le projet.

### 3.3 Corpus

Un corpus est une cible documentaire de connaissance. Il peut être :

- le corpus principal d'un projet ;
- un corpus indépendant du projet ;
- un corpus de référence explicitement choisi.

Le corpus reçoit des documents promus ou ingérés. Il ne doit pas recevoir automatiquement chaque transcript brut d'une réunion opérationnelle.

### 3.4 Meeting et session

`Meeting` désigne l'intention ou l'objet planifié côté produit : titre, horaire, participants, agenda et rattachement opérationnel.

`KnowledgeSession` désigne l'exécution d'une capture : appareils, segments audio, transcript, localisation, état de streaming, résumé et résultats d'intelligence.

Un meeting peut produire une session. Une session peut aussi être créée sans meeting préalable. Il ne faut donc pas utiliser `session_type` comme seul indicateur de destination documentaire.

## 4. Règle d'attachement

Une session a une et une seule cible primaire au moment où elle est promue :

```text
Projet choisi
  -> corpus principal du projet résolu automatiquement

Corpus choisi sans projet
  -> corpus choisi directement

Ni projet ni corpus choisi
  -> staging / inbox du workspace
```

### 4.1 Cas projet

Si l'utilisateur sélectionne un projet, l'API résout le corpus principal du projet et enregistre les deux relations :

```text
session.project_id = P
session.target_corpus_id = primary_corpus(P)
```

Le client ne doit pas demander à l'utilisateur de sélectionner à nouveau le corpus principal. Il peut toutefois afficher la résolution et proposer un corpus de référence distinct uniquement comme extension explicite.

### 4.2 Cas corpus

Si l'utilisateur sélectionne un corpus sans projet :

```text
session.project_id = null
session.target_corpus_id = C
```

La capture devient une contribution documentaire au corpus, sans être considérée comme une réunion d'un projet. Les participants et le contexte de l'entretien restent toutefois conservés dans la session.

### 4.3 Cas projet et corpus fournis ensemble

Le serveur doit refuser ou corriger explicitement toute incohérence. Par défaut :

- si le corpus fourni est le corpus principal du projet, la requête est acceptée ;
- si le corpus fourni est un autre corpus, la requête est acceptée seulement avec `target_override_reason` et confirmation utilisateur ;
- si le corpus n'appartient pas au workspace du projet, la requête est refusée (`409 target_mismatch`).

Il ne doit jamais exister une session silencieusement rattachée à un projet mais indexée dans un corpus qui n'est pas celui affiché à l'utilisateur.

## 5. Les trois grands scénarios

### 5.1 Réunion prévue : contenu pour le travail du projet

Exemple : comité projet, rendez-vous client, réunion d'équipe, point d'avancement.

Déclaration recommandée :

```json
{
  "capture_kind": "meeting",
  "knowledge_intent": "operate_project",
  "target_type": "project",
  "promotion_policy": "project_outputs"
}
```

Comportement :

1. L'utilisateur choisit le meeting planifié ou crée une réunion maintenant.
2. Le projet, le titre, l'agenda, les participants et le lieu sont préremplis.
3. La session est attachée au projet ; le corpus principal est résolu automatiquement.
4. Le transcript et les artefacts bruts restent liés à la session.
5. Meeting Copilot produit les décisions, actions, questions ouvertes, sujets et mises à jour de projet.
6. Ces sorties structurées alimentent le projet et la mémoire temporelle.
7. Le transcript complet n'est promu dans le corpus qu'après une action explicite : `Promote to project corpus`.

Règle importante : la réunion est bien attachée au projet, mais son enregistrement n'est pas automatiquement un document canonique du corpus. Cela évite de polluer le corpus avec des échanges opérationnels, des apartés et des formulations non validées.

### 5.2 Entretien d'expert : contenu destiné à un corpus

Exemple : recueillir les informations d'un expert, enregistrer une interview, documenter un savoir métier.

Déclaration recommandée :

```json
{
  "capture_kind": "expert_interview",
  "knowledge_intent": "collect_knowledge",
  "target_type": "corpus",
  "promotion_policy": "corpus_candidate"
}
```

Comportement :

1. L'utilisateur choisit directement le corpus cible, ou choisit un projet dont le corpus principal est proposé.
2. La session conserve le nom et le rôle de l'expert, le sujet, les sources et le consentement.
3. Le transcript brut est une preuve de provenance, mais n'est pas immédiatement la page de référence.
4. Le système génère un document candidat : titre, synthèse, affirmations, points à vérifier, citations temporelles et métadonnées de provenance.
5. Le candidat entre dans le staging du corpus.
6. Après revue, l'utilisateur choisit `Promote`, `Promote with edits` ou `Reject`.
7. Seul le contenu promu est indexé dans le corpus comme document durable.

Si l'entretien est mené dans le cadre d'un projet, `project_id` peut être conservé comme contexte secondaire, mais `target_corpus_id` reste la cible documentaire explicite. Le corpus principal du projet est la valeur par défaut, pas une déduction irréversible.

### 5.3 Note improvisée : aucune cible connue au démarrage

Exemple : idée vocale, note audio, échange spontané, réunion non préparée.

Déclaration initiale :

```json
{
  "capture_kind": "voice_note",
  "knowledge_intent": "undecided",
  "target_type": "inbox",
  "promotion_policy": "private_until_review"
}
```

Comportement :

1. `Record now` crée immédiatement une session dans le workspace de l'utilisateur si celui-ci est authentifié.
2. Aucun projet ni corpus n'est inventé. Le titre par défaut indique qu'il s'agit d'une capture à classer.
3. En mode local/offline, la session et les chunks sont conservés dans IndexedDB ; ils reçoivent une identité locale stable.
4. À la reconnexion, la session est synchronisée dans le workspace comme `staged_unassigned`.
5. Le système peut transcrire et proposer une classification, mais la suggestion ne vaut pas décision.
6. L'utilisateur doit pouvoir choisir ensuite : projet, corpus indépendant, conserver en note privée, fusionner avec une session, archiver ou supprimer.
7. Tant qu'aucune cible n'est choisie, aucun document n'est indexé dans un corpus.

Cette règle couvre aussi une réunion improvisée : si l'utilisateur choisit un projet au démarrage ou après l'enregistrement, la session devient une réunion du projet ; sinon elle reste une capture inbox.

## 6. Staging : état de transition obligatoire

Le staging n'est pas un corpus caché et ne doit pas être traité comme un corpus de recherche. C'est une file de captures et de documents candidats qui attendent une décision de classement ou de promotion.

### 6.1 États de session

```text
draft
  -> capturing
  -> captured
  -> syncing
  -> staged_unassigned | staged_targeted
  -> classified
  -> promoted | kept_private | rejected | archived
```

Les états de capture existants (`recording`, `paused`, `processing_live`, `processing_offline`, `completed`) restent des états techniques. Les états ci-dessus sont la couche métier de destination ; ils ne doivent pas être confondus avec le statut de streaming.

### 6.2 États du document candidat

```text
not_materialized
  -> transcript_available
  -> candidate_generated
  -> awaiting_review
  -> approved_for_corpus
  -> indexed
```

Un échec de transcription ou de génération ne doit pas supprimer l'audio local ni la session. Il doit produire un état de reprise et laisser l'utilisateur télécharger ou corriger la capture.

### 6.3 Contenu du staging

Chaque élément de staging doit afficher :

- titre et date ;
- surface et appareil d'origine ;
- statut de synchronisation et présence de l'audio ;
- qualité du transcript ;
- participants et consentement ;
- classification proposée ;
- projet proposé, corpus proposé et raison de la proposition ;
- actions : `Classer`, `Promouvoir`, `Garder privé`, `Rejeter`, `Archiver`.

Le staging doit conserver la provenance : `session_id`, `source_document_id`, timestamps du transcript, appareil, utilisateur créateur et version du document candidat.

## 7. Contrat de données recommandé

Le modèle actuel de `KnowledgeSession` contient déjà `workspace_id`, `project_id`, `source_document_id`, le type, le mode, les métadonnées, le transcript et les résultats de réunion. Il faut ajouter une couche de ciblage explicite, idéalement avec des colonnes typées plutôt qu'un simple JSON.

Champs recommandés :

| Champ | Type | Rôle |
|---|---|---|
| `capture_kind` | enum | `meeting`, `expert_interview`, `voice_note`, `other` |
| `knowledge_intent` | enum | `operate_project`, `collect_knowledge`, `personal_note`, `undecided` |
| `target_type` | enum | `project`, `corpus`, `inbox` |
| `target_corpus_id` | UUID nullable | corpus primaire résolu ou choisi |
| `staging_status` | enum | état métier de classement/promotion |
| `promotion_policy` | enum | sortie projet, candidat corpus ou privé |
| `planned_meeting_id` | UUID nullable | meeting prévu, distinct de la session exécutée |
| `target_locked_at` | datetime nullable | moment où la cible devient effective |
| `target_locked_by` | UUID nullable | utilisateur ayant confirmé la cible |
| `classification_json` | JSON | suggestions, confiance et justification, jamais vérité canonique |
| `consent_json` | JSON | consentement, participants et contraintes d'utilisation |

Compatibilité transitoire : avant migration, ces champs peuvent être stockés sous `metadata_json.capture_routing`, mais toute nouvelle API doit exposer le contrat typé et ne pas obliger les clients à interpréter le JSON.

## 8. API et comportement des surfaces

### 8.1 Création

`POST /v1/knowledge-sessions` doit accepter une intention de capture et une cible. Le serveur résout le corpus principal si `project_id` est fourni.

`POST /v1/knowledge-sessions/{id}/recorder-sync` doit pouvoir compléter ou modifier la cible tant que `target_locked_at` est nul et que la session n'est pas promue.

### 8.2 Liste recorder

`GET /v1/knowledge-sessions/recordable` doit retourner les sessions planifiées, les sessions de projet, les sessions corpus et les sessions inbox explicitement accessibles à l'utilisateur. Le client doit afficher une séparation visuelle entre :

- réunions prévues ;
- enregistrements récents à classer ;
- captures liées à un projet ;
- entretiens destinés à un corpus.

### 8.3 Actions de promotion

Ajouter des actions explicites et idempotentes :

- `POST /{session_id}/classify` ;
- `POST /{session_id}/promote-to-project` ;
- `POST /{session_id}/promote-to-corpus` ;
- `POST /{session_id}/keep-private` ;
- `POST /{session_id}/reject`.

Chaque action doit vérifier les droits sur le workspace, le projet et le corpus, écrire un événement d'audit et préserver le lien vers la session source.

## 9. Règles de non-ambiguïté

1. Une surface de capture ne détermine jamais la destination.
2. `session_type` ne détermine jamais à lui seul la promotion.
3. Le workspace n'est jamais utilisé comme corpus par défaut.
4. Un projet résout toujours son corpus principal ; le client ne duplique pas cette logique.
5. Une cible proposée par un modèle n'est jamais une cible verrouillée.
6. Une session inbox peut être classée après coup sans recréer l'audio ni le transcript.
7. Une réunion opérationnelle produit par défaut des sorties projet, pas un document corpus.
8. Un entretien d'expert produit par défaut un candidat documentaire, pas une page publiée sans revue.
9. Aucun contenu d'une session non classée ne doit être visible dans la recherche d'un corpus.
10. Toute promotion est traçable, réversible au niveau du document promu et liée à la session source.

## 10. Priorité d'implémentation

### P0 - verrouiller le contrat

- ajouter les enums et champs de ciblage ;
- résoudre le corpus principal d'un projet côté serveur ;
- créer le statut `staged_unassigned` ;
- faire fonctionner `Record now` sans projet ni corpus ;
- interdire l'indexation d'une session inbox ;
- afficher la cible et la politique de promotion avant démarrage quand elles sont connues.

### P1 - rendre la revue opérable

- page staging workspace ;
- génération d'un document candidat pour les entretiens ;
- actions de promotion, conservation privée et rejet ;
- événements d'audit et provenance ;
- reprise après crash et synchronisation des captures IndexedDB.

### P2 - intelligence de classement

- suggestions projet/corpus basées sur le titre, le sujet, le transcript et les corpus accessibles ;
- confirmation utilisateur obligatoire ;
- score, justification et possibilité de corriger la suggestion ;
- détection des doublons et proposition de fusion.

## 11. Critères d'acceptation

La conception est considérée comme correcte lorsque les scénarios suivants sont vérifiables :

| Scénario | Résultat obligatoire |
|---|---|
| Meeting planifié avec projet | session projet, corpus principal résolu, décisions/actions projet, pas d'indexation automatique du transcript brut |
| Entretien expert avec corpus | session corpus, document candidat en staging, revue avant indexation |
| Entretien expert avec projet | projet conservé comme contexte, corpus principal proposé/résolu, promotion documentaire explicite |
| `Record now` authentifié | session inbox dans le workspace, jamais de corpus inventé |
| `Record now` offline | audio et métadonnées en IndexedDB, synchronisation ultérieure en `staged_unassigned` |
| Réunion improvisée puis projet choisi | rattachement au projet sans recréer la session |
| Session restée non classée | transcript absent de la recherche corpus, visible seulement dans le staging autorisé |
| Projet supprimé ou corpus inaccessible | session conservée, cible marquée invalide, aucune réindexation silencieuse |

## 12. Conclusion

## 13. Règle d'intégration pour Eigen Companion

### Réponse à la question de développement

Quand Eigen Companion rejoint une session planifiée, il doit respecter les métadonnées canoniques de la session. La réponse de référence est donc :

> Comme le dock web : la session planifiée est canonique ; Companion s'y branche comme un appareil de capture et ne remplace pas son titre, son lieu, son projet, son agenda ni ses participants.

Companion peut transmettre des observations d'exécution, par exemple la qualité du micro, le nom de l'ordinateur, l'état réseau, la localisation effectivement observée ou les participants distants détectés. Ces observations doivent être ajoutées dans les métadonnées de l'appareil ou dans un journal de capture, et non écraser le contexte planifié.

Le backend accepte explicitement `metadata_json.recorder_join_mode = "canonical"` sur `recorder-sync`. Dans ce mode, `project_id`, titre, sujet, agenda et lieu de la session restent inchangés ; les informations propres au recorder sont conservées sous `metadata_json` avec leur source.

### Contrat d'intégration Companion

```json
{
  "session_id": "planned-session-id",
  "recorder_join_mode": "canonical",
  "recorder_surface": "eigen_companion",
  "device_name": "Gabriel's MacBook",
  "observed_location": {
    "label": "Paris",
    "geo_lat": 48.8566,
    "geo_lng": 2.3522,
    "source": "companion"
  }
}
```

Décision d'usage :

- `meeting` / `project_meeting` : la session planifiée reste la source de vérité métier ; Companion ajoute un device et des traces de capture ;
- `expert_interview` : la session planifiée reste la source de vérité, et le contenu peut produire un candidat corpus ;
- `voice_note` / `free_recording` : Companion crée une session inbox si aucune session n'est choisie ;
- un changement volontaire de projet ou de corpus doit être une action de classement explicite après la capture, jamais un effet secondaire du join.

Cela évite qu'un laptop rejoignant une réunion modifie silencieusement le projet ou le lieu prévus, tout en permettant de conserver la localisation réelle et les détails techniques comme preuves d'exécution.

Le choix central est de ne pas opposer “meeting” et “corpus” comme deux types d'enregistrement. Une même session de capture peut servir une réunion, une collecte de connaissance ou une note ; ce qui change est l'intention, la cible et la politique de promotion.

Le flux robuste est donc :

```text
Capturer d'abord
  -> rattacher au projet si connu
  -> sinon choisir un corpus si le but est documentaire
  -> sinon conserver en inbox/staging
  -> promouvoir explicitement vers le projet ou le corpus
```

Cette règle permet de conserver la fluidité de l'enregistrement local/offline-first décrite dans l'architecture Eigen Meeting, tout en évitant qu'un transcript brut, une note improvisée ou une réunion opérationnelle ne deviennent automatiquement du savoir canonique.

## Sources et périmètre

Le document d'architecture joint décrit les surfaces iOS/PWA/web, la création de `KnowledgeSession`, les chemins stream et local/offline-first, IndexedDB, les endpoints de synchronisation et les états techniques de capture. Le présent document ajoute les décisions de routage métier qui ne sont pas déterminées par cette architecture technique.
