# MiniHub — Architecture technique

Référence technique de l'application : architecture matérielle, logicielle et
visuelle, et carte complète du code. Objectif : qu'un développeur ou un agent IA
puisse intervenir sur n'importe quelle partie du projet à partir de ce seul
fichier.

**Ne pas le lire en entier par réflexe.** Le point d'entrée du dépôt est
[AGENTS.md](AGENTS.md), qui renvoie ici section par section selon la tâche.
Pour le périmètre produit, voir [INTENT.md](INTENT.md) ; pour le pourquoi des
choix contre-intuitifs, [DECISIONS.md](DECISIONS.md).

Les noms de fichiers, symboles, événements et commandes sont donnés
littéralement — ils sont directement recherchables dans le code.

**État de référence** : commit `1b0e3d5`, 586 tests JS + 3 952 vérifications
natives au vert. Pour ce qui reste à faire, voir [ROADMAP.md](ROADMAP.md).

---

## Table des matières

1. [Ce qu'est l'application](#1-ce-quest-lapplication)
2. [Architecture matérielle](#2-architecture-matérielle)
3. [Architecture des processus](#3-architecture-des-processus)
4. [Le protocole IPC](#4-le-protocole-ipc)
5. [Le Hub et le système de modules](#5-le-hub-et-le-système-de-modules)
6. [Le graphe de routage](#6-le-graphe-de-routage)
7. [Le moteur audio natif](#7-le-moteur-audio-natif)
8. [Contrats de threading](#8-contrats-de-threading)
9. [Le séquenceur](#9-le-séquenceur)
10. [Architecture de l'interface](#10-architecture-de-linterface)
11. [Persistance : préférences et projets](#11-persistance--préférences-et-projets)
12. [Carte du code](#12-carte-du-code)
13. [Invariants à ne pas casser](#13-invariants-à-ne-pas-casser)
14. [Construire, lancer, tester](#14-construire-lancer-tester)

---

## 1. Ce qu'est l'application

MiniHub est une station de travail musicale de bureau, construite autour du
contrôleur MIDI **Arturia MiniLab 3**. Elle combine :

- un **Patch Bay** — un éditeur de câblage type panneau arrière, où l'on relie
  des nœuds par des câbles typés ;
- un **hôte VST3** natif, avec chaînes de plugins en série, éditeurs natifs et
  persistance de l'état des plugins ;
- un **séquenceur** d'arrangement MIDI + audio, cadencé à l'échantillon, avec
  enregistrement, export multi-format et éditeur de clips en fenêtre séparée ;
- des nœuds de traitement : **Mixer**, **Morpher**, **Arpégiateur** ;
- un **apprentissage de contrôles** (Learn) qui mappe les potentiomètres et pads
  physiques du MiniLab sur des paramètres VST3.

La philosophie centrale : **le graphe de routage est l'autorité**. Ce que l'on
entend est déterminé par les câbles du Patch Bay, jamais par la page affichée.
Naviguer dans l'interface ne modifie aucun signal.

Deuxième principe : **l'audio ne traverse jamais la frontière Electron**. Seuls
des messages de CONTRÔLE et de MIDI circulent entre le renderer et le moteur
natif. Tout le traitement du son reste dans le processus C++.

---

## 2. Architecture matérielle

### Le contrôleur

L'Arturia MiniLab 3 est vu par l'application sous **deux facettes indépendantes**,
ce qui explique une subtilité du graphe :

| Facette | Rôle |
|---|---|
| Source MIDI | Le clavier, les pads, les potentiomètres émettent vers `midi-out` |
| Destination MIDI | Le port matériel sélectionné reçoit ce qu'on lui envoie via `midi-in` |

Ces deux facettes ne sont **pas** un chemin de traversée interne : ce qui entre
par `midi-in` n'est jamais réémis par `midi-out`. C'est pourquoi
`Graph._wouldCreateCycle()` ignore les nœuds de type `midi-output` lors de la
détection de boucles — sans cela, un monitoring `MiniLab → Sequencer → MiniLab`
serait faussement refusé (`src/renderer/js/core/graph.js:121`).

Which physical MIDI port belongs to the controller, and which of its ports can
carry what is played, is decided by the loaded profile's `device.ports[]`. It is
read by [portRoles.js](src/renderer/js/midi/portRoles.js), which imports nothing
and takes the profile as an argument;
[minilab.js](src/renderer/js/midi/minilab.js) is only the adapter binding those
answers to the one profile that ships (`isMiniLabName`,
`isPerformanceInputName`, `miniLabScore`, `bestMiniLabInput`). A
`control-surface` or `ignore` port is never armed, however much its name looks
like the device's: `priority` ranks, `role` forbids.

La surface de contrôle physique — 8 potentiomètres, 8 pads, molettes — est
décrite dans
[minilabControls.js](src/renderer/js/midi/minilabControls.js)
(`MINILAB_CONTROL_SOURCES`) et redessinée en SVG par
[miniLabControlSurface.js](src/renderer/js/ui/miniLabControlSurface.js).

### L'audio

Le moteur natif ouvre **un seul flux PortAudio en WASAPI**, exclusivement. Les
back-ends ASIO, DirectSound, WMME et WDMKS sont désactivés à la compilation
(`PA_USE_ASIO OFF`, etc. dans `native/audio-engine/CMakeLists.txt`) pour qu'aucun
second flux concurrent ne puisse être créé.

Bloc cible : **256 échantillons** (`kTargetBlockSize`), plafond 4096
(`kMaximumBlockSize`). L'entrée physique est optionnelle et n'est active que si
WASAPI l'a réellement négociée — `AudioEngine::inputActive()` reflète ce qui a
été obtenu, pas ce qui a été demandé.

### Le timing MIDI

Chaque message MIDI analysé porte quatre champs temporels
([midiManager.js](src/renderer/js/midi/midiManager.js)) :

| Champ | Sens |
|---|---|
| `webMidiTimestamp` | horodatage Web MIDI d'origine (ms) |
| `hubTimestamp` | `performance.now()` à la réception (diagnostic) |
| `offsetMs` | décalage configuré pour cette entrée (défaut 0) |
| `compensatedTimestamp` | `webMidiTimestamp + offsetMs` — la valeur canonique |
| `processingDelayMs` | `hubTimestamp - webMidiTimestamp` (diagnostic seul) |

La compensation est une **pure annotation** : le traitement live n'est jamais
retardé. Le décalage par entrée est persisté sous `inputOffsets`.

---

## 3. Architecture des processus

Trois processus, trois langages, trois responsabilités.

```
┌──────────────────────────────────────────────────────────────────┐
│ Processus principal Electron  (CommonJS, src/main/)              │
│  · fenêtres, dialogues, persistance disque                       │
│  · supervise le processus natif (démarrage, crash, arrêt propre) │
│  · relaie le protocole IPC, avec liste blanche de commandes      │
└───────────┬──────────────────────────────────────┬───────────────┘
            │ contextBridge (preload.js)           │ stdin/stdout JSON
            │ → window.hubAPI                      │
┌───────────▼──────────────────────┐   ┌───────────▼───────────────┐
│ Renderer  (ES modules, Chromium) │   │ Moteur natif (C++17)      │
│  · Hub, graphe, modules, UI      │   │  · PortAudio/WASAPI       │
│  · Web MIDI (entrée physique)    │   │  · hôte VST3, chaînes     │
│  · aucun accès disque direct     │   │  · séquenceur, export     │
└──────────────────────────────────┘   └───────────────────────────┘
```

**Points de contrat importants :**

- Le renderer est en **ES modules** (`src/renderer/package.json` contient
  `{"type":"module"}`) ; le processus principal reste en **CommonJS**. Cette
  séparation permet aux tests Node d'importer directement les modules du
  renderer sans étape de build.
- **Aucune étape de build JS.** Pas de bundler, pas de transpilation, pas de
  framework. Ce qui est écrit dans `src/` est ce qui s'exécute.
- `contextIsolation: true`, `nodeIntegration: false`. Le renderer n'a accès
  qu'à la surface exposée par [preload.js](src/main/preload.js) sous
  `window.hubAPI`.
- Sur Windows, le rendu GPU est désactivé (`in-process-gpu` +
  `disableHardwareAcceleration`) : le sous-processus GPU d'Electron sortait en
  `STATUS_DLL_NOT_FOUND` sur la machine cible. L'interface n'utilise pas WebGL.
- **Verrou d'instance unique** (`requestSingleInstanceLock`) : une seconde
  exécution ramène la fenêtre existante au premier plan.

### L'éditeur de clips

Le Clip Editor est une **BrowserWindow séparée**, avec son propre preload
([clipEditorPreload.js](src/main/clipEditorPreload.js)) et son propre document
([clip-editor.html](src/renderer/clip-editor.html)). Il est piloté par
[clipEditorWindows.js](src/main/clipEditorWindows.js), qui valide chaque
opération entrante (`quantize`, `add-note`, `update-note`, `delete-notes`,
`update-audio`) avant de la transmettre au renderer principal.

Seul le renderer principal canonique peut envoyer certaines commandes : les
requêtes venant d'un éditeur périmé ou d'un WebContents inconnu sont rejetées
(`_isMainSender`, `_editorForSender`).

---

## 4. Le protocole IPC

### Renderer ↔ processus principal

Exposé par `contextBridge` sous `window.hubAPI`. Surface complète dans
[preload.js](src/main/preload.js) : réglages, dialogues de projet, dialogues
audio, diagnostics, commandes moteur, abonnements aux événements moteur, et le
cycle de vie du Clip Editor.

Toute commande moteur passe par `ipcMain.handle('engine:command')`, qui applique
**une liste blanche fixe** ([engineCommandPolicy.js](src/main/engineCommandPolicy.js),
`ALLOWED_ENGINE_COMMANDS`) puis, pour les commandes sensibles, un validateur
dédié :

| Commande | Validateur |
|---|---|
| `selectDevice` | [audioDeviceCommand.js](src/main/audioDeviceCommand.js) |
| `setVstParameter` | [vstParameterCommand.js](src/main/vstParameterCommand.js) |
| `setVstParameterLearn` | [vstParameterLearnCommand.js](src/main/vstParameterLearnCommand.js) |
| `getVstParameters`, `sequencerQuiesce` | inline dans [main.js](src/main/main.js) |

L'intention : la surface IPC exposée est une liste finie et relisible, pas
« n'importe quel objet que le renderer sérialise ».

### Processus principal ↔ moteur natif

**JSON délimité par des sauts de ligne**, sur stdin (vers le moteur) et stdout
(depuis le moteur). Chaque message porte `"v": 1` (`kProtocolVersion` côté C++,
`PROTOCOL_VERSION` côté JS). Implémentation : [ipc.h](native/audio-engine/src/ipc.h)
et [engine.js](src/main/engine.js).

Le moteur est lancé avec `--role live --parent-pid <pid> --created-at <iso>`.
[EngineProcess](src/main/engine.js) refuse de démarrer un second moteur vivant
(`activeSupervisor`), gère la poignée de main `hello`, détecte les crashs et
effectue un arrêt ordonné (`shutdown` → `shutdownAck` → attente de sortie →
`kill` en dernier recours). Un crash déclenche jusqu'à **deux** redémarrages
automatiques.

**Familles d'événements émis par le moteur** (traitées dans
[engineClient.js](src/renderer/js/core/engineClient.js), méthode `_onEvent`) :

- cycle de vie : `hello`, `status`, `error`
- périphériques : `devices`, `deviceState`, `midiOutputState`
- plugins : `plugins`, `chainChanged`, `instanceStatus`, `editorStatus`,
  `pluginState`, `pluginStateCaptureComplete`
- paramètres : `vstParameters`, `vstParameterTouched`, `vstParameterLearnState`
- transport : `transport`, `metronomeTick`
- séquenceur : `sequencerMidiRecorded`, `sequencerAudioRecorded`,
  `sequencerAudioInfo`, `sequencerExport`, `sequencerQuiesced`
- télémétrie : `masterMeter`, `hostTiming`, `audioPathTelemetry`,
  `audioRuntimeTelemetry`

Les événements périodiques ne sont **pas** écrits sur disque : le filtre
[engineEventTrace.js](src/main/engineEventTrace.js) les élimine, à une exception
près — `audioRuntimeTelemetry` est journalisé quand la fenêtre qu'il décrit
signale une anomalie. C'est ce qui transforme le journal en registre
d'incidents plutôt qu'en tuyau d'arrosage, et c'est le seul endroit où un
décrochage *silencieux* devient visible.

---

## 5. Le Hub et le système de modules

### Le Hub

[hub.js](src/renderer/js/core/hub.js) construit l'objet unique par lequel tout
transite. Un module ne parle jamais à un autre module directement.

| Propriété | Classe | Rôle |
|---|---|---|
| `hub.events` | `EventBus` | bus publication/abonnement typé |
| `hub.settings` | `SettingsStore` | préférences persistées via IPC |
| `hub.midi` | `MidiManager` | couche périphériques Web MIDI |
| `hub.graph` | `Graph` | graphe de routage (indépendant de l'UI) |
| `hub.engine` | `EngineClient` | client du moteur natif |
| `hub.diagnostics` | — | journalisation vers le fichier du processus principal |
| `hub.hardware` | `HardwareConfigManager` | restauration des préférences audio |
| `hub.modules` | `ModuleSystem` | registre des modules (focus UI) |
| `hub.control` | `ControlBindingManager` | mappages MiniLab → paramètres VST3 |
| `hub.nodes` | `NodeInstanceManager` | instances de nœuds créées par l'utilisateur |
| `hub.project` | `ProjectManager` | cycle de vie du projet |
| `hub.sequencer` | `SequencerController` | séquenceur (modèle + transport) |

### Le contrat de module

```js
hub.modules.register({
  id: 'mon-module',                      // identité unique, obligatoire
  name: 'Mon Module',
  navEntry: { label: '…', icon: '…', group: 'node', accent: 'vst' },
  routingNode: { id, name, type, inputs, outputs, onInput },   // optionnel
  onRegister(hub) {},                    // optionnel, une fois
  mount(container) {},                   // devient actif
  unmount() {}                           // désactivé — doit tout nettoyer
});
```

- `navEntry` fait apparaître le module dans la barre latérale automatiquement.
  Le groupe (`home`, `system`, `node`) détermine la section ; un groupe vide
  n'est pas affiché ([sidebar.js](src/renderer/js/ui/sidebar.js)).
- `routingNode` fait du module un nœud du graphe. **`register` l'ajoute au
  graphe et `unregister` l'en retire** — la symétrie est garantie depuis
  `f4ec31f` et verrouillée par test.
- `mount`/`unmount` sont encadrés par `try/catch` : un module qui explose
  affiche un panneau d'erreur au lieu de casser l'application.

**Pour ajouter un module aujourd'hui**, il suffit de l'enregistrer dans
[app.js](src/renderer/js/app.js). Aucune modification de la coquille n'est
nécessaire. La barre latérale, le graphe et la navigation suivent.

### Les types de nœuds

[nodeTypes.js](src/renderer/js/core/nodeTypes.js) est le registre. Un type est
**immuable** : une instance garde son type à vie, seul son `content` évolue.

| Type | Catégorie | Entrées | Sorties | Contenu |
|---|---|---|---|---|
| `vst` | Plugin | midi, audio, control | audio | chaîne de plugins |
| `mixer` | Audio | audio ×N (dynamique) | audio | niveaux, mutes, master |
| `morpher` | Audio | audio ×N (dynamique) | audio | niveaux, pas de morphing |
| `arpeggiator` | MIDI | midi | midi | motif, gamme, mode, rythme |
| `sequencer` | MIDI | midi, audio | midi, audio | *(modèle séparé)* |
| `audio-input` | Audio | — | audio | — |
| `video`, `image` | — | — | — | réservés |

Drapeaux structurants : `singleton` (une seule instance), `stableId` (identité
fixe au lieu d'un identifiant séquentiel), `fixedModuleId` (le module survit à
la suppression du nœud — cas du Sequencer), `deletable`, `copyable`,
`dynamicAudioInputs` (le nœud gagne une entrée dès que toutes sont câblées).

### Nœuds système

Deux nœuds n'ont **pas** d'entrée dans `NODE_TYPES` : ce sont des points
terminaux matériels, pas des familles instanciables. Leurs identifiants sont
centralisés dans [systemNodes.js](src/renderer/js/core/systemNodes.js) :

| Constante | Valeur | Type de nœud |
|---|---|---|
| `MINILAB_NODE_ID` | `minilab-3` | `midi-output` |
| `AUDIO_OUTPUT_NODE_ID` | `audio-output` | `audio-output` |
| `SEQUENCER_NODE_ID` | `sequencer` | `sequencer` |
| `AUDIO_INPUT_NODE_ID` | `audio-input` | `audio-input` |

L'identifiant de module du nœud Audio Output est **délibérément identique** à
son identifiant de nœud : c'est ce qui permet au Patch Bay de retrouver
l'éditeur d'un nœud par `hub.modules.get(node.id)`.

### Identité contre numérotation

Distinction volontaire, et source d'erreurs si on la confond
([nodeInstances.js](src/renderer/js/core/nodeInstances.js)) :

- **`id`** — `vst-011`. Stable, unique à jamais, **jamais réutilisé** après
  suppression. C'est la clé de tout ce qui doit survivre : câbles, positions,
  modules, chaînes natives.
- **`ordinal`** — `2`, rendu « VST 2 ». **Affichage seul.** Un nouveau nœud
  prend le plus petit entier libre dans sa famille. Supprimer VST 2 à 10 fait
  qu'un nouveau nœud s'appellera « VST 2 » — alors que son `id` sera `vst-011`.

Les nœuds existants ne sont jamais renumérotés ; seuls les nouveaux comblent les
trous. Le `name` est dérivé et n'est pas persisté séparément.

---

## 6. Le graphe de routage

[graph.js](src/renderer/js/core/graph.js). Des nœuds déclarent des ports typés ;
une connexion relie un port de sortie à un port d'entrée **de même type**.

### Les trois types de port

| Type | Ce qui circule |
|---|---|
| `midi` | de vrais événements MIDI, via `emitData` vers les cibles connectées |
| `audio` | **aucun échantillon** — la connexion est néanmoins l'autorité : une chaîne VST n'atteint la sortie physique que tant que son `audio-out` est câblé |
| `control` | valeurs normalisées sémantiques (K1..K8, pads…) |

### Règles appliquées à la connexion

`connect()` refuse : un nœud inconnu, un port inconnu, des types incompatibles,
un doublon, et un **cycle** pour les types `midi` et `audio`
(`_wouldCreateCycle`).

`emitData(nodeId, portId, data)` diffuse à toutes les cibles câblées.
`emitDataTo(nodeId, portId, targetNodeId, data)` traverse **un seul** câble
existant — c'est ce qui permet au séquenceur de choisir laquelle de ses
branches de sortie reçoit un événement live, sans jamais inventer de route.

### Synchronisation vers le moteur

[engineSync.js](src/renderer/js/core/engineSync.js) traduit le graphe en plan
natif, avec une distinction cruciale :

- **`audioTopologyKey(nodes)`** — tout ce qui définit la *forme* du graphe. Une
  différence ici impose une recompilation native, car elle change le câblage des
  tampons et les délais de compensation (PDC). `stepCount` en fait partie.
- **`audioNodeValues(nodes)`** — les valeurs éditées en continu (niveaux, mutes,
  master, pas du Morpher). Appliquées **en place** sur le plan déjà publié.

Cette séparation existe pour une raison mesurée : un curseur `range` émet un
événement `input` par pixel de glissement. Les router par `syncAudioGraph`
recompilait le graphe des dizaines de fois par seconde et remettait à zéro
chaque ligne de retard PDC en plein flux (jusqu'à 37 recompilations/seconde
relevées dans le journal). Les écritures sont en plus regroupées côté UI par
`NATIVE_VALUE_COALESCE_MS` (120 ms).

---

## 7. Le moteur audio natif

C++17, JUCE 9 pour l'hébergement VST3, PortAudio pour le périphérique, SDK VST3
de Steinberg, LAME pour l'encodage MP3.

### Vue d'ensemble

```
                    ┌──────────────────────────────────────┐
   stdin JSON  ───► │ Engine  (façade contrôle, msg thread)│
                    │  · commandes cmdXxx()                │
                    │  · registre VST3, chaînes, éditeurs  │
                    └──────────────┬───────────────────────┘
                                   │ publie des plans immuables
                    ┌──────────────▼───────────────────────┐
                    │ engine2::AudioEngine                 │
                    │  · UN flux PortAudio/WASAPI          │
                    │  · UN Transport live                 │
                    └──────────────┬───────────────────────┘
                                   │ callback temps réel
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
  MidiExecutionPlan       AudioExecutionPlan            SequencerEngine
  (arpégiateurs,          (ordre topologique,           (arrangement,
   destinations)           délais PDC, mix)              enregistrement, export)
                                   │
                                   ▼
                            MasterOutput  ──► sortie physique
```

### `Engine` — la façade de contrôle

[engine.h](native/audio-engine/src/engine.h) / `engine.cpp`. Tourne sur le
**thread message** de JUCE. Une méthode `cmdXxx()` par commande du protocole.
Possède le registre VST3, les chaînes (`Chain`, append-only, elles survivent à
tout plan), les éditeurs natifs, et l'instance `engine2::AudioEngine`.

### `AudioExecutionPlan` — le plan audio compilé

[audio_graph.h](native/audio-engine/src/audio_graph.h). Compilé hors du thread
audio, publié, puis **immuable dans sa forme**. Chaque nœud porte :

- son `kind` (`input`, `vst`, `mixer`, `morpher`, `sequencer`, `output`,
  `diagnosticSine`) ;
- ses sources en **ordre topologique** ;
- ses `SourceDelay` — les lignes de retard qui compensent la latence des
  plugins (PDC) ;
- un `NodeValues` dans **sa propre allocation**, contenant des `std::atomic`
  pour les niveaux, mutes, master et pas de morphing.

C'est ce dernier point qui permet la mise à jour en place : le thread de
contrôle écrit dans les atomiques d'un plan vivant sans rien réallouer ni
libérer. `findNode(id)` renvoie `nullptr` si l'identifiant est inconnu — ce qui
signale à l'appelant que sa vue de la topologie est périmée et déclenche une
resynchronisation complète (erreur `audio-values-stale`).

Le nœud `diagnosticSine` est **absent du parseur IPC** : un projet ne peut donc
jamais le persister ni l'instancier. Il n'existe que pour les tests natifs.

### `Chain` — une chaîne VST3 en série

[chain.h](native/audio-engine/src/chain.h). Maximum 16 plugins. L'ordre de la
liste est l'ordre de traitement. `midiEnabled` et `outputEnabled` reflètent la
topologie du Patch Bay et déterminent si le MIDI atteint la chaîne et si la
chaîne atteint la sortie.

Le MIDI est injecté depuis le thread de contrôle par un **anneau sans verrou**
(`juce::AbstractFifo`, 4096 entrées) et consommé dans le callback. Chaque
événement porte une **époque** : un Stop concurrent incrémente l'époque et fait
rejeter un Note On post-Stop déjà en vol.

`panic()` demande au thread audio d'éteindre chaque note tenue. Les Note Off
explicites sont émis depuis un registre `activeNotes_` **avant** CC123/CC120,
pour que les instruments qui ignorent l'un ou l'autre CC s'arrêtent quand même.

### `MidiExecutionPlan` — arpégiateurs et destinations

[midi_graph.h](native/audio-engine/src/midi_graph.h). `ArpeggiatorRuntime`
implémente les modes (Up, Down, Up/Down, As Played, Random, Custom), la
quantification sur gamme, les liaisons (`tie`) et les silences (`rest`). Le
motif custom fait jusqu'à 32 pas.

### `MasterOutput` — gain et mesure

[master_output.h](native/audio-engine/src/master_output.h). Gain lissé sur
**20 ms**, mesure post-gain, détection d'écrêtage et de valeurs non finies.

**Aucune réduction de gain automatique** n'existe dans cet étage ni aux
frontières amont. Les crêtes au-dessus de 1.0 sont rapportées telles quelles.
C'est délibéré : la mesure observe, elle ne corrige pas.

### `Transport` — l'horloge

[transport.h](native/audio-engine/src/transport.h). Implémente
`juce::AudioPlayHead`. BPM 20–300, position en PPQ, boucle, métronome avec
pré-décompte. Tout est en `std::atomic`.

`TransportPlayHeadRouter` est installé **une fois** sur chaque plugin ; le
callback choisit l'horloge live ou l'horloge privée d'export avant de traiter un
bloc. Un VST ne reçoit donc jamais le timing du mauvais transport.

---

## 8. Contrats de threading

La partie la plus délicate du projet. À lire avant toute modification du chemin
temps réel.

### Le thread audio ne bloque jamais

`Chain::processBlock` prend son verrou avec **`tryEnter`**. S'il échoue — une
édition depuis le thread message est en cours — le bloc est **sauté** (silence)
plutôt que d'attendre. Le thread message tient le même verrou pendant toute la
mutation, destruction d'un plugin retiré comprise : c'est ce qui rend les
pointeurs bruts sûrs, là où l'ancien schéma « instantané puis relâchement »
provoquait un accès après libération.

### Un bloc sauté est observable

Un bloc sauté est indistinguable d'un bloc sain pour toutes les autres métriques
— le callback rend la main à l'heure, écrit des zéros finis, ne lève aucun
sous-débit PortAudio. Une session pouvait donc afficher une santé parfaite
pendant que l'utilisateur entendait un clic à chaque saut.

[realtime_drops.h](native/audio-engine/src/realtime_drops.h) expose deux
compteurs pour rendre ce mode de panne visible :

- `chainBlocksSkipped()` — une chaîne entière sautée (verrou tenu) ;
- `pluginBlocksSkipped()` — un plugin sauté (mutation de contrôle en cours).

Ils remontent dans `audioRuntimeTelemetry`, et c'est ce que le filtre du journal
guette.

### Lectures message-thread sans verrou

`Chain::copyPlugins()` et `Chain::find()` ne prennent **délibérément pas** le
verrou : les mutations sont sérialisées sur le thread message, et une traversée
lecture/lecture face au callback est sûre. Prendre le verrou ici faisait échouer
le `tryEnter` du callback et perdre des blocs sains — la fonction était appelée
une fois par seconde et par chaîne par le minuteur de diagnostic.

### Files audio → message

`MetronomeTickQueue` (capacité 64) est une file à capacité fixe, sans verrou,
sans allocation, sans IPC ni travail UI côté producteur temps réel.

---

## 9. Le séquenceur

### Le modèle (renderer)

[sequencerModel.js](src/renderer/js/core/sequencerModel.js). Résolution :
`TICKS_PER_QUARTER = 960`. Limites dures : **64 pistes, 2048 clips par piste,
65 536 notes par clip** (`SEQUENCER_LIMITS`).

Grilles de quantification : 1/4, 1/8, 1/16, 1/32, 1/8 triolet, 1/16 triolet.
Aimantation : 1 mesure, 1/2, 1/4, 1/8, 1/16, 1/32.

Une piste est `midi` ou `audio` ; un clip audio porte `trimStartSeconds`,
`trimEndSeconds`, `gain`, `peaks` et un état de disponibilité du média.

### Le contrôleur (renderer)

[sequencerController.js](src/renderer/js/core/sequencerController.js) fait le
lien entre le modèle, le graphe et le moteur. Il possède le **focus musical** :
il enregistre l'unique entrée physique canonique (`minilab-3` → `midi-out`) et
ne réémet le MIDI live que sur les branches de sortie choisies par les pistes
armées ou monitorées, via `emitDataTo`. La lecture de l'arrangement, elle, est
routée indépendamment par le plan natif par piste.

Il gère aussi le chien de garde d'export (`EXPORT_STALL_TIMEOUT_MS` = 60 s) :
seule une **progression réelle du nombre de trames** compte comme activité, car
la télémétrie native reste périodique même si le callback s'est arrêté.

### Le moteur (natif)

[sequencer.h](native/audio-engine/src/sequencer.h). Le renderer publie des
instantanés de projet immuables ; le callback audio ne lit qu'un plan
précompilé. Enregistrement MIDI et audio, export offline avec transport privé et
processeurs clonés, formats WAV (16/24/32 bits), MP3 (128–320 kbps) et OGG.

L'export possède son propre `Transport` : les éditions live restent donc
immédiates pendant un bounce. Seul un redémarrage du périphérique audio est
différé, parce qu'il retirerait le callback qui pilote les deux contextes.

---

## 10. Architecture de l'interface

### La coquille

[index.html](src/renderer/index.html) définit quatre zones fixes :

```
┌─────────────────────────────────────────────────────────┐
│ #app-header   marque · état MIDI · transport · projet   │
├───────────┬─────────────────────────────────────────────┤
│ #sidebar  │ #content                                    │
│ HOME      │  (le module actif y est monté)              │
│ SYSTEM    │                                             │
│ NODES     │                                             │
└───────────┴─────────────────────────────────────────────┘
                                          #modal-root
```

`#content` est **partagé** par tous les modules. C'est la raison pour laquelle
`unmount()` doit retirer ses écouteurs : un gestionnaire laissé sur `#content`
réagit aux clics des autres pages. Ce bug a réellement existé — cliquer sur une
action de plugin déclenchait l'action sur d'autres nœuds VST, et « Delete Node »
pouvait supprimer un nœud visité précédemment.

### Le Patch Bay

[routingModule.js](src/renderer/js/modules/routing/routingModule.js) — SVG natif,
sans framework. Les nœuds sont des `<g>` positionnés par `transform`, les ports
des pastilles, les câbles des courbes de Bézier cubiques.

Interactions : glisser un nœud, tirer un câble d'une sortie vers une entrée
compatible, cliquer un câble puis Suppr, Ctrl+C/Ctrl+V, menus contextuels sur
nœud et sur canevas, pan au clic droit glissé (seuil `PAN_THRESHOLD` = 4 px pour
distinguer clic et glissement), zoom à la molette.

La géométrie est centralisée dans
[nodeGeometry.js](src/renderer/js/core/nodeGeometry.js) : largeur 200,
zone d'identité 88 px, dock d'E/S qui grandit avec le nombre de ports. Le
MiniLab a une géométrie spéciale — sa surface de contrôle est dessinée à
l'échelle 0,405 et ses ports CONTROL sont placés sur les potentiomètres réels.

**Séparation stricte des responsabilités :**

| Donnée | Propriétaire | Clé de réglage |
|---|---|---|
| routage | `hub.graph` | `graphConnections` |
| positions | `GraphLayout` | `graphLayout` |
| pan et zoom | `GraphViewport` | `graphViewport` |
| instances | `NodeInstanceManager` | `nodeInstances` |

Les positions et le viewport sont de l'**état visuel** et ne doivent jamais
entrer dans `hub.graph`.

### Contrainte CSP

`default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:`

Les **styles inline sont interdits**. Toute géométrie dépendant d'une valeur est
donc soit un attribut SVG (`stroke-dasharray`, `transform="rotate(...)"`), soit
un attribut `data-*` inerte appliqué ensuite par le CSSOM — voir
`applyDynamicStyles()` dans le module séquenceur, et les fonctions `knobArcDash`
/ `knobPointerTransform` dans [omniPearl.js](src/renderer/js/ui/omniPearl.js).

### Échappement

Les noms de plugins, de fabricants et de périphériques viennent du disque ou du
matériel, pas de nous. `escapeHtml()`
([html.js](src/renderer/js/core/html.js)) est obligatoire partout où une telle
valeur atteint un littéral de gabarit : un plugin nommé
`<img src=x onerror=…>` doit s'afficher comme du texte.

### Deux systèmes visuels

⚠️ Il en coexiste **deux**, et c'est une dette identifiée :

- `base.css` (1 486 lignes) — le langage historique : `.panel`, `.btn`, `.pill`,
  utilisé par 9 fichiers ;
- `omni-pearl.css` (967 lignes) — le langage « Omni Pearl » : contrôles au rendu
  matériel construits autour de **vrais** éléments de formulaire, utilisé par le
  seul arpégiateur. `clip-editor.html` ne le charge même pas.

Voir [ROADMAP.md](ROADMAP.md), point 6.

---

## 11. Persistance : préférences et projets

Deux domaines strictement séparés.

### Préférences applicatives

`%APPDATA%/minilab-hub/settings.json`, écrit atomiquement (fichier `.tmp` puis
`rename`) par [settings.js](src/main/settings.js). Ce qui appartient à la
machine et survit d'un projet à l'autre :

`selectedInputId`, `midiInputPreference`, `selectedOutputId`, `inputOffsets`,
`audioOutputConfig`, `vstCatalog`, `metronomeEnabled`, `metronomeVolume`,
`recentProjectPath`, `recentProjectName`, `recentDirectories`.

Toutes ces clés sont écrites par le renderer, **sauf une**.
`recentDirectories` — le dossier utilisé pour `project`, `audioExport`,
`audioImport` et `audioRecordings`
([recentDirectories.js](src/main/recentDirectories.js)) — est produite par le
processus principal, puisque les sélecteurs de fichiers vivent là.

Deux voies l'alimentent : un sélecteur retient le dossier du fichier choisi
(`rememberDirectoryOfFile`) ; une destination **sans** sélecteur — les prises,
classées à la fin de l'enregistrement — se choisit dans Settings
(`directories:choose` → `rememberDirectory`). `effectiveDirectory(purpose)` dans
[main.js](src/main/main.js) est le seul point de lecture : mémoire d'abord,
dossier d'origine (`fallbackDirectory`) en repli.

Or le renderer réécrit `settings.json` **en entier** depuis la copie chargée à
son démarrage : tout dossier retenu depuis en est absent. `saveSettings`
réimpose donc cette clé depuis le disque à chaque écriture venue du renderer.
Voir [DECISIONS.md](DECISIONS.md) D-015 — le report n'est pas une redondance.

### État de projet

Fichier `.minihub` (JSON, `format: "minihub-project"`, `version: 1`), écrit
atomiquement par [projectFiles.js](src/main/projectFiles.js), validé à la
lecture comme à l'écriture. Emplacement par défaut :
`Documents/MiniHub/Projects`.

Les clés de projet sont listées **une seule fois**, dans
[projectKeys.js](src/renderer/js/core/projectKeys.js) :

`nodeInstances`, `graphConnections`, `graphLayout`, `graphViewport`,
`transportBpm`, `sequencerState`, `masterOutput`.

Deux mécanismes indépendants s'en servent, et c'est pour cela que la liste doit
rester unique :

- `ProjectManager.bootstrap()` **efface** ces clés au lancement, pour qu'un
  démarrage ordinaire parte d'un espace vide plutôt que de ressusciter la
  dernière session ;
- `SettingsStore.applicationData()` les **retire** avant écriture, pour que
  l'état de projet ne fuie jamais dans les préférences machine.

### Fermeture d'un projet modifié

Fermer la fenêtre **sauvegarde**. Le processus principal possède l'événement de
fermeture ([projectCloseGuard.js](src/main/projectCloseGuard.js)) mais pas le
projet : seul le renderer sait capturer l'état des VST3 et construire un
instantané valide. La fermeture est donc un aller-retour, dans cet ordre :

1. le renderer publie son identité de projet à chaque `publish()` — *modifié*,
   *nom*, et *possède déjà un fichier* ;
2. à la fermeture, un projet propre passe sans un mot ;
3. un projet modifié **qui a un fichier** déclenche `project:save-request` ; la
   fenêtre ne se ferme qu'une fois la réponse reçue, dans une limite de 20 s ;
4. un projet **jamais enregistré** est le seul à ouvrir une boîte : « Save… /
   Quit without saving / Cancel » ;
5. tout ce qui n'est pas une sauvegarde confirmée — échec d'écriture, moteur
   absent, renderer muet — ouvre le dialogue explicite « Close without saving /
   Cancel ». Le sélecteur refermé par l'utilisateur (`cancelled`) fait
   exception : il annule la fermeture sans second dialogue.

`app.on('before-quit')` route un `app.quit()` par le même chemin **avant**
d'arrêter le moteur natif : la capture d'état exige un moteur vivant, et une
fermeture annulée ne doit pas laisser l'application ouverte sans audio.

Voir [DECISIONS.md](DECISIONS.md) D-014 pour ce que ce choix coûte.

### Bascule de projet

Charger un projet **recharge le renderer** tout en gardant le processus natif
vivant. La séquence, dans `ProjectManager._replace()`, est ordonnée avec soin :

1. sérialiser le transfert dans `sessionStorage` **avant** de toucher au runtime ;
2. fermer les Clip Editors ;
3. `sequencerQuiesce` natif — un enregistrement, une horloge ou une note tenue
   ne doit pas survivre dans le projet suivant ;
4. `location.reload()` — la navigation est engagée **avant** la destruction ;
5. démonter les chaînes VST une fois la navigation actée.

Si quoi que ce soit échoue avant l'étape 4, l'ancien projet reste entièrement
jouable — c'est la raison de l'ordre choisi.

### État des plugins VST3

Capturé par `capturePluginStates` avant chaque sauvegarde. Les blocs d'état
arrivent en événements `pluginState` **avant** le marqueur de fin, et sont
persistés par le processus principal contre l'identité stable du plugin
(`persistPluginStateChunk`) — parce que le renderer peut déjà avoir disparu lors
d'une capture forcée à l'extinction.

---

## 12. Carte du code

### `src/main/` — processus principal (CommonJS)

| Fichier | Responsabilité |
|---|---|
| `main.js` | fenêtre, IPC, cycle de vie du moteur, dialogues |
| `preload.js` | `contextBridge` → `window.hubAPI` |
| `engine.js` | superviseur du processus natif (`EngineProcess`) |
| `engineCommandPolicy.js` | liste blanche des commandes moteur |
| `audioDeviceCommand.js`, `vstParameterCommand.js`, `vstParameterLearnCommand.js` | validateurs IPC purs |
| `settings.js` | préférences applicatives, écriture atomique |
| `recentDirectories.js` | dernier dossier retenu par sélecteur, et son report |
| `projectFiles.js` | lecture/écriture validée des `.minihub` |
| `projectCloseGuard.js` | fermeture : sauvegarde automatique, dialogue en dernier recours |
| `clipEditorWindows.js` | fenêtres Clip Editor et validation de leurs requêtes |
| `clipEditorPreload.js` | pont du Clip Editor |
| `diagnostics.js` | journal de démarrage, rotation à 4 Mo, empreintes |
| `engineEventTrace.js` | filtre des événements périodiques |
| `audioExportPath.js` | normalisation des extensions d'export |
| `consoleStreamGuard.js` | survie aux EPIPE sur stdout/stderr |

### `src/renderer/js/core/` — le cœur

| Fichier | Responsabilité |
|---|---|
| `hub.js` | assemblage du Hub |
| `eventBus.js` | bus d'événements isolant les erreurs de handler |
| `moduleSystem.js` | registre des modules, symétrie register/unregister |
| `graph.js` | graphe de routage, types de ports, détection de cycles |
| `nodeTypes.js` | registre des types de nœuds |
| `systemNodes.js` | identifiants des nœuds système |
| `nodeInstances.js` | instances, identité/ordinal, éditeurs de nœuds ⚠️ 1 143 lignes |
| `nodeGeometry.js`, `graphLayout.js`, `graphViewport.js`, `viewportMath.js`, `grid.js` | géométrie et état visuel du Patch Bay |
| `engineClient.js` | client du moteur, cache d'état, corrélation des requêtes |
| `engineSync.js` | graphe → plan natif, séparation topologie/valeurs |
| `chainSync.js` | reconstruction des chaînes VST après (re)démarrage moteur |
| `midiRouting.js`, `controlRouting.js` | injection MIDI et CONTROL dans le graphe |
| `controlBindings.js` | mappages MiniLab → paramètres VST3, Learn |
| `vstChain.js` | rôles VST et modèle de chaîne interne |
| `vstParameterDiscovery.js` | découverte des paramètres par nœud |
| `masterOutput.js` | gain master, normalisation |
| `sequencerModel.js`, `sequencerController.js` | séquenceur |
| `arpeggiatorState.js`, `arpeggiatorEditor.js` | arpégiateur |
| `projectManager.js`, `projectKeys.js` | cycle de vie et périmètre du projet |
| `settingsStore.js` | réglages côté renderer |
| `hardwareConfig.js` | restauration des préférences audio |
| `tempoControl.js` | normalisation du tempo, glissement au clic droit |
| `html.js` | `escapeHtml` |
| `diagnostics.js`, `buildStamp.js` | traçabilité |

### `src/renderer/js/modules/` — les modules

`home/` (accueil projet), `minilab/` (panneau contrôleur), `routing/` (Patch Bay),
`audioOutput/` (sortie audio système), `sequencer/` (arrangement).

### `src/renderer/js/ui/` et `midi/`

`sidebar.js`, `header.js`, `settingsModal.js`, `icons.js`,
`miniLabControlSurface.js`, `omniPearl.js` — et côté MIDI `midiManager.js`,
`parseMidi.js`, `controllerProfile.js`, `portRoles.js`, `minilab.js`,
`minilabControls.js`, plus `profiles/` (one JSON file per controller).

### `native/audio-engine/src/`

| Fichier | Responsabilité |
|---|---|
| `main.cpp` | point d'entrée, arguments de rôle |
| `ipc.{h,cpp}` | frontière JSON par lignes |
| `engine.{h,cpp}` | façade de contrôle, une méthode par commande ⚠️ 2 452 lignes |
| `engine2/audio_engine.{h,cpp}` | flux PortAudio unique, transport live |
| `engine2/portaudio_device.{h,cpp}` | périphérique WASAPI |
| `engine2/realtime_output_buffer.h` | tampon de sortie temps réel |
| `audio_graph.{h,cpp}` | plan audio compilé, PDC, mixage |
| `chain.{h,cpp}` | chaîne VST3 série, MIDI sans verrou, panic |
| `plugin_host.{h,cpp}` | instance VST3, éditeur, paramètres ⚠️ 1 841 lignes |
| `vst3_audio_buffer_bridge.{h,cpp}` | pont de tampons VST3 |
| `vst3_scanner.{h,cpp}`, `scanner_main.cpp` | scan VST3 en processus séparé |
| `midi_graph.{h,cpp}` | arpégiateurs, destinations |
| `midi_output.{h,cpp}` | sortie MIDI physique |
| `sequencer.{h,cpp}` | arrangement, enregistrement, export |
| `master_output.{h,cpp}` | gain et mesure master |
| `transport.h` | horloge, métronome, boucle |
| `audio_signal_meter.{h,cpp}` | télémétrie de frontière |
| `realtime_drops.h` | compteurs de blocs sautés |

### `test/` — 586 tests

Exécutés par le lanceur intégré de Node (`node:test`), sans dépendance. Ils
importent directement les modules du renderer. `domShim.mjs` fournit le DOM
minimal, `helpers.mjs` un Hub factice.

### `scripts/`

`sync-dist.mjs` promeut `src/` + le moteur natif Release dans `dist/MiniHub` et
écrit `runtime-provenance.json`. `launch-dist.mjs` lance la version packagée.
Les `runtime-*-gauntlet.mjs` sont des harnais de vérification ponctuels pilotant
l'application réelle par CDP.

---

## 13. Invariants à ne pas casser

1. **Aucun échantillon audio ne traverse l'IPC.** Uniquement du CONTRÔLE et du
   MIDI.
2. **Le graphe est l'autorité du routage.** Le module affiché n'influence jamais
   le signal. Un abonnement de routage appartient au Hub, pas à un `mount()`.
3. **Le thread audio ne bloque jamais.** `tryEnter`, structures sans verrou,
   aucune allocation dans le callback.
4. **Un `id` de nœud n'est jamais réutilisé.** L'`ordinal` est de l'affichage.
5. **`register` et `unregister` sont symétriques**, nœud de routage compris.
6. **Une clé de projet est déclarée une seule fois**, dans `projectKeys.js`, et
   n'apparaît jamais dans les `DEFAULTS` du processus principal.
7. **Un identifiant de nœud système vient de `systemNodes.js`**, jamais d'un
   littéral. *(La contrepartie C++ n'est pas encore unifiée — voir ROADMAP.)*
8. **`unmount()` retire tout** : abonnements et écouteurs DOM. `#content` est
   partagé.
9. **Toute valeur externe est échappée** avant d'atteindre `innerHTML`.
10. **Pas de style inline** — la CSP les rejette.
11. **`dist/` doit correspondre à `src/`.** Le test de provenance échoue sinon ;
    lancer `npm run sync:dist` après toute modification des sources.
12. **Le catalogue VST ne rétrécit jamais tout seul.** Seul un scan explicitement
    demandé par l'utilisateur peut le réduire (`_acceptsCatalog`).

---

## 14. Construire, lancer, tester

```bash
npm install            # Electron + rcedit
npm test               # 586 tests, lanceur Node intégré, ~5 s
npm run build:native   # moteur natif Release (CMake + MSBuild)
npm run build:native:tests
npm run sync:dist      # promeut src/ + moteur vers dist/MiniHub
npm start              # build natif + sync + lancement de la version packagée
```

**Dépendances natives à récupérer localement** (jamais versionnées, ~682 Mo) :
JUCE 9 dans `native/third_party/JUCE`, le SDK VST3 de Steinberg dans
`native/third_party/vst3sdk`, PortAudio dans `native/third_party/portaudio`,
LAME dans `native/third_party/lame`. CMake échoue avec un message explicite si
l'une manque.

**Tests natifs** (après `build:native:tests`) :

```bash
native/audio-engine/build/Release/mlh_native_tests.exe --core
native/audio-engine/build/Release/mlh_native_tests.exe --vst3-e2e
native/audio-engine/build/Release/mlh_native_tests.exe --cross-track-isolation
native/audio-engine/build/Release/mlh_realtime_output_tests.exe
```

**Diagnostic** : le journal de démarrage est dans
`%APPDATA%/minilab-hub/minilab-hub-startup.log` (rotation à 4 Mo, une
génération conservée). C'est la première chose à lire quand le moteur ne
démarre pas sur une machine inaccessible au débogueur.
