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

---

## D-022 — One other controller, not N

**Status**: in force · 2026-09-04 · **implemented 2026-09-04** —
[plans/done/other-controller.md](plans/done/other-controller.md), 6 of 6 steps.
The half with a user is built; the plural this entry refuses is untouched.

**Context** — Étape A of `MINIHUB_CONTROLLER_PLATFORM_SPEC.md` is finished: the
MiniLab 3 is a profile file, and the engine no longer knows any keyboard by name.
Étape B, "le pluriel", was next in that document: a multi-input `MidiManager`, N
controller nodes, a generic Patch Bay node, a generalised sequencer ingress.

Two facts decided against it, and neither is about taste.

The specification's own §2 says Étapes B, C and D require amending
[INTENT.md](INTENT.md), written and dated. INTENT §5 says why: *"not making it
impossible ≠ generalising now. Writing an abstraction layer for controllers that
do not exist in this project is speculative work."*

And the author has **one** controller. Asked directly on 2026-09-04: no second
keyboard. The next real user is named and dated — a friend who will configure his
own keyboard, which is the condition on which the application repository stops
being private — but he is not here yet.

**Decision** — Étape B as written is **not** done. What is done instead is the
half of it that has a user: **the single controller slot stops being a MiniLab
slot and becomes a profile slot.**

The distinction, in one sentence: *plugging in a different keyboard* is what a
friend needs; *using two keyboards at once* is what nobody has asked for. They
were bundled in one étape, and they are not the same size, the same risk, or the
same product.

In scope:

- port roles read from the profile's `device.ports` (spec §4.2) instead of
  `midi/minilab.js` — which is what Étape A left owed, and what lets a port that
  is not called "Minilab3 MIDI" be recognised at all;
- the controller node's identity taken from the loaded profile;
- the sequencer's canonical MIDI ingress accepting the controller node rather
  than one id (`sequencerController.js:9`, five call sites);
- the header naming the connected device from the profile instead of two
  hard-coded strings.

Out of scope, and refused for now:

- **`selectedInputId` stays singular.** No multi-input `MidiManager`, no settings
  migration, no N controller nodes. That is the part that touches the signal path
  in several places at once, and it is the part with no user.
- no second profile is **shipped**. The application keeps exactly one. That a
  second works is proved by a fixture in `test/`, not by data for hardware nobody
  owns — which is precisely what INTENT §5 calls speculative.

**Consequence** — A friend with a different keyboard can write a profile and use
MiniHub. That is the milestone the repository's visibility already waits on, so
this étape has a user before it has code, which is the opposite of how Étape B
was framed.

The plural is not refused forever; it is refused **until someone plugs in a second
keyboard**. The day that happens, `selectedInputId` is the one thing to reopen,
and nothing in this étape blocks it.

Calendar, carried over from spec §6.8 and D-021: **D-018** refactors
`ControlBindingManager` with an owner named `minilab`, which is wrong the moment
a profile can be something else. When D-018 is implemented, that name is
`controller:<profileId>`.

**What would justify revisiting it** — A second controller on the desk, or a user
who genuinely needs two at once. Either makes the plural concrete rather than
speculative, and the refusal above lifts by the same mechanism that lifted this
one.

**Proof in the code** — `src/main/settings.js:21` (`selectedInputId`, singular
and staying so), `src/renderer/js/midi/minilab.js` (the port roles that belong in
`device.ports`), `src/renderer/js/core/sequencerController.js:9`
(`isCanonicalMidiIngress`), `src/renderer/js/ui/header.js:50` and `:53` (the two
hard-coded device strings), and `plans/done/controller-profile.md`, whose closing
entry names the decoder's remaining dependency on `midi/minilab.js`.

---

## D-023 — `layout` is optional, and its absence is the answer

**Status**: in force · 2026-09-05 · **not implemented** — specification only
(§4.4 revised, §5.3 bis added). The validator still requires `layout`, and
nothing reaches the list mode while the MiniLab is the only profile and carries
its coordinates.

**Context** — D-020 turned a controller into a profile file, and spec §4.4
required `layout` from v1 for a sound reason: without coordinates the Patch Bay
stacks 25 ports at 30 px — ~760 px of node — and the drawing code was arithmetic
that assumed four knobs to a row.

What that section never checked is whether anything could **fill** the field. It
cannot. The Builder's five steps (§5.3) capture what a device *sends* — a full
sweep, a turn in each direction, press-release-press — and not one of them asks
where a control sits.

And the field is not decoration. `core/nodeGeometry.js` places a control port at
its profile coordinate, so the drawing **is** the wiring surface: pulling a cable
is aiming at a spot on a picture. A layout that puts K1 where K3 sits makes the
user cable the wrong control, in silence. It corrupts nothing saved — a binding
is `<profileId>:<controlId>`, never a position — but it is a data-entry error
with no error message.

**Decision** — Two outcomes, both honest, distinguished by **presence** rather
than by a flag.

- **With a photograph of the user's own device**: the Builder shows it as a
  backdrop and asks one extra gesture per control — move it, then click it on the
  photo. The MIDI message gives the identity, the click gives the position.
  Nothing is recognised in the image and nothing needs to be.
- **Without one**: the controls are a list, and `layout` is **absent**.

`layout` therefore becomes **optional**. Three alternatives were refused:

- **a default grid** — it invents ordinality: four knobs to a row, one row of
  pads, and a physical order that CC numbers do not carry. It yields a drawing
  that is plausible and wrong, which §1.3 refuses in as many words — *« un profil
  à 95 % qui prétend 100 % »*;
- **a `confidence` on the layout** — a field flagged unsure is read as sure
  within six months. A field that is not there cannot lie;
- **analysing the photograph** — it could never answer the only question that
  matters, which is *which* of eight identical knobs sends CC 74. The Builder
  already knows, from the message it just received.

**Consequence** — The precision required is **ordinal, not metric**: twenty
pixels of drift change nothing, while swapping K3 and K4 breaks the surface. The
photograph is the only mechanism in the journey that measures that ordinality
rather than assuming it, which is why it is the primary path and the list is the
fallback — not the reverse.

The application side is one already-existing mode: a node without `node.surface`
falls back to the port list every other node uses. Its only work is the ~760 px
column §4.4 measured, which is a defect of the single column rather than of the
list — in columns, or grouped by `family`, 25 controls fit in about 250 px.

Nothing is built now, on purpose: while the MiniLab is the only profile, the list
mode is never reached, and building a path nothing walks is what `INTENT.md` §2
refuses. It becomes necessary with the Builder (Étape C).

**Measured 2026-09-05, after this entry was written** — five in-browser detectors
were run against a photograph of the author's own MiniLab 3, each given the
control counts the MIDI already knows, so the question asked was the easy one.
The best result was OWLv2 (~600 MB), which found the eight backlit pads and
labelled piano keys as faders; Florence-2 large answered "computer monitor", the
same as its base. The click is therefore not a fallback waiting for automation to
mature — it is what works. And the criterion the author set is what closes it:
**the reference photograph is the poor one**, since people send what their phone
takes at night. A detector needing studio light moves the problem onto the user.
A person, by contrast, recognises their own keyboard on a bad photograph.
Specification §10, question 0.

**One click per control** — the journey is a loop, not a sequence of armings.
Nothing is re-armed between two controls, and the family is asked only where the
message does not already answer it. Over forty controls, a confirmation button is
forty wasted clicks, and tedium is what leaves a profile unfinished.

**What would justify revisiting it** — A way for the Builder to obtain ordinality
without a photograph that does not amount to guessing. Nothing on the table does:
Web MIDI with `sysex: false` (§5.2) exposes `name`, `manufacturer` and `id`, and
none of the three says where a knob is.

**Proof in the code** — `src/renderer/js/core/nodeGeometry.js:65-71` (the control
port placed from `node.surface.ports[port.id]`), `:50` (`SURFACE_NODE_HEIGHT`
against the `PORT_ROW = 30` stack), `src/renderer/js/midi/controllerProfile.js`
`validateControls()` (where `layout` is required today, and the one line that
changes when this is implemented), and `src/renderer/js/ui/miniLabControlSurface.js`
(the only consumer of the coordinates).

---

## D-024 — The Builder and the catalogue live on the site, because a profile is shared

**Status**: in force · 2026-09-05 · **not implemented** — specification only
(§5.5 added, §7.2 revised). Nothing is built.

**Context** — A demonstration on 2026-09-05 settled that the Builder needs no
image analysis: the MIDI message says *which* control answered, a click on the
user's own photograph says *where* it is (D-023). That made the mechanism cheap
enough to run anywhere, and the real question surfaced — where should it run?

The case for moving it into MiniHub was serious. The application already has the
MIDI, the Learn mode and the screen; the browser costs Web MIDI, a relaxed CSP,
a second repository and a file transfer to do the same thing further from the
keyboard. §1.3 of the specification even says repair happens in MiniHub, in
front of the hardware.

**It was refused by the author on 2026-09-05, and the reason is what decides this
entry: a profile that works serves everyone who owns the same hardware.**

Two consequences follow that the "move it into the app" case had missed. **Where
a profile is created decides where it is shared** — created in the app it needs
an export, a trip to GitHub and a pull request, three frictions that kill
sharing; created on the site, publishing is the next step of the same journey.
And **the calibration is then paid once per hardware model, not once per user** —
which answers the objection that the journey is tedious. It is tedious for the
first owner of a device, and free for every one after.

**Decision** — the Builder stays on the site, and the site becomes a catalogue
around it. Four parts.

1. **One entry point, which sorts itself.** The site asks for MIDI access, reads
   the input's `name`, matches it against an index of published profiles, and
   opens the hardware's page. No match means "nobody has mapped this yet" and
   starts the Builder with the device already named. Web MIDI with
   `sysex: false` gives `name`, `manufacturer` and `id` — exactly the
   fingerprint of §4.2 — and `portRoles.js` already matches it, decoration
   included, from the copyable set of §3.5. The site and the application
   therefore recognise a keyboard by the same code.
2. **The catalogue is indexed twice, over the same files**: hardware → its
   authors, and author → everything they mapped. The second exists because
   trusting a mapper is a real reason to pick a profile.
3. **Stars, counted where the vote already lives.** ~~Each profile has its
   GitHub discussion; people react and write *why*, and a script commits the
   counts.~~ **Revised 2026-09-05 by D-026**: voting on GitHub requires an
   account of everyone wanting to say "this one works on my desk", which is the
   same barrier the author refused for the nickname. The vote, the report and the
   setup itself all arrive through one Cloudflare Worker instead.
4. **What stays out**: no backend, no account, no telemetry, no deep link. §7.4
   already refuses deep links, and this entry does not reopen them — a profile
   reaches MiniHub as a file the user chooses, never as a site opening the
   application.

**Consequence** — the common journey stops being calibration. It becomes: plug
in, open the site, be recognised, download. Calibration is the first owner's
path, not everyone's. That is a thing a catalogue can do and a menu inside an
application cannot, which is the answer to "why a site at all".

The moderation cost that §7.2 refused does not come back: the author blesses
nothing. Users report, and counts are counted.

**What this obliges elsewhere** — **MiniHub cannot read a profile file today.**
`loadedProfile.js:22` imports `profiles/minilab-3.json` at build time; there is
no import path, and `preload.js` exposes no file access for profiles. Until that
exists the site produces files nothing consumes, so it is the first piece of
work — and it is worth building alone, since a friend writing a profile by hand
needs it just as much as the Builder does.

**What would justify revisiting it** — Nobody publishing a second profile for a
year. The catalogue's whole value is other people's mappings; without them the
site is a download page, and the Builder would have been better inside the app.

**Proof in the code** — `src/renderer/js/midi/portRoles.js` (the matcher the site
copies), `src/renderer/js/midi/loadedProfile.js:22` (the build-time import that
blocks everything), `src/main/preload.js` (`projectPickOpen` / `projectRead`, the
brick to decline for profiles), and `scripts/check-invariants.mjs`
(`shared decoder`, which keeps the copyable set copyable).

---

## D-025 — `profileId` names the hardware, `author` names who mapped it

**Status**: in force · 2026-09-05 · **not implemented** — specification only
(§4.5 revised). The shipped profile already satisfies it.

**Context** — D-024 admits several profiles for one device: two people may map
the same keyboard, and the author wants them ranked hardware first, then by
author. That is new, and it collides with something already persisted.

A saved binding is `<profileId>:<controlId>` (§3.3), written inside every
project. If Alice publishes `donner-dmk25-alice` and Bob `donner-dmk25-bob`,
then switching from one to the other **cuts every cable, in silence** — the
exact failure §3.2 exists to prevent, guarded *inside* a profile by the
`immutable control ids` rule and by nothing *between* profiles.

**Decision** — the identity of a profile is **the hardware**, not the person.

- `profileId` names the device: `donner-dmk25`. It is what enters a binding key.
- `author` names who mapped it. It is what the catalogue's second index and the
  author page read, and it never enters an identity.
- Two mappings of one device are two profiles sharing a `profileId`, told apart
  by `author` and `revision`.

**Consequence** — trying a competing profile costs nothing: the cables say
`donner-dmk25:k1` under either one, so a user can switch, compare and go back.
That is what makes competition useful rather than dangerous — and without it,
trying a second profile means rewiring everything, so nobody would.

The id register gains its real meaning at the same time: the contract is per
**model**, so whoever maps a device second respects the control ids the first one
published. Two profiles for one keyboard become interchangeable instead of
incompatible.

**What this obliges elsewhere** — `author` is declared in `ROOT_KEYS` and
**validated nowhere**; the shipped profile carries `""`. It is the third field of
that kind found in two days, after `range` (now read) and `mode` (still not).

**Revised 2026-09-05 — a free nickname, not a handle from somewhere else.** This
entry first proposed the GitHub handle, on the grounds that a pull request proved
it. The author refused it on sight: *"tu demandes le nom git de l'utilisateur en
pensant que tout le monde a un compte git"*. He is right, and the refusal is
larger than the field — requiring an account anywhere to name yourself excludes
people for the convenience of an index. `author` is therefore whatever the person
types. Two mappers can collide on a nickname; that is a smaller price than a
barrier at the door, and the catalogue can show the setup count beside a name to
tell them apart. See D-026.

**What would justify revisiting it** — A device whose variants genuinely need
different control ids, firmware revisions that move the messages far enough that
one id set cannot cover both. Then the hardware is arguably two devices, and gets
two `profileId`s.

**Proof in the code** — `src/renderer/js/midi/controllerProfile.js` (`ROOT_KEYS`
holds `author`; no `stringField` validates it), `test/conformance/published-control-ids.json`
(the register, keyed by `profileId`), and `src/renderer/js/core/controlBindings.js:25`
(`<profileId>:<controlId>`, the key this entry protects).

---

## D-026 — A setup is published on arrival, and reported by hand if it offends

**Status**: in force · 2026-09-05 · **not implemented** — specification only.

**Context** — D-024 made the site a catalogue but left the way in undecided, and
three answers were put to the author on 2026-09-05. Pull requests: refused, they
require a GitHub account. Email to `contact@minihub.site`: refused, *"il faut que
ce soit automatique"*. A review queue before publication: refused, *"je souhaite
que les setups soient directement publiés, oublie moi"*.

**Decision** — six points, and the first one governs the rest.

1. **A setup is published the moment it arrives.** No queue, no approval, nothing
   waiting on one person's attention. §7.2 already refused blessing profiles
   because a single maintainer answering personally for hardware he does not own
   is where the project dies of maintenance; a review queue is that refusal
   arriving through the back door.
2. **Transport is a small Cloudflare Worker**, on the account that already holds
   the DNS and the mail routing. The page posts the file, the Worker commits it.
   The site stays static — the Worker is a letterbox on its own origin, not a web
   server — and the credential lives there, never in the page. Free tier is
   100,000 requests a day, which is several orders of magnitude past what this
   project will see.
3. **Reporting replaces filtering.** A button on the card sends a short message
   to the author's mailbox through the same Worker. A word list was considered
   and refused for three reasons: the surface is tiny (control ids are
   constrained to `[a-z0-9-]`, so only the nickname, maker and model are free
   text); a list covering every language cannot be maintained and is defeated by
   `n4zi`; and above all **the harmful setup is not the rude one, it is the wrong
   one** — bad CC numbers, positions at random — which no filter can see and only
   a user can report.
4. **Free strings get shorter.** The validator allows 200 characters, enough to
   write a sentence in a nickname. Around 40 is enough for a name and removes the
   surface without a list to maintain — the one part of the filter idea worth
   keeping.
5. **No account anywhere.** A nickname is typed, not proven. This revises D-025,
   and it also moves the stars: counting them on GitHub discussions required the
   very account this refuses, so votes go through the same Worker.
6. **`setup` is the word the user reads; `profile` stays the word of the format
   and the code.** "Profile" collides with "user profile" in a reader's head, and
   the file is a description of a desk, not of a person. Renaming it in the
   format would touch 417 occurrences across 32 files, 306 more in the documents,
   and `profileId` is a persisted field — so the rename would invalidate every
   setup written so far and force `formatVersion` 2, for a word only the code
   reads. The project already runs four names for one product on purpose
   (AGENTS.md §2); this is the fifth, at the layer where it matters.

7. **One vote per address and per setup**, stored as a fingerprint and never as
   an address.
   Asked on 2026-09-05: can a repeated vote from one IP be refused? Yes — the
   Worker sees `CF-Connecting-IP` — and it is worth doing, but what it buys has
   to be stated plainly. It stops the bored click, not a determined person: an
   address changes with a phone, a VPN or a router reboot. It also costs
   something in the other direction, because a household or an office shares one
   address and a second, legitimate vote from it is refused. And an IP is
   personal data, so what is kept is `hash(address + setupId + secret)` — the
   setup id is part of the key, so one address votes on as many setups as it
   likes and once on each. Enough to recognise a repeat, useless for anything
   else, and nothing to erase later.
   Approximate deduplication is the right target here: a star is an opinion, not
   a ballot.

**Consequence** — nothing stands between writing a setup and other people having
it, which is what makes the catalogue worth the calibration. What protects the
reader is not a gate at the entrance but the things that already exist: the
validator refuses dangerous strings on every field, the completeness figure says
how much of the device was actually observed, and the stars and reports say what
the machine cannot judge.

**What would justify revisiting it** — Reports arriving faster than one person
can read them. That is the point where a queue starts costing less than the
mailbox, and the number is small: a handful a week.

**Proof in the code** — `src/renderer/js/midi/controllerProfile.js`
(`DANGEROUS_STRINGS`, tested against every string in the file, and
`LIMITS.stringLength` at 200, the value point 4 lowers), and
`test/conformance/published-control-ids.json` (control ids constrained to
`[a-z0-9-]`, which is why the free-text surface is three fields wide).

---

## D-027 — A profile is chosen at launch, and changing it reloads the window

**Status**: in force · 2026-09-05 · **implemented**

**Context** — D-024 puts a catalogue of profiles on the site and D-026 says how
one arrives there. Neither is worth anything while MiniHub cannot read a profile
it did not ship with: `loadedProfile.js` imported `profiles/minilab-3.json` at
build time and `preload.js` exposed no file access at all, so the catalogue would
have served files nothing could consume.

Making the profile a runtime choice ran straight into something already load
bearing. `MINILAB_NODE_ID` (`core/systemNodes.js`) is a **module-level constant**
derived from `profileId`, and it is evaluated when the ES module graph loads —
which is *before* `main()` in `app.js` reaches `await hub.settings.load()`. A
profile fetched through an asynchronous IPC call arrives after every consumer has
already frozen its value, and MiniHub would then decode with one profile while
naming its routing node after another.

**Decision** — the profile is resolved **once, at launch**, before the first
module evaluates, and changing it reloads the window.

- `preload.js` fetches it with `ipcRenderer.sendSync('profile:current')` and
  exposes it as `hubProfile`. That is the only synchronous channel in the file
  and the only thing that can run early enough: preload executes before page
  scripts and has Node.
- `loadedProfile.js` resolves rather than imports. It validates what arrived, and
  falls back to the profile that ships when there is nothing, when the file is
  gone or is not JSON, or when it does not validate — recording which, in
  `PROFILE_ORIGIN`.
- Imported profiles live in `userData/profiles/`, and `selectedProfileFile` holds
  a **file name**, never a path.
- Settings shows which controller is running, where its profile came from, and
  says the window reloads before the user clicks.

**Why not a live swap** — it would turn `MINILAB_NODE_ID` and its thirty-odd
consumers into function calls, for a change a user makes once. The reload costs
nothing that is not already paid: opening a project reloads the renderer already,
and `core/chainSync.js` rebuilds the engine's chains afterwards.

**Why the fallback is loud** — MiniHub never launches without a controller, so a
chosen profile that cannot be honoured falls back to the shipped one. In silence
that is the worst possible outcome: a user whose keyboard has quietly become a
MiniLab 3, with every cable pointing at a node named after a device he does not
own. `PROFILE_ORIGIN` carries the reason and Settings prints it.

**Why validation moved into the renderer** — `src/main/` is CommonJS and cannot
import `midi/controllerProfile.js`, which the `module boundary` rule keeps an ES
module. Main reads bytes, the renderer judges them. The better consequence is
that a file is refused **before** it reaches the profiles folder, so a bad import
leaves nothing behind to find and delete; and every fault is shown, because the
validator accumulates them so a hand-written profile is fixed in one pass.

**What this does not do** — the plural. One profile is loaded at a time, D-022
stands: no multi-input `MidiManager`, no N controller nodes, `selectedInputId`
stays singular.

**Consequence** — the `one profile ships` check rule was re-expressed: that static
import is no longer *the decision*, it is the fallback. A third clause was added
and it is the load-bearing one — the loader must call
`validateControllerProfile()`. Nothing else stands between a hand-edited JSON and
the routing node's id, and its absence would fail no test, because every test runs
on the profile that ships.

**Proof in the code** — `src/renderer/js/midi/loadedProfile.js` (`resolveProfile`,
`PROFILE_ORIGIN`), `src/main/controllerProfiles.js`, `src/main/preload.js`
(`sendSync`), `src/main/main.js` (`profile:*`),
`src/renderer/js/core/profileImport.js`,
`src/renderer/js/ui/controllerProfileSection.js`, `test/loadedProfile.test.mjs`,
`test/controllerProfiles.test.cjs`, `test/profileIpc.test.cjs`,
`test/profileImport.test.mjs`, `scripts/check-invariants.mjs`
(`one profile ships`)

---

## D-028 — What is printed on the hardware is part of the format

**Status**: in force · 2026-09-05 · **implemented**

**Context** — `ui/miniLabControlSurface.js` drew the MiniLab by name. Five
controls were fetched by id — `shift`, `pitch-bend`, `modulation`,
`main-encoder`, `main-click` — and ten words were literals in the HTML: `HOLD`,
`OCT −`, `OCT +`, the imitation display, and the eight pad legends `Arp`, `Pad`,
`Prog`, `Loop`, `Stop`, `Play`, `Record`, `Tap`. The file admitted as much of the
pad legends: *"hardware text with no field in the profile format yet"*.

That was not a tidiness problem. A profile declaring none of those five ids
returned `undefined`, and the next line read `control.id` off it, so drawing
another keyboard threw a `TypeError` — measured against
`test/conformance/vega-49.json`, not deduced — and took down both surfaces that
draw it: the MiniLab page and the VST Learn panel.

Three answers were put to the author: drop the words, declare only the two that
are really buttons, or keep a decoration block for the shipped profile alone. He
refused all three and gave the reason that reframes them: **a user recognises a
control by what is written on his hardware**. That is not decoration, it is the
label on the object under his fingers.

**Decision** — two optional fields on a control, and they belong to every profile.

- **`printed`** — the text the panel carries next to this control. Free text,
  bounded and swept for dangerous shapes like every other string in the file.
- **`silent: true`** — a real control that sends nothing. `bindings: []` alone was
  already legal but ambiguous: it also reads as "not measured yet". It is the
  field behind the Builder's `+ silent` button.

A silent control is **drawn and never routed**: it produces no CONTROL source, so
no Patch Bay port and no binding key. That is what keeps
`test/conformance/control-sources.json` byte-identical at 25 sources — declaring
the panel moved no saved project.

`computeCompleteness()` gains a fifth counter, `silent`, so those controls stop
counting as `untested`, which they are not: a finished profile reporting four
missing measurements is the opposite of what that summary exists to say. The
counter is **optional** in a declared `completeness` — absent means none — so every
profile written before this change, the Builder's output included, stays valid.

**Rendering rule, from the author** — `printed` is **always drawn**, subdued if it
must be, never dropped. A label the user cannot see is worth nothing.

**Consequence** — the MiniLab declares 29 controls where it declared 25: `hold`,
`oct-down`, `oct-up` and `display` are silent, and the eight pads carry their
legends. The renderers draw from `family`, `layout` and `printed`, and fetch
nothing by id; a family the drawing has no box for lands in `ml-extra` rather than
vanishing. The Builder will need to ask for both fields when Étape C comes.

**Proof in the code** — `src/renderer/js/midi/controllerProfile.js`
(`CONTROL_KEYS`, `booleanField`, `computeCompleteness`),
`src/renderer/js/midi/profiles/minilab-3.json`,
`src/renderer/js/midi/minilabControls.js` (`isRoutable`,
`MINILAB_SURFACE_CONTROLS`), `src/renderer/js/ui/miniLabControlSurface.js`,
`test/miniLabSurface.test.mjs`, `test/minilabProfile.test.mjs`,
`test/conformance/published-control-ids.json`

---

## D-029 — A cable whose node is absent is kept, not dropped

**Status**: in force · 2026-09-05 · **implemented**

**Context** — `network.js` `restore()` skipped a connection whose endpoints it
could not find, with a `console.warn` and nothing else; `_persist()` then wrote
the file without it. One launch to lose a cable, one save to make it permanent.

The controller node's id **is** the loaded profile's id, so this became a
data-loss path the moment a profile could be chosen: open a project with another
keyboard loaded and every cable from the controller points at a node that does
not exist. It is specification §6.1 one level up — the same silent destruction
`normalizeControlBinding` was fixed for, where bindings validate shape and resolve
belonging at use.

**Decision** — **absent is remembered, wrong is dropped**, and nothing remembered
ever routes.

- ABSENT means the node or the port cannot be found. The cable may be perfectly
  correct and simply describe a device that is not loaded right now, so it is
  kept, written back out, and connected the day its node arrives.
- WRONG means every endpoint exists and the cable still cannot be made —
  incompatible types, a duplicate, a feedback cycle. Keeping those would preserve
  garbage for ever.

**Consequence, and it is the part that was nearly missed** — `serialize()` fed both
the settings file *and* the `network:change` event, which `engineSync`,
`controlBindings`, the sequencer and the Patch Bay read as the live routing.
Widening it would have handed phantom cables to the native engine. The two lists
are therefore separated by name: **`serialize()` is what gets written,
`connections()` is what is routing**, and the event carries the second.

**Proof in the code** — `src/renderer/js/core/network.js` (`_unresolved`,
`_absentEndpoint`, `_resolveWaiting`, `serialize`, `_emit`),
`src/renderer/js/core/nodeInstances.js:382`, `test/network.test.mjs`

---

## D-030 — `layout` is optional, and placement is all or nothing

**Status**: in force · 2026-09-05 · **implemented**. D-023 decided the first half
in specification only; this is what the code does about it.

**Context** — D-023 made `layout` optional because the Builder's steps capture
what a device *sends* and never where its controls *sit*: without a photograph of
the user's own keyboard there are no coordinates. The validator had not been told.
`layout` was still required, so a profile written without a photograph would have
been **refused at import** — a door turning away exactly the visitors D-023 was
written to admit.

**Decision** — `device.layout` and `control.layout` are optional, and a profile
either places every control or places none.

A half-placed profile is the dangerous one, and the failure is silent and total
for the controls it forgets: `nodeGeometry.js` draws a surface node's ports from
`surface.ports`, so a control with no coordinate gets **no socket at all**. It
decodes, it appears in Learn, and nothing can be cabled to it. Refusing the file
is the only place that can be seen.

**Consequence** — with no coordinates there is no panel: `MINILAB_SURFACE` is
`null`, the routing node carries no surface and its ports stack in the dock like
any other node's, and the two HTML surfaces render a list grouped by family. The
list answers the **same contract** as the panel — same `data-source-control-id`,
same state classes, same silent rule, same `printed` — which is what lets the
MiniLab page and the VST Learn panel keep working without learning a second mode.

A bug of the same family was fixed on the way: `MINILAB_SURFACE_BOX` was
`{ ...profile.device.layout }`, and spreading an absent box gives `{}` — an object,
therefore truthy, therefore a panel of width `undefined`.

**Proof in the code** — `src/renderer/js/midi/controllerProfile.js`
(`reportPlacement`), `src/renderer/js/midi/minilabControls.js`
(`MINILAB_SURFACE_BOX`), `src/renderer/js/ui/miniLabControlSurface.js`
(`MINILAB_SURFACE`, `controlListHtml`), `test/miniLabSurface.test.mjs`
