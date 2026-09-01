# MiniHub Engine 2 — Realtime Output Buffer Fix

Date de qualification : 24 août 2026  
Plateforme : Windows, PortAudio/WASAPI shared  
Périphérique runtime : `Casque (High Definition Audio Device)`  
Sample rate runtime : `48000 Hz`

## Statut de livraison

La frontière temps réel `MasterOutput -> Engine 2 -> PortAudio -> WASAPI` a été corrigée, instrumentée, testée sous AddressSanitizer et qualifiée sur le périphérique WASAPI réel. Le binaire est livré pour un test d'écoute utilisateur. Ce document ne prononce pas de validation finale subjective.

## Cause racine exacte

Le défaut était le contrat de buffer à la frontière matérielle, pas le gain Master ni la préférence de taille de buffer.

Le code fautif dans `native/audio-engine/src/engine2/portaudio_device.cpp` ouvrait auparavant la sortie avec :

```cpp
output.sampleFormat = paFloat32 | paNonInterleaved;
```

Le callback interprétait ensuite le `void* output` de PortAudio comme un tableau de pointeurs planaires :

```cpp
auto* outputChannels = static_cast<float* const*>(output);
```

Le dernier maillon n'effectuait donc aucune copie explicite `L/R -> LRLR`. Il déléguait la disposition finale et sa conversion vers WASAPI au mode `paNonInterleaved` de PortAudio. Il n'existait pas non plus un unique effacement vérifiable de `frames réellement reçues × 2 × sizeof(float)` au début du callback.

Un second défaut de contrat existait dans `AudioEngine::processRealtime` : le découpage n'intervenait qu'à la limite globale de `4096`, alors que les scratch buffers et plans DSP étaient préparés à la taille demandée dans les préférences. Si PortAudio fournissait plus de frames que cette préférence, un segment pouvait dépasser la capacité réellement préparée. Cette condition pouvait conduire à un bloc silencieux au niveau du plan ou à une plage invalide dans un scratch buffer. Elle est désormais impossible : les frames réelles restent l'autorité et sont segmentées, si nécessaire, à la capacité DSP préparée.

Ces deux erreurs constituaient le chemin de sortie incorrect identifié : une frontière non-interleaved implicite et une hypothèse incohérente entre taille réelle du callback et capacité préparée.

## Correction appliquée

La sortie PortAudio est maintenant ouverte avec le contrat exact suivant :

- sample format : `paFloat32` ;
- type réel : IEEE-754 `float`, `sizeof(float) == 4` ;
- canaux de sortie : `2` ;
- layout : stéréo interleaved `LRLRLR...` ;
- backend : `WASAPI shared` ;
- sample rate réel lu via `Pa_GetStreamInfo()`.

Le callback effectue maintenant, dans cet ordre :

1. lecture du nombre de frames réellement reçu ;
2. effacement exact du buffer PortAudio avec `frames × 2 × sizeof(float)` ;
3. traitement du graphe dans un staging planar L/R préalloué ;
4. détection de NaN, +Inf et -Inf sans clamp ;
5. copie explicite :

```cpp
output[2 * frame]     = masterLeft[frame];
output[2 * frame + 1] = masterRight[frame];
```

6. capture circulaire préallouée au point exact d'écriture PortAudio ;
7. publication des compteurs et du timing sans I/O disque dans le callback.

Il n'y a ni accumulation dans la destination PortAudio, ni conversion `float -> int16 -> float`, ni copie mémoire `double` vers `float`, ni clamp silencieux. L'entrée audio reste séparément en `paFloat32 | paNonInterleaved` ; ce choix d'entrée n'affecte pas le contrat de sortie corrigé.

## Frames réellement reçues

Qualification runtime sur le stream PortAudio/WASAPI réel :

| Préférence | Frames reçues par callback | Callback ID | AudioGraph ID | Master ID | Écriture PA ID |
|---:|---:|---:|---:|---:|---:|
| 128 | 128 | 1186 | 1186 | 1186 | 1186 |
| 256 | 256 | 2039 | 2039 | 2039 | 2039 |
| 512 | 512 | 2457 | 2457 | 2457 | 2457 |
| 1024 | 1024 | 2661 | 2661 | 2661 | 2661 |

Le snapshot terminal compte `5323` callbacks, `5323` traitements AudioGraph, `5323` traitements Master et `5323` écritures PortAudio. L'invariant un callback / un graphe / un Master / une écriture est donc vérifié sur cette exécution.

Le banc déterministe a aussi utilisé les tailles non préférentielles `63, 128, 193, 257, 511, 1024`. Toutes les frames ont été traitées exactement une fois avec une erreur d'échantillon maximale de `0`.

## Zéro, limites et samples obsolètes

Le test natif place quatre sentinelles autour de chaque destination PortAudio simulée. Pour chaque callback, il vérifie :

- que tous les samples de destination sont remis à zéro avant le traitement ;
- que les sentinelles avant et après la destination restent intactes ;
- qu'une écriture partielle dans le staging laisse toutes les autres frames à zéro ;
- qu'aucun sample du callback précédent ne subsiste ;
- que l'interleaving produit exactement les valeurs planaires attendues.

Résultat Release : `2536 checks`, erreur maximale `0`, aucune sentinelle modifiée.

## AddressSanitizer

Configuration : MSVC `/fsanitize=address`.

- `mlh_realtime_output_tests`, `RelWithDebInfo` ASan : `2536 checks`, exit `0`, aucun diagnostic ASan ;
- moteur `mlh-audio-engine.exe` complet, `Release` avec le flag global ASan : compilation réussie ;
- moteur ASan exécuté quatre secondes sur le périphérique réel puis arrêté par le protocole : exit `0`, aucun diagnostic AddressSanitizer.

La capture Release et la capture ASan sont byte-identiques, SHA-256 :

`28BD73CD1D9B2F6DFF585B6F2169FE6DE8554F6925DB43B7393C9561E1FAAD29`

## Test 440 Hz gauche / 880 Hz droite

Signal : une seconde à `48000 Hz`, amplitude `-18 dBFS` (`0.125893`).

- gauche : composante 440 Hz correcte ; composante 880 Hz `< 1e-7` ;
- droite : composante 880 Hz correcte ; composante 440 Hz `< 1e-7` ;
- erreur sample-by-sample entre Master planar et destination interleaved : `0` ;
- non-finis : `0` ;
- continuité aux frontières de callbacks : erreur `0`, y compris avec tailles variables.

Il n'existe donc ni bloc `LLLL...RRRR...` envoyé à une destination `LRLR...`, ni échange de canaux, ni redémarrage de phase.

## Tests sine -18 dBFS / -6 dBFS

| Signal | Peak Master attendu | Peak copié | Non-finis | Erreur max |
|---|---:|---:|---:|---:|
| sine -18 dBFS | 0.125893 | 0.125893 | 0 | 0 |
| sine -6 dBFS | 0.501187 | 0.501187 | 0 | 0 |

Résultats par taille du banc Release :

| Frames | Callbacks pour 1 s | Temps test max par callback |
|---:|---:|---:|
| 128 | 375 | 0.0321 ms |
| 256 | 188 | 0.0182 ms |
| 512 | 94 | 0.0445 ms |
| 1024 | 47 | 0.0509 ms |

Le test NaN/Inf injecte volontairement un NaN, un +Inf et un -Inf. Les trois catégories sont comptées séparément et les valeurs restent observables dans la destination : aucun clamp ne masque la corruption.

## Capture du point d'écriture PortAudio

La capture circulaire est remplie après l'interleaving, exactement sur les samples destinés à PortAudio. L'écriture WAV est faite après le test, hors callback.

Capture principale :

`artifacts/engine2-realtime-output/portaudio-write-tap-440L-880R-minus18dBFS.wav`

- format WAV tag `3` : IEEE float ;
- 2 canaux ;
- 48000 Hz ;
- 32 bits ;
- block align 8 ;
- 48000 frames ;
- taille 384044 octets.

Capture ASan :

`artifacts/engine2-realtime-output/asan-portaudio-write-tap-440L-880R-minus18dBFS.wav`

Les deux fichiers ont le même SHA-256.

## Xruns et timing WASAPI réel

| Frames | `paOutputUnderflow` delta | `paOutputOverflow` delta | NaN/Inf | Temps callback observé | Deadline théorique |
|---:|---:|---:|---:|---:|---:|
| 128 | 0 | 0 | 0 | 0.0038 ms | 2.6667 ms |
| 256 | 0 | 0 | 0 | 0.0072 ms | 5.3333 ms |
| 512 | 0 | 0 | 0 | 0.0196 ms | 10.6667 ms |
| 1024 | 0 | 0 | 0 | 0.0340 ms | 21.3333 ms |

Maximum du chemin sans plugin pendant cette phase : `0.0776 ms`. Aucun flag `paInputUnderflow`, `paInputOverflow`, `paPrimingOutput` ou autre flag PortAudio n'a été observé.

## Dexed / Vital

Test effectué dans le nouveau `MiniHub.exe`, à `48000 Hz / 256 frames`, sur le stream WASAPI réel :

| Cas | Peak Master observé | Peak au tap PA observé | NaN/Inf | Underflow | Overflow | Callback courant |
|---|---:|---:|---:|---:|---:|---:|
| Dexed | 0.125828 | 0.028683 | 0 | 0 | 0 | 0.0156 ms |
| Vital | 0.355734 | 0.344071 | 0 | 0 | 0 | 0.0866 ms |
| Dexed + Vital | 0.168250 | 0.088751 | 0 | 0 | 0 | 0.1003 ms |

Les peaks Master et tap PA sont pris par des snapshots de callbacks différents ; leur égalité numérique n'est donc pas attendue dans cette télémétrie asynchrone. Le banc déterministe sample-by-sample prouve séparément l'égalité exacte au sein d'un même callback.

Deux dépassements de deadline ont été comptés pendant l'activation à froid de Vital : maximum `29.6036 ms` pour une deadline de `5.3333 ms`. Ils correspondent à deux appels de traitement VST à froid. Ils n'ont produit aucun `paOutputUnderflow` ni `paOutputOverflow`, et le traitement stabilisé de Vital puis Dexed + Vital reste entre `0.0866` et `0.1003 ms`. Cette mesure est conservée explicitement ; elle n'est pas présentée comme un problème de taille de buffer et n'est pas masquée par le correctif de sortie.

Le test automatisé prouve un flux fini, correctement copié et sans xrun déclaré par PortAudio. La confirmation auditive subjective des trois cas reste le but du test utilisateur de ce binaire.

Artefact runtime complet :

`artifacts/engine2-realtime-output/runtime-wasapi-dexed-vital.json`

## Régressions

- tests JavaScript/CJS/MJS complets : `541/541` ;
- test de contrat Engine 2 ciblé : `12/12` ;
- CTest `realtimeOutputBuffer` : `1/1` ;
- test natif de la frontière : `2536 checks` Release et `2536 checks` ASan.

Aucun changement fonctionnel n'a été apporté au Sequencer, au MIDI, aux clips, aux faders, au Mixer, à la PDC, à l'export offline, au scanner VST, au lifecycle VST ou à l'UI générale.

## Fichiers modifiés pour ce chantier

- `native/audio-engine/src/engine2/portaudio_device.h`
- `native/audio-engine/src/engine2/portaudio_device.cpp`
- `native/audio-engine/src/engine2/audio_engine.h`
- `native/audio-engine/src/engine2/audio_engine.cpp`
- `native/audio-engine/src/engine2/realtime_output_buffer.h`
- `native/audio-engine/src/engine.cpp`
- `native/audio-engine/CMakeLists.txt`
- `native/audio-engine/test/realtime_output_tests.cpp`
- `test/nativeRealtimeSafety.test.mjs`
- `scripts/runtime-realtime-output-gauntlet.mjs`
- `ENGINE2_REALTIME_OUTPUT_BUFFER_REPORT.md`

Artefacts ajoutés sous `artifacts/engine2-realtime-output/`.

## Nouveau MiniHub.exe

Chemin :

`C:\Users\666di\Desktop\LM Studio\Minilab Hub\dist\MiniHub\MiniHub.exe`

SHA-256 :

`B4245464056214A762DC5BF119A65F8A40206C21F7BEA12BC40E1FD8FECFA3B4`

Moteur natif embarqué :

`C:\Users\666di\Desktop\LM Studio\Minilab Hub\dist\MiniHub\resources\native\mlh-audio-engine.exe`

SHA-256 :

`23C52BEE1FCCE92F51F007FD4254CF97693E1FA3019D572F245D3604E133FAD4`

REALTIME OUTPUT BUFFER FIX — READY FOR USER TEST
