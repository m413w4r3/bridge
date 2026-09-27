# Bridge ChatGPT durci

## Topologie

Le bridge est un service autonome : ce dépôt le construit, le démarre
(`make up`) et possède son volume `bridge_data`. Aucune application cliente ne
le démarre, ne gère ses volumes ni n’en dépend pour démarrer. Le port hôte est
publié sur `${BRIDGE_BIND_ADDRESS:-127.0.0.1}:${BRIDGE_PORT:-8001}` ;
l’extension Chrome se connecte à `ws://127.0.0.1:8001/ws` avec son jeton
d’appairage. L’absence de l’extension reste un état dégradé : `/health` répond,
`/ready` répond 503.

Chaque client fournit sa propre URL de base :

| Client | URL de base | `BRIDGE_BIND_ADDRESS` |
|---|---|---|
| processus sur l’hôte | `http://127.0.0.1:8001/v1` | `127.0.0.1` (défaut) |
| conteneur d’une autre stack, Linux | `http://host.docker.internal:8001/v1` avec `extra_hosts: ["host.docker.internal:host-gateway"]` | passerelle `docker0` (souvent `172.17.0.1`) ou `0.0.0.0` |
| conteneur d’une autre stack, Docker Desktop | `http://host.docker.internal:8001/v1` | à vérifier sur la plateforme |

Sous Linux, un port publié sur `127.0.0.1` n’est **pas** joignable depuis un
conteneur via `host.docker.internal` : `host-gateway` résout vers la passerelle
`docker0`, et la connexion est refusée. La correction minimale est
`BRIDGE_BIND_ADDRESS=172.17.0.1` (adresse donnée par
`ip -4 addr show docker0`) : le port reste hors du LAN mais devient joignable
par les conteneurs locaux et les processus de l’hôte. `0.0.0.0` l’expose en plus
sur toutes les interfaces de l’hôte, LAN compris : ne l’utiliser que derrière un
pare-feu fermant le port depuis l’extérieur. Hors loopback, `BRIDGE_API_KEY`
doit être une valeur forte.

Deux secrets distincts :

- `BRIDGE_API_KEY` authentifie les requêtes HTTP ; chaque client envoie la
  même valeur en `Authorization: Bearer <clé>` sous son propre nom de variable ;
- `BRIDGE_WS_TOKEN` authentifie l’extension WebSocket.

Le serveur refuse les endpoints de pilotage HTTP sans `BRIDGE_API_KEY` lorsqu’il
écoute sur une adresse non locale — toujours le cas dans Compose, où
`BRIDGE_HOST=0.0.0.0` à l’intérieur du conteneur — et refuse toujours `/ws` si
le jeton WebSocket manque ou ne concorde pas.

### Reprise d’un registre existant

Un bridge qui tournait auparavant dans la stack Compose d’une application
cliente a laissé son registre SQLite dans le volume de cette stack (par exemple
`cti-bulletin_bridge_data`) ; ce dépôt utilise `chatgpt-bridge_bridge_data`.
Pour que les retries et la réconciliation des runs antérieurs retrouvent leur
journal, copier une fois le registre, bridge arrêté :

```bash
docker compose down
docker volume create chatgpt-bridge_bridge_data
docker run --rm -v cti-bulletin_bridge_data:/from:ro \
  -v chatgpt-bridge_bridge_data:/to python:3.13-slim cp -a /from/. /to/
make up
```

Reprendre aussi les deux secrets dans le `.env` de ce dépôt (`BRIDGE_API_KEY`,
`BRIDGE_WS_TOKEN`) : le popup de l’extension garde alors son jeton.

## Configuration

| Variable | Usage |
|---|---|
| `BRIDGE_API_KEY` | Bearer HTTP ; le client envoie la même valeur sous son propre nom de variable |
| `BRIDGE_WS_TOKEN` | jeton distinct, saisi dans le popup de l’extension |
| `BRIDGE_RUN_DB` | SQLite durable, `/data/bridge-runs.sqlite3` dans Compose |
| `BRIDGE_RUN_RETENTION_SECONDS` | rétention des runs terminaux, 7 jours par défaut |
| `BRIDGE_RUN_CLEANUP_LIMIT` | nombre maximal de lignes supprimées par nettoyage |
| `BRIDGE_IDLE_TIMEOUT` | silence maximal de l’extension, 300 secondes par défaut |
| `BRIDGE_TOTAL_TIMEOUT` | génération complète, 3600 secondes par défaut |
| `BRIDGE_UI_TIMEOUT` | probe ou contrôle actif de l’UI, 30 secondes par défaut |
| `BRIDGE_UI_SNAPSHOT_STALE` | âge après lequel le dernier snapshot est périmé |
| `BRIDGE_SHUTDOWN_GRACE_SECONDS` | délai de drainage des runs, 20 secondes par défaut |
| `BRIDGE_BIND_ADDRESS` | adresse hôte de publication Compose, `127.0.0.1` par défaut |

Timeouts de connexion et nombre de tentatives côté client relèvent de la
configuration de chaque application cliente.

### Bornes indépendantes

Elles ne se remplacent pas et ne doivent jamais être confondues :

    tour surveillé avec `.streaming-animation` active
        ≠ idle timeout serveur
        ≠ total timeout serveur

1. **Idle timeout réseau/extension** — `BRIDGE_IDLE_TIMEOUT` (300 s). Silence
   total de l’extension côté serveur : plus aucun paquet, heartbeat compris. Un
   heartbeat le réarme, parce qu’il prouve que l’extension et l’onglet vivent.
2. **Attente du premier tour assistant** — aucun délai local lié à la stabilité
   du DOM. Une réflexion réelle peut durer plus de 300 s sans mutation ni
   signal reconnu, surtout après un changement de sélecteur. Le content script
   continue ses heartbeats sans contenu ; la borne totale du serveur clôt une
   attente qui ne produit jamais de réponse. Les ambiguïtés du contrat de
   réponse gardent leurs propres délais de détection.
3. **Garde-fous du tour assistant surveillé** — `FINALIZATION_STALL_MS` (45 s)
   quand l’UI ne se dit plus active, et `WATCHED_TURN_ACTIVE_SIGNAL_STALL_MS`
   (300 s) pour les seuls signaux de streaming bornés
   (`.result-streaming`, `[data-is-streaming='true']`). Un Stop visible ou un
   raisonnement actif peut rester stable plusieurs minutes : il conserve le
   run vivant jusqu’à la borne totale du serveur.

   **Exception `.streaming-animation`.** Quand ce détecteur-là est visible dans
   le périmètre du tour surveillé, la génération est active : le texte peut
   légitimement rester inchangé pendant plusieurs minutes de recherche
   approfondie (deux runs de production sont restés à ~30 caractères pendant
   300 003 ms et 352 002 ms, puis le même tour a rendu la réponse complète). La
   stabilité du texte ne prouve alors rien et ne produit **jamais**
   `active_signal_stalled` : le content script continue d’observer le même tour,
   continue ses heartbeats sans contenu, n’émet ni `done` ni `incomplete` et ne
   resoumet rien. La borne dure redevient la borne 4.

   `.result-streaming` et `[data-is-streaming='true']` gardent leur sémantique
   bornée lorsqu’ils sont le signal actif prioritaire. `assistant_actions`
   reste le signal final le plus fort et finalise immédiatement, même si un
   signal d’activité est encore présent.

   **Une réponse sans boutons d’actions reste finalisable.** La stabilité du
   texte ne conclut jamais pendant un signal actif, mais elle conclut *après*
   sa disparition : c’est le mode `quiescent_stability` (`SETTLE_UNKNOWN_MS`).
   Voir « Finalisation (ACTIVE / QUIESCENT / FINAL) ».
4. **Total generation timeout** — `BRIDGE_TOTAL_TIMEOUT` (3600 s). Plafond
   absolu d’une génération, quelle que soit l’activité observée. Une recherche
   approfondie ChatGPT dépasse couramment le quart d’heure : cette borne protège
   d’une génération réellement bloquée, elle n’arbitre pas la durée normale
   d’une recherche. Un client qui attend le run (par exemple un job de
   worker) doit se donner une borne supérieure, pour parser et persister après.

Aucune de ces bornes ne resoumet le prompt : elles terminent le run
(`bridge_idle_timeout`, `bridge_total_timeout` ou réponse incomplète à la
finalisation) et laissent la réconciliation explicite décider.

### Autonomie en arrière-plan

Chaque Temporary Chat live est l’onglet **actif** de sa **propre fenêtre Chrome**
créée par le bridge (`type: normal`, `focused: false`, `state: normal`, jamais
minimisée). Il ne doit **jamais** avoir besoin d’être focalisé pour qu’une
réponse soit consommée. Le focus reste un outil de debug humain, jamais un
mécanisme de complétion.

**Pourquoi une fenêtre dédiée.** Un onglet créé `active: false` dans la fenêtre
de l’opérateur est un onglet d’arrière-plan : `document.visibilityState` y vaut
`hidden` pendant toute la génération. Une production réelle de ~13 min l’a
prouvé (`started_hidden=true`, `started_has_focus=false`), et elle ne s’est
terminée qu’après une visite humaine de la page. Le cycle de vie visé est :

    tab.active = true            document.visibilityState = visible
    window.focused = false       document.hasFocus() = false

**Une fenêtre par session live**, jamais une fenêtre partagée : une fenêtre
Chrome n’a qu’un seul onglet actif, donc deux générations simultanées dans la
même fenêtre recréeraient exactement le défaut d’arrière-plan pour l’une des
deux.

**Un seul chemin de création** : `createDedicatedTemporaryChat()` dans
`background.js`, utilisé par la réservation de `browser_target` comme par le
`fresh` d’une conversation. L’onglet est résolu depuis le `windowId` exact
(`chrome.tabs.query({ windowId })`, un seul onglet attendu), jamais par une
recherche d’URL ni « le premier onglet chatgpt.com ». Un `continue` ne crée ni
fenêtre ni onglet : il retrouve le binding exact.

**Un seul chemin de fermeture** : `closeBoundTarget()`. La fenêtre dédiée n’est
fermée que si la propriété est *prouvée* depuis l’entrée de registre créée par
le bridge — `bridge_owned_window`, l’onglet exact existe encore, il est toujours
dans le `window_id` enregistré, et cette fenêtre ne contient que lui. Sinon
(propriété non prouvable, ou onglets ajoutés par l’opérateur dans cette
fenêtre), seul l’onglet exact du bridge est fermé. Aucune fenêtre n’est jamais
fermée parce qu’elle contient une URL ChatGPT.

**Fermeture manuelle pendant un run.** Si l’opérateur ferme l’onglet ou la
fenêtre dédiée, `chrome.tabs.onRemoved` purge d’abord les bindings puis émet un
échec typé et fermé : `bridge_extension_disconnected`,
`submission_state=post_submission`, `retryable=false`. Aucune resoumission,
aucune fenêtre de remplacement, aucune conversation reconstruite.

Chrome ralentit les minuteries d’une page masquée : ~1 s en arrière-plan, puis
au plus **une exécution par minute** au-delà de cinq minutes cachées
(*intensive throttling*). Une boucle d’observation uniquement minutée en subit
deux conséquences, qu’il faut distinguer :

- **latence** — constater une fin déjà rendue pouvait prendre deux réveils
  minutés, soit jusqu’à ~2 minutes. C’est légitime, borné, et invisible pour le
  résultat ;
- **correction** — un unique réveil throttlé faisait bondir `stable_for_ms` de 0
  à 60 000 ms, donc au-delà de `FINALIZATION_STALL_MS` (45 s) *à la première
  observation qui suivait la fin*. Une réponse parfaitement terminée
  (`completion_signal=assistant_actions`) partait alors en
  `incomplete/finalization_stalled` au lieu d’un `done`. C’est le seul défaut de
  correction imputable à l’arrière-plan, et il est corrigé.

Trois protections indépendantes, aucune ne pouvant conclure seule :

1. **MutationObserver** (content script) — réveille la boucle d’observation dès
   qu’un nœud, un texte ou un attribut surveillé change. Les callbacks
   d’observateur ne sont pas soumis au throttling des minuteries. La portée est
   la racine du document (React remplace le tour surveillé), compensée par un
   filtre d’attributs fermé et un callback trivial. Les observateurs sont
   déconnectés à la fin de chaque job (`disconnectDomWatchers()`), jamais
   partagés entre deux runs.
2. **`observe_tick`** (service worker → onglet exact) — cadencé par le ping du
   serveur (`KEEPALIVE_INTERVAL`, 20 s), donc par une horloge extérieure à la
   page. Le tick ne fait que **réveiller** la boucle du run exact : il n’émet ni
   heartbeat ni `done` et ne peut donc jamais prétendre que l’observateur DOM
   est vivant. Le content script reste seul auteur de la liveness et de la fin.
3. **Minuterie `POLL_MS`** — repli borné, throttlé, jamais supprimé. Sans ping
   serveur et sans mutation, la boucle continue de tourner (au pire une fois par
   minute), donc les heartbeats continuent : ~60 s au pire face à
   `BRIDGE_IDLE_TIMEOUT` (300 s), soit une marge de 5×. **Ne pas descendre
   `BRIDGE_IDLE_TIMEOUT` sous 120 s**, et ne jamais l’augmenter pour masquer un
   problème d’observation.

`MIN_STALL_OBSERVATIONS` (3) complète ces bornes : un verdict de « figé »
(`finalization_stalled`, `active_signal_stalled`)
exige désormais une durée longue **et** plusieurs observations réelles. Un seul
réveil tardif n’est pas la preuve que la boucle n’a jamais conclu.

**Déchargement d’onglet (*discard*).** Pendant tout un run lié, l’onglet exact
est marqué `autoDiscardable = false` (jamais activé, jamais focalisé), et il le
reste tant qu’une conversation live (KEEP) ou une target y est liée. Si Chrome
le décharge malgré tout, `chrome.tabs.onUpdated` le détecte et le run échoue de
façon typée et fermée : `bridge_extension_disconnected`,
`submission_state=post_submission`, `retryable=false`, `tab_state.discarded=true`
dans les diagnostics. La target exacte est conservée pour une recovery
explicite — aucune resoumission, aucun onglet de remplacement, aucune
conversation reconstruite.

**Ce qui reste interdit** comme chemin de complétion :
`chrome.tabs.update(tabId, { active: true })`, `window.focus()`, un clic
synthétique dans la page ChatGPT, ou tout changement de fenêtre active.

Dans Chrome : charger `chatgpt-bridge/extension`, ouvrir le popup, saisir
`ws://127.0.0.1:8001/ws` et `BRIDGE_WS_TOKEN`, puis reconnecter. Le jeton est
conservé dans `chrome.storage.local`; il n’est ni affiché dans le statut ni écrit
dans les logs.

## Sémantique d’idempotence

Les trois façades utilisent le même claim SQLite et les mêmes états
`queued` → `running` → `completed|failed|needs_review`. `/v1/responses` et
`/v1/chat/completions` acceptent `X-Idempotency-Key`; une clé réutilisée avec un
payload différent est rejetée en `409 bridge_payload_conflict`. Sans clé, ces
façades créent une clé `non_retryable_<uuid>` : le run reste durable, mais ne
doit pas être implicitement rejoué.

`POST /v1/bridge/runs` accepte `X-Idempotency-Key` et `request_id`. Lorsqu’ils
sont tous deux présents, ils doivent être identiques. L’application emploie
l’UUID du `ModelRun`, créé une seule fois avant l’appel réseau.

Le hash SHA-256 canonique couvre le payload JSON hors `request_id`. La table
SQLite associe atomiquement clé, hash, `bridge_run_id`, état, timestamps et
réponse ou erreur finale.

Avec `background=true`, le POST crée ou retrouve ce run puis retourne
immédiatement son identifiant et l'état `queued`/`running`. Une unique tâche
détachée pilote l'extension et écrit le snapshot final dans SQLite. Le client
interroge `GET /v1/bridge/runs/{id}` jusqu'à `completed` ou `failed` ; les
heartbeats de l'extension ne sont jamais concaténés au contenu final.

- même clé et même payload : même run, jointure si en cours, replay si terminé ;
- même clé et payload différent : `409 bridge_payload_conflict` ;
- timeout ou déconnexion du client : la tâche bridge continue et le retry joint
  le run initial ;
- redémarrage après un run terminé : replay SQLite, sans interaction UI ;
- redémarrage pendant un run : échec sûr `bridge_server_error` marqué
  `submission_attempted`, sans nouvelle soumission implicite ; si l'onglet
  Temporary Chat exact est encore disponible, l'opérateur peut lancer la
  recovery visible, sinon il doit l'abandonner explicitement.

L’extension garde en plus les `request_id` dans `chrome.storage.local`. Le
background réserve l’ID avant tout envoi au content script, et le content script
le réserve avant toute manipulation du DOM. Un paquet ou événement WebSocket
dupliqué ne déclenche donc jamais un second clic.

## Capabilities et probe

`GET /v1/bridge/capabilities` ne contacte jamais l’extension. Il retourne les
capacités statiques, la connexion et le dernier snapshot UI avec `observed_at`,
`age_seconds` et `stale`; un snapshot absent n’est pas une erreur.

`GET /v1/bridge/capabilities?probe=true` est l’opération active. Elle peut ouvrir
les menus ChatGPT, attend le verrou de génération et renvoie une erreur typée
`bridge_ui_timeout` ou `bridge_extension_disconnected`.

## Matrice erreurs et retry

| Code | Retry | Action |
|---|---:|---|
| `bridge_unreachable` | oui | vérifier processus, URL client et `BRIDGE_BIND_ADDRESS` (voir Topologie) |
| `bridge_timeout` | oui | vérifier génération et timeouts |
| `bridge_rate_limited` | oui | attendre `Retry-After` |
| `bridge_extension_disconnected` | oui | ouvrir ChatGPT et reconnecter l’extension |
| `bridge_ui_timeout` | oui | vérifier l’onglet et les sélecteurs UI |
| `bridge_response_contract_drift` | non | l’UI a changé de contrat de réponse : lire `details` (comptages) puis étendre les stratégies de ResponseRoot |
| `bridge_server_error` | oui | consulter les logs avec le correlation ID |
| `bridge_auth_failed` | non | corriger/faire tourner le secret HTTP |
| `bridge_payload_conflict` | non | corriger la génération de clé |
| `bridge_protocol_error` | non | aligner versions/contrats |

Le champ `submission_state` prime le tableau : `pre_submission` peut être
retenté après nettoyage ; `submission_attempted` ou `post_submission` exige la
réconciliation du run exact avant toute autre action. Une recovery visible
réussie se confirme par le SHA-256 attendu, puis seulement la target exacte
peut être libérée.

Un POST n’est jamais retenté automatiquement sans clé stable. Avec une clé, le
transport applique un backoff borné avec jitter aux seules erreurs transitoires,
honore `Retry-After` et réutilise strictement la même clé.

## Diagnostic et observabilité

Rechercher dans les logs `bridge_run_id`, `correlation_id` ou l’empreinte courte
`idempotency_fingerprint`. Les événements donnent phase, durée, déduplication et
reconnexion. `GET /v1/bridge/metrics` expose des compteurs sans labels sensibles
(runs, déduplication, conflits, timeouts UI, reconnexions et activité). Les probes de santé réussies ne sont pas journalisées par le
backend. Aucun prompt, réponse, token, cookie ni clé brute ne doit être logué.

`/health` est une liveness rapide et reste à HTTP 200 sans extension. Il expose
les préfixes des identifiants d’installation, de worker et de connexion, ainsi
que l’âge de la connexion et du dernier pong ; il ne renvoie ni identifiant
complet, ni clé, ni URL WebSocket.

`/ready` décrit séparément `server_operational`, la configuration
HTTP/WebSocket, l’accès SQLite et l’état de l’extension. Après acceptation du
socket, le serveur attend au plus cinq secondes un premier paquet `hello`
valide avant d’attacher cette connexion. Les états d’extension sont
`extension_absent`, `extension_handshake_pending`, `extension_stale`,
`extension_conflict` et `extension_available`. Pendant l’arrêt, `/ready`
répond `server_shutting_down` dès que le serveur n’accepte plus de runs, même
si l’extension est encore saine. Seul `extension_available` répond HTTP 200. Une connexion récente peut attendre son premier pong pendant
40 secondes ; ensuite, un pong vieux de plus de 60 secondes rend l’extension
stale. Ces seuils peuvent être réglés avec
`BRIDGE_EXTENSION_HELLO_TIMEOUT`, `BRIDGE_EXTENSION_FIRST_PONG_GRACE`,
`BRIDGE_EXTENSION_PONG_TIMEOUT` et `BRIDGE_EXTENSION_CONFLICT_WINDOW`.

Une extension saine conserve son lease. Un autre owner reçoit une fermeture
`owner_active`, et le conflit est journalisé avec des préfixes d’identifiants.
Une connexion stale peut être remplacée. Une configuration incomplète et une
extension indisponible répondent HTTP 503 sans faire échouer le healthcheck
Compose.

```bash
make status
make logs
```

`make status` affiche l’état Compose puis health, ready et capabilities. Il
construit l’en-tête Bearer dans le conteneur et n’affiche jamais le secret.

Le popup de l’extension expose la même chaîne en un clic, sans DevTools :
composer → Send → locator de réponse → finalisation → sérialisation, plus
`Copy diagnostic` pour joindre un JSON complet et sûr. Voir
« UI contract drift » pour la lecture ligne par ligne.

## UI contract drift

Symptôme typique : les runs échouent en HTTP 502 avec
`error.code = bridge_ui_timeout`, `phase = pre_submission` et
`submission_state = pre_submission`. Rien n’a été envoyé à ChatGPT ; le
détail porte `details.ui_contract_error` (`composer_missing`,
`ambiguous_composer`, `send_missing`, `ambiguous_send_button`) et
`details.dom_health`, par exemple :

```json
{
  "composer": {"status": "missing", "visible_candidates": 0},
  "content_script_version": "37"
}
```

Procédure, dans cet ordre :

1. Ouvrir le popup de l’extension (icône ChatGPT Mini-Bridge), avec un onglet
   `chatgpt.com` ouvert.
2. Cliquer **Diagnostiquer l’UI ChatGPT**. Le diagnostic ne lit aucun texte
   de la page ni du composer.
3. Interpréter les lignes Composer et Send :
   - **OK** : un sélecteur nommé du contrat correspond à exactement un élément
     visible. Rien à faire.
   - **DEGRADED** : aucun sélecteur nommé ne correspond, mais le repli
     structurel a trouvé un candidat unique et sûr (textbox `contenteditable`
     dans un formulaire, ou bouton `submit` du formulaire du composer). Les
     runs passent ; la console de l’onglet journalise
     `bridge_dom_contract_degraded`. Ajouter la nouvelle signature à
     `SELECTORS` dans `extension/content.js` (et aux listes blanches de
     `background.js`/`popup.js` et à `tools/diagnose.js` —
     `tests/dom-contract.test.js` échoue tant qu’elles divergent).
   - **BROKEN** (missing) ou **AMBIGUOUS** : le runtime refusera d’écrire ou
     d’envoyer, par construction ; il ne choisit jamais un élément au hasard.
     Les compteurs `visible · known · structural` indiquent si le composer a
     disparu (0 partout) ou s’il y en a plusieurs (≥ 2).
   - **Content script v…** doit correspondre à `VERSION` dans
     `extension/content.js` ; sinon recharger l’extension **et** l’onglet.
4. Cliquer **Copy diagnostic** : le JSON copié ne contient que le contrat
   fixe (statuts, stratégie, sélecteur connu, compteurs, préfixes
   d’identifiants). Il peut être joint à un ticket tel quel. Il couvre toute
   la chaîne `target → input → response_locator → finalization →
   serialization → connection`.
   La ligne **Target** nomme toujours la source réellement diagnostiquée
   (`Bridge inflight`, `Bridge browser target`, `Bridge conversation`,
   `Bridge-owned tab`, `Generic ChatGPT tab`) et si elle appartient au bridge :
   la priorité est *run inflight exact* → *browser target exact* →
   *conversation retenue* → *onglet d’une fenêtre du bridge* → *onglet ChatGPT
   quelconque en dernier recours*. Un onglet quelconque affiche
   `Temporary Chat = N/A` : il ne déclenche jamais de fausse alarme.
   La section **Response locator** décrit le contrat de réponse : surface de
   conversation, stratégie (`semantic_assistant` ou `markdown_root_delta`),
   comptages de roots et de feuilles inline, verdict du candidat
   (`FOUND` / `NONE` en attente / `BROKEN` / `—` hors run) et, en cas de dérive,
   la raison bornée (`ambiguous_root`, `inline_without_root`, `surface_missing`).
   Un refus de contrat affiche `Candidate = BROKEN`, la raison, et libelle la
   ligne des roots « Markdown roots » avec les roots du DOM réel. Voir
   « Contrat de réponse (ResponseRoot) ».
   La section **Finalization** relit l’état vivant publié par la boucle du
   content script (`ACTIVE` / `QUIESCENT` / `FINAL`), jamais une valeur
   recalculée par le popup : signal bloquant (`Blocking signal`), caractères
   sérialisés, stabilité mesurée / seuil réellement appliqué, observations,
   actions/streaming/reasoning/Stop. La ligne de réveils expose
   `mutation · observe_tick · timer` et l’âge de la dernière observation : c’est
   ainsi qu’un onglet d’arrière-plan throttlé se distingue d’une réponse figée.
   La section **Serialization** nomme le sérialiseur, la présence du root et le
   dernier résultat (`OK` / `ERROR`).
   Le bouton **Copier la structure de réponse** joint un snapshot structurel
   borné (tag, tokens de classe, `data-testid`, dimensions, profondeur) quand
   il faut décrire un arbre réel sans jamais copier de texte.
5. Seulement si le popup ne suffit pas (il faut voir l’évolution pendant un
   envoi), coller `tools/diagnose.js` dans la console DevTools de l’onglet :
   il enregistre 90 s de transitions structurelles sans lire de texte.

Pour vérifier la chaîne complète après correction :

```bash
BRIDGE_API_KEY=... tools/smoke_chatgpt_bridge.sh   # [base_url], défaut http://127.0.0.1:8001
```

Le script envoie « Reply with exactly: BRIDGE_OK », affiche le statut HTTP, la
durée, puis soit `reply_match`, soit le code d’erreur et le `dom_health`
borné. Il ne passe jamais la clé en argument de commande et ne l’affiche
pas. Chaque exécution soumet un nouveau prompt (nouvelle clé
d’idempotence).

Si le smoke reste bloqué (statut HTTP obtenu, aucune réponse, ou
`bridge_ui_timeout`) : ouvrir le popup de l’extension, cliquer
**Copy diagnostic**, puis lire le JSON **dans cet ordre** —
**Connection** (extension/WebSocket vivants, cible exacte et son
propriétaire), **Input** (Temporary Chat confirmé, composer, Send),
**Response locator** (surface, baseline/roots, verdict du candidat et raison
bornée), **Finalization** (ACTIVE / QUIESCENT / FINAL, signal bloquant,
stabilité observée / seuil appliqué), **Serialization** (root trouvé,
sérialiseur, dernier résultat). Une cause en amont rend les suivantes
illisibles : ne jamais interpréter une ligne Finalization quand la ligne
Input est déjà BROKEN.

## Contrat de réponse (ResponseRoot)

La réponse n’est pas cherchée comme « un tour assistant » mais comme le contenu
rendu APRÈS la soumission du prompt : le **ResponseRoot**. Deux stratégies le
résolvent, dans cet ordre :

1. `semantic_assistant` — UI historique :
   `[data-message-author-role="assistant"]` et son answer root `.markdown`.
2. `markdown_root_delta` — UI observée en production : plus aucun
   `data-message-author-role`, `data-message-id`, `data-turn`,
   `conversation-turn` ni `<article>`. Le contenu vit dans un `div` dont une
   classe COMMENCE par `MarkdownRoot-` (suffixe généré, jamais écrit en dur) ;
   les feuilles `inline-markdown` / `InlineMarkdown…` ne sont qu’une preuve de
   contenu conversationnel, jamais une réponse à elles seules. Une réponse qui
   contient P/UL/LI/code/table reste UN seul ResponseRoot.

Le candidat vient d’un DELTA structurel : `captureResponseBaseline()` est
capturé juste avant l’unique `triggerComposerSubmission()` (comptages, clés
locales `WeakMap`, signatures de tokens de classe — jamais un caractère de
contenu), et `resolveResponseCandidate()` ne retient que les ResponseRoots qui
dépassent ce baseline dans la surface de conversation. « Le dernier
MarkdownRoot de la page » n’est jamais une réponse. La surface elle-même est
bornée (`resolveConversationSurface()`) : header, nav, aside, menus, popovers
et modales ne peuvent pas devenir une conversation — le diagnostic réel a déjà
montré un `app-shell-header-context-menu-surface` qui ne doit jamais être pris
pour une réponse.

**Le message utilisateur moderne peut aussi être un `MarkdownRoot-`.** Après
Send, son rendu peut être le premier root nouveau, sans attribut de rôle. Le
locator compare alors ce root au texte fiable réellement mis dans le composer
avant l'envoi et l'exclut, avec ses feuilles inline, du delta de réponse. La
comparaison reste locale au run et n'apparaît dans aucun log ni heartbeat. Un
assistant qui répéterait ce texte de façon indiscernable reste exclu : le
bridge attend une réponse distincte ou atteint la borne totale, plutôt que de
livrer le prompt comme une réponse. Les roots assistant suivants conservent
leur identité par ordinal et signature après ce filtrage.

Ce qu’est un root « nouveau » est strict, parce que React peut remonter tout
le tour (nœud neuf, **tokens de classe neufs**) sans qu’aucune réponse n’ait
été écrite : est frais un ResponseRoot dont le nœud est absent du baseline
**et** dont le rang dépasse l’enveloppe des roots du baseline
(`isFreshResponseRoot()`). Un ancien tour re-rendu, même avec une signature
différente, reste l’ancien tour : il n’est jamais candidat, ni identité de
repli pour le locator (`locateResponseCandidate()`), et son contenu n’est
jamais relivré comme la réponse du run. En cas de doute, le run reste en
attente — le `bridge_total_timeout` du serveur borne la durée — plutôt que de
livrer un ancien texte.

L’identité du candidat est locale au run (WeakMap + ordinal + signature) :
React peut remplacer le nœud, le locator rattache le nouveau nœud au même
candidat logique, sans jamais persister ni fabriquer un identifiant de
conversation, de tour ou de message.

Observabilité, sans contenu : la console de l’onglet journalise
`bridge_response_locator` (`strategy`, `baseline_root_count`,
`current_root_count`, `candidate_found`, `candidate_root_tag`, `markdown_root`,
`inline_leaf_count`, `ambiguity_count`, `version`), et le popup affiche la
section **Response locator** (Conversation / Strategy / Baseline roots /
Current roots — libellée **Markdown roots** quand le locator refuse de
conclure — / Candidate / Markdown root / Inline leaves / Reason). Le verdict du
candidat (`candidate_state` : `idle`, `pending`, `found`, `broken`) et sa
raison bornée (`ambiguous_root`, `inline_without_root`, `surface_missing`) sont
produits par la décision réelle du locator, jamais re-dérivés par le popup : un
onglet sans run reste `idle`, sans fausse alarme. Le bouton
**Copier la structure de réponse** produit un snapshot structurel borné — tag,
tokens de classe bornés, role, data-testid, data-* en liste blanche,
profondeur, nombre d’enfants, dimensions, visibilité, stratégie de root — sans
jamais lire ni copier un texte (ni `innerText`, ni `textContent`, ni
`innerHTML`).

Dérive de contrat, fail closed : après un Send confirmé, si deux nouveaux
ResponseRoots coexistent (`RESPONSE_AMBIGUITY_HOLD_MS`), ou si des feuilles
`inline-markdown` restent visibles sans aucun ResponseRoot résolvable
(`RESPONSE_CONTRACT_DRIFT_MS`), le run échoue en
`bridge_response_contract_drift` avec `submission_state = post_submission` et
aucun replay automatique. `details` est borné et sans contenu :
`reason` (`ambiguous_response_roots` ou
`inline_markdown_without_response_root`), `response_root_strategies`,
`semantic_assistant_matches`, `markdown_root_matches`, `inline_leaf_matches`,
`baseline_root_count`, `current_root_count`, `conversation_surface_found`,
`conversation_surface_strategy`, `submission_state` et
`content_script_version`.

## Finalisation (ACTIVE / QUIESCENT / FINAL)

Les boutons Copy/actions historiques ne sont plus la seule preuve de fin : la
nouvelle UI peut rendre une réponse complète sans jamais les monter. La décision
est donc une machine à états explicite — `extension/completion.js` (états purs),
`extension/final-output.js` (décision de durée), pilotée par `streamAnswer()` :

    ACTIVE    = au moins un signal d’activité, tous SCOPÉS
    QUIESCENT = réponse non vide, aucun signal actif, aucune preuve terminale
    FINAL     = preuve terminale, ou quiescence stable assez longtemps

Signaux d’activité, chacun borné à son périmètre :

- `streaming` et `reasoning` — lus dans le **périmètre de la réponse** : le
  ResponseRoot et son plus proche wrapper qui ne contient aucun autre
  ResponseRoot (`responseSignalScope()`). Le nœud lui-même est inclus
  (`matches`) : un `MarkdownRoot-*` moderne porte `result-streaming` sur son
  propre nœud, que `querySelectorAll` seul manquerait. Un indicateur laissé par
  un ancien tour, ou par un widget latéral, ne maintient donc jamais *cette*
  réponse en vie.
- `stop_button` — lu dans le composer courant uniquement (`inspectComposer()`
  puis son `form`/parent), jamais dans la page : un Stop d’un autre widget ne
  compte pas.

**Preuve terminale** (`terminal_action`) : la barre d’actions du tour
(`SELECTORS.turnActions`, dont Copy). Elle reste le signal le plus fort et
finalise après `SETTLE_MS` — mais elle n’est plus requise.

**Quiescence** (`quiescent_stability`) : `SETTLE_UNKNOWN_MS` (15 s) de stabilité
*réellement observée*, avec au moins `MIN_QUIESCENT_OBSERVATIONS` (3)
observations réelles, un texte sérialisé non vide et identique d’une
observation à l’autre. Durée et observations sont exigées ensemble : un unique
réveil throttlé tardif n’est pas une preuve. La confiance de cette fin est
`medium`, jamais `high` : c’est une inférence, pas une preuve terminale.
FINAL est terminal — un unique `done`/`incomplete` est émis, jamais un second,
même si un MutationObserver se déclenche après coup.

Ce que la stabilité ne fait **jamais** : conclure pendant ACTIVE. Un texte figé
60 s pendant que le streaming (ou le Stop, ou le reasoning) reste allumé n’est
pas une réponse finie. Quand le signal actif disparaît, la fenêtre quiescente
commence à cette observation-là ; un changement de sortie ou de candidat
logique la remet à zéro.

Double vérification avant de conclure : le ResponseRoot est re-résolu,
re-sérialisé, les signaux sont relus, et le texte doit être identique. Pour
`quiescent_stability`, la seconde lecture exige seulement l’**absence de signal
actif** — jamais l’apparition d’un bouton Copy entre-temps : c’est exactement
la boucle sans fin que cette machine remplace.

Remplacement React : un `MarkdownRoot` recréé avec le même texte reste le même
candidat logique (clé locale du ResponseRoot) et conserve sa fenêtre de
stabilité. Une identité ambiguë, elle, ne conclut rien : le candidat redevient
`null`, l’état retombe sur `waiting` et la fenêtre repart de zéro (fail closed).

Observabilité, jamais de contenu : chaque heartbeat publie
`progress.finalization` — `finalization_state`, `signal`, `output_chars`,
`stable_for_ms`, `stable_observations`, `streaming_visible`, `reasoning_visible`,
`stop_visible`, `terminal_action_visible`, `response_strategy` — que le serveur
conserve borné (`bridge/generation.py::_finalization_state`) sous
`bridge_progress.finalization`, et joint aux `details` d’un `needs_review`. Une
fin conclue joint `finalization_evidence` : `mode` (`terminal_action` ou
`quiescent_stability`), `signal`, `stable_for_ms`, `stable_observations`,
`output_chars`, `candidate_strategy`.

Le popup relit ce même état vivant sans rien recalculer : le content script
publie `run_state` (`RUN_STATES`/`RUN_SIGNALS`, mêmes listes blanches que le
worker) à chaque itération de la boucle, et `stable_threshold_ms` vient de
`finalizationThresholdMs()` — le seuil publié est la borne de sortie réellement
appliquée à cet état (`active_signal_stall_ms`, `finalization_stall_ms`,
`settle_ms`/`empty_final_settle_ms`). Les réveils (`last_wake.mutation`,
`observe_tick`, `timer`) et `ms_since_observation`/`ms_since_dom_mutation`
distinguent une boucle vivante d’un onglet d’arrière-plan throttlé. Voir
« UI contract drift » pour la lecture des sections **Finalization** et
**Serialization**.

Un signal ACTIVE qui reste allumé anormalement longtemps n’est jamais converti
en FINAL par la durée seule : `WATCHED_TURN_ACTIVE_SIGNAL_STALL_MS` produit
`incomplete/active_signal_stalled` (candidat joint, `blocking_signal` nommé),
`FINALIZATION_STALL_MS` produit `incomplete/finalization_stalled`. L’exception
`.streaming-animation` reste inchangée (cf. « Bornes indépendantes »).

### Sortie finale et identité de continuation

Le succès du texte final est distinct de la réutilisation de la conversation.
Le serveur exige un snapshot non vide, `finalization_state=final` et une preuve
de finalisation cohérente. L’identité externe du tour n’est obligatoire que si
la requête normalisée porte une cible Bridge `conversation` (`fresh` ou
`continue`). Les trois façades déduisent cette exigence de la même donnée
normalisée ; le caractère durable d’un run ne signifie pas qu’il est
continuable.

Un run stateless sans cible `conversation` peut donc réussir sans identifiant
externe. La réponse conserve ses diagnostics de finalisation et indique
`external_turn_id_verified=false` et `continuation_available=false`; la
conversation Bridge reste vide. Si une cible `conversation` était demandée,
l’absence d’identité reste `external_turn_identity_unavailable` et aucun
identifiant n’est fabriqué. Les runs stateless réussis sont persistés comme
`completed`, et leurs retries idempotents relisent ce résultat sans renvoyer
le prompt au navigateur. `previous_response_id` n’est pas un handle pris en
charge par cette façade : il est refusé en validation (`422`) au lieu d’être
ignoré puis traité comme un run stateless.

## WebSocket churn

Symptôme : `/ready` alterne entre `extension_available`, `extension_stale`
ou `extension_conflict`, ou les logs montrent des
`extension_connection_replaced` / `extension_connection_conflict` répétés.
Cinq valeurs, visibles à la fois dans `/health`/`/ready` (côté serveur) et
dans la ligne « Extension / WebSocket » du diagnostic du popup (côté worker),
suffisent à qualifier la situation :

| Valeur | Serveur | Popup | Lecture |
|---|---|---|---|
| instance id | `instance_id_prefix` | `instance …` | Stable par installation de l’extension (chrome.storage.local). Deux préfixes différents = deux profils Chrome/installations. |
| worker session | `worker_session_prefix` | `worker …` | Change à chaque redémarrage du service worker MV3. Changer seul, avec le même instance id, est normal. |
| connection id | `connection_id_prefix` | `connexion …` | Change à chaque socket. |
| reconnection count | `reconnections` | `reconnexions …` | Serveur : remplacements depuis son démarrage. Popup : reconnexions de ce worker. Une croissance régulière (≈ 1/min) signale une boucle. |
| last pong / ping | `seconds_since_pong` | `dernier ping … s` | Au-delà de 60 s, la connexion est stale des deux côtés. |

États du popup : **STABLE** (socket ouvert, ping récent), **CONNECTING**,
**STALE** (socket ouvert sans ping depuis plus de 60 s), **CONFLICT** (le
worker s’efface 60 s après `replaced` — fermeture 4000 — ou `owner_active`
— fermeture 4409), **DISCONNECTED**.

Interprétation :

- instance id différents et `extension_conflict` : deux installations se
  disputent le pont. Le serveur garde l’owner sain ; l’autre réessaie au plus
  une fois par minute sans jamais le remplacer. Désactiver l’extension dans
  le profil en trop.
- même instance id, worker session qui change, reconnexions qui montent
  lentement : redémarrages MV3 normaux ; aucune action.
- `extension_stale` persistant avec popup STABLE : les pings ne passent plus
  (proxy, réseau, serveur bloqué) ; consulter `make logs`.
- Le bouton **Enregistrer & reconnecter** du popup lève volontairement la
  suppression de 60 s ; ne pas l’utiliser en boucle sur deux profils.

## Cycle de vie et arrêt

`make up` démarre et attend le bridge ; `make down` l’arrête sans supprimer le
volume `bridge_data`. `make restart` recrée le conteneur. À la réception de
SIGTERM, le bridge refuse les nouveaux runs, draine ceux déjà engagés pendant
`BRIDGE_SHUTDOWN_GRACE_SECONDS`, marque le reliquat comme soumission ambiguë,
conserve sa target exacte pour une recovery explicite, puis ferme le WebSocket
et effectue le checkpoint SQLite. Au redémarrage, les états `queued` ou
`running` sont transformés en échec `submission_attempted` et ne sont jamais
resoumis.

## Test manuel d’autonomie (fenêtre dédiée jamais focalisée)

Procédure de reproduction et de preuve. Elle doit permettre de trancher
objectivement entre « a exigé un focus humain » et « terminé sans focus ».

### Smoke A — contrat court (routage seulement)

`uv run examples/verify_ephemeral_conversation.py` : `fresh` → `continue` →
`conversation_archive`. Le script ne voit pas les identités Chrome ; les
vérifier dans la console du service worker : un seul
`phase=dedicated_window_created`, puis le même `tab_id`/`window_id` sur les deux
tours (`phase=bound_tab_state`), et `phase=dedicated_window_removed` à
l’archivage. **Ne rien toucher à la fenêtre du bridge.** Ses réponses tiennent en ~10–15 s : ce smoke prouve le routage et le
cycle de vie de la fenêtre, **jamais** l’absence de dépendance au premier plan.

### Smoke B — cycle de vie long (obligatoire)

1. `make up`, puis vérifier le pont : `make status`.
2. Recharger l’extension dans Chrome et vérifier la version du content script :
   dans la console de l’onglet ChatGPT, la ligne
   `🔌 ChatGPT Mini-Bridge : content script prêt — version 40`. Une version plus
   ancienne signifie que Chrome sert encore le code précédent.
3. Lancer une génération qui occupe ChatGPT **au moins 6 à 10 minutes**
   (recherche approfondie), sans effet de bord de production.
4. **Ne toucher à aucune fenêtre ni onglet du bridge** : ne pas cliquer dessus,
   ne pas le survoler, ne pas remonter la fenêtre dédiée. Garder une autre
   fenêtre / application focalisée pendant toute la génération.
5. N’inspecter les logs qu’**après** la fin du run : `make logs`.

Critères de réussite, tous requis :

    completion_signal=assistant_actions
    started_visibility_state=visible   started_hidden=false   started_has_focus=false
    visibility_state=visible           hidden=false           has_focus=false
    focus_gains_during_run=0
    aucun finalization_stalled / active_signal_stalled / bridge_extension_disconnected
    un seul Send, aucun rejeu

Un `visibility_state=hidden` malgré `tab.active=true` et `window.focused=false`
signifie que Chrome considère toujours la page masquée : l’architecture de
fenêtre dédiée ne résout alors pas le problème → **NO-GO**, à rapporter tel quel
plutôt qu’à masquer.

Ce que la télémétrie permet de vérifier, sans aucun contenu :

| Question | Où regarder |
| --- | --- |
| La fenêtre dédiée a-t-elle bien été créée ? | `bridge_run_phase phase=dedicated_window_created` : `window_focused=false`, `window_state=normal`, `window_type=normal`, `tab_active=true` |
| La page est-elle restée *visible* ? | `bridge_run_autonomy … visibility_state=visible`, `started_hidden=false` — un `hidden` ici invalide l’architecture de fenêtre dédiée |
| Est-il resté sans focus ? | `has_focus=False`, `focus_gains=0`, `visible_transitions=0` |
| Un focus humain a-t-il précédé la détection ? | `focus_gains`/`visible_transitions` > 0 sur le `done` |
| Quand le DOM final est-il apparu ? | `ms_since_dom_mutation` sur le `done` (recul depuis la dernière mutation) |
| Comment la fin a-t-elle été détectée ? | `wake_mutation` / `wake_tick` / `wake_timer` |
| L’onglet a-t-il été déchargé ? | `tab_state.discarded=true` (console du service worker, ou diagnostics de l’erreur `bridge_extension_disconnected`) |
| L’onglet est-il resté hors focus ? | `bridge_run_phase phase=bound_tab_state` (console du service worker) : `active=true`, `window_focused=false`, `window_state=normal`, `auto_discardable=false`, `frozen=false` ou `null` si non supporté |

Un `done` accompagné de `visibility_state=visible`, `hidden=false`,
`has_focus=False`, `focus_gains=0` et `visible_transitions=0` **prouve** une
complétion autonome sans dépendance au premier plan : la page est restée
visible pour Chrome sans jamais avoir été focalisée par un humain.
Un `visibility_state=hidden` sur un run en fenêtre dédiée est au contraire un
**NO-GO** pour cette architecture : la fenêtre non focalisée n’a pas suffi. À l’inverse, `focus_gains>0` sur ce même `done` est la signature d’une
complétion qui a suivi une intervention humaine, et doit être traitée comme une
régression.

Les timeouts journalisent les mêmes champs (`bridge_idle_timeout` /
`bridge_total_timeout` portent `visibility_state`, `has_focus`, `focus_gains`,
`ms_since_dom_mutation`, `ms_since_heartbeat`), ce qui distingue un onglet
masqué mais sain d’un onglet gelé ou déchargé.

## Test manuel de non-duplication

Utiliser uniquement la fausse extension, jamais une session ChatGPT réelle :

```bash
export BRIDGE_API_KEY='http-secret-local'
export BRIDGE_WS_TOKEN='ws-secret-local'
docker compose up -d --build chatgpt-bridge
BRIDGE_WS=ws://127.0.0.1:8001/ws \
  BRIDGE_WS_TOKEN="$BRIDGE_WS_TOKEN" \
  .venv/bin/python examples/fake_extension.py
```

Dans un autre terminal, envoyer deux fois exactement la même commande :

```bash
curl --max-time 0.01 -sS -X POST http://127.0.0.1:8001/v1/bridge/runs \
  -H "Authorization: Bearer $BRIDGE_API_KEY" \
  -H 'Content-Type: application/json' -H 'X-Idempotency-Key: manual-once-1' \
  -d '{"request_id":"manual-once-1","input":"test déterministe"}' || true
curl -sS -X POST http://127.0.0.1:8001/v1/bridge/runs \
  -H "Authorization: Bearer $BRIDGE_API_KEY" \
  -H 'Content-Type: application/json' -H 'X-Idempotency-Key: manual-once-1' \
  -d '{"request_id":"manual-once-1","input":"test déterministe"}'
```

La fausse extension doit imprimer une seule ligne `prompt reçu`; les deux appels
partagent le même `resp_*`.

Le smoke test Compose automatisé exécute la même garantie avec deux POST
concurrents et un replay :

```bash
BRIDGE_API_KEY='compose-http-test' BRIDGE_WS_TOKEN='compose-ws-test' \
  docker compose --profile bridge-test up --build --abort-on-container-exit \
  --exit-code-from bridge-smoke bridge-smoke
```

## Rotation des secrets et limites

Pour une rotation, générer deux nouvelles valeurs indépendantes, arrêter le
bridge, mettre à jour l’environnement Compose et le popup Chrome, puis redémarrer
et vérifier health/capabilities. Les anciennes connexions WebSocket sont ainsi
fermées. Ne mettez jamais les valeurs dans Git ou une commande conservée dans
l’historique partagé.

Les façades `/v1/responses`, `/v1/chat/completions` et `/v1/bridge/runs` partagent
le même moteur de run détaché et le même registre SQLite. Une réponse Responses
en background reste donc récupérable via `GET /v1/responses/{id}` après une
reconstruction de l'application. Une exécution `queued`/`running` interrompue
par un redémarrage devient `failed` lors de `recover_interrupted()` : elle n'est
jamais rejouée implicitement, car le bridge ne peut pas prouver si le clic UI a
déjà été envoyé. `model` reste une étiquette client ; la sélection réelle de
l'UI est réservée aux contrôles Bridge explicites (`bridge_ui_model` ou
`ui_model`).
