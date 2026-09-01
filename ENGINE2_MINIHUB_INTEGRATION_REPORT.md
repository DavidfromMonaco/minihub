# MiniHub — Rapport d’intégration définitive d’Engine 2

Date : 24 août 2026  
Statut : prêt pour le test manuel utilisateur, pas « FINAL PASS ».

## 1. Résultat

Engine 2 est intégré sous l’interface MiniHub existante et constitue désormais l’unique autorité audio temps réel. La version Release démarre, ouvre un seul flux PortAudio/WASAPI partagé, charge directement des VST3 avec le SDK Steinberg, fait jouer Dexed et Vital simultanément, conserve le Patch Bay et le Sequencer, pilote un transport unique et réalise les exports offline sans PortAudio.

Les contrôles automatisés, natifs et les gauntlets exécutés sur l’application packagée sont réussis. Ils ne remplacent pas une écoute humaine sur le matériel final : la livraison est donc déclarée `READY FOR USER TEST`, jamais `FINAL PASS`.

## 2. Sauvegarde obligatoire

Sauvegarde complète créée avant toute modification de source :

`C:\Users\666di\Desktop\LM Studio\Minilab Hub.old`

Vérifications effectuées avant de commencer l’intégration :

- 4 586 dossiers et 28 477 fichiers copiés ;
- environ 8,662 Go ;
- zéro échec de copie ;
- comparaison récursive chemin relatif + taille : 28 477 fichiers de chaque côté, zéro différence ;
- présence vérifiée de `.git`, `package.json`, `engine2-prototype`, `native/audio-engine`, `dist`, `node_modules` et des ressources de build ;
- aucun build, nettoyage ou changement n’a été effectué dans le dossier `.old`.

La sauvegarde est restée intacte pendant tout le chantier.

## 3. Fichiers MiniHub modifiés

La comparaison avec la sauvegarde prise juste avant le chantier donne exactement 19 fichiers source ajoutés ou modifiés :

- `native/audio-engine/CMakeLists.txt`
- `native/audio-engine/src/audio_graph.cpp`
- `native/audio-engine/src/audio_graph.h`
- `native/audio-engine/src/chain.cpp`
- `native/audio-engine/src/chain.h`
- `native/audio-engine/src/engine.cpp`
- `native/audio-engine/src/engine.h`
- `native/audio-engine/src/engine2/audio_engine.cpp` (ajout)
- `native/audio-engine/src/engine2/audio_engine.h` (ajout)
- `native/audio-engine/src/engine2/portaudio_device.cpp` (ajout)
- `native/audio-engine/src/engine2/portaudio_device.h` (ajout)
- `native/audio-engine/src/main.cpp`
- `native/audio-engine/src/plugin_host.cpp`
- `native/audio-engine/src/plugin_host.h`
- `native/audio-engine/test/native_tests.cpp`
- `scripts/runtime-commercial-vst-gain-gauntlet.mjs`
- `scripts/runtime-engine2-integration-gauntlet.mjs` (ajout)
- `scripts/runtime-vst-lifecycle-gauntlet.mjs` (ajout)
- `test/nativeRealtimeSafety.test.mjs`

Livrable documentaire ajouté séparément : `ENGINE2_MINIHUB_INTEGRATION_REPORT.md` (hors des 19 fichiers source ci-dessus).

Dépendances intégrées localement :

- `native/third_party/portaudio` : arbre PortAudio complet copié depuis le prototype ;
- `native/third_party/vst3sdk` : SDK VST3 Steinberg complet copié depuis le prototype.

Les dossiers de build, le package `dist` et les artefacts de test ont également été régénérés. Ils ne sont pas comptés parmi les 19 changements de source.

## 4. Composants Engine 2 intégrés

- `mlh::engine2::AudioEngine` : propriétaire du périphérique et du transport live ;
- `mlh::engine2::PortAudioDevice` : périphérique WASAPI partagé et callback unique ;
- `AudioExecutionPlan` : graphe audio compilé et publié de façon atomique ;
- `Chain` : chaîne série d’instruments/FX avec latence cumulée ;
- `PluginInstance` : hôte VST3 direct Steinberg ;
- Mixer : niveaux, mute, sommation flottante linéaire et télémétrie ;
- `MasterOutput` : traitement final commun ;
- `Transport` : position échantillon/PPQ, tempo, loop, play, stop et seek ;
- `SequencerEngine` : clips audio/MIDI et rendu selon le transport Engine 2 ;
- PDC : latence de chemin cumulée et alignement préalloué des entrées ;
- renderer offline : snapshot séparé, transport offline et clones de plugins.

Correspondance avec les concepts du prototype : `AudioEngine` est le cœur, `AudioExecutionPlan` est l’AudioGraph, chaque node VST possède une `Chain` jouant le rôle de Track/FX chain, les nodes Mixer effectuent la somme et `MasterOutput` porte la sortie Master.

## 5. Architecture finale et ownership audio

Chemin monitoring :

`MiniHub UI / Patch Bay / Sequencer -> IPC Engine 2 -> AudioExecutionPlan -> Chain / VST3 -> Mixer -> MasterOutput -> PortAudioDevice -> WASAPI shared`

Chemin export :

`Snapshot Sequencer -> AudioExecutionPlan offline / clones VST3 -> Mixer -> MasterOutput -> encodeur fichier`

Invariant implémenté :

`1 AudioEngine -> 1 PortAudioDevice -> 1 flux WASAPI partagé`

Le processus natif live est le seul propriétaire de l’endpoint Windows. Electron, les renderers, le scanner VST et les plugins ne créent aucune sortie audio. Un verrou global refuse la création d’un second propriétaire PortAudio avant même `Pa_Initialize`. Le compteur de flux actifs est journalisé avant l’ouverture puis après le démarrage.

Capture Windows sur le package final :

- périphérique : `Casque (High Definition Audio Device)` ;
- backend : `WASAPI shared` ;
- sample rate : 48 000 Hz ;
- buffer : 256 au premier démarrage, puis préférence persistée à 128 ;
- processus Engine live : 1 ;
- sessions audio de cet Engine : 1 ;
- processus scanner : 0 ;
- sessions audio scanner : 0.

Preuve enregistrée dans `artifacts/engine2-integration/audio-session-final.json`.

## 6. Ancien moteur : remplacé, désactivé, conservé

Remplacé ou désactivé :

- suppression de `AudioDeviceManager` comme propriétaire audio ;
- suppression de l’ancien callback `AudioIODeviceCallback` ;
- suppression de l’hébergement live JUCE `AudioPluginInstance` ;
- retrait de toute autorité transport concurrente ;
- retrait de toute exportation dépendant du périphérique live.

Conservé sans autorité audio :

- l’API IPC historique et les noms de commandes, comme façade de compatibilité pour l’UI ;
- JUCE pour les buffers/structures de données, formats de fichiers, utilitaires de graphe/séquenceur, sortie MIDI physique et scanner existant ;
- le scanner VST3 isolé, qui n’ouvre aucun périphérique ;
- les formats de projet et migrations existants ;
- le dossier `engine2-prototype`, conservé comme référence mais absent du build réel.

JUCE et Tracktion ne sont pas moteurs audio. Tracktion n’est pas utilisé. La dépendance JUCE `audio_devices` subsiste uniquement pour la sortie MIDI physique ; aucun `AudioDeviceManager` n’est construit.

## 7. Patch Bay et publication du graphe

Les connexions audio visibles sont transformées en `AudioGraphSpec` par la commande existante `syncAudioGraph`. La validation des IDs, ports, sources, cycles et nodes est effectuée hors callback. Le tri topologique, les buffers, les délais PDC et les pointeurs de sources sont préparés avant publication.

Le callback lit un plan immutable publié atomiquement. Un compteur de lecteurs protège le plan courant ; les anciens plans ne sont récupérés que lorsqu’aucun lecteur temps réel ne peut encore les référencer. Une modification de chaîne — ajout, retrait, réordre ou bypass — republie également le graphe afin de recalculer la PDC.

Les tests applicatifs couvrent connexion, déconnexion, reconnexion, fan-out, suppression/recréation de node, persistance et rejet des incohérences. Les tests natifs couvrent DAG valide, cycles, ports, input physique, Mixer et Audio Output réel.

## 8. Threading et sécurité temps réel

Le callback PortAudio :

- utilise des buffers et listes d’événements préalloués ;
- ne charge, ne détruit et ne décharge aucun plugin ;
- ne fait ni accès disque, ni IPC bloquant, ni opération UI ;
- ne publie pas de nouveau graphe ;
- ne fait pas d’attente de thread ;
- traite des segments bornés avec une taille maximale préparée de 4 096 échantillons.

Les commandes, scans, compilations de graphe, snapshots et mutations de chaîne sont préparés sur les threads de contrôle/travail. Les transferts MIDI et paramètres vers le processor utilisent des files de capacité fixe. La création du provider/controller VST et les opérations de fenêtre sont exécutées sur le thread natif de contrôle/UI, ce qui évite le deadlock observé lorsque Dexed était créé sur un worker puis attaché depuis un autre thread.

Le retrait d’un plugin suit l’ordre : retrait du plan temps réel, attente de fin des lecteurs, fermeture éditeur, `setProcessing(false)`, `setActive(false)`, libération streams/interfaces/controller/provider, puis module.

## 9. Hébergement VST3 direct

Le chemin live utilise directement le SDK Steinberg :

- `Hosting::Module` et `PlugProvider` ;
- `IComponent`, `IAudioProcessor`, `IEditController` ;
- négociation de bus mono/stéréo, bus auxiliaires désactivés ;
- `setupProcessing`, `setActive`, `setProcessing`, puis `process` ;
- `ProcessContext` alimenté par l’unique transport ;
- événements MIDI à offset échantillon, CC/pitch/aftertouch et `IMidiMapping` ;
- ParamID Steinberg stable et gestion de gestes/paramètres ;
- état composant/controller sérialisé dans l’enveloppe historique `VST3PluginState` pour préserver les projets ;
- `IPlugView` natif attaché à un HWND enfant dédié avec resize et fermeture contrôlés.

Le cas d’un instrument 16 sorties a été corrigé : seule la sortie principale mono/stéréo acceptée est active, les auxiliaires sont négociées `kEmpty`. MiniHub conserve ainsi son contrat principal 0-in/2-out déterministe.

## 10. Transport, Sequencer, Clip Editor et projets

`AudioEngine` possède l’unique `Transport`. La barre globale, le Sequencer, le Clip Editor et les commandes IPC utilisent ce même état pour Play, Stop, Go to Start, Seek, Loop et Tempo. Le callback appelle `beginBlock` puis avance la même horloge en échantillons/PPQ ; aucun séquenceur ne peut continuer lorsque le transport Engine 2 est arrêté.

Le Sequencer et le Clip Editor existants sont conservés. Les clips MIDI sont planifiés avec leur offset exact dans le bloc ; les clips audio sont rendus vers le graphe visible. Les enregistrements audio ne reçoivent que les sources reliées directement au port AUDIO IN visible du Sequencer. Les projets conservent leur schéma existant et les migrations automatiques déjà présentes ; aucun changement manuel de format n’est requis.

Un aller-retour réel d’écriture/lecture de projet a réussi dans `artifacts/engine2-integration/engine2-project-roundtrip-20260824160243999.minihub`.

## 11. Mixer, niveaux et PDC

Le chemin effectif est :

`Sources/Tracks -> VST/FX -> latence cumulée -> délais PDC par entrée -> somme Mixer -> MasterOutput`

La somme est flottante et strictement linéaire. Il n’existe ni limiteur caché, ni normalisation automatique, ni seconde somme Electron. Deux sorties VST corrélées ont reproduit le pic attendu à environ `+5,575 dBFS`, sans réduction automatique.

Chaque `Chain` additionne la latence des plugins actifs non bypassés. La compilation du DAG calcule le maximum de chaque chemin et préalloue un retard circulaire stéréo pour les chemins plus rapides. Une latence supérieure à 131 072 échantillons est refusée. Un test natif explicite valide l’alignement exact à travers une frontière de bloc ainsi que le chemin zéro latence sans copie.

Le monitoring et l’export emploient la même logique `AudioExecutionPlan`, Mixer et Master.

## 12. Export offline

PortAudio n’intervient jamais dans l’export. Le renderer capture un snapshot cohérent de l’arrangement, clone les chaînes VST3 et utilise un transport offline distinct. Le monitoring live peut rester actif ; sa position, son loop et son état Play/Stop sont inchangés à la fin ou après annulation.

Résultats du package final :

- charge légère, 2 Dexed + 2 Valhalla Supermassive, WAV, 115 s, 5 520 000 frames, 33 120 104 octets, RIFF valide, `46,8188x` temps réel ;
- charge moyenne, 6 Dexed + 6 Valhalla Supermassive, OGG, 120 s, 5 760 000 frames, 163 442 octets, OggS valide, `14,0495x` temps réel ;
- `deviceIndependent=true`, `hardwareOutput=false`, aucune erreur Engine ;
- WAV, MP3 et OGG du gauntlet codecs : signatures valides ;
- annulation : fichier partiel supprimé et transport live restauré.

Artefacts principaux :

- `artifacts/engine2-integration/offline-light-2vst-2fx-20260824162116365.wav`
- `artifacts/engine2-integration/offline-medium-6vst-6fx-20260824162116365.ogg`
- `artifacts/runtime-export-packaged-20260824/runtime-export-20260824155922661.wav`
- `artifacts/runtime-export-packaged-20260824/runtime-export-20260824155922661.mp3`
- `artifacts/runtime-export-packaged-20260824/runtime-export-20260824155922661.ogg`

MiniHub expose actuellement l’export Master ; aucun export stems existant n’était disponible à comparer dans cette étape.

## 13. Résultats des tests

### Build et tests de régression

- configuration CMake Release : réussie ;
- build `mlh-audio-engine.exe` : réussi ;
- build `mlh_native_tests.exe` : réussi ;
- tests Node/Electron/UI : 539 tests, 539 réussis, 0 échec ;
- CTest natif : 2 suites sur 2 réussies, 0 échec ;
- test natif VST3 : vrai bundle VST3, scan, chargement direct, MIDI sample-accurate, arpégiateur, deux instances, routing, niveaux et export WAV ;
- test sécurité temps réel : chemin callback Engine 2 et processor direct contrôlés.

### Application packagée réelle

- démarrage du package final : réussi ;
- une seule session WASAPI live : vérifiée avec l’énumérateur de sessions Windows ;
- Dexed seul : réussi ;
- Vital seul : réussi ;
- Dexed + Vital sur deux pistes : réussi ;
- notes simultanées et deux instances : signal fini, non nul, aucune valeur non finie ;
- plusieurs FX : 2+2 puis 6+6 chaînes instrument/Valhalla réussies ;
- erreurs Engine pendant les gauntlets : aucune.

### Lifecycle VST

- Dexed : 3 cycles création/suppression/recréation réussis ; GUI 866×674 ouverte/fermée ; changement de projet réussi ; zéro instance restante ;
- Vital : 3 cycles création/suppression/recréation réussis ; GUI 1400×820 ouverte/fermée ; changement de projet réussi ; zéro instance restante ;
- aucun deadlock après déplacement de la création VST sur le thread de contrôle/UI ;
- aucun crash ni corruption mémoire détecté pendant ces scénarios.

### Transport et projets

Gauntlet réel réussi :

- 100 cycles `Play -> Stop` ;
- 50 cycles `Play -> Go to Start -> Play -> Stop` ;
- 20 cycles `Play -> Export -> Stop -> Play` ;
- 20 WAV avec signature valide ;
- 3 535 événements transport et 20 terminaisons d’export ;
- aucune erreur Engine ;
- round-trip projet sur disque réussi.

Les tests applicatifs couvrent aussi New, Save, Load, remplacement/fermeture de projet, compatibilité des projets, Patch Bay, Sequencer, Clip Editor, fenêtres VST, paramètres, routing MIDI/audio, Play/Stop/tempo et export.

## 14. Vital et problèmes encore connus

Vital 1.0.7 charge, joue, s’ouvre, se ferme, se supprime et se recrée avec le nouvel hôte. Dexed et Vital jouent ensemble dans le package final.

Le diagnostic historique de croissance de handles propre à Vital 1.0.7 reste documenté. Il n’a pas été utilisé pour bloquer l’intégration globale et aucun équivalent n’a été observé avec Dexed. Les cycles de ce chantier se terminent avec zéro instance MiniHub restante, mais une campagne manuelle longue durée avec Vital demeure recommandée pour qualifier le comportement de cette version du plugin sur la machine utilisateur.

Points restant à valider par l’utilisateur :

- écoute réelle, niveau perçu et absence de décrochage sur son périphérique ;
- latence ressentie avec ses réglages de buffer ;
- presets et interfaces de sa collection personnelle de VST3 ;
- endurance prolongée de Vital 1.0.7 ;
- workflow musical complet sur ses projets habituels.

Ce sont des tests utilisateur, pas des défauts bloquants actuellement reproduits. Aucun crash, corruption mémoire, double flux audio ou erreur Engine n’a été détecté par les validations réalisées.

## 15. Build livré

Exécutable à tester :

`C:\Users\666di\Desktop\LM Studio\Minilab Hub\dist\MiniHub\MiniHub.exe`

SHA-256 : `B4245464056214A762DC5BF119A65F8A40206C21F7BEA12BC40E1FD8FECFA3B4`  
Taille : 225 580 032 octets.

Engine natif embarqué :

`C:\Users\666di\Desktop\LM Studio\Minilab Hub\dist\MiniHub\resources\native\mlh-audio-engine.exe`

SHA-256 : `985D495734F077E25CF1C0ACADD0499D13FBC1D626745FF51C76E61479F0868A`  
Taille : 5 795 328 octets.

Ce hachage est identique à celui de `native/audio-engine/build/Release/mlh-audio-engine.exe`, ce qui confirme que le package contient exactement le dernier Engine 2 Release validé.

## 16. Verdict

ENGINE 2 INTEGRATED — READY FOR USER TEST
