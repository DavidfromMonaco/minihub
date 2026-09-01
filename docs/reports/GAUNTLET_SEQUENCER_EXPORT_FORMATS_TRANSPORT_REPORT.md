# GAUNTLET — Sequencer export formats and transport isolation

Date: 2026-08-23  
Runtime testé: `dist/MiniHub/MiniHub.exe`  
Verdict: **PASS**

## Résumé

Le défaut venait d’un partage direct du même objet `Transport` entre la lecture live et le rendu d’export. L’ancien export désactivait la boucle du transport live, déplaçait son playhead, lançait sa lecture, l’arrêtait depuis le callback audio, puis tentait de restaurer un snapshot plus tard sur le thread de messages. Pendant cette transaction, les commandes Play/Stop étaient en outre différées. Une commande utilisateur pouvait donc perdre la course contre la restauration asynchrone d’un état ancien; la boucle et la lecture restaurées pouvaient relancer des clips après l’export.

Le rendu utilise désormais un `offlineExportTransport_` privé. Le transport live n’est lu qu’une fois pour capturer le tempo; il n’est ni cherché, ni bouclé, ni démarré, ni arrêté, ni « restauré » par l’export. Le callback choisit explicitement un transport par bloc, et un routeur de playhead donne le même choix aux VST. Les commandes Play/Stop live restent immédiates pendant la transaction. WAV, MP3 et OGG reçoivent le même buffer Master final.

Le paquet réellement utilisé par l’utilisateur a généré et fait décoder les trois codecs. Après chacun, Stop a produit un Master exactement silencieux et Play a produit immédiatement un signal mesuré. L’annulation a supprimé le fichier partiel et laissé le transport live contrôlable.

## Cause racine et ancienne architecture

L’ancienne séquence de `SequencerEngine::startExport` était conceptuellement:

1. mémoriser un pointeur vers le transport live et quelques champs `playing`, `loop` et playhead;
2. appeler `transport.setLoop(false)`, `transport.seekPpq(exportStart)` et `transport.setPlaying(true)` sur ce même objet;
3. rendre les blocs avec ce transport partagé;
4. appeler `transport.setPlaying(false)` dans `processMaster` à la fin;
5. restaurer ultérieurement l’ancien snapshot dans `serviceEvents`.

Deux mécanismes transformaient ce partage en panne visible:

- côté renderer et côté moteur, `setTransport` faisait partie des mutations différées pendant l’export: Play/Stop n’atteignait donc pas immédiatement l’état live;
- la restauration différée pouvait écraser une intention utilisateur plus récente avec le snapshot capturé au départ. Si le snapshot contenait `playing=true` ou une boucle active, les clips pouvaient repartir ou rester en boucle après le rendu.

Ce n’était pas un simple défaut d’affichage: le véritable transport natif était modifié. Aucun reset UI n’a été ajouté pour le masquer.

## Nouvelle isolation live/offline

Le chemin courant est:

```text
Live Transport ------------------------------> lecture live / UI
       | lecture unique du BPM au démarrage
       v
Offline Export Transport -> Sequencer snapshot -> VST/FX -> Mixer
                         -> per-node protection -> Audio Output
                         -> Master Gain/Meter -> writer WAV/MP3/OGG
```

Les invariants implémentés sont les suivants:

- `Transport transport_` reste l’autorité live.
- `Transport offlineExportTransport_` appartient au contexte export et commence à `exportStart`, sans boucle.
- `TransportPlayHeadRouter` est installé une fois sur les plugins et pointe, pour chaque callback, vers le transport du bloc courant.
- l’arrangement est un `Plan` immuable, capturé par génération dans `exportPlan_` avant l’ouverture du rendu;
- les mutations du graphe audio/MIDI, du Sequencer, des chaînes VST, des paramètres/états, du Master et des éditeurs sont différées jusqu’à l’événement terminal;
- `setTransport` n’est plus une mutation différée: Play, Stop, seek et boucle live restent des commandes immédiates;
- les éditeurs VST sont fermés avant le premier bloc pour qu’une modification directe d’éditeur ne contourne pas la transaction;
- la sélection et l’état visuel des clips restent dans le renderer et ne sont jamais modifiés par l’export;
- la sortie MIDI physique et le métronome sont exclus du rendu d’export;
- l’export ne contient aucun pointeur de restauration vers le transport live.

Les processeurs VST ne sont pas clonés. Leur graphe logique et leurs paramètres sont figés par la transaction pendant le rendu, et le playhead qu’ils voient est le transport offline. La trace `vstSnapshot` publie identité, génération, bypass, taille et empreinte de l’état sérialisé de chaque plugin. Cela évite de dupliquer des instances VST tout en maintenant un état de rendu stable.

Comportement défini pendant une lecture live: l’état live reste indépendant et accepte immédiatement Play/Stop, tandis que les blocs DSP sont temporairement conduits par l’horloge d’export. Le playhead live ne sert jamais à déterminer le rendu. À la fin, la lecture live reprend naturellement depuis sa position live; aucune restauration artificielle n’est appliquée.

## Traces ajoutées

L’événement `sequencerExport` en état `started` expose maintenant:

- état live: `livePlaying`, `liveRecording`, `livePpqPosition`, `liveSamplePosition`, boucle et bornes;
- état offline: `offlinePlaying`, positions PPQ/sample et boucle;
- snapshot arrangement: génération, pistes, type, mute/arm, entrées/sorties, clips, bornes et état `scheduled`/`unavailable`;
- snapshot VST: chaîne, instance, plugin, génération, rôle, bypass et empreinte de state;
- nombre de mutations différées.

L’événement terminal `complete`, `error` ou `cancelled` republie l’état live et le nombre de mutations avant leur rejeu. Le gauntlet runtime a observé une génération de snapshot `7`, deux pistes, quatre clips tous `scheduled`, et un routage vers `mixer-runtime`.

## Fin déterministe et tails

Le renderer calcule:

- export complet: `startPpq = 0`, `endPpq = compositionEndPpq()`;
- export de boucle: bornes explicites de la boucle du projet.

Le moteur refuse toute plage non finie, inversée, négative ou toute tail hors `0..30 s`. Le nombre de frames est fixé avant le premier bloc:

```text
ceil((((exportEndPpq - exportStartPpq) * 60 / bpm) + tailSeconds) * sampleRate)
```

La boucle du transport offline est toujours désactivée. À `exportEndPpq`:

- aucun nouvel événement MIDI et aucun nouvel échantillon de clip ne sont injectés;
- Note Off, All Notes Off et All Sound Off sont émis sur les 16 canaux;
- les arpégiateurs reçoivent un panic de frontière;
- les VST/FX, Mixer, protections et Master continuent de traiter la tail jusqu’au nombre exact de frames;
- le writer est fermé, puis le contexte et son transport sont détruits;
- une erreur d’écriture supprime le fichier incomplet.

Une répétition de clip ou une boucle live ne peut donc pas prolonger le rendu. La tail par défaut de l’UI est de 2 secondes et reste configurable de 0 à 30 secondes.

## Pipeline PCM et encodeurs

Un seul callback produit le signal:

```text
Sequencer snapshot
-> MIDI graph / VST instruments / FX
-> audio graph / Mixer / Morpher
-> protection par node et entrée Audio Output
-> Master Gain + Meter
-> SequencerEngine::processMaster
-> AudioFormatWriter sélectionné
```

Il n’existe aucun moteur séparé par codec. `processMaster` reçoit exactement le buffer post-protection, post-Master et post-meter envoyé à la sortie audio, puis le `ThreadedWriter` sélectionné l’encode.

### WAV

- writer: `juce::WavAudioFormat`;
- stéréo, sample rate moteur;
- PCM 16/24/32 bits;
- défaut: 24 bits.

### MP3

- writer: `juce::LAMEEncoderAudioFormat` avec `JUCE_USE_LAME_AUDIO_FORMAT=1`;
- choix CBR réellement retournés par JUCE/LAME: 128, 192, 256 et 320 kbps;
- défaut: 320 kbps;
- PCM temporaire 16 bits attendu par le writer LAME de cette version JUCE;
- `lame.exe` est recherché exclusivement à côté de `mlh-audio-engine.exe`; aucun FFmpeg ni LAME système n’est recherché.

MiniHub embarque LAME x64 3.100.1, construit depuis le snapshot source `lameproject/lame` `1f5cc9487284d5950343aa5d4f70de433468070a`. Le source utilisé, `COPYING`, `LICENSE`, la procédure de build et le binaire sont conservés sous `native/third_party/lame`. Le package contient `resources/native/lame.exe` et `LAME-COPYING.txt`. SHA-256 du binaire source/build/package: `95962C168C949E54FEE3547B87DB3AD5708DC49C2D6E7D82193FF35FEFD37336`. LAME est utilisé comme exécutable séparé sous GNU Library GPL v2; aucune modification source silencieuse ni installation externe n’est requise.

Références d’implémentation/licence: [options de build `juce_audio_formats`](https://docs.juce.com/master/juce__audio__formats_8h.html), [documentation JUCE de `LAMEEncoderAudioFormat`](https://docs.juce.com/master/classjuce_1_1LAMEEncoderAudioFormat.html) et [site officiel LAME](https://lame.sourceforge.io/).

### OGG Vorbis

- writer in-process: `juce::OggVorbisAudioFormat` avec `JUCE_USE_OGGVORBIS=1`;
- l’UI ne code pas d’indices arbitraires: elle affiche les libellés réellement renvoyés par `getQualityOptions()`;
- options runtime observées: 64, 80, 96, 112, 128, 160, 192, 224, 256, 320 et 500 kbps;
- défaut: dernière option, 500 kbps.

JUCE documente que l’index passé au writer OGG doit provenir de [`getQualityOptions()`](https://docs.juce.com/master/classjuce_1_1OggVorbisAudioFormat.html).

## UI, chemins et annulation

Le panneau Export du Sequencer contient:

- Format: WAV, MP3, OGG Vorbis;
- WAV seulement: bit depth;
- MP3 seulement: bitrate;
- OGG seulement: quality issue des capacités natives;
- tail, Export complet, Export Loop et Cancel.

Le dialogue Electron utilise un filtre et une extension propres au format. `audioExportFilePath` retire les suffixes codecs superposés avant d’ajouter exactement l’extension choisie; `track.mp3.wav` devient ainsi `track.mp3` pour un export MP3. Le moteur refuse également toute extension ne correspondant pas au codec demandé.

`sequencerCancelExport` ferme uniquement la barrière du callback export, attend qu’aucun callback ne possède le writer, ferme celui-ci, supprime le fichier partiel, libère le plan et le transport offline, puis publie `cancelled`. Il ne modifie jamais le transport live.

## Tests permanents ajoutés ou étendus

### JavaScript

- choix de format, options pertinentes et bouton Cancel dans le Sequencer;
- commandes natives WAV/MP3/OGG et valeurs par défaut;
- canonicalisation des extensions et cas `track.mp3.wav`;
- Save dialog et preload format-aware;
- autorisation du protocole d’annulation;
- `setTransport` immédiat pendant l’export;
- garde statique contre le retour d’un transport/restauration partagé;
- contexte offline, routeur de playhead et transaction de mutations.

Résultat: **508 tests passés, 0 échec** avec `npm test`.

### Natif

La régression permanente crée plusieurs pistes/clips, active une boucle live, puis répète pour WAV, MP3 et OGG:

1. transport live en lecture et en boucle;
2. démarrage d’un export offline à zéro;
3. vérification que Play, boucle, PPQ et sample live ne changent pas dans `startExport`;
4. rendu jusqu’à la limite déterministe;
5. vérification identique après fermeture;
6. Stop, bloc silencieux sans clip fantôme;
7. désactivation de boucle, seek zéro, Play, bloc audible;
8. Stop;
9. décodage et inspection du fichier.

Un cas séparé démarre arrêté. Un autre annule un export et vérifie état live inchangé, événement `cancelled` et absence de fichier partiel. Les validations PCM couvrent stéréo, 48 kHz, durée, valeurs finies et signal non silencieux. OGG est relu par JUCE après contrôle de la signature `OggS`; MP3 est contrôlé comme flux MPEG/ID3 puis redécodé par le LAME embarqué.

Résultats:

- native core: **1 279 contrôles passés**;
- VST3 E2E déterministe: **43 contrôles passés**;
- CTest Release: **2/2 tests passés**, 0 échec;
- artefacts natifs conservés: `sequencer-export-transport.wav`, `.mp3`, `.ogg`.

Le VST3 E2E conserve la négociation multi-sorties, le routage Sequencer/arpégiateur, le traitement live et les exports répétés avec le playhead routé vers le bon transport.

## Validation du runtime packagé

Le test a lancé, sans mock, `dist/MiniHub/MiniHub.exe` masqué avec CDP local, puis a commandé son véritable `hubAPI`, son processus principal Electron et `resources/native/mlh-audio-engine.exe`.

Provenance observée:

- `packaged: true`;
- exécutable: `dist/MiniHub/MiniHub.exe`;
- moteur natif SHA-256: `ec19a36a0ea3e591c4df5adc073c8725a8dc0a374b5577d84786475c9c366669`;
- LAME présent et annoncé par le moteur;
- device: `Casque (High Definition Audio Device)`, 48 000 Hz, buffer 480;
- arrangement réel injecté: 2 pistes audio, 4 clips, Mixer et Audio Output;
- boucle live: 0.05–0.35 PPQ;
- plage d’export: 0–0.8 PPQ à 120 BPM plus 0.3 s de tail;
- cible exacte: 33 600 frames, soit 0.700 s.

Pour chaque codec, le runtime a accusé Stop puis Play pendant le rendu sans déplacer son PPQ live. À l’événement terminal, `livePlaying=true`, la boucle et ses bornes étaient intactes, et aucune mutation n’était différée. Après chaque export:

| Format | État terminal | Frames | Stop Master L/R | Play Master L/R | Stop final L/R |
|---|---:|---:|---:|---:|---:|
| WAV | complete | 33 600 | 0 / 0 | 0.031531 / 0.015766 | 0 / 0 |
| MP3 | complete | 33 600 | 0 / 0 | 0.031531 / 0.015766 | 0 / 0 |
| OGG | complete | 33 600 | 0 / 0 | 0.031531 / 0.015766 | 0 / 0 |

Le playhead live avance de nouveau normalement une fois l’export terminé; ce mouvement naturel n’est pas une restauration de l’export. Pendant les commandes Stop/Play envoyées alors que le rendu était actif, sa position est restée identique, preuve que l’horloge offline conduisait le rendu.

L’export long annulé a produit `state=cancelled`, `frames=0`, a conservé le transport live arrêté à PPQ 0.14, a supprimé le fichier partiel, puis Play a redonné le même signal mesuré et Stop est revenu à 0/0. Aucun événement `error` n’a été émis.

Le script reproductible est `scripts/runtime-export-gauntlet.mjs`.

## Validation indépendante des fichiers runtime

`ffprobe` n’est utilisé que par le gauntlet indépendant; MiniHub ne l’invoque jamais.

| Fichier | Codec réel | Canaux | Rate | Durée | Taille | SHA-256 |
|---|---|---:|---:|---:|---:|---|
| `runtime-export-20260823214952565.wav` | PCM s24le | 2 | 48 000 | 0.700000 s | 201 704 | `6523E5CB426861B0CBEBA60AA315CDB60DD509387E5B06C88AC42AC5FB1B770A` |
| `runtime-export-20260823214952565.mp3` | MPEG Layer III | 2 | 48 000 | 0.700000 s | 30 720 | `9C096D2AC5F5F3369AA4F5D44A0D9B061872E1281B6AF48E1C8E3EDA5A8C3A21` |
| `runtime-export-20260823214952565.ogg` | Vorbis/Ogg | 2 | 48 000 | 0.702667 s | 9 391 | `3F262EE092EBEDE211F12E6122418709E86EF3A63C225F6EC42E5B4F1F86EF9C` |

Le léger granule/padding OGG de 2.667 ms reste dans la tolérance codec permanente (2 304 frames). Les tests natifs ont en plus vérifié absence de NaN/Inf, signal non silencieux et décodage complet. Les signatures prouvent qu’il ne s’agit pas de fichiers WAV renommés.

## Fichiers modifiés pour ce gauntlet

- documentation/build: `README.md`, `native/audio-engine/CMakeLists.txt`, `native/third_party/lame/MINIHUB_BUILD.md`, `scripts/sync-dist.mjs`;
- moteur: `native/audio-engine/src/transport.h`, `sequencer.h/.cpp`, `engine.h/.cpp`;
- dépendance: `native/third_party/lame/` avec sources, licences et `bin/lame.exe`;
- main/preload: `src/main/audioExportPath.js`, `main.js`, `preload.js`, `engineCommandPolicy.js`;
- renderer: `engineClient.js`, `sequencerController.js`, `sequencerModule.js`, `base.css`, `buildStamp.js`;
- tests: `audioExportPath.test.cjs`, `engine.test.mjs`, `nativeRealtimeSafety.test.mjs`, `recorderProtocol.test.cjs`, `sequencer.test.mjs`, `sequencerUi.test.mjs`, `native/audio-engine/test/native_tests.cpp`;
- preuve runtime: `scripts/runtime-export-gauntlet.mjs` et les fichiers audio sous `artifacts/`.

## Non-régressions et verdict

La suite complète confirme les contrats existants: VST3 multi-sorties, gain staging/protection par node, Master Gain/Meter, Sequencer MIDI et audio, snapshot déterministe, protections New/Load/Record, routage Patch Bay, save/load, UI VST et MiniLab.

**VERDICT: PASS.** WAV, MP3 et OGG Vorbis ont été réellement générés par le runtime MiniHub packagé, identifiés et décodés comme leurs codecs annoncés. Play/Stop a été exercé pendant et après chacun; après chaque Stop le Master est exactement silencieux, après chaque Play il est audible, aucune boucle fantôme ni note coincée n’a été observée, et Cancel ne touche que le contexte offline.
