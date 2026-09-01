# MiniHub Engine 2 — Architecture du prototype

Date de référence : 2026-08-24  
Statut : prototype autonome Windows, non branché à MiniHub

## 1. Périmètre et frontières

Le prototype se trouve entièrement dans `engine2-prototype/`. Il ne lie ni le
moteur audio MiniHub existant, ni Electron, ni Tracktion Engine, ni JUCE. Ses
seules dépendances audio/hébergement sont PortAudio et le SDK VST3 Steinberg
officiel.

La chaîne est :

```text
PortAudio/WASAPI shared
        |
        v
AudioEngine (propriétaire de la session et du Transport)
        |
        v
AudioGraph
  +-- Track 1: MIDI fixe -> PluginInstance -> Gain -> PDC --+
  +-- Track 2: MIDI fixe -> PluginInstance -> Gain -> PDC --+--> somme Master
                                                                  |
                         monitoring -------------------------------+--> périphérique
                         export offline ---------------------------+--> WAV float32
```

PortAudio ne connaît ni les pistes, ni les plugins, ni le mixer. Il choisit et
ouvre exclusivement un périphérique WASAPI, appelle le callback et reçoit un
buffer stéréo entrelacé déjà mixé.

## 2. Ownership

```text
main/test runner
  +-- AudioEngine
  |    +-- Transport
  |    +-- atomic<AudioGraph*> active
  |    +-- vector<unique_ptr<AudioGraph>> owned/retired
  |    +-- capture realtime préallouée (test uniquement)
  +-- PortAudioDevice
       +-- PaStream* unique

AudioGraph
  +-- unique_ptr<Track> x2
       +-- unique_ptr<IProcessor>
       |    +-- PluginInstance ou source déterministe de test
       +-- buffers L/R préalloués
       +-- lignes de délai PDC préallouées

PluginInstance
  +-- shared_ptr<VST3::Hosting::Module>
  +-- IPtr<PlugProvider>
  +-- IPtr<IComponent>
  +-- IPtr<IAudioProcessor>
  +-- HostProcessData et EventList préalloués
  +-- buffers de bus auxiliaires préalloués
```

Les classes possédant une ressource native sont non copiables. `PluginInstance`
libère dans cet ordre : `setProcessing(false)`, `setActive(false)`, buffers de
process, pointeurs processor/component, provider (déconnexion et `terminate` du
component/controller), puis module (`ExitDll`, `FreeLibrary`). Aucun pointeur VST
n'est exposé au graphe.

## 3. Session audio unique

`PortAudioDevice::owner_` est un pointeur atomique global au processus. `open()`
doit réussir un compare/exchange de `nullptr` vers `this`; toute seconde instance
est rejetée avant `Pa_Initialize`. `activeStreams_` compte les streams démarrés et
doit être zéro avant `Pa_StartStream`.

Configuration :

- Host API imposée : `paWASAPI` ;
- périphérique : sortie WASAPI par défaut ;
- mode partagé : aucun flag `paWinWasapiExclusive` ;
- stéréo float32 ;
- préférence : 48 000 Hz, puis sample rate natif si 48 kHz est refusé ;
- préférence : 256 samples ;
- adaptation : un callback supérieur à 4096 samples est découpé en segments
  préalloués de 4096 maximum ;
- trace : nom, sample rate demandé/réel, taille demandée/maximum observé,
  latence de sortie, callbacks, erreurs et nombre de streams actifs.

Le sample rate réellement obtenu est communiqué au `Transport` avant toute
publication/démarrage du graphe.

## 4. Threading et publication du graphe

### Thread de contrôle

Le thread de contrôle effectue exclusivement : découverte/chargement VST,
initialisation, négociation des bus, `setupProcessing`, activation, allocation
des buffers, ouverture/fermeture du périphérique, publication et destruction.

Un nouveau graphe est entièrement préparé et démarré avant publication. La
publication est un store atomique séquentiellement cohérent de son pointeur.
Tous les graphes publiés restent possédés par `AudioEngine`.

### Thread audio PortAudio

Le callback :

1. incrémente un compteur atomique de lecteurs ;
2. charge le pointeur de graphe actif ;
3. appelle `AudioGraph::processBlock()` ;
4. copie éventuellement vers une capture mémoire déjà dimensionnée ;
5. décrémente le compteur de lecteurs.

Le callback n'effectue aucune allocation/destruction hôte, E/S disque,
ouverture/fermeture, attente, mutex, opération UI ou publication de graphe. Les
`EventList`, buffers de pistes, buffers de bus, buffers PDC et capture sont
dimensionnés auparavant. Les implémentations binaires tierces Dexed/Vital restent
hors du contrôle de l'hôte et peuvent, en interne, adopter leurs propres choix
d'allocation.

### Réclamation

`reclaimRetiredGraphs()` ne s'exécute que sur le thread de contrôle et seulement
si le compteur de lecteurs vaut zéro. Un callback qui a incrémenté avant la
publication protège donc l'ancien graphe ; un callback qui incrémente après la
publication ne peut charger que le nouveau. La destruction d'un ancien graphe ne
peut jamais être déclenchée par la libération d'un `shared_ptr` dans le callback.

### Export offline

L'export n'initialise pas PortAudio. Un thread non temps réel possède un
`AudioGraph`, un `Transport` offline et appelle directement le même
`AudioGraph::processBlock()`. Seul le sink change : mémoire/WAV au lieu du
périphérique.

## 5. Transport et MIDI

`Transport` contient sample position, tempo, état playing, boucle et bornes de
boucle. Le PPQ est calculé à partir de la position sample, du tempo et du sample
rate moteur. Les opérations disponibles sont Play, Stop, Go to Start, Seek,
SetTempo et SetLoop.

Une frontière de boucle située au milieu d'un callback force un découpage du
bloc exactement à `loopEnd`, puis la suite est traitée à `loopStart`. Les
événements MIDI sont stockés en positions sample absolues et convertis en offsets
intra-bloc. `PluginInstance` alimente `ProcessContext` avec :

- `projectTimeSamples` et `continousTimeSamples` ;
- `projectTimeMusic` (PPQ) ;
- tempo ;
- playing/stopped ;
- cycle start/end et cycle active.

Aucun timer UI n'existe dans ce prototype.

## 6. Graphe, mixer et PDC

Chaque piste efface ses buffers, collecte au plus 256 événements préalloués,
traite son instrument, applique son gain puis son délai de compensation. Le
master calcule uniquement :

```text
master[n] = track1_after_gain_and_pdc[n] + track2_after_gain_and_pdc[n]
```

Il n'existe aucun limiteur, normaliseur, saturateur ou clamp caché. Le WAV float32
préserve les valeurs du graphe, y compris celles qui sortiraient de `[-1, +1]`.

À la préparation, le graphe lit `IAudioProcessor::getLatencySamples()` pour les
deux pistes. Pour une latence maximale `L`, la piste `i` reçoit un délai
`L - latency(i)`. La capacité PDC est bornée et préallouée à 131 072 samples ; une
latence supérieure fait échouer la préparation au lieu d'allouer en callback.

## 7. Cycle de vie VST3

Le wrapper explicite `PluginInstance` réalise :

```text
Module::create / découverte classe Audio Module Class
  -> factory.createInstance<IComponent>
  -> IPluginBase::initialize(hostContext)
  -> création/initialize IEditController si séparé
  -> connexion IConnectionPoint component <-> controller
  -> activation des bus audio/event
  -> setBusArrangements(stereo)
  -> setupProcessing(realtime|offline, float32, maxBlock, sampleRate)
  -> HostProcessData/EventList préalloués
  -> component.setActive(true)
  -> processor.setProcessing(true)
  -> process(...)
  -> processor.setProcessing(false)
  -> component.setActive(false)
  -> disconnect
  -> terminate controller/component
  -> release des interfaces
  -> ExitDll / FreeLibrary
```

Les modes realtime et offline utilisent deux instances fraîches et le même code
de graphe/mixer.

## 8. Proposition d'interface future — non implémentée

Le verdict actuel étant FAIL, aucune intégration n'est autorisée. Une frontière
future minimale pourrait toutefois exposer uniquement des commandes sérialisées
sur un canal de contrôle et des snapshots immuables :

```text
Engine2Control
  configureDevice(DeviceConfig)
  publishSession(SessionDescription)
  play() / stop() / seek(samples) / setTempo(bpm) / setLoop(...)
  renderOffline(RenderRequest)
  shutdown()

Engine2Events
  deviceTrace
  transportSnapshot
  metersSnapshot
  pluginLoadResult
  renderProgress/result
  fatalDiagnostic
```

Electron/Patch Bay ne recevraient jamais de pointeur audio/VST et n'appelleraient
jamais le callback. Cette proposition n'est ni branchée ni approuvée pour
remplacer le moteur existant.

