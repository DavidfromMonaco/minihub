# MINIHub — Rapport du prototype Tracktion Engine

Date d'exécution : 24 août 2026  
Verdict : **FAIL**  
Recommandation : **conserver le moteur MiniHub actuel ; ne pas démarrer de migration.**

## Résumé exécutif

Le prototype isolé démontre que Tracktion Engine peut ouvrir une seule sortie Windows partagée, héberger Dexed et Vital sur deux pistes réellement indépendantes, leur envoyer deux séquences MIDI distinctes, les lire simultanément, les sommer correctement à gain unitaire et produire des fichiers offline sans dépendre du périphérique temps réel.

Il échoue néanmoins à deux critères obligatoires :

- les passes offline successives des deux VST ne sont pas déterministes et les stems rendus séparément ne reconstruisent pas le master de la première passe ;
- le scénario trois cycles termine de manière non propre, avec `0xC0000374` (corruption du tas) ou `0xC0000005` (violation d'accès) suivant le timing, pendant le troisième cycle ou le teardown.

Un défaut supplémentaire dans le helper Tracktion `toBitSet(Array<Track*>)` faisait initialement inclure toutes les pistes dans chaque stem. Le prototype contourne ce helper en construisant le masque `Renderer::Parameters::tracksToDo` directement. Ce contournement permet bien d'exporter des stems distincts, mais le défaut amont doit être corrigé avant toute adoption.

## Isolation et livrables

Tous les ajouts techniques sont sous `tracktion-engine-prototype/`. Aucun fichier de `src/`, `native/audio-engine/`, du runtime Electron ou des tests MiniHub existants n'a été modifié.

Principaux éléments :

- `tracktion-engine-prototype/CMakeLists.txt` : cible C++20 autonome ;
- `tracktion-engine-prototype/src/main.cpp` : banc A–E ;
- `tracktion-engine-prototype/scripts/fetch-dependencies.ps1` : checkout officiel isolé ;
- `tracktion-engine-prototype/scripts/build.ps1` : build Windows reproductible ;
- `tracktion-engine-prototype/scripts/run-validation.ps1` : exécution avec capture du code de sortie natif ;
- `tracktion-engine-prototype/scripts/audit-audio-session.ps1` : inventaire Core Audio par PID ;
- `tracktion-engine-prototype/artifacts/final-session/prototype-results.json` : résultat complet d'un cycle ;
- `tracktion-engine-prototype/artifacts/final-evidence/prototype-results.json` : métriques de trois cycles arrivés jusqu'au rapport avant le crash de teardown ;
- `tracktion-engine-prototype/artifacts/final-validation/process-exit.json` : preuve machine du crash `0xC0000374` ;
- `tracktion-engine-prototype/artifacts/audio-session-audit.json` : preuve d'une session audio active unique.

Les dépendances clonées et les répertoires de build sont ignorés par Git. Les WAV et JSON de mesure restent aussi des artefacts locaux, régénérables.

## Architecture réellement utilisée

```text
minihub_tracktion_probe.exe
└─ 1 tracktion::engine::Engine
   ├─ 1 DeviceManager / 1 juce::AudioDeviceManager
   │  └─ WASAPI partagé "Windows Audio" / 1 session Core Audio
   └─ 1 Edit persistant
      ├─ AudioTrack 1 / MIDI canal 1 / notes 48–55 / Dexed VST3
      ├─ AudioTrack 2 / MIDI canal 2 / notes 72–79 / Vital VST3
      ├─ master plugins / LevelMeter / master à 0 dB
      └─ Renderer offline : master + piste 1 + piste 2
```

Le graphe temps réel et les plugins vivent dans le processus hôte. Les VST ne créent ni gestionnaire audio ni sortie matérielle propre. Un processeur global pass-through capture le master après sommation sans modifier les échantillons. Il n'y a ni limiteur, ni normalisation, ni dither, ni clipping logiciel du host.

Configuration de compilation importante :

- `JUCE_PLUGINHOST_VST3=1` ;
- `JUCE_WASAPI=1` ;
- `JUCE_ASIO=0` et `JUCE_DIRECTSOUND=0` ;
- type choisi : `Windows Audio`, jamais `Windows Audio (Exclusive Mode)` ;
- C++20 ;
- rendu WAV float 32 bits, 48 kHz, bloc offline 512, `realTimeRender=false`.

## Versions et environnement

| Composant | Valeur |
|---|---|
| Tracktion Engine source | `3.5.0` |
| Commit Tracktion | `494e91d2ff546353b69723a5e992dd71d1a0204b` |
| Version runtime Tracktion | `Tracktion Engine v3.1.0` — chaîne amont obsolète |
| JUCE | `JUCE v8.0.13` |
| Commit JUCE | `37c894f83d379179b2070d437ccd0f1cd9af9576` |
| OS/API audio | Windows, WASAPI partagé |
| Périphérique | `Casque (High Definition Audio Device)` |
| Fréquence temps réel | 48 000 Hz |
| Bloc temps réel | 480 échantillons |
| Latence de sortie annoncée | 480 échantillons |
| Instances Engine | 1 |
| Instances AudioDeviceManager | 1 |

## VST testés

| Piste | VST3 | Fabricant | Routage MIDI |
|---|---|---|---|
| 1 | Dexed | Digital Suburban | clip dédié, canal 1, motif 48/55 |
| 2 | Vital | Vital Audio | clip dédié, canal 2, motif 72/79 |

Les deux descriptions VST3 ont des identifiants différents et les deux wrappers `ExternalPlugin` ont été chargés comme instruments.

## Résultats détaillés

### Test A — Audio simultané : PASS

- Les deux VST ont produit du son en même temps.
- Premier cycle représentatif : piste 1 `−17,51 dBFS`, piste 2 `−8,87 dBFS`, master `−6,32 dBFS`.
- Capture réelle du master : `−6,50 dBFS` sur l'exécution avec audit, zéro échantillon à ou au-dessus de 1,0.
- Charger le second VST n'a ni fermé ni remplacé la sortie du premier.
- L'audit Core Audio externe a mesuré `sessionCount=1` et `activeSessionCount=1` pour le PID du host.
- Aucun VST n'a ouvert une session exclusive ou une sortie propre : la seule session appartient à `minihub_tracktion_probe.exe`.

Conclusion : le modèle Tracktion/JUCE résout correctement le risque « un VST prend la sortie au second » lorsqu'un seul Engine/DeviceManager possède le périphérique.

### Test B — Sommation et gain : PASS structurel

Le niveau maître par défaut de l'`Edit` introduisait d'abord un écart fixe de 3 dB entre le meter master et la capture. Le prototype fixe explicitement les volumes piste et master à `0,0 dB`. Il s'agit d'un réglage de gain transparent, pas d'un limiteur ou d'un masquage du défaut.

Pour séparer les mathématiques de sommation de l'état aléatoire des synthés tiers, un second `Edit` de mesure utilise deux clips sinusoïdaux déterministes :

| Signal | Peak | RMS |
|---|---:|---:|
| Piste 1, sinus 220 Hz, amplitude 0,20 | `−13,9794 dBFS` | `−16,9897 dBFS` |
| Piste 2, sinus 330 Hz, amplitude 0,15 | `−16,4782 dBFS` | `−19,4885 dBFS` |
| Master | `−9,5530 dBFS` | `−15,0515 dBFS` |

- Erreur maximale `master − (piste1 + piste2)` : `1,4901161e−8`.
- Erreur RMS : `5,2044833e−9`.
- Aucun échantillon à ou au-dessus de 0 dBFS.
- Aucun limiteur, normaliseur, dither ou clipper inséré.

Conclusion : la sommation Tracktion est linéaire et ne reproduit pas le défaut structurel d'écrasement/gain visé. Le défaut initial des stems venait du masque de pistes amont, pas du mixeur.

### Test C — Transport : PASS avant teardown

Sur chacun des cycles arrivés à terme :

- Play depuis le début ;
- progression d'environ `1,19–1,21 s` ;
- Stop confirmé ;
- retour à `0,000 s` ;
- reprise d'environ `1,03–1,06 s` ;
- passage de `120` à `132 BPM` pendant la lecture ;
- Stop puis nouvelle lecture après les trois exports offline.

Le transport n'a perdu ni piste ni plugin. Le crash de stabilité ultérieur invalide toutefois une qualification globale de production.

### Test D — Export offline : FAIL

Points validés :

- master, piste 1 et piste 2 sont écrits en WAV float 32 bits ;
- les stems deviennent réellement distincts avec le masque `tracksToDo` construit manuellement ;
- piste 1 et piste 2 sont non silencieuses ;
- les trois fichiers de 4 secondes sont calculés en environ `1,70–1,73 s` au total, donc nettement plus vite que les 12 secondes audio cumulées ;
- après fermeture physique du périphérique JUCE, un nouveau master est encore rendu en environ `0,59–0,60 s` ; l'export est donc bien indépendant de la callback temps réel.

Échecs :

- répétition du master : différence maximale `0,633565992` sur l'exécution complète d'un cycle et `0,705214858` sur l'exécution trois cycles ;
- export périphérique fermé contre premier master : différence maximale `0,581646532` à `0,661136091` ;
- somme des stems VST rendus séparément contre le master VST : différence maximale `0,706986412` sur l'exécution d'audit.

Interprétation : les rendus utilisent bien Tracktion offline, mais Dexed/Vital ne repartent pas du même état DSP à chaque nouvelle passe. Tracktion ne fournit pas ici un snapshot/reset qui garantisse que master, stem 1, stem 2 et répétition commencent dans un état VST identique. Le renderer lui-même sait sommer exactement des sources déterministes, mais le critère demandé porte sur les VST réellement testés : il est donc **FAIL**.

Défaut amont associé : au commit testé, `toBitSet(Array<Track*>)` sélectionne toutes les pistes. Sans le contournement local, chaque stem est en réalité le master. Le prototype n'a pas modifié Tracktion ; il a évité ce helper et alimenté directement le masque public `tracksToDo`.

### Test E — Stabilité : FAIL

Deux signatures ont été observées sur des exécutions trois cycles :

- `0xC0000374` — corruption du tas, parfois au début du troisième cycle ;
- `0xC0000005` — violation d'accès, parfois après que les trois cycles, les exports et le JSON ont été produits, pendant le teardown.

La preuve régénérée par `run-validation.ps1` contient :

```json
{
  "cycles": 3,
  "nativeExitCode": -1073740940,
  "nativeExitHex": "0xC0000374",
  "cleanProcessExit": false
}
```

Sur une exécution ayant atteint la fin logique des trois cycles avant le crash :

| Cycle | Temps des 3 exports | Handles | Working set |
|---:|---:|---:|---:|
| 1 | `1707,66 ms` | 372 | 201 416 704 octets |
| 2 | `1725,81 ms` | 374 | 201 515 008 octets |
| 3 | `1707,73 ms` | 374 | 201 531 392 octets |

Les handles et le working set se stabilisent pendant les cycles, mais une terminaison native non propre est éliminatoire. Sans trace ASan/symboles dans Tracktion et les deux plugins, la cause racine exacte ne peut pas être attribuée honnêtement à une classe particulière. Le symptôme est néanmoins précis et reproductible : durée de vie/teardown du graphe ou des instances VST après des alternances temps réel/offline.

## Problèmes rencontrés

1. Le sous-module officiel JUCE est référencé en SSH ; le fetch a dû utiliser une substitution HTTPS, sans changer le commit.
2. L'environnement Windows contenait à la fois `Path` et `PATH`, ce qui faisait échouer MSBuild. Le script de build recrée un environnement enfant canonique.
3. L'API `develop` diffère d'exemples plus anciens : namespaces temporels, constructeur `MidiChannel`, format manager JUCE et PID Windows ont été adaptés.
4. `toBitSet(Array<Track*>)` sélectionne toutes les pistes ; contournement local par masque d'indices.
5. `DeviceManager::closeDevices()` ne ferme pas seul le périphérique courant de JUCE ; appel explicite à `closeAudioDevice()` requis.
6. Exports VST non déterministes entre passes.
7. Crash multi-cycle/teardown.

## Implications de licence

La voie de licence est techniquement réaliste mais coûteuse et double :

- Tracktion Engine : GPLv3+ ou offre commerciale selon revenus/financements, sièges et branding ;
- JUCE 8 épinglé : AGPLv3 ou offre commerciale JUCE ;
- un MiniHub propriétaire doit acquérir les deux licences commerciales appropriées ;
- une publication sous la seule mention MIT actuelle ne couvre pas le binaire combiné Tracktion/JUCE ;
- validation écrite par les deux vendeurs et revue juridique requises avant tout produit.

Les détails, montants et sources figurent dans `TRACKTION_ENGINE_FEASIBILITY.md`.

## Comparaison avec le moteur MiniHub actuel

| Sujet | Moteur MiniHub actuel | Prototype Tracktion |
|---|---|---|
| Intégration Electron | Processus natif supervisé, IPC NDJSON déjà en place | Compatible avec le même schéma |
| Audio Windows | Un `juce::AudioDeviceManager`, WASAPI partagé | Un DeviceManager Tracktion/JUCE, WASAPI partagé |
| Graphe visuel | `AudioExecutionPlan`/`MidiExecutionPlan` dérivés des Nodes/Patch Bay | Mapping à construire vers Track/Plugin/Rack/Output Tracktion |
| Séquenceur | Plans immuables, transport et export MiniHub | `Edit`, tracks, clips et TransportControl prêts à l'emploi |
| Export | Contexte offline cloné et privé déjà conçu | Renderer plus riche, mais non-déterminisme VST observé |
| Stems | Implémentation MiniHub contrôlée | Helper de sélection amont défectueux dans `develop` |
| PDC/fonctions DAW | À maintenir maison | Avantage Tracktion substantiel |
| Risque migration | Aucun pour conserver | Réécriture du modèle de session, des IDs et du bridge ; crash bloquant |
| Licence supplémentaire | JUCE actuel | JUCE + Tracktion commercial pour le propriétaire |

Tracktion réduirait beaucoup de code DAW maison, surtout pour clips, automation, PDC, racks et export. Mais MiniHub possède déjà la frontière de processus, la session audio unique, les plans temps réel, les transactions d'export et les tests déterministes. Dans l'état testé, le remplacement échange une dette fonctionnelle connue contre des défauts de cycle de vie et d'export moins contrôlables.

## Architecture MiniHub envisageable si Tracktion est requalifié plus tard

La migration réelle n'est pas commencée. L'architecture de moindre impact serait :

```text
UI Electron actuelle
  Nodes / Patch Bay / Séquenceur / Clip editor
                  │ commandes et événements existants
                  ▼
Electron main : EngineProcess inchangé
  supervision, handshake, crash recovery, NDJSON
                  │ protocole versionné
                  ▼
Tracktion adapter dans un unique processus natif
  ├─ 1 Engine + 1 DeviceManager + 1 Edit persistant
  ├─ Node ID MiniHub ↔ Track/Plugin/Rack/EditItemID
  ├─ câbles MIDI ↔ entrées MIDI/virtual MIDI/track destinations
  ├─ câbles audio ↔ track outputs/racks/aux/submix
  ├─ transport/tempo ↔ TransportControl/TempoSequence
  └─ export ↔ Renderer avec snapshot transactionnel
```

Responsabilités conservées côté MiniHub :

- Electron, fenêtres et cycle de vie applicatif ;
- UI actuelle et état visuel ;
- Nodes, Patch Bay et logique d'édition des câbles ;
- IDs persistants du format `.minihub` ;
- validation des commandes, diagnostics, sauvegarde et reprise après crash.

Responsabilités confiées à Tracktion :

- pistes, clips et tempo ;
- routage MIDI/audio compilé ;
- hébergement VST et FX ;
- mix et master ;
- transport et PDC ;
- rendu offline et stems.

Le bridge devrait appliquer des snapshots complets et atomiques du graphe UI vers un `Edit`, jamais exposer les objets Tracktion au renderer. Les éditeurs VST resteraient des fenêtres natives détenues par le processus audio. Le scan VST pourrait rester un helper sans périphérique, comme aujourd'hui.

Conditions préalables avant de reconsidérer cette architecture :

1. release Tracktion stable épinglée, pas `develop` ;
2. correctif officiel ou test de non-régression du masque de pistes ;
3. protocole documenté pour recréer un état VST identique à chaque pass master/stem ;
4. 50 cycles minimum sous ASan/diagnostics heap, deux VST commerciaux et deux VST de test déterministes ;
5. fermeture propre du processus, zéro crash et zéro session Core Audio restante ;
6. devis et validation écrite Tracktion + JUCE ;
7. décision humaine explicite avant toute migration.

## Matrice PASS / FAIL finale

| Critère obligatoire | Résultat |
|---|---|
| 2 VST différents simultanés | PASS |
| 2 pistes réellement indépendantes | PASS |
| Une seule session audio Windows | PASS |
| Mix temps réel stable | PASS pendant lecture, mais invalidé par la stabilité globale |
| Absence d'anomalie structurelle de gain | PASS |
| Transport contrôlable | PASS avant crash |
| Export multipiste offline correct et déterministe | **FAIL** |
| Stabilité multi-cycle/teardown | **FAIL** |
| Voie de licence réaliste | PASS conditionnel |

# Verdict : FAIL

Le prototype ne satisfait pas tous les critères obligatoires. La cause technique bloquante est double : absence de déterminisme des passes VST offline et corruption mémoire/violation d'accès multi-cycle. Le défaut amont du masque de pistes renforce le risque de la version testée.

**Recommandation : conserver le moteur MiniHub actuel. Ne pas migrer.** Attendre une correction/release Tracktion, un protocole VST déterministe et une nouvelle qualification complète. Toute décision ultérieure appartient à l'arbitrage humain.
