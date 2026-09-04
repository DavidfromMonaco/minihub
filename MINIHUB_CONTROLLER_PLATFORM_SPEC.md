# MiniHub — Spécification de la plateforme de contrôleurs

**Document** : `MINIHUB_CONTROLLER_PLATFORM_SPEC.md`
**Statut** : v2 — brouillon révisé, **non engagé**
**Portée** : format de profil de contrôleur · intégration MiniHub · site
compagnon et Controller Builder

---

## 0. Révisions

### v2 — 2026-09-03

Réécriture après épreuve du concept contre le code réel. Onze corrections, dont
sept viennent d'un défaut vérifié dans le dépôt, pas d'une préférence.

| # | Ce que la v1 disait | Ce qui a été trouvé | § |
|---|---|---|---|
| 1 | `controls[]` porte **un** `message` | Le contrôleur de référence émet **deux à quatre** messages par contrôle selon la couche Shift/DAW. Le format v1 ne peut pas décrire le MiniLab 3. | §4.3 |
| 2 | Le profil décrit le matériel | Rien ne distingue ce qui a été **observé** de ce qui a été **deviné**. C'est là que naît la boucle de correctifs. | §3.4 |
| 3 | Un contrôleur = un port MIDI | Le MiniLab expose **quatre** entrées dont une seule porte le jeu. Se tromper échoue en silence. | §4.2 |
| 4 | `deviceNames[]` identifie l'appareil | Le dépôt a déjà tranché : l'identité est une **empreinte** `name + manufacturer + type`, parce que les ids Web MIDI changent au redémarrage. Deux tests le garantissent. | §4.2 |
| 5 | Position UI « optionnelle », dessin en Phase 3 | La géométrie du Patch Bay est **paramétrique par famille** mais arithmétiquement figée. Sans coordonnées dès la v1 : UI dégradée **puis** migration de format. | §4.4 |
| 6 | §18 « tenter une migration » | Les ids de contrôle deviennent des **ids de port persistés dans les projets**. Migrer un profil sans migrer les projets casse les câbles en silence. | §3.2 |
| 7 | §9.12 alias projet `CONTROL_A` | Ajoute une **quatrième** couche de nommage à trois existantes. Retiré. | §7.1 |
| 8 | §7 trois niveaux LOCAL / COMMUNITY / OFFICIAL | Coût de modération pour un mainteneur unique, sans besoin démontré. Ramené à un dossier et des PR. | §7.2 |
| 9 | §12 système de mise à jour | Contredit `INTENT.md` §7 et ne sert aucun des deux usages du §3 d'`INTENT.md`. Reporté derrière la décision de distribution. | §7.3 |
| 10 | §14 propriétés abandon-safe | Douze propriétés énoncées, zéro test. `INTENT.md` §9 : « un invariant énoncé doit devenir un test — sinon ce n'est qu'un vœu. » | §9 |
| 11 | Aucune mention du chantier Matrix | D-018 (**décidée, non implémentée**) refactore le **même fichier**. L'ordre des deux chantiers change le coût du second. | §6.8 |

Une découverte va dans l'autre sens, et elle est bonne : bien nommé, le profil
de référence rend la migration des projets existants **vide**. Voir §3.3.

---

## 1. Le pari, et ce qui le fait échouer

### 1.1 Le pari

Un contrôleur MIDI est **de la donnée, pas du code**. Si l'on sait décrire un
contrôleur dans un document déclaratif versionné, alors en supporter un
deuxième ne demande plus de programmer : ça demande d'écrire un fichier.

Ce pari est juste. La preuve est déjà dans le dépôt :
[`MINILAB_CONTROL_SOURCES`](src/renderer/js/midi/minilabControls.js) **est** un
profil — il se trouve simplement écrit en littéral JavaScript au lieu de JSON.
Le convertir n'invente rien ; ça déplace une donnée qui existe déjà.

### 1.2 Ce qui le fait échouer

Le pari repose entièrement sur une hypothèse que la v1 n'énonce jamais :

> **Un assistant de calibration produit un profil correct.**

Cette hypothèse est fausse pour les appareils intéressants, et le contrôleur de
référence le démontre à lui seul. Sept mécanismes la mettent en défaut :

| Mécanisme | Ce que l'assistant voit | Ce qui est vrai |
|---|---|---|
| **Couches Shift / DAW** | K1 envoie CC 74 | K1 envoie CC 74 **ou** CC 86 selon la couche (`ccs: [74, 86]`) |
| **Ports multiples** | quatre appareils « MiniLab » | un seul porte le jeu ; les autres sont MCU/HUI et DIN THRU |
| **Encodeurs relatifs** | des valeurs qui bougent | absolu, 2's-complement, signed-bit ou offset-64 — indiscernables d'un seul geste |
| **Toggle / momentané** | une pression | il faut presser, relâcher, **re-presser** pour trancher |
| **Contrôles multi-messages** | une note | les pads envoient note **et** CC de pression (`notes: [36+i, 44+i]`, `ccs: [102+i]`) |
| **Paires CC 14 bits** | deux contrôles | un seul contrôle, MSB en CC *n* et LSB en CC *n*+32 |
| **Sémantique variable par couche** | un potentiomètre | l'encodeur principal porte **quatre** CC (`[114, 112, 28, 29]`), absolu dans une couche, relatif dans l'autre |

Ce n'est pas un cas limite. Mesuré sur le contrôleur de référence :
**15 de ses 25 contrôles émettent plus d'un message**, et l'encodeur principal
en émet quatre. Soit **60 % de l'appareil que le format de la v1 ne sait pas
décrire.**

**Conséquence, et c'est le cœur de cette révision.** L'assistant produira des
profils justes pour les appareils simples et **subtilement faux** pour les
autres. Un profil subtilement faux ne lève aucune erreur : le potentiomètre 3
ne fait simplement rien, et personne ne sait pourquoi.

### 1.3 La réponse — et pourquoi ce n'est pas « un assistant plus malin »

On ne rattrape pas ça par de l'inférence supplémentaire. Chaque règle ajoutée
au devineur crée une nouvelle façon de se tromper avec assurance. C'est
exactement la boucle de correctifs infinis qu'il s'agit d'éviter.

La réponse tient en trois règles, et elles gouvernent tout le reste du
document :

1. **Le profil enregistre ce qui a été observé et marque ce qui a été déduit.**
   Un champ `confidence` par binding. Ce qui n'a pas été vu est dit non vu.
2. **La réparation se fait dans MiniHub, devant le matériel réel** — pas en
   retournant sur le site refaire l'assistant. Le seul endroit où l'appareil et
   le logiciel sont ensemble, c'est le bureau de l'utilisateur.
3. **L'incomplet est un état normal**, affiché, pas une erreur. Un profil à
   60 % qui le dit vaut mieux qu'un profil à 95 % qui prétend 100 %.

Si ces trois règles ne sont pas tenues, le reste du document ne vaut rien : le
projet passera son temps à corriger des profils à distance, pour du matériel
que personne dans la boucle ne possède.

---

## 2. La décision produit — une porte, pas une étape

Ce document **ne peut pas** être implémenté tel quel sans amender
[INTENT.md](INTENT.md). Ce n'est pas une formalité : quatre sections datées du
2026-09-03 s'y opposent explicitement.

| Ce document | INTENT.md |
|---|---|
| §6 couche d'abstraction contrôleur | §5 — « écrire une couche d'abstraction pour des contrôleurs qui n'existent pas dans ce projet est **du travail spéculatif** » |
| §5 site public, §7.2 profils partagés | §6 — « **Pas une plateforme extensible.** Pas un produit multi-utilisateur » |
| distribution, releases publiques | §2 — « ajouter aujourd'hui de la mécanique d'installation, de mise à jour ou d'onboarding serait **travailler pour un utilisateur qui n'existe pas** » |
| vérification de version *(retirée en v2, §7.3)* | §7 — « **aucune vérification de mise à jour automatique**, tant que la question de la distribution n'est pas tranchée » |

**Point important** : l'Étape A du §8 **ne franchit pas cette porte**. Elle
retire du matériel codé en dur du cœur — ce qu'`INTENT.md` §5 réclame déjà et
que D-008 a explicitement laissé ouvert. Elle est de la consolidation, pas de
l'expansion, et elle peut commencer sans amender quoi que ce soit.

Les Étapes B, C et D, elles, exigent l'amendement, écrit et daté, avec ses
entrées dans [DECISIONS.md](DECISIONS.md).

---

## 3. Principes non négociables

Ceux de la v1 qui survivent, et cinq qui viennent de l'épreuve.

### 3.1 Conservés de la v1

- Aucune IA en production, aucune clé API.
- Un profil est **de la donnée déclarative**. Jamais de JavaScript, de script,
  de commande, de chemin système, de DLL, d'URL exécutable, de callback.
- MiniHub fonctionne **sans réseau** et sans le site.
- Le site n'est **jamais** une dépendance d'exécution.
- L'arrêt du site ne rend aucune installation inutilisable.
- Toute évolution du format est versionnée.

### 3.2 Un identifiant publié est immuable

**C'est la règle qui évite la migration en cascade**, donc la boucle de
correctifs.

Un `controlId` publié ne peut plus jamais être renommé ni renuméroté. Raison
mécanique, vérifiée dans le code : l'id de contrôle **devient un id de port du
graphe**, et les ports sont persistés dans `graphConnections` de chaque projet
(`{ from: {nodeId, portId}, to: {nodeId, portId} }`,
[graph.js:25](src/renderer/js/core/graph.js:25)). Renommer un contrôle casse
les câbles de tous les projets qui l'utilisaient — en silence, parce que le
graphe cesse simplement de correspondre. C'est le mode de panne que
[systemNodes.js](src/renderer/js/core/systemNodes.js) documente déjà.

Corollaire : **une révision de profil peut ajouter, jamais remplacer.** Un
contrôle mal décrit reçoit un binding corrigé ; il ne change pas d'id. Le
migrateur n'a donc jamais à toucher un projet — il n'existe que pour ajouter
des champs à un profil.

### 3.3 La migration des projets existants doit être vide

Application immédiate de §3.2, et c'est un gain gratuit :

- le profil de référence garde **`minilab-3`** comme `profileId` ;
- ses contrôles gardent leurs clés courtes : `k1`, `f2`, `p3`, `pitch-bend` ;
- l'id de port reste dérivé par `control-<controlId>` → **`control-k1`**,
  identique à aujourd'hui ;
- la clé de binding reste `<profileId>:<controlId>` → **`minilab-3:k1`**,
  identique à aujourd'hui ;
- l'id du nœud de graphe est le `profileId` → **`minilab-3`**, identique à
  `MINILAB_NODE_ID`.

**Aucun projet existant ne bouge.** Ce n'est pas de la chance : c'est la raison
pour laquelle le profil de référence doit être nommé ainsi et pas
`arturia.minilab3`.

### 3.4 Le profil dit ce qu'il ne sait pas

Chaque binding porte un `confidence` parmi `observed`, `documented`,
`inferred`. Chaque contrôle déclaré mais jamais vu bouger est `untested`.
L'interface de MiniHub distingue visuellement les trois. Un profil n'a pas le
droit de présenter une déduction comme une observation.

### 3.5 Un seul décodeur, partagé, avec un corpus

Le site et MiniHub doivent s'accorder sur trois choses : le schéma, le décodage
message → contrôle, et l'inférence de sémantique. Trois occasions de diverger,
et **toute divergence est un correctif**.

Donc : schéma et décodeur sont **un seul artefact**, copié à l'identique des
deux côtés, accompagné d'un **corpus de conformité** — des flux MIDI
enregistrés et leur décodage attendu — que les deux exécutent. Le corpus est la
seule preuve que les deux côtés sont d'accord.

Point d'appui existant : [parseMidi.js](src/renderer/js/midi/parseMidi.js) fait
78 lignes, sans dépendance, en module ES. Il se partage tel quel.

### 3.6 Un invariant énoncé devient un test

`INTENT.md` §9. Les propriétés abandon-safe et les critères d'acceptation de la
v1 sont réécrits au §9 de ce document sous forme de commandes. Ce qui ne peut
pas être vérifié par une commande est retiré du document.

---

## 4. Le format de profil

### 4.1 L'épreuve du format

Un format de description de contrôleurs qui ne sait pas décrire **le contrôleur
de référence** est faux. C'est l'unique critère d'acceptation du format, et il
est vérifiable aujourd'hui : le profil `minilab-3` doit produire, après
chargement, exactement les 25 sources de contrôle que `MINILAB_CONTROL_SOURCES`
déclare — mêmes ids, mêmes CC, mêmes notes, mêmes sémantiques.

Le format de la v1 échoue à cette épreuve. Celui-ci est construit pour la
passer.

### 4.2 Identité de l'appareil : empreinte et rôles de port

Deux corrections, toutes deux imposées par des tests existants.

**L'identité est une empreinte, pas un id.** `hardwarePersistence.test.mjs`
garantit déjà que la préférence MIDI se restaure « par empreinte quand l'id
Web MIDI change », et qu'« un id Web MIDI réutilisé ne peut pas usurper
l'identité d'un autre appareil préféré ». Le rapprochement profil ↔ appareil
**hérite de ces deux propriétés** : il se fait sur `name + manufacturer + type`
normalisés, jamais sur l'id Web MIDI.

**Un appareil a des ports, avec des rôles.** Le classement de
[minilab.js](src/renderer/js/midi/minilab.js) — aujourd'hui du code — devient
de la donnée :

```json
"device": {
  "vendor": "Arturia",
  "model": "MiniLab 3",
  "ports": [
    { "role": "performance",     "priority": 5, "match": { "name": "Minilab3 MIDI" } },
    { "role": "performance",     "priority": 3, "match": { "name": "Minilab3 ALV" },
      "note": "port Analog Lab dedie" },
    { "role": "control-surface", "priority": 1, "match": { "name": "Minilab3 MCU/HUI" },
      "note": "ne porte jamais les notes jouees" },
    { "role": "ignore",          "priority": 0, "match": { "name": "Minilab3 DIN THRU" } }
  ]
}
```

`role` répond à la question que la v1 ne pose pas : *ce port peut-il porter ce
que l'on joue ?* Un port `control-surface` ou `ignore` n'est jamais
auto-sélectionné, quel que soit son nom.

### 4.3 Contrôles : `bindings[]`, pas `message`

**La correction centrale du format.** Un contrôle n'émet pas un message ; il
émet un ensemble de messages, dépendant de la couche active.

```json
"layers": [
  { "id": "default", "label": "Analog Lab" },
  { "id": "daw",     "label": "DAW / Shift" }
],

"controls": [
  {
    "id": "k1", "label": "K1", "family": "knob",
    "layout": { "x": 155, "y": 43 },
    "bindings": [
      { "layer": "default", "when": { "kind": "cc", "channel": 1, "number": 74 },
        "mode": "absolute", "range": [0, 127], "confidence": "observed" },
      { "layer": "daw", "when": { "kind": "cc", "channel": 1, "number": 86 },
        "mode": "absolute", "range": [0, 127], "confidence": "documented" }
    ]
  },
  {
    "id": "p1", "label": "P1", "family": "pad",
    "layout": { "x": 90, "y": 126 },
    "bindings": [
      { "layer": "default", "when": { "kind": "note", "channel": 10, "number": 36 },
        "mode": "velocity", "confidence": "observed" },
      { "layer": "daw", "when": { "kind": "note", "channel": 10, "number": 44 },
        "mode": "velocity", "confidence": "documented" },
      { "layer": "*", "when": { "kind": "cc", "channel": 10, "number": 102 },
        "mode": "pressure", "confidence": "documented" }
    ]
  },
  {
    "id": "main-encoder", "label": "Main", "family": "encoder",
    "layout": { "x": 122, "y": 68 },
    "bindings": [
      { "layer": "default", "when": { "kind": "cc", "channel": 1, "number": 114 },
        "mode": "absolute", "confidence": "observed" },
      { "layer": "daw", "when": { "kind": "cc", "channel": 1, "number": 28 },
        "mode": "relative", "encoding": "twos-complement", "confidence": "inferred" }
    ]
  }
]
```

Quatre choses que le format de la v1 ne pouvait pas dire, et que celui-ci dit :

- **un contrôle, plusieurs messages** — les `bindings` du pad P1 ;
- **une sémantique qui change selon la couche** — `main-encoder` est absolu en
  `default`, relatif en `daw` ;
- **un message présent dans toutes les couches** — `"layer": "*"` ;
- **la fiabilité de chaque ligne** — `confidence`.

**`mode` reconnus** : `absolute`, `relative`, `velocity`, `pressure`,
`bipolar`, `momentary`, `toggle`, `trigger`.

**`encoding`**, requis si `mode: "relative"` : `twos-complement`, `signed-bit`,
`offset-64`. Aucune valeur par défaut : un relatif dont l'encodage n'a pas été
observé est `inferred` et affiché comme tel.

**`kind`** : `cc`, `note`, `pitchbend`, `channelpressure`, `polyaftertouch`,
`programchange`. Une paire 14 bits est **un** binding
`{ "kind": "cc14", "number": 74, "lsbNumber": 106 }`, jamais deux contrôles.

### 4.4 `layout` est requis dès la v1, pas en Phase 3

La v1 range la représentation graphique en Phase 3 et rend `layout` optionnel.
Vérification faite, c'est un piège à deux détentes.

[miniLabControlSurface.js](src/renderer/js/ui/miniLabControlSurface.js) ne
contient pas une image : il contient une **disposition paramétrique par
famille**, avec des positions calculées en dur — `x: 155 + (index % 4) * 52`
suppose quatre potentiomètres par rangée, les huit pads supposent une rangée
unique, et les faders portent un décalage vertical codé sur les clés `f2` et
`f4`. Les classes CSS (`.ml-surface-knob`, `.ml-surface-fader`,
`.ml-surface-pad`), elles, sont déjà génériques par famille.

Sans `layout` dans le profil, la v1 livre donc :

1. un nœud Patch Bay dégradé pour tout contrôleur non-MiniLab — 25 ports
   empilés à 30 px font **≈ 760 px de haut**
   ([nodeGeometry.js](src/renderer/js/core/nodeGeometry.js), `PORT_ROW = 30`) ;
2. **puis** une migration de format quand la Phase 3 arrive.

Avec `layout` dès la v1, le rendu existant devient générique sans rien perdre,
et le MiniLab reste dessiné exactement comme aujourd'hui — ses coordonnées
sortent du code pour entrer dans son profil. `family` gouverne la forme,
`layout` la position, la façade reste `base.css`.

### 4.5 Métadonnées

```json
{
  "formatVersion": 1,
  "profileId": "minilab-3",
  "revision": 1,
  "name": "Arturia MiniLab 3",
  "author": "",
  "createdAt": "2026-09-03",
  "completeness": { "declared": 25, "observed": 25, "inferred": 0, "untested": 0 }
}
```

`formatVersion` versionne le **format** ; `revision` versionne **ce profil**.
`completeness` est calculé, jamais saisi : c'est le résumé que MiniHub affiche,
et qui donne à l'utilisateur une raison de ne pas faire confiance à un profil
importé les yeux fermés.

---

## 5. Le Controller Builder

### 5.1 Ce qu'il promet, et ce qu'il ne promet pas

**Il promet** : reconnaître l'appareil, capturer ce que l'utilisateur bouge
réellement, produire un profil valide et honnête sur ses lacunes.

**Il ne promet pas** un profil complet. Un profil partiel est un résultat
normal, exporté, marqué, et complété plus tard dans MiniHub devant le matériel.

### 5.2 Compatibilité

Web MIDI, donc Chromium (Chrome, Edge) : Firefox ne l'expose pas sans
extension, Safari pas du tout — **à revérifier au moment de faire**. HTTPS
obligatoire, permission demandée explicitement. Le navigateur incompatible est
annoncé d'emblée, pas découvert à l'étape 3.

`sysex: false`, comme l'application. L'identité disponible se limite donc à
`name`, `manufacturer`, `id` — soit exactement l'empreinte du §4.2. La v1
laissait entendre qu'on obtiendrait mieux ; ce n'est pas le cas sans une
seconde permission SysEx, hors périmètre.

### 5.3 Le parcours, corrigé

**Étape 0 — désambiguïser les ports.** *Nouvelle, et elle passe en premier.*
L'appareil expose souvent plusieurs entrées. L'assistant les liste toutes,
demande de jouer une note, et **observe lequel réagit**. C'est le seul moyen
fiable, et ça élimine le mode d'échec le plus décourageant : « je bouge tout,
il ne se passe rien ».

**Étape 1 — décrire.** Ce que l'appareil possède, par famille et par nombre.
Sert à savoir ce qui reste à couvrir.

**Étape 2 — calibrer, contrôle par contrôle.** Trois gestes au lieu d'un :

| Famille | Geste demandé | Ce qu'on en tire |
|---|---|---|
| potentiomètre, fader | course complète, **butée à butée** | absolu vs relatif, plage réelle, paire 14 bits |
| encodeur | **au moins un tour dans chaque sens** | encodage relatif, ou absolu si les valeurs saturent |
| bouton | **presser, relâcher, presser** | momentané vs toggle |
| pad | frapper doucement, puis fort | vélocité, et CC de pression accompagnant |

Tout ce qui n'est pas issu d'un geste est `inferred` ou `documented`. Jamais
`observed`.

**Étape 3 — balayer les couches.** *Nouvelle.* « Votre appareil a-t-il un
bouton Shift, un mode DAW, des banques ? » Si oui, l'assistant fait refaire la
calibration des contrôles concernés dans la seconde couche. Si l'utilisateur
passe, les contrôles restent mono-couche et le profil le dit.

**Étape 4 — conflits.** Deux contrôles sur le même message, un message
instable, un contrôle jamais vu. Signalés, jamais bloquants.

**Étape 5 — bilan honnête.**

```text
PROFIL  Arturia MiniLab 3
Observes    17 / 25
Deduits      2      encodeur principal (relatif), pad pression
Non testes   6      couche DAW
Conflits     0
Resultat    PARTIEL - exportable, completable dans MiniHub
```

### 5.4 The site around it

*(This section is in English, per AGENTS.md §6. The rest of this document
predates that rule and still owes its conversion.)*

Presentation, features, download, documentation of the format, the Builder, the
profiles folder. Static. No account, no backend, no telemetry. No MIDI event
leaves the browser.

#### The device card

One page per device: a photograph, its history (date, country of origin), its
specifications, its connectors, its keybed, and a blueprint of its controls.

Three rules, each of which stops the card turning into something else:

1. **Two artefacts, one identity.** The profile says what the device *sends* —
   the contract MiniHub executes, and a thing a reviewer can check in five
   minutes. The card says what the device *is*. They share the `profileId` and
   nothing else. No photograph, no prose, no country of origin ever enters a
   profile: D-020 refuses moderation tiers, and editorial content inside a
   contributed data file **is** a moderation tier under another name.
2. **The blueprint is generated, never drawn in the browser.** The site's CSP is
   `script-src 'none'` and the site ships no JavaScript at all. A script in the
   site's `scripts/` reads the profile and writes the SVG, which is committed —
   the same category as `check.mjs`, not a build step: what is in the repository
   is still exactly what is served. `check.mjs` then refuses a blueprint that no
   longer matches the profile it came from, which is what turns the card into a
   **verification** of the profile rather than an illustration of it.
3. **The profile is copied into the site repository**, exactly as `parseMidi.js`
   and the decoder are (§3.5). The card reads that copy, never the application.

**Photographs** — manufacturer product shots are used as citation, credited, and
replaced on the manufacturer's request. Author's decision, 2026-09-04. Still
owed: a visible way to make that request, since the site displays no contact
address by design. The public `minihub-site` issues are the candidate that costs
no address.

**What this closes**: an interactive card — hovering a knob to read its CC —
needs `script-src 'none'` lifted. The site's whole posture is not worth that
convenience.

**Ordering**: Étape C. The cards are written by the author, once the rest is
finished. `layout` and `family` in the profile (§4.4) are what the blueprint
reads, which is one more reason they are required in v1 rather than in a phase 3.

---

## 6. Intégration MiniHub — ce qui casse, précisément

Chaque point ci-dessous a été vérifié dans le code. Ce ne sont pas des risques :
ce sont des ruptures certaines si l'on construit tel que la v1 le décrit.

### 6.1 Perte de mappings — le défaut le plus grave

Les bindings vivent dans `inst.content.controlBindings`, donc **dans le fichier
`.minihub`**. Au chargement,
[nodeInstances.js:472](src/renderer/js/core/nodeInstances.js:472) les repasse
par `normalizeControlBindings`, qui rejette tout `sourceControlId` absent de la
table MiniLab en dur
([controlBindings.js:29](src/renderer/js/core/controlBindings.js:29)).

Sous la v1 : profil absent → bindings jetés en silence → la sauvegarde suivante
les perd **définitivement**. C'est exactement ce que le §9.11 de la v1
interdit, provoqué par un chemin de code qui existe aujourd'hui.

**Correction** : `normalizeControlBinding` valide la **forme**, pas
l'appartenance. L'appartenance se résout à l'usage, contre le profil chargé. Un
binding non résolu est **conservé** et affiché `missing-target` — un état qui
existe déjà dans `bindingStatus()` (`unbound`, `disconnected`,
`missing-target`, `not-ready`, `active`), ce qui satisfait au passage
l'exigence de D-018 : une seule langue pour les deux systèmes Learn.

### 6.2 Identités persistées

`MINILAB_NODE_ID = 'minilab-3'` fait partie du contrat de routage persisté
(`graphConnections`, `graphLayout`). Le §3.3 rend ce point inoffensif **à
condition** que le profil de référence garde ce `profileId`. Un second appareil
du même modèle prend `minilab-3#2`.

### 6.3 Géométrie du Patch Bay

[nodeGeometry.js](src/renderer/js/core/nodeGeometry.js) porte une branche
spéciale : hauteur figée à 166, surface SVG mise à l'échelle, et chaque port
placé à l'emplacement physique du contrôle. Généralisée par le `layout` du
§4.4, elle cesse d'être une exception : le MiniLab devient le premier profil à
fournir ses coordonnées, pas un cas particulier du code.

### 6.4 Une seule entrée sélectionnée

`selectedInputId` est au singulier (`src/main/settings.js:21`), et
`midi:message` n'émet que pour l'entrée sélectionnée. Le pluriel demande de
refondre `MidiManager`, la forme des réglages, et l'affichage d'en-tête
(`header.js:45-53` annonce « MiniLab 3 connected » en dur).

À conserver absolument : `midi:inputMessage`, qui émet déjà depuis **toutes**
les entrées physiques pour l'enregistrement. C'est le point d'appui du pluriel.

### 6.5 Le séquenceur n'enregistre que le MiniLab

`isCanonicalMidiIngress` exige `connection.from.nodeId === MINILAB_NODE_ID`
([sequencerController.js:9](src/renderer/js/core/sequencerController.js:9)), et
cinq sites l'utilisent. **Un second contrôleur serait injouable en
enregistrement** tant que ce n'est pas généralisé à « tout nœud de contrôleur ».
Trois messages d'erreur nomment aussi « MiniLab 3 » en dur (lignes 678, 684,
686).

### 6.6 Le moteur natif

`native/audio-engine/src/midi_output.h:49` code encore `id == "minilab-3"` :
c'est la moitié ouverte de D-008, que le pluriel force à terminer. Elle est
petite, mais elle est en C++ et compte donc dans la règle des **0 erreur
0 avertissement**.

### 6.7 Le décodage doit rester additif

`controlRouting.test.mjs` garantit que « les notes musicales et le MIDI de K1
restent natifs pendant que K1 est aussi exposé en CONTROL ». Le décodeur piloté
par profil **doit** conserver cette propriété : projeter en CONTROL ne retire
jamais un message de son chemin MIDI. C'est un invariant de signal, pas un
détail.

### 6.8 Collision avec le chantier Matrix — question d'ordre

D-018 est **décidée et non implémentée**. Elle refactore `ControlBindingManager`
pour y introduire un arbitre de Learn partagé, dont le propriétaire est nommé
`minilab | matrix`.

Ce document refactore **le même fichier** : clé de binding, validation contre
profil, conservation des non-résolus.

Deux conséquences :

- **Fait dans le désordre, le refactor est payé deux fois**, et le second
  rouvre le premier.
- Si les contrôleurs passent au pluriel, le nom de propriétaire `minilab` de
  D-018 est **déjà faux avant d'être écrit**. Il doit être `controller`, ou
  `controller:<profileId>`.

**Recommandation** : l'Étape A passe **avant** la phase 2 du chantier Matrix,
ou bien D-018 s'écrit au pluriel dès maintenant. C'est une décision de
calendrier, et c'est la seule de ce document qui coûte de l'argent si on la
manque.

---

## 7. Ce qui est retiré de la v1

### 7.1 L'alias projet `CONTROL_A` (§9.12) — retiré

Le §9.12 veut qu'un projet référence `CONTROL_A`, que le profil résout ensuite.
Mais le §9.9 fait déjà porter le mapping par l'id de contrôle du profil. Deux
indirections pour un seul travail, et le document ne dit jamais laquelle le
projet stocke.

Dans le code, un projet référence déjà **deux** choses : `portId` dans les
câbles, `sourceControlId` dans les bindings. Ajouter `CONTROL_A` en fait
**quatre** : CC matériel → id de contrôle → alias projet → id de port. Chaque
couche est un endroit où un décalage silencieux devient possible, dans un
domaine où le silence est déjà le mode de panne dominant.

**À la place** : câbles et bindings s'accordent sur `<profileId>:<controlId>`.
Ouvrir un projet fait pour un autre contrôleur propose un **remapping
explicite** — une action de l'utilisateur, visible, annulable — au lieu d'une
résolution automatique qui a l'air de marcher.

### 7.2 Les trois niveaux de validation (§7) — ramenés à un

LOCAL / COMMUNITY VERIFIED / OFFICIAL implique de la modération, des seuils,
des litiges, des signalements, des variantes de firmware. Pour un mainteneur
unique, « OFFICIAL » veut dire : **tu réponds personnellement de chaque
contrôleur que tu as béni**, y compris ceux que tu ne possèdes pas. C'est là
que le projet meurt de maintenance, pas de code.

**À la place** : un profil est un fichier. Ceux que l'auteur a testés sur son
matériel vivent dans le dépôt. Les autres arrivent par pull request. Zéro
backend, zéro vote, zéro modération. Les niveaux pourront revenir le jour où
quelqu'un les réclame.

### 7.3 Le système de mise à jour (§12) — reporté

Contredit `INTENT.md` §7 mot pour mot, et ne sert ni l'un ni l'autre des deux
usages qui définissent le produit. Il revient avec la décision de distribution,
pas avant.

### 7.4 Deep links, comptes, synchronisation, télémétrie — retirés

La v1 les classait déjà « non nécessaires ». Les laisser dans le document les
fait exister comme une intention. Ils n'y sont plus.

---

## 8. Découpage et chiffrage

Unité : le **chantier**, calibré sur ceux de la [ROADMAP](ROADMAP.md) —
« éclater `nodeInstances.js` » vaut 1. La seule mesure fiable reste le nombre
de fichiers touchés et de tests à écrire ; le reste est une indication.

### Étape A — le profil interne · **0,8 chantier**

**Ne franchit pas la porte du §2.** Aucun contrôleur nouveau, aucune surface
produit nouvelle. On retire le matériel du cœur, ce qu'`INTENT.md` §5 demande.

| Travail | Fichiers |
|---|---|
| schéma + validateur + corpus de conformité | *nouveaux* |
| `MINILAB_CONTROL_SOURCES` → profil `minilab-3` chargé | `midi/minilabControls.js` |
| décodeur piloté par profil, additif (§6.7) | `midi/minilabControls.js`, `core/controlRouting.js` |
| bindings : valider la forme, conserver les non-résolus | `core/controlBindings.js`, `core/nodeInstances.js` |
| `layout` sorti du code vers le profil | `ui/miniLabControlSurface.js`, `core/nodeGeometry.js` |
| finir D-008 côté C++ | `native/.../midi_output.h` |

**Preuve de fin** : le profil `minilab-3` reproduit les 25 sources à
l'identique ; `npm test` + `npm run check` verts ; `npm run build:native` 0/0 ;
**aucun projet existant modifié**. ~30 tests neufs.

### Étape B — le pluriel · **1,5 chantier** · *porte du §2 franchie*

`MidiManager` multi-entrées, migration de la forme des réglages, ingress
séquenceur généralisé (§6.5), en-tête et barre latérale, N nœuds contrôleur,
nœud Patch Bay générique. C'est l'étape la plus large et la seule qui touche au
chemin du signal en plusieurs endroits à la fois.

### Étape C — le site et le Builder · **1 chantier** · *base de code séparée*

Pages statiques : ~0,2. Le Builder : le reste. `parseMidi.js` et le décodeur de
l'Étape A se recopient — le Builder n'est neuf que pour l'assistant du §5.3.
Sans l'Étape A, il n'y a rien à recopier et il faut tout réécrire : **C après
A, toujours.**

### Étape D — les profils partagés · **0,1 chantier**

Un dossier, un README, des pull requests.

### Ordre

```text
A  →  (porte du §2)  →  B  →  C  →  D
```

et **A avant la phase 2 de Matrix** (§6.8), sans quoi le refactor de
`ControlBindingManager` est payé deux fois.

---

## 9. Critères d'acceptation — exécutables

Les critères de la v1 étaient en prose. Ceux-ci sont des commandes.
`INTENT.md` §9 : ce qui n'est pas prouvé par une commande n'est pas prouvé.

### Règles `npm run check` à ajouter

| Règle | Ce qu'elle refuse |
|---|---|
| `profile is data` | une valeur de profil qui n'est pas un scalaire, un tableau ou un objet — donc toute fonction, toute URL exécutable, tout chemin système |
| `immutable control ids` | un `controlId` présent dans une révision publiée et absent de la suivante (§3.2) |
| `no hardware literal` | `minilab-3` écrit en dur hors de `systemNodes.js` et du profil de référence |
| `shared decoder` | an import reaching outside the shared set (`parseMidi.js`, `controllerProfile.js`, `portRoles.js`, `decodeControl.js`) — added while implementing §3.5, which named the artefact but nothing kept it copyable |
| `device name out of the shell` | a device's own words (taken from the shipped profiles) written as prose under `core/` or `ui/` — the shell names the controller from its routing node, and only the controller's module reads that name from the profile. Identifiers, CSS classes and data attributes are single tokens and pass; MiniHub's own names (AGENTS.md §2) are subtracted first |

### Tests à ajouter

| Test | Prouve |
|---|---|
| le profil `minilab-3` reproduit les 25 sources à l'identique | §4.1 — le format sait décrire le matériel de référence |
| un binding dont le profil est absent survit à un cycle charger/sauver | §6.1 — la perte de mappings est fermée |
| un profil malveillant (script, URL, chemin, prototype) est rejeté champ par champ | §3.1 |
| un id Web MIDI réutilisé ne fait pas charger le profil d'un autre appareil | §4.2 |
| K1 en CONTROL laisse le CC 74 sur son chemin MIDI natif | §6.7 |
| brancher / débrancher / rebrancher restaure les mappings sans les réécrire | hot-plug |
| un profil de `formatVersion` inconnue est refusé sans toucher aux projets | §3.2 |
| le corpus de conformité donne le même résultat des deux côtés | §3.5 |

### Ce qui reste manuel

Sans un second contrôleur physique, l'Étape B n'est vérifiable qu'en partie.
**C'est une limite réelle** : le premier appareil non-MiniLab testé révélera
des choses que ce document n'a pas prévues. Le §3.4 existe pour que ces
découvertes soient lisibles plutôt que silencieuses.

---

## 10. Questions ouvertes

1. **Y a-t-il un second contrôleur ?** S'il n'y en a aucun sur le bureau, les
   Étapes B et C construisent pour un utilisateur qui n'existe pas — ce
   qu'`INTENT.md` §2 nomme précisément. L'Étape A, elle, reste justifiée seule.
2. **Le pluriel entre-t-il dans D-018 maintenant** (§6.8), ou D-018 s'écrit-elle
   au singulier puis se reprend ?
3. **Le Builder vit-il dans ce dépôt ou dans un second ?** Un second dépôt
   protège l'interdit « aucune étape de build JS » ; un seul dépôt garde le
   décodeur et son corpus sous un même `npm test`.
