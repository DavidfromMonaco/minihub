# MiniHub — Gauntlet architecture moteur audio / export multipiste / bounce offline

Date de validation : 24 août 2026  
Package validé : `dist/MiniHub/MiniHub.exe`  
Verdict : **PASS technique automatisé sur le package final**.  
Réserve explicite : l'écoute humaine subjective des trois fichiers n'est pas réalisable par l'agent ; elle reste listée dans la checklist manuelle. La présence, le contenu multipiste, les signatures, la durée, le décodage et le signal ont été validés automatiquement.

## 1. Résultat exécutif

- Un seul processus live `mlh-audio-engine.exe` est supervisé pendant toute la durée de l'application.
- Un second moteur live est refusé nativement, avant construction de `AudioDeviceManager`, avec le code de sortie `73`.
- Le scan VST utilise désormais `mlh-vst3-scanner.exe`, exécutable séparé sans lien vers `juce_audio_devices` et sans session CoreAudio.
- Le bounce ne dépend plus du callback matériel : un worker CPU avance bloc après bloc sans `sleep`, timer, périphérique ou sortie hardware.
- Le contexte de bounce est privé et immuable : transport, plan Séquenceur, graphes audio/MIDI, chaînes VST clonées, états des plug-ins et Master dédié.
- Le chemin live reste utilisable pendant le bounce ; les commandes MIDI Note On/Off et le vumètre Master live ont été observés pendant les exports.
- WAV, MP3 et OGG sont produits depuis le même tap Master post-gain/post-meter, sans limiteur, normalisation ou réduction automatique cachée.
- Le package final a passé les tests JS, natifs, codecs, annulation, performance, provenance et télémétrie Windows.

## 2. Causes établies

### 2.1 Export presque temps réel

Cause exacte : le rendu privé était exécuté depuis `Engine::audioDeviceIOCallbackWithContext`. Un seul bloc d'export était donc calculé par bloc du périphérique physique. Même avec un transport privé et des clones VST corrects, l'horloge matérielle imposait mécaniquement une vitesse proche de 1×.

Correction : le callback matériel ne traite plus que le chemin live. `Engine::renderOfflineExport` boucle sur le nombre de frames restantes, traite le plan MIDI, le plan audio, le Master privé, écrit l'encodeur puis avance le transport offline. Cette boucle ne contient ni attente, ni timer, ni appel de périphérique.

### 2.2 Deux processus portant le nom du moteur

L'ancien package a été instrumenté sans modification :

- au repos : 1 processus moteur live et 1 session CoreAudio ;
- pendant un scan Kontakt : 2 processus nommés `mlh-audio-engine.exe`, l'un live et l'autre lancé avec `--scan-file` ;
- le helper de scan observé n'avait aucune session CoreAudio.

La seconde identité de processus était donc exactement le scanner réutilisant le binaire et le nom du moteur. En revanche, deux sessions audio persistantes de l'ancien package n'ont pas été reproduites sur cette machine ; il serait inexact de les attribuer au scanner observé. L'ancienne architecture ne possédait par ailleurs pas de verrou natif dur si le superviseur Electron était contourné.

Corrections : exécutable scanner distinct, métadonnées de rôle explicites, garde singleton JS, verrou Win32 `Local\\MiniHub.LiveAudioEngine.v1`, et arrêt avec acquittement.

### 2.3 Multipiste et sélection

Le plan d'export est compilé depuis la photographie complète du projet. Les pistes armées ou non, les clips sélectionnés ou non, et plusieurs destinations VST sont conservés. Les tests natifs utilisent trois pistes à des fenêtres temporelles différentes et des états d'armement mixtes ; chaque codec contient du signal dans les trois fenêtres. La sélection d'interface ne sert pas de filtre au Master Export.

### 2.4 Annulation MP3

Le gauntlet a découvert puis corrigé un défaut supplémentaire : le writer LAME de JUCE convertissait son WAV temporaire dans son destructeur. Annuler une plage MP3 immense pouvait donc lancer l'encodage complet et bloquer le thread de commandes.

Le writer MP3 est maintenant explicitement annulable. La requête d'annulation est atomique et non bloquante sur le thread de messages ; le worker offline détruit ensuite le writer, supprime le temporaire sans lancer LAME, nettoie les notes des clones et publie l'état terminal `cancelled`.

## 3. Architecture finale des processus

| Processus | Rôle | Parent | Périphérique audio hôte | Durée de vie | Motif |
|---|---|---|---|---|---|
| `MiniHub.exe` principal | application/superviseur | shell | non | application | UI, IPC et cycle de vie |
| `mlh-audio-engine.exe` | `live` | `MiniHub.exe` principal | oui, unique | application | audio live, VST, séquenceur et worker offline |
| `mlh-vst3-scanner.exe` | `scan` | moteur live | non | bornée à un fichier | isolation des métadonnées VST3 |
| `lame.exe` | encodeur MP3 final | moteur live | non | bornée à la finalisation MP3 | conversion du WAV temporaire validé |

Le scanner ne compile pas `engine.cpp`, n'inclut pas `engine.h`, ne lie pas `juce_audio_devices` et ne contient pas les symboles `AudioDeviceManager`, `WASAPI`, `ASIO` ou `audioDeviceIOCallback`.

## 4. Architecture du bounce

1. Le thread de messages valide la plage et capture BPM, sample rate, block size, projet, graphe audio, graphe MIDI, gain Master et états VST.
2. Un worker de préparation crée des instances VST privées et restaure leurs états.
3. Un plan Séquenceur privé, un transport sans boucle, les plans audio/MIDI et un Master privé sont publiés comme transaction immuable.
4. Le worker offline calcule les blocs aussi vite que le CPU et l'encodeur le permettent.
5. Le tap unique est : somme float des pistes → gain/mètre Master → writer WAV/OGG/MP3.
6. La fin ou l'annulation envoie Note Off/CC123/CC120 aux clones, ferme le writer, détruit le contexte privé et laisse le transport live intact.

Seule une reconfiguration de périphérique est différée pendant la transaction, car elle republie le contrat sample-rate/block-size du Séquenceur. Les graphes, le transport live, le gain, le MIDI et les commandes de plug-in restent immédiats.

## 5. Instrumentation Windows observée

### Package final pendant un scan réel

Capture : `artifacts/audio-architecture-final-package.json`

- moteur live : 1 ;
- session audio du moteur live : 1 ;
- scanner : 1 ;
- session audio du scanner : 0 ;
- PID live `19924`, parent `4744`, rôle et arguments présents.

### Package final pendant le bounce moyen

Capture : `artifacts/audio-architecture-final-package-during-offline-export.json`

- capture CoreAudio à `09:34:05.187Z`, à l'intérieur de la fenêtre de bounce ;
- moteur live : 1 ;
- session audio live : 1 ;
- scanner : 0 ;
- session scanner : 0 ;
- aucune session d'export et aucun second moteur.

### Arrêt

Capture : `artifacts/audio-architecture-final-after-shutdown.json`

- moteur live : 0 ;
- session audio live : 0 ;
- scanner : 0 ;
- encodeur survivant : 0.

## 6. Résultats fonctionnels et performance

### Codecs sur le package final

Gauntlet `runtime-export-gauntlet.mjs` : **PASS**.

| Codec | Artefact final | Preuve |
|---|---|---|
| WAV 24-bit | `artifacts/runtime-export-20260824093153788.wav` | 496 904 octets, RIFF/WAVE |
| MP3 320 kb/s | `artifacts/runtime-export-20260824093153788.mp3` | 71 040 octets, frame MPEG valide |
| OGG qualité max | `artifacts/runtime-export-20260824093153788.ogg` | 9 487 octets, `OggS` |

Pour les trois formats : 82 800 frames stéréo à 48 kHz, snapshot de 2 pistes/4 clips, transport live arrêté et inchangé, aucune impulsion métronome, reprise live audible automatiquement vérifiée après export.

L'annulation MP3 longue produit `cancelled`, préserve le transport live, permet Play/Stop et Note On/Off pendant la transaction, ne laisse ni LAME ni fichier partiel actif.

### Projets de performance sur le package final

| Projet | Contenu | Durée audio | Durée du rendu | Vitesse |
|---|---|---:|---:|---:|
| Léger | 2 pistes, 2 instruments VST3, 2 FX VST3, WAV | 115 s | 1,842 s | **62,43×** |
| Moyen | 6 pistes, 6 instruments VST3, 6 FX VST3, OGG | 120 s | 6,340 s | **18,93×** |

Chaque événement `started` annonce `renderThread=offline-worker`, `deviceIndependent=true`, `hardwareOutput=false`. Chaque snapshot contient toutes les pistes et les 2 instances clonées par chaîne. Un Note On live, un vumètre Master non nul et son Note Off ont été observés pendant chaque bounce ; le transport live est resté arrêté à 0,5 PPQ avec sa boucle inchangée.

## 7. Tests automatisés

- Suite JS complète : **539/539 PASS**.
- Tests natifs core : **1 276 checks PASS**.
- Tests VST3 E2E natifs : **48 checks PASS**.
- Multipiste : somme float de trois pistes supérieure à 2,9× une piste, sans réduction cachée.
- Contenu codecs : trois fenêtres temporelles distinctes présentes dans WAV, MP3 et OGG.
- Scanner hostile : sortie bruyante, timeout et crash isolés sans tuer le moteur.
- Provenance : sources, package, moteur, scanner, LAME et Electron hachés et cohérents.
- Singleton natif : second lancement refusé avant audio avec `duplicateExit=73`.
- Cycle de vie : fermeture propre, aucun processus/session résiduel.

## 8. Package final et empreintes

Synchronisation finale : `2026-08-24T09:31:20.479Z`  
Electron : `43.4.0`

| Fichier | SHA-256 |
|---|---|
| `dist/MiniHub/MiniHub.exe` | `b4245464056214a762dc5bf119a65f8a40206c21f7bea12bc40e1fd8fecfa3b4` |
| `mlh-audio-engine.exe` | `367420401eb03ab845242afb4cbad5f0561294d5faef6d4d130972730f78df6d` |
| `mlh-vst3-scanner.exe` | `910250ebf4f111340fcca329fadf91a49083deeca4139ae1b154c8ab4138c265` |
| `lame.exe` | `95962c168c949e54fee3547b87db3ad5708dc49c2d6e7d82193ff35fefd37336` |

Le worktree était déjà fortement modifié avant ce correctif ; aucune modification non liée n'a été remise à zéro.

## 9. Principaux fichiers modifiés/ajoutés

- `native/audio-engine/src/engine.cpp`, `engine.h` : worker offline, snapshot privé, télémétrie, transport live isolé.
- `native/audio-engine/src/sequencer.cpp`, `sequencer.h` : writer synchrone offline, MP3 annulable, nettoyage.
- `native/audio-engine/src/main.cpp` : rôle live exclusif et mutex Win32 durable.
- `native/audio-engine/src/scanner_main.cpp`, `vst3_scanner.cpp` : helper de scan dédié sans périphérique.
- `native/audio-engine/CMakeLists.txt` : cibles moteur/scanner et plug-ins déterministes de test.
- `src/main/engine.js`, `src/main/main.js` : superviseur singleton, métadonnées PID/PPID/rôle, arrêt acquitté.
- `src/renderer/js/modules/sequencer/sequencerModule.js` : progression “Rendering offline” et vitesse temps réel.
- `scripts/audio-session-gauntlet.ps1` : attribution processus/sessions CoreAudio.
- `scripts/runtime-offline-performance-gauntlet.mjs` : projets VST/FX reproductibles.
- `scripts/sync-dist.mjs` : package et provenance du scanner.

## 10. Checklist manuelle restante

Ces contrôles ne bloquent pas les preuves automatiques ci-dessus, mais doivent être exécutés par une personne pour l'acceptation perceptive :

1. Ouvrir le mixeur Windows et confirmer visuellement une seule ligne MiniHub.
2. Ajouter plusieurs pistes/VST et confirmer que cette ligne ne se duplique pas.
3. Écouter les trois artefacts WAV/MP3/OGG et confirmer subjectivement la présence de toutes les pistes.
4. Comparer visuellement les durées affichées aux mesures 1,842 s / 115 s et 6,340 s / 120 s.

La topologie CoreAudio correspondant aux points 1 et 2 et le contenu numérique correspondant au point 3 sont déjà PASS ; seule l'observation humaine de l'interface du mixeur et l'écoute subjective restent hors portée de l'agent.
