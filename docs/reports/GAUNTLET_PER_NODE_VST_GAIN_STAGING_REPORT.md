# Gauntlet — Per-node VST gain staging

Date : 23 août 2026  
Statut : validations automatiques réussies ; validation auditive utilisateur requise  
Verdict final : **non déclaré** tant que l’utilisateur n’a pas confirmé l’absence de craquements avec ses VST et son MiniLab.

## Résultat synthétique

L’ancien Safety Limiter global de fin de Master a été retiré. `MasterOutput` ne contient plus que le Master Gain lissé, la garde `NaN/Inf`, les meters L/R, le peak dBFS et le latch CLIP.

La nouvelle classe DSP commune `NodeSafetyLimiter` est appliquée aux frontières suivantes :

- instrument VST : immédiatement après son `processBlock()` ;
- effet VST : immédiatement avant son `processBlock()` ; sa sortie brute reste mesurée et sera protégée par la prochaine frontière ;
- chaîne interne de plusieurs VST : chaque instance applique la règle correspondant à son rôle ;
- Mixer et Morpher : après leur sommation/crossfade, avant que leur sortie n’alimente une destination ;
- Audio Output : après la somme des branches et du métronome, avant Master Gain ;
- export Master WAV : le writer reçoit exactement le même signal post-protection Audio Output et post-Master Gain que le périphérique.

La protection est stéréo liée, déterministe, sans lookahead, sans allocation, mutex, accès disque ou réseau dans le traitement DSP. Elle neutralise les valeurs non finies et utilise une réduction de gain liée, pas un hard clamp comme algorithme principal.

## Architecture précédente supprimée

Architecture invalidée par l’écoute utilisateur :

`Mix -> Master Gain -> Safety Limiter global -> Meter -> Device / Master WAV`

Architecture actuelle :

`Sources / VST -> protections locales de destination -> Audio Output protection -> Master Gain -> Meter -> Device / Master WAV`

Une recherche finale dans le code actif ne trouve plus `master-output-limiter`, `preLimiterPeak`, `masterOutput_.setCeiling`, `post-limiter` ou le badge `Limiter ON`. Le seul motif restant est l’assertion de test qui interdit explicitement son retour.

## Choix du plafond

Le plafond centralisé par défaut est **−3 dBFS** (`NodeSafetyLimiter::defaultCeilingDb`). Le projet persiste `safetyCeilingDb` et l’ancien `ceilingDb: -1` du limiteur Master n’est volontairement pas réutilisé.

Comparaison pour une source à 0,95 :

| Plafond | Réduction locale de la source | Conséquence |
|---|---:|---|
| −3 dBFS | environ 2,56 dB | headroom local réel, dynamique mieux conservée |
| −6 dBFS | environ 5,55 dB | 3 dB de réduction supplémentaire sur chaque source forte |

Le choix −3 dBFS est cohérent parce que chaque sommation suivante possède sa propre frontière. Deux sources protégées à −3 dBFS peuvent encore sommer à environ +3 dBFS ; la protection du node destination traite alors cette somme avant tout VST suivant. −6 dBFS réduirait inutilement chaque source sans supprimer la nécessité de protéger les sommes de trois branches ou plus.

Un Master Gain positif réserve automatiquement le headroom correspondant à l’entrée Audio Output. Par exemple, avec +6 dB de Master Gain, la frontière Audio Output travaille à −9 dBFS pour conserver un maximum final de −3 dBFS. Un test natif couvre ce cas.

## Reproduction +5,575 dBFS

Le gauntlet VST3 charge deux instances distinctes du vrai binaire `MiniHub Deterministic Test Instrument.vst3`. À pleine vélocité, chaque instance produit un pic brut voisin de 0,95.

| Étape | Mesure / contrainte observée |
|---|---:|
| VST instrument A, sortie brute | > 0,94, cible 0,95 |
| VST instrument B, sortie brute | > 0,94, cible 0,95 |
| Somme brute théorique A + B | 1,90 = +5,575 dBFS |
| Sortie protégée de chaque instrument | ≤ −3 dBFS |
| Entrée brute du Mixer après somme des sorties protégées | > 1,41, environ +3 dBFS |
| Sortie protégée du Mixer | ≤ −3 dBFS |
| Signal transmis à Audio Output dans ce graphe | fini et ≤ −3 dBFS |

Le point important n’est donc pas uniquement le pic final : les deux instruments sont maîtrisés immédiatement après leur génération, puis la somme est maîtrisée à la frontière suivante.

Le test VST3 E2E valide aussi le contrat réel 0 entrée / 32 sorties du plugin de test, négocié par MiniHub en 0 entrée / 2 sorties, ainsi que la lecture, l’arpégiateur, les Note Off et l’export.

## Télémétrie temporaire

Un événement `nodeSafetyTelemetry` est émis hors callback, une fois par seconde, pour les instances VST et nodes de sommation. Il contient :

- peak entrée brut et dBFS ;
- peak sortie VST brut et dBFS ;
- peak protégé ;
- maximums entrée, sortie et global ;
- réduction courante, maximum récent et maximum global ;
- interventions récentes et cumulées ;
- valeurs `NaN/Inf` récentes et cumulées ;
- durée de traitement du VST, maximum récent et maximum global.

Audio Output expose les mêmes informations dans `masterMeter.audioOutputProtection`.

La page Audio Output du runtime empaqueté affiche maintenant une table **Gain staging diagnostics** par node/VST, ainsi que :

- durée du callback et deadline ;
- charge CPU audio estimée ;
- deadline misses ;
- underruns de scheduling estimés.

JUCE ne fournit pas ici de compteur WASAPI xrun natif fiable ; le protocole l’indique avec `nativeWasapiXrunCounterAvailable: false`. Le compteur affiché est donc une estimation fondée sur les gaps de callback, pas une prétention de mesure matérielle exacte.

Sur le runtime empaqueté au repos : callback environ 0,02–0,03 ms pour une deadline de 10,00 ms, 0 deadline miss et 0 underrun estimé. Cela ne remplace pas une mesure sous charge avec les VST de l’utilisateur.

## Master, monitoring et export

La séquence du callback est vérifiée statiquement et nativement :

1. graphe audio ;
2. métronome monitoring éventuel ;
3. `audioOutputSafety_.process()` ;
4. `masterOutput_.process()` — gain et meters uniquement ;
5. `sequencer_.processMaster()` ;
6. périphérique audio.

Il n’existe donc pas de chemin export parallèle conservant l’ancien limiteur. Le Master WAV consomme les mêmes floats que le monitoring après Audio Output protection et Master Gain.

Artefact WAV conservé : `artifacts/per-node-vst-master-export.wav`.

- PCM 24 bits stéréo ;
- 48 000 Hz ;
- 0,500 s ;
- peak mesuré par FFmpeg : −3,751721 dBFS ;
- SHA-256 : `dda61119b6f6f72943d7c1c3dde0b20d8675e7bf5fdc9aafdb7540695e5b56df`.

Ce WAV provient du chemin d’export VST3 E2E à une instance ; la reproduction deux VST à +5,575 dBFS est validée séparément dans le même exécutable de test, avec les niveaux par node indiqués ci-dessus.

## Tests exécutés

| Validation | Résultat |
|---|---:|
| Tests JS/CJS complets | 504 / 504 réussis |
| Tests natifs core | 1 245 contrôles réussis |
| VST3 E2E | 44 contrôles réussis |
| Build Release `mlh_audio_engine` | réussi |
| Master WAV 24-bit / 48 kHz | généré et inspecté |
| Synchronisation runtime | 69 fichiers applicatifs + moteur natif |
| Runtime empaqueté réel | lancé, inspecté par CDP, fermé proprement |

Le moteur source et le moteur empaqueté ont le même SHA-256 :

`4f61f11abcba00a1b766ac8a4157ee24678b07c340907015da6ca27097ab50c3`

Manifest : `dist/MiniHub/resources/app/runtime-provenance.json`.

Capture runtime finale : `artifacts/per-node-gain-staging-runtime-final.png`.

## Régressions couvertes

- transparence mesurable sous le seuil sur un limiteur fraîchement préparé ;
- plafond identique pour les tailles de bloc 1, 7, 64, 127, 256 et 511 ;
- lien stéréo et conservation du ratio L/R ;
- garde `NaN/Inf` ;
- lissage du Master Gain sans zipper discontinuity ;
- réserve de headroom avec Master Gain positif ;
- CLIP Master toujours diagnostique et reset explicite ;
- persistance/migration du Master Gain et du plafond de sécurité ;
- VST multi-sorties, MIDI, arpégiateur, Note Off, mutes et volume Mixer ;
- exactitude format/durée du Master WAV ;
- absence du limiteur global Master dans le chemin temps réel ;
- absence d’allocation, lock et hard clamp principal dans `NodeSafetyLimiter`.

## Fichiers concernés

### DSP et moteur natif

- `native/audio-engine/src/node_safety_limiter.h` — nouveau ;
- `native/audio-engine/src/node_safety_limiter.cpp` — nouveau ;
- `native/audio-engine/src/master_output.h` ;
- `native/audio-engine/src/master_output.cpp` ;
- `native/audio-engine/src/plugin_host.h` ;
- `native/audio-engine/src/plugin_host.cpp` ;
- `native/audio-engine/src/chain.h` ;
- `native/audio-engine/src/chain.cpp` ;
- `native/audio-engine/src/audio_graph.h` ;
- `native/audio-engine/src/audio_graph.cpp` ;
- `native/audio-engine/src/engine.h` ;
- `native/audio-engine/src/engine.cpp` ;
- `native/audio-engine/CMakeLists.txt`.

### Renderer et persistance

- `src/renderer/js/core/masterOutput.js` ;
- `src/renderer/js/core/engineClient.js` ;
- `src/renderer/js/modules/audioOutput/audioOutputModule.js` ;
- `src/renderer/styles/base.css`.

### Tests

- `native/audio-engine/test/deterministic_test_instrument.cpp` ;
- `native/audio-engine/test/native_tests.cpp` ;
- `test/masterOutput.test.mjs` ;
- `test/nativeRealtimeSafety.test.mjs`.

## Risques et validation utilisateur obligatoire

Les contrôles automatiques démontrent la nouvelle architecture et les niveaux, mais ne démontrent pas l’absence audible de craquements avec des VST tiers, un driver et une charge CPU réels.

Validation demandée à l’utilisateur :

1. lancer `dist/MiniHub/MiniHub.exe` ;
2. charger le projet qui produisait les craquements ;
3. ouvrir Audio Output et laisser visible **Gain staging diagnostics** ;
4. jouer le même passage avec les mêmes VST et le MiniLab ;
5. noter le node qui présente une sortie excessive, une réduction, une durée VST élevée, un deadline miss ou un underrun estimé ;
6. confirmer auditivement si les craquements ont disparu.

Si les niveaux restent sains mais qu’un craquement subsiste, la table permettra de distinguer immédiatement un VST lent d’un gap/deadline callback. Il faudra alors corréler l’instant du craquement avec la ligne VST et les compteurs runtime, puis éventuellement ajouter une instrumentation WASAPI native spécifique au backend/périphérique concerné.

**Conclusion : la refonte est prête pour le test humain réel, mais aucun PASS auditif final n’est déclaré.**
