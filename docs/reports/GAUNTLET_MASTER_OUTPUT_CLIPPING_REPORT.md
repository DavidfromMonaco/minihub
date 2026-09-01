# GAUNTLET — Master Output / écrêtage numérique

Date : 23 août 2026  
Projet : MiniHub  
Périmètre : chemin audio natif, sommation multi-VST, sortie physique, export Master WAV, télémétrie et interface Audio Output

## Verdict global

**FAIL — validation finale incomplète au sens strict du gauntlet.**

La cause numérique a été reproduite, localisée et corrigée dans le runtime MiniHub empaqueté. Sous une surcharge réelle de `1.899999976` (`+5.575 dBFS`) produite par deux instances d'un vrai binaire VST3 multi-sorties, la sortie physique et le fichier Master sont désormais limités à `0.891250968` (`-1.000 dBFS`). Le WAV 24 bits exporté contient 48 000 images stéréo finies, atteint exactement `-1.000 dBFS`, et aucune erreur moteur n'a été observée.

Le verdict ne peut cependant pas être **PASS** : le critère demandé est la disparition *audible* des craquements dans une utilisation normale, et l'environnement d'essai ne fournit ni capture loopback fiable ni écoute humaine attestée. En outre, le bandeau du runtime signalait `No MiniLab 3 detected`; la non-régression du contrôleur physique n'a donc pas pu être exercée matériellement. Les preuves numériques et automatisées sont positives, mais elles ne remplacent pas ces deux validations physiques imposées par le cahier des charges.

## Diagnostic et cause racine

### Chemin avant correction

Le chemin effectif était :

`VST3 -> gain d'entrée/Mixer/Morpher -> sommation Audio Output -> buffer float de callback -> enregistreur Master -> conversion périphérique ou PCM`

Les buffers internes en `float` acceptaient correctement des valeurs hors de `[-1, +1]`. En revanche, aucun étage final commun ne protégeait la conversion vers le périphérique ou vers le PCM du WAV. La première zone destructrice était donc la conversion de sortie : les valeurs supérieures à `1.0` lui arrivaient directement et devaient être saturées/quantifiées à cet endroit.

Le défaut n'était pas une mauvaise compensation du nombre de bus VST3. Le host continue à accepter un instrument déclarant 16 bus stéréo, soit 32 sorties, puis négocie uniquement son bus principal vers le contrat stéréo MiniHub. Le problème était la somme parfaitement valide de plusieurs sources individuellement nominales : une addition peut dépasser `0 dBFS` même quand chaque VST reste sous `1.0`.

### Mesure déterministe par étage

Le test natif instrumente le vrai plan `AudioExecutionPlan` et conserve le mix exact pré-Master dans le buffer préalloué du nœud Audio Output.

| Point de mesure | Pic absolu | Niveau | RMS stéréo | Échantillons hors plage |
|---|---:|---:|---:|---:|
| Source équivalente VST, L/R = 0,8/0,4 | 0,800000 | -1,938 dBFS | 0,632456 | 0 |
| Après gain x2 / sommation Mixer | 1,600000 | +4,082 dBFS | 1,264911 | 64 |
| Entrée Audio Output, pré-Master | 1,600000 | +4,082 dBFS | 1,264911 | 64 |
| Buffer de callback pré-Master | 1,600000 | +4,082 dBFS | identique | 64 |
| Après Safety Limiter à -1 dBFS | <= 0,891251 | <= -1,000 dBFS | réduit avec le même gain lié L/R | 0 en sortie |

La première apparition de valeurs hors plage est donc **après le gain/la sommation**, pas dans la source et pas dans la logique VST multi-sorties.

## Correction implémentée

Le chemin final est maintenant unique et explicite :

`Sources/VST -> Mixer/Morpher -> Audio Output final mix -> Master Gain -> Safety Limiter -> Meter -> périphérique + enregistreur Master`

Le clic du métronome est ajouté avant ce Master pendant l'écoute. Il est supprimé pendant l'export hors ligne afin de ne pas être imprimé dans le fichier. Les prises de pistes restent, volontairement, des taps de sources ; seul l'enregistreur Master reçoit exactement le signal post-gain/post-limiteur envoyé au périphérique.

### Master Gain

- plage visible et native : `-60 dB` à `+12 dB` ;
- valeur initiale : `0 dB`, pour préserver le niveau des projets existants ;
- lissage linéaire par échantillon sur 20 ms afin d'éviter les discontinuités de type zipper noise ;
- état stocké dans le projet, pas dans les réglages globaux de l'application ;
- les anciens projets sans champ Master migrent explicitement à `0 dB / -1 dBFS` ;
- les changements sont republiés après redémarrage du moteur, même si la page Audio Output n'est pas montée.

Une atténuation par défaut de `-6 dB` a été considérée mais non imposée : elle aurait modifié silencieusement le rendu de tous les projets existants. Le contrôle est visible et permet à l'utilisateur de créer cette marge quand il le souhaite.

### Safety Limiter

- plafond par défaut : `-1.0 dBFS` ;
- détection de crête et gain de réduction liés en stéréo ;
- attaque instantanée à l'échantillon afin qu'aucun dépassement ne traverse ;
- relâchement exponentiel de 100 ms ;
- pas de lookahead et donc pas de latence ajoutée ;
- réduction multiplicative du signal, sans clamp final dur échantillon par échantillon ;
- signal sous le seuil inchangé à la précision du test ;
- garde contre `NaN` et `Inf` avant le périphérique et l'enregistreur.

L'implémentation n'utilise volontairement pas `juce::dsp::Limiter` : cette classe applique des compresseurs indépendants par canal et termine par une limitation dure à 0 dB, ce qui ne respecte ni le lien stéréo requis ni le plafond commun à -1 dBFS.

### Temps réel

Le callback n'effectue aucune allocation, aucun accès disque/réseau, aucun verrou et aucun appel UI. Tous les buffers appartiennent déjà au plan audio. Les données du meter passent par des atomiques ; un timer du thread message les publie par IPC à 10 Hz. Les mutations du Master demandées pendant un export sont différées avec les autres mutations de la transaction d'export.

## Metering et interface

La page Audio Output contient désormais un bloc compact **Master Output** avec :

- Master Gain et sa valeur en dB ;
- deux bargraphes L/R post-Master avec valeurs en dBFS ;
- badge permanent `Limiter ON · -1.0 dBFS` ;
- témoin rouge `CLIP`, fondé sur le signal pré-limiteur et mémorisé jusqu'au reset ;
- réduction de gain courante ;
- réduction maximale récente, maintenue deux secondes côté interface pour rester lisible après un transitoire.

La télémétrie native contient aussi le pic pré-limiteur courant, le maximum pré-limiteur depuis le reset moteur, le nombre d'échantillons hors plage de la fenêtre, leur total et l'état persistant du témoin CLIP. Les bargraphes représentent réellement le signal post-gain/post-limiteur commun au périphérique et au Master WAV.

Capture du runtime final : `artifacts/master-output-runtime-held.png`.

## Essais de surcharge dans le runtime empaqueté

Le test a lancé `dist/MiniHub/MiniHub.exe` avec le lanceur officiel, et a traversé le preload, le main process et le protocole du moteur natif. Le périphérique actif était `Casque (High Definition Audio Device)`, à 48 kHz avec un bloc matériel annoncé de 480 échantillons.

Deux instances du vrai binaire `MiniHub Deterministic Test Instrument.vst3` ont été chargées. Ce VST3 déclare 16 bus de sortie stéréo/32 canaux ; les deux instances sont passées à l'état `ready`. Elles ont reçu le même accord de huit notes et ont été sommées directement dans Audio Output.

### Charge à Master Gain 0 dB

| Mesure runtime | Résultat |
|---|---:|
| Pic de chaque VST avant somme | 0,950000 (-0,446 dBFS) |
| Pic du mix pré-limiteur | 1,899999976 (+5,575 dBFS) |
| Pic post-limiteur L/R | 0,891250968 (-1,000 dBFS) |
| Réduction maximale | 6,575072 dB |
| Échantillons pré-limiteur hors plage, essai live | 42 858 |
| Témoin CLIP | actif |
| Erreurs moteur | 0 |

L'interface en charge affichait `-1.0 dBFS` sur L et R, une réduction courante de `5.6 dB`, un maximum récent de `6.6 dB` et le témoin CLIP actif.

### Charge ramenée à Master Gain -12 dB

| Mesure runtime | Résultat |
|---|---:|
| Pic pré-limiteur après gain lissé | 0,477258414 (-6,425 dBFS) |
| Pic post-limiteur | 0,477190137 |
| Réduction maximale résiduelle | 0,001243 dB |
| Échantillons hors plage | 0 |
| Témoin CLIP après reset | inactif |
| Erreurs moteur | 0 |

Cette seconde passe confirme que le gain baisse bien le niveau avant le limiteur et que celui-ci devient pratiquement transparent quand la charge reste sous son seuil.

## Export Master WAV

Le même scénario à deux VST a été rendu par `sequencerExport`, donc par le véritable enregistreur Master natif, et non par un générateur de fichier externe.

| Propriété | Résultat |
|---|---:|
| État export | complete |
| Format | PCM signé 24 bits little-endian |
| Canaux | 2 |
| Fréquence | 48 000 Hz |
| Images | 48 000 |
| Durée | 1,000 s |
| Pic pré-limiteur observé pendant export | 1,899999976 (+5,575 dBFS) |
| Pic post-limiteur natif | 0,891250968 (-1,000 dBFS) |
| Réduction maximale | 6,575072 dB |
| Échantillons pré-limiteur hors plage | 66 170 |
| Pic du WAV relu par FFmpeg `astats` | -1,000000 dBFS, L et R |
| RMS du WAV relu | -7,862830 dBFS, L et R |
| Données non finies / erreur moteur | 0 / 0 |

Fichier de preuve : `artifacts/master-overload-runtime.wav`.

## Tests et non-régressions

### Résultats automatiques

- `npm test` : **504/504 réussis** ;
- `mlh_native_tests.exe --core` : **1 235 contrôles réussis** ;
- `mlh_native_tests.exe --vst3-e2e` : **36 contrôles réussis** ;
- build/synchronisation du runtime : réussite, 69 fichiers applicatifs et le moteur natif copiés, provenance régénérée, exécutable re-stampé ;
- arrêt du runtime final : propre, avec `shutdownAck` et code de sortie 0.

Les tests spécifiques couvrent les tailles de bloc `1, 7, 64, 127, 256, 511`, la sommation de deux sources nominales, le plafond à -1 dBFS, le lien stéréo, le reset du clip, la transparence sous seuil, le lissage du gain et les entrées `NaN/Inf`.

### Régressions couvertes

- **VST multi-sorties** : le binaire de test expose réellement 16 bus stéréo/32 sorties ; MiniHub négocie toujours `0 entrée / 2 sorties`, un seul bus de sortie actif. Tous les tests E2E passent.
- **VST UI et cycle de vie** : les suites renderer couvrant ouverture/fermeture, état, remplacement de génération, suppression et ré-ajout passent. Le VST déterministe runtime ne possède volontairement pas d'éditeur, donc l'ouverture d'une UI tierce n'a pas été revalidée manuellement dans cette passe.
- **MIDI et séquenceur** : les tests d'entrée, routage, arpégiateur, notes coincées, transport, édition, suppression/ré-ajout et enregistrement passent. Le contrôleur MiniLab 3 physique était absent du runtime de validation.
- **Mixer / Morpher / Audio Output** : sommation, gains, mutes, routage, persistance et rendu passent ; l'ajout du Master intervient uniquement après le mix final.
- **Sauvegarde/chargement** : le champ `master` est sérialisé, normalisé et restauré ; les projets legacy gardent l'unité. Les tests de remplacement de projet et de round-trip complet passent.
- **Export** : format, durée, silence après Note Off, mutes, volume Mixer, snapshots déterministes, répétition et annulation passent ; l'essai empaqueté surchargé atteint bien -1 dBFS et non 0 dBFS.

## Fichiers modifiés pour cette correction

### Moteur natif

- `native/audio-engine/src/master_output.h`
- `native/audio-engine/src/master_output.cpp`
- `native/audio-engine/src/engine.h`
- `native/audio-engine/src/engine.cpp`
- `native/audio-engine/src/audio_graph.cpp`
- `native/audio-engine/CMakeLists.txt`
- `native/audio-engine/test/native_tests.cpp`

### Main process et renderer

- `src/main/engineCommandPolicy.js`
- `src/renderer/js/app.js`
- `src/renderer/js/core/engineClient.js`
- `src/renderer/js/core/masterOutput.js`
- `src/renderer/js/core/projectManager.js`
- `src/renderer/js/core/settingsStore.js`
- `src/renderer/js/modules/audioOutput/audioOutputModule.js`
- `src/renderer/styles/base.css`

### Tests

- `test/masterOutput.test.mjs`
- `test/nativeRealtimeSafety.test.mjs`
- `test/recorderProtocol.test.cjs`

### Preuves générées

- `artifacts/master-output-runtime-held.png`
- `artifacts/master-overload-runtime.wav`

## Risques résiduels et étapes nécessaires pour obtenir PASS

1. Rejouer le projet utilisateur qui produisait réellement les craquements, avec ses VST et son périphérique habituel, puis confirmer à l'écoute que la disparition est nette à Master Gain 0 dB et que le meter plafonne à -1 dBFS.
2. Répéter avec le MiniLab 3 connecté : notes, contrôles, transport, enregistrement et absence de notes coincées.
3. Ouvrir les éditeurs des VST tiers utilisés dans ce projet pendant une session normale, puis supprimer/ré-ajouter les nœuds et recharger le projet sauvegardé.
4. Si un craquement subsiste alors que le pic post-Master reste sous -1 dBFS, l'origine n'est plus un écrêtage numérique final ; instrumenter alors les underruns WASAPI, le temps de callback et le comportement propre au VST concerné.

En résumé : **la fuite numérique au-delà de 0 dBFS vers le périphérique et le WAV est corrigée et vérifiée dans le runtime empaqueté ; le gauntlet reste FAIL uniquement parce que l'écoute humaine du cas utilisateur et le contrôleur physique requis n'étaient pas disponibles.**
