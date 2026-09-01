# MiniHub — Craquements audio : cause racine et correctifs

Date : 31 août 2026
Plateforme : Windows 11, PortAudio/WASAPI shared
Périphérique de sortie : `Casque (High Definition Audio Device)` — codec carte mère
Sample rate runtime : `48000 Hz` — bloc `256`

Statut : **corrigé, confirmé à l'écoute par l'utilisateur.**

---

## 1. Symptôme et point de départ

Craquements audibles en jeu. `ENGINE2_REALTIME_OUTPUT_BUFFER_REPORT.md` avait pourtant
qualifié la frontière de sortie « PASS » : interleaving, effacement, non-finis et continuité
aux frontières de callbacks étaient prouvés exacts échantillon par échantillon. Les deux
constats étaient compatibles, pour la raison développée en §3.

La piste de l'écrêtage (suppression du Safety Limiter par
`GAUNTLET_LINEAR_FLOAT_SUMMATION_REPORT.md`) a été écartée par un test utilisateur : baisser
les gains ne changeait rien.

---

## 2. Cause racine : un stream duplex agrégeant deux horloges indépendantes

`native/audio-engine/src/engine2/portaudio_device.cpp` ouvrait **inconditionnellement** le
périphérique de capture par défaut dans le même stream PortAudio que la sortie :

    const PaDeviceIndex inputIndex = host->defaultInputDevice;

Sur la machine de qualification, les endpoints actifs sont :

| Direction | Endpoint | Périphérique |
|---|---|---|
| Sortie | `Casque` | **High Definition Audio Device** (onboard) |
| Entrée | `Microphone` | **Realtek USB2.0 Audio** (USB) |

Un unique stream agrégeait donc un codec interne et un codec USB, soit **deux quartz
indépendants**. La documentation PortAudio est explicite : sans horloge partagée, la
synchronisation duplex est instable, et le duplex inter-périphériques sous WASAPI n'est pas
un cas supporté. La dérive se rattrape par des sauts d'échantillons périodiques — des
craquements réguliers, indépendants du niveau, ce qui explique l'échec du test de gain.

L'entrée n'était utilisée par personne : aucun nœud `audio-input` n'existait dans le graphe.

### Correctif

`open()` prend un paramètre `enableInput`. `Engine` ne le passe à `true` que si le graphe
publié contient réellement un nœud `audio-input` (`cmdSyncAudioGraph`), et le remet à `false`
dans `clearAudioGraph()`. `applyAudioInputRequirement()` rouvre le stream **uniquement** sur
ce changement de topologie, jamais sur un changement de valeur.

Trace runtime après correctif :

    [engine2] device="Casque (High Definition Audio Device)" backend="WASAPI shared"
              sampleRate=48000 bufferSize=256 suggestedLatencyMs=11.61
              inputRequested=0 inputActive=0 inputDevice=""

---

## 3. Pourquoi l'instrumentation disait PASS

Deux chemins temps réel répondent à une contention par du **silence** :

- `Chain::processBlock` — `SpinLock::ScopedTryLockType` échoue, la fonction retourne ;
- `PluginInstance::processBlock` — `beginRealtimeRead()` échoue, le plugin ne produit rien.

Les deux sont des choix délibérés et corrects du point de vue de la sûreté mémoire. Mais un
bloc ainsi abandonné arrive au périphérique en **zéros propres et à l'heure** : le callback
respecte sa deadline, ne produit aucun non-fini, et PortAudio ne signale aucun underflow.

Aucun compteur n'existait pour ces deux `return`. Le mode de panne le plus probable était
donc **structurellement invisible** à toute la télémétrie, ce qui rendait un verdict « PASS »
parfaitement compatible avec des craquements audibles.

### Correctif

`native/audio-engine/src/realtime_drops.h` expose deux compteurs process-wide, incrémentés
aux deux `return` et publiés dans `audioRuntimeTelemetry` : `chainBlocksSkipped`,
`pluginBlocksSkipped`, leurs deltas par fenêtre, et `silentBlockDropouts`.

Mesure après correctifs, sur session de jeu réelle : **0 sur les deux compteurs.**

---

## 4. Autres défauts corrigés dans la même passe

### 4.1 getState() coupait le son

`PluginInstance::getState()` prend `beginControlMutation()`, ce qui exclut le plugin du thread
audio pendant toute la sérialisation (des dizaines de ms sur un synthé à wavetables). Il était
appelé automatiquement à 10 Hz par `capturePluginStates(false)`, armé par tout changement de
paramètre — donc par un simple mouvement de potentiomètre du MiniLab.

La capture est désormais conditionnée à la quiescence : transport arrêté **et** pic pré-gain
sous `-80 dBFS` pendant 3 ticks consécutifs. La sauvegarde d'état pour reprise après crash est
conservée ; elle ne peut plus tomber au milieu d'un son.

### 4.2 Un geste de fader recompilait le graphe par mouvement de souris

Un `<input type="range">` émet un événement `input` par pixel de glissement. Chaque événement
déclenchait une écriture disque synchrone **et** un `syncAudioGraph`, donc une recompilation
complète du plan — mesurée à **37 par seconde** dans le log runtime. Chaque recompilation
reconstruit tous les `SourceDelay` et **remet à zéro les lignes à retard de PDC** en plein flux.

Correctif en deux temps :

1. `nodeInstances.js` coalesce les contrôles continus sur 120 ms, le `change` de fin de geste
   flushant immédiatement ;
2. la topologie et les valeurs sont désormais **séparées**. `NodeValues` (atomiques, allocation
   distincte, `audio_graph.h`) porte niveaux, mutes, master level et pas du Morpher. La
   nouvelle commande `setAudioNodeValues` les applique **en place sur le plan publié**, pendant
   que le thread audio le lit. `stepCount` reste structurel.

Une mise à jour dont la topologie n'est pas reconnue est refusée **en entier**
(`audio-values-stale`) plutôt qu'appliquée partiellement ; le renderer répond par un
`syncAudioGraph` complet.

`activeAudioSpec_` est mis à jour en même temps que le plan, sinon
`republishActiveAudioGraph()` réverterait les valeurs.

### 4.3 Le compteur estimatedSchedulingUnderruns criait au loup

Le compteur comparait l'écart entre départs de callbacks à `1,5 x` la deadline d'un bloc. Or
PortAudio/WASAPI shared sert plusieurs blocs utilisateur par période hôte : les callbacks
arrivent en rafale, puis une pause d'une période hôte. À 256 frames / 48 kHz cela déclarait
**43 % des callbacks en retard** sur un stream que PortAudio lui-même déclarait sans underflow
(2100 sur 5323, puis environ 80 par seconde).

Le seuil est désormais la profondeur réellement tamponnée par le périphérique
(`Pa_GetStreamInfo()->outputLatency`), seul niveau auquel un écart peut affamer la sortie.
`paOutputUnderflow` reste le signal autoritaire.

### 4.4 Log de démarrage de 18,6 Mo écrit en synchrone

`diagnostics.log()` faisait un `mkdirSync` **par ligne** puis un `appendFileSync`, sans
rotation, dans le processus qui relaie aussi le MIDI live. Chaque événement moteur y passait,
`masterMeter` à 10 Hz compris : 209 916 lignes, dont 82 % de télémétrie périodique.

- rotation à 4 Mo avec une sauvegarde, création de répertoire mise en cache ;
- `engineEventTrace.js` : la télémétrie périodique n'est plus écrite ; `audioRuntimeTelemetry`
  ne l'est **que quand la fenêtre rapporte une faute**, en lignes `engine:anomaly`. Les
  compteurs cumulatifs PortAudio sont rapportés par croissance, pas par niveau.

Résultat : fichier vivant à **50 Ko** au lieu de 18,6 Mo.

### 4.5 Chain::copyPlugins() prenait le SpinLock du thread audio

La méthode prenait `lock_` **et allouait son vecteur dedans**, une fois par seconde et par
chaîne pendant la lecture. C'est exactement ce que le commentaire de `find()` proscrit déjà,
pour la raison exacte que le try-lock du callback en pâtit. Les cinq appelants sont tous sur le
thread message ; le verrou est retiré et le contrat documenté sur la déclaration.

### 4.6 Analog Lab V était déclaré incompatible à tort

`configureBuses()` ne proposait qu'un seul agencement — bus principal stéréo, **tous les bus
auxiliaires en `kEmpty`** — et traitait un refus comme fatal. Or `kResultFalse` de
`setBusArrangements` signifie « proposition non acceptée », pas « plugin cassé » : le host doit
interroger `getBusArrangement` et s'adapter.

Une échelle de négociation remplace la proposition unique : bus auxiliaires conservés, puis
alignés sur le principal, puis vidés — en stéréo puis en mono — et enfin **aucun appel**,
acceptant l'agencement par défaut du plugin. Le verrou réel est désormais la validation aval
(sortie principale 1 ou 2 canaux), dont le message d'erreur rapporte la topologie observée.

---

## 5. Mesures de qualification

Sonde headless pilotant `dist/MiniHub/resources/native/mlh-audio-engine.exe` en JSON sur
stdin — le binaire exact livré.

### Chargement Analog Lab V

    [plugin-load] phase=instantiate-control-thread
    [plugin-load] phase=instance-created ok=1
    [plugin-load] phase=prepare
    [plugin-load] phase=ready
    instanceStatus  status:"ready"  error:null

### Mise à jour en place du graphe

| Mesure | Attendu | Observé |
|---|---:|---:|
| `audioGraphSynced` après publication initiale + 2 changements de valeur | 1 | **1** |
| `audioNodeValuesApplied` | 2 | **2** |
| `gainCoefficient` relu en télémétrie live | 0,35 | **0,349999994** |
| `inputGainCoefficients` (0,42 x 0,35) | 0,147 | **0,146999999** |
| Mise à jour de topologie inconnue refusée | oui | **oui** |

### Session de jeu réelle

| Compteur | Valeur |
|---|---:|
| `chainBlocksSkipped` | 0 |
| `pluginBlocksSkipped` | 0 |
| `paOutputUnderflows` | 0 |
| `deadlineMisses` | 0 |
| `portAudioNonFiniteSamples` | 0 |

---

## 6. Régressions

| Suite | Résultat |
|---|---|
| Tests JS/CJS/MJS | **551 / 551** |
| `mlh_native_tests` | **1417 checks**, exit 0 |
| `mlh_realtime_output_tests` | **2535 checks**, exit 0 |

Aucun changement fonctionnel apporté au Sequencer, au MIDI, aux clips, à l'export offline, au
scanner VST3, au lifecycle VST ou à l'UI générale. Le Master reste une sommation flottante
linéaire sans limiteur, conformément à `GAUNTLET_LINEAR_FLOAT_SUMMATION_REPORT.md`.

---

## 7. Fichiers modifiés

Natif :

- `native/audio-engine/src/engine2/portaudio_device.{h,cpp}`
- `native/audio-engine/src/engine2/audio_engine.{h,cpp}`
- `native/audio-engine/src/engine.{h,cpp}`
- `native/audio-engine/src/audio_graph.{h,cpp}`
- `native/audio-engine/src/chain.{h,cpp}`
- `native/audio-engine/src/plugin_host.cpp`
- `native/audio-engine/src/realtime_drops.h` *(nouveau)*
- `native/audio-engine/CMakeLists.txt`
- `native/audio-engine/test/native_tests.cpp`

Electron / renderer :

- `src/main/diagnostics.js`
- `src/main/engineEventTrace.js` *(nouveau)*
- `src/main/engineCommandPolicy.js`
- `src/main/main.js`
- `src/renderer/js/core/engineSync.js`
- `src/renderer/js/core/engineClient.js`
- `src/renderer/js/core/nodeInstances.js`

Tests :

- `test/engineEventTrace.test.cjs` *(nouveau)*
- `test/nativeAudioGraph.test.mjs`

---

## 8. Livrable

`dist/MiniHub/MiniHub.exe`

Moteur natif embarqué — SHA-256 :

`03398BEB0A75C70B081AE04D68F29939D9C526872DB0D2B3062DD38F402480E8`

---

## 9. Reste ouvert

- Le duplex reste possible **à la demande** : ajouter un nœud `audio-input` rouvre le stream
  avec l'entrée, donc avec la dérive d'horloge si les deux périphériques diffèrent. C'est
  désormais un choix explicite de l'utilisateur et non plus le comportement par défaut.
- Aucun limiteur de sécurité n'a été réintroduit ; une somme au-delà de `0 dBFS` est toujours
  écrêtée par PortAudio puis par le mixer WASAPI.
