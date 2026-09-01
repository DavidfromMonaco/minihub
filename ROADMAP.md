# MiniHub — Feuille de route

Document de pilotage unique : ce qui a été fait, ce qu'il reste à faire.
Pour comprendre l'application et son code, voir [BLUEPRINT.md](BLUEPRINT.md).

**État actuel** — branche `master`, commit `f4ec31f`.
553 tests JS au vert, 3 952 vérifications natives au vert, build Release propre
(0 erreur, 0 avertissement), `dist/` synchronisé avec les sources.

L'objectif de toute cette passe est la **consolidation avant ajout de nouveaux
modules**. Les points 1 à 3 ont supprimé les obstacles structurels ; le point 4
est le seul vrai chantier restant avant qu'ajouter un module devienne mécanique.

---

## Fait

### 1. Point de retour et hygiène du dépôt — `c3c00c9`

Le dépôt était décroché du code réel depuis `601ec70` : tout le moteur audio
actuel (`sequencer.cpp`, `audio_graph.cpp`, `master_output.cpp`, `midi_graph.cpp`,
`engine2/`) n'était pas versionné, et une centaine de fichiers sources étaient
modifiés ou absents. Il n'existait aucun état vers lequel revenir.

- 216 fichiers committés, 8,5 Mo, après vérification complète.
- `.gitignore` étendu : il ne couvrait qu'un seul arbre de build sur sept.
- Dépôt compacté : `.git` 120 Mo → 5,6 Mo (1 521 objets libres, aucun pack).
- Cohérence source↔binaire prouvée : le rebuild n'a **rien relinké**, donc les
  sources committées sont exactement celles qui ont produit l'exécutable qui
  fonctionne.

### 2. Purge et archivage documentaire — `4ba5934`

Disque : **13,7 Go → 3,9 Go**.

- Six arbres de build natifs abandonnés supprimés (`build-asan` 5,4 Go,
  `build-ninja`, `build-clip-editing*`). `build/` — celui qui fait autorité —
  intact.
- Builds, SDK et captures des deux prototypes supprimés ; leurs **sources**
  conservées et versionnées (Engine 2 vit désormais dans
  `native/audio-engine/src/engine2/`, compilé).
- `artifacts/` 300 Mo → 58 Mo, de façon chirurgicale : 15 rapports citaient
  43 chemins `artifacts/` comme pièces justificatives, une purge en bloc les
  aurait orphelins. Seuls sont partis les profils Chromium jetables et les
  98 rendus audio qu'aucun rapport ne citait.
- Les 25 rapports historiques ont été archivés, puis remplacés par les deux
  documents actuels. Ils restent consultables dans l'historique git au commit
  `c3c00c9`.

### 3. Unification des identités partagées — `f4ec31f`

Quatre duplications qui piégeaient l'ajout d'un module.

- **`core/systemNodes.js`** — `'minilab-3'` était redéclaré dans **neuf
  modules** sous trois noms différents, `'audio-output'` dans trois. Mode de
  panne silencieux : une copie oubliée lors d'un renommage ne lève aucune
  erreur, le graphe cesse simplement de correspondre.
- **`core/projectKeys.js`** — la liste projet/application existait en double.
  Une clé ajoutée d'un seul côté échoue dans deux directions opposées : valeur
  périmée survivant dans un nouveau projet, ou état de projet écrit dans les
  préférences globales.
- **`main/settings.js`** — `DEFAULTS` déclarait 6 clés pour 17 utilisées, et
  contenait `graphConnections` qui est de l'état de projet.
- **`ModuleSystem.unregister`** défait maintenant exactement ce que `register`
  fait, nœud de routage compris. Deux tests verrouillent la symétrie, et leur
  capacité à détecter la régression a été vérifiée en désactivant le correctif.

### Hors numérotation

- Instantanés du 24/08 préservés en branches (`snapshot/2026-08-24-*`) puis les
  deux dossiers `.old` supprimés : **23,3 Go → 4,7 Go** sur le disque. Le code
  qu'ils contenaient ne pesait que 4 Mo ; tout le reste était regénérable.
- `dist/` resynchronisé. Le manifeste de provenance déclarait `gitHead 601ec70`
  avec `worktreeDirty: true` — il ment donc moins désormais.
- Cette documentation : `BLUEPRINT.md` + `ROADMAP.md` remplacent 25 fichiers
  Markdown éparpillés à la racine.

---

## À faire

### 4. Éclater `nodeInstances.js` — le vrai chantier

**C'est ce qui bloque réellement l'ajout de modules.**

[nodeInstances.js](src/renderer/js/core/nodeInstances.js) fait 1 143 lignes et
est devenu un fichier-dieu. Son `_registerModule()` contient un `mount()` de
**440 lignes** (lignes 651 à 1090) qui gère **quatre éditeurs différents** —
VST, Arpégiateur, Mixer, Morpher — via 26 tests `type.id === '…'` disséminés
dans 9 gestionnaires d'événements, chacun commençant par
`if (type.id !== 'X') return;`.

Conséquence concrète : ajouter un type de nœud impose d'éditer ce fichier à une
dizaine d'endroits, dans du code partagé avec quatre autres types.

**Cible proposée :**

```
core/nodeInstances.js     registre pur : identité, contenu, persistance,
                          création/suppression/duplication
core/nodeEditors.js       table typeId → { render, bind }
modules/vst/…             éditeur VST (chaîne, scan, bindings CONTROL)
modules/arpeggiator/…     éditeur arpégiateur (déjà à moitié sorti dans
                          core/arpeggiatorEditor.js)
modules/nativeAudio/…     éditeur Mixer + Morpher (ils partagent déjà leur rendu)
```

Sous-tâches :

- extraire un utilitaire `createDisposers()` : `mount()` enregistre aujourd'hui
  9 écouteurs DOM, miroités à la main à **trois** endroits (déclaration,
  stockage sur `module._onX`, retrait dans `unmount`). Ajouter un écouteur
  demande de toucher les trois.
- remonter `NATIVE_VALUE_COALESCE_MS` (déclaré au milieu du bloc d'imports,
  ligne 54) et le regroupement d'écritures dans l'utilitaire partagé.
- documenter le contrat d'éditeur dans le BLUEPRINT une fois stabilisé.

**Bénéfice attendu** : un nouveau type de nœud = un nouveau dossier + une ligne
dans la table, sans toucher au registre.

### 5. Code mort, doublons et journalisation

Inventaire établi lors de l'audit, tout est vérifié.

**Réellement mort** (aucune référence, ni dans `src/`, ni dans `test/`) :
`buildStampLabel`, `isMiniLab3Name`, `PORT_TYPES`, et trois `dispose()` jamais
appelés (`ControlBindingManager`, `HardwareConfigManager`, `SequencerController`
— seul celui d'`EngineClient` sert, dans les tests).

**Sur-exporté** (utilisé uniquement dans son propre fichier) : `clearFollowingTies`,
`pitchRowsForPattern`, `pitchLabel`, `TEMPO_MIN`, `TEMPO_MAX`, `PLUGIN_FAMILIES`,
`knobArcDash`, `knobPointerTransform`, `pearlKnob`, `dockHeight`, `DOCK_MIN_H`,
`PORT_ROW`, `PAD_BOTTOM`, `MINILAB_NODE_HEIGHT`, `renderControlBindings`.

**Doublons** :

- `dedupeDevices` (`src/renderer/js/modules/audioOutput/audioOutputModule.js:32`)
  et `uniqueDevices` (`src/renderer/js/core/hardwareConfig.js:20`)
  — même fonction, deux versions ;
- cinq définitions distinctes de `clamp` ;
- deux `formatDb` aux sémantiques différentes (dBFS contre gain→dB) ;
- `identityHeight(node)` ignore son paramètre
  (`src/renderer/js/core/nodeGeometry.js:32`) ;
- `export const homeModule` (`src/renderer/js/modules/home/homeModule.js:55`)
  n'existe que pour un test et duplique la `navEntry` du module réel.

**Journalisation** — `src/renderer/js/core/engineClient.js:204`
fait un `console.log` sur **chaque** événement moteur, y compris `masterMeter`
(10 Hz), `transport`, `hostTiming`, `audioPathTelemetry`. Et
`src/main/main.js:89` relaie chaque message console du renderer vers
le processus principal. C'est exactement ce que
[engineEventTrace.js](src/main/engineEventTrace.js) a été écrit pour empêcher —
sauf que ce filtre ne couvre que le chemin disque. La méthode `command()` juste
en dessous (ligne 401) applique déjà le bon filtrage ; `_onEvent` doit reprendre
la même logique.

**Identité côté C++** — `native/audio-engine/src/midi_output.h:56`
code en dur `id == "minilab-3"` dans `isPhysicalMidiDestination()`. C'est la
contrepartie native de ce que le point 3 a unifié côté JS ; l'invariant 7 du
BLUEPRINT n'est donc pas encore complet.

**Échappement** — `src/renderer/js/core/nodeInstances.js:240`
interpole `${instance.name}` sans `escapeHtml`, seule exception parmi les
gabarits voisins. Non exploitable (le nom est dérivé du type et de l'ordinal),
mais à aligner.

### 6. Cohérence visuelle et nommage

**Deux systèmes de design coexistent.** `base.css` (1 486 lignes, langage
`.panel`/`.btn`, utilisé par 9 fichiers) et `omni-pearl.css` (967 lignes,
langage `op-*`, utilisé par le **seul** arpégiateur). `clip-editor.html` ne
charge même pas le second. Migration à moitié faite : il faut trancher lequel un
nouveau module doit utiliser, puis converger.

**Quatre noms pour un même produit** : « MiniLab Hub » (titre de fenêtre,
README), « MiniHub » (exécutable, `dist/MiniHub`, extension `.minihub`,
`Documents/MiniHub`), `minilab-hub` (nom npm, fichier journal), `mlh_` (préfixe
natif). À unifier, en gardant à l'esprit que le nom du fichier journal et le
répertoire `%APPDATA%` sont des chemins existants chez l'utilisateur.

**Style d'écriture** — des passages proprement formatés voisinent avec des
lignes compressées quasi illisibles : `nodeInstances.js:316-323` et `341-355`,
`engineSync.js:35`, `engineClient.js:655`. À homogénéiser au fil des passages,
sans passe cosmétique dédiée.

---

## Idées au-delà de la consolidation

Sans engagement ni priorité — noté pour ne pas l'oublier.

- Les types de nœuds `video` et `image` existent dans le registre avec des ports
  vides ; rien ne les implémente.
- Le README annonçait « sends, sidechains, automation, gestion de presets,
  minimap, annuler/refaire, disposition automatique du graphe, groupes de
  nœuds » comme hors périmètre. Ils le restent.
- Les dix scripts `runtime-*-gauntlet.mjs` sont des harnais ponctuels liés à des
  investigations closes. À regrouper sous `scripts/gauntlets/` ou à retirer une
  fois leur usage confirmé caduc.
