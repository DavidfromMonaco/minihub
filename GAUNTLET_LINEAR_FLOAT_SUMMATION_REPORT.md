# MiniHub — Refonte gain et sommation audio flottante

Date : 24 août 2026  
Statut technique : **PASS**  
Validation auditive humaine avec le projet/VST de l’utilisateur : **encore requise**

Ce rapport remplace l’architecture décrite dans `GAUNTLET_PER_NODE_VST_GAIN_STAGING_REPORT.md`. Le plafond automatique −3 dBFS et tous les limiteurs de sécurité internes de cette passe précédente ont été supprimés.

## 1. Architecture trouvée avant correction

Le chemin actif était :

`VST instrument -> limiteur de sortie VST -> FX (limiteur à l’entrée de chaque FX) -> Mixer/Morpher (limiteur après somme) -> Audio Output (limiteur pré-Master) -> Master Gain -> Meter -> Device`

L’export clonait les chaînes et le graphe, puis possédait encore son propre limiteur `outputSafety` avant son Master.

Le plafond était centralisé à −3 dBFS par `nodeSafetyCeilingDb_` et persisté dans les projets sous `safetyCeilingDb`. Un Master positif abaissait encore le plafond pré-Master pour « réserver » automatiquement du headroom.

Les calculs étaient déjà en `float`, mais chaque limiteur ramenait dynamiquement le signal à son plafond. Le headroom flottant existait donc dans le type, mais était volontairement détruit aux frontières VST, FX, sommation et sortie.

## 2. Emplacement exact des anciens limiteurs

- `PluginInstance::processBlock()` : après chaque instrument et avant chaque effet ;
- `AudioExecutionPlan::process()` : après chaque Mixer et Morpher ;
- `Engine::audioDeviceIOCallbackWithContext()` : entrée Audio Output avant Master ;
- `Engine::ExportContext` : sortie du graphe offline avant Master/export ;
- propagation du plafond : `Engine -> Chain -> PluginInstance`, plans audio live et plans export.

L’implémentation `node_safety_limiter.{h,cpp}` et ses états `limiterGain_`, `releaseCoefficient_`, plafond et compteurs d’intervention ont été supprimés du dépôt et du CMake.

## 3. Cause du pompage cyclique

La cause DSP exacte était le coefficient `limiterGain_` dépendant du niveau : attaque instantanée dès qu’un pic dépassait −3 dBFS, puis récupération exponentielle de 80 ms. Un signal VST dont l’enveloppe ou les modulations repassaient périodiquement au-dessus du plafond réarmait continuellement l’attaque ; les étages successifs pouvaient cumuler cette modulation.

Il n’existait pas de timer interne fixé à une seconde. La période audible voisine d’une seconde venait du rythme de franchissement du plafond par le contenu VST, tandis que l’attaque/release automatique transformait ces franchissements en variations de volume. La preuve corrective est qu’un signal déterministe tenu 20,5 s traverse désormais le package avec une variation de pic de seulement `2,98e-8`, sans aucun état d’enveloppe dans le moteur.

## 4. Cause de l’effondrement de Track 1 avec Track 2

Le limiteur du Mixer calculait son gain sur le pic de la somme complète :

`requiredGain = ceiling / linkedPeak`

Ajouter Track 2 augmentait `linkedPeak`, donc diminuait le coefficient appliqué à toute la somme, y compris la contribution déjà calculée de Track 1. Le limiteur Audio Output pouvait répéter cette réduction. Le niveau de Track 1 dépendait donc directement de Track 2, même si son propre fader n’avait pas bougé.

## 5. Architecture retenue

Chemin live :

`VST/FX float -> Track static gain -> linear float sum -> Master Gain (rampe 20 ms uniquement lors d’un changement) -> Meter/CLIP -> Device`

Chemin export :

`VST/FX clones float -> mêmes gains de graphe -> même somme linéaire -> même Master Gain -> writer`

Règles garanties :

- `juce::AudioBuffer<float>` reste la représentation VST/routing/somme ;
- le Mixer utilise seulement `addFrom(..., inputLevel * masterLevel)` ;
- aucune division par le nombre de pistes ;
- aucun clamp intermédiaire à `[-1, +1]` ;
- aucune AGC, normalisation, compensation de sources ou enveloppe de gain ;
- aucun limiteur Master optionnel n’est conservé : il n’existe donc aucun traitement caché, même désactivé ;
- le Master ne possède que son gain explicite, un meter, le latch CLIP et la substitution `NaN/Inf` à la frontière finale ;
- l’export PCM fixe effectue sa conversion seulement au writer final.

`AudioSignalMeter` remplace l’ancien DSP par une observation strictement passive. Il ne possède aucun pointeur d’écriture, gain, plafond ou release.

## 6. Instrumentation livrée

L’événement `audioPathTelemetry` expose hors callback :

- peak entrée VST/FX ;
- peak sortie VST/FX ;
- peak Mixer/Morpher avant/après observation ;
- `gainCoefficient` statique ;
- `inputGainCoefficients` de chaque piste du Mixer ;
- maximums et échantillons non finis ;
- `automaticGainReduction: false` ;
- `gainReductionCoefficient: 1` et `gainReductionDb: 0`.

`masterMeter` expose en plus : peak pré-gain, coefficient Master, peaks L/R post-gain, dépassements, CLIP et observation Audio Output. La page Audio Output affiche clairement « Linear float sum · no auto gain », le peak pré-Master, le CLIP et la table des coefficients.

## 7. Tests numériques obligatoires

Suite native `--core` : **1 264 contrôles PASS**.

| Test | Résultat |
|---|---|
| A — Unity | entrée 0,4 -> Track/Mixer/Output 0,4 exactement ; observation passive pendant 20 s sans modification |
| B — Deux pistes indépendantes | buffer et coefficient de Track 1 identiques avant/après ajout de Track 2 |
| C — Somme connue | deux sources corrélées 0,4 -> 0,8, soit +6,0206 dB |
| D — Silence | une seconde chaîne VST silencieuse laisse Track 1 exactement à 0,4 |
| E — 1/2/4/8 pistes | sortie = `0,4 * N`, coefficient Track 1 toujours 1,0 ; la somme 8 pistes atteint 3,2 sans réduction |
| Over-range Master | 1,25 à gain 0 dB reste 1,25 et allume CLIP |
| Master positif | 1,25 à +6 dB devient exactement `1,25 * 10^(6/20)` sans réserve automatique |
| Rampe Master | cible tenue après la rampe anti-clic explicite de 20 ms |

## 8. Tests VST

### VST3 déterministe réellement chargé

Suite native `--vst3-e2e` : **48 contrôles PASS**.

- deux instances VST3 réelles, 0 entrée / 32 sorties négociées en 0/2 ;
- Track A = 0,95 et Track B = 0,95 ;
- somme Mixer/Audio Output = 1,90, soit +5,575 dBFS ;
- entrée et sortie Mixer identiques ;
- lecture, arpégiateur, Note Off, Mute et export WAV validés.

### VST tiers Dexed dans le package

Deux instances de `C:\Program Files\Common Files\VST3\Dexed.vst3` ont été chargées dans `dist/MiniHub/MiniHub.exe`.

- note tenue et instance observée pendant 20,5 s : 21 snapshots de frontière, 41 meters audibles avant la décroissance naturelle du preset ;
- maximum Track A avant Track B : `0,1603105068` ; après activation de B : même maximum et coefficient hôte toujours 1,0 ;
- Track B audible : peak `0,1338163316` ;
- coefficients Mixer avant/après activation de B : `[1, 1]` ;
- Master −6 dB : ratio mesuré `0,5011872` ;
- fader/mute : coefficients `[0,5, 0]` ;
- deux pistes mutées : Master exactement silencieux ;
- aucune erreur moteur.

Vital a aussi été chargé, mais son état initial n’a produit aucun signal MIDI exploitable ; il n’est donc pas compté comme preuve audio.

## 9. Validation du package réel

Exécutable : `dist/MiniHub/MiniHub.exe` (`packaged: true`, page sous `resources/app`).

Gauntlet déterministe packagé : **PASS**.

- tenue continue : 20,5 s ;
- peak Master minimum `0,1662499607`, maximum `0,1662499905` ;
- Track A avant/après Track B : sortie `0,9499999881`, coefficient 1,0, GR 1,0 / 0 dB ;
- Mixer avant Track B : `0,1662499905`, coefficients `[0,175, 0,175]` ;
- Mixer après Track B : `0,3324747682`, mêmes coefficients ;
- surcharge volontaire à unity : Mixer entrée/sortie `1,8999999762` (+5,575 dBFS), coefficients `[1, 1]`, aucune réduction ;
- Master explicitement abaissé à −60 dB pendant ce test matériel : pré-gain `1,8999996185`, sortie `0,0018999997` ;
- export WAV réel : 120 000 frames, 48 kHz, stéréo, 720 104 octets, terminé sans erreur.

Artefact : `artifacts/runtime-linear-sum-packaged-20260824/runtime-vst-routing-20260824073933641.wav`.

Build et provenance :

- tests JS/CJS : **538/538 PASS** ;
- moteur source SHA-256 : `d5a5e336881a64b5f3006b2bdcb84d9ee0b693f1309a99edd85901a6d1cd54d6` ;
- moteur packagé SHA-256 : identique ;
- `MiniHub.exe` SHA-256 : `b4245464056214a762dc5bf119a65f8a40206c21f7bea12bc40e1fd8fecfa3b4` ;
- provenance générée : 24 août 2026 à 07:36:05 (heure locale affichée par PowerShell).

## 10. Fichiers modifiés

Moteur/DSP :

- `native/audio-engine/src/audio_signal_meter.{h,cpp}` — nouveau meter passif ;
- `native/audio-engine/src/node_safety_limiter.{h,cpp}` — supprimés ;
- `native/audio-engine/src/plugin_host.{h,cpp}` ;
- `native/audio-engine/src/chain.{h,cpp}` ;
- `native/audio-engine/src/audio_graph.{h,cpp}` ;
- `native/audio-engine/src/engine.{h,cpp}` ;
- `native/audio-engine/src/master_output.h` ;
- `native/audio-engine/CMakeLists.txt`.

Renderer/persistance :

- `src/renderer/js/core/masterOutput.js` ;
- `src/renderer/js/core/engineClient.js` ;
- `src/renderer/js/modules/audioOutput/audioOutputModule.js`.

Tests/gauntlets :

- `native/audio-engine/test/native_tests.cpp` ;
- `test/masterOutput.test.mjs` ;
- `test/nativeRealtimeSafety.test.mjs` ;
- `scripts/runtime-vst-midi-gauntlet.mjs` ;
- `scripts/runtime-commercial-vst-gain-gauntlet.mjs`.

## 11. Régressions et limites

Validé automatiquement : VST unique/multiples, chaîne FX sans protection hôte, Mute, gains Mixer, Master Gain, routing, lecture Séquenceur, monitoring live, export Master cloné, sauvegarde/chargement du Master Gain et migration des anciens plafonds.

Le MiniHub actuel n’expose pas de commande `Solo` dédiée dans le Séquenceur. Le comportement équivalent (muter toutes les autres entrées) est validé, mais aucune fonction absente n’est déclarée testée.

La validation humaine restante est volontairement limitée à l’écoute du projet qui reproduisait le défaut :

1. ouvrir `dist/MiniHub/MiniHub.exe` ;
2. charger le projet et ses presets Analog Lab/VST habituels ;
3. tenir/jouer le passage au moins 20 s ;
4. ajouter les pistes dans l’ordre qui provoquait la chute ;
5. confirmer auditivement l’absence de pompage et la balance voulue ;
6. vérifier le périphérique matériel et le MiniLab réels.

Les mesures automatiques et les deux passages du package démontrent que MiniHub n’applique plus aucune réduction cachée. Elles ne remplacent pas la confirmation perceptive finale sur le matériel, les presets et l’acoustique de l’utilisateur.
