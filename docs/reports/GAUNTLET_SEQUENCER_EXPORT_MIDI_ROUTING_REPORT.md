# MiniHub — Correctifs Séquenceur / Export / Routage MIDI

Date de validation : 24 août 2026  
Verdict final : **PASS**

Le verdict n'a été prononcé qu'après compilation Release, tests JS et natifs, puis exécution de deux gauntlets dans le véritable `dist/MiniHub/MiniHub.exe` (`packaged: true`).

## Causes racines

1. Le rendu d'export utilisait le callback audio qui alimente aussi les sorties matérielles. Le transport live était gelé pendant le bounce et le PCM d'export pouvait donc partager le chemin audible.
2. `EngineClient._liveInputCommand()` supprimait des commandes MIDI live pendant l'export, notamment le Note Off : c'était la cause directe des notes bloquées.
3. Le Séquenceur et l'export partageaient des plans et des destinations VST live. Un export ne possédait pas un snapshot profond et autonome de l'arrangement, des graphes et des processeurs.
4. Le routage renderer diffusait le MIDI du Séquenceur sur toutes ses branches. La piste ciblée, le focus et l'armement n'étaient pas une autorité de routage suffisante.
5. La sélection de clips était un identifiant unique ; le drag groupé, la prévisualisation continue, l'annulation exacte et un presse-papiers temporel de groupe n'existaient pas.

## Architecture livrée

### Export Master isolé

- Le callback rend d'abord le graphe live vers le matériel avec le transport live.
- Un `ExportContext` séparé possède : chaînes et instances VST clonées, états restaurés, plans Audio/MIDI gelés, buffer stéréo privé, scratch MIDI privé, Master et protections privés, fréquence capturée et transport offline.
- Le PCM privé n'est jamais additionné aux canaux matériels. Il alimente un unique writer Master, puis WAV, MP3 ou OGG utilisent cette même source PCM.
- Le snapshot couvre toutes les pistes et tous les clips de l'arrangement. La sélection UI n'entre pas dans la commande native.
- La plage complète va de 0 au maximum exact `startPpq + lengthPpq`. Un arrangement vide reste exactement à 0 dans le modèle ; seul le dialogue d'export conserve son fallback historique de quatre temps pour permettre un fichier vide explicite.
- Les mutations live de graphe, VST, mix, transport et MIDI restent immédiates, car le bounce travaille sur des clones. Seul un changement de périphérique audio est différé : il arrêterait le callback qui cadence aussi le writer privé.
- Fin, annulation et erreur provoquent Note Off exact pour les notes connues, puis CC123 et CC120 sur les 16 canaux de chaque destination export clonée. Les clones consomment un dernier bloc de nettoyage avant destruction.
- MP3 utilise le binaire LAME fourni dans `resources/native`, avec sa notice LGPL copiée dans la distribution.

### Multi-sélection et édition de clips

- État canonique : `selectedClipIds`, ancre de sélection et compatibilité `selectedClipId`.
- Clic simple, Ctrl/Cmd-clic, Shift-clic et clic sur le fond.
- Drag groupé horizontal et vertical avec un delta temporel commun quantifié, conservation des écarts relatifs et rejet atomique des pistes incompatibles.
- La position DOM suit le pointeur avant le mouse-up ; un seul commit canonique est produit au relâchement.
- `Escape` et `pointercancel` restaurent exactement toutes les positions initiales.
- Copier, coller, dupliquer et supprimer opèrent sur le groupe, préservent les offsets temporels et créent de nouveaux IDs pour les copies.

### Routage MIDI par piste

- Le seul ingress de performance reconnu est le câble stable `MiniLab MIDI OUT -> Sequencer MIDI IN`, associé au port WebMIDI sélectionné.
- Chaque piste MIDI possède une destination explicite. La lecture de l'arrangement envoie chaque piste à sa propre destination.
- Le live vise uniquement les pistes armées ou monitorées, ayant le bon input et une branche `Sequencer MIDI OUT` réellement câblée vers leur destination.
- Le focus d'une piste MIDI l'arme exclusivement par défaut. Le multi-arm reste possible par geste additif explicite.
- Le graphe utilise `emitDataTo()` pour une branche ciblée au lieu d'un fan-out global.
- Chaque Note On mémorise ses destinations exactes ; son Note Off retourne vers ces destinations même si le focus change. Une déconnexion déclenche encore le nettoyage direct de l'ancienne destination.

## Fichiers principaux

- Natif : `native/audio-engine/src/engine.{h,cpp}`, `native/audio-engine/src/sequencer.{h,cpp}`.
- Renderer : `src/renderer/js/core/engineClient.js`, `sequencerModel.js`, `sequencerController.js`, `graph.js`, `nodeInstances.js`.
- UI : `src/renderer/js/modules/sequencer/sequencerModule.js`, `src/renderer/styles/base.css`.
- Tests : `test/sequencer.test.mjs`, `sequencerUi.test.mjs`, `sequencerProductAcceptance.test.mjs`, `engine.test.mjs`, `nativeRealtimeSafety.test.mjs`, `native/audio-engine/test/native_tests.cpp`.
- Runtime : `scripts/runtime-export-gauntlet.mjs`, `scripts/runtime-vst-midi-gauntlet.mjs`.

## Résultats automatisés

- `npm test` : **516/516 PASS**.
- `mlh_native_tests.exe --core` avec conservation des artefacts : **1 307 contrôles PASS**.
- `mlh_native_tests.exe --vst3-e2e` : **49 contrôles PASS**, avec VST3 déterministe réellement scanné, instancié, joué et exporté.
- Build Release : `mlh_audio_engine` et `mlh_native_tests` compilés avec succès.

## Preuves dans le MiniHub packagé

Exécutable testé : `dist/MiniHub/MiniHub.exe`  
Moteur packagé SHA-256 : `cc53aeef6337666eaab8ebd8d318243ee7d44982b34ecf02998e0881430b2e5f`  
Manifest runtime : `601ec70976c62fda831fe7819a454035370d1f52@2026-08-24T00:46:19.233Z`

### Export audio et codecs

- Deux pistes, quatre clips, plage exacte 0 → 0,45 PPQ, sélection absente du protocole.
- Master mesuré à 0 pendant chaque export alors que le live est arrêté.
- Transport live conservé à `playing=false`, position 0,1, boucle 0,05 → 0,35.
- Lecture live audible et Stop silencieux après chaque export.
- Export long : Play audible puis Stop silencieux pendant l'export, suivi d'une annulation ; fichier annulé supprimé.
- Aucun tick de métronome ni erreur moteur pendant le bounce.
- Décodage externe FFmpeg/FFprobe :
  - WAV PCM 24 bits, stéréo 48 kHz, 1,725 s, 496 904 octets, crête −30,0 dB ;
  - MP3 320 kb/s demandé, stéréo 48 kHz, 1,725 s, 71 040 octets, crête −30,0 dB ;
  - OGG Vorbis qualité maximale, stéréo 48 kHz, 1,728 s, 9 476 octets, crête −29,9 dB.

Artefacts : `artifacts/runtime-export-packaged-20260824/runtime-export-20260824005109603.{wav,mp3,ogg}`.

### Deux VST et live MIDI

- Deux instances réelles du VST3 déterministe chargées dans deux chaînes distinctes.
- Focus A : Note On uniquement vers A ; changement de focus : Note Off exact + CC123/CC120 vers A.
- Focus B : Note On/Off uniquement vers B.
- Multi-arm explicite : Note On/Off vers A et B.
- Export avec un seul clip sélectionné : snapshot de deux pistes/deux clips et deux clones VST, chacun avec 269 octets d'état et le même hash d'état.
- Note On et Note Off envoyés immédiatement pendant la transaction d'export.
- Une note live tenue reste audible pendant et après la fin du bounce ; son Note Off après la fin produit un Master exactement silencieux, sans note bloquée.
- Transport live conservé à `playing=false`, position 0,25, boucle 0,25 → 1,75 ; transport offline sans boucle.
- WAV VST décodé : PCM 24 bits, stéréo 48 kHz, 2,5 s, 720 104 octets, crête −14,3 dB.

Artefact : `artifacts/runtime-export-packaged-20260824/runtime-vst-routing-20260824005721845.wav`.

## Limites connues

- Aucun contrôleur MiniLab physique n'était disponible dans l'environnement. Le second gauntlet injecte les octets MIDI au même point d'entrée du graphe packagé (`MiniLab MIDI OUT`) et exerce ensuite le vrai contrôleur de routage et le vrai moteur.
- Le VST utilisé pour la preuve est le VST3 déterministe du banc de test, pas un instrument commercial tiers.
- Le rendu privé est actuellement cadencé par le callback audio actif : il privilégie l'isolation et la sûreté temps réel, mais ne promet pas un bounce plus rapide que le temps réel.
- Un VST tiers qui refuse une seconde instance ou la restauration de son état fera échouer l'export de manière explicite ; l'instance live reste alors intacte.
