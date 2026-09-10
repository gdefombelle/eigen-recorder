# Typologie des sessions EigenVertex

Référence unique, partagée entre Eigen Meeting et Eigen Companion.
Ce fichier doit être **identique dans les deux dépôts**. Toute évolution se
fait ici d'abord, jamais dans un seul client.

Backend déployé et vérifié le 26 août 2026. Migration `ffj6d7e8f9a0`.

---

## Règle fondamentale

**Le type de session, le contexte métier et le rattachement projet/corpus
sont trois choses différentes.**

Ne jamais coder dans `session_type` le fait qu'une réunion appartienne à un
projet — c'est ce que porte `project_id`. Ne jamais coder le contexte métier
dans le type — c'est `business_context`.

---

## Les six valeurs canoniques de session_type

```
meeting
interview
event
media_capture
field_visit
voice_note
```

**Aucune autre valeur ne doit être envoyée en création.** Les anciennes —
`project_meeting`, `expert_interview`, `client_interview`, `workshop`,
`debate`, `expert_presentation`, `audit_session`, `follow_up`,
`free_recording`, `other` — ne sont plus acceptées par le backend en
création, mise à jour ou démarrage immédiat.

Si un cas d'usage ne rentre dans aucune des six, **signaler l'écart** plutôt
que de retomber sur une valeur approchante.

---

## interaction_subtype — chaîne libre, conventions imposées

Le champ est une chaîne libre de 64 caractères, sans validation serveur. La
cohérence est donc **entièrement à la charge des clients**. Ces conventions
sont normatives :

| session_type | interaction_subtype |
|---|---|
| `meeting` | `project` |
| `meeting` | `workshop` |
| `interview` | `expert` |
| `interview` | `client` |
| `interview` | `candidate` |
| `event` | `webinar` |
| `event` | `conference` |
| `media_capture` | `podcast` |
| `field_visit` | *(aucun)* |
| `voice_note` | *(aucun)* |

Une valeur hors de cette table doit être ajoutée **ici d'abord**, dans les
deux dépôts, avant d'être envoyée par un client.

---

## business_context — chaîne libre

```
hr
sales
research
internal
```

Autre valeur possible, normalisée, ajoutée ici d'abord.

Ne pas renseigner quand le contexte n'est pas explicite. `null` est une
réponse valide — notamment pour une réunion de projet.

---

## knowledge_intent — énumération serveur

```
operate_project
collect_knowledge
personal_note
undecided
```

---

## target_type — énumération serveur

```
project
corpus
inbox
```

Une session **n'a pas besoin** d'un projet ni d'un corpus.

---

## capture_inbox_status — énumération serveur

```
pending_review
not_required
staged_unassigned
staged_targeted
classified
promoted
kept_private
rejected
archived
```

**À la création, ne pas envoyer ce champ.** Le backend le dérive :

- `target_type` = `project` ou `corpus` → `not_required`
- `target_type` = `inbox` → `pending_review`

---

## Les six cas d'usage

### Cas 1 — Enregistrement immédiat (« Record Now »)

```
session_type          voice_note
knowledge_intent      personal_note
target_type           inbox
project_id            null
target_corpus_id      null
capture_inbox_status  omis (dérivé en pending_review)
```

Titre généré automatiquement, par exemple « Note 18:23 ».

### Cas 2 — Réunion de projet

```
session_type          meeting
interaction_subtype   project
knowledge_intent      operate_project
project_id            renseigné
target_type           project
target_corpus_id      seulement si le backend le demande explicitement
business_context      null
```

### Cas 3 — Interview d'expert

```
session_type          interview
interaction_subtype   expert
knowledge_intent      collect_knowledge
target_type           corpus si un corpus est choisi, sinon inbox
```

### Cas 4 — Interview client ou candidat

```
session_type          interview
interaction_subtype   client | candidate
business_context      sales | hr
knowledge_intent      collect_knowledge
target_type           selon le choix EXPLICITE de l'utilisateur
```

**Ne jamais router automatiquement vers un corpus d'expertise.** Un entretien
de recrutement ou un entretien commercial ne se verse pas dans un corpus de
connaissance sans décision de l'utilisateur.

### Cas 5 — Webinaire, conférence, podcast

```
event         + webinar
event         + conference
media_capture + podcast
```

Ne pas créer un nouveau `session_type` par variante — c'est précisément ce
que `interaction_subtype` sert à éviter.

### Cas 6 — Session planifiée rejointe

Quand un client rejoint une session existante :

- réutiliser **exactement** son `session_id` ;
- ne **jamais** créer une seconde session ;
- conserver titre, sujet, lieu, participants, projet ;
- ne modifier ces valeurs qu'après une action **explicite** de l'utilisateur ;
- ajouter seulement la source de capture dans `metadata_json`.

La session backend est canonique. Le client s'y branche, il ne la réécrit
pas.

**Transport :** envoyer uniquement les champs réellement modifiés, sous forme
de patch. Jamais une copie complète de l'état local — le serveur fusionne
champ par champ via `model_fields_set`, et envoyer tout écraserait des
valeurs que l'utilisateur n'a pas touchées.

---

## Exemple canonique vérifié

Session réelle en base, à utiliser comme référence de contrôle :

```json
{
  "id": "840de793-a192-402d-bfe1-55301af21d4f",
  "title": "Lancement",
  "session_type": "meeting",
  "interaction_subtype": "project",
  "business_context": null,
  "project_id": "4bda0185-8d2c-48aa-9ee0-9f0d6cefb3ff",
  "target_corpus_id": "c21c05b6-f960-4e40-8cff-0db463b9cb71",
  "knowledge_intent": "operate_project",
  "target_type": "project",
  "capture_inbox_status": "not_required"
}
```

---

## Hors ligne et rattrapage

- conserver un identifiant de session **stable** ;
- réutiliser les **mêmes** identifiants de chunks ;
- rendre les tentatives de renvoi idempotentes ;
- vérifier qu'un rattrapage ne crée pas de doublon ;
- vérifier qu'un enregistrement immédiat reste dans la Capture Inbox.

---

## En cas d'incompatibilité

Si l'API refuse une valeur de ce document, **ne pas la remplacer
silencieusement** par une valeur approchante — surtout pas `other`.

Signaler précisément l'écart : quel champ, quelle valeur envoyée, quelle
réponse du serveur. Utiliser une valeur de repli uniquement si c'est
indispensable pour avancer, et le documenter comme dette explicite.

Un client qui contourne en silence produit un dialecte, et deux clients qui
contournent chacun de leur côté produisent deux dialectes incompatibles.
