# MiniHub — Rapport du gauntlet applicatif complet

Date de clôture : 24 août 2026  
Runtime de référence : `C:/Users/666di/Desktop/LM Studio/Minilab Hub/dist/MiniHub/MiniHub.exe`

## 1. Verdict global

**FAIL GLOBAL**

Le paquet final démarre, son moteur reste actif, les suites source/natives passent, sa provenance est cohérente et les exports WAV, OGG et MP3 ont réellement terminé depuis le véritable paquet. Cela ne suffit pas à prononcer un PASS global : l'ouverture immédiate des trois fichiers dans le Lecteur multimédia Windows n'a pas pu être démontrée, le MiniLab 3 physique et l'écoute humaine n'étaient pas disponibles, le scénario final VST a utilisé deux instances du même VST de test plutôt que deux instruments tiers différents, et deux helpers natifs orphelins provenant d'un crash antérieur subsistent jusqu'au redémarrage de Windows.

| Niveau de preuve | Verdict | Résultat |
|---|---:|---|
| Code source et tests JavaScript | PASS | 538/538 tests passent. |
| Build et tests natifs | PASS | 2/2 exécutables CTest passent, soit 1 304 contrôles cœur et 49 contrôles VST3 end-to-end. |
| Package et provenance | PASS | 154/154 éléments contrôlés, aucun fichier manquant, surnuméraire ou divergent. |
| Démarrage du véritable EXE | PASS | Lancement sans contournement GPU externe, renderer accessible et moteur `running` après 18 s. |
| Export logiciel WAV/OGG/MP3 | PASS | Trois exports successifs terminés, décodables par FFprobe, transport réutilisable ensuite. |
| Lecture immédiate Windows Media Player | FAIL | L'automatisation WMP reste en `OpenState=21`, `PlayState=9`, durée 0 après 10 s pour les trois formats. |
| MiniLab physique, écoute et VST tiers réels | VALIDATION UTILISATEUR REQUISE | Le matériel, l'écoute et le jeu de plugins requis n'étaient pas disponibles aux agents. |
| Propreté complète des processus | FAIL | PID 11244 et 21888, antérieurs au paquet final, restent orphelins et non terminables sans redémarrage/autorité supérieure. |

Le but du gauntlet n'étant pas d'obtenir un rapport vert, toute condition critique non effectivement validée maintient le verdict global à FAIL.

## 2. Runtime exact testé

- Exécutable : `C:/Users/666di/Desktop/LM Studio/Minilab Hub/dist/MiniHub/MiniHub.exe`
- SHA-256 EXE : `b4245464056214a762dc5bf119a65f8a40206c21f7bea12bc40e1fd8fecfa3b4`
- Manifeste : `dist/MiniHub/resources/app/runtime-provenance.json`
- SHA-256 manifeste : `94f09b16e59fea3099c36f434cc5a33defdb26e2b780c8d4a6f2dce19401565a`
- Synchronisation : `2026-08-24T02:48:50.842Z`
- Commit de référence : `601ec70976c62fda831fe7819a454035370d1f52`
- Worktree au packaging : `worktreeDirty: true`
- Electron : `43.4.0`, 74/74 fichiers contrôlés
- Application : 75/75 fichiers contrôlés
- Moteur natif SHA-256 : `99933eca469901ec829443a9a7815b8e94846ee9a93aaca71a2f6baa563a5e78`
- `src/main/main.js` SHA-256 : `935c77701bb45037d03640959abb7c38794c6f2b28299a04834aad20f80c6b6a`
- `src/main/engine.js` SHA-256 source/package : `4dac266ef2a7d41ec6e74676c57102d75c40af5b60c96ed6fa17fc24f3b28544`

Le lancement final a utilisé un profil utilisateur neuf et le débogage distant uniquement pour observer le renderer. Aucun flag GPU externe n'a été ajouté. Une contre-validation séparée a confirmé que le raccourci pointe vers ce même EXE, avec le bon dossier de travail et sans argument.

## 3. Cartographie générale

Flux principal :

```text
MiniHub.exe / Electron main
  → preload isolé et IPC borné
  → renderer (Hub, Patch Bay, Sequencer, projets, fenêtres VST)
  → EngineProcess, protocole NDJSON stdin/stdout
  → mlh-audio-engine.exe / JUCE
  → périphérique audio + graphe audio + graphe MIDI
  → chaînes VST3 + transport + Sequencer
  → rendu Master commun
  → encodeur WAV / OGG / LAME MP3
```

Le main Electron gère les fenêtres, les dialogues, le cycle de fermeture, le moteur enfant et les fichiers projet. Le preload n'expose qu'une API IPC délimitée. Le renderer possède l'état canonique du Hub, du graphe, des nodes, des chaînes VST, du Sequencer et de l'interface. `ProjectManager` capture cet état avec les états binaires VST avant une sauvegarde ou un changement destructif.

Le moteur natif JUCE gère le périphérique, le callback temps réel, les graphes audio/MIDI, les instances VST3, le transport, les notes actives et le contexte de rendu export. Le MIDI live et la lecture des clips ont des chemins distincts avant leur réunion dans les destinations VST. L'armement exclusif et le multi-arm sont décidés dans le routage canonique puis synchronisés vers le moteur.

L'export prend un snapshot du projet, prépare un contexte de rendu et des clones VST, rend toute la timeline dans le Master commun, puis encode ce même Master en WAV, OGG ou MP3. La progression est relayée moteur → main → renderer. Le scan VST s'effectue dans des helpers isolés afin qu'un plugin problématique ne bloque pas toute la découverte.

Le packaging suit désormais : build natif → reconstruction de `dist/MiniHub` → copie application/moteur/LAME/licence/runtime Electron → calcul des hashes → écriture du manifeste → estampillage du véritable EXE. Le manifeste lie explicitement le code packagé au runtime utilisateur.

États partagés sensibles identifiés : transaction d'export, transport, notes MIDI actives, capture d'états VST, scan VST, état sale du projet, chemin de projet courant, capacités moteur, fenêtres éditeur et processus helpers.

## 4. Agents et responsabilités

La contrainte d'exécution autorisait quatre agents simultanés. Les dix responsabilités demandées ont donc été couvertes comme dix axes fonctionnels par l'orchestrateur et trois agents spécialisés, sans prétendre avoir lancé dix processus indépendants.

| Axe demandé | Responsable principal | Contre-validation |
|---|---|---|
| 1. Cartographie technique | agent `map_package` | orchestrateur |
| 2. QA runtime global | agent `audio_export` | orchestrateur et `map_package` |
| 3. Audio | agent `audio_export` | orchestrateur |
| 4. MIDI et routage | agent `sequencer_runtime` | `audio_export` sur paquet réel |
| 5. Sequencer | agent `sequencer_runtime` | orchestrateur |
| 6. Export | `audio_export` pour la reproduction, orchestrateur pour les corrections natives | `sequencer_runtime` puis `audio_export` |
| 7. VST | agents `audio_export` et `sequencer_runtime` | `map_package` pour capture/provenance |
| 8. Cycle projet | agent `sequencer_runtime` | orchestrateur par tests et repack |
| 9. Interactions limites | agent `sequencer_runtime` | orchestrateur |
| 10. Package/provenance | agent `map_package` | `audio_export` par lancement strict final |

Les corrections importantes ont été revérifiées par un agent différent de leur auteur. Exemple : la coalescence des captures VST, corrigée par l'orchestrateur, a été validée par `map_package` en tests de crash/timeout et par `audio_export` dans l'EXE final. Les protections de projet proposées par `sequencer_runtime` ont été rejouées par l'orchestrateur dans la suite complète et le package reconstruit.

## 5. Défauts découverts

| ID | Défaut | État final |
|---|---|---|
| D01 | Repository et ancien package pouvaient diverger ; les tests validaient une autre copie que l'EXE utilisateur. | Corrigé |
| D02 | L'export pouvait attendre indéfiniment le callback audio, notamment sans périphérique actif ; Cancel pouvait ne jamais finaliser. | Corrigé pour le blocage ; limite d'architecture D14 restante |
| D03 | Progression et étapes d'export insuffisantes ; l'UI pouvait rester sur `Rendering offline...`. | Corrigé, avec granularité encore partielle |
| D04 | New, Load ou fermeture pouvaient détruire un projet sale avant confirmation ou préflight complet. | Corrigé |
| D05 | Save pouvait écrire malgré l'échec de capture VST ; un Save As échoué pouvait muter nom/chemin/état sale. | Corrigé |
| D06 | Un scan VST rejeté pouvait laisser le renderer dans un état de scan actif. | Corrigé |
| D07 | Après rechargement renderer, les capacités moteur, dont MP3, pouvaient ne pas être redemandées. | Corrigé |
| D08 | Le package normal lançait un sous-processus GPU qui terminait avec `0xc0000135`; le premier contournement terminait ensuite avec `0x80000003`. | Corrigé pour l'environnement testé |
| D09 | Le script de package ne reconstruisait pas de façon sûre l'intégralité du runtime ni sa provenance. | Corrigé |
| D10 | Deux captures d'états VST simultanées écrasaient le resolver unique ; Save/Close pouvaient se bloquer ou recevoir le mauvais résultat. | Corrigé |
| D11 | Une erreur de montage Routing était avalée dans un contrôle de sidebar, créant un faux résultat. | Corrigé |
| D12 | WMP ne confirme pas l'ouverture immédiate des WAV/MP3/OGG finaux malgré leur décodage FFprobe. | Non résolu / validation utilisateur requise |
| D13 | Deux helpers natifs de scan issus d'un ancien crash restent orphelins (PID 11244 et 21888). | Non résolu jusqu'au redémarrage Windows |
| D14 | Le rendu dit offline reste cadencé par le callback audio actif et n'est pas un rendu autonome plus rapide que le temps réel. | Limite restante |

## 6. Niveau d'importance

| Niveau | Défauts |
|---|---|
| Critique | D01, D02, D04, D05, D08, D09, D10 |
| Important | D03, D06, D07, D12, D13, D14 |
| Mineur | D11 |

Un défaut est critique lorsqu'il peut provoquer perte de données, blocage durable, test du mauvais binaire, impossibilité de démarrer ou incohérence de sauvegarde. Un défaut est important lorsqu'il dégrade un flux majeur ou empêche d'en apporter la preuve de bout en bout. D12 et D13 suffisent à maintenir FAIL même si le décodage des fichiers et les nouveaux lancements sont corrects.

## 7. Reproduction

- **D01/D09** : comparer les hashes source et `dist`, supprimer le dossier cible puis relancer l'ancien flux de synchronisation ; des éléments Electron et/ou applicatifs n'étaient pas couverts par une preuve exhaustive.
- **D02** : lancer un export alors que le moteur audio n'est pas réellement en callback, ou annuler pendant cette attente ; aucun terminal fiable n'arrivait.
- **D03** : envoyer plusieurs télémétries de progression identiques ; l'ancien watchdog pouvait être rafraîchi sans avancement de frame et laisser croire à une activité réelle.
- **D04** : modifier un projet, invoquer New/Load/Close, puis annuler tardivement ; les mutations natives pouvaient déjà avoir commencé.
- **D05** : faire échouer `capturePluginStates()` ou l'écriture Save As ; l'ancien flux pouvait poursuivre ou remplacer les métadonnées du projet courant.
- **D06/D07** : rejeter `scanVst3`, puis recharger le renderer ; le latch de scan et les capacités pouvaient rester obsolètes.
- **D08** : lancer directement le package sans flag externe sur un profil neuf ; crash du processus GPU `0xc0000135`, puis breakpoint `0x80000003` avec la première mitigation seule.
- **D10** : lancer deux `capturePluginStates()` avant la complétion native ; le second appel remplaçait le resolver du premier.
- **D11** : provoquer une exception au montage Routing pendant le test de groupement de sidebar ; l'exception était interceptée sans faire échouer le test.
- **D12** : ouvrir chacun des trois exports finaux via le contrôle COM WMP en PowerShell STA ; après 10 s : `OpenState=21`, `PlayState=9`, durée 0, position 0, sans erreur COM explicite.
- **D13** : après le crash d'une validation de scan, observer `mlh-audio-engine.exe --scan-file`; les PID 11244/21888 restent présents et refusent la terminaison depuis la session courante.

## 8. Causes

- Le package historique reposait sur une synchronisation partielle et sur des timestamps implicites plutôt que sur un inventaire hashé complet.
- La machine d'état d'export supposait qu'un callback audio continuerait toujours à faire progresser rendu et nettoyage. L'annulation dépendait donc elle aussi d'un callback qui pouvait ne plus arriver.
- Le watchdog renderer observait des événements, pas l'avancement réel des frames.
- Les transitions de projet mélangeaient confirmation utilisateur, capture VST, mutations natives et remplacement d'état sans transaction préalable complète.
- `EngineProcess` stockait un unique callback de capture au lieu d'une transaction partagée par les appelants concurrents.
- Le renderer ne réinitialisait pas systématiquement son état optimiste lors d'un rejet IPC et ne refaisait pas toujours le handshake moteur après reload.
- Le processus GPU Electron échouait dans cet environnement Windows avant l'affichage. La désactivation d'accélération seule ne suffisait pas ; le GPU a dû être déplacé in-process avant `app.whenReady()`.
- La cause exacte de D12 n'est pas établie. FFprobe décode immédiatement les trois fichiers, ce qui prouve leur structure générale, mais ne prouve pas la compatibilité effective avec ce WMP.
- Les helpers D13 ont survécu à un crash du harnais/processus parent ; la session actuelle n'a pas l'autorité nécessaire pour les terminer.

## 9. Corrections

- Refonte de `sync-dist` : reconstruction complète, copie Electron/application/native/LAME/licence, inventaires hashés, manifeste de provenance et EXE final estampillé.
- Si un helper Windows verrouille le moteur natif, la synchronisation ne conserve la cible que lorsque son SHA-256 est strictement identique à la source ; toute divergence reste une erreur.
- Rejet immédiat d'un export sans moteur audio actif ; terminal d'erreur structuré pour les requêtes malformées.
- Ajout des états `preparing`, `started`, `progress`, `finalizing`, `done`, `error` et des étapes de préparation, snapshot, contexte, VST, graphe, timeline, blocs, Master, encodeur, finalisation, fermeture, destruction et nettoyage MIDI.
- Watchdog de 60 s piloté par l'avancement des frames, ignorant les répétitions identiques ; télémétrie tardive ignorée après timeout.
- Annulation bornée avec grâce de 250 ms et nettoyage de contexte protégé lorsqu'aucun callback/hazard ne subsiste.
- Confirmation sale avant New/Load/Close ; préflight et staging avant mutations natives ; resynchronisation de l'ancien Sequencer si quiesce/reload échoue.
- Save refusé si la capture VST échoue ; Save As ne change plus chemin, nom ou drapeau sale tant que l'écriture n'a pas réussi.
- Garde de fermeture main/preload et état sale transmis explicitement.
- Capture VST coalescée dans une Promise unique : une commande native pour tous les appelants simultanés, résolution commune, timeout/crash/échec à `false`, complétions dupliquées sans effet.
- Rollback du latch de scan sur rejet et nouveau `hello` au refresh renderer pour restaurer les capacités, dont MP3.
- Initialisation Win32 avant `app.whenReady()` avec GPU in-process et accélération matérielle désactivée.
- Correction du test de sidebar afin qu'une exception Routing fasse réellement échouer le test.
- Ajout d'un validateur WMP STA reproductible ; il expose actuellement D12 au lieu de le masquer.

## 10. Fichiers modifiés

Fichiers directement créés ou modifiés par ce gauntlet :

- `native/audio-engine/src/engine.cpp`
- `native/audio-engine/src/engine.h`
- `native/audio-engine/src/sequencer.h`
- `src/main/main.js`
- `src/main/preload.js`
- `src/main/engine.js`
- `src/main/projectCloseGuard.js`
- `src/renderer/js/core/projectManager.js`
- `src/renderer/js/core/engineClient.js`
- `src/renderer/js/core/sequencerController.js`
- `src/renderer/js/modules/sequencer/sequencerModule.js`
- `src/renderer/js/core/buildStamp.js`
- `scripts/sync-dist.mjs`
- `scripts/validate-wmp.ps1`
- `package.json`
- `test/engineProcess.test.cjs`
- `test/projectManager.test.mjs`
- `test/projectCloseGuard.test.cjs`
- `test/engine.test.mjs`
- `test/sidebarGrouping.test.mjs`
- `test/sequencer.test.mjs`
- `test/nativeRealtimeSafety.test.mjs`
- `test/runtimeProvenance.test.cjs`
- `dist/MiniHub/**` reconstruit

Le dépôt était déjà largement sale avant ce gauntlet. Cette liste décrit les changements du présent audit et ne revendique ni ne supprime les autres modifications ou artefacts utilisateur visibles dans `git status`.

## 11. Tests ajoutés

- Concurrence de `capturePluginStates` : coalescence, une seule commande, succès commun, timeout, `_fail`, crash `_onExit` et complétion dupliquée.
- Garde de fermeture de projet sale et choix Save/Discard/Cancel.
- Échec de capture VST avant Save, atomicité Save As, staging New/Load et resynchronisation après handoff avorté.
- Export sans périphérique, progression par frames, watchdog sans faux heartbeat, télémétrie tardive et annulation bornée.
- États/stages d'export et restauration du transport/UI après succès, erreur et Cancel.
- Rollback de scan VST et récupération des capacités après reload.
- Erreurs de montage sidebar non avalées.
- Provenance dynamique source/package, hashes application/native/Electron, préconditions GPU Win32 et raccourci exact.
- Vérification WMP STA des trois formats via `scripts/validate-wmp.ps1`.

Ces contrôles ont été ajoutés ou étendus dans les fichiers cités en section 10. Les tests runtime réels restent séparés des tests unitaires afin de ne pas recréer le faux PASS historique.

## 12. Résultats automatisés

| Suite | Résultat final |
|---|---:|
| `npm test` après dernier correctif et dernier repack | **538/538 PASS**, 0 fail, 0 skipped |
| `ctest --test-dir native/audio-engine/build -C Release --output-on-failure` | **2/2 PASS** |
| Assertions `mlh_native_core_tests` | **1 304 PASS** |
| Assertions `mlh_vst3_e2e_tests` | **49 PASS** |
| Tests ciblés concurrence + provenance, contre-validation | **6/6 PASS** |
| Inventaire provenance package | **154/154 PASS** |

Le dernier `npm test` a été exécuté après la correction de concurrence et le repack final. CTest a aussi été relancé à la clôture. Aucun test n'est ignoré.

## 13. Résultats du package réel

### Démarrage et moteur

- Lancement strict de l'EXE final sur profil neuf, sans flag GPU externe : PASS.
- PID final vivant après 18 s, renderer accessible, moteur `running` : PASS.
- Deux appels simultanés `window.hubAPI.capturePluginStates()` : `[{ok:true}, {ok:true}]` en 1,3 ms, une seule `pluginStateCaptureComplete`, moteur toujours actif : PASS.
- Fermeture finale : nouvelle capture normale, `shutdownAck`, moteur `stopped`, aucun nouveau processus MiniHub/helper résiduel : PASS.

### Export réel

Séquence exécutée sans redémarrage : WAV → MP3 → OGG → Cancel → nouvel export. Les trois rendus complets ont atteint `DONE`; Cancel a rendu l'UI réutilisable et supprimé le partiel.

| Format | Fichier | Frames | Preuve |
|---|---:|---:|---|
| WAV | 496 904 octets | 82 800 | PCM 24 bits, 48 kHz, stéréo, 1,725 s |
| MP3 | 71 040 octets | 82 800 | 48 kHz, stéréo, 1,725 s |
| OGG | 9 486 octets | 82 800 | Vorbis, 48 kHz, stéréo, 1,727667 s |

Artefacts : `artifacts/runtime-export-20260824024317046.wav`, `.mp3`, `.ogg`. FFprobe les ouvre et les décode immédiatement. Les trois formats passent par le même rendu Master. Play, Stop, compteurs et un nouvel export restent fonctionnels après chacun.

Le scénario MIDI/VST final a chargé deux instances/clones du VST déterministe de test, testé focus A/B, armement exclusif et multi-arm, injecté Note On/Off pendant export et conservé correctement une note tenue jusqu'au Note Off. Export obtenu : 120 000 frames, WAV 720 104 octets, aucune erreur moteur. Cela valide la logique logicielle et l'absence de note abandonnée dans ce scénario, mais pas deux instruments tiers réellement différents.

### Matrice croisée

| Scénario | Résultat |
|---|---|
| Play → Stop → Export → Play | PASS package réel |
| Play → Stop → WAV → OGG → MP3 | PASS package réel |
| Export → Cancel → Export | PASS package réel |
| Plusieurs exports sans redémarrage | PASS package réel |
| Notes MIDI simulées maintenues → Export → Note Off | PASS package réel |
| Track 1/Track 2 exclusif et multi-arm | PASS avec MIDI/VST déterministes ; matériel physique requis |
| Playback clips indépendant du MIDI live | PASS logique/runtime déterministe ; écoute requise |
| Changement destination / suppression VST | PASS automatisé/IPC ; parcours UI utilisateur requis |
| Save → Close → Load | PASS automatisé/direct IPC ; parcours menus utilisateur requis |
| Record réel → Stop → Export | VALIDATION UTILISATEUR REQUISE |
| New/Load après longue session réelle | VALIDATION UTILISATEUR REQUISE |

### Lecture externe

FFprobe : PASS pour les trois formats. Windows Media Player COM, y compris Windows PowerShell STA : FAIL/inconclusif pour les trois, avec `OpenState=21`, `PlayState=9`, durée 0 après 10 s et aucune erreur COM explicite. La condition « immédiatement lisible dans le Lecteur multimédia Windows » n'est donc pas déclarée PASS.

## 14. Régressions trouvées

1. Le premier watchdog d'export pouvait considérer des paquets de progression identiques comme une activité : corrigé pour exiger une avancée de frame.
2. Le premier fallback Cancel pouvait tenter un nettoyage alors qu'un callback détenait encore le contexte : corrigé par une grâce et `tryClearExportContext()` protégé.
3. La simple désactivation d'accélération GPU supprimait un crash mais révélait un breakpoint `0x80000003` : corrigé par l'initialisation GPU in-process avant ready.
4. La correction tardive de capture concurrente a rendu le test de provenance rouge tant que `dist` n'était pas repackagé : le test a correctement empêché un faux PASS ; repack puis 6/6 PASS.
5. Un contrôle sidebar masquait une exception de montage Routing : test durci puis suite verte.
6. Un harnais runtime externe dépendait d'un fixture `artifacts/sequencer-export-transport.wav` absent : classé défaut du harnais, pas du produit ; les validations finales ont produit leurs propres fichiers.
7. Le run WMP a montré que « décodable par FFprobe » n'équivaut pas à « ouvert immédiatement par WMP » : D12 reste ouverte.

## 15. Anciens faux PASS expliqués

| Ancien contrôle | Pourquoi il passait | Usage réel non couvert | Nouveau contrôle |
|---|---|---|---|
| Test de commande export | Vérifiait surtout la sérialisation/démarrage. | Fin réelle, fichier fermé, UI débloquée, second export. | Exports successifs depuis l'EXE, terminal `DONE`, décodage et réutilisation transport. |
| Tests source | Exécutaient le repository courant. | Le raccourci pouvait lancer une ancienne copie. | Manifeste hashé 154/154, EXE/raccourci exact et lancement du package. |
| Présence MP3 dans le code | Le codec existait côté moteur. | Capacité absente après reload renderer. | Handshake `hello` au refresh et export MP3 réel. |
| Heartbeat export | Tout événement repoussait le timeout. | Frames figées avec UI indéfiniment active. | Watchdog fondé sur l'avancement réel des frames. |
| Export valide par parseur | FFprobe lisait le conteneur. | WMP pouvait encore refuser/attendre. | Test WMP STA distinct ; résultat actuel FAIL/inconclusif. |
| Save séquentiel | Une seule capture VST était en vol. | Save et Close concurrents écrasaient leur resolver. | Deux appels simultanés, une commande, résolution commune + crash/timeout. |
| Garde projet partielle | Testait l'état final nominal. | Cancel ou échec après mutations natives. | Confirmation et staging avant mutation, tests de rollback/resync. |
| Démarrage avec flags | Un flag de harnais contournait le GPU. | Double-clic normal du package. | Lancement sans flag GPU externe sur profil neuf. |
| Test de sidebar tolérant | L'exception Routing était attrapée. | Échec de montage réel masqué. | Exception désormais fatale au test. |

La règle appliquée est désormais : un PASS unitaire ne devient pas un PASS runtime, et un PASS runtime déterministe ne devient pas un PASS matériel ou perceptif.

## 16. Limites restantes

- D12 : compatibilité immédiate WMP non démontrée.
- Aucun MiniLab 3 physique n'a été connecté ; l'identité des contrôles et le routage sont testés en logiciel seulement.
- Aucune écoute humaine n'a vérifié silence, contenu de tous les clips, clipping, craquements, note finale et sommation perceptive.
- Le dernier runtime VST utilise deux instances du même VST déterministe. Deux instruments tiers différents, plusieurs FX réels, LANDR, UI plugin, Learn et Last touched doivent encore être essayés ensemble.
- Les parcours visibles complets New/Save/Save As/Load/Close/dialogue export n'ont pas tous été cliqués manuellement ; les preuves sont surtout unitaires, IPC et runtime piloté.
- Les PID 11244 et 21888 restent orphelins. Le script de package peut tolérer leur verrou seulement si source et cible natives ont exactement le même hash ; une future modification native exigera leur disparition.
- Le rendu export reste cadencé par le callback audio actif. Il ne peut plus rester silencieusement bloqué sans périphérique, mais ce n'est pas encore un moteur offline autonome/faster-than-realtime.
- Plusieurs marqueurs `*:end` de finalisation sont émis après une phase groupée de `serviceEvents()` ; l'observabilité est utile mais certains débuts/fins ne correspondent pas encore à une opération atomique distincte.
- Le contournement GPU est validé sur cette machine pendant des lancements courts, pas sur une longue session multi-écrans ou sur d'autres pilotes.
- `worktreeDirty: true` : l'artefact est vérifiable par hashes, mais il n'est pas reproductible depuis le commit `601ec709…` seul.
- La lecture et l'enregistrement avec un véritable périphérique audio/ASIO n'ont pas été validés par écoute.

## 17. Validations utilisateur encore nécessaires

Chaque point suivant porte explicitement le statut **VALIDATION UTILISATEUR REQUISE** :

1. **Redémarrer Windows**, puis confirmer dans le Gestionnaire des tâches que les anciens PID 11244 et 21888 ont disparu et qu'aucun `mlh-audio-engine.exe --scan-file` ne subsiste.
2. **Démarrage normal** : double-cliquer trois fois, séparément, le raccourci habituel puis l'EXE exact. Attendre 30 s à chaque fois, fermer normalement et vérifier qu'aucun processus MiniHub/helper ne reste.
3. **MiniLab 3 physique** : sélectionner Track 1 puis Track 2, jouer et vérifier qu'un seul instrument reçoit le live en armement exclusif ; activer volontairement le multi-arm et vérifier que les deux le reçoivent. Tenir des notes pendant Stop, Export et Cancel, puis confirmer qu'aucune note ne reste active.
4. **VST tiers réels** : créer deux pistes MIDI avec deux instruments VST3 différents, ajouter plusieurs FX dont LANDR si installé, ouvrir/fermer leurs UI, essayer Learn et Last touched, sauvegarder, fermer et recharger. Vérifier sons, paramètres, ordre, bypass, routage et états restaurés.
5. **Export par l'UI seulement** : construire plusieurs clips à des positions distinctes, sélectionner volontairement un seul clip, puis exporter WAV → OGG → MP3 vers un dossier vide sans redémarrer. La sélection ne doit pas modifier le mix ni la fin de timeline.
6. **Windows Media Player** : immédiatement après chaque export, ouvrir le fichier `Untitled Mix` dans le Lecteur multimédia Windows. Confirmer absence de `0x80070323`, démarrage immédiat, durée correcte et seek fonctionnel.
7. **Écoute comparative** : écouter les trois exports de bout en bout et confirmer toutes les pistes/clips, leurs positions et niveaux, l'absence de clipping/craquements/silence inattendu, la fin exacte de la dernière note et un mix identique entre codecs hors pertes de compression.
8. **Annulation** : lancer un export long, annuler au milieu, vérifier disparition du partiel et UI débloquée, puis réussir immédiatement un nouvel export dans chacun des trois formats.
9. **Record réel** : enregistrer une entrée audio et du MIDI, Stop, lire, exporter, puis vérifier monitoring, contenu enregistré, synchronisation et restauration du transport.
10. **Cycle projet par menus** : projet complexe sale → New/Load/Close ; essayer successivement Cancel, Discard et Save. Tester aussi Save As vers une destination volontairement non inscriptible et confirmer que le projet courant conserve nom, chemin et état sale.
11. **Session longue** : pendant au moins 30 minutes, alterner Play/Stop, tempo, loop, zoom/scroll, drag groupé, copier/coller/dupliquer, changements de destination, suppression/recréation de VST, fenêtres secondaires, exports et New/Load. Vérifier absence de crash, dérive, bouton bloqué, silence et fuite de processus.
12. **Clôture** : fermer MiniHub après cette session et confirmer dans le Gestionnaire des tâches qu'il ne reste ni MiniHub, ni moteur, ni helper de scan.

Tant que les points 1, 3, 4, 6, 7, 9, 11 et 12 ne sont pas effectivement observés, le verdict global doit rester **FAIL**.
