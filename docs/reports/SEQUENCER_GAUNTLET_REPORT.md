# SEQUENCER GAUNTLET REPORT

Date : 23 août 2026

Baseline Git observée : `601ec70976c62fda831fe7819a454035370d1f52` (`master`)

Verdict logiciel final : **PASS**

## Validation status

**SOFTWARE / ENGINE VALIDATED**

**PHYSICAL HARDWARE NOT AVAILABLE**

**HUMAN LISTENING NOT PERFORMED**

L'absence de MiniLab physique et d'écoute humaine est une limite de validation matérielle, pas un échec logiciel. Toutes les gates logicielles ciblées, les régressions, le moteur Release et les contrôles UX packagés exécutables sont au vert. Le correctif UX post-gauntlet Record/Stop et multi-pistes/multi-VST est également validé dans le package final.

Le worktree contenait déjà de nombreuses modifications avant ce gauntlet. Elles ont été préservées : aucun reset, clean ou checkout destructif n'a été effectué.

## Human arbitrations implemented

| Arbitrage | Résultat | Preuve principale |
|---|---:|---|
| Singleton Sequencer par projet | PASS | `singleton: true`, ID stable `sequencer`, duplication refusée, seconde création refusée |
| Aucun Sequencer automatique au New | PASS | projet neuf sans instance ; bootstrap réel et package vérifiés |
| Ajout explicite depuis Patch Bay | PASS | sélecteur `Sequencer` + `+ New Node` |
| Node supprimable | PASS | action packagée `Delete Node` et test d'intégration réel |
| Suppression = node, câbles et routing seulement | PASS | node et connexions disparaissent ; arrangement inchangé |
| Réajout = données existantes, jamais second arrangement | PASS | réapparition de la piste et du clip d'origine ; une seule instance |
| Save/reload absent puis réajout/save/reload | PASS | round-trip disque avec node absent, puis présent exactement une fois, arrangement identique |
| Snapshot d'export figé | PASS | plan Sequencer export-owned + transaction native/renderer sur graphes, transport, chaînes, VST et MIDI output |
| Changement de routing pendant export | PASS | mutations différées dans l'ordre ; bounce courant inchangé ; export suivant sur le nouvel état |
| New/Load pendant Record | PASS | refus visible avant toute transition et après chaque frontière asynchrone |
| Record/Stop visibles et diagnostic d'enregistrement | PASS | Record reste actionnable et affiche la cause exacte ; Stop est un contrôle distinct dans le header et le Sequencer |
| Plusieurs pistes vers plusieurs VST | PASS | champs Input/Destination explicites ; deux pistes vers VST 1/VST 2 créent deux câbles MIDI indépendants |

## 1. Sequencer lifecycle

Le Sequencer est un singleton de projet :

- un projet neuf ne contient aucun node Sequencer ;
- l'utilisateur l'ajoute explicitement dans le Patch Bay ;
- l'ID stable est `sequencer` ;
- la duplication et une seconde création retournent un refus sans mutation ;
- le node expose exactement `MIDI IN`, `AUDIO IN`, `MIDI OUT`, `AUDIO OUT`.

La suppression retire :

- l'instance de routing ;
- le node graphique ;
- son layout ;
- tous ses câbles et le routing natif correspondant.

Elle ne désenregistre pas la page fixe Sequencer et ne touche pas `sequencerState`. Tant que le node est absent, la page montre l'empty-state `Patch Bay required`. Après réajout, le même contrôleur de projet réutilise pistes, clips, notes, médias, loop et mix existants.

Le test disque couvre la séquence complète suivante : save avec node → reload → suppression → save/reload sans node → arrangement encore présent → réajout → save/reload → exactement un node et arrangement original inchangé.

## 2. Frozen Master Export

Le rendu capture maintenant un état cohérent au démarrage :

- `SequencerEngine` publie un pointeur de plan d'arrangement dédié à l'export ;
- les plans remplacés restent vivants jusqu'à la fin du bounce ;
- le client renderer bloque les mutations de rendu dès l'envoi de `sequencerExport` ;
- le moteur natif constitue la seconde frontière autoritative et diffère les commandes même si le client est contourné ;
- les mutations sont rejouées, dans l'ordre, uniquement après l'événement terminal de l'export ;
- une transition projet annule l'export et jette les mutations appartenant à l'ancien projet.

La transaction couvre notamment :

- graphes audio et MIDI ;
- arrangement Sequencer ;
- transport ;
- routing et gates de chaînes ;
- création, suppression, ordre, bypass, état et paramètres VST ;
- device audio et sortie MIDI physique ;
- ouverture/remise au premier plan d'éditeurs VST.

Deux courses supplémentaires sont fermées :

- un export est refusé clairement tant qu'un worker de création VST peut encore installer un processor ;
- les éditeurs VST visibles sont fermés avant la première frame, car leurs contrôles peuvent écrire directement dans l'`AudioProcessor` sans passer par l'IPC.

Le panic de sécurité reste immédiat sur la sortie MIDI physique pendant le bounce. Il ne modifie pas l'état musical Sequencer/chaînes/Arpeggiator du rendu figé. Les inputs MIDI temps réel reçus pendant le bounce sont ignorés et ne sont jamais rejoués tardivement.

Le test C++ rend un vrai WAV, modifie l'arrangement au milieu du rendu et démontre que le fichier courant garde l'ancien plan. L'export suivant consomme naturellement le nouvel état.

## 3. New / Load during Record

`New`, template Basic et `Load` refusent une transition si Record est actif. Le refus :

- émet `project:blocked` avec la raison `recording-active` ;
- affiche `Cannot … while recording. Stop recording first.` ;
- ne stoppe pas et ne commit pas la prise ;
- ne démonte aucun VST ;
- ne stage aucun projet ;
- ne recharge pas le renderer.

`Load` revérifie Record avant le picker, après le picker et après la lecture disque. `_replace` revérifie encore après l'ack de quiescence. Un verrou de transition empêche symétriquement Record de démarrer pendant le court handoff projet ; il est libéré dans un `finally`.

## Targeted gauntlet

Commande :

`node --test test/projectManager.test.mjs test/sequencer.test.mjs test/sequencerProductAcceptance.test.mjs test/engine.test.mjs test/nativeRealtimeSafety.test.mjs`

Résultat : **62 tests, 62 PASS, 0 FAIL**.

Couverture ciblée :

- suppression/réajout du node ;
- conservation pistes, clips et notes ;
- absence de second Sequencer et duplication refusée ;
- save/reload pendant absence puis après réajout ;
- New et bootstrap réel sans Sequencer ;
- snapshot d'arrangement déterministe ;
- mutations de routing/mixer/VST/transport pendant export ;
- chargement VST asynchrone et éditeur VST pendant export ;
- New/Load refusés à toutes les frontières pendant Record ;
- Record refusé pendant une transition projet.

Une relecture indépendante finale a exécuté sa sélection ciblée (**51/51 PASS**) puis approuvé explicitement l'implémentation sans écart de correction, sécurité ou concurrence.

Correctif UX ciblé post-gauntlet :

`node --test test/sequencer.test.mjs test/sequencerUi.test.mjs test/sequencerProductAcceptance.test.mjs`

Résultat : **40 tests, 40 PASS, 0 FAIL**.

Cette sélection vérifie notamment que Record n'est plus silencieusement grisé quand une précondition manque, que la cause est affichée, que Stop est distinct, et que deux pistes MIDI conservent chacune leur destination VST et leur câble Patch Bay.

## Full regressions

- JavaScript : `npm test` → **462 tests, 462 PASS, 0 FAIL**.
- Natif core : `mlh_native_tests.exe --core` → **1177 checks PASS**.
- VST3 direct/E2E : `mlh_native_tests.exe --vst3-e2e` → **33 checks PASS**.
- Natif complet : `mlh_native_tests.exe --all` → **1210 checks PASS**.
- CTest Release : **2/2 PASS**, 0 échec.
- Contrôles syntaxiques source et package : **PASS**.

Le VST3 E2E construit et charge un vrai VST3 déterministe, vérifie Note On/Off, buffers audio, graphes MIDI/Arpeggiator et exports. Cette validation est au niveau processor/buffers/WAV ; elle ne prétend pas remplacer une écoute humaine.

## Release build and package

Le moteur et les tests ont été reconstruits en Release avec environnement `PATH` normalisé et build séquentiel, nécessaire parce que l'environnement de validation expose simultanément `Path` et `PATH` à MSBuild 18.

`npm run sync:dist` a resynchronisé **63 fichiers**, recréé/stampé l'exécutable, puis le moteur Release testé a été copié dans le package.

- `dist/MiniHub/MiniHub.exe` : 225 580 032 octets ; SHA-256 `B4245464056214A762DC5BF119A65F8A40206C21F7BEA12BC40E1FD8FECFA3B4`.
- moteur Release : 5 652 480 octets ; SHA-256 `925CB35F15D9C2BCD4517B4183E26F5119D582E464B1E87081551F3902A5D35E`.
- moteur embarqué : même taille et même SHA-256 ; correspondance **TRUE**.

L'environnement graphique isolé du runner faisait échouer le subprocess GPU Chromium (`GPU process isn't usable`). La validation packagée a donc été relancée avec rendu GPU in-process/désactivé. Le renderer, le moteur natif embarqué et les interactions produit ont alors fonctionné normalement. Il s'agit d'une contrainte du harness graphique, pas d'une gate fonctionnelle Sequencer.

## Packaged UX validation

Exécutable : `dist/MiniHub/MiniHub.exe`, profil neuf isolé, inspection DOM et capture via Chrome DevTools Protocol.

Scénario exercé dans le package final :

1. ouverture d'un projet neuf : aucun node Sequencer ;
2. ajout explicite depuis Patch Bay : exactement un node et quatre ports typés ;
3. nouvelle tentative d'ajout : toujours une seule instance ;
4. création d'une piste MIDI et d'un clip ;
5. suppression via le menu `Delete Node` : node absent et page `Patch Bay required` ;
6. réajout : exactement un node, `MIDI 1` et `MIDI Clip` réapparaissent ;
7. fermeture propre : capture finale des états plugin, arrêt moteur, aucun processus MiniHub ou moteur résiduel.

Scénario UX Record/Stop et multi-VST exercé avec un second profil neuf :

1. ajout explicite d'un Sequencer et de deux nodes VST ;
2. création de deux pistes MIDI ;
3. présence simultanée de Record et Stop dans le header et dans le panneau Sequencer ;
4. piste armée sans MiniLab physique : Record reste cliquable et le message visible indique `No MIDI input is detected or selected` ;
5. champ `Input` explicite indiquant `No MIDI input detected` ;
6. affectation de `MIDI 1` à `VST 1 — VST chain` et de `MIDI 2` à `VST 2 — VST chain` ;
7. confirmation dans le Sequencer de `Output cable connected` sur les deux pistes ;
8. confirmation dans le Patch Bay de deux câbles distincts `sequencer.midi-out → vst-001.midi-in` et `sequencer.midi-out → vst-002.midi-in` ;
9. fermeture propre, moteur natif arrêté et aucun processus résiduel.

Capture finale : `artifacts/sequencer-gauntlet/screenshots/arbitration-delete-readd-retained.png`

SHA-256 : `1E612158276D54481A52B56357C102FCC9A1B067F9C41398ED3794BAEBB97ACE`

Captures du correctif UX :

- `artifacts/sequencer-gauntlet/screenshots/record-stop-multivst-routing.png` — SHA-256 `196027EDE686B5071F370B37513AF33E852C6DDCA5452CF6C735A408BA3E6DA7` ;
- `artifacts/sequencer-gauntlet/screenshots/two-tracks-two-vst-patch-bay.png` — SHA-256 `FBF880474AC5F7A9D8B86B65ACB36CE4418E326A14EB7F5EFE62968FD0A15AD6`.

Le dialogue OS Save/Load n'a pas été piloté visuellement jusqu'à choisir un fichier. Le même chemin projet est couvert par le vrai writer atomique, reader, snapshots, bootstrap renderer et les round-trips disque d'acceptation décrits plus haut.

## Validation boundaries

### SOFTWARE / ENGINE VALIDATED

Lifecycle, singleton, persistence, quatre ports, routing autoritatif, capture MIDI/audio déterministe, VST3 réel, Arpeggiator, export WAV figé, transitions projet, build Release, package et régressions : **PASS**.

### PHYSICAL HARDWARE NOT AVAILABLE

Aucun MiniLab 3 physique n'était détecté pendant ce run. Les tests couvrent le protocole, le graphe, le timing, le MIDI hardware sink et les protections anti-stuck-notes, mais ne revendiquent pas une performance manuelle sur contrôleur réel.

### HUMAN LISTENING NOT PERFORMED

Aucune écoute humaine via haut-parleurs/casque n'a été effectuée. Le signal est validé de manière déterministe par le processor VST3, les buffers et les fichiers WAV.

## Final verdict

**PASS — SOFTWARE / ENGINE VALIDATED**

Les deux limites matérielles ci-dessus restent documentées sans dégrader le verdict logiciel du Sequencer.
