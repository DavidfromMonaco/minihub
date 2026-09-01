# MINIHub — Sequencer Implementation Report

Date : 23 août 2026  
Verdict final : **PASS**

## 1. Résultat

Le Sequencer est finalisé dans l’architecture MiniHub existante. Les pistes MIDI ciblent une chaîne VST3, l’Arpeggiator existant ou la sortie MIDI sélectionnée dans MiniHub. Le scheduling reste natif et sample-clocked. Le rendu Master WAV traverse le vrai host VST3 et le vrai DAG audio.

Les trois chaînes finales sont validées :

```text
A. Sequencer MIDI Track → VST3 → Mixer → Audio Output
B. Sequencer MIDI Track → Arpeggiator → VST3 → Mixer → Audio Output
C. Sequencer MIDI Track → VST3 → Mixer → Master WAV Export
```

Le chemin `Sequencer MIDI Track → physical MIDI output` est validé au niveau UI, routing, protocole et moteur. Aucun port MIDI physique n’était connecté ; MiniHub a toutefois ouvert le véritable endpoint Windows/JUCE `Microsoft GS Wavetable Synth`, sans mock du protocole ou de `juce::MidiOutput`.

## 2. Architecture finale

```text
Timeline / Piano Roll
        ↓ opérations PPQ
SequencerModel + SequencerController
        ↓ snapshot immuable via IPC versionné
SequencerEngine JUCE
        ├─ MIDI → Chain VST3
        ├─ MIDI → Arpeggiator du MIDI DAG → VST3 / MIDI output
        ├─ MIDI → PhysicalMidiOutput JUCE
        └─ Audio → audio DAG → Mixer / Morpher → Audio Output / Master WAV
```

Le Patch Bay renderer demeure l’autorité topologique. Le transport global demeure l’unique horloge musicale. Aucun `setTimeout`, `setInterval` ou `requestAnimationFrame` n’est utilisé pour programmer les événements MIDI.

## 3. Hardware MIDI Output — PASS

La destination de piste réutilise le nœud MiniLab existant, désormais exposé comme destination `midi-output`, et la sélection de port MIDI déjà fournie par MiniHub. `SequencerController` synchronise l’identifiant et le nom du port vers la commande native `selectMidiOutput`.

Le moteur utilise `PhysicalMidiOutput`, fondé sur `juce::MidiOutput` :

- énumération et sélection d’un endpoint MIDI par identifiant/nom ;
- ouverture par le véritable backend JUCE ;
- `sendBlockOfMessages` avec timestamp natif de début de callback, sample offsets et sample rate ;
- Note On, Note Off dérivé de la durée, vélocité et canal conservés ;
- loop et seek pris en charge par le transport/scheduler natif partagé ;
- chase sample-zero après seek dans une note tenue ;
- Stop, seek, resync, fin d’export et commande panic appellent le panic global ;
- suppression des messages en attente puis CC 123 All Notes Off et CC 120 All Sound Off sur les 16 canaux ;
- aucune clock JavaScript et aucun second moteur MIDI.

Validation déterministe moteur : 48 kHz, callback start 4321 ms, Note On sample 0, vélocité 87, canal 3, Note Off à la frontière native suivante, seek/chase sample 0 et panic sans événement restant. Les tests de loop/Stop partagent exactement le même scheduler et la même sortie `MidiOutputSink`.

Validation du protocole réel : le binaire Release a énuméré, ouvert puis fermé `Microsoft GS Wavetable Synth`, a synchronisé une piste `midi-output`, activé un loop PPQ 0..1, effectué un seek, Stop, panic, désélection et `shutdownAck`.

**ENGINE VALIDATED**  
**PHYSICAL HARDWARE NOT AVAILABLE**

## 4. Arpeggiator Routing — PASS

La piste Sequencer cible le nœud Arpeggiator du graphe existant. Ses événements horodatés entrent dans `MidiExecutionPlan`, puis l’Arpeggiator alimente ses destinations VST3 ou MIDI physiques existantes.

Le test natif réel valide :

- compilation `Sequencer → Arpeggiator → VST3` ;
- événement Sequencer à PPQ 0,125 ;
- déclenchement de l’Arpeggiator au sample exact 6000 à 48 kHz/120 BPM ;
- silence avant le step et signal VST3 audible après le step ;
- panic de l’Arpeggiator et de la chaîne VST3 ;
- conservation des patterns 4/8/16/32 et du transport global par les régressions existantes.

Aucun Arpeggiator spécifique au Sequencer n’a été ajouté.

## 5. VST3 Real Processing — PASS

Le plugin `MiniHub Deterministic Test Instrument.vst3` est construit comme un vrai bundle VST3 JUCE réservé aux tests. Il est découvert par `Vst3Scanner`, chargé par `PluginInstance`, inséré dans une vraie `Chain`, préparé à 48 kHz/256 samples et traité par le DAG MiniHub. Le host n’est pas mocké.

Le contrat direct JUCE et le contrat MiniHub valident : bus de sortie stéréo, silence sans MIDI, audio après Note On, silence après Note Off, destruction propre et absence de stuck note.

Résultats de la correction VST3 conservée :

- Direct JUCE Host : PASS ;
- MiniHub DAG : PASS ;
- Sequencer → Arpeggiator → VST3 : PASS ;
- VST3 MIDI → Audio : PASS ;
- AddressSanitizer : PASS ;
- VST3 E2E répété : 5/5 PASS.

## 6. VST3 Master WAV Export — PASS

Le test C exécute réellement :

```text
MIDI clip → VST3 instrument → audio DAG → Mixer → Master Export → WAV
```

Il valide trois exports successifs (unity, gain 0,5, mute) :

- WAV 24-bit, 48 kHz, exactement 24 000 frames pour la plage demandée ;
- signal non silencieux généré par le VST3 réel ;
- routing VST3 → Mixer → Audio Output/Master ;
- rapport de volume 0,5 imprimé dans le WAV ;
- mute imprimé comme silence déterministe ;
- démarrage au bon sample et silence après Note Off ;
- réussite de plusieurs exports successifs ;
- transport, playhead et loop globaux restaurés ;
- aucun stuck note après export.

Le rendu Master WAV reste temps réel, tel qu’autorisé par le milestone.

## 7. MIDI Recording — PASS

L’entrée physique sélectionnée est horodatée par le transport natif, applique la compensation MIDI MiniHub et conserve pitch, vélocité, canal et durée. Stop/seek ferment les notes actives. Le résultat devient automatiquement un clip éditable et persistant.

Les tests injectent de vrais messages MIDI dans le moteur et valident le résultat de capture. Aucun contrôleur physique n’a été utilisé pendant cette passe.

**ENGINE VALIDATED**  
**PHYSICAL HARDWARE NOT AVAILABLE**

## 8. Audio Recording — PASS

Les pistes audio capturent l’entrée active ou un tap du DAG. `AudioTakeWriter` écrit un WAV stéréo 32-bit par `ThreadedWriter`, sans bloquer le callback. Le test E2E injecte 480 frames réelles, ferme la prise, relit le fichier JUCE et crée automatiquement le clip renderer.

Un périphérique `Microphone (Realtek USB2.0 Audio)` était énuméré, mais le `deviceState` du smoke moteur indiquait `inputDevice` vide ; aucune capture physique n’est donc revendiquée.

**ENGINE VALIDATED**  
**PHYSICAL HARDWARE NOT AVAILABLE** dans le callback actif de validation.

## 9. Persistence — PASS

`sequencerState` reste une clé projet et non une préférence machine. Save/load manuel préserve pistes, arm/mute/volume, I/O, clips MIDI/audio, notes, références de fichiers, trims/gain, loop, snap, zoom/scroll et état utile de l’éditeur. Les tests écrivent, relisent et valident réellement le fichier projet atomique.

## 10. Régressions globales — PASS

La suite JavaScript finale couvre notamment :

- Sequencer, Piano Roll, timeline, transport et loop ;
- MIDI recording, audio recording et compensation ;
- MIDI live, panic et hardware persistence ;
- VST Host, VST state/cache, paramètres et lifecycle ;
- Arpeggiator 4/8/16/32 ;
- Patch Bay, audio DAG, Mixer et Morpher ;
- Master WAV export ;
- save/load projet ;
- Home, sidebar, navigation et lifecycle Electron ;
- garde de fermeture `EPIPE` du main process.

Résultat final : **417 tests, 417 pass, 0 fail**.

Suites natives Release :

- `mlh_native_core_tests` : PASS, **1151 checks** ;
- `mlh_vst3_e2e_tests` : PASS, **33 checks** ;
- CTest post-build : 2/2 suites PASS ;
- AddressSanitizer VST3 : PASS ;
- répétition VST3 E2E : 5/5 PASS.

## 11. Release Build — PASS

Un seul build CMake/MSBuild a été exécuté à la fois. Avant chaque compilation, le garde a vérifié l’absence de `cmake`, `MSBuild` et `cl`. Les workers `/nodemode` MSBuild dont le parent avait disparu ont été identifiés puis fermés avant de poursuivre.

Le build complet `native/audio-engine/build --config Release --parallel 2` a produit :

- `mlh-audio-engine.exe` ;
- `mlh_native_tests.exe` ;
- le VST3 déterministe de validation.

Build : PASS. Les seuls diagnostics sont des warnings JUCE de dépréciation de `MidiBuffer::Iterator`, sans erreur ni régression.

## 12. Electron Build et Packaged Application — PASS

`npm run sync:dist` a synchronisé **62 fichiers**, recréé `MiniHub.exe` depuis le runtime Electron vierge, estampillé l’icône MiniHub et promu atomiquement l’exécutable.

Contrôles du package :

- syntaxe du main et du preload packagés : PASS ;
- payload source/package identique : PASS ;
- garde `EPIPE` présent dans le package : PASS ;
- binaire natif Release/package identique : PASS ;
- SHA-256 natif : `7F3FE39A784995914E561C71E69F12D1A593F303838352BA8E6A941477D2542E` ;
- aucun processus MiniHub ou moteur laissé actif après validation.

Un premier smoke graphique lancé par Codex a hérité de son stdout. L’interruption du runner a fermé le pipe et provoqué une exception `EPIPE` dans le relais console du main Electron. Les quatre processus de ce lancement ont été fermés. `consoleStreamGuard` neutralise désormais uniquement `EPIPE` sur stdout/stderr ; son test de non-crash et d’installation idempotente passe. Aucun nouveau smoke graphique n’a été lancé depuis un pipe Codex.

## 13. FINALIZATION PASS

| Élément | Statut | Validation |
|---|---|---|
| Hardware MIDI Output | PASS | UI + Patch Bay + IPC + scheduler natif + endpoint JUCE réel ; matériel physique absent |
| Arpeggiator Routing | PASS | Sequencer → Arpeggiator existant → vrai VST3, sample-exact |
| VST3 Real Processing | PASS | scanner/host/chain/DAG réels, 33 checks E2E |
| VST3 Master WAV Export | PASS | vrai signal VST3, volume, mute, durée, routing, 3 exports, no stuck note |
| MIDI Recording | PASS | capture/compensation/clip/persistence moteur |
| Audio Recording | PASS | buffers réels → writer réel → WAV relu → clip |
| Persistence | PASS | projet atomique et arrangement complet |
| Global Regressions | PASS | 417 JS + 1151 core + 33 VST3, 0 échec |
| Release Build | PASS | build natif Release complet et séquentiel |
| Packaged Application | PASS | payload, exécutable, icône, syntaxe et hashes validés |

### Tests ajoutés dans la finalization

- destination physique `CapturingMidiOutput` au niveau moteur ;
- découverte/état/sélection de sortie MIDI dans `EngineClient` ;
- route Patch Bay Sequencer → `midi-output` ;
- description du graphe Sequencer → Arpeggiator → VST3/MIDI output ;
- vrai VST3 déterministe chargé par le host MiniHub ;
- exports VST3 unity/half/mute ;
- protection Electron main process contre un stdout/stderr fermé (`EPIPE`).

### Hardware availability

- sortie MIDI physique : **PHYSICAL HARDWARE NOT AVAILABLE** ;
- endpoint MIDI système JUCE réel : disponible, ouvert et validé ;
- audio output : moteur ouvert à 48 kHz / 128 samples ;
- audio input actif : vide pendant la validation ; aucune capture physique revendiquée.

### Limitations restantes

Aucun blocker logiciel demandé par ce milestone ne reste ouvert. Les contraintes suivantes sont explicites et acceptées :

- Master WAV en temps réel avec callback audio actif ;
- aucune validation manuelle d’un contrôleur MIDI physique ou d’une capture audio physique dans cet environnement ;
- warning de maintenance sur l’API JUCE `MidiBuffer::Iterator` dépréciée.

Les fonctions hors scope — automation, time stretch, comping, stems UI, nouveaux formats, nouvel éditeur/mixer/transport — n’ont pas été ajoutées.

## 14. Verdict final

**PASS**

Toutes les fonctions logicielles demandées sont reliées au moteur MiniHub réel et validées. L’absence de sortie MIDI physique empêche uniquement le label `PHYSICAL HARDWARE VALIDATED`; elle ne constitue ni un bug logiciel ni un motif de verdict PARTIAL.
