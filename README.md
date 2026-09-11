# ChatGPT Mini-Bridge

> La topologie sécurisée, l’idempotence, la matrice de retry et les procédures
> d’exploitation sont décrites dans
> [`docs/chatgpt_bridge_operations.md`](docs/chatgpt_bridge_operations.md).

API locale compatible OpenAI, servie par ton onglet `chatgpt.com` via une extension Chrome.

Les URLs `http://127.0.0.1:8001/v1` ci-dessous concernent les clients lancés
directement sur l’hôte.

```
[ton script]  ──POST 127.0.0.1:8001/v1/chat/completions──>  [server.py launcher]
                                                                   ▼
                                                         [bridge/app.py (FastAPI)]
                                                                   ▲
                                                          WebSocket │ /ws
                                                                   ▼
                                                     [service worker (background.js)]
                                                                   │ chrome.tabs.sendMessage
                                                                   ▼
                                                   [content.js → DOM de chatgpt.com]
```

Pas de Cloudflare à contourner : c'est un vrai navigateur, déjà authentifié.

## Déploiement autonome (Docker Compose)

Depuis la racine de ce dépôt :

```bash
cp .env.example .env      # renseigner BRIDGE_API_KEY et BRIDGE_WS_TOKEN
make up                   # docker compose up -d --build --wait chatgpt-bridge
make status               # health, ready, capabilities, sans afficher de secret
make logs
make down                 # conserve le volume bridge_data
```

Le volume Docker nommé `bridge_data` conserve le registre SQLite
(`/data/bridge-runs.sqlite3`) entre `down` et le prochain `up`. `/health`
indique que le serveur répond ; `/ready` indique que le Bridge est réellement
utilisable, notamment lorsque l'extension est connectée.

Le serveur ne consomme que ses variables `BRIDGE_*`. Chaque application cliente
configure séparément son URL HTTP et envoie `Authorization: Bearer
<BRIDGE_API_KEY>` sous le nom de variable qui lui est propre. Le port est publié
sur `127.0.0.1` par défaut ; un client conteneurisé d'une autre stack exige un
autre `BRIDGE_BIND_ADDRESS` (voir « Topologie » dans
[`docs/chatgpt_bridge_operations.md`](docs/chatgpt_bridge_operations.md)).

## Installation

**1. Serveur**

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python server.py
```

**2. Extension**

`chrome://extensions/` → active **Mode développeur** → **Charger l'extension non empaquetée** → choisis le dossier `extension/`.

**3. Onglet ChatGPT**

Ouvre `https://chatgpt.com/` (connecté). L'icône de l'extension doit afficher une pastille verte ; le serveur logue `✅ Extension Chrome connectée`.

## Le client CLI : `chat.py`

Zéro dépendance (bibliothèque standard uniquement) — c'est l'outil de test principal.

```bash
./chat.py "Explique-moi les décorateurs Python"      # réponse en flux
./chat.py -f notes.txt -f schema.png "Analyse ça"    # pièces jointes
cat rapport.md | ./chat.py "Fais-en 5 points"        # stdin en contexte
./chat.py --new "Écris un backup" --save-code ./out  # blocs de code → fichiers
./chat.py "..." --out reponse.md --no-stream
./chat.py --json "..."                               # réponse OpenAI brute
```

| Option | Rôle |
|---|---|
| `-f, --file` | pièce jointe, répétable |
| `--mode` | `auto` (défaut) : voir ci-dessous. Ou `inline` / `upload` pour forcer |
| `--max-inline` | seuil en octets au-delà duquel un fichier texte devient pièce jointe (8192) |
| `-s, --system` | message système en tête |
| `-n, --new` | repart d'une conversation vierge |
| `-o, --out` | écrit la réponse dans un fichier |
| `--save-code` | extrait chaque bloc ``` dans un fichier, extension déduite du langage |
| `--json`, `--no-stream` | réponse brute / non-streamée |
| `--url`, `--key`, `--model`, `--timeout` | ciblage du serveur |

Le mode `auto` arbitre selon la taille et le type : un fichier texte **court** est injecté dans
le prompt (le modèle le voit directement, sans dépendre d'un sélecteur de l'UI) ; au-delà de
`--max-inline`, ou si le fichier est binaire, il devient une **pièce jointe** déposée dans le
composer — son contenu n'est alors plus payé en tokens à chaque requête.

Les pièces jointes partent au format standard de l'API OpenAI : bloc `image_url` (data URI)
pour les images, bloc `file` pour le reste. N'importe quel client OpenAI peut donc faire pareil.

## Utilisation via HTTP

```bash
curl http://127.0.0.1:8001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"chatgpt-web","messages":[{"role":"user","content":"Raconte une blague courte."}]}'
```

Avec le SDK officiel — le serveur accepte le streaming comme le non-streaming. Le transport
DOM est toutefois `final_delta_only` : une requête SSE reçoit un unique delta final après la
stabilisation, et non les versions intermédiaires que ChatGPT peut réécrire :

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8001/v1", api_key="peu-importe")

client.chat.completions.create(
    model="chatgpt-web",
    messages=[{"role": "user", "content": "Salut"}],
    stream=True,
    extra_body={"new_chat": True},   # repart d'une conversation vierge
)
```

| Endpoint | Rôle |
|---|---|
| `POST /v1/chat/completions` | `stream: true` (SSE) et `false` |
| `POST /v1/responses` | sous-ensemble texte, `web_search`, JSON Schema et background |
| `GET /v1/responses/{id}` | polling d'une réponse de fond locale |
| `POST /v1/bridge/runs` | contrat natif et honnête utilisé par l'application CTI |
| `GET /v1/bridge/runs/{id}` | polling natif d'un run bridge |
| `GET /v1/bridge/capabilities` | capacités statiques et dernier snapshot UI, sans accès DOM |
| `GET /v1/bridge/metrics` | compteurs opérationnels sans contenu sensible |
| `GET /v1/bridge/ui` | état pilotable de l'onglet (`?probe=true` énumère les choix) |
| `POST /v1/bridge/ui/controls` | applique un réglage hors run (profil, modèle, recherche) |
| `GET /v1/models` | seulement le libellé neutre `chatgpt-web` ; les entrées connues du sélecteur UI sont listées à part dans `ui_models` (sélection via `bridge_ui_model`) |
| `GET /health` | extension connectée ? qui la détient ? requête en cours ? |
| `GET /ready` | configuration, SQLite et disponibilité fonctionnelle de l’extension |

### Un moteur durable pour les trois façades

Les trois endpoints de génération convergent vers le même moteur de run détaché :

```text
/v1/responses       ─┐
/v1/chat/completions ├──> DurableRunService ──> SQLite
/v1/bridge/runs     ─┘
```

La compatibilité OpenAI est émulée et limitée aux formats documentés ici. Le champ
`model` envoyé par un client reste une étiquette de traçabilité : il ne sélectionne
jamais le modèle de l'interface ChatGPT. Le contrôle UI explicite passe par
`bridge_ui_model` sur `/responses` ou `ui_model` sur `/bridge/runs`.

Les réponses Responses en background restent récupérables après redémarrage grâce à
SQLite. Une exécution interrompue (`queued` ou `running`) devient `failed` au
démarrage suivant et n'est jamais rejouée implicitement. `/v1/bridge/*` reste la
surface native de contrôle, diagnostic et recovery.

`X-Idempotency-Key` est accepté par `/v1/responses` et `/v1/chat/completions` :
une même clé et un même payload rejoignent le run existant, tandis qu'un payload
différent donne `409 bridge_payload_conflict`. Sans clé, le run reçoit une clé
non-retryable mais reste récupérable par son identifiant Responses.

### Fichiers : format OpenAI standard

Les blocs de contenu de l'API officielle sont compris tels quels et transformés en pièces
jointes déposées dans le composer — les médias ne transitent donc pas par le prompt :

```python
client.chat.completions.create(model="chatgpt-web", messages=[{"role": "user", "content": [
    {"type": "text", "text": "Décris cette image"},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}},
    {"type": "file", "file": {"filename": "rapport.pdf", "file_data": "data:application/pdf;base64,..."}},
]}])
```

| Bloc | Traitement |
|---|---|
| `text` | concaténé dans le prompt |
| `image_url` avec data URI | pièce jointe (le nom est généré : l'API n'en transporte pas) |
| `image_url` avec URL distante | l'URL est laissée dans le prompt, rien n'est téléchargé |
| `file` avec `file_data` | pièce jointe, `filename` conservé |
| autres (`input_audio`…) | ignorés, sans équivalent dans l'UI |

Deux champs hors standard restent acceptés (via `extra_body` avec le SDK) :

| Champ | Rôle |
|---|---|
| `new_chat` | `true` pour repartir d'une conversation vierge |
| `files` | `[{"name": ..., "mime": ..., "data": "<base64>"}]` — raccourci maison, fusionné avec les blocs |

## Contrôles de l'interface : modèle, profil, recherche web

L'extension sait lire et piloter trois réglages de l'UI ChatGPT. **Chaque contrôle est
appliqué puis relu dans le DOM** ; sans cette relecture concordante, il est déclaré en échec
avec sa raison, jamais « appliqué » par optimisme.

```bash
curl -s localhost:8001/v1/bridge/ui?probe=true      # état + énumération des choix
curl -s localhost:8001/v1/bridge/ui/controls -H 'Content-Type: application/json' \
     -d '{"profile":"Équipe CTI","model":"GPT-5 Thinking","web_search":false}'
```

Dans un run, les mêmes réglages sont appliqués **à l'intérieur du verrou** qui sérialise les
générations : aucune autre requête ne peut rebasculer l'interface entre la vérification et
l'envoi du prompt.

```bash
curl -s localhost:8001/v1/bridge/runs -H 'Content-Type: application/json' -d '{
  "requested_model": "premium-profile",
  "ui_model": "GPT-5 Thinking",
  "profile": "Équipe CTI",
  "web_search": true,
  "input": "Que sait-on de CVE-2024-3094 ?"}'
```

| Champ | Rôle |
|---|---|
| `requested_model` | **étiquette** de traçabilité de l'appelant ; ne pilote rien (l'UI ne connaît pas ces noms) |
| `ui_model` | entrée du sélecteur de modèle à appliquer et vérifier |
| `profile` | profil / espace de travail ChatGPT à sélectionner d'abord |
| `web_search` | `true` active l'outil, `false` **le désactive** (sinon un reste d'état pollue les runs suivants) |
| `allow_unverified_model` | `true` accepte un run dont le modèle n'a pas pu être appliqué |

Ce que le bridge en dit ensuite, dans la réponse :

| Champ | Signification |
|---|---|
| `model` | libellé **lu** dans le sélecteur, ou `chatgpt-web` quand il n'est pas lisible |
| `metadata.model_source` | `ui_observed` ou `unknown` |
| `metadata.web_search_mode` | `ui_tool` (outil activé et vérifié), `prompt_instructed` (repli), `off`, `off_unverified`, `untouched` |
| `metadata.controls` | résultat détaillé de chaque contrôle : `requested`, `applied`, `verified`, `ok`, `reason` |

Les règles de dégradation sont volontairement asymétriques :

- **`ui_model` ou `profile` non vérifiés → le run échoue** (`409`, ou `502` si l'UI est
  injoignable). Dans une chaîne de traçabilité, un run attribué au mauvais modèle est pire
  qu'un run manquant. `allow_unverified_model` lève la règle pour le modèle uniquement.
- **`web_search` non vérifiable → repli sur l'instruction dans le prompt**, signalé par
  `web_search_mode: "prompt_instructed"`. C'est le comportement historique du bridge, qui
  reste disponible mais n'est plus confondu avec l'activation réelle de l'outil.

`GET /v1/bridge/capabilities` reflète le dernier snapshot connu sans contacter le DOM ; le
bloc `ui` indique son âge et s'il est périmé. `?probe=true` déclenche explicitement la lecture
active et ouvre les menus pour énumérer modèles et profils — c'est visible à l'écran, donc
fait après la génération en cours et mis en cache 60 s.

`/v1/chat/completions` ne pilote rien : son champ `model` reste ignoré, comme avant.
Il refuse `response_format` en 422 (`unsupported_parameter`, `pre_submission`)
au lieu de l'ignorer : aucune sortie structurée n'y est implémentée.

## Configuration (variables d'environnement)

| Variable | Défaut | Rôle |
|---|---|---|
| `BRIDGE_HOST` / `BRIDGE_PORT` | `127.0.0.1` / `8001` | écoute du serveur |
| `BRIDGE_API_KEY` | *(vide)* | si défini, exige `Authorization: Bearer <clé>` |
| `BRIDGE_WS_TOKEN` | *(obligatoire)* | jeton d'appairage distinct de l'extension |
| `BRIDGE_RUN_DB` | `data/bridge-runs.sqlite3` | registre durable d'idempotence |
| `BRIDGE_IDLE_TIMEOUT` | `120` | secondes sans le moindre paquet avant abandon |
| `BRIDGE_TOTAL_TIMEOUT` | `900` | durée max d'une génération |
| `BRIDGE_UI_TIMEOUT` | `30` | durée max d'une lecture ou d'un pilotage de l'interface |
| `BRIDGE_UI_PROBE_TTL` | `60` | validité d'une énumération des menus (elle les ouvre à l'écran) |
| `BRIDGE_SHUTDOWN_GRACE_SECONDS` | `20` | délai de drainage avant annulation prudente des runs |

L'URL du WebSocket côté extension se change dans le popup (utile si tu changes `BRIDGE_PORT`).

## Tester sans navigateur

`examples/fake_extension.py` simule l'extension et renvoie un écho — pratique pour valider le serveur seul :

```bash
.venv/bin/python examples/fake_extension.py   # dans un 2e terminal
.venv/bin/python examples/test_client.py
```

> **Un seul client à la fois peut tenir le pont.** Désactive l'extension Chrome (ou ferme
> l'onglet chatgpt.com) avant de lancer `fake_extension.py`, sinon le serveur ferme la
> connexion du perdant avec le code `4000 replaced`. C'est voulu : c'est ce qui permet à un
> rechargement d'onglet de reprendre le pont sans redémarrer le serveur. `GET /health` indique
> qui le détient (`"client"`), et le bouton du popup force la reprise par l'extension.

Les scripts d'exemple suivent `BRIDGE_HOST` / `BRIDGE_PORT` / `BRIDGE_API_KEY` ; la fausse
extension exige aussi `BRIDGE_WS_TOKEN` :

```bash
BRIDGE_PORT=8001 .venv/bin/python examples/test_client.py "ta question"
```

## Quand l'UI d'OpenAI change

Tout ce qui dépend du HTML d'OpenAI est regroupé dans l'objet `SELECTORS` en tête de
`extension/content.js`. Chaque entrée est une liste d'alternatives essayées dans l'ordre :
ajoute le nouveau sélecteur en première position, rien d'autre à toucher.

## Détails d'implémentation qui comptent

- **Un seul lecteur du WebSocket.** Le serveur route les paquets par `id` de requête vers une
  queue dédiée. Sans ça, l'endpoint `/ws` et le handler HTTP se volent mutuellement les messages.
- **Requêtes sérialisées** (`bridge.slot`) : l'UI web ne peut générer qu'une réponse à la fois.
  Les requêtes concurrentes font la queue au lieu de se mélanger.
- **Saisie par `insertText`**, pas par `innerHTML` : ProseMirror ignore les mutations DOM
  directes, et `innerHTML` casse sur tout prompt contenant `<`, `&` ou un retour ligne.
- **Extraction Markdown** plutôt que `innerText` : les libellés des boutons « Copier » des blocs
  de code sont exclus, et les blocs sont rebalisés en ``` avec leur langage.
- **Rien de transmis qui puisse encore bouger.** Le sérialiseur referme les blocs de code, donc
  le ``` de fermeture se déplace tant que le code s'écrit : l'émettre au fil de l'eau
  entrelaçait les délimiteurs au milieu du code. Le bloc en cours est donc laissé **ouvert**
  pendant la génération et refermé au dernier relevé. Le reste du diff se fait par préfixe
  commun, car le rendu Markdown peut réécrire le texte déjà lu.
- **Aucune référence DOM gardée.** React remplace le nœud du message entre la phase de
  réflexion et la réponse ; le tour est donc re-cherché à chaque relevé via l'identifiant
  stable de son conteneur (`conversation-turn-N`).
- **Pas de conteneur `.markdown` = la réponse n'a pas commencé** (mesuré : pendant la phase
  « Thinking », le tour n'en contient aucun). Évite de diffuser le texte de réflexion.
- **Un réglage d'interface n'est « appliqué » qu'après relecture.** Cliquer une entrée de menu
  ne prouve rien : React peut ignorer le clic, l'entrée peut avoir changé de sens. Le content
  script relit donc le libellé du déclencheur (ou l'état du bouton) et ne renvoie `ok: true`
  qu'en cas de concordance. Les contrôles sont appliqués **dans** le verrou de sérialisation,
  sinon une autre requête pourrait rebasculer l'UI entre la vérification et l'envoi.
- **WebSocket dans le service worker**, pas dans le content script : il survit aux navigations
  SPA et échappe à la CSP de la page. Le serveur ping toutes les 20 s et une alarme le réveille
  toutes les 30 s, car un service worker MV3 inactif est arrêté par Chrome.
- **Un arrêt du service worker ne perd plus la réponse.** Chrome peut le tuer et le relancer en
  pleine génération : les messages produits pendant la coupure sont mis en file d'attente côté
  extension et rejoués à la reconnexion, et le serveur accorde un délai de grâce
  (`BRIDGE_RECONNECT_GRACE`, 20 s) avant d'abandonner la requête en cours.
- **Les blocs de code ChatGPT sont des `<pre>` imbriqués.** Le sérialiseur ne visitant que le
  `<pre>` extérieur, c'est lui qui doit être repéré comme « en cours d'écriture » — viser le
  dernier `<pre>` en ordre document désignait l'intérieur et entrelaçait les délimiteurs.
- **Le DOM n'est pas append-only.** L'UI peut réécrire un bloc, son langage ou une section
  Markdown déjà rendue. L'extension observe ces snapshots localement, maintient la connexion
  par heartbeat puis transmet une seule fois le texte final vérifié dans le paquet `done`.

## Limites

- **Les sélecteurs des contrôles d'interface n'ont pas encore été confrontés à l'UI réelle**
  (contrairement à ceux du streaming, mesurés). Ils sont écrits pour échouer visiblement : si
  un déclencheur a changé de nom, le contrôle rend `ok: false` avec sa raison et le run
  s'arrête — il ne part pas avec le mauvais modèle. Première chose à vérifier au branchement :
  `GET /v1/bridge/ui?probe=true` doit énumérer les modèles réellement affichés.
- La façade Responses est une adaptation vers l'UI, pas le service Responses natif : les tokens
  sont estimés et les objets sources structurés de `web_search` ne peuvent pas être
  reconstruits. Le modèle rapporté est le **libellé affiché** par le sélecteur, pas le snapshot
  exact servi par OpenAI ; quand il n'est pas lisible, le bridge dit `chatgpt-web`.
- Les trois façades de génération partagent le même moteur durable SQLite ; les réponses
  Responses en background survivent à la reconstruction du serveur. Un run interrompu par
  un redémarrage échoue sans resoumission implicite.
- Structured Outputs est demandé dans le prompt, puis doit impérativement être revalidé par le
  client contre son schéma.
- Le contrat `/v1/bridge/*` est celui à privilégier dans l'application : il expose explicitement
  comment `web_search` a été obtenue (`ui_tool` ou `prompt_instructed`), Structured Outputs
  comme prompt revalidé côté client, et une idempotence durable pour les runs natifs.
- `reasoning_effort` reste accepté puis ignoré : ce réglage n'a pas de contrôle vérifiable dans
  l'UI, et le bridge préfère ne rien promettre.

- Les `usage.*_tokens` sont estimés (`len/4`) : l'UI web ne renvoie aucun décompte réel.
- `temperature`, `top_p`, `max_tokens`… sont acceptés puis ignorés — sans équivalent dans l'UI.
- Un seul onglet ChatGPT est piloté (l'actif en priorité), et une génération à la fois.
- Les images passées en **URL distante** ne sont pas téléchargées : seules les data URI
  deviennent des pièces jointes.
- **Récupérer des fichiers produits par ChatGPT** (sorties du code interpreter, liens
  `sandbox:/mnt/data/…`) n'est pas géré : il faudrait cliquer les liens et intercepter les
  téléchargements. `--save-code` couvre le cas courant en extrayant les blocs de code de la
  réponse.
- Sur une question portant sur une image, le libellé d'état « Analyzing image » de l'UI peut
  se retrouver collé en tête de réponse. Les régions `aria-live` sont écartées du texte lu,
  mais ce cas précis n'a pas été reconfirmé après correction.

## Diagnostic quand quelque chose cloche

`extension/content.js` porte une constante `DEBUG`. Passée à `true`, elle journalise dans la
console de l'onglet, à chaque changement d'état, ce que voit la boucle de streaming :

```
[bridge] fini=false root=DIV.markdown pre=2 | queue="…\n```python"
```

`fini` (fin détectée), `root` (conteneur lu), `pre` (blocs de code vus) et la fin du texte
suffisent en général à localiser un changement d'UI. `tools/diagnose.js`, à coller dans la
console, enregistre en parallèle la structure réelle de la page pendant 90 s.

⚠️ Recharger l'extension ne remplace pas le content script des onglets déjà ouverts — d'où le
rechargement automatique des onglets ChatGPT à l'installation, et le numéro de version affiché
au démarrage pour vérifier quel code tourne réellement.
