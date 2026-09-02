# AGENTS.md — MiniHub

Point d'entrée unique pour un agent ou un développeur qui arrive sur ce dépôt.
Ce fichier est la **carte** ; il ne remplace aucun des documents qu'il désigne.
Lis-le en entier, puis n'ouvre que ce dont la tâche a besoin.

---

## 0. La règle de conduite

**Quand une demande entre en conflit avec l'architecture existante, dis-le avant
de construire.** Nomme ce qui casserait et propose la reformulation : « si ce
module est fait comme ça, ceci se casse, donc voilà comment le repenser. »

Jamais construire d'abord et signaler ensuite. Jamais construire en silence en
espérant que ça passe. Un conflit signalé en amont coûte cinq minutes ; le même
conflit découvert après coup coûte le chantier.

Les trois sources contre lesquelles vérifier un conflit :
[INTENT.md](INTENT.md) (le périmètre), les invariants du §4 ci-dessous
(l'architecture), [DECISIONS.md](DECISIONS.md) (ce qui a déjà été tranché et
pourquoi).

---

## 1. Ce que c'est, en cinq lignes

Station de travail musicale de bureau (Windows), bâtie autour du contrôleur MIDI
**Arturia MiniLab 3** : Patch Bay à câbles typés, hôte VST3 natif, séquenceur
MIDI + audio cadencé à l'échantillon, nœuds Mixer / Morpher / Arpégiateur,
apprentissage des potentiomètres physiques vers les paramètres VST3.

Trois processus : Electron principal (CommonJS) — renderer Chromium (ES modules,
sans build) — moteur audio C++17 (JUCE 9, PortAudio/WASAPI, SDK VST3).

## 2. Vocabulaire — quatre noms, un seul produit

| Forme | Où elle apparaît | Ne pas « corriger » |
|---|---|---|
| **MiniHub** | nom du produit, `dist/MiniHub`, `MiniHub.exe`, extension `.minihub`, `Documents/MiniHub/Projects` | c'est le nom canonique |
| MiniLab Hub | titre de la fenêtre principale | historique, visible par l'utilisateur |
| `minilab-hub` | nom npm, `%APPDATA%/minilab-hub/`, journal de démarrage | **chemin existant sur le disque de l'utilisateur** — le renommer perd ses réglages |
| `mlh_` / `mlh-` | cibles et binaires natifs (`mlh_audio_engine`, `mlh-vst3-scanner.exe`) | préfixe de build, référencé par les scripts |

**MiniLab** seul désigne le contrôleur matériel, jamais l'application.

## 3. Où aller selon la tâche

| Tu touches à… | Lis d'abord |
|---|---|
| n'importe quoi | ce fichier + [INTENT.md](INTENT.md) |
| l'architecture, un contrat, un module | [ARCHITECTURE.md](ARCHITECTURE.md) — table des matières en tête |
| une décision qui te semble absurde | [DECISIONS.md](DECISIONS.md) **avant** de la « réparer » |
| ce qui reste à faire | [ROADMAP.md](ROADMAP.md) |
| une tâche longue, multi-sessions | [PLANS.md](PLANS.md) puis `plans/active/` |
| l'IPC, le protocole moteur | ARCHITECTURE §4 |
| le graphe, les ports, les cycles | ARCHITECTURE §6 |
| le moteur natif, le temps réel | ARCHITECTURE §7 et §8 |
| le séquenceur | ARCHITECTURE §9 |
| l'UI, la CSP, le style | ARCHITECTURE §10 — références visuelles dans `docs/design-references/` |
| la persistance, les projets | ARCHITECTURE §11 |

## 4. Règles absolues

Ces douze invariants sont détaillés et justifiés dans **ARCHITECTURE §13**. Les
enfreindre est un échec, pas un compromis.

1. **Aucun échantillon audio ne traverse l'IPC.** Uniquement du CONTRÔLE et du MIDI.
2. **Le graphe est l'autorité du routage.** La page affichée n'influence jamais le signal.
3. **Le thread audio ne bloque jamais.** Pas de verrou, pas d'allocation dans le callback.
4. **Un `id` de nœud n'est jamais réutilisé.** L'`ordinal` est de l'affichage pur.
5. **`register` et `unregister` sont symétriques**, nœud de routage compris.
6. **Une clé de projet est déclarée une seule fois**, dans `core/projectKeys.js`.
7. **Un identifiant de nœud système vient de `core/systemNodes.js`**, jamais d'un littéral.
8. **`unmount()` retire tout** — abonnements et écouteurs DOM. `#content` est partagé.
9. **Toute valeur externe est échappée** (`core/html.js`) avant d'atteindre `innerHTML`.
10. **Pas de style inline** — la CSP (`style-src 'self'`) les rejette silencieusement.
11. **`dist/` doit correspondre à `src/`** — `npm run sync:dist` après toute modification.
12. **Le catalogue VST ne rétrécit jamais tout seul.**

## 5. Interdits de conception

Le « non » a autant de valeur que le « oui ». Voir [INTENT.md](INTENT.md) pour le
périmètre produit ; ici, les interdits techniques :

- **Aucune étape de build JS.** Pas de bundler, pas de transpilation, pas de
  framework. Ce qui est dans `src/` est ce qui s'exécute.
- **Aucune dépendance runtime.** `package.json` ne contient qu'`electron` et
  `rcedit`, en `devDependencies`. Les tests utilisent `node:test`, pas un runner.
- **Aucun accès disque depuis le renderer.** `contextIsolation: true`,
  `nodeIntegration: false` ; tout passe par `window.hubAPI` (`src/main/preload.js`).
- **Aucune commande moteur hors liste blanche** (`src/main/engineCommandPolicy.js`).
- **Aucun second flux audio.** Un seul flux PortAudio/WASAPI ; les autres
  back-ends sont désactivés à la compilation.

## 6. Conventions

- **Langue** : les commentaires, docstrings et identifiants du **code** sont en
  **anglais** ; les documents `.md` sont en **français accentué**. Respecter les
  deux côtés de ce partage.
- `src/main/` est en **CommonJS**, `src/renderer/` en **ES modules**
  (`src/renderer/package.json` porte `{"type":"module"}`). C'est ce qui permet aux
  tests d'importer le renderer sans build. Ne pas mélanger.
- **Deux feuilles de style, deux rôles — pas deux rivales.** Elles ne se
  concurrencent pas, elles couvrent des couches différentes :

  | Ce que tu habilles | Feuille | Comment |
  |---|---|---|
  | coquille de l'app : entête, barre latérale, Patch Bay, câbles, modales, formulaires de réglages | `base.css` | classes `.panel`, `.btn`, `.pill`… |
  | surface d'instrument : ce qui imite une façade d'appareil — potentiomètres, interrupteurs, grilles pas-à-pas | `omni-pearl.css` | poser `class="omni-pearl"` sur la racine du module, puis construire les contrôles avec `ui/omniPearl.js` (`pearlKnob`, `pearlSelect`, `pearlSwitch`, `pearlIconButton`) |

  **C'est du confinement, pas de l'empilement.** La façade n'est pas une
  peinture posée sur `base.css` : `.omni-pearl` redéfinit son **propre** jeu
  complet de tokens (`--op-*`) et ne consomme aucune variable de `base.css`, et
  ses composants sont un autre balisage (`pearlKnob` fabrique un potentiomètre
  SVG autour d'un `<select>` natif, là où base a un `<input type="range">`). Un
  module choisit donc un vocabulaire **pour tout son sous-arbre** — jamais les
  deux mélangés. La coquille, elle, n'est jamais habillée.

  **Une coquille, au plus une façade.** Une seconde façade signifie un second
  jeu de ~35 tokens et une seconde bibliothèque de composants. Si un nouveau
  look est voulu, il **étend ou remplace** `omni-pearl`, il ne s'y ajoute pas.
  `npm run check` refuse une troisième feuille de style. Voir
  [DECISIONS.md](DECISIONS.md) D-012.

  Aujourd'hui seul l'arpégiateur porte la façade ; l'étendre se décide éditeur
  par éditeur, pas en bloc. Par défaut, un nouveau module utilise `base.css`.

  Piège : `clip-editor.html` ne charge **que** `base.css`. Toute classe `op-`
  qui y atterrirait serait sans style, sans le moindre message d'erreur —
  `npm run check` l'attrape désormais.

- Un commentaire explique **pourquoi**, jamais **quoi**. Les fichiers existants
  (`core/systemNodes.js`, `core/projectKeys.js`) donnent la densité attendue :
  ils décrivent le mode de panne que la structure empêche.
- Pas de littéral magique pour une identité partagée — voir invariants 6 et 7.

## 7. Commandes

```bash
npm install              # Electron + rcedit
npm test                 # 553 tests JS, lanceur node:test, ~5 s
npm run check            # verificateur d'invariants (Node stdlib, ~1 s)
npm run build:native     # moteur natif Release (CMake + MSBuild)
npm run build:native:tests
npm run sync:dist        # promeut src/ + moteur vers dist/MiniHub
npm start                # build natif + sync + lancement de la version packagee
```

Tests natifs, après `build:native:tests` :

```bash
native/audio-engine/build/Release/mlh_native_tests.exe --core
native/audio-engine/build/Release/mlh_native_tests.exe --vst3-e2e
native/audio-engine/build/Release/mlh_native_tests.exe --cross-track-isolation
native/audio-engine/build/Release/mlh_realtime_output_tests.exe
```

**SDK natifs à récupérer localement** (jamais versionnés, ~682 Mo) : JUCE 9,
SDK VST3, PortAudio, LAME sous `native/third_party/`. CMake échoue avec un
message explicite si l'un manque.

## 8. Vérité mécanique — la définition de « fini »

Une modification n'est terminée que lorsque **tout ce qui la concerne est vert** :

| Portée modifiée | Doit passer |
|---|---|
| n'importe quel `src/` | `npm test` + `npm run check` |
| n'importe quel `src/` | `npm run sync:dist` (sinon le test de provenance échoue) |
| `native/audio-engine/src/` | `npm run build:native` **0 erreur 0 avertissement** + les 4 binaires de test |
| un invariant d'ARCHITECTURE §13 | ajouter le test qui l'aurait attrapé |

Ce qui n'est pas prouvé par une commande n'est pas prouvé. Ne pas rapporter
« ça marche » sur la foi d'une lecture du code. Si un test échoue, le dire avec
sa sortie.

`scripts/runtime-*-gauntlet.mjs` sont des harnais ponctuels pilotant
l'application réelle par CDP ; ils sont liés à des investigations closes et ne
font **pas** partie de la définition de « fini ». Voir ROADMAP.

## 9. Pièges qui coûtent une heure

- **Le renderer n'est pas rechargé par `npm start`** tant que `sync:dist` n'a pas
  tourné : tu debugges alors l'ancien code copié dans `dist/`.
- **Un `console.log` dans le renderer part vers le processus principal** puis vers
  le disque. Sur un événement périodique (`masterMeter` à 10 Hz), le journal
  explose. Voir `src/main/engineEventTrace.js`.
- **`core/nodeInstances.js` (1 145 lignes) et `modules/routing/routingModule.js`
  (1 496 lignes)** sont les deux fichiers où une modification innocente casse
  quatre types de nœuds à la fois. Chantier n°4 de la ROADMAP.
- **Le moteur natif survit à un rechargement du renderer.** Les chaînes VST sont
  `append-only` côté C++ ; `core/chainSync.js` les reconstruit après redémarrage.
