# Module de presets universel — ExecPlan

**Objectif** — Un nœud **Preset** que l'on câble sur un nœud VST, qui identifie
seul le plugin ciblé et ne propose que les presets qui lui correspondent :
d'abord ceux présents sur le disque, puis ceux des banques publiques en ligne.
Appliquer un preset ne coupe jamais l'audio.

**Origine** — [INTENT.md](../../INTENT.md) §8 (levée du refus sur la gestion de
presets) et §7 (réseau autorisé, confiné). Demande formulée le 2026-09-02.

**Statut** — **en veille** depuis le 2026-09-03, après l'étape 8 sur 9.
Décision de l'auteur : suspendre pour étudier une source de presets dédiée
plutôt que de dépendre de sources tierces. Le plan reste dans `plans/active/`
parce qu'aucun autre chantier MiniHub ne l'a remplacé ; l'étape 9 est la seule
qui reste, et trois correctifs de sécurité sont en attente (voir Journal).

---

## Contexte

**Ce qui existe déjà et qu'il faut réutiliser :**

- `native/audio-engine/src/plugin_host.cpp:1718` — `getState()` / `setState()`
  produisent et consomment un document `<VST3PluginState>` portant deux chunks
  base64 : `IComponent` et `IEditController`, encapsulés par
  `juce::AudioProcessor::copyXmlToBinary`.
- `native/third_party/vst3sdk/public.sdk/source/vst/vstpresetfile.h:36` — le
  conteneur `.vstpreset` porte exactement les mêmes chunks
  (`kComponentState`, `kControllerState`, `kMetaInfo`), précédés de l'en-tête
  `VST3` et du **classID** du composant. La correspondance est un transcodage
  d'octets, pas une interprétation.
- `src/renderer/js/core/nodeInstances.js:404` — `setPluginState()` existe déjà
  et écrit l'état persisté d'un plugin d'une chaîne.
- `src/renderer/js/core/engineSync.js:14` et `:29` — `describeAudioGraph` et
  `describeMidiGraph` filtrent sur un ensemble `supported` **explicite**. Un
  type de nœud absent de ces ensembles est invisible pour le moteur, sans aucune
  modification : c'est ce qui rend un nœud Preset sans effet sur le plan audio.
- `src/main/settings.js:45` — motif d'écriture atomique à reprendre.

**Sections d'ARCHITECTURE.md à relire :** §4 (IPC et liste blanche), §6 (graphe,
ports, cycles), §10 (CSP et échappement), §11 (persistance), §13 (invariants).

**Entrées de DECISIONS.md que ce plan approche :** D-003 (aucune dépendance),
D-004 (topologie contre valeurs), D-007 (liste blanche IPC), D-009 (écriture
atomique), D-012 (une coquille, au plus une façade).

**Le point dur, à traiter en premier :**
`native/audio-engine/src/vst3_scanner.cpp:35` pose
`rec.pluginId = d.fileOrIdentifier`, c'est-à-dire **le chemin du fichier `.vst3`
sur cette machine**. Aucun preset venu d'ailleurs ne peut se rattacher à cette
clé, et [INTENT.md](../../INTENT.md) §2 interdit nommément les « identifiants de
plugins » propres à la machine. Le ciblage automatique demandé — « le nœud câblé
sur Massive X ne propose que des presets Massive X » — n'existe pas tant que le
catalogue ne porte pas une identité stable.

---

## Contraintes

Ce qui ne doit pas bouger :

- **Invariant 1** — aucun échantillon audio ne traverse l'IPC. Un preset est du
  contrôle, pas du signal.
- **Invariant 2** — le graphe reste l'autorité du routage. Un câble `preset`
  n'est **pas** une arête de signal : il exprime une relation de configuration,
  et n'entre ni dans `describeAudioGraph` ni dans `describeMidiGraph`.
- **Invariant 8** — `unmount()` retire tout. L'éditeur du nœud Preset a des
  requêtes réseau en vol : elles doivent être annulées ou ignorées au démontage.
- **Invariant 9** — nom, auteur, description et licence d'un preset viennent du
  réseau. Chacun passe par `escapeHtml()` avant `innerHTML`.
- **Invariant 10** — pas de style inline ; la CSP n'est pas élargie, ni pour
  `connect-src`, ni pour `img-src`. Le renderer ne touche jamais le réseau.
- **Invariant 11** — `npm run sync:dist` après chaque étape.
- **Invariant 12** — le catalogue VST ne rétrécit jamais tout seul. L'ajout du
  `classId` est une migration **additive** : une entrée scannée avant la
  migration n'a pas de `classId` et doit survivre telle quelle.
- **D-004** — le nœud Preset n'entre dans aucune clé de topologie. Le câbler ou
  le décâbler ne doit provoquer **aucune** recompilation du plan natif.
- **D-007** — toute nouvelle commande moteur passe par
  `ALLOWED_ENGINE_COMMANDS` et son validateur dédié.
- **D-003** — aucune dépendance runtime. Le réseau passe par le module `net`
  d'Electron, l'archivage par `node:zlib`, rien d'autre.
- **INTENT §7** — l'application reste pleinement utilisable sans réseau ; aucune
  donnée de l'utilisateur ne sort ; aucune vérification de mise à jour.

Formats persistés touchés :

- `vstCatalog` (préférences applicatives) — gagne un champ `classId` optionnel ;
- `nodeInstances` (état de projet) — gagne un type d'instance `preset` ;
- nouveau store `%APPDATA%/minilab-hub/presets/` — **jamais** dans
  `settings.json`, que `persistPluginStateChunk` réécrit intégralement à chaque
  chunk d'état.

---

## Hors périmètre

Nommément, et ce sera tentant :

- **Le scraping de sites de presets** (Splice, ADSR, PresetShare, KVR). Pas
  d'API publique, CGU hostiles, structure HTML qui casse sans préavis. Les
  sources sont des index déclarés, pas des pages disséquées.
- **Tout compte, connexion, achat ou téléversement.** INTENT §6 : pas de
  produit multi-utilisateur, pas de service.
- **Le partage de presets vers l'extérieur.** Le flux est descendant seulement.
- **Le preset « de nœud MiniHub »** — capturer un arpégiateur, un mixer ou une
  chaîne VST entière dans un preset portable. C'est un autre modèle de données ;
  il attend une décision séparée.
- **La refonte complète de `nodeInstances.js`** (ROADMAP §4). Ce plan en
  extrait la couture d'éditeurs, rien de plus ; les quatre éditeurs existants ne
  sont pas déplacés.
- **Un lecteur ZIP.** `node:zlib` sait dégonfler, pas lire un conteneur ZIP. La
  v1 ne traite que des fichiers unitaires ; les banques archivées attendent.
- **La vérification automatique de mises à jour** de l'application ou des
  index. L'utilisateur rafraîchit quand il le décide.
- **Les vignettes distantes.** `img-src 'self' data:` n'est pas élargi.

---

## Étapes

- [x] 1. Extraire la couture d'éditeurs : `core/nodeEditors.js` porte une table
      `typeId → { render, bind }` et `core/disposers.js` un `createDisposers()`.
      `nodeInstances.js` consulte la table au lieu du ternaire de la ligne 730 ;
      les quatre éditeurs existants restent dans leur fichier actuel et sont
      simplement inscrits dans la table. Aucun changement de comportement.
      Vérification : `npm test` **560/560** (553 inchangés + 7 nouveaux dans
      `test/nodeEditors.test.mjs`) + `npm run check` **9 règles, 0 violation** +
      `npm run sync:dist`. Capacité de détection vérifiée par sonde dans les
      deux sens (voir Journal).

- [x] 2. Ajouter le type de port `preset` : documentation dans `graph.js`,
      glyphe dans `modules/routing/routingCore.js:25`, classe dans `base.css`,
      port d'entrée `preset-in` sur le type `vst` dans `nodeTypes.js`.
      Ajouter la règle de vérification qui refuse `preset` dans les ensembles
      `supported` de `engineSync.js` (invariant 2, D-011).
      Vérification : `npm test` **567/567** (+7 dans `test/presetPort.test.mjs`)
      + `npm run check` **10 règles, 0 violation** + `npm run sync:dist`.
      Sonde : laisser `preset` entrer dans `engineSync` fait tomber la règle
      *et* deux tests.

- [x] 3. Exposer le Class ID VST3 : `classId` dans `PluginRecord`, sérialisé par
      `serializeRecord` / `deserializeRecord`, remonté dans l'événement
      `plugins`. Migration additive du `vstCatalog` existant.
      Route tranchée **sur mesure** : `VST3::Hosting::Module` + factory. La
      lecture de `moduleinfo.json` est écartée — 50 des 54 `.vst3` de la machine
      sont des DLL nues sans bundle, et un seul des quatre bundles porte ce
      fichier : couverture 1 sur 54.
      Vérification : `npm run build:native` **0 erreur**, les 4 binaires natifs
      verts (**3 952 vérifications**), `npm test` **569/569** (+2 tests de
      migration de catalogue), `npm run check` 10 règles, `npm run sync:dist`.
      Preuve directe : le helper produit un `classId` sur 4 plugins réels sur 4,
      Massive X compris.

- [x] 4. `src/main/presetFile.js` — lecture et écriture du conteneur
      `.vstpreset` en JS pur : en-tête, classID, table d'entrées,
      `kComponentState` / `kControllerState` / `kMetaInfo`. Aucun réseau, aucune
      IPC à cette étape.
      Vérification : `npm test` **584/584** (+15 dans
      `test/presetFile.test.cjs`) + `npm run check` 10 règles +
      `npm run sync:dist`. Les fixtures sont construites **octet par octet
      depuis la spec**, sans passer par l'écrivain du module, et l'écrivain est
      comparé à l'une d'elles par égalité binaire.
      Reste ouvert : aucun `.vstpreset` réel n'existe sur la machine ni dans le
      SDK — à confronter à un fichier écrit par le SDK à l'étape 5 (voir
      Journal).

- [x] 5. Commande native `loadPresetChunks { chainId, instanceId, pluginId,
      generation, classId, component, controller }` dans `plugin_host.cpp` et
      `engine.cpp`, inscrite dans `ALLOWED_ENGINE_COMMANDS` avec son validateur
      `src/main/presetCommand.js` sur le modèle de `vstParameterCommand.js`.
      Évite de réimplémenter `copyXmlToBinary` côté JS.
      `classId` ajoute une troisieme garde, côté moteur.
      Vérification : `npm run build:native` **0 erreur**, les 4 binaires natifs
      verts (**3 958 vérifications**, dont le nouveau `[core] vstpreset-container`),
      `npm test` **593/593** (+7 validateur, +2 fixture SDK), `npm run check`
      10 règles, `npm run sync:dist`.
      **Lacune de l'étape 4 fermée** : `test/fixtures/sdk-written.vstpreset` est
      écrit par `PresetFile::savePreset` du SDK, et notre écrivain produit des
      octets identiques.

- [x] 6. Source disque locale : `src/main/presetStore.js` indexe
      `%LOCALAPPDATA%\VST3 Presets\<Vendeur>\<Plugin>\`, le dossier partagé et
      le store MiniHub. Canaux IPC `presets:library` et **`presets:read`**
      (et non `presets:apply` — voir Journal).
      Vérification : `npm test` **604/604** (+11 dans
      `test/presetStore.test.cjs`, sur un vrai répertoire temporaire) +
      `npm run check` 10 règles + `npm run sync:dist`.
      Écriture atomique non faite : rien n'écrit encore. Elle arrive avec les
      étapes 8 et 9, qui en auront l'usage.

- [x] 7. Le nœud **Preset** : entrée dans `nodeTypes.js`, dossier
      `modules/presets/`, éditeur inscrit dans la table de l'étape 1, aucune
      ligne ajoutée au `mount()` de `nodeInstances.js`. Le nœud lit sa
      connexion `preset` sortante pour trouver le nœud VST cible, résout le
      plugin visé dans sa chaîne, et filtre par `classId` — à défaut, par
      couple fabricant + nom normalisé. **À la fin de cette étape le module est
      complet hors ligne.**
      Vérification : `npm test` **617/617** (+13 dans
      `test/presetEditor.test.mjs`) + `npm run check` 10 règles +
      `npm run sync:dist`. Sonde : retirer un `escapeHtml` fait tomber le
      test d'échappement, et lui seul. **Zéro ligne ajoutée au `mount()` de
      `nodeInstances.js`**, comme promis à l'étape 1.

- [x] 8. Étage réseau : `src/main/presetSource.js` récupère un index JSON en
      HTTPS via le module `net` d'Electron, plafond de taille, empreinte
      SHA-256, refus de toute redirection non-HTTPS. Cache local dans le store
      de l'étape 6. Sources initiales : banques publiques de plugins libres
      hébergées en dépôt. Sans réseau, le nœud affiche le cache et le disque,
      et rien ne casse.
      Vérification : `npm test` **641/641** (+15 `test/presetSource.test.cjs`,
      +6 store, +3 éditeur) + `npm run check` 10 règles + `npm run sync:dist`.
      Transport injecté : aucun test ne touche le réseau.

- [ ] 9. Installation sur disque des formats que `setState` ne peut pas
      recevoir (`.fxp`, `.vital`, `.syx`) : copie dans le répertoire de presets
      du plugin, sans écrasement silencieux. Le plugin les voit dans son propre
      navigateur.
      Vérification : `npm test` + `npm run sync:dist`

---

## Point de retour

Branche `feat/presets-universels`, créée au commit `1b53647` de
`docs/socle-agents`. Abandonner le chantier = supprimer la branche.

**Pourquoi pas `master`** : `docs/socle-agents` est exactement un commit devant
`master`, sans divergence, et `scripts/check-invariants.mjs` n'existe pas encore
sur `master`. Repartir de `master` perdrait `npm run check`, qui fait partie de
la définition de « fini » (AGENTS §8). Quand la branche documentaire rejoindra
`master` est une décision séparée, qui n'appartient pas à ce plan.

**Baseline mesurée avant la première modification** : `npm test` 553/553,
`npm run check` 9 règles sans violation.

---

## Fini quand

- `npm test` et `npm run check` verts ;
- `npm run sync:dist` passé, test de provenance vert (invariant 11) ;
- `npm run build:native` : 0 erreur, 0 avertissement ;
- `mlh_native_tests.exe --core` et `--vst3-e2e` verts ;
- et les critères propres à ce plan :
  - câbler puis décâbler un nœud Preset ne produit **aucune** recompilation du
    plan audio dans le journal (D-004) ;
  - appliquer un preset sur un plugin en cours de lecture ne produit aucun
    décrochage (`audioRuntimeTelemetry` sans anomalie) ;
  - l'application démarre, ouvre un projet et joue **avec le réseau coupé**, le
    nœud Preset affichant sa bibliothèque locale (INTENT §7) ;
  - un preset dont le `classId` ne correspond pas au plugin ciblé est refusé
    **avant** d'atteindre le moteur, avec un message lisible ;
  - un catalogue VST antérieur à l'étape 3 s'ouvre sans perdre une entrée
    (invariant 12).

---

## Journal

2026-09-02 — Plan ouvert. Trois arbitrages tranchés à l'ouverture :
« universel » désigne le **ciblage automatique** du plugin câblé, pas un format
portable entre plugins ; les sources sont des banques publiques de plugins
libres, pas du scraping ; et le module est un **nœud** du Patch Bay, pas une
page de la barre latérale. Cette dernière décision impose l'étape 1 : sans la
couture d'éditeurs, un nœud de plus signifie une cinquième branche dans le
ternaire de `nodeInstances.js:730` et sept gardes `if (type.id !== 'preset')`
supplémentaires dans des gestionnaires partagés — exactement ce que ROADMAP §4
décrit comme le blocage à lever.

2026-09-02 — Type de port tranché : **un quatrième type `preset`**, et non la
réutilisation de `control`. Un câble CTRL qui ne transporte aucun contrôle
contredirait `controlRouting.js` et `controlBindings.js:252`, qui supposent tous
deux une valeur normalisée venue du MiniLab. Le coût est contenu : documentation
de `graph.js`, glyphe dans `routingCore.js:25`, une classe CSS, un port
`preset-in` sur le type `vst`. Effet de bord assumé : tous les nœuds VST
existants gagnent un port et grandissent d'une rangée dans le Patch Bay.

Branche de travail créée, baseline verte relevée (voir « Point de retour »).

2026-09-02 — **Étape 1 faite.** Deux fichiers ajoutés (`core/nodeEditors.js`,
`core/disposers.js`). Dans `nodeInstances.js`, le ternaire imbriqué de la
ligne 730 devient une consultation de table, et les vingt lignes de miroir
manuel des écouteurs (déclaration → champ `module._onX` → `removeEventListener`)
disparaissent au profit d'un collecteur : `unmount()` passe de 27 lignes à 8.

Comptage honnête : le fichier ne rétrécit pas encore, il gagne **6 lignes
nettes** (+51/−45). Les 19 lignes d'inscription des quatre éditeurs historiques
y vivent temporairement et partiront avec eux à ROADMAP §4. Ce que l'étape
achète n'est pas de la taille, c'est le fait qu'un **nouveau** type n'ait plus
rien à ajouter ici.

Surprise utile : la sonde a montré que l'invariant 8 était **déjà** verrouillé
mécaniquement. Neutraliser `dispose()` fait tomber trois tests existants, dont
« an unmounted VST node never reacts to clicks meant for another node ». Aucun
test supplémentaire n'était donc nécessaire de ce côté ; les 7 tests ajoutés
couvrent le contrat du registre lui-même, sur lequel l'étape 7 s'appuiera.
Seconde sonde, dans l'autre sens : désarmer l'appel à `editor.bind()` ne fait
tomber que le test visé.

Décision prise en cours d'étape : `createDisposers()` est utilisé
**immédiatement** par les quatre éditeurs historiques, plutôt que créé et laissé
inerte jusqu'à l'étape 7. Un module exporté mais non appelé est exactement ce
que ROADMAP §5 recense comme défaut ; et c'est la sous-tâche que ROADMAP §4
nomme explicitement.

Non fait, et assumé : les quatre éditeurs historiques partagent toujours les
sept gestionnaires DOM de `mount()`. Seul leur *rendu* passe par la table. Les
en sortir reste ROADMAP §4.

2026-09-02 — **Étape 2 faite.** Type `preset` déclaré (losange, `--preset`),
socket `preset-in` sur le nœud VST, entrée de légende, et la règle
`preset stays out of the engine` dans `npm run check`. `ARCHITECTURE.md` §6
passe de « les trois types de port » à quatre, avec la raison du refus de
surcharger `control`.

Ce que la modification a révélé : **quatre tests hérités encodaient
silencieusement la géométrie du nœud VST**. Trois listaient ses ports en dur ;
le quatrième, `keyboard Paste uses viewport center`, était plus insidieux. Le
nœud grandit de 30 px (le dock passe de trois à quatre rangées), donc le collage
au centre du viewport chevauche désormais la source, et `resolveNodePos()` le
décale — son anti-empilement fonctionnant exactement comme prévu. La valeur
`(400,300)` n'était pas « le centre » mais « le centre, tant qu'un nœud VST
mesure moins de 190 px de haut ». Corrigé en éloignant la source plutôt qu'en
figeant la nouvelle valeur : ce test porte sur le *choix* de la position, pas
sur le décalage. Diagnostic tranché par sonde — retirer le seul port ajouté fait
repasser les 22 tests du fichier — et non par raisonnement, qui donnait faux.

À reprendre quand le plan atterrira : ROADMAP écrit que `check-invariants.mjs`
« rend mécaniques sept des douze invariants ». La nouvelle règle couvre en
partie l'invariant 2, qui ne l'était pas. Le compte sera à corriger à ce
moment-là, pas maintenant : l'entrée décrit un état passé du dépôt.

2026-09-02 — **Étape 3 faite.** `classId` traverse maintenant toute la chaîne :
factory VST3 → `PluginRecord` → protocole du helper → événement `plugins` →
`vstCatalog`. Vérifié sur quatre plugins réels — Massive X
`5653544E6924486D6173736976652078`, ValhallaDelay, Vital, Dexed.

Format confirmé dans le SDK, pas supposé : sous Windows `SMTG_OS_WINDOWS=1` rend
`VST3::UID::defaultComFormat` vrai, et `COM_COMPATIBLE=1` fait écrire à
`FUID::toString` la même disposition. La chaîne stockée est donc **exactement**
celle qu'un en-tête `.vstpreset` contient : l'étape 4 comparera par égalité de
chaînes, sans réordonnancement d'octets.

Arbitrage de couverture, tranché par mesure et non par intuition. La voie
« sans liaison nouvelle » — lire `Contents/Resources/moduleinfo.json` — aurait
laissé `mlh_vst3_scanner` intact. Comptage sur la machine cible le 2026-09-02 :
**50 des 54 `.vst3` installés sont des DLL nues** (aucun bundle, donc aucun
`moduleinfo.json` possible) et **un seul des quatre bundles** porte le fichier.
Couverture : 1 plugin sur 54. Écartée.

Conséquence assumée, signalée parce qu'elle touche une cible volontairement
minimale : `mlh_vst3_scanner` lie désormais `sdk_hosting` et compile
`module_win32.cpp`. Le commentaire du CMake explique pourquoi les deux
exclusions qu'il énonce (pas d'`engine.cpp`, pas de `juce_audio_devices`) restent
vraies — lire une factory n'ouvre aucun périphérique audio, et ce helper chargeait
déjà le binaire du plugin via JUCE.

Risque résiduel, écrit dans le code plutôt que tu : lire l'UID rouvre le module
une seconde fois, et une violation d'accès n'est **pas** rattrapable par
`catch (...)` sous MSVC. Un plugin qui fauterait là ferait tomber le helper, et
`scanFileIsolated` jette le fichier résultat dès que l'enfant sort non-zéro —
écrire le résultat en deux temps ne servirait donc à rien, et assouplir cette
garde échangerait une panne étroite contre une large. L'exposition reste bornée
par `_acceptsCatalog`, qui refuse tout scan automatique plus court que le
catalogue en place : l'invariant 12 tient là où il est énoncé.

Trouvé au passage, hors périmètre : `npm run build:native` sort **4
avertissements C4996** (`juce::MidiBuffer::Iterator` déconseillé) dans
`native/audio-engine/src/midi_graph.cpp:33,35`. Ils sont antérieurs à ce plan —
`midi_graph.cpp` n'est pas modifié ici — et invisibles tant qu'un build
incrémental ne recompile pas ce fichier. AGENTS §8 exige « 0 erreur 0
avertissement » : cette exigence est donc actuellement fausse sur un build
complet, indépendamment de ce chantier.

2026-09-02 — **Étape 4 faite.** `src/main/presetFile.js` lit et écrit le
conteneur, sans réseau, sans IPC, sans dépendance : 200 lignes et 15 tests.

Méthode de test choisie contre le piège évident : un aller-retour
écriture → lecture dans un seul module passe même quand la disposition est
fausse des deux côtés. Les fixtures sont donc construites **octet par octet
depuis la spec du SDK**, sans emprunter une ligne à `writePreset`, et un test
compare ensuite la sortie de l'écrivain à l'une d'elles par égalité binaire.

Le parseur traite ses octets comme hostiles, puisqu'ils viendront du réseau :
offsets et tailles sont des int64 validés avant conversion (négatif, au-delà de
`MAX_SAFE_INTEGER`, ou hors tampon = fichier malformé, jamais un nombre qu'on
promène), un chunk ne peut ni commencer dans l'en-tête ni dépasser la fin du
fichier, le compte d'entrées est borné par `kMaxEntries` **avant** toute
allocation, et rien ne lève : chaque refus porte sa raison. Les chunks sont
copiés et non vus, pour que le tampon source puisse être relâché.

**Lacune de vérification, à fermer à l'étape 5.** Aucun `.vstpreset` réel
n'existe sur cette machine (`%LOCALAPPDATA%\VST3 Presets` est vide, aucun bundle
n'en embarque) ni dans le SDK. La conformité repose donc sur ma transcription de
`vstpresetfile.cpp`, pas sur un fichier écrit par un tiers. L'étape 5 recompile
de toute façon le natif : y produire un fichier via `PresetFile::savePreset` du
SDK, le figer comme fixture binaire dans `test/fixtures/`, et le faire relire par
`readPreset` fermera la boucle pour un coût quasi nul. Tant que ce n'est pas
fait, une erreur de transcription resterait invisible jusqu'au premier preset
téléchargé.

Constat au passage : le dossier de presets standard étant vide, la source disque
de l'étape 6 ne trouvera rien tant que l'étape 9 n'aura pas installé quelque
chose. L'ordre des étapes 6 et 9 sera peut-être à revoir le moment venu.

2026-09-02 — **Étape 5 faite.** Le chemin d'application d'un preset existe de
bout en bout : `engineClient.loadPresetChunks()` → liste blanche → validateur
`presetCommand.js` → `Engine::cmdLoadPresetChunks` → `PluginInstance::setStateChunks`.

`setState` et `setStateChunks` partagent désormais `applyStateBlocks()` plutôt
que de dupliquer la mutation sous garde et la resynchronisation des compteurs de
révision. Les deux entrées restent distinctes parce que leurs charges le sont :
l'une porte l'enveloppe XML binaire de JUCE, l'autre les chunks bruts d'un
conteneur. Reconstruire cette enveloppe en JavaScript aurait signifié
réimplémenter `copyXmlToBinary` — un nombre magique plus du GZIP — contre un
interne de JUCE libre de changer.

**Trois gardes, pas une.** Ces octets sont les moins fiables qui entrent dans
l'application, et ils finissent dans le `setState` d'un VST3 qui tourne dans le
processus moteur. Le validateur du processus principal fixe la forme ; le moteur
revérifie l'identité et la génération ; et une garde nouvelle compare le
**classId** déclaré à celui de l'instance. Donner à un plugin un preset écrit
pour un autre est la façon la plus directe de pousser un plugin correct dans un
comportement indéfini. Quand le catalogue ne connaît pas l'UID de l'instance, la
garde s'efface au lieu de refuser tout preset sur une entrée ancienne —
même dégradation gracieuse qu'ailleurs.

**Lacune de l'étape 4 fermée.** `test/fixtures/sdk-written.vstpreset` (143
octets) est produit par `PresetFile::savePreset` du SDK lui-même, via
`mlh_native_tests.exe --preset-fixture <chemin>`. Deux tests JS le lisent : l'un
vérifie que `readPreset` en extrait les bons chunks, l'autre que `writePreset`
produit des octets **identiques**. Le test natif correspondant tourne dans
`--core` et épingle au passage l'affirmation dont tout le reste dépend : les 32
caractères d'un en-tête de preset sont bien ceux que le scanner enregistre comme
`classId` (`FUID::fromString` puis `toString` rend la chaîne inchangée).

Ce que la fixture a confirmé, octet par octet : `56 53 54 33` puis version
`01 00 00 00`, les 32 caractères du classId, puis `5F 00 00 00 00 00 00 00` —
offset de liste 95 = 48 + 23 + 24. La transcription de l'étape 4 était juste.

2026-09-02 — **Étape 6 faite.** `presetStore.js` marche sur le modèle de
`projectFiles.js` : il reçoit ses chemins au lieu de les résoudre par Electron,
donc il se teste sur un vrai répertoire temporaire, sans application.

Une scrutation lit **48 octets par fichier**, jamais le fichier entier : le
classId de l'en-tête suffit à décider si un preset appartient au plugin câblé,
et c'est tout ce que la bibliothèque a besoin de savoir. D'où l'extraction de
`readHeader()` hors de `readPreset()` à cette étape.

Écart au texte du plan, assumé : le canal s'appelle **`presets:read`** et non
`presets:apply`. Il renvoie les chunks base64 au renderer, qui émet ensuite la
commande `loadPresetChunks` ordinaire. Appliquer directement depuis le processus
principal aurait économisé un aller-retour — non négligeable sur un preset de
plusieurs mégaoctets — mais aurait ouvert un **second chemin vers le moteur** à
côté d'`engine:command`. D-007 existe précisément pour que la surface que le
moteur peut recevoir reste une liste unique et relisible. L'économie ne valait
pas la lecture perdue. À rouvrir si un preset volumineux se révèle lent à
l'usage, mesuré et non supposé.

Ce que le store refuse, et pourquoi c'est la partie qui compte : le renderer
nomme un preset par son chemin, donc « lire le preset à ce chemin » ne doit
jamais devenir « lire ce fichier ». Le chemin est re-résolu et comparé aux
racines avec une frontière terminée par un séparateur — un répertoire voisin
nommé `<racine>-evil` ne passe pas le test de préfixe naïf, et un test le
vérifie. S'y ajoutent : extension obligatoire, plafond de taille, liens
symboliques ignorés (c'est ainsi qu'une scrutation sort de l'arbre qu'on lui a
confié, ou rencontre une boucle), profondeur et nombre de fichiers bornés.

Un fichier dont l'en-tête ne s'analyse pas est ignoré en silence : un fichier
égaré dans un dossier de presets n'est pas une raison de faire échouer la
bibliothèque. Et une racine absente n'est pas une erreur — c'est l'état normal
d'une machine neuve, celui de la machine cible aujourd'hui.

2026-09-02 — **Étape 7 faite. Le nœud existe.** Et la promesse de l'étape 1
tient : `modules/presets/presetEditor.js` s'inscrit dans la table et **n'ajoute
pas une ligne** au `mount()` de `nodeInstances.js`. Un `import` à effet de bord
dans `app.js` suffit à l'enregistrer.

Le câble est l'autorité, littéralement : `resolveTarget()` relit le graphe à
chaque peinture au lieu de garder une copie de sa cible. Débrancher change ce
que la page propose sans qu'aucun autre état n'ait à suivre — c'est l'invariant
2 appliqué à une relation de configuration, et un test le vérifie en
débranchant.

Deux ajouts génériques plutôt que spécifiques au type, pour ne pas rouvrir la
coupure que l'étape 1 a fermée :

- `NodeInstanceManager.persist()`, publique et sans connaissance de type. Un
  éditeur extérieur modifie `instance.content` puis le dit. L'alternative était
  un setter par type de nœud dans `nodeInstances.js`, exactement le couplage que
  `core/nodeEditors.js` existe pour finir.
- `defaultContentFor('preset')` ne garde que `pluginInstanceId` : la chaîne
  n'est pas recopiée, sinon il y aurait deux réponses concurrentes à « sur quel
  plugin ce nœud agit-il ».

Piège de test évité, et il valait le détour : le shim DOM partagé ne résout que
les sélecteurs `#id`. Un test d'intégration bâti dessus aurait été **vert en ne
peignant rien** — pire que pas de test. D'où un conteneur dédié dans le fichier
de test, comme `pluginEditor.test.mjs` en a déjà un.

Ce que les tests verrouillent au-delà du fonctionnel : un nom de preset venu du
disque est échappé avant `innerHTML` (sonde : retirer l'`escapeHtml` fait tomber
ce test et lui seul), le démontage retire tous les écouteurs, et une réponse de
bibliothèque qui arrive **après** le démontage ne peint rien — `#content` étant
partagé, elle repeindrait sinon la page d'un autre module.

Vérifié au passage, parce qu'un doute valait la peine d'être levé : appliquer un
preset resynchronise les compteurs de révision de `PluginInstance`, ce qui
suspend la capture opportuniste au repos. Ça aurait pu signifier un preset
appliqué mais jamais persisté. Ce n'est pas le cas : le chemin de sauvegarde
(`cmdCapturePluginStates`) et l'extinction appellent tous deux
`capturePluginStates(**true**)`, qui ignore ces compteurs.

Reste à faire avant de dire que ça marche : lancer l'application. Rien de ce qui
précède ne prouve le rendu réel — c'est le premier chantier de ce plan dont le
résultat se regarde.

2026-09-03 — **Étape 8 faite.** `presetSource.js` récupère et valide, le store
mémorise, le nœud affiche une section « Online ». Le renderer ne touche toujours
pas au réseau : `grep fetch|XMLHttpRequest|WebSocket` sur `src/renderer/js` ne
rend rien, et la CSP est inchangée.

Correction d'une chose dite trop vite à l'ouverture du plan. J'ai présenté « les
banques GitHub de plugins libres » comme la source qui marche : vrai pour
l'hébergement, **faux pour le format**. Dexed distribue du `.syx`, Surge XT du
`.fxp`, Vital du `.vital` ; le `.vstpreset` — seul format que `loadPresetChunks`
applique à chaud — y est bien moins répandu. L'étage réseau est donc
**agnostique au format** : il télécharge ce que la source annonce et marque
chaque entrée `applicable` ou non. Les non-applicables attendent l'étape 9.

Deux genres de source, table interne et non point d'extension (INTENT §6) :
`index` (un document JSON que MiniHub définit, à une URL que l'utilisateur
contrôle) et `github` (un dossier public lu par l'API contents, qui ne demande
ni index à rédiger ni compte). Ajouter un troisième genre, c'est éditer ce
fichier.

Ce que le réseau n'a pas le droit de faire : sortir de HTTPS (une redirection
qui descend en clair est **refusée**, jamais suivie), porter des identifiants
dans l'URL, dépasser les plafonds de taille avant même l'accumulation du corps,
proposer une extension hors liste, ou livrer des octets dont l'empreinte
SHA-256 déclarée ne tombe pas juste — un écart est un refus, pas un
avertissement. Le `sha` d'une listing GitHub est le hash blob de git, pas un
SHA-256 du contenu : il n'est **délibérément pas** recopié dans `sha256`,
annoncer une empreinte invérifiable étant pire que n'en avoir aucune.

Deux défauts trouvés par les tests avant qu'ils existent en vrai :

1. Mon motif `[A-Za-z0-9._-]` acceptait `..` comme propriétaire GitHub et
   fabriquait `api.github.com/repos/../r/contents`. Resserré à « commence par un
   alphanumérique », qui est aussi la règle de GitHub.
2. `reload()` et `loadOnline()` partageaient un compteur de requête, donc l'un
   invalidait la réponse de l'autre et la liste installée ne se peignait jamais.
   Compteurs séparés.

Réglages : `presetSources` par défaut **vide**. MiniHub ne contacte rien tant
que personne ne le lui demande, et l'ouverture d'un nœud lit le **cache** — un
test vérifie que monter la page n'appelle jamais avec `refresh: true`. Un
rafraîchissement dont toutes les sources échouent **garde** ce qui était
mémorisé au lieu de vider la liste : INTENT §7 veut une dégradation, pas une
disparition.

Conséquence à assumer : sans source configurée, la section en ligne dit « No
catalogue source configured » plutôt que de paraître vide. Aucun catalogue
public au format MiniHub n'existe — c'est un format que ce dépôt vient de
définir. Utilisable tout de suite en revanche : une source `github` pointant un
dossier de `.vstpreset` d'un dépôt public.

2026-09-03 — **Mise en veille après l'étape 8.** Revue de sécurité demandée par
l'auteur avant de poursuivre. Elle a produit trois correctifs **non appliqués**,
que quiconque reprend ce plan doit traiter avant l'étape 9 :

1. **`presets:download` accepte n'importe quelle URL HTTPS.** Le plus grave :
   `normalizeEntry` vérifie le schéma, l'absence d'identifiants et l'extension,
   mais **pas** que l'URL appartienne à une source configurée. Un catalogue
   hostile peut donc pointer ailleurs, et le renderer dispose d'une primitive
   « fais chercher n'importe quelle URL HTTPS par le processus principal », qui
   n'existait pas avant ce chantier. Correctif : épingler les téléchargements
   aux origines des sources déclarées.
2. **Le transport laisse passer les données d'authentification de session.** La
   documentation d'Electron le dit : sans `credentials`, les cookies ne partent
   pas mais l'authentification de session, si. Rien à fuiter aujourd'hui —
   l'application ne s'authentifie nulle part — mais c'est une propriété de
   sécurité qui repose sur un défaut. Correctif : `credentials: 'omit'` explicite
   et une partition de session dédiée.
3. **Le cache de catalogue n'est pas revalidé à la lecture.** `readCatalogueCache`
   rend ce que le fichier contient sans repasser par `normalizeEntry`. Impact
   faible (l'affichage échappe, le téléchargement renormalise) mais valider à
   l'entrée *et* à la sortie coûte deux lignes.

Verrues mineures relevées : un téléchargement écrase silencieusement un preset
homonyme, et le chemin de lecture directe suit les liens symboliques alors que
la scrutation les ignore (impact contenu : le fichier doit malgré tout s'analyser
comme un `.vstpreset`).

État de repos : `presetSources` est vide par défaut et rien ne part tout seul,
donc la branche au repos ne contacte rien. Mais le canal `presets:download` est
présent dans `dist/` synchronisé et accepte toute URL HTTPS ; son exploitation
suppose un renderer compromis.

Risque irréductible, à ne pas oublier au réveil : un preset est un blob opaque
interprété par un plugin tiers, dans un processus séparé mais lancé avec le jeton
de l'utilisateur — isolation contre les plantages, pas contre une compromission.
Et un preset appliqué devient de l'état persisté, donc réappliqué à chaque
ouverture du projet. La défense est la provenance et l'intégrité, jamais
l'assainissement.
