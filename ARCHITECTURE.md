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
opération entrante avant de la transmettre au renderer principal. La liste est
énumérée, jamais déduite — `quantize`, `add-note`, `update-note`, `move-notes`,
`set-notes`, `duplicate-notes`, `delete-notes`, `set-snap`, `update-audio` — et
un test la compare à celle du modèle, parce que la frontière de processus
(`main` en CommonJS, le modèle en module ES) interdit de n'en avoir qu'une.

The split between `move-notes` and `set-notes` is deliberate: the first
carries **deltas** (a drag), the second **absolute values** (a velocity), and a
payload where some fields are relative and others are not gets misread once and
is then wrong forever. `set-snap` is the one operation that writes project
state which is not a clip — see [DECISIONS.md](DECISIONS.md) D-035.

Two channels carry things that are **not** operations, because they are not
edits: `clip-editor:transport` (Play, Stop, Return) and
`clip-editor:audition` (sound one note). Neither writes model state, neither is
queued behind edits, and both are refused for a stale project for the same
reason an edit is. The audition's duration is bounded on both sides of the IPC —
the note-off is a scheduled callback in the renderer, so an unbounded duration
is a note held inside a VST for as long as the window lives
([DECISIONS.md](DECISIONS.md) D-036).

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
| `setControlRegistry`, `setControlStatus`, `pluginRequest` | [controlSourceCommand.js](src/main/controlSourceCommand.js) |
| `syncOneRing`, `setOneRingTargets`, `oneRingCommand`, `removeOneRing`, `setOneRingMaterial` | [oneRingCommand.js](src/main/oneRingCommand.js) |
| `getVstParameters`, `sequencerQuiesce` | inline dans [main.js](src/main/main.js) |

L'intention : la surface IPC exposée est une liste finie et relisible, pas
« n'importe quel objet que le renderer sérialise ».

#### Le profil du contrôleur — le seul appel synchrone

`preload.js` expose aussi `window.hubProfile`, obtenu par
`ipcRenderer.sendSync('profile:current')`. C'est **le seul appel synchrone de la
surface**, et il ne peut pas être autre chose : `MINILAB_NODE_ID` est une
constante de module dérivée du profil, évaluée au chargement du graphe ES —
c'est-à-dire avant la première ligne de `app.js`. Un profil obtenu par `invoke`
arriverait après que tous ses consommateurs ont figé leur valeur, et MiniHub
décoderait avec un profil tout en nommant son nœud d'après un autre.

Conséquence assumée : **changer de profil recharge la fenêtre**. Voir
[DECISIONS.md](DECISIONS.md) D-027 et
[loadedProfile.js](src/renderer/js/midi/loadedProfile.js).

Les cinq canaux asynchrones qui vont avec agissent tous sur le **prochain**
lancement :

| Canal | Ce qu'il fait |
|---|---|
| `profile:list` | ce que contient `userData/profiles/`, et lequel est choisi |
| `profile:pick` | ouvre le sélecteur et **lit** le fichier, sans rien stocker |
| `profile:import` | écrit le profil dans le dossier et le sélectionne |
| `profile:select` | choisit un profil déjà présent ; `null` = celui livré |
| `profile:forget` | supprime un profil importé, jamais celui en usage |

Le jugement se fait dans le renderer, pas dans le principal : `src/main/` est en
CommonJS et ne peut pas importer le validateur, qui est un module ES que la règle
`module boundary` garde tel quel. Le principal lit des octets, le renderer les
juge — et la conséquence est meilleure que la contrainte, puisqu'un fichier
refusé n'atteint jamais le dossier des profils.

#### The bindings bar — a second window drawn by the first

Each open plugin editor has a bindings bar docked under it (§10, *The bindings
bar*; [DECISIONS.md](DECISIONS.md) D-021). The bar is a window of its own with
its own preload, [bindingsBarPreload.js](src/main/bindingsBarPreload.js)
(`window.bindingsBarAPI`), and it owns nothing: the bindings, the armed Learn
and the cables live in the main renderer. So the main renderer draws every
bar, and main only carries and checks
([bindingsBarWindows.js](src/main/bindingsBarWindows.js)):

| Channel | From → to | What |
|---|---|---|
| `bindings-bar:wanted` | main → main renderer | a bar's page is loaded and listening: draw it |
| `bindings-bar:render` | main renderer → main → bar | the bar's markup, drawn by `renderControlBindings()` |
| `bindings-bar:values` | main renderer → main → bar | where each bound knob stands, apart from the markup so a drag is never redrawn under the mouse |
| `bindings-bar:list` | main renderer → main | which bars are open, after a reload |
| `bindings-bar:ready`, `bindings-bar:action` | bar → main (→ main renderer) | the page is listening; a click, as a typed action (`validAction`) addressed by the bar that sent it, never by a node it names |

The engine reports each editor frame's geometry as `editorBounds`, periodic
during a drag and therefore kept out of the startup log with `masterMeter`.


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
  `editorBounds` (the frame's visible edge, periodic), `pluginState`,
  `pluginStateCaptureComplete`
- paramètres : `vstParameters`, `vstParameterTouched`, `vstParameterLearnState`
- commands from a plugin (§6, *Commands from a plugin*): `controlEvents` (a
  stream, never logged), `controlRegistryStatus`, `pluginRequestResult`
- One Ring (§6, *One Ring*): `oneRingSynced`, `oneRingTargetsStatus`,
  `oneRingCommandResult`, `oneRingRemoved`, `oneRingStatus` (periodic, never
  logged), `oneRingMaterial`, `oneRingMaterialSet`, `oneRingWrite`
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
| `hub.commands` | `CommandBus` | commands a plugin on a CTRL OUT cable sends the modules (§6) |
| `hub.perform(fn)` | — | runs writes that are played, not authored: no undo step, no "modified", one coalesced save |

### Le contrat de module

```js
hub.modules.register({
  id: 'mon-module',                      // identité unique, obligatoire
  name: 'Mon Module',
  navEntry: { label: '…', icon: '…', group: 'node', accent: 'vst' },
  routingNode: { id, name, type, inputs, outputs, onInput },   // optionnel
  controlCommands() {},                  // optional: what its CTRL IN accepts
  onRegister(hub) {},                    // optionnel, une fois
  mount(container) {},                   // devient actif
  unmount() {}                           // désactivé — doit tout nettoyer
});
```

- `controlCommands()` returns the targets a plugin cabled into the module's
  routing node may command — typed commands built with the helpers of
  [commandRegistry.js](src/renderer/js/core/commandRegistry.js). It is asked
  again whenever what it describes may have changed, and only while a cable
  leads to the node. There is nothing to register: a module that declares it is
  commandable, and `unregister` takes its commands away with its node.

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
| `vst` | Plugin | midi, audio, control | midi, audio, control | chaîne de plugins |
| `mixer` | Audio | audio ×N (dynamique), control | audio | niveaux, mutes, master |
| `morpher` | Audio | audio ×N (dynamique), control | audio | niveaux, pas de morphing |
| `arpeggiator` | MIDI | midi, control | midi | motif, gamme, mode, rythme |
| `one-ring` | MIDI | midi | control, midi | a sequence (the VST's state made sparse), its material and its writer (§6, *One Ring*) |
| `sequencer` | MIDI | midi, audio, control | midi, audio | *(modèle séparé)* |
| `audio-input` | Audio | — | audio | — |
| `audio-player` | Audio | — | audio | a file's path, loop, level (§7, *`AudioPlayer`*) |
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
| `control` | valeurs normalisées sémantiques (K1..K8, pads…), and the commands a plugin sends from its node's CTRL OUT |

### Règles appliquées à la connexion

`connect()` refuse : un nœud inconnu, un port inconnu, des types incompatibles,
un doublon, et un **cycle** pour les types `midi` et `audio`
(`_wouldCreateCycle`) — and a controller's knob into a CTRL IN declared
`commandsOnly` (`carriesWhatInputTakes`): the Sequencer, the Arpeggiator, the
Mixer, the Morpher and the Audio Output have nothing a knob could be bound to.
A VST node's CTRL IN takes both, knobs for its bindings and commands for its
plugins.

`emitData(nodeId, portId, data)` diffuse à toutes les cibles câblées.
`emitDataTo(nodeId, portId, targetNodeId, data)` traverse **un seul** câble
existant — c'est ce qui permet au séquenceur de choisir laquelle de ses
branches de sortie reçoit un événement live, sans jamais inventer de route.

### MIDI through a VST node

A VST node's `midi-out` repeats what enters its `midi-in`: a track, a keyboard
or an arpeggiator wired into one instrument plays every node cabled after it
([DECISIONS.md](DECISIONS.md) D-039). The track's Destination stays the first
VST; the rest is the Patch Bay's business.

The series is answered by **one walk**,
[midiThru.js](src/renderer/js/core/midiThru.js) `midiThruReach(network,
nodeId)`: breadth-first along MIDI OUT cables, each node once, through VSTs
only. An arpeggiator, a One Ring and a `midi-output` node end it; the
Sequencer is never in it. Three consumers deliver on that one answer, which is the point of it being
one:

| Consumer | How it delivers |
|---|---|
| live playing — the VST node's `onInput` | `engine.midi` for each VST in the series; `emitDataTo(via, 'midi-out', …)` for an arpeggiator or a hardware output |
| sequencer playback and export | `SequencerController.syncNative()` sends each MIDI track a `thru` list; the native `Track` pushes the same block into every entry |
| an arpeggiator | `describeMidiNetwork` folds the series into its `destinations` |

Two things the walk refuses on purpose. It never re-emits through
`network.emitData`: the Sequencer's MIDI IN assumes only a controller emits
into it (`isCanonicalMidiIngress`), and a naive re-emission would have recorded
a VST's copy of every note. And an instrument two paths reach plays once — a
per-cable copy would double it.

A track's fader and mute cover its whole series (`midiTrackGainForOutput`, second
pass): lowering a track that lowered one layer would read as broken. The fader
scales the instruments' output; the mute stops the track's notes and leaves
that output alone, so what else an instrument plays is not muted with the
track (D-054). An audio track's mute likewise silences its clips and still
passes its input. A track
cabled to an instrument directly outranks one that reaches it through a series.

### Commands from a plugin

A plugin can command MiniHub's modules — One Ring, a VST3 built outside this
repository, is the first. It exposes the private interface of
[control_source.h](native/audio-engine/src/control_source.h) on its audio
processor; every other plugin answers `kNoInterface` and never hears of it.
[DECISIONS.md](DECISIONS.md) D-042 holds the why. The path, end to end:

| Step | Where | What |
|---|---|---|
| discovery | `DirectVst3Plugin::create` | `queryInterface` on the processor; `chainChanged` carries `controlSource: true` |
| the jack | `routingModule.js` | a VST node's CTRL OUT is drawn only when `hub.commands.sendsCommands(nodeId)`, or when a cable already leaves it |
| the list | `CommandBus.publish` | per plugin instance: the targets of the nodes its node's CTRL OUT is cabled to, compiled from each module's `controlCommands()`, sent as `setControlRegistry` only when it changed |
| the order | `_acceptInstanceStatus` | nothing is published before `instanceStatus: ready`, the report chainSync restores the saved state on — the plugin validates a state against the targets it knows |
| the packets | `Engine::forwardControlEvents` | the audio callback queues fixed-size packets inside the plugin; the 60 Hz timer drains at most 128 per instance into `controlEvents` |
| execution | `CommandBus.dispatch` | per packet: same instance and generation, a growing sequence, a published revision, the cable still in, a known command, the declared value type and range — then `execute` inside `hub.perform` |
| feedback | `setControlStatus` | why the last refused command was refused, in the plugin's own window, cleared by that command succeeding |

A command with a declared release (PLAY → STOP, RECORD_ON → RECORD_OFF) is
held by the bus until its release runs, and released once if the plugin cannot
send it: the cable pulled, the node deleted, the plugin bypassed or removed, the
engine gone. During a project change a hold is forgotten, never executed.

What a command writes is performance (D-032): `hub.perform` keeps it out of
`observe` and out of `markDirty`, coalesces its settings saves into one, and
hands the keys to `hub.history.absorb`, so the next edit's step does not carry
what was played before it.

Timing is the control thread's, not the audio grid's: a command lands one timer
tick and one IPC round after its step — a Stop programmed on beat 6 was measured
stopping the transport at 6.00 to 6.03. An offline export executes no command.

#### Requests to a plugin

What such a plugin keeps in its own state — One Ring's channels, steps, scenes —
no parameter shows and no host can click. The same header declares a third
optional interface, `IControlRequests`: a JSON object in, a JSON object out, in
the plugin's own vocabulary ([DECISIONS.md](DECISIONS.md) D-043).

| Step | Where | What |
|---|---|---|
| discovery | `DirectVst3Plugin::create` | `queryInterface`; `chainChanged` carries `requests: true`, `describe` shows it on the plugin |
| the agent | `agentRequests.js`, kind `plugin` | who is asked: a plugin of this project, ready, that takes requests; gated on the project id — the body is not read |
| the engine | `Engine::cmdPluginRequest` | the instance of the generation the renderer knew; request at most 1 MB, reply at most 4 MB and a JSON object; answers `pluginRequestResult` |
| the plugin | `request` then `readReply` | runs the request on the engine's message thread and keeps the reply, read back at its size |

The reply reaches the agent unchanged, `ok: false` included: a plugin's refusal
is an answer, not a failure of the channel. A plugin that changes what it will
save announces it (`restartComponent`), MiniHub captures its state, and the
project is marked modified like any edit.

### One Ring — a native command source, and a MIDI processor

A One Ring node ([DECISIONS.md](DECISIONS.md) D-070 to D-072) is One Ring's
sequencer made a node: its runtime runs in the engine (§7, *One Ring*), its
commands take the path above, and it plays notes. Where each part lives:

| Part | Where | What |
|---|---|---|
| the content | [oneRingSequence.js](src/renderer/js/core/oneRingSequence.js) | the sequence as the VST saved it, each channel's cells kept sparse against a `blank`; scenes A1 to D8 (`SCENE_PLACES`); the material, the voices' rules per scene, the writer's settings; read with the engine's own defaults, so both sides refuse the same states |
| the page's edits | [oneRingEdits.js](src/renderer/js/core/oneRingEdits.js) | what each control does to the sequence, as pure functions — the page and the agent's requests (`oneRingRequests.js`) call the same ones |
| the engine's copy | [oneRingNodes.js](src/renderer/js/core/oneRingNodes.js) (`hub.oneRing`) | sends a node's sequence when it changes, one in flight per node; every one again when an engine starts; the material apart from it; takes back the scene played (as performance), the material captured (as an edit) and each generation to write |
| the commands | `CommandBus` | a native source keyed by node id beside the plugin sources: targets published with `setOneRingTargets`, `controlEvents` carrying `nodeId` and `generation`, checked and executed like a plugin's, holds released the same way |
| MIDI IN | `midiThru.js`, `sequencerModule.js`, `nodeInstances.js` | a MIDI track may name the node as its Destination; a controller cabled to it sends its notes through `engine.midiNode` |
| MIDI OUT | `describeMidiNetwork` (`engineSync.js`) | the node's destinations — chains and their series, arpeggiators, the hardware output — described as an arpeggiator's are |
| generations | `SequencerController.writeGeneration` | a new track, or the one clip the writer names; one undo step, the project modified (D-072) |
| from the VST | [oneRingImport.js](src/renderer/js/core/oneRingImport.js), [juceState.js](src/renderer/js/core/juceState.js) | "Copy to One Ring node" on a VST node holding One Ring: its JUCE state read, a node made, the CTRL OUT cables moved |

A One Ring has no CTRL IN: it takes no command, and the STOP a sequence sends to
the Sequencer does not stop it. Every Stop a person gives does
(`stopOneRings`), Pause does not (D-048).

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
  SequencerEngine ──► One Ring ──► MidiExecutionPlan    AudioExecutionPlan
  (arrangement,       runtimes     (arpégiateurs,       (ordre topologique,
   enregistrement,    (one per     destinations)         délais PDC, mix)
   export)             node)
        order in a block: Sequencer, One Ring, arpeggiators, chains
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
  `player`, `diagnosticSine`) ;
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

A seek is not a panic. `Engine::releaseAllMidi` gives the notes the sequencer
and the arpeggiators sound their Note Off, lets them ring out, and the sequencer
chases the new position. One Ring's SEEK 0 at the end of its cycle used to put
All Sound Off on every chain and cut every voice at the loop point. Stop, a new
MIDI wiring and a sequencer sync that sends a track somewhere else still panic.
A sync that keeps every track where it plays — a clip edited, or written, while
the piece plays — panics nothing: the callback gives Note Off to the notes of
the tracks whose clips changed and chases their new ones, and the other tracks
play on (`SequencerEngine::adoptLivePlan`; `sequencerSynced` says
`keptRouting`).

### `AudioPlayer` — a file in the Patch Bay

[audio_player.h](native/audio-engine/src/audio_player.h). An Audio Player node's
file, decoded whole by the engine on a worker thread -- the renderer sends a
path, never a sample (invariant 1). Players are append-only like chains: a plan
holds their raw pointers, so a node that goes only unloads its file.

| Step | Where | What |
|---|---|---|
| the list | `AudioPlayerNodes` (`core/audioPlayers.js`) | every player of the project, `{ nodeId, filePath, loop }`, sent as `syncAudioPlayers` whenever it may have changed; one it leaves out holds no file |
| the file | `Engine::loadAudioPlayerFile` | decoded off the message thread (`audio_player::decode`), shared by the players of the same file, answered as `audioPlayerFile`: `loading`, `ready` with length, rate and a 512-point overview, `error` with a sentence, `empty` |
| the level | `describeAudioNetwork` | the node's `masterLevel` in the audio network: a value, never a recompile |
| the sound | `AudioPlayer::render`, node kind `player` | at the file's own rate, converted by a 64-tap windowed sinc; the transport's edges, the commands of its page (`audioPlayerTransport`), fades of 5 ms on a pause, a stop, a seek |
| where it is | `Engine::forwardAudioPlayers` | `audioPlayerStatus`, on a change and ten times a second while it plays, kept out of the startup log |

The transport drives every player, and does not place it: its start plays them
from where they are, its stop pauses them, and the Stop somebody gives returns
them to their start. An export plays a copy of each from its beginning.
[DECISIONS.md](DECISIONS.md) D-051 holds the why. The header's **Plays**
selector (`setPlayScope`, D-053) can take the players out of the transport
(Sequencer), or the arrangement's clips out of it (Players).

### `MidiExecutionPlan` — arpégiateurs et destinations

[midi_network.h](native/audio-engine/src/midi_network.h). `ArpeggiatorRuntime`
implémente les modes (Up, Down, Up/Down, As Played, Random, Custom), la
quantification sur gamme, les liaisons (`tie`) et les silences (`rest`). Le
motif custom fait jusqu'à 32 pas.

A `syncMidiNetwork` with the same nodes and cables as the running plan changes
values only — a rate, a mode, a step, often sent every beat by a plugin on a
CTRL OUT cable. The engine hands them to the running arpeggiators
(`MidiExecutionPlan::setValues`, a three-slot latest-value exchange read at the
next block): held and sounding notes are kept and nothing is panicked. Only a
change of nodes or cables compiles a new plan, and its panic silences every
chain, a pad played by a Sequencer track included. The startup log shows which
path was taken: `engine:event midiNetworkSynced nodes=N rebuilt=true|false`.

### One Ring — a runtime per node

[one_ring/runtime.h](native/audio-engine/src/one_ring/runtime.h). One Ring's
core — `scheduler`, `model`, `generative`, `commands` — was ported from the VST
with its behaviour unchanged, into `native/audio-engine/src/one_ring/`,
namespace `mlh::one_ring` (D-070). A `Runtime` does what the VST's processor
did around it, with the live `Transport` where the VST had a host playhead:

- **The clock**: one beat counter per node, advanced at the transport's tempo.
  The transport's Play starts it; while both play, a seek or a loop wrap moves
  it with the arrangement; the transport stopping does not stop it, a STOP of
  its own does — which every Stop a person gives sends (`stopOneRings` on
  `setTransport`). A command from outside the sequence begins a tick of its own
  (`Scheduler::beginCommand`), so the per-tick guards against a sequence
  recalling itself in a loop do not refuse a second press at rest.
- **Where it runs**: `Engine::processEngine2Block` runs the Sequencer, then
  every One Ring of the published `OneRingSet`, then the arpeggiators, then the
  chains. A MIDI track aimed at a One Ring pushes its block into the runtime's
  scheduled input (`OneRingInputs`), as one aimed at an arpeggiator does.
- **Notes** (D-071): `capture.*` takes what reaches MIDI IN, on its own count of
  beats; `material.*` holds the origin and the current generation, 256 notes
  each; `voices.*` renders the four voices block by block, each note at the
  sample nearest its beat, and keeps each sounding note until its Note Off;
  `take.*` keeps the last 1,024 notes the voices played, for a `WRITE`.
- **Out**: commands as `controlEvents`, drained by the timer; notes straight to
  the chains, the arpeggiators' inputs and the hardware output that
  `syncMidiNetwork` handed it — only when they change, the old destinations
  given their Note Offs first; generations as `oneRingWrite`; a status on any
  change and every 100 ms while playing.
- **A node removed** plays on, out of the set, until the callback has ended its
  notes (`drainingOneRings_`); a panic makes it forget them, a seek releases
  them.

The engine takes at most 32 scenes per sequence; a plan of 32 worked scenes is
about 4.3 MB and takes about 70 ms to read, which is why the renderer keeps one
sequence in flight per node.

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

**Time signature** (D-059). The transport holds the project's signature as one
packed word (`TimeSig`), sent by the renderer with `setTransport`; a value
that is not a signature is refused and the last good one kept. `beginBlock`
fixes it for the block, like the tempo, and `getPosition` gives plugins that
signature and the start of the current bar in it. The metronome clicks every
beat of it (the denominator's note), accented on the bar; the count-in is one
bar, in the signature Record was pressed in. One Ring's own bar stays four
quarters.

Since D-061 that signature is a map: `setMeter` takes every region from
quarter 0 into fixed arrays of atomics behind a sequence counter -- written by
the message thread, read by the audio thread without a lock, again if a write
overlapped. `meterAt(ppq)` answers the region and where the next begins, so
the metronome and the Morpher look it up only when they cross into another.

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

### One Ring's plans and queues

A One Ring runtime is fed and read by three threads, and the callback never
waits for either of the others ([runtime.h](native/audio-engine/src/one_ring/runtime.h)).
A new sequence is an immutable plan swapped at a block boundary, behind a
readers count; the set of runtimes the callback walks (`OneRingSet`) is
published the same way, and a retired one is freed by the message thread once
no block reads it. Commands, live notes and material go in, and commands,
generations and material come out, through single-producer single-consumer
queues of fixed capacity: a full queue refuses the item and counts it. The
status is a three-slot latest-value exchange (`Latest`), because a queue nobody
drains keeps its oldest entries — the VST's first status, read after a quiet
minute, described a sequence that had since started.

### Reading the arrangement from a realtime thread

The sequencer publishes immutable plans and the message thread frees the old
ones (`SequencerEngine::reclaimPlans`). A thread that walks a plan must claim it
first, through `acquirePlan(exportContext)` / `releasePlan(exportContext)`: a
bare `activePlan_.load()` is a plan that the next edit may free under the
reader.

There is **one claim per reader, not one shared slot.** The audio callback
(`liveHazard_`) and the offline export worker (`exportHazard_`) read at the same
moment on two threads; with a single slot the later store erased the earlier
claim, and `test/native_tests.cpp` (`sequencer-plan-readers`) fails the day
they share one again. The export plan itself belongs to `preparedExportPlan_`
and is destroyed in `cancelExport()` / `serviceEvents()` once the export claim
lets go of it. Readers on the message thread (`setTrackControl`, `panic`,
`trackSignalTrace`, `beginRecording`) need no claim: reclamation runs on that
same thread.

---

## 9. Le séquenceur

### Le modèle (renderer)

[sequencerModel.js](src/renderer/js/core/sequencerModel.js). Résolution :
`TICKS_PER_QUARTER = 960`. Limites dures : **64 pistes, 2048 clips par piste,
65 536 notes par clip** (`SEQUENCER_LIMITS`).

**The time signature is the arrangement's** (D-059): `signature` in the state,
4/4 when absent, so it is saved and undone with the tracks. Positions stay in
quarters; what a bar is comes from [musicalTime.js](src/renderer/js/core/musicalTime.js)
and nowhere else -- `quartersPerBar(signature)` is 3.5 in 7/8. Every caller
passes the signature (`SequencerController.signature`): a function there
called without one answers in 4/4, which is right only in a 4/4 project.
`1 bar` in Snap and Quantize is the one grid value that depends on it.

**A track may count its own bars** (D-060): `meter` on a track, signature
changes at the track's own bar numbers, the project's signature before the
first. The model reads a track's bars through `trackRegions(track)` and snaps
on them; lanes are drawn from the same regions. The engine never sees a track
meter: notes are in quarters, and the transport, the metronome and what
plugins read stay the project's.

**The project's signature changes along the song** (D-061): `meter` in the
state, changes after bar one; `projectRegions()` is the map every bar is
read from, and tracks are built on it. The engine is sent the whole map
(`setTransport.meter`).

Grilles de quantification : 1 mesure, 1/2, 1/4, 1/8, 1/16, 1/32, 1/8 triolet,
1/16 triolet. Aimantation : 1 mesure, 1/2, 1/4, 1/8, 1/16, 1/32 — le premier
vocabulaire **contient** le second, ce qui est ce qui permet au menu contextuel
d'un clip d'offrir « Quantize to <l'aimantation courante> » sans trou.

Zoom : de `ZOOM_MIN` = 1 à `ZOOM_MAX` = 240 pixels par noire. Le plancher de 1
n'est pas une coquetterie — voir [DECISIONS.md](DECISIONS.md) D-033.

**Note and clip group edits.** Four operations act on a selection rather than on
one id, and three of them are shared with the Clip Editor's other window:

| Operation | What it moves | Rule |
|---|---|---|
| `moveClips` | clips, across tracks | one common delta, reduced for the group |
| `moveMidiNotes` | notes: start, pitch, duration | the same, via `clampNoteGroupDelta` |
| `setMidiNotes` | notes: velocity, channel | absolute values, clamped per note |
| `duplicateMidiNotes` | notes | copies one selection-span later |

`clampNoteGroupDelta` is **exported and pure** because two processes need the
identical answer: the model applies it, and the Clip Editor draws it a frame
earlier, in another window, before any IPC has happened. A second
implementation there drifts, and the symptom is a note that slides one way
under the hand and lands another when released — which is the defect that
motivated it.

`splitClip` cuts a clip in two without redistributing anything: both halves
keep the whole source and take a different window onto it
([DECISIONS.md](DECISIONS.md) D-034).

**A take into a track that holds clips** ([DECISIONS.md](DECISIONS.md) D-063).
`recordMidiTake` writes a MIDI take into the clips it was played over --
Overdub adds, Replace clears the range first -- and stretches a clip to take
a note played past its edge; `clearAudioRange` cuts an audio take's range out
of the other clips in Replace. The engine folds a take round a loop onto the
loop and numbers each note's `pass`; which passes survive is the renderer's
choice, made from the mode the take began in.

A MIDI clip also keeps `controls` -- CC, pitch wheel, channel and key
pressure -- in its source quarters beside its notes ([DECISIONS.md](DECISIONS.md)
D-064). The engine plays them at their sample before the notes, chases them on
Play, a seek and a loop's return, and lets the pedal and the wheel go on a stop.

A track also has `automation` ([DECISIONS.md](DECISIONS.md) D-065): lanes of
points for plugin parameters, recorded by the engine from a bound knob's
`setVstParameter` during a take. Played back, a lane's value goes from the
sequencer to the plugin's chain through a lock-free FIFO (`Chain::pushAutomation`),
and into the plugin's `inputParameterChanges` before its block -- the only path
by which the audio thread writes a plugin parameter.

Une piste est `midi` ou `audio` ; un clip audio porte `trimStartSeconds`,
`trimEndSeconds`, `gain`, `peaks` et un état de disponibilité du média.

### Le contrôleur (renderer)

[sequencerController.js](src/renderer/js/core/sequencerController.js) fait le
lien entre le modèle, le graphe et le moteur. Il possède le **focus musical** :
il enregistre l'unique entrée physique canonique (`minilab-3` → `midi-out`) et
ne réémet le MIDI live que sur les branches de sortie choisies par les pistes
armées ou monitorées, via `emitDataTo`. La lecture de l'arrangement, elle, est
routée indépendamment par le plan natif par piste.

An audio track that is armed or monitored passes what reaches its Input on to
its Destination, transport running or not, and in an export too
([DECISIONS.md](DECISIONS.md) D-052). Its Input is a node cabled straight into
the Sequencer's AUDIO IN; nothing else reaches it.

**A generation One Ring wrote** comes in through `writeGeneration`
([DECISIONS.md](DECISIONS.md) D-072): a MIDI track of its own with the
generation as its one clip, placed where it was heard and taking neither the
focus nor the selection, or the notes of the one clip the writer names,
replaced (`SequencerModel.replaceMidiNotes`) or added to (`addMidiNotes`) —
the two operations the Clip Editor's protocol offers too, as `replace-notes`
and `add-notes`. A named clip gone or not MIDI is refused, never replaced by
another. Each write is one `changed()`: one undo step, the project modified.
The sync it causes keeps the routing, so nothing is silenced (§7, *`Chain`*;
D-073).

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

**Pan.** A track and a Mixer strip each carry a pan, one balance law for both
([pan_law.h](native/audio-engine/src/pan_law.h), D-057): centred it is exactly
unity, turned to a side it lowers the other side only. An audio track pans its
clip sum after its fader; a MIDI track pans the instrument it plays, where its
fader already acts (`midiTrackGainForOutput`). Like the fader, a pan is a live
control (`setSequencerTrackControl`), never a resync.

**A track with its instrument** ([instrumentTrack.js](src/renderer/js/core/instrumentTrack.js)):
"+ MIDI Track" offers the installed instruments; taking one makes a VST node
with the plugin, cables the Sequencer to it and its sound where the previous
instrument's goes, and opens the plugin's window when it is ready. The same
doors a hand uses, so the network stays the only routing (invariant 2).

---

## 10. Architecture de l'interface

### La coquille

[index.html](src/renderer/index.html) defines five fixed zones:

```
┌─────────────────────────────────────────────────────────┐
│ #app-header  project · File Edit View · transport · ─□× │
├───────────┬─────────────────────────────────────────────┤
│ #sidebar  │ #content                                    │
│ HOME      │  (le module actif y est monté)              │
│ SYSTEM    │                                             │
│ NODES     │                                             │
├───────────┴─────────────────────────────────────────────┤
│ .status-bar   controller · audio engine · device        │
└─────────────────────────────────────────────────────────┘
                                          #modal-root
```

Since D-055 the header **is** the window's title bar: the window is created
with `titleBarStyle: 'hidden'` and a `titleBarOverlay`, so Windows draws only
its three caption buttons, over `.caption-space`, and the rest of the header is
a drag region (`-webkit-app-region`), switched off while a dialog or a menu is
open over it. File, Edit and View are buttons whose menus the page draws
([ui/appMenus.js](src/renderer/js/ui/appMenus.js)) from main's description of
the application menu (`menu:describe`), sending back the entry chosen
(`menu:invoke`), which the native item performs -- one list of entries, its
roles and accelerators intact. Tooltips are drawn by the page too
([ui/tooltip.js](src/renderer/js/ui/tooltip.js)): a `title` is taken off its
element while hovered and given back after. The transport's values sit in a
black readout; the controller and the audio engine moved to the status bar
([ui/statusBar.js](src/renderer/js/ui/statusBar.js), fed by `engine:state` and
`engine:deviceState`).

The transport ends on **Export** ([ui/exportPanel.js](src/renderer/js/ui/exportPanel.js),
D-056): a panel drawn by the page, not a module, since an export renders the
Audio Output whatever page is on screen and whether a Sequencer is in the patch
or not. Its length is `SequencerController.exportSpan`. **Space** plays and
stops on every page ([ui/transportKeys.js](src/renderer/js/ui/transportKeys.js)),
a caret or an open list excepted.

L'en-tête **affiche** le projet, il ne le pilote pas : les actions de projet
sont dans le menu de l'application ([appMenu.js](src/main/appMenu.js)), avec
les raccourcis habituels. Le processus principal n'envoie qu'un nom de commande
sur `menu:command` ; c'est [menuCommands.js](src/renderer/js/core/menuCommands.js)
qui le résout contre `hub.project`, seul détenteur de l'état — modifié, en cours
d'enregistrement, jamais sauvegardé.

**Two layouts** ([interfaceLayout.js](src/renderer/js/ui/interfaceLayout.js),
D-057). Original: one page at a time, in `#content`. Hybrid 1: the Sequencer
*docked* in `#content-top` (`ModuleSystem.dock`), `#content` below it as the
page area, a bar between them. Opening the docked module only points at it;
a page opened from the dock's container lands in `#content`. The Sequencer and
the Patch Bay answer the same keys, so each asks `paneHasKeys` first: the half
pressed last has them. The layout and the bar's share are application
settings, not project keys.

**The bindings bar** ([DECISIONS.md](DECISIONS.md) D-021). A knob is learned
from under the plugin's own window, not from a page of the shell: the VST
node's page has no bindings panel since 2026-09-15. Main opens one frameless,
non-focusable window per open plugin editor and places it from the engine's
`editorBounds` (`placeBar`): under the frame when the screen has room, else a
column beside it, over the plugin only when neither side has 300 px. The page,
[bindings-bar.html](src/renderer/bindings-bar.html) with
[bindingsBar.js](src/renderer/js/bindingsBar.js), shows markup and reports
clicks. What it shows is drawn in the main renderer by
[bindingsBarHost.js](src/renderer/js/core/bindingsBarHost.js) with
`renderControlBindings()` ([controlBindingsPanel.js](src/renderer/js/core/controlBindingsPanel.js)),
and each click is carried out by
[controlBindingActions.js](src/renderer/js/core/controlBindingActions.js):
the bar holds no binding rule of its own, so D-018's refactor, when it comes,
touches one call site more rather than a second implementation. The strip is
styled in `base.css`; the controller faceplates inside it are the shell's
`miniLabControlSurface`, not the `omni-pearl` faceplate. Taller than wide, the
page lays itself out as a column (`@media (orientation: portrait)`).

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

Since D-055 the canvas takes the whole page and its controls float in its
corners: the Add field (it opens the canvas menu, under it), the cable legend,
the Tab hint, and Align / zoom / Fit. **Tab** turns the canvas round to the rear
view, where each controller card used to carry a switch. A card is flat: its
family (`nodeFamily` in `core/nodeTypes.js` -- the OmniBox category, `media` or
`system`) is the one colour it wears, as a short heavy bracket straddling
its top-left corner; under the title a
black readout says what the node holds (`core/nodeSummary.js`); a jack is
filled once a cable is on it, and a cable takes its type's colour, a control
cable dashed. No drop shadow on a card: a filter per card is what a drag
repaints every frame. What moves on a card -- the output's L and R
(`engine:masterMeter`), a Mixer's or Morpher's strips (`engine:nodeMeters`,
from the engine's `NodeMeters`, 10 Hz), a One Ring's scene and state
(`oneRing:status`) -- is written into its elements in place, never by a
redraw; the meters rise at once and fall at 30 dB/s, animated.

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

### Context menus

**One implementation** since 2026-09-25:
[ui/contextMenu.js](src/renderer/js/ui/contextMenu.js), used by the Sequencer
and the Patch Bay. It attaches to `document.body`, closes on Escape, on a press
or right-click outside it, a wheel, a scroll, a blur, a resize and its caller's
next render or unmount, removes every listener it added, and is built with
`createElement` so a clip name reaching a label has no markup path to travel
down (invariant 9 satisfied by construction). Position goes through the CSSOM
(invariant 10). A press INSIDE it is not "outside": the document hears a press
in capture, before the menu, and closing there removed the menu before its own
click -- no entry ran in the application until that was seen.

Entries are flat: `{ heading }` titles a group, `{ separator }` divides,
`search` puts a field on top that narrows the entries as it is typed into
(a heading stays only while it heads something), and the arrows and Enter walk
and take them. The Patch Bay's canvas menu lists every node type under its
family that way, where it used to nest three hover submenus
(OmniBox > family > type); the author found those unergonomic. A double-click
of the empty canvas opens the same list. A node's menu acts on the selection it
belongs to -- a right-click on an unselected node selects it first, as a file
manager does -- and a cable has one, to unplug it.

The Patch Bay's menus borrow the `.ctx-item` / `.ctx-separator` vocabulary
their hand-built ancestors declared; a first attempt at the shared module
redeclared `.ctx-item` and, sitting later in `base.css`, silently restyled
them. A test in `test/contextMenu.test.mjs` is what stops that returning.

The VST node's plugin list is not a third menu but a select's list, drawn by
the page as the faceplate's are (`bindPearlLists`):
[ui/pluginMenu.js](src/renderer/js/ui/pluginMenu.js) leaves the `<select>` in
charge of the value and draws what it opens, because a select cannot fold a
brand's plugins into one row (`foldPluginsByBrand`, `core/vstChain.js`). It
wears the `.ctx-menu` vocabulary, scoped under `.plugin-menu`, and scrolls,
since one brand can hold more plugins than the screen has rows.

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

### Home — the only bitmaps in the renderer

The four Home cards are the first, and so far only, pictures MiniHub ships:
`src/renderer/assets/home/*.jpg`, referenced from the module as
`assets/home/<file>` — a path relative to `index.html`, which is what Chromium
resolves, not to the module that writes the markup. JPEG at 1400 px wide: the
column never renders a card past 700 px, so that covers a 2× screen, and it
keeps each file near 100 kB where the source PNG was 1.8 MB.

Their frames are cut by `clip-path`, and **a clipped box loses its border with
its corners**. So every framed shape is a pair: a filled shape, and the same
shape inset 1 px on top of it — `.home-card-frame` / `.home-card-face` for the
card, `.home-card-art` / `.home-card-art-face` for the picture's slanted edge.
What shows between the two is the 1 px outline the design asks for. Focus works
the same way: there is no outside left to draw a ring in, so the frame itself
takes the accent colour.

A test reads the mounted markup and checks every picture it names is really on
disk (`test/homeStartup.test.mjs`): a renamed file would otherwise leave a card
with a silent hole in it — no error, no log.

### Deux systèmes visuels

⚠️ Il en coexiste **deux**, et c'est une dette identifiée :

- `base.css` (2 446 lignes) — le langage historique : `.panel`, `.btn`, `.pill` ;
- `omni-pearl.css` (2 561 lignes) — le langage « Omni Pearl » : contrôles au
  rendu matériel construits autour de **vrais** éléments de formulaire, porté
  par l'arpégiateur et, since 2026-09-17, by One Ring's page. `clip-editor.html`
  ne le charge même pas. Façade graphite depuis le 2026-09-12
  ([DECISIONS.md](DECISIONS.md) D-037) : elle ressemble à la machine qu'elle
  dessine, et toutes ses couleurs sont des tokens. One Ring extended it with a
  section 5 — key caps, LEDs, LCD fields, scribble strips, rotary selectors,
  drag knobs and pads, built by `ui/omniPearl.js` — and with lists it draws
  itself (`bindPearlLists`): the list a native `<select>` opens is a window
  Chromium paints after the operating system's theme, white on Windows, which
  neither `color-scheme` nor `nativeTheme` reached in Electron 43.

**One Ring's page** ([modules/oneRing/](src/renderer/js/modules/oneRing/)) is
a deck — transport, display, scenes — above four tabs: SEQUENCE (the channels,
the 64 cells as pads, the cell and its Follow Actions), MEMORY (capture and
material), VOICES (the four voices' rules) and WRITER (where generations go,
and feedback). `oneRingFaceplate.js` draws the sequence, `oneRingNotes.js` the
three other tabs, `oneRingParts.js` their shared pieces, `oneRingPanel.js`
binds them. The page is five regions, each redrawn only when its markup
changes; the status never redraws, it lights the display, LEDs and playheads
in place.

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
`recentDirectories` — le dossier utilisé pour `project`, `template`,
`audioExport`, `audioImport` et `audioRecordings`
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

### Templates

A template is the same `.minihub` file in another folder:
`Documents/MiniHub/Templates`, beside `Projects` and never inside it, with its
own `template` purpose in [recentDirectories.js](src/main/recentDirectories.js).

That separation carries the entire contract, in both directions:

- **Save as Template** (`project:save-as-template`, `ProjectManager.saveAsTemplate`)
  captures the VST3 state exactly as Save does, then writes through
  `template:pick-save`. What it does NOT do is the point: it moves neither the
  project's file, nor its name, nor its dirty flag, nor `recentProjectPath` —
  Home's Current Project card reads that key, and a template listed there would
  be reopened as the project and overwritten by the next Ctrl+S.
- **Start from a template** (`project:template`, `ProjectManager.newFromTemplate`)
  reads the file and replaces the project **with no file path**, and with a
  fresh `projectId` and `createdAt`. The first Ctrl+S therefore opens the
  PROJECT picker, in the projects folder, and the template on disk is never
  written to by an ordinary save.
- Because the two dialogs remember **different** folders, saving a template
  cannot move where the next project is saved, and vice versa. A single shared
  memory would have made "Save as Template" quietly redirect every later Save.

A template is therefore changed the way it was made: start from it, edit it,
Save as Template again over the same name. An empty templates folder opens no
dialog at all — main answers `{ empty: true }` and the renderer says how a
template is made, which is the sentence an empty file dialog cannot say.

MiniHub ships one template, `src/main/templates/The basic.minihub`: the
controller into an empty VST node, that node into the audio output. It is an
**example**, for somebody opening MiniHub with no idea what a patch looks like
— the shortest one that makes a sound. Its cables name the controller node of
the profile that ships, and swapping that node for one's own keyboard and
saving the result is the exercise, not a defect to work around.

It travels with `src/` into the package and into the installer, and
[shippedTemplates.js](src/main/shippedTemplates.js) copies it into the user's
templates folder at startup — **only when it is not already there**. A native
file dialog can show one folder and knows nothing of the application's
resources, so a shipped template that stayed inside the package would be one
nobody can open; and a copy that overwrote would throw away a template the user
had edited under the same name. The cost of that rule, stated so nobody calls it
a bug: a shipped template the user deletes comes back at the next launch.

`test/projectTemplates.test.mjs` holds the negative half of this contract, and
`test/shippedTemplates.test.cjs` the shipped copy.

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
| `launchContext.js` | where Windows really files AppData; a MiniHub inside another app's package starts again through the shell (D-045) |
| `preload.js` | `contextBridge` → `window.hubAPI` |
| `engine.js` | superviseur du processus natif (`EngineProcess`) |
| `engineCommandPolicy.js` | liste blanche des commandes moteur |
| `audioDeviceCommand.js`, `vstParameterCommand.js`, `vstParameterLearnCommand.js`, `controlSourceCommand.js`, `oneRingCommand.js` | validateurs IPC purs |
| `bindingsBarWindows.js`, `bindingsBarPreload.js` | the bindings bar under each plugin editor: placing it, carrying its markup and its clicks (D-021) |
| `settings.js` | préférences applicatives, écriture atomique |
| `recentDirectories.js` | dernier dossier retenu par sélecteur, et son report |
| `projectFiles.js` | lecture/écriture validée des `.minihub` |
| `projectCloseGuard.js` | fermeture : sauvegarde automatique, dialogue en dernier recours |
| `appMenu.js` | menu de l'application ; Fichier → Nouveau / Modèle / Ouvrir / Enregistrer / Enregistrer comme modèle |
| `shippedTemplates.js` | le modèle livré, copié au démarrage s'il manque |
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
| `pluginCatalog.js` | one entry per plugin, whichever path the scanner reached it by (D-044) |
| `engineSync.js` | graphe → plan natif, séparation topologie/valeurs |
| `midiThru.js` | what a VST node's MIDI OUT reaches — the one walk every consumer of a series reads |
| `chainSync.js` | reconstruction des chaînes VST après (re)démarrage moteur |
| `midiRouting.js`, `controlRouting.js` | injection MIDI et CONTROL dans le graphe |
| `controlBindings.js` | mappages MiniLab → paramètres VST3, Learn |
| `controlBindingsPanel.js`, `controlBindingActions.js` | `renderControlBindings()`, and what a click in it does |
| `bindingsBarHost.js`, `controlValues.js` | each bindings bar drawn from here; where a bound knob stands |
| `commandBus.js` | commands a plugin sends over CTRL OUT: sources, publication, dispatch, holds |
| `commandRegistry.js` | command descriptors, their checks, value decoding |
| `nodeCommands.js`, `sequencerCommands.js` | what the Arpeggiator, Mixer, Morpher, VST and Sequencer accept |
| `vstChain.js` | rôles VST et modèle de chaîne interne |
| `vstParameterDiscovery.js` | découverte des paramètres par nœud |
| `masterOutput.js` | gain master, normalisation |
| `sequencerModel.js`, `sequencerController.js` | séquenceur |
| `arpeggiatorState.js`, `arpeggiatorEditor.js` | arpégiateur |
| `oneRingSequence.js`, `oneRingRandom.js`, `oneRingEdits.js` | One Ring's content, its random draws (bit for bit the engine's) and its edits |
| `oneRingNodes.js`, `oneRingRequests.js`, `oneRingImport.js`, `juceState.js` | One Ring nodes and the engine's runtimes, the agent's requests, the copy from a VST's JUCE state |
| `projectManager.js`, `projectKeys.js` | cycle de vie et périmètre du projet |
| `settingsStore.js` | réglages côté renderer |
| `hardwareConfig.js` | restauration des préférences audio |
| `tempoControl.js` | normalisation du tempo, glissement au clic droit |
| `html.js` | `escapeHtml` |
| `diagnostics.js`, `buildStamp.js` | traçabilité |

### `src/renderer/js/modules/` — les modules

`home/` (accueil projet), `minilab/` (panneau contrôleur), `routing/` (Patch Bay),
`audioOutput/` (sortie audio système), `sequencer/` (arrangement), `oneRing/`
(One Ring's page, §10).

### `src/renderer/js/ui/` et `midi/`

`sidebar.js`, `header.js`, `settingsModal.js`, `icons.js`,
`miniLabControlSurface.js`, `surfaceLayout.js` (split out so the bindings bar's
page loads no profile), `omniPearl.js`, `contextMenu.js` — et côté MIDI
`midiManager.js`,
`parseMidi.js`, `controllerProfile.js`, `portRoles.js`, `decodeControl.js`,
`minilab.js`, `minilabControls.js`, plus `profiles/` (one JSON file per
controller).

Four of those are one artefact, not four files: `parseMidi.js` (bytes to
message), `controllerProfile.js` (the schema and its validator), `portRoles.js`
(which port may speak) and `decodeControl.js` (message to control). They import
each other and nothing else, and the site Builder runs a byte-for-byte copy of
the set — specification §3.5. `test/conformance/midi-corpus.json` is the only
proof the two copies still agree, which is why it is frozen: regenerating it to
make it pass destroys the thing it is for. `minilabControls.js` sits outside the
set on purpose, because it is where the profile's answer acquires MiniHub's
names (`minilab-3:k1`, node `minilab-3`, port `control-k1`) and those are
persisted in projects.

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
| `control_source.h` | the interfaces a plugin that commands MiniHub exposes, and the one that takes an agent's requests — an ABI shared with binaries built elsewhere |
| `vst3_audio_buffer_bridge.{h,cpp}` | pont de tampons VST3 |
| `vst3_scanner.{h,cpp}`, `scanner_main.cpp` | scan VST3 en processus séparé |
| `midi_network.{h,cpp}` | arpégiateurs, destinations |
| `scales.h` | the scales, one table for the arpeggiator and One Ring |
| `one_ring/` | One Ring: the core ported from the VST (`scheduler`, `model`, `generative`, `commands`), `state_json`, `runtime`, and part two's `capture`, `material`, `voices`, `take` |
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
12. **Le catalogue VST ne perd jamais un plugin tout seul.** Seul un scan
    explicitement demandé par l'utilisateur peut en retirer (`_acceptsCatalog`).
    Un second chemin vers le même plugin n'en est pas un (`oneEntryPerPlugin`,
    D-044).

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
