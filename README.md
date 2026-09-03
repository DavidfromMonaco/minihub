# MiniHub

Station de travail musicale de bureau (Windows), bâtie autour du contrôleur MIDI
**Arturia MiniLab 3** : Patch Bay à câbles typés, hôte VST3 natif, séquenceur
MIDI + audio cadencé à l'échantillon, nœuds Mixer / Morpher / Arpégiateur, et
apprentissage des potentiomètres physiques vers les paramètres VST3.

Le **graphe** — et non l'interface affichée — décide de ce que l'on entend.

---

## État

Projet personnel en développement actif. Pas de version publiée, pas
d'installateur. Il se construit et se lance depuis les sources.

## Prérequis

| | |
|---|---|
| Système | Windows 10/11 — **définitif**, pas de portage prévu |
| Node.js | 20 ou plus récent |
| Compilateur | Visual Studio 2022 ou 2026, charge de travail C++ desktop |
| CMake | 3.22 ou plus récent |
| Audio | une sortie WASAPI |

## Dépendances natives à récupérer

Environ **682 Mo**, jamais versionnés. À déposer sous `native/third_party/` :

| Dossier attendu | Quoi |
|---|---|
| `native/third_party/JUCE` | JUCE 9 |
| `native/third_party/vst3sdk` | SDK VST3 de Steinberg |
| `native/third_party/portaudio` | PortAudio |
| `native/third_party/lame` | LAME, avec `bin/lame.exe` |

CMake s'arrête avec un message explicite si l'une manque — il n'y a pas d'échec
silencieux à ce stade.

## Construire et lancer

```bash
npm install
```

Configurer l'arbre natif **une seule fois** (seule étape non scriptée) :

```bash
cmake -S native/audio-engine -B native/audio-engine/build -A x64
```

Ensuite :

```bash
npm start              # build natif + sync dist + lancement
```

## Vérifier

```bash
npm test               # tests JS, lanceur node:test
npm run check          # verificateur d'invariants
npm run build:native   # doit passer 0 erreur 0 avertissement
```

Après `npm run build:native:tests`, les quatre binaires natifs :

```bash
native/audio-engine/build/Release/mlh_native_tests.exe --core
native/audio-engine/build/Release/mlh_native_tests.exe --vst3-e2e
native/audio-engine/build/Release/mlh_native_tests.exe --cross-track-isolation
native/audio-engine/build/Release/mlh_realtime_output_tests.exe
```

**Une modification n'est finie que quand tout ce qui la concerne est vert.**
Voir [AGENTS.md](AGENTS.md) §8.

## Diagnostic

Journal de démarrage :
`%APPDATA%/minilab-hub/minilab-hub-startup.log`. C'est la première chose à lire
quand le moteur ne démarre pas.

## Documentation

Le dépôt se documente lui-même. Point d'entrée obligatoire pour un contributeur
ou un agent : **[AGENTS.md](AGENTS.md)**.

| Fichier | Ce qu'il contient |
|---|---|
| [AGENTS.md](AGENTS.md) | la carte — règles absolues, interdits, conventions, commandes |
| [INTENT.md](INTENT.md) | ce que MiniHub doit être, et ne pas devenir |
| [ARCHITECTURE.md](ARCHITECTURE.md) | l'architecture technique, par section |
| [DECISIONS.md](DECISIONS.md) | ce qui a été tranché, et pourquoi |
| [ROADMAP.md](ROADMAP.md) | ce qui reste à faire |
| [PLANS.md](PLANS.md) | les chantiers longs, multi-sessions |

## Nom

**MiniHub** est le nom du produit. `minilab-hub` (npm, `%APPDATA%`) et `mlh_`
(cibles natives) sont historiques et **ne doivent pas être « corrigés »** : ce
sont des chemins existants sur le disque des utilisateurs. **MiniLab** seul
désigne le contrôleur matériel, jamais l'application. Voir AGENTS.md §2.

## Licence

MIT — voir [LICENSE](LICENSE).
