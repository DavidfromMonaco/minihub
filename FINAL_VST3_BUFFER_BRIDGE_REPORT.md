# MiniHub — rapport final de réécriture du bridge audio VST3

Date de validation : 24 août 2026  
Périmètre : `Engine 2 -> AudioExecutionPlan -> Chain -> PluginInstance -> VST3 ProcessData / AudioBusBuffers`

## Verdict technique

L'ancien adaptateur audio VST3 a été retiré du chemin de production et remplacé par un bridge `float32 planar` possédé par chaque instance. Le nombre réel de frames du callback est maintenant transmis explicitement, sans être déduit de la capacité du buffer de graphe. Le binaire livré contient ce chemin unique et a passé les validations déterministes, Dexed/Vital, multi-instance et AddressSanitizer.

Le verdict sonore final reste volontairement un test humain : les tests automatisés prouvent la cohérence mémoire, temporelle et sample-exacte de la frontière, mais ne remplacent pas l'écoute live sur le périphérique de l'utilisateur.

## Sauvegardes

- sauvegarde créée avant toute modification : `C:\Users\666di\Desktop\LM Studio\Minilab Hub.pre-vst3-buffer-rewrite.old` ;
- sauvegarde historique vérifiée et laissée intacte : `C:\Users\666di\Desktop\LM Studio\Minilab Hub.old`.

La sauvegarde pré-réécriture contient 40 205 fichiers pour environ 9,986 Go. La copie `robocopy` s'est achevée sans erreur.

## Défaut exact trouvé

Le défaut déterminant était une confusion entre **capacité allouée** et **nombre réel de frames du callback**.

1. Chaque `AudioExecutionPlan::Node::output` était alloué à `maxBlockSize`.
2. Lors d'un callback court, `AudioExecutionPlan::process(..., count, ...)` ne préparait et ne consommait correctement que `count` frames.
3. L'ancien appel était néanmoins `Chain::processBlock(n.output, midi, ...)`, sans `count`.
4. `PluginInstance` puis `DirectVst3Plugin` déduisaient `frames` de `audio.getNumSamples()`, donc de la capacité `maxBlockSize`.
5. `ProcessData::numSamples` recevait cette capacité au lieu du nombre réel de frames.

Exemple reproduit : plan alloué à 256 frames, callback réel de 73 frames. L'ancien adaptateur demandait au VST de traiter 256 frames ; le graphe n'en consommait que 73. L'état DSP du plugin avançait donc de 256 frames entre deux callbacks distants de 73 frames. La frontière de bloc suivante reprenait à un état temporel incorrect, avec une portion hors bloc issue de données inutiles ou anciennes. Cela produit des discontinuités et une distorsion audible sans imposer un dépassement de 0 dBFS.

Le premier point de corruption était donc le passage `AudioExecutionPlan -> Chain -> PluginInstance -> ProcessData::numSamples`, avant le Mixer et avant le MasterOutput.

## Architecture ancienne

- `Steinberg::Vst::HostProcessData` gérait les descripteurs génériques.
- Un `std::vector<std::vector<float>> scratchChannels_` regroupait les canaux de tous les bus.
- `bindBuffers(audio)` réaffectait les pointeurs à chaque bloc.
- Le bus de sortie d'index 0 était supposé principal.
- Les sorties du bus 0 pouvaient pointer directement vers le buffer JUCE, donc le host supposait implicitement un mode proche de l'in-place.
- Les autres sorties utilisaient le scratch.
- Les entrées étaient copiées comme si toute instance recevait un flux d'effet.
- `silenceFlags` était remis uniformément à zéro au lieu d'être recalculé d'après les samples.
- `canProcessSampleSize(kSample32)` n'était pas vérifié explicitement.
- Surtout, `numSamples` était tiré de `AudioBuffer::getNumSamples()` et non du callback réel.

## Architecture réécrite

`Vst3AudioBufferBridge` est désormais une propriété exclusive de chaque `DirectVst3Plugin`.

Pour chaque direction et chaque bus, il possède :

- un `BusStorage` propre ;
- un `AudioBusBuffers` propre ;
- un tableau stable `channelBuffers32` ;
- un `unique_ptr<Sample32[]>` séparé pour chaque canal ;
- une durée de vie couvrant toute la période `prepare() -> reset()`.

Les vecteurs propriétaires atteignent leur taille finale avant la construction des descripteurs SDK. Aucun redimensionnement ultérieur ne peut invalider un pointeur. Les buffers d'entrée et de sortie sont toujours distincts. Deux instances ne partagent aucune zone de processing.

Le chemin d'un bloc est maintenant :

1. `AudioExecutionPlan` crée un identifiant 64 bits unique de callback et transmet `count`.
2. `Chain::processBlock` reçoit explicitement `numSamples` et `blockId`.
3. `PluginInstance::processBlock` conserve ces deux valeurs.
4. Le bridge copie ou met à zéro exactement `numSamples` éléments par canal.
5. `ProcessData::numSamples = numSamples` juste avant un unique `IAudioProcessor::process()`.
6. Le bus principal est recopié une seule fois dans le buffer Engine 2, sur exactement `numSamples` frames.

Il n'existe plus de `HostProcessData`, `bindBuffers` ou `scratchChannels_` dans l'hôte de production.

## Format DSP et ProcessSetup

- format interne du bridge : `Steinberg::Vst::Sample32`, donc `float32` ;
- disposition : planar, `channelBuffers32[0] = Left`, `channelBuffers32[1] = Right` ;
- aucun flux `LRLRLRLR` n'est fourni à un VST ;
- entrées et sorties : allocations disjointes, aucun alias L/R ou input/output ;
- `canProcessSampleSize(kSample32)` : vérifié explicitement avant `setupProcessing` ;
- `symbolicSampleSize = kSample32` ;
- `sampleRate` : valeur réelle Engine 2 ;
- `maxSamplesPerBlock` : capacité préparée de l'instance ;
- `numSamples` : nombre réel de frames du bloc courant ;
- mode : `kRealtime` en live, `kOffline` pour un clone d'export.

PortAudio demeure interleaved uniquement à la sortie finale du moteur. Aucun code PortAudio/WASAPI, taille de buffer, gain, Mixer, Master, limiteur ou normaliseur n'a été modifié pour masquer le problème.

## Bus, instruments, effets et silenceFlags

La négociation recherche le vrai bus `kMain` au lieu d'imposer l'index 0. Seul le bus principal nécessaire au graphe est activé ; les auxiliaires sont désactivés et reçoivent des arrangements vides. Chaque bus exposé conserve néanmoins son descripteur et son stockage distinct conformément au contrat `ProcessData`.

- instrument : aucune copie du flux audio Engine 2 dans les entrées ; une instance sans entrée expose `numInputs = 0` ;
- effet : copie du buffer Engine 2 dans les plans d'entrée du bus principal, traitement, puis copie du bus principal de sortie ;
- avant chaque `process()`, chaque canal de sortie est mis à zéro sur exactement `numSamples * sizeof(float)` ;
- les `silenceFlags` d'entrée sont recalculés canal par canal ;
- les `silenceFlags` de sortie sont réinitialisés pour le nouvel appel, sans réutiliser l'état du bloc précédent.

Comptages observés :

| Plugin de validation | Bus entrée/sortie exposés | Canaux main entrée/sortie | Frames du test | Appels/bloc |
|---|---:|---:|---:|---:|
| Instrument déterministe multi-out | 0 / 16 | 0 / 2 | 73 | 1 |
| Effet déterministe stéréo | 1 / 1 | 2 / 2 | 91 | 1 |
| Dexed | 0 / 1 | 0 / 2 | 480 | 1 |
| Vital | 0 / 1 | 0 / 2 | 480 | 1 |

L'instrument déterministe expose 16 bus stéréo, mais MiniHub n'active et ne lit que son vrai bus principal. Aucun bus auxiliaire ne pointe vers le même couple stéréo.

## Traces d'adresses multi-VST

Les adresses sont propres à chaque exécution et sont rapportées ici comme preuve de la disposition observée, pas comme valeurs persistantes.

Exécution Release simultanée Dexed + Vital :

| Instance | input L/R | output L | output R | Frames | Appels/bloc |
|---|---|---:|---:|---:|---:|
| Dexed | `0 / 0` | `0x147daf1cba0` | `0x147daf19e40` | 480 | 1 |
| Vital | `0 / 0` | `0x147daf1d330` | `0x147daf1bc80` | 480 | 1 |

Les entrées nulles sont attendues : Dexed et Vital sont des instruments sans bus audio d'entrée. Leurs quatre adresses de sortie sont non nulles et mutuellement distinctes.

Exécution ASan simultanée Dexed + Vital :

- Dexed output L/R : `0x12a9917a6080 / 0x12a9917a5880` ;
- Vital output L/R : `0x12a991832880 / 0x12a9917a0880` ;
- `numSamples = 480` pour les deux ;
- `processCallInBlock = 1` pour les deux.

Contrôle FX stéréo ASan :

- input L/R : `0x12ee57eaeb80 / 0x12ee57eaf080` ;
- output L/R : `0x12ee57eaf580 / 0x12ee57eafa80` ;
- aucune adresse d'entrée n'est égale à une adresse de sortie.

## Une exécution et une contribution par bloc

Chaque callback reçoit un token composé d'une identité de plan et d'un compteur de callback. Ce token est identique pour tous les nœuds VST du même passage et ne collisionne pas avec le premier bloc d'un plan nouvellement publié. Chaque instance mémorise :

- `blockId` ;
- `plugin/instanceId` ;
- `numSamples` ;
- adresses input/output ;
- numéro d'appel dans ce bloc.

Tous les tests ont observé `processCallInBlock = 1`. Le bridge effectue une seule copie du bus principal vers `PluginInstance`. `Chain` consomme ce résultat une seule fois et le Mixer additionne chaque nœud une seule fois.

## Comparaison sample par sample et forme d'onde

Le test fondamental contourne Mixer, MasterOutput, PortAudio et Sequencer : MIDI manuel -> `PluginInstance` -> bridge planar -> capture.

Les contrôles couvrent :

- deux instances instrument indépendantes, l'une préparée à 256 frames et l'autre à 73 ;
- deux callbacks consécutifs de 73 frames identiques bit pour bit entre les deux préparations ;
- continuité de phase au deuxième bloc ;
- sentinelles au-delà de la frame 73 laissées intactes ;
- effet stéréo 91 frames avec entrées L/R différentes et gain attendu exact ;
- absence d'alternance L/R, de sample répété constant, de bloc répété et de moitié obsolète ;
- valeurs finies, sans NaN/Inf ;
- plans gauche/droite distincts ;
- `VST/Chain -> Mixer unity -> Audio Output -> buffer matériel` identique bit pour bit ;
- `MasterOutput` à l'unité identique bit pour bit.

Après correction, aucune première divergence n'est observée entre les étapes A à E. Avant correction, la première divergence était temporelle dès `ProcessData::numSamples` : le VST avançait sur la capacité maximale tandis que l'étape suivante ne consommait que le callback réel.

## AddressSanitizer

Configuration effective : MSVC x64, `Release`, option globale `/fsanitize=address`, runtime `clang_rt.asan_dynamic-x86_64.dll`, `ASAN_OPTIONS=halt_on_error=1:abort_on_error=1:detect_leaks=0`.

Résultats :

- frontière déterministe instrument + FX + callbacks variables : 83 contrôles, code 0 ;
- Dexed seul : capture directe audible et finie, code 0 ;
- Vital seul : capture directe audible et finie, code 0 ;
- Dexed + Vital simultanés : isolation et sorties distinctes, code 0 ;
- matrice additionnelle Dexed/Dexed et Vital/Vital : code 0 ;
- aucune lecture/écriture hors limites, use-after-free ou adresse invalide signalée.

Les DLL commerciales elles-mêmes restent naturellement les binaires fournis par leurs éditeurs ; l'hôte, le SDK de hosting, `PluginInstance`, `Chain` et le nouveau bridge ont été instrumentés.

## Suites de régression

- tests natifs cœur : 1 307 contrôles réussis ;
- VST3 end-to-end Release : 83 contrôles réussis ;
- isolation commerciale Release, incluant Dexed/Vital : 60 contrôles réussis ;
- VST3 end-to-end ASan : 83 contrôles réussis ;
- isolation commerciale ASan : 60 contrôles réussis ;
- tests JavaScript/Electron : 541/541 réussis ;
- paquet réel `MiniHub.exe` : Dexed et Vital chargés/retirés trois fois chacun, éditeurs natifs ouverts/fermés, verdict `PASS`, aucune erreur Engine 2.

## Fichiers modifiés pour ce chantier

- `native/audio-engine/src/vst3_audio_buffer_bridge.h` — nouveau ;
- `native/audio-engine/src/vst3_audio_buffer_bridge.cpp` — nouveau ;
- `native/audio-engine/src/plugin_host.h` ;
- `native/audio-engine/src/plugin_host.cpp` ;
- `native/audio-engine/src/chain.h` ;
- `native/audio-engine/src/chain.cpp` ;
- `native/audio-engine/src/audio_graph.h` ;
- `native/audio-engine/src/audio_graph.cpp` ;
- `native/audio-engine/src/engine.cpp` — adaptation de l'appel de cleanup offline au nouveau contrat explicite ;
- `native/audio-engine/CMakeLists.txt` ;
- `native/audio-engine/test/native_tests.cpp` ;
- `test/nativeRealtimeSafety.test.mjs` — garde-fou statique adapté à la nouvelle signature ;
- `FINAL_VST3_BUFFER_BRIDGE_REPORT.md` — présent rapport.

## Build livré

Exécutable utilisateur :

`C:\Users\666di\Desktop\LM Studio\Minilab Hub\dist\MiniHub\MiniHub.exe`

- taille : 225 580 032 octets ;
- SHA-256 : `B4245464056214A762DC5BF119A65F8A40206C21F7BEA12BC40E1FD8FECFA3B4`.

Moteur natif réellement embarqué :

`C:\Users\666di\Desktop\LM Studio\Minilab Hub\dist\MiniHub\resources\native\mlh-audio-engine.exe`

- taille : 5 831 168 octets ;
- SHA-256 : `EA6823AA418D7C000347DCDD34B31B306D5450E66A372856D4543A1127AB5E6E` ;
- hash identique au binaire Release autoritaire `native/audio-engine/build/Release/mlh-audio-engine.exe`.

Le manifeste `dist/MiniHub/resources/app/runtime-provenance.json` référence ces mêmes empreintes et une synchronisation au `2026-08-24T21:10:49.979Z`.

## Test humain demandé

1. Lancer le nouveau `dist/MiniHub/MiniHub.exe`.
2. Charger Dexed puis Vital, séparément et ensemble.
3. Jouer au clavier en live à un niveau nettement inférieur à 0 dBFS.
4. Vérifier à l'écoute l'absence de forte distorsion, de bloc répété et de discontinuité.

Si ce build clippe encore pendant ce test humain, ne pas relancer une campagne de correctifs moteur : conserver les deux sauvegardes et créer uniquement `MINIHUB_AUDIO_POSTMORTEM.md` conformément à la décision de projet.

FINAL VST3 BUFFER REWRITE — READY FOR USER TEST
