# MiniHub — Sequencer Audio/MIDI Correctness Report

Date : 24 août 2026  
Statut : corrections intégrées, build Release et validations automatisées réussies ; qualification finale conditionnée au test réel utilisateur.

## 1. Résultat livré

La topologie de piste est maintenant explicite et commune au live et à l’export :

`clips -> SUM piste -> Track Gain/Mute -> Track FX/routing -> Mixer -> Master`

Pour une piste MIDI pilotant un instrument VST3, le gain est appliqué à la sortie audio de l’instrument, avant les effets suivants de sa chaîne. Il ne modifie plus la vélocité MIDI et donc plus le timbre du synthétiseur.

Le changement de fader ou de mute passe par une commande Engine 2 atomique. Il ne reconstruit plus le plan du Sequencer et ne déclenche plus de panic/rechase pendant la lecture.

Stop invalide désormais les producteurs MIDI antérieurs, supprime les événements futurs obsolètes, émet un Note Off explicite pour chaque note active puis CC123/CC120, et nettoie toutes les chaînes concernées. Un Play immédiat après Stop utilise une nouvelle époque MIDI et reste accepté.

PortAudio, WASAPI, le SDK VST3, la PDC, le Master et le scanner VST n’ont pas été modifiés par ce chantier.

## 2. Diagnostic exact

### 2.1 Superposition des clips audio

L’inspection de la révision source disponible a invalidé une hypothèse importante : le renderer ne contenait pas de `trackBuffer = clipBuffer`. Il utilisait déjà `out.addSample(...)`. Je ne rapporte donc pas un faux écrasement que le code inspecté ne montre pas.

Le défaut réel de cette révision était la frontière DSP : le buffer de destination servait directement d’accumulateur et le volume de piste était multiplié dans chaque contribution de clip (`sample * clip.gain * track.volume`). Il n’existait ni buffer SUM propre à la piste, ni point unique « somme terminée », ni télémétrie permettant de distinguer contribution d’un clip, somme de piste et gain. Toute différence entre la source et un package antérieur était en outre impossible à diagnostiquer numériquement à ce niveau.

La correction introduit un scratch buffer stéréo par piste :

1. clear une seule fois au début du bloc de la piste ;
2. ajout de chaque clip actif avec son seul `clip.gain` ;
3. mesure de la somme complète ;
4. application unique du `track gain` ou de mute ;
5. ajout du résultat au buffer de destination.

Aucun clear, reset, copy ou remplacement n’intervient entre deux clips actifs d’une même piste.

### 2.2 Fader de piste

Deux causes se combinaient :

- côté UI, chaque changement de volume passait par `setTrack -> syncSequencer`, donc reconstruisait le plan complet et provoquait les nettoyages MIDI associés ;
- côté natif, le volume d’une piste MIDI multipliait la vélocité du Note On. Par exemple, une note écrite à vélocité 100 devenait 50 pour un fader à 0,5. Cela changeait le timbre, pas le niveau audio de retour du VST.

Le chemin corrigé est :

`fader dB UI -> conversion gain -> IPC setSequencerTrackControl -> TrackRuntime atomique -> AudioExecutionPlan/Chain -> multiplicateur DSP`

Le fader couvre -60 dB (silence) à +6 dB. Les événements `input` agissent pendant la lecture ; l’événement final ne sert qu’au rendu/persistage UI. La vélocité écrite est conservée exactement. Aucun smoothing préexistant n’était disponible dans cette couche ; la mutation devient effective à la frontière du bloc audio sans ajouter une seconde architecture de gain.

### 2.3 VST continuant après Stop

La cause de course était précise : une callback déjà engagée pouvait fabriquer un Note On avant Stop, puis appeler `Chain::pushMidi` après le panic. L’ancienne surcharge lisait l’époque courante au moment de l’enqueue ; l’événement ancien pouvait donc recevoir par erreur la nouvelle époque et survivre au Stop. En parallèle, la chaîne ne conservait pas un registre exhaustif des notes réellement livrées et dépendait surtout de CC123/CC120, que tous les plugins n’interprètent pas de façon identique.

La correction :

- capture l’époque de destination au début du bloc producteur ;
- incrémente l’époque au panic et refuse tout événement dont l’époque attendue est devenue obsolète ;
- revérifie l’état `playing` courant, pas seulement le snapshot de début de callback ;
- suit les notes actives sur 16 canaux × 128 pitches dans le Sequencer et dans chaque Chain ;
- envoie les Note Off explicites avant CC123 All Notes Off et CC120 All Sound Off ;
- vide l’état actif, les buffers planifiés et l’arpégiateur ;
- propage le panic à toutes les chaînes actives ;
- sépare les états de nettoyage live et export.

Une reverb ou un delay peut toujours rendre sa tail naturelle. Le test ciblé utilise les instruments sans ajouter de reverb et exige l’absence d’oscillateur/note maintenue ou de nouvelle note après Stop.

## 3. Instrumentation ajoutée

Engine 2 émet une télémétrie `audioPathTelemetry` de scope `sequencer-track` contenant, pour chaque bloc publié :

- `activeClips` ;
- `peakBeforeSum` : plus forte contribution individuelle après clip gain ;
- `peakAfterSum` ;
- `gainCoefficient` ;
- `peakAfterGain` ;
- `destinationBuffer`.

Cette trace complète les observations déjà présentes sur VST/routing, Mixer et Master. Elle permet de suivre réellement :

`clips -> somme piste -> volume piste -> routing/FX -> mixer -> master`

## 4. Valeurs numériques avant/après

| Cas | Avant, révision inspectée | Après et mesure |
|---|---:|---:|
| 2 clips identiques | `addSample` existait, mais sans frontière SUM isolée ; pas de mesure instrumentée avant patch | erreur max `< 1e-6`, ratio `2,000000`, `+6,0206 dB` |
| 3 clips identiques | non couvert numériquement | erreur max `< 2e-6`, résultat `3A` |
| chevauchement partiel / milieu de bloc | non couvert numériquement | somme des deux rendus indépendants, erreur max `< 1e-6` |
| boucle avec 2 clips | non couvert numériquement | `2A` au passage de wrap, erreur max `< 1e-6` |
| 2 clips, fader 0 dB | gain appliqué dans chaque clip | `2A × 1,000000` |
| 2 clips, fader -6 dB | MIDI : vélocité 100 -> 50 ; pas un gain audio | `2A × 0,501187`, erreur ratio `< 1e-6` |
| 2 clips, fader +6 dB | pas de contrôle DSP MIDI correct | `2A × 1,995262`, erreur ratio `< 1e-6` |
| Mute | mutation via rebuild du plan | sortie exactement `0`, transport inchangé |
| dynamique 0 -> -12 -> 0 dB | rebuild/panic possible | ratios `1 -> 0,251189 -> 1` sur blocs consécutifs, plan non reconstruit |
| vélocité MIDI écrite 100, fader 0,5 | 50 | 100 ; le gain 0,5 est appliqué à l’audio du VST |
| nettoyage Stop | CC123/CC120 sans registre exhaustif ; callback ancienne ré-enqueueable | Note Off explicites + CC123/CC120 ; époque ancienne rejetée |

Le test VST3 WAV réel a mesuré les peaks suivants : unité `0,650787`, Mixer 0,5 `0,325394`, piste -6 dB `0,326166`, Mixer 0,5 puis piste +6 dB `0,649246`. Les ratios sont cohérents avec 0,5, 0,501187 et 1,995262 dans les tolérances de quantification du WAV 24 bits.

Le même `renderAudioForOutput`/gain de retour VST est utilisé par le callback live et le plan cloné d’export. Les writers WAV, MP3 et OGG sont strictement en aval de ce DSP ; il n’existe pas de seconde implémentation du volume par codec.

## 5. Tests exécutés

### Tests unitaires et natifs

- suite JavaScript complète : `540/540` réussis ; inclut Patch Bay, transport, tempo, loop, UI Sequencer, volume/mute, exports, projets et provenance du package ;
- tests natifs core : `1307` checks réussis ;
- tests natifs VST3 end-to-end : `61` checks réussis ;
- deux clips alignés, trois clips, overlap partiel, débuts/fins intra-bloc et loop : réussis numériquement ;
- 0/-6/+6 dB, mute, 0/-12/0 dB et combinaison `SUM -> gain` : réussis numériquement ;
- 100 cycles Chain équivalents Play/Stop : chaque cycle contient un Note Off explicite et aucun Note On post-Stop ;
- callback productrice obsolète : Note On rejeté après changement d’époque ;
- Play immédiat après Stop : Note On de la nouvelle époque accepté ;
- note croisant la fin de boucle : Note Off au sample exact de frontière ;
- WAV/MP3/OGG générés et décodés par les tests codec natifs.

### Package Release réel

Le gauntlet Engine 2 empaqueté a réussi :

- 100 cycles Play/Stop ;
- 50 cycles avec Play/Go to Start/Play/Stop ;
- 20 cycles Play/Export/Stop/Play ;
- 3 525 événements transport confirmés ;
- 20 exports WAV valides ;
- sauvegarde/relecture projet valide ;
- zéro erreur Engine 2.

Le gauntlet export runtime a produit le même snapshot deux pistes/quatre clips en :

- WAV : 496 904 octets, signature RIFF/WAVE ;
- MP3 320 kbps : 71 040 octets, signature MPEG ;
- OGG : 19 804 octets, signature OggS.

Les trois exports sont terminés sur le worker offline, ont conservé le transport live, ont redémarré audiblement après export et sont revenus à des meters `0/0` après Stop. L’annulation MP3 pendant lecture a également conservé le live et nettoyé le fichier partiel.

### Dexed et Vital installés

`C:\Program Files\Common Files\VST3\Dexed.vst3` et `Vital.vst3` ont été chargés ensemble dans le `MiniHub.exe` livré.

- hold Dexed 20,5 s : 41 meters audibles, 21 trames de télémétrie, peak observé `0,1603105` ;
- activation Vital simultanée : peak Vital `0,3557515`, gains du Mixer inchangés ;
- Master -6 dB : `0,3358816 / 0,6701719 = 0,501187` ;
- mute des deux branches : peak final `0` ;
- trois cycles création/suppression/recréation par plugin ; éditeurs Dexed 866×674 et Vital 1400×820 ouverts/fermés ; zéro instance restante ;
- zéro erreur moteur.

Le gauntlet Stop ciblé correspond au scénario obligatoire : deux pistes, Dexed + Vital simultanés, notes de 20 PPQ, loop active 0–4, Stop au milieu du sustain, puis reprise immédiate.

- 100 cycles réussis ;
- 536 meters audibles pendant les phases Play ;
- six meters consécutifs après le 100e Stop, maximum `2,57164e-14` ;
- scénario complémentaire : loop 0–0,25 PPQ maintenue 700 ms, soit au moins cinq wraps complets ; huit meters audibles pendant les passes, puis six meters post-Stop avec un maximum `9,09599e-12` ;
- reprise immédiate : peak `0,0801754` ;
- Stop final : maximum `6,05719e-14` (silence numérique résiduel bien sous le seuil `1e-4`) ;
- aucun événement d’erreur Engine 2.

## 6. Fichiers modifiés pour cette correction

Moteur natif :

- `native/audio-engine/src/sequencer.h`
- `native/audio-engine/src/sequencer.cpp`
- `native/audio-engine/src/chain.h`
- `native/audio-engine/src/chain.cpp`
- `native/audio-engine/src/midi_graph.h`
- `native/audio-engine/src/midi_graph.cpp`
- `native/audio-engine/src/audio_graph.cpp`
- `native/audio-engine/src/engine.h`
- `native/audio-engine/src/engine.cpp`

IPC/UI :

- `src/main/engineCommandPolicy.js`
- `src/renderer/js/core/engineClient.js`
- `src/renderer/js/core/sequencerController.js`
- `src/renderer/js/modules/sequencer/sequencerModule.js`

Tests et preuve reproductible :

- `native/audio-engine/test/native_tests.cpp`
- `test/sequencer.test.mjs`
- `scripts/runtime-vst-stop-gauntlet.mjs`
- `SEQUENCER_AUDIO_MIDI_CORRECTNESS_REPORT.md`

Le worktree contenait de nombreuses modifications préexistantes liées à Engine 2 ; cette liste ne s’attribue que les fichiers touchés par le présent chantier. `sync-dist` a recopié les sources runtime correspondantes et le moteur fraîchement compilé sous `dist/MiniHub`.

## 7. Build livré et intégrité

Exécutable :

`C:\Users\666di\Desktop\LM Studio\Minilab Hub\dist\MiniHub\MiniHub.exe`

- taille : 225 580 032 octets ;
- SHA-256 : `B4245464056214A762DC5BF119A65F8A40206C21F7BEA12BC40E1FD8FECFA3B4`.

Moteur natif embarqué :

`C:\Users\666di\Desktop\LM Studio\Minilab Hub\dist\MiniHub\resources\native\mlh-audio-engine.exe`

- taille : 5 810 688 octets ;
- SHA-256 : `B4A1FEDD6A1BFD713B451314F8FFAB31071F0C3CC1DAD4C351BD63E51CC5F8A9`.

Le contrôle de provenance source/package passe dans la suite `540/540`.

## 8. Régressions et limites de qualification

Aucune régression automatisée n’a été détectée sur les éléments demandés : deux VST simultanés, Patch Bay, Play/Stop, Go to Start, loop, tempo, volume/mute, clips audio et MIDI, exports WAV/MP3/OGG et projet.

La compilation Release ne produit que des avertissements de dépréciation JUCE sur `MidiBuffer::Iterator`, sans erreur.

Une route où plusieurs pistes MIDI partagent volontairement une seule et même instance de synthé constitue un bus audio commun après l’instrument ; leurs voix ne peuvent pas recevoir des faders post-synth indépendants sans séparer les instances. Le chemin validé et utilisé par les scénarios Dexed + Vital est une piste MIDI vers une chaîne VST dédiée.

Les validations automatiques ne remplacent pas le test réel de votre projet, de vos presets, de votre matériel audio et de votre perception des tails FX. Le build est donc prêt pour ce test utilisateur, sans qualification finale anticipée.

SEQUENCER AUDIO/MIDI CORRECTNESS — READY FOR USER TEST
