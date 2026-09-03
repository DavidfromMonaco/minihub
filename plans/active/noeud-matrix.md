# Nœud Matrix — ExecPlan

**Objectif** — Un nœud `matrix`, unique par projet, gouverne dans le temps les
nœuds auxquels il est câblé par un lien `control` : scènes, états, rampes et
règles de sortie à seed reproductible, exécutées dans le moteur natif, en live
comme à l'export.

**Origine** — [ROADMAP.md](../../ROADMAP.md) §7 · spécification cible
`SPECIFICATION_MATRIX_MINIHUB.md` (révisée le 2026-09-03 contre le code réel).

**Statut** — **en attente** · plan écrit le 2026-09-03, aucune étape commencée.
Le dépôt est exactement au point de retour ci-dessous : aucune ligne de code
n'a bougé. Reprendre à l'étape 1.

---

## Contexte

**Documents à relire avant d'agir**
[INTENT.md](../../INTENT.md) §8 bis (ce qui est autorisé, et où s'arrête
l'autorisation) · [DECISIONS.md](../../DECISIONS.md) **D-004** (topologie contre
valeurs), **D-016**, **D-017**, **D-018** ·
[ARCHITECTURE.md](../../ARCHITECTURE.md) §4 (IPC), §6 (graphe), §7-8 (moteur et
threading), §11 (persistance), §13 (invariants).

**Fichiers au cœur du chantier**

| Fichier | Rôle dans ce chantier |
|---|---|
| `src/renderer/js/core/nodeTypes.js` | déclare le type `matrix` et les ports `control` |
| `src/renderer/js/core/nodeInstances.js` | ligne 289 : le piège des ports (§4.3 de la spec) |
| `src/renderer/js/core/nodeEditors.js` | la couture par laquelle l'éditeur Matrix entre |
| `src/renderer/js/core/controlBindings.js` | l'armement Learn unique que D-018 partage |
| `src/renderer/js/core/engineSync.js` | sépare topologie et valeurs — le gain Matrix est une valeur |
| `src/main/engineCommandPolicy.js` | liste blanche : trois commandes à ajouter |
| `native/audio-engine/src/transport.h` | source du BPM ; **pas** de la position (D-017) |
| `native/audio-engine/src/audio_graph.{h,cpp}` | `NodeValues`, et la branche `vst` sans gain |
| `native/audio-engine/src/engine.cpp` | dispatch des commandes ; contexte d'export cloné |

---

## Contraintes

Ce qui ne doit pas bouger.

- **Invariant 1** — aucun échantillon audio dans l'IPC. La Matrix ne transporte
  que des adresses et des valeurs de contrôle.
- **Invariant 2** — le graphe est l'autorité. Pas de câble, pas de contrôle.
  Fermer l'éditeur Matrix n'arrête rien.
- **Invariant 3** — le thread audio ne bloque jamais. Le runtime Matrix ne prend
  aucun verrou, n'alloue pas, ne fait pas d'IPC dans le callback.
- **Invariant 4** — la Matrix adresse ses cibles par `nodeId`, jamais par
  `ordinal` ni par nom.
- **Invariant 6** — **aucune clé ajoutée à `core/projectKeys.js`.** Toute la
  configuration vit dans le `content` du nœud, donc sous `nodeInstances`.
- **Invariant 8** — `unmount()` de l'éditeur retire tout, et **n'arrête pas** le
  runtime.
- **Invariant 9 et 10** — noms de plugins et de paramètres échappés ; aucun style
  inline.
- **Invariant 11** — `npm run sync:dist` à chaque étape qui touche `src/`.
- **D-004** — le gain Matrix passe par `audioNodeValues()`, jamais par
  `audioTopologyKey()`. Sinon chaque fade recompile le graphe.
- **D-017** — le compteur Matrix lit le **BPM** du `Transport`, jamais sa
  **position**.
- **Format persisté** — un projet `.minihub` sans nœud Matrix doit continuer à
  s'ouvrir sans migration ni avertissement.
- **Morpher** — `AudioNodeKind::morpher` reste dans le parseur natif et
  `'morpher'` reste dans le `supported` de `describeAudioGraph`. Il sort du menu
  d'ajout, il ne sort pas du code.

---

## Hors périmètre

Nommé explicitement, parce que chacun sera tentant en cours de route.

- **Éclater `nodeInstances.js`** (ROADMAP §4). Le chantier reste ouvert ; ce plan
  ne déplace **pas** les quatre éditeurs existants. Il n'ajoute que la fonction
  pure d'étape 1, qui est le préalable dont il a lui-même besoin.
- **Supprimer le code Morpher legacy.** Chantier séparé, après confirmation
  qu'aucun projet n'en dépend (spec §12).
- **Piste d'automation dans le séquenceur.** Refusée, et le reste
  ([INTENT.md](../../INTENT.md) §8 bis).
- **Recorder et Preset Machine** comme cibles de la Matrix (spec §4.5). Le
  contrat de capacités doit les rendre possibles, pas les livrer.
- **Entrées ou sorties `midi` sur la Matrix** (spec §3.1). Première version :
  `control` uniquement.
- **Un interrupteur « suivre le transport »** (D-017, évolution possible).
- **Étendre la façade `omni-pearl`** à l'éditeur Matrix. Par défaut `base.css`
  (D-012) ; le goût se tranche après que ça marche.

---

## Étapes

Chaque étape laisse le dépôt vert. Les étapes de la phase 1 sont découpées ;
celles des phases 2 à 4 donnent l'inventaire de fichiers et de tests et seront
affinées au début de leur phase — les écrire finement aujourd'hui serait de la
fiction.

### Phase 1 — Fondations

Sortie de phase : une Matrix câblée au Sequencer le démarre et l'arrête, la
configuration survit à une sauvegarde/recharge, et rien ne part vers un nœud non
câblé.

- [ ] **1. Extraire la construction des ports du graphe.**
      Nouveau `src/renderer/js/core/nodePorts.js` : `graphPortsFor(type, content)`,
      pure et sans DOM. Elle concatène les ports statiques de `type.ports` **et**
      les entrées audio dynamiques de `content.inputs`.
      `nodeInstances.js:289` l'appelle au lieu de reconstruire la liste.
      C'est le correctif du piège de la spec §4.3 : aujourd'hui un type portant
      `dynamicAudioInputs` **ignore** `type.ports.inputs`, donc un `ctrl-in`
      déclaré n'atteindrait jamais le graphe, sans la moindre erreur.
      Nouveau `test/nodePorts.test.mjs` — verrouille que les ports statiques non
      audio survivent sur un type à entrées dynamiques.
      Vérification : `npm test && npm run check`

- [ ] **2. Déclarer le type `matrix` et le port `ctrl-in` du Sequencer.**
      `core/nodeTypes.js` : type `matrix` (`singleton`, `stableId: 'matrix'`,
      `deletable: true`, `copyable: false`, `omniBoxCategory: 'Control'`, une
      sortie `control-out`, aucune entrée) ; `'Control'` ajouté à l'ordre de
      `listOmniBoxCategories()` ; `ctrl-in` ajouté aux entrées de `sequencer`.
      `omniBoxCategory` **retiré** du `morpher` (spec §12.1) — il disparaît du
      menu d'ajout sans être supprimé.
      Nouveau `test/matrixNode.test.mjs`.
      Vérification : `npm test`

- [ ] **3. Le modèle de scènes.**
      Nouveau `src/renderer/js/core/matrixModel.js` : scènes, lignes d'action /
      d'état / d'automation, identités stables indépendantes du nom et de la
      position, `normalizeMatrixContent()` et `validateMatrixContent()`. Pur,
      sans DOM, sans moteur.
      Une référence invalide est **conservée comme non résolue**, jamais
      réparée en silence (spec §11).
      Nouveau `test/matrixModel.test.mjs`.
      Vérification : `npm test`

- [ ] **4. Le contrat de capacités.**
      Nouveau `src/renderer/js/core/matrixCapabilities.js` : forme d'une
      capacité (id stable, libellé, type `action|boolean|continuous|enum`, plage,
      défaut, transition acceptée, adresse de cible, disponibilité) et le
      fournisseur du Sequencer — `play`, `stop`, `restart`, `goToStart`,
      `loop`. Les états réutilisent le vocabulaire de `bindingStatus()` :
      `unbound`, `disconnected`, `missing-target`, `not-ready`, `active`.
      Nouveau `test/matrixCapabilities.test.mjs`.
      Vérification : `npm test`

- [ ] **5. Contenu par défaut, normalisation, duplication.**
      `nodeInstances.js` : branches `matrix` dans `defaultContentFor()` et la
      normalisation au chargement. Aucune clé dans `projectKeys.js`.
      Nouveau `test/matrixPersistence.test.mjs` — aller-retour
      sauvegarde/recharge, et **un projet chargé ouvre la Matrix à l'arrêt**
      (spec §2.11, critère §15.G).
      Vérification : `npm test && npm run check`

- [ ] **6. L'éditeur.**
      Nouveau dossier `src/renderer/js/modules/matrix/` :
      `matrixEditor.js` (`registerNodeEditor('matrix', { render, bind })`,
      teardown par `createDisposers()`), importé pour son effet de bord dans
      `src/renderer/js/app.js`. `base.css`, aucun style inline, toute valeur
      externe échappée par `core/html.js`.
      Nouveau `test/matrixEditor.test.mjs` — rendu, et `unmount()` qui retire
      tout **sans arrêter le runtime** (invariant 8).
      Vérification : `npm test && npm run check`

- [ ] **7. L'autorité du graphe.**
      Nouveau `src/renderer/js/modules/matrix/matrixControl.js` : résout les
      cibles depuis `hub.graph.connectionsFrom(matrixId, 'control-out')` et
      **refuse** toute commande vers un nœud non câblé. Retirer le câble coupe
      immédiatement.
      Nouveau `test/matrixGraphAuthority.test.mjs` — le critère §15.A au complet,
      y compris « VST B ne reçoit strictement aucune commande ».
      Vérification : `npm test`

- [ ] **8. Le compteur de temps musical, côté natif.**
      Nouveau `native/audio-engine/src/matrix_clock.h`, en-tête seul comme
      `transport.h` : accumulateur PPQ avancé par échantillons, BPM relu à
      chaque bloc dans le `Transport` fourni, `reset()`, frontières de temps et
      de mesure. **Ne lit jamais `Transport::ppqPosition()`** (D-017).
      Ajouté aux deux cibles de `native/audio-engine/CMakeLists.txt`
      (`mlh_audio_engine` et `mlh_native_tests`).
      Nouvelle suite dans `native/audio-engine/test/native_tests.cpp` (`--core`) :
      absence de dérive contre le `Transport` à BPM constant, changement de BPM
      en cours, et le compteur qui **continue** quand le transport est arrêté.
      Vérification : `npm run build:native` (0 erreur 0 avertissement) puis
      `npm run build:native:tests` et
      `native/audio-engine/build/Release/mlh_native_tests.exe --core`

- [ ] **9. Le protocole.**
      `src/main/engineCommandPolicy.js` : `syncMatrix`, `setMatrixValues`,
      `matrixTransport`. Nouveau validateur `src/main/matrixCommand.js`, sur le
      modèle de `vstParameterCommand.js`. Méthodes correspondantes dans
      `core/engineClient.js`. Côté natif : `cmdSyncMatrix`, `cmdSetMatrixValues`,
      `cmdMatrixTransport` dans `engine.{h,cpp}`.
      L'événement `matrixState` n'est émis **qu'au changement** — scène,
      Run/Stop, autopilot — jamais périodiquement, pour ne pas inonder le
      journal (AGENTS.md §9). Aucune progression continue dedans.
      Nouveaux `test/matrixCommand.test.cjs` et `test/matrixProtocol.test.mjs`.
      Vérification : `npm test && npm run build:native`

- [ ] **10. Rendre D-017 mécanique.**
      Nouvelle règle dans `scripts/check-invariants.mjs` : aucun `setTimeout`,
      `setInterval` ni `requestAnimationFrame` dans
      `src/renderer/js/modules/matrix/` ni dans les fichiers `core/matrix*.js`.
      C'est la décision qui a coûté le plus de travail à établir ; sans règle,
      ce n'est qu'un vœu (INTENT §9).
      Vérifier que la règle **détecte** : l'introduire, la voir échouer sur une
      sonde, retirer la sonde.
      Vérification : `npm run check` (10 règles)

- [ ] **11. Promotion.**
      `npm run sync:dist`, puis le test de provenance.
      Vérification : `npm run sync:dist && npm test`

### Phase 2 — Contrôle audio et VST

Sortie de phase : un fade de 8 mesures sur un nœud VST, une rampe `Release`
20 % → 80 %, et le Learn qui capture le bon paramètre et le retrouve après
rechargement.

- [ ] **12. L'étage de gain post-chaîne des nœuds VST — il n'existe pas.**
      `audio_graph.h` : un second gain dans `NodeValues`, distinct de
      `masterLevel`. `audio_graph.cpp`, branche `vst` : l'appliquer après
      `chain->processBlock`, **lissé** (à la manière des 20 ms de
      `MasterOutput`) pour satisfaire « sans zipper noise ».
      Il se **multiplie** avec `trackGain.gain` du séquenceur, qui possède déjà
      cet emplacement ; aucun des deux n'écrase l'autre.
      `core/engineSync.js` : le porter dans `audioNodeValues()`, **jamais** dans
      `audioTopologyKey()` (D-004).
      Tests natifs `--core` : lissage, multiplication des deux gains, absence de
      recompilation pendant un fade.
      Nouveau `test/matrixGain.test.mjs`.

- [ ] **13. Le runtime natif et ses rampes.**
      Nouveaux `native/audio-engine/src/matrix_runtime.{h,cpp}` : plan
      immuable dans sa forme, valeurs en atomiques, échange de plan hors du
      thread audio, rampes évaluées au bloc depuis le compteur de l'étape 8.
      **Construit par contexte** dès maintenant (spec §9.1 révisée), pas
      seulement pour le live.
      Le remplacement d'une rampe en cours repart de la **valeur courante**,
      sans saut (spec §7.2).
      Tests natifs `--core` : rampe, remplacement de rampe, changement de BPM en
      cours de rampe, Stop pendant un fade, aucun événement rejoué en rafale.

- [ ] **14. L'arbitre de Learn (D-018).**
      Nouveau `src/renderer/js/core/learnArbiter.js` : une seule demande armée
      dans l'application, avec le nom de son propriétaire
      (`minilab` | `matrix`), et l'armement par instance explicite que
      `armLearn()` ne sait pas faire aujourd'hui.
      `core/controlBindings.js` lui délègue son armement — les persistances
      restent séparées.
      Nouveau `src/renderer/js/modules/matrix/matrixLearn.js`.
      Nouveau `test/learnArbiter.test.mjs` — armer depuis la Matrix annule
      **visiblement** un armement MiniLab, et jamais l'inverse en silence.
      Le critère §15.C au complet, y compris la ligne qui devient non résolue
      sans remapping automatique.

- [ ] **15. Adresses de paramètres et découverte.**
      Adresse stable = `nodeId` + instance de plugin + `ParamID` VST3 ; le
      libellé n'identifie rien. Réutiliser `core/vstParameterDiscovery.js`.
      L'écriture bridée (~30 Hz) vers `setParamNormalized` **en plus** de la
      rampe, pour que le potentiomètre bouge dans l'éditeur du plugin.
      Nouveau `test/matrixVstAddress.test.mjs`.
      Test natif `--vst3-e2e` : une vraie automation de paramètre, et son
      **absence** sur un plugin non ciblé.

- [ ] **16. Capacités Mixer et Arpégiateur.**
      `ctrl-in` déclaré sur `mixer`, `morpher` et `arpeggiator` — rendu visible
      par l'étape 1. Fournisseurs de capacités correspondants. Les changements
      d'arpégiateur s'appliquent sur une frontière musicale sûre, sauf demande
      explicite d'immédiat (spec §4.4).
      Nouveau `test/matrixMixerArp.test.mjs` — une entrée supprimée ne redirige
      **jamais** son automation vers une autre.

### Phase 3 — Moteur génératif

Sortie de phase : quatre scènes, une seed fixe, deux passes identiques.

- [ ] **17. Le générateur pseudo-aléatoire.**
      Nouveau `src/renderer/js/core/matrixRandom.js` + sa contrepartie native.
      Consommé **uniquement** aux transitions de scène et aux frontières de
      Random Step, indexé par `(sceneIndex, lineId, stepIndex)` — jamais par
      ordre d'appel, temps mural ou compteur de blocs (spec §8.2 révisée).
      Nouveau `test/matrixRandom.test.mjs` : deux tailles de bloc différentes
      produisent la **même** suite.

- [ ] **18. Règles de sortie et Autopilot.**
      Nouveau `src/renderer/js/core/matrixAutopilot.js` : destinations, poids,
      répétitions minimales et maximales, interdiction de répétition immédiate.
      L'interface signale les configurations impossibles (spec §8.1).
      Nouveau `test/matrixAutopilot.test.mjs`.

- [ ] **19. Run, Stop, Restart, Next Scene.**
      `Stop` annule les événements futurs, arrête les Sequencers **que la Matrix
      a démarrés**, envoie le panic, et laisse les valeurs courantes en place
      sans saut (critère §15.F).
      `Restart` réinitialise seed et compteurs.
      Tests natifs `--core` : déterminisme après Restart, aucune note bloquée.
      Nouveau `test/matrixTransport.test.mjs`.

### Phase 4 — Export, legacy, gauntlet

- [ ] **20. Snapshot d'export.**
      `engine.cpp` : le contexte d'export construit son **propre** runtime
      Matrix, sur son transport et ses chaînes clonées. Les modifications faites
      dans l'interface après le début de l'export ne l'atteignent pas.
      Une génération potentiellement infinie exige une durée explicite avant
      export (spec §10).
      Nouveau `test/matrixExportSnapshot.test.mjs` + suite native.

- [ ] **21. Morpher legacy.**
      Un ancien projet contenant un Morpher s'ouvre, garde son routage audio, ne
      reçoit aucune Matrix automatique, et le Morpher s'affiche
      **Morpher (legacy)** (critère §15.I).
      Nouveau `test/matrixLegacyMorpher.test.mjs`.

- [ ] **22. Gauntlet runtime.**
      Nouveau `scripts/gauntlets/runtime-matrix-gauntlet.mjs` : câblage réel à
      la souris dans le Patch Bay, sauvegarde, rechargement, runtime packagé.
      Exception assumée à AGENTS.md §8, inscrite dans la spec §16 révisée :
      aucun test unitaire ne peut prouver qu'un câble tiré gouverne réellement
      un plugin.

- [ ] **23. Documentation.**
      `ARCHITECTURE.md` gagne sa section Matrix et la table de `nodeTypes` gagne
      sa ligne. Les trois décisions perdent leur mention
      « décidé, pas encore implémenté ». `git mv plans/active/noeud-matrix.md
      plans/done/`.

---

## Point de retour

Branche `master`, commit `1b0e3d5` — dernier état avant ce chantier, augmenté
des seuls commits documentaires du 2026-09-03 (INTENT §8 bis, D-016 à D-018,
révisions de la spécification, ROADMAP §7). Aucune ligne de code n'a bougé
à ce point.

---

## Fini quand

Les commandes d'AGENTS.md §8, toutes vertes :

```
npm test
npm run check
npm run sync:dist
npm run build:native          # 0 erreur, 0 avertissement
npm run build:native:tests
native/audio-engine/build/Release/mlh_native_tests.exe --core
native/audio-engine/build/Release/mlh_native_tests.exe --vst3-e2e
native/audio-engine/build/Release/mlh_native_tests.exe --cross-track-isolation
native/audio-engine/build/Release/mlh_realtime_output_tests.exe
```

Plus, propre à ce chantier :

- les neuf critères d'acceptation fonctionnels de la spec §15 (A à I) passent sur
  le runtime normal ;
- `chainBlocksSkipped` et `pluginBlocksSkipped` **n'augmentent pas** pendant une
  automation normale (spec §16) ;
- `npm run check` compte **dix** règles, la dixième étant celle de l'étape 10 ;
- le gauntlet de l'étape 22 passe sur `dist/MiniHub`.

---

## Journal

**2026-09-03** — Plan écrit. Trois décisions prises avant toute ligne de code,
parce que chacune rendait le chantier faux si elle était découverte en route :
D-016 (le périmètre), D-017 (l'horloge), D-018 (le Learn partagé).

Trois mécanismes que la spécification supposait existants et qui ne le sont pas,
vérifiés dans le code : l'étage de gain post-chaîne d'un nœud VST (étape 12), la
visibilité d'un `ctrl-in` sur un nœud à entrées dynamiques (étape 1), le runtime
bi-contexte live/export (étape 13).

Une bonne surprise : la couture `core/nodeEditors.js` existe déjà et tous les
gestionnaires partagés de `nodeInstances.js` filtrent sur un `type.id` explicite.
L'éditeur Matrix n'attend donc pas ROADMAP §4.

**2026-09-03 — chantier mis en attente à la demande.** Seule la passe
documentaire est committée : `INTENT.md` §8 bis, D-016 à D-018, la spécification
révisée, `ROADMAP.md` §7 et ce plan. Le code est intact. Ce fichier est le point
d'entrée pour reprendre : lire les contraintes et le hors périmètre, puis
l'étape 1.
