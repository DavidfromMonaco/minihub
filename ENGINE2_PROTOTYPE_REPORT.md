# MiniHub Engine 2 — Rapport final du prototype

Date d'exécution : 2026-08-24  
Plateforme : Windows NT 10.0.26200 x64, Europe/Paris  
Verdict final : **FAIL**

## 1. Résumé exécutif

Un nouveau moteur autonome a été construit dans `engine2-prototype/`, sans
connexion à MiniHub/Electron et sans réutilisation du code audio MiniHub. Le
prototype utilise PortAudio uniquement pour WASAPI et le SDK Steinberg VST3
directement pour Dexed/Vital.

Les preuves fonctionnelles sont positives : une session WASAPI unique, deux
pistes Dexed+Vital simultanées, MIDI sample-accurate, transport, boucle, somme
linéaire, PDC, export offline sans PortAudio, dix exports déterministes exacts,
comparaison realtime/offline exacte avec la source de contrôle, 100 cycles de
création/destruction et 100 cycles de transport exécutés sans crash. ASan n'a
signalé aucune corruption mémoire.

Le verdict reste néanmoins FAIL. Pendant les 100 cycles Dexed+Vital avec
destruction, le nombre de handles monte exactement de 152 après warm-up à 252,
soit +1 par cycle. Une isolation supplémentaire montre 0 croissance après
warm-up pour deux Dexed sur 20 cycles, mais +20 handles pour deux Vital sur 20
cycles. Le chemin de cycle de vie Vital est donc le déclencheur reproductible.
`PluginInstance` exécute pourtant stopProcessing, deactivate, terminate,
`ExitDll` et `FreeLibrary`. Ce résidu ne peut pas être ignoré sous les critères
imposés.

Conformément à « un PASS partiel est un FAIL », Engine 2 n'est pas candidat au
remplacement du moteur MiniHub et aucune intégration n'a été réalisée.

## 2. Livrables

- `ENGINE2_ARCHITECTURE.md` : frontières, ownership, threading, VST, WASAPI,
  transport, PDC et interface future non implémentée ;
- `ENGINE2_TEST_PLAN.md` : matrice, charges, seuils et codes natifs ;
- `ENGINE2_PROTOTYPE_REPORT.md` : ce rapport ;
- `engine2-prototype/` : sources C++20, CMake, scripts et artifacts ;
- `engine2-prototype/artifacts/validation/validation-summary.json` : résumé
  machine-readable complet.

## 3. Versions exactes

### Dépendances liées

| Composant | Version/révision | Usage |
|---|---|---|
| Steinberg VST3 SDK | `v3.8.1_build_84`, `3cdf9ca5d1f5b1b21e0a86832aa4abe55607bd96` | hosting direct |
| `vst3_base` | `fcf9da0bd27a16f7f03773a3a39822f28f5c8477` | submodule SDK |
| `vst3_cmake` | `054c9143cbb8d47fc4694e473f2ee3b4d951a8f5` | build SDK |
| `vst3_pluginterfaces` | `4f547e8e102b47de4a8b8aaf343c73b700786372` | interfaces VST3 |
| `vst3_public_sdk` | `586dc5e6c8012c3e4b01c79389375cbe96bdb1da` | helpers hosting |
| PortAudio | `v19.7.0`, `147dd722548358763a8b649b3e4b41dfffbcfbb6` | périphérique WASAPI seulement |

Les submodules `doc`, `tutorials` et `vstgui4` ont été récupérés par le checkout
officiel aux révisions respectives `8bfca19d...`, `33b73dfb...` et `5db27225...`,
mais ne sont ni compilés ni liés. `SMTG_ENABLE_VSTGUI_SUPPORT=OFF`, tous les
exemples SDK sont désactivés, et les backends PortAudio ASIO, DirectSound, MME et
WDMKS sont désactivés.

### Toolchain

| Outil | Version |
|---|---|
| CMake | 4.2.3 |
| Visual Studio | Community 2026 18.3.2 |
| MSVC | 19.50.35725 x64 |
| Windows SDK ciblé | 10.0.26100.0 |
| C++ | C++20, `/permissive-`, `/W4` |
| Validation mémoire | MSVC AddressSanitizer + HeapEnableTerminationOnCorruption |

### Plugins testés

| Plugin | File/Product version | SHA-256 |
|---|---|---|
| Dexed | 1.0.0 | `A2ED43F72F3CABB3920EE024495B08F150D4B0B23E1EB7B353E9D585BD5C457D` |
| Vital | 1.0.7 | `6B208AC737FC645C78B30BFCC8720BDFA5A5A2538DFDDDDE61D6327B59B8329F` |

Chemins : `C:\Program Files\Common Files\VST3\Dexed.vst3` et
`C:\Program Files\Common Files\VST3\Vital.vst3`.

## 4. Architecture effectivement réalisée

Le code sépare `PortAudioDevice`, `AudioEngine`, `AudioGraph`, deux `Track`, les
`IProcessor/PluginInstance`, le gain/PDC, puis le master. Le master est une
addition float32 stricte. Le WAV est IEEE float32 afin de ne pas ajouter de
clipping de conversion.

`PortAudioDevice` impose `paWASAPI`, le mode partagé, deux canaux et une seule
session via un owner atomique. La seconde ouverture concurrente a été refusée
dans les deux tests périphérique. Le périphérique obtenu est
`Casque (High Definition Audio Device)`, à 48 000 Hz et 256 samples demandés et
observés.

`AudioEngine` publie un graphe entièrement préparé avec un pointeur atomique et
retient les anciens graphes. Un compteur de lecteurs empêche leur destruction
tant qu'un callback est actif. Aucun smart pointer ne peut donc libérer un VST
sur le thread audio.

Le callback ne contient aucune allocation/destruction hôte, E/S, mutex ou
attente. Il charge le graphe, traite et copie optionnellement dans une capture
préallouée. Les événements VST (`EventList`), bus, pistes, PDC et buffers de
capture sont alloués sur le thread de contrôle.

L'offline appelle directement `AudioGraph::processBlock()` avec un `Transport`
offline. PortAudio n'est ni initialisé ni ouvert. Le monitoring et l'export
partagent donc exactement le graphe, le mixer, le transport MIDI et la PDC.

## 5. Ownership et cycle de vie VST

Chaque piste possède exclusivement son `IProcessor`. `PluginInstance` possède le
module, le provider, le component, le processor, les données de process et les
buffers. La préparation effectue découverte, création, initialize du component
et du controller, connexion, activation des bus, négociation stéréo et
setupProcessing. Le démarrage effectue setActive puis setProcessing.

À la fin :

1. `setProcessing(false)` ;
2. `setActive(false)` ;
3. détachement et destruction de `HostProcessData` ;
4. release de `IAudioProcessor` et `IComponent` ;
5. `PlugProvider` déconnecte component/controller et appelle `terminate` ;
6. le module appelle `ExitDll` puis `FreeLibrary`.

Aucun pointeur VST ne survit à `PluginInstance` et aucune destruction n'a lieu
dans le callback.

## 6. Résultats audio et transport

| Test | Mesure | Résultat |
|---|---|---|
| Session unique | seconde ouverture rejetée | PASS |
| WASAPI | 48 kHz, 256 demandé/observé, 0 erreur callback | PASS |
| Streams après fermeture | 0 | PASS |
| Deux pistes VST | Dexed et Vital non silencieux à chaque cycle | PASS fonctionnel |
| Somme | sample exact `T1 + T2` | PASS |
| Limiteur/normaliseur | aucun dans le chemin | PASS structurel |
| MIDI offset | événement à 17, premier sine non nul à 18 | PASS |
| Boucle intra-callback | `[32,100)`, 90 + 32 -> 54 | PASS |
| Transport contrôle | 100 Play/Stop/Seek/Play/Stop | PASS fonctionnel |
| Transport VST | 100/100 sans unload | PASS fonctionnel |
| PDC | latences `[0,127]`, compensations `[127,0]` | PASS |
| Impulsion PDC | master 0,5 uniquement au sample 127 | PASS |
| Offline VST | 96 000 frames, peak 0,349656, 0 stream | PASS |

Peaks maximaux pendant le stress transport : Dexed `0,442142`, Vital `1,1112`.
La valeur Vital supérieure à 1 est conservée : aucun limiter caché n'a été
ajouté.

## 7. Déterminisme

### Contrôle moteur

Dix exports de 96 000 frames sont strictement identiques sample par sample.
Hash FNV-1a des samples float32 : `15014722203612525651`. Le même résultat est
obtenu en Release et sous ASan.

### Plugins réels séparés

Dexed : 10/10 identiques, hash
`17697649251768774027`, peak `0,0939807`.

Vital : 10/10 identiques, hash `268602637606688071`, peak `0,357177`.

Il n'a donc pas été nécessaire d'attribuer une divergence à une source aléatoire
dans ces versions/presets par défaut.

## 8. Realtime versus offline

### Source déterministe

- longueur realtime/offline : 96 000 frames chacune ;
- égalité : exacte sample par sample ;
- peak : `0,287656` des deux côtés ;
- RMS : `0,112142` des deux côtés ;
- différence d'onset : 0 sample ;
- callbacks : 375 ; erreurs callback : 0.

### Dexed + Vital

- longueur : 96 000 frames des deux côtés ;
- realtime peak/RMS : `0,349656` / `0,106988` ;
- offline peak/RMS : `0,329963` / `0,0919545` ;
- différence d'onset : 1 sample ;
- égalité exacte : non ;
- critères niveau/timing : PASS.

La divergence ne vient pas de deux mixeurs différents : le test déterministe
prouve l'identité du chemin hôte. Elle apparaît avec deux instances fraîches de
plugins et des modes VST déclarés respectivement `kRealtime` et `kOffline`.

## 9. Stress, mémoire et handles

### 100 créations/destructions Release

- cycles tentés/complétés : 100/100 ;
- Dexed sonore : 100/100 ; Vital sonore : 100/100 ;
- crash/deadlock : aucun ;
- private bytes après warm-up : `4 341 760` ;
- private bytes finaux : `75 366 400` ;
- quatre derniers points : `74 436 608`, `74 739 712`, `74 821 632`,
  `75 366 400` — plateau dans la bande de 16 MiB ;
- handles après warm-up : 152 ; finaux : 252 ;
- série handles tous les dix cycles :
  `162,172,182,192,202,212,222,232,242,252`.

Résultat : **FAIL**, croissance déterministe de +1 handle par cycle.

### 100 transports sans unload Release

- cycles : 100/100 ;
- private bytes chargé avant/après : `152 444 928` / `152 444 928` ;
- handles chargé avant/après : `187` / `187` ;
- les dix points mémoire et handles sont strictement plats ;
- après destruction : private bytes `4 419 584`, handles `152` contre 101 au
  démarrage du processus.

Le moteur ne fuit pas pendant les 100 transitions de transport, mais un résidu
initial lié au chargement/déchargement des plugins demeure. Verdict strict de la
suite : **FAIL ressources**, bien que la stabilité transport soit prouvée.

### Isolation du déclencheur

- deux Dexed, 20 cycles après warm-up : handles `148 -> 148`, private bytes
  `3 031 040 -> 3 080 192` ;
- deux Vital, 20 cycles après warm-up : handles `149 -> 169`, soit +20 ;
- transport avec instances conservées : handles plats ;
- la croissance se produit à chaque recréation du chemin Vital.

Conclusion prudente : le problème est isolé à l'interaction de cycle de vie avec
Vital 1.0.7 sur cette machine. Le contrôle Dexed utilisant le même
`PluginInstance`, le même SDK et le même graphe ne reproduit pas la croissance.
Attribuer définitivement le défaut au binaire Vital nécessiterait une trace de
types/stacks de handles externe ; le prototype ne masque donc pas l'échec.

## 10. Protection mémoire

Release et ASan activent la terminaison Windows sur corruption heap. ASan
instrumente le moteur, PortAudio et les helpers VST3 compilés. Résultats :

- core ASan : exit 0, stderr vide ;
- 100 cycles Dexed+Vital ASan : les 100 cycles s'exécutent, stderr vide, aucun
  overflow/use-after-free/invalid free détecté ;
- mémoire ASan après warm-up/fin : `304 136 192` / `466 702 336` private bytes,
  les quatre derniers relevés restent en plateau ;
- handles ASan : `153 -> 253`, confirmant le défaut Release ;
- LeakSanitizer n'est pas disponible dans MSVC Windows, d'où la mesure séparée
  private bytes/handles.

Aucun code `0xC0000374` ou `0xC0000005` n'a été observé.

## 11. Codes de sortie natifs consolidés

| Exécution | Durée | Exit | Interprétation |
|---|---:|---:|---|
| core-release | 349 ms | 0 | PASS |
| vst-load-unload-100 | 22 025 ms | 3 | FAIL handles |
| vst-transport-100 | 741 ms | 4 | FAIL résidu handles après unload |
| vst-determinism | 3 068 ms | 0 | PASS |
| vst-offline | 305 ms | 0 | PASS |
| wasapi-deterministic-compare | 2 087 ms | 0 | PASS |
| wasapi-vst-compare | 2 491 ms | 0 | PASS |
| core-asan | 699 ms | 0 | PASS |
| vst-load-unload-100-asan | 119 011 ms | 3 | aucun défaut ASan, FAIL handles |

Les exits 3 et 4 sont émis volontairement par les assertions strictes de
ressources ; ce ne sont pas des crash codes natifs.

## 12. Matrice des critères PASS

| Critère imposé | État |
|---|---|
| une seule session WASAPI | PASS |
| Dexed + Vital simultanés | PASS |
| deux pistes indépendantes | PASS |
| sommation correcte | PASS |
| MIDI stable/sample-accurate | PASS |
| transport stable 100 cycles | PASS fonctionnel |
| PDC fonctionnelle | PASS |
| export offline sans périphérique | PASS |
| déterminisme PCM exact | PASS |
| aucune corruption mémoire | PASS dans la couverture ASan/heap utilisée |
| aucun crash | PASS |
| aucun deadlock | PASS |
| 100 créations/destructions | 100 exécutées, **FAIL ressources** |
| aucun handle restant/progressif | **FAIL** |

## 13. Verdict et suite

**VERDICT FINAL : FAIL.**

La règle fondamentale a rempli son rôle : le son fonctionne, mais le moteur ne
reste pas propre lorsqu'on répète le cycle de vie Vital. Tant que la croissance
de handles n'est pas expliquée et supprimée ou qu'une version de Vital corrigée
n'est pas qualifiée avec les mêmes 100 cycles, Engine 2 ne satisfait pas les
critères.

Aucun remplacement, branchement Electron, Patch Bay, séquenceur ou sauvegarde
MiniHub n'a été effectué. La prochaine action sûre est une investigation native
des handles Vital (type et stack de création) ou la qualification d'une autre
version de Vital, suivie de la répétition intégrale du plan — jamais une
dérogation au verdict.

