# MiniHub — Registre des décisions

Ce que le code fait d'apparemment étrange, et **pourquoi**. Chaque entrée
correspond à un choix qui a coûté du temps à établir et qu'une lecture naïve du
code invite à défaire.

**Avant de « corriger » quelque chose qui te semble absurde dans ce projet,
cherche-le ici.** Si tu ne le trouves pas et que tu tranches, ajoute l'entrée.

**Règles du registre**

- **Ajout seulement.** Une entrée n'est jamais réécrite ni supprimée. Une
  décision qui change est marquée `dépassée par D-xxx`, et la nouvelle entrée
  explique ce qui a changé dans le monde.
- Une entrée sans **preuve dans le code** n'est pas une décision, c'est une
  opinion : elle n'a pas sa place ici.
- Le champ **ce qui justifierait de revenir dessus** est obligatoire. Une
  décision qu'aucun fait ne pourrait invalider est un dogme, pas une décision.
- Ce registre dit *pourquoi*. [ARCHITECTURE.md](ARCHITECTURE.md) dit *comment*.
  [INTENT.md](INTENT.md) dit *pour qui*.

---

## D-001 — Le rendu GPU est désactivé sous Windows

**Statut** : en vigueur · antérieure au point de retour `c3c00c9`

**Contexte** — Le sous-processus GPU d'Electron sortait en
`STATUS_DLL_NOT_FOUND` sur la machine cible. L'application ne démarrait pas, et
le symptôme ne se reproduit pas sur une machine de développement standard.

**Décision** — `app.commandLine.appendSwitch('in-process-gpu')` puis
`app.disableHardwareAcceleration()` au tout début du processus principal.

**Conséquence** — L'interface ne peut pas utiliser WebGL, ni aucune technique
dont le coût suppose une accélération matérielle. Le Patch Bay est dessiné en
SVG et en DOM, et doit le rester.

**Ce qui justifierait de revenir dessus** — Un changement de machine cible, ou
une version d'Electron où le sous-processus GPU démarre. À vérifier en retirant
les deux lignes et en lançant `npm start` sur la machine de l'utilisateur, pas
ailleurs.

**Preuve dans le code** — `src/main/main.js:13-14`

---

## D-002 — Un seul back-end audio : WASAPI, imposé à la compilation

**Statut** : en vigueur · antérieure à `c3c00c9`

**Contexte** — Plusieurs flux audio concurrents produisaient des artefacts et
des conflits de périphérique. Désactiver les back-ends au démarrage ne suffit
pas : rien n'empêche un chemin de code d'en rouvrir un.

**Décision** — ASIO, DirectSound, WMME et WDMKS sont compilés **hors** de
PortAudio (`PA_USE_ASIO OFF`, etc.). Un second flux devient impossible par
construction, pas par discipline.

**Conséquence** — Aucun support ASIO, jamais, sans recompiler. La latence
plancher est celle de WASAPI en mode partagé ou exclusif. Bloc cible 256
échantillons, plafond 4096.

**Ce qui justifierait de revenir dessus** — Un besoin de latence que WASAPI
exclusif ne tient pas, mesuré et non supposé. Rouvrir ASIO impose alors de
prouver qu'un seul flux reste ouvert à tout instant.

**Preuve dans le code** — `native/audio-engine/CMakeLists.txt:25-29`

---

## D-003 — Aucune étape de build pour le JavaScript

**Statut** : en vigueur · antérieure à `c3c00c9`

**Contexte** — Un bundler ajoute une étape entre ce qui est écrit et ce qui
s'exécute, donc une source d'écart supplémentaire dans une application qui a
déjà trois processus et deux langages.

**Décision** — Le renderer est en ES modules natifs
(`src/renderer/package.json` porte `{"type":"module"}`), le processus principal
reste en CommonJS. Aucun bundler, aucune transpilation, aucun framework.

**Conséquence** — Les 553 tests importent directement les modules du renderer
sans étape de build, ce qui rend la suite quasi instantanée (~5 s). En échange :
pas de JSX, pas de TypeScript, pas d'import de paquet npm dans le renderer, et
la frontière CommonJS / ESM doit être respectée à la lettre.

**Ce qui justifierait de revenir dessus** — Rien de connu. Ce serait un
changement d'identité du projet, pas une optimisation ; voir INTENT.md.

**Preuve dans le code** — `src/renderer/package.json`, `package.json` (aucune
`dependencies`)

---

## D-004 — La topologie audio et les valeurs audio empruntent deux chemins

**Statut** : en vigueur · antérieure à `c3c00c9`

**Contexte** — Un curseur `range` émet un événement `input` par pixel de
glissement. Router ces valeurs par `syncAudioGraph` recompilait le graphe natif
des dizaines de fois par seconde — **jusqu'à 37 recompilations par seconde
relevées dans le journal** — et remettait à zéro chaque ligne de retard PDC en
plein flux audio.

**Décision** — `audioTopologyKey(nodes)` décrit la *forme* du graphe : une
différence impose une recompilation. `audioNodeValues(nodes)` décrit les valeurs
éditées en continu (niveaux, mutes, master, pas du Morpher) : elles sont
appliquées **en place** sur le plan déjà publié. Les écritures sont en outre
regroupées côté UI toutes les 120 ms.

**Conséquence** — Ajouter un réglage continu à un nœud oblige à choisir
explicitement son camp. Le mettre dans la clé de topologie « parce que c'est
plus simple » réintroduit le défaut, silencieusement : il ne se voit qu'à
l'oreille et dans le journal.

**Ce qui justifierait de revenir dessus** — Une recompilation native devenue
assez bon marché pour être faite par image, mesurée sous charge VST réelle.

**Preuve dans le code** — `src/renderer/js/core/engineSync.js`,
`src/renderer/js/core/nodeInstances.js:54` (`NATIVE_VALUE_COALESCE_MS = 120`)

---

## D-005 — La détection de cycles ignore les nœuds `midi-output`

**Statut** : en vigueur · antérieure à `c3c00c9`

**Contexte** — Le MiniLab est représenté par **deux facettes matérielles
indépendantes** : sa sortie MIDI provient du clavier, et ce qu'il reçoit sur son
entrée MIDI n'est jamais réémis par sa sortie. Traiter ces deux ports comme une
traversée interne fabriquait un faux cycle, et le monitoring matériel
`MiniLab → Sequencer → MiniLab` était refusé à tort.

**Décision** — `Graph._wouldCreateCycle()` n'explore pas les arêtes sortantes
d'un nœud de type `midi-output`.

**Conséquence** — Un vrai cycle passant par un nœud `midi-output` ne serait pas
détecté. C'est acceptable parce qu'un tel nœud est un point terminal matériel :
il n'existe aucun chemin de retour interne.

**Ce qui justifierait de revenir dessus** — Un type de nœud `midi-output` qui
réémettrait réellement ce qu'il reçoit. Il faudrait alors distinguer les
terminaux matériels des relais, pas retirer l'exception.

**Preuve dans le code** — `src/renderer/js/core/graph.js:115-121`

---

## D-006 — L'identité d'un nœud est séparée de sa numérotation

**Statut** : en vigueur · établie au commit `92f6b12` (« Pass 1 »)

**Contexte** — Confondre les deux fait survivre des câbles vers un nœud
supprimé, ou fait pointer une chaîne native vers le mauvais plugin.

**Décision** — L'`id` (`vst-011`) est stable, unique à jamais, et **jamais
réutilisé** après suppression : c'est la clé des câbles, positions, modules et
chaînes natives. L'`ordinal` (« VST 2 ») est de l'**affichage seul** ; un
nouveau nœud prend le plus petit entier libre de sa famille, et les nœuds
existants ne sont jamais renumérotés.

**Conséquence** — Après suppression de « VST 2 » alors que dix nœuds existent,
un nouveau nœud s'affichera « VST 2 » tout en portant l'id `vst-011`. C'est
voulu. Le `name` est dérivé et n'est pas persisté séparément.

**Ce qui justifierait de revenir dessus** — Rien. C'est l'invariant 4.

**Preuve dans le code** — `src/renderer/js/core/nodeInstances.js`

---

## D-007 — La surface IPC est une liste blanche fixe, pas un passe-plat

**Statut** : en vigueur · antérieure à `c3c00c9`

**Contexte** — Un pont IPC qui relaie « n'importe quel objet sérialisé par le
renderer » n'est pas relisible : on ne peut pas savoir, en lisant le processus
principal, ce que le moteur natif peut recevoir.

**Décision** — Toute commande moteur passe par `ipcMain.handle('engine:command')`
qui applique `ALLOWED_ENGINE_COMMANDS`, puis un validateur dédié pour les
commandes sensibles (`selectDevice`, `setVstParameter`, `setVstParameterLearn`).

**Conséquence** — Ajouter une commande moteur impose de toucher la liste blanche.
C'est le point du dispositif : la surface exposée reste une liste finie et
lisible d'un coup d'œil.

**Ce qui justifierait de revenir dessus** — Rien de connu.

**Preuve dans le code** — `src/main/engineCommandPolicy.js`,
`src/main/audioDeviceCommand.js`, `src/main/vstParameterCommand.js`,
`src/main/vstParameterLearnCommand.js`

---

## D-008 — Une identité partagée est déclarée à un seul endroit

**Statut** : **appliquée en entier** · établie au commit `f4ec31f`, achevée le
2026-09-04 (Étape A, étape 8). Seul le *statut* est mis à jour ici : la décision
elle-même n'a pas bougé, et ce qui restait ouvert est conservé ci-dessous plutôt
qu'effacé.

**Contexte** — `'minilab-3'` était redéclaré dans **neuf modules** sous trois
noms différents, `'audio-output'` dans trois. La liste des clés de projet
existait en double. Le mode de panne est silencieux : une copie oubliée lors
d'un renommage ne lève aucune erreur, le graphe cesse simplement de
correspondre et le MIDI arrête de router.

**Décision** — `core/systemNodes.js` détient les identifiants de nœuds système,
`core/projectKeys.js` la liste des clés de projet. Les `DEFAULTS` du processus
principal n'en contiennent aucune.

**Conséquence** — Un littéral d'identité partagée dans un module est désormais
un défaut, pas un raccourci. `npm run check` le refuse.

**Ce qui restait ouvert, et comment ça s'est fermé** — La contrepartie C++
n'était pas unifiée : `isPhysicalMidiDestination()` codait `id == "minilab-3"`
en dur, et l'invariant 7 était donc incomplet côté natif.

Fermé le 2026-09-04. La fonction est supprimée. Le moteur reconnaît maintenant
une destination matérielle au **genre** du nœud (`midi-output`) que le renderer
envoie déjà pour chaque nœud du réseau MIDI — le séquenceur lisait d'ailleurs ce
genre depuis toujours, et ne gardait la comparaison par nom qu'en second recours.
Un second contrôleur ne coûte donc plus une ligne de C++. Deux vérifications
natives neuves le tiennent, dont une qui échoue si le nom redevient spécial.

**Ce qui justifierait de revenir dessus** — Rien. Le travail restant était de
l'étendre, pas de le défaire, et il est fait.

**Preuve dans le code** — `src/renderer/js/core/systemNodes.js`,
`src/renderer/js/core/projectKeys.js`, `src/main/settings.js:19-30`,
`native/audio-engine/src/midi_network.cpp` (`physicalOutputs`, construit depuis
les genres de nœuds) et `native/audio-engine/test/native_tests.cpp`
(« an undeclared destination is refused, whatever it is called »).

---

## D-009 — Les réglages sont écrits de façon atomique

**Statut** : en vigueur · antérieure à `c3c00c9`

**Contexte** — Les réglages sont sauvegardés à **chaque** modification du graphe
ou de la disposition. Une coupure en pleine écriture laissait un JSON tronqué,
que `loadSettings` écartait silencieusement — emportant avec lui tous les nœuds
et tous les câbles.

**Décision** — Écriture dans un fichier `.tmp` puis `renameSync` sur la cible.

**Conséquence** — Le pire cas est de perdre la dernière écriture, jamais l'état
antérieur. Tout nouveau chemin d'écriture de fichier utilisateur doit adopter le
même motif.

**Ce qui justifierait de revenir dessus** — Rien.

**Preuve dans le code** — `src/main/settings.js:45-53`

---

## D-010 — Un seul document d'architecture, non fragmenté

**Statut** : en vigueur · 2026-09-02, prolonge le commit `b115b41`

**Contexte** — Le projet est passé de 26 fichiers Markdown épars à deux
documents. Le réflexe suivant — éclater l'architecture en `docs/` pour la
« divulgation progressive » — recréerait mécaniquement le problème résolu : des
fichiers qui divergent, dont aucun ne fait autorité.

**Décision** — `ARCHITECTURE.md` reste **un seul document**, avec sa table des
matières. La divulgation progressive se fait par **routage depuis `AGENTS.md`**
(« tu touches au séquenceur → lis §9 »), pas par découpage. `docs/` accueille ce
qui n'est pas du texte de référence : aujourd'hui les images de
`design-references/`.

**Conséquence** — `ARCHITECTURE.md` est long (~41 Ko) et ne doit jamais être
chargé en entier par réflexe. `AGENTS.md`, lui, reste court et se lit
intégralement.

**Ce qui justifierait de revenir dessus** — Un document devenu assez gros pour
qu'aucun agent n'en trouve la bonne section, mesuré sur des sessions réelles et
non supposé.

**Preuve dans le code** — `AGENTS.md` §3, `ARCHITECTURE.md` (table des matières)

---

## D-011 — Les invariants sont vérifiés mécaniquement

**Statut** : en vigueur · 2026-09-02

**Contexte** — ARCHITECTURE §13 énonce douze invariants. Un invariant qui
n'existe qu'en prose est un invariant qu'un agent enfreint de bonne foi, sans
qu'aucun signal ne le contredise.

**Décision** — `scripts/check-invariants.mjs` (`npm run check`) traduit en
échecs mécaniques ceux des invariants qui sont vérifiables statiquement.
Node stdlib, zéro dépendance, cohérent avec D-003. Les invariants non
vérifiables statiquement restent couverts par les tests et la relecture : le
thread audio (invariant 3), la symétrie register/unregister (5), et
l'échappement avant `innerHTML` (9) — pour ce dernier, toute heuristique
testée signalait une vingtaine de lignes de journal et de titres de fenêtre
parfaitement légitimes.

**Conséquence** — `npm run check` fait partie de la définition de « fini ».
Un invariant nouvellement énoncé dans ARCHITECTURE §13 doit s'accompagner soit
d'une règle dans le vérificateur, soit d'un test, soit d'une justification
écrite de son absence.

**Ce qui justifierait de revenir dessus** — Un vérificateur qui produirait assez
de faux positifs pour qu'on prenne l'habitude de l'ignorer. Le remède serait de
retirer la règle fautive, pas l'outil.

**Preuve dans le code** — `scripts/check-invariants.mjs`, `package.json`
(script `check`)

---

## D-012 — Une coquille, au plus une façade, jamais mélangées

**Statut** : en vigueur · 2026-09-02

**Contexte** — Le dépôt porte deux feuilles de style aux palettes opposées :
`base.css` sombre et `omni-pearl.css` claire. Lues de loin, elles ressemblent à
une migration abandonnée, et le réflexe est de vouloir « unifier » — soit en
fusionnant les deux, soit en supprimant la seconde.

Les deux réflexes sont faux. `base.css` habille la **coquille** (entête, barre
latérale, Patch Bay, câbles, modales) ; `omni-pearl.css` est une **façade
d'appareil** destinée aux surfaces d'instrument posées dans cette coquille, avec
sa bibliothèque de composants générique (`ui/omniPearl.js` : potentiomètres,
sélecteurs, interrupteurs, boutons-icônes, tous construits autour de vrais
éléments de formulaire pour préserver le clavier et les lecteurs d'écran).

La supprimer coûterait la réécriture complète de l'arpégiateur **plus** l'ajout
à `base.css` des primitives qu'on viendrait d'en retirer : `base.css` n'a ni
potentiomètre, ni interrupteur, ni grille pas-à-pas.

**Décision** — Trois règles.

1. **Confinement, pas empilement.** `.omni-pearl` redéfinit son propre jeu
   complet de tokens et ne consomme aucune variable de `base.css`. Un module
   choisit un vocabulaire pour **tout son sous-arbre** ; les deux ne se
   mélangent jamais. La coquille n'est jamais habillée.
2. **Une coquille, au plus une façade.** Un nouveau look étend ou remplace
   `omni-pearl` ; il ne s'y ajoute pas.
3. **Une classe de façade seulement là où sa feuille est chargée.**
   `clip-editor.html` ne charge que `base.css`.

**Conséquence** — L'étendue de la façade se décide éditeur par éditeur et non
en bloc ; par défaut un nouveau module utilise `base.css`. Les deux dernières
règles sont mécaniques : `npm run check` refuse une troisième feuille de style,
et refuse une classe `op-` dans le Clip Editor. Cette seconde règle **lit** le
document plutôt que de le supposer : elle se désarme d'elle-même le jour où
`clip-editor.html` chargera la façade. Comportement vérifié par sonde dans les
trois sens.

**Ce qui justifierait de revenir dessus** — Un besoin réel de deux façades
simultanées, c'est-à-dire deux familles de surfaces d'instrument dont l'aspect
doit différer. À ce jour il n'en existe qu'une.

**Preuve dans le code** — `src/renderer/styles/omni-pearl.css:1-19` (l'intention
d'origine, écrite par son auteur), `src/renderer/js/ui/omniPearl.js:1-16`,
`scripts/check-invariants.mjs` (règles `faceplate scope` et `one faceplate`),
`AGENTS.md` §6


---

## D-013 — La gestion de presets reste hors périmètre

**Statut** : en vigueur · 2026-09-03

**Contexte** — Le refus avait été levé le 2026-09-02 ([INTENT.md](INTENT.md)
§8), et un ExecPlan a mené le chantier jusqu'à l'étape 8 sur 9 : conteneur
`.vstpreset` lu et écrit en JS pur, commande native `loadPresetChunks`, Class ID
VST3 remonté du scanner, source disque, nœud Preset câblable, étage réseau avec
index JSON signé. Environ 2 750 lignes, tests compris.

Quatre mesures, prises le 2026-09-03, disent pourquoi ça ne mène nulle part :

- **fichiers `.vstpreset` sur la machine : zéro.** Les deux répertoires
  standards (`%LOCALAPPDATA%` et `%COMMONPROGRAMFILES%\VST3 Presets`)
  n'existent même pas ;
- **catalogues publics au format `minihub-preset-index` : zéro.** Le format est
  né dans ce dépôt et n'a aucun producteur ;
- **utilisateurs : un** (§2). Une banque communautaire suppose une communauté ;
  ici le seul contributeur possible est aussi le seul lecteur ;
- **le seul format applicable à chaud est le moins répandu.** `loadPresetChunks`
  ne consomme que du `.vstpreset` ; les banques publiques réelles distribuent
  du `.fxp`, du `.syx`, du `.vital`.

S'y ajoute une redondance que la mesure ne montre pas : le besoin est **déjà
servi deux fois**. Chaque VST3 embarque son propre navigateur de presets, et
`capturePluginStates` / `persistPluginStateChunk` persistent déjà l'état de
chaque plugin dans le projet. Le nœud Preset était le troisième dispositif à
faire la même chose.

**Décision** — Le refus est reconduit. Le code est retiré du tronc. Il n'est pas
détruit : il vit dans le commit `b1cb405` de la branche `feat/presets-universels`,
avec son ExecPlan et son journal.

Deux étapes du chantier sont **conservées**, parce qu'elles ne relèvent pas du
preset et corrigeaient de vrais défauts :

- la couture d'éditeurs (`core/nodeEditors.js`, `core/disposers.js`), qui est
  la sous-tâche que [ROADMAP.md](ROADMAP.md) §4 nomme ;
- le `classId` VST3 dans le catalogue, qui donne enfin aux plugins une identité
  portable là où `pluginId` était un chemin absolu propre à cette machine —
  exactement ce que §2 interdit de coder en dur.

**Conséquence** — §7 (le réseau) perd son unique consommateur prévu : ses règles
restent écrites, mais comme cadre pour un usage futur, pas comme description
d'un existant. Trois correctifs de sécurité en attente disparaissent avec le
code qu'ils visaient, dont le canal `presets:download` qui acceptait n'importe
quelle URL HTTPS. La liste blanche des commandes moteur reperd
`loadPresetChunks`.

**Ce qui justifierait de revenir dessus** — Pas l'abondance de presets : le
besoin qu'ils servent est déjà couvert. Ce qui le justifierait, c'est le manque
que ce chantier avait lui-même mis hors périmètre — **rappeler une configuration
MiniHub** : une chaîne VST plus un arpégiateur plus des mappings MiniLab,
recallable dans un autre projet. Aucun navigateur de plugin ne le fera jamais.
C'est un autre modèle de données, il ne traverse aucun réseau, et il ne duplique
rien d'existant.

**Preuve dans le code** — l'absence : aucun fichier `preset*` sous `src/`,
`loadPresetChunks` absent d'`engineCommandPolicy.js`, aucun type de port
`preset` dans `routingCore.js`. Le chantier retiré : commit `b1cb405`.

---

## D-014 — Fermer MiniHub sauvegarde ; la question ne se pose qu'une fois

**Statut** : en vigueur · 2026-09-03

**Contexte** — Toute fermeture d'un projet modifié ouvrait la même boîte :
« Discard changes / Cancel ». Elle apparaissait exactement au moment où
l'utilisateur a déjà décidé de partir, et son unique bouton d'action détruisait
le travail. Une boîte qui surgit à chaque sortie et dont on clique toujours le
même bouton n'est plus lue : elle enseigne un réflexe, puis emporte une session
le jour où ce réflexe se trompe.

**Décision** — À la fermeture, un projet qui possède **déjà un fichier** est
écrit à sa place, sans rien demander — le modèle des stations de travail
(DaVinci Resolve). Un projet **jamais enregistré** est le seul cas qui pose une
vraie question, celle de la destination : la boîte devient « Save… / Quit
without saving / Cancel », défaut sur Save.

La sauvegarde appartient au renderer (capture des états VST3, instantané,
écriture atomique) : la fermeture est donc un **aller-retour IPC** borné à 20 s.
Tout ce qui n'est pas une sauvegarde confirmée — refus, échec d'écriture,
renderer devenu muet — rouvre un dialogue explicite. Rien ne se ferme en silence
sur une perte, et un renderer bloqué ne peut pas condamner la fenêtre.

**Conséquence** — Fermer n'est plus un moyen d'annuler. MiniHub n'a pas
d'historique d'édition : une suppression malheureuse suivie d'une sortie est
définitive. Le garde-fou disponible est `Save As` **avant** l'expérience
risquée, pas la croix de la fenêtre après.

**Ce qui justifierait de revenir dessus** — Un dispositif qui rende la sortie
réversible : historique d'annulation persistant, ou versions successives du
`.minihub` conservées à chaque sauvegarde automatique. Tant qu'aucun des deux
n'existe, l'écriture reste préférable à la boîte, parce qu'elle perd moins.

**Preuve dans le code** — `src/main/projectCloseGuard.js`,
`src/main/main.js` (`requestProjectSave`, `PROJECT_SAVE_TIMEOUT_MS`),
`src/renderer/js/core/projectManager.js` (`saveForClose`, `bindCloseSave`),
`test/projectCloseGuard.test.cjs`

---

## D-015 — Aucun fichier n'atterrit dans un dossier que l'utilisateur n'a pas choisi

**Statut** : en vigueur · 2026-09-03

**Contexte** — Deux défauts de même nature. Chaque sélecteur repartait de son
dossier d'origine (`Documents/MiniHub/Projects`, `Musique`) : un utilisateur
dont les mixdowns vont sur un autre disque refaisait la même navigation à
chaque export. Pire, les prises enregistrées étaient **classées sans aucun
choix** dans `Musique/MiniHub Recordings` — un dossier que rien dans l'interface
ne nommait, et que l'utilisateur devait deviner.

**Décision** — Quatre mémoires distinctes — projet, export audio, import audio,
prises — dans `recentDirectories` (préférences applicatives), alimentées de deux
façons selon qu'il existe un sélecteur ou non :

- **avec sélecteur** (projet, export, import) : le dossier retenu est celui du
  fichier que l'utilisateur vient de choisir, et le sélecteur suivant s'y ouvre ;
- **sans sélecteur** (prises) : une prise est classée à l'instant où elle se
  termine, donc son dossier se choisit **une fois** dans Settings, pas après
  chaque prise.

Les dossiers d'origine ne sont plus que des points de départ : repli au premier
usage, ou quand le dossier mémorisé a disparu (disque débranché, dossier
supprimé). Le panneau Settings affiche les trois **destinations** — prises,
exports, projets — avec leur chemin complet, un bouton pour en changer et un
bouton pour les ouvrir. Un dossier d'écriture qui n'est nommé nulle part est un
dossier que l'utilisateur doit chercher ; c'est le défaut d'origine, et il ne se
corrige pas en mémorisant mieux.

Des mémoires séparées, parce qu'un « dernier dossier » unique enverrait le
prochain export dans le dossier de projets dès qu'un projet vient d'être ouvert.

**Conséquence** — Le processus principal devient l'auteur d'une clé de
`settings.json`, ce qui crée un piège : le renderer réécrit le fichier **en
entier** depuis la copie qu'il a chargée au démarrage, où tout dossier retenu
depuis n'existe pas. `saveSettings` réimpose donc cette clé depuis le disque à
chaque écriture venue du renderer (`carryDirectoryMemory`). Ce report n'est pas
une redondance : le supprimer efface silencieusement la mémoire de tous les
sélecteurs à la première modification de préférence.

**Ce qui justifierait de revenir dessus** — Un modèle où le renderer cesserait
d'écrire l'objet de préférences entier ; le report deviendrait alors inutile,
mais pas la mémoire elle-même. Pour les prises, un dossier **par projet** (à la
manière d'un dossier média de session) si un jour un projet doit être
déplaçable avec son audio ; ce serait une autre décision, pas un réglage.

**Preuve dans le code** — `src/main/recentDirectories.js`,
`src/main/settings.js` (`saveSettings`, `rememberDirectory`,
`rememberDirectoryOfFile`), `src/main/main.js` (`effectiveDirectory`,
`fallbackDirectory`, `directories:*`),
`src/renderer/js/ui/settingsModal.js` (`FOLDER_ROWS`),
`test/recentDirectories.test.cjs`, `test/settingsDirectories.test.mjs`

---

## D-016 — L'automation entre dans le périmètre, sous la forme d'un nœud Matrix

**Statut** : en vigueur · 2026-09-03 · **décidé, pas encore implémenté**

**Contexte** — `automation` figurait dans la liste « hors périmètre par défaut »
d'[INTENT.md](INTENT.md) §6. Or le §3 du même document désigne « jouer de la
musique générative en direct » comme l'un des **deux usages qui définissent le
produit**. Les deux lignes se contredisaient depuis l'origine : un setup
incapable de changer d'état tout seul dans le temps ne joue pas de musique
générative, il joue une boucle.

**Décision** — Le refus est levé, dans la forme précise d'un nœud **Matrix** :
unique par projet, ajouté à la main, qui ne gouverne que les nœuds auxquels il
est réellement câblé par un lien `control`. Reste refusé, sans changement : la
piste d'automation du séquenceur (ligne, points, courbe dessinée sur
l'arrangement), le langage de script, la génération par modèle.

La frontière tient en une phrase : la Matrix **gouverne des nœuds**, elle ne
**dessine pas des courbes sur un temps**.

**Conséquence** — [INTENT.md](INTENT.md) §6 perd le mot `automation` et gagne un
§8 bis qui porte la levée et ses limites. Le Morpher cesse d'être proposé à la
création, sans être supprimé (§12 de la spécification).

**Ce qui justifierait de revenir dessus** — Que la Matrix se mette à exiger une
piste d'automation dans l'arrangement pour être utilisable. Ce serait le signe
que le modèle « scènes + règles » ne suffit pas, et donc que ce qui était
vraiment voulu est l'automation de DAW du §6 — laquelle reste refusée. La levée
serait alors à annuler, pas à élargir.

**Preuve dans le code** — l'absence, aujourd'hui : aucun type `matrix` dans
`src/renderer/js/core/nodeTypes.js`, aucun port `control` en entrée ailleurs que
`vst.ctrl-in`. La contradiction qui a motivé la levée est lisible telle quelle
dans `INTENT.md` §3 contre `INTENT.md` §6 avant ce commit.

---

## D-017 — La Matrix compte son propre temps musical, au tempo global

**Statut** : en vigueur · 2026-09-03 · **décidé, pas encore implémenté**

**Contexte** — La spécification demandait deux choses incompatibles. Les scènes,
fades et rampes devaient être cadencés par la position PPQ du Transport (§9.2),
et une action d'entrée de scène devait pouvoir **arrêter** le séquenceur (§4.1,
critère d'acceptation §15.B).

Or `Transport::advance()` sort immédiatement quand le transport ne joue pas :

```cpp
void advance(int n) noexcept { if(!processingPlaying()||n<=0)return; ... }
```

Une scène qui arrête le séquenceur gèle donc l'horloge de la Matrix elle-même :
sa durée ne s'écoule jamais, ses règles de sortie ne se déclenchent jamais, un
« Next Scene à la prochaine mesure » n'arrive jamais. Et le défaut est double —
`seekPpq()` rembobine le PPQ, donc une action `Restart`, en remettant
l'arrangement à zéro, remettrait aussi à zéro la progression de la scène qui
vient de la déclencher. Asservir la Matrix au PPQ du Transport casse exactement
les deux actions pour lesquelles elle existe.

**Décision** — La Matrix possède **son propre compteur** de temps musical, dans
le moteur natif, avancé par le compteur d'échantillons du callback. Elle ne
rembobine jamais et ne s'arrête que sur un Stop de la Matrix.

**Ce compteur n'est pas une seconde horloge : c'est un second compteur sur la
même horloge.** Son tempo est relu à chaque bloc dans le `Transport` global.
Deux conséquences, et ce sont précisément celles qui étaient voulues :

- **aucune dérive possible.** La Matrix et le séquenceur avancent du même
  `quarterNotesPerSample`, issu du même BPM et du même compteur d'échantillons.
  Leurs mesures ont la même longueur, à l'échantillon près ;
- **phase commune par construction.** C'est la Matrix qui lance le séquenceur,
  sur une de ses propres frontières de mesure. Les deux partent alignés et
  avancent au même rythme, donc ils restent alignés. Un séquenceur branché en
  aval est synchronisé sans qu'aucun mécanisme de resynchronisation n'existe.

Un changement de BPM pendant une rampe déplace sa fin exactement comme le
demande §7.1, puisque le BPM est relu à chaque bloc et non figé au départ.

**Ce que ça n'est pas** — Ce n'est pas un timer JavaScript : l'interdiction du
§9.2 visait la gigue et la dérive du renderer, et elle est intégralement
respectée. Ce n'est pas non plus un second `Transport` au sens de l'export : la
Matrix ne fournit aucun `AudioPlayHead` à aucun plugin.

**Ce qui justifierait de revenir dessus** — Un usage où le séquenceur, et non la
Matrix, serait le maître : l'utilisateur lance l'arrangement à la main et veut
que les scènes se mettent en pause avec lui. Ce serait un interrupteur « suivre
le transport » par projet — un ajout à cette décision, pas son annulation.

**Preuve dans le code** — `native/audio-engine/src/transport.h` : `advance()`,
`seekPpq()`, `processingPlaying()`. Le précédent d'un second contexte temporel
indépendant existe déjà : `offlineExportTransport_` dans
`native/audio-engine/src/sequencer.h`.

---

## D-018 — Un seul Learn armé dans l'application, avec un propriétaire nommé

**Statut** : en vigueur · 2026-09-03 · **décidé, pas encore implémenté**

**Contexte** — `ControlBindingManager` détient **un** `pendingLearn`, au
singulier, pour toute l'application, et le moteur natif supersède sa demande
d'armement de façon atomique. La spécification Matrix demandait un second
système Learn (§5) en se protégeant uniquement de l'écrasement des *mappings*
MiniLab (§5.2) — pas de celui de l'*armement*. Deux systèmes indépendants qui
arment le même plugin : le second annule silencieusement le premier, et
l'utilisateur voit une capture partir dans la mauvaise ligne.

Second défaut, dans l'existant : `armLearn()` ne sait pas viser une instance
choisie. Il échoue en `multiple-plugin-targets` sauf si exactement un plugin est
prêt, ou exactement un éditeur est ouvert. La Matrix, elle, a besoin que
l'utilisateur désigne l'instance (§5.1 étape 2).

**Décision** — Un **arbitre de Learn partagé** : une seule demande armée à la
fois dans l'application, portant l'identité de son propriétaire
(`minilab` | `matrix`). Armer depuis la Matrix annule explicitement un armement
MiniLab en cours, et réciproquement — visiblement, jamais en silence. L'arbitre
gagne l'armement par instance explicite, dont les deux clients bénéficient.

Les **persistances restent séparées** : les mappings MiniLab restent dans
`controlBindings` du nœud VST, ceux de la Matrix dans le contenu du nœud Matrix.
C'est l'armement qui est partagé, pas le carnet d'adresses.

**Conséquence** — La phase 2 du chantier Matrix contient un refactor de
l'existant, pas seulement un ajout. C'est assumé : l'alternative était de
dupliquer ~300 lignes aux règles de validation subtilement divergentes, dans un
domaine — l'identité d'un paramètre VST3 vivant — où une divergence subtile
écrit dans le mauvais plugin.

**Ce qui justifierait de revenir dessus** — Que le moteur natif accepte
plusieurs armements simultanés, distingués par `learnId`, sur des instances
différentes. L'arbitre deviendrait un registre à N entrées ; le principe d'un
propriétaire nommé resterait.

**Preuve dans le code** — `src/renderer/js/core/controlBindings.js` :
`this.pendingLearn` (singulier), `armLearn()` et ses échecs
`multiple-plugin-targets` / `multiple-plugin-editors-open`, le commentaire
« The native engine also supersedes its previous operation atomically ».
Côté natif : `PluginInstance::armParameterLearn`, `activeLearnId_`.

---

## D-019 — Every document is in English, like the code

**Status**: in force · 2026-09-04

**Context** — Until today AGENTS.md §6 split the repository in two: English for
code, comments, docstrings and identifiers; accented French for `.md` documents.
That split was coherent while the only reader was the author. Three facts
changed it. The repository is public and MIT-licensed. The public site
(`minihub.site`) was decided in English, without discussion. And the documents
are the *only* way to understand this project: the architecture is not derivable
from the code — it is written in ARCHITECTURE.md, and the reasons live here.

A contributor who lands on a public repository and cannot read why the audio
thread never blocks does not read the code more carefully. They open a pull
request that breaks invariant 3.

**Decision** — Everything is in English: code and `.md` documents alike. The
split in AGENTS.md §6 is removed, not softened.

The vocabulary is **not invented for the occasion**: it is taken from the code,
which was already English. `scripts/check-invariants.mjs` already names the
concepts — `shell` and `faceplate` for the two stylesheets, `renderer
isolation`, `project keys`, `system node ids`, `module boundary`. Translating
towards any other term would have created a fifth naming layer, the failure mode
D-008 exists to prevent.

**Consequence** — Commit messages before 2026-09-04 stay in French. They are
history: rewriting them would change every hash for no gain. File names do not
change either, which is what keeps this cheap — the 62 inter-document links
point at file names, never at section anchors, so no link breaks.

`npm run check` enforces nothing here: no rule reads a `.md` file. This decision
therefore rests on review, not on a command — which makes it weaker than the
others in this register, and it is worth saying so plainly.

**What would justify revisiting it** — A contributor base that reads French
better than English, or documents so tied to French phrasing that the English
version loses precision. Neither is true today: these documents are technical,
and their vocabulary was already English underneath.

**Proof in the code** — `AGENTS.md` §6, `scripts/check-invariants.mjs` rule
names, and the `minihub-site` repository, written in English from its first
commit.

---

## D-020 — A controller is declarative data, and profiles are shared as files

**Status**: in force · 2026-09-04

**Context** — `INTENT.md` §6 refused an extensible platform and a multi-user
product, and `MINIHUB_CONTROLLER_PLATFORM_SPEC.md` §2 names four dated lines it
contradicts. The gate was real, and it is now crossed deliberately rather than
drifted through: the repository is public, the site is published, and someone
who owns a different keyboard is no longer hypothetical.

But the refusal was also already costing something, independently of anyone
else. `MINILAB_CONTROL_SOURCES` in `midi/minilabControls.js` **is** a profile,
written as a JavaScript literal. The hardware is welded into the core, which
`INTENT.md` §5 calls a defect and D-008 fixed on the JS side without finishing
on the C++ side. Extracting it is owed whether or not a second controller ever
exists.

**Decision** — Lift the refusal for exactly two things, and no more: a versioned
declarative profile format describing one controller, and profiles living as
files in the repository, contributed by pull request.

The boundary is **extensible by data, never by code**. A profile value is a
scalar, an array or an object — never a function, a script, a command, a system
path, a DLL, an executable URL or a callback. That is a `npm run check` rule, so
it fails a build rather than a review.

Refused, still, and named here so the lifting cannot be widened by reading:
accounts, login, sync, any backend, any submission API, moderation tiers,
sharing of `.minihub` projects, and any runtime dependency on the site.

**Consequence** — Étape A of the specification (extracting the reference profile)
becomes legitimate work rather than speculation, and it is the prerequisite for
everything after it: the site Builder copies the Étape A decoder verbatim, so
building the Builder first would mean writing it twice.

A second consequence has a date attached. §6.8 of the specification: D-018
refactors `ControlBindingManager`, and Étape A refactors the same file. Out of
order, that refactor is paid twice, and D-018's owner name `minilab` is already
wrong before being written — in the plural it has to be `controller:<profileId>`.
The Matrix workstream is therefore on standby until its owner says otherwise,
and Étape A takes the single active-plan slot.

**What would justify revisiting it** — Evidence that profiles cannot in fact
describe a second real device without adding executable escape hatches. That
would mean the format is wrong, not that the boundary is; the answer would be to
fix the format, and if it cannot be fixed, to withdraw the lifting rather than
let code in through it.

**Proof in the code** — `src/renderer/js/midi/minilabControls.js`
(`MINILAB_CONTROL_SOURCES`, the profile already written as a literal),
`INTENT.md` §8 ter, and `MINIHUB_CONTROLLER_PLATFORM_SPEC.md` §3.1 and §9.

---

## D-021 — The bindings bar docks under the plugin window, and stays HTML

**Status**: in force · 2026-09-04 · **decided, not implemented**

**Context** — Learning a knob today costs two windows and a head movement. The
MiniLab surface, the Learn button and the binding list live in MiniHub; the
plugin editor whose parameter is being learned is a separate window, opened by
the engine, usually covering what you were just reading. The author asked for one
window.

Verified before answering, because it decides everything: the plugin editor is
**not** an Electron window. It is a hand-built Win32 frame created in the engine
process — `WS_OVERLAPPEDWINDOW`, with a `STATIC` child the VST3 view attaches to
by `kPlatformTypeHWND`. Chromium runs in another process and cannot draw one
pixel inside it.

**Decision** — A separate frameless Electron window, rendering the existing
bindings interface, **docked under** the plugin editor and moving with it as one
piece. Not one window: two that share an edge and are never seen apart.

**It replaces the panel, it does not duplicate it.** Once the docked bar exists,
`renderControlBindings()` leaves the VST node's editor inside MiniHub: bindings
are reached from the plugin window and from nowhere else. That is what makes this
one place instead of two, and it is why the interface is moved rather than
cloned — a second copy would be a second thing to keep in step.

Two alternatives were weighed and refused:

- **A host strip inside the plugin frame.** The frame is ours, the child could be
  shortened, and every DAW does exactly this. It is refused because the strip
  would have to be drawn in C++/Win32, in the engine process: a second
  implementation of an interface that already exists in HTML, in a third visual
  vocabulary that is neither `base.css` nor `omni-pearl`, added to the one process
  that must never die because it owns the audio device.
- **Reparenting the plugin `HWND` into the Electron window.** It works on
  Windows. It also marries two processes that were separated on purpose — the
  engine is a singleton child so that it can own the device independently — and it
  makes a plugin crash take the visual host down with it.

The choice is reversible in the direction that matters: the IPC the docked window
needs is exactly the IPC a host strip would need. If docking proves not to be
enough, A is still reachable; if it proves enough, A is never built.

**Consequence** — One piece of native work, and it is small: `editorStatus`
reports `width` and `height` but **no position**, and nothing is emitted when the
user drags the window. The engine has to report the frame's position, on move and
on resize. Everything else is renderer work reusing `renderControlBindings()`
unchanged.

Ordering, and it is the same trap as the specification's §6.8: **D-018** — one
armed Learn in the application, with a named owner — refactors
`ControlBindingManager`, which is what this docked window drives. Built in the
wrong order, that refactor is paid twice. This comes after Étape A, and after or
with D-018, never before.

One case looked like a gap the removal would open, and it is not one. **A plugin
with no editor of its own cannot be learned today either.** `armLearn()` will
arm without an open editor when the chain holds a single ready plugin, but arming
is not binding: a capture requires the native LEARN to observe a parameter
gesture, and there is no way to make that gesture on a plugin that shows nothing.
Removing the panel takes nothing away — a plugin you cannot touch has nothing to
map. Author's answer, 2026-09-04, and the reason this entry states it rather than
leaving it open.

Settled while building, not in advance: stacking order against a plugin window
that is itself always-on-top, behaviour across monitors at different DPI, what
happens when the editor is minimised, and what the bar does when the plugin
window sits at the very bottom of the screen.

**What would justify revisiting it** — A plugin whose window cannot be tracked
reliably, or a stacking behaviour that makes the bar flicker or steal focus during
ordinary use. Either would mean docking cannot be made to feel like one window,
and the answer would then be the host strip of option A, not a worse dock.

**Proof in the code** — `native/audio-engine/src/plugin_host.cpp`
(`EditorWindow::open()`, the `CreateWindowExW` frame and its `STATIC` content
child), `native/audio-engine/src/engine.cpp` (the `editorStatus` payload:
`width` and `height`, no position), `src/main/engineCommandPolicy.js` (the
allow-list a new command has to enter), and
`src/renderer/js/core/nodeInstances.js` (`renderControlBindings()`, the interface
being reused rather than rebuilt).
