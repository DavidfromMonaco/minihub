# MiniHub — Spécification du nœud Matrix

## 0. Révisions

**2026-09-03 — relecture contre le code réel.** La cible fonctionnelle est
inchangée. Neuf points ont été corrigés parce qu'ils supposaient un mécanisme
qui n'existe pas dans le dépôt, ou parce qu'ils se contredisaient entre eux.
Chaque correction est marquée **`[révisé 2026-09-03]`** à l'endroit où elle
s'applique, et les trois qui changent une décision sont enregistrées :

| Point | Ce qui n'allait pas | Décision |
|---|---|---|
| §2.6, §9 | l'horloge se gelait elle-même (§4.1 `Stop` contre §9.2) | [DECISIONS.md](DECISIONS.md) D-017 |
| §5 | deux systèmes Learn pour un seul armement natif | [DECISIONS.md](DECISIONS.md) D-018 |
| périmètre | `automation` était hors périmètre ([INTENT.md](INTENT.md) §6) | [DECISIONS.md](DECISIONS.md) D-016 |
| §7.2 | l'étage de gain post-chaîne des nœuds VST n'existe pas | à construire |
| §4.3 | un `ctrl-in` sur le Mixer serait silencieusement ignoré | correctif nommé |
| §9.1, §10, §17 | l'exécution est bi-contexte, pas mono | phase 1, pas phase 4 |
| §8.2 | le déterminisme était énoncé, pas spécifié | règle de tirage ajoutée |
| §11 | deux voies de persistance proposées, aucune choisie | choisie |
| §16 | compte de tests périmé, et contradiction avec AGENTS.md §8 | corrigé |

---

## 1. Objet du chantier

Je veux abandonner le **Morpher actuel** comme direction produit et le remplacer par un nouveau nœud nommé **Matrix**.

La Matrix doit être le **centre d'orchestration de MiniHub** : elle se connecte aux nœuds que je choisis, découvre ce qu'ils savent faire, puis les pilote dans le temps à partir de scènes et de règles préparées à l'avance.

L'objectif final est de transformer un setup MiniHub préconfiguré en **système de génération et d'arrangement musical automatique**. La Matrix ne doit pas générer du son elle-même : elle doit gouverner le setup qui le génère.

Cette spécification décrit la cible fonctionnelle complète. L'implémentation peut être découpée en phases, mais aucune simplification ne doit modifier cette cible sans validation explicite.

---

## 2. Décisions produit non négociables

1. Le nom du nouveau nœud est **Matrix**.
2. La Matrix est un **nœud de contrôle et d'orchestration**, jamais un nœud audio.
3. Aucun échantillon audio ne doit traverser Electron ou l'IPC.
4. La Matrix ne peut piloter que les nœuds auxquels elle est réellement reliée dans le Patch Bay.
5. Le graphe reste l'autorité : changer de page ou fermer l'éditeur de la Matrix ne doit jamais interrompre son fonctionnement.
6. Les actions temporelles, fades et automations sont cadencés **au tempo du
   Transport natif**, dans le moteur, jamais par un timer JavaScript.
   **`[révisé 2026-09-03]`** La Matrix suit le **tempo** global, pas la
   **position** du Transport : elle tient son propre compteur de temps musical,
   avancé par le compteur d'échantillons du callback, dont le BPM est relu à
   chaque bloc dans le `Transport`. Asservir la Matrix au PPQ du Transport
   rendait §4.1 et §15.B infaisables — voir [DECISIONS.md](DECISIONS.md) D-017.
7. La Matrix doit pouvoir piloter les paramètres exposés par les VST3, notamment `Attack`, `Decay`, `Sustain`, `Release`, cutoff, resonance, drive, mix, bypass et tout autre paramètre réellement publié par le plugin.
8. Un système **Matrix Learn** doit permettre d'associer manuellement un contrôle VST à une fonction de la Matrix quand le nom exposé par le plugin est ambigu.
9. Les configurations de la Matrix appartiennent au projet `.minihub`, pas aux préférences de la machine.
10. À chargement égal, seed égale et actions utilisateur égales, le comportement génératif doit être reproductible.
11. L'état éditable doit être sauvegardé, mais un projet chargé doit toujours ouvrir la Matrix **à l'arrêt**.
12. La Matrix doit fonctionner de façon identique en lecture live et en export offline lorsque le même scénario et la même seed sont utilisés.

---

## 3. Position de la Matrix dans MiniHub

### 3.1 Nature du nœud

La Matrix doit être ajoutée au registre des types de nœuds sous un type stable `matrix`.

Propriétés attendues :

- une seule Matrix par projet (`singleton`) ;
- ajout manuel depuis le Patch Bay ;
- aucune création automatique dans un nouveau projet ;
- nœud supprimable ;
- nœud non copiable ;
- aucune entrée ou sortie `audio` ;
- aucune entrée ou sortie `midi` dans la première version ;
- une sortie `control` capable d'être reliée à plusieurs nœuds cibles ;
- identité stable utilisée dans le projet, le graphe et le moteur ;
- page d'édition dédiée, accessible comme les autres nœuds.

### 3.2 Connexions de contrôle

Les types de nœuds pilotables doivent exposer une entrée `control` lorsqu'ils possèdent au moins une capacité compatible avec la Matrix.

Une connexion Matrix → cible signifie :

- la cible apparaît dans l'éditeur de la Matrix ;
- ses capacités disponibles deviennent sélectionnables ;
- la Matrix est autorisée à lui envoyer des actions ou des valeurs ;
- la suppression du câble interdit immédiatement toute nouvelle commande vers cette cible.

La Matrix ne doit jamais rechercher ni piloter automatiquement tous les nœuds du projet. **L'absence de câble signifie l'absence de contrôle.**

Les cibles sont référencées par leur `nodeId` stable, jamais par leur nom d'affichage ni leur `ordinal`.

### 3.3 Contrat de capacités

La Matrix ne doit pas contenir une série de suppositions fragiles sur chaque interface. Chaque famille de nœuds pilotable doit exposer un petit contrat de capacités descriptif.

Une capacité doit au minimum déclarer :

- un identifiant stable ;
- un libellé affichable ;
- son type : `action`, `boolean`, `continuous` ou `enum` ;
- sa plage et sa valeur par défaut si elle est continue ;
- ses valeurs autorisées si elle est énumérée ;
- si elle accepte une transition temporelle ;
- l'adresse stable de la cible réelle ;
- son état de disponibilité.

La Matrix doit utiliser ce contrat pour construire son interface et valider ses scènes. Une capacité inconnue ou devenue indisponible doit être signalée, jamais remplacée silencieusement par une autre.

---

## 4. Nœuds et capacités à piloter

### 4.1 Séquenceur

Quand la Matrix est connectée au Sequencer, elle doit pouvoir déclencher :

- **Play** : lecture depuis la position courante ;
- **Stop** : arrêt sûr avec extinction des notes tenues ;
- **Restart** : retour au début de l'arrangement puis lecture ;
- **Go to Start** : retour au début sans lecture ;
- activation ou désactivation de **Loop**.

Ces commandes doivent utiliser le Sequencer et le Transport existants. Il ne doit pas exister une seconde horloge concurrente dans la Matrix.

### 4.2 Nœuds VST

Quand la Matrix est connectée à un nœud VST, elle doit pouvoir piloter :

- le gain de sortie post-chaîne fourni par MiniHub ;
- le mute et le bypass lorsque ces fonctions sont disponibles ;
- chaque paramètre publié par chaque instance VST3 de la chaîne ;
- plusieurs paramètres du même plugin ou de plusieurs plugins simultanément.

L'adresse d'un paramètre doit rester stable et contenir au minimum :

- le `nodeId` du nœud VST ;
- l'identité stable de l'instance du plugin dans la chaîne ;
- l'identifiant natif stable du paramètre VST ;
- un libellé utilisateur facultatif, sans rôle d'identification technique.

La position visuelle du nœud, son ordinal et la position temporaire du plugin dans une liste ne doivent pas servir d'identité persistante.

### 4.3 Mixer

Quand la Matrix est connectée à un Mixer, elle doit pouvoir piloter :

- le niveau de chaque entrée ;
- le mute de chaque entrée ;
- le niveau master du Mixer ;
- le mute master ;
- les fades sur les niveaux ci-dessus.

Les entrées dynamiques doivent conserver une identité stable. Une piste supprimée ou devenue indisponible ne doit jamais rediriger son automation vers une autre entrée.

**`[révisé 2026-09-03]` Piège vérifié.** Déclarer un port `ctrl-in` sur `mixer`
ou `morpher` dans `core/nodeTypes.js` **ne suffit pas** : pour un type portant
`dynamicAudioInputs`, `core/nodeInstances.js:289` construit les entrées du nœud
du graphe **entièrement** depuis `content.inputs` et ignore `type.ports.inputs`.
Le port existerait dans le registre, n'atteindrait jamais le graphe, et aucune
erreur ne serait levée. La ligne 289 doit concaténer les ports statiques non
audio, et ce correctif doit porter son propre test — c'est exactement la classe
de panne silencieuse que les invariants du dépôt existent pour empêcher.

### 4.4 Arpégiateur

Quand la Matrix est connectée à un Arpégiateur, elle doit pouvoir piloter au minimum :

- activation/désactivation ;
- pattern ;
- rate ;
- gate ;
- mode ;
- paramètres de randomisation déjà disponibles dans le nœud.

Les changements doivent être appliqués sur une frontière musicale sûre afin d'éviter les notes bloquées et les changements de motif au milieu d'un pas, sauf si l'utilisateur choisit explicitement une transition immédiate.

### 4.5 Extension future

Le contrat de capacités doit permettre d'ajouter ensuite Recorder, Preset Machine et de futurs nœuds sans réécrire le cœur de la Matrix. Ces extensions ne font pas partie du premier lot obligatoire.

---

## 5. Matrix Learn pour les VST3

Les noms de paramètres VST étant souvent inconsistants, la Matrix doit fournir un apprentissage manuel fiable.

### 5.1 Parcours utilisateur

1. L'utilisateur ajoute une automation ou un état VST dans une scène.
2. Il sélectionne le nœud VST et, si nécessaire, l'instance de plugin concernée.
3. Il clique sur **Learn** dans la Matrix.
4. Il bouge le bouton voulu dans l'éditeur natif du VST.
5. Le prochain événement `vstParameterTouched` valide associe ce paramètre à la ligne sélectionnée.
6. La Matrix affiche le plugin, le nom exposé, l'identifiant du paramètre et permet d'ajouter un alias humain tel que `Release`.

**`[révisé 2026-09-03]` Un seul armement dans l'application.**
`ControlBindingManager` détient **un** `pendingLearn`, au singulier, pour toute
l'application, et le moteur natif supersède sa demande de façon atomique. Deux
systèmes Learn indépendants annuleraient donc silencieusement l'armement l'un de
l'autre. Matrix Learn et le Learn MiniLab partagent un **arbitre** commun : une
seule demande armée à la fois, portant l'identité de son propriétaire
(`minilab` | `matrix`), et l'annulation de l'autre est **visible**. Les
persistances, elles, restent séparées. L'arbitre gagne l'armement par instance
explicite, que l'étape 2 ci-dessus exige et que `armLearn()` ne sait pas faire
aujourd'hui (il échoue en `multiple-plugin-targets`). Voir
[DECISIONS.md](DECISIONS.md) D-018.

### 5.2 Règles de sécurité

- Le Learn doit être explicitement armé et limité à une seule ligne.
- Il doit pouvoir être annulé.
- Il doit ignorer les événements antérieurs à son armement.
- Il ne doit pas écraser un mapping existant sans confirmation.
- Il ne doit pas modifier les mappings MiniLab → VST déjà gérés par le système Learn existant.
- Si le plugin ou le paramètre n'existe plus, la ligne devient **Unresolved**.
  **`[révisé 2026-09-03]`** « Unresolved » est le libellé affiché, pas un
  sixième état : les états internes sont ceux que `bindingStatus()` définit
  déjà — `unbound`, `disconnected`, `missing-target`, `not-ready`, `active`.
  Une seule langue pour les deux systèmes Learn.
- Une ligne non résolue ne doit envoyer aucune valeur et ne doit jamais se rattacher automatiquement à un autre paramètre ressemblant.

### 5.3 Valeurs

Les valeurs techniques sont stockées dans l'intervalle normalisé VST `[0, 1]`. L'interface peut afficher en complément le texte fourni par le plugin, mais ne doit pas déduire une unité qui n'est pas exposée.

---

## 6. Scènes

Une **Scene** est une description nommée de ce que le setup doit faire et de l'état qu'il doit atteindre.

Chaque scène contient :

- un identifiant stable indépendant de son nom et de sa position ;
- un nom éditable ;
- une couleur facultative d'organisation ;
- une durée musicale ;
- des actions d'entrée ;
- des états cibles ;
- des transitions ou automations ;
- ses règles de sortie vers les scènes suivantes.

### 6.1 Actions d'entrée

Une action d'entrée est déclenchée une seule fois lorsque la scène devient active. Exemples :

- Sequencer `Restart` ;
- Sequencer `Stop` ;
- activer un Arpégiateur ;
- désactiver la boucle ;
- muter une entrée de Mixer.

### 6.2 États cibles

Un état cible décrit une valeur à maintenir pendant la scène. Exemples :

- Release du synthé à 80 % ;
- Sustain à 65 % ;
- entrée Bass du Mixer non mutée ;
- gain du Pad à −12 dB ;
- Arpégiateur sur Pattern B.

### 6.3 Automations dans une scène

Une ligne d'automation doit proposer au minimum quatre modes :

1. **Set** : appliquer immédiatement une valeur ;
2. **Ramp** : interpoler de la valeur de départ vers la valeur cible pendant une durée musicale ;
3. **Random Range** : choisir une valeur comprise dans une plage définie ;
4. **Random Step** : choisir une nouvelle valeur dans la plage à chaque intervalle musical défini.

Exemples attendus :

- `Release : 20 % → 80 % sur 8 mesures` ;
- `Decay : valeur aléatoire entre 30 % et 50 % toutes les 4 mesures` ;
- `Sustain : 70 % pendant toute la scène` ;
- `Cutoff : 15 % → 65 % avec une courbe douce`.

### 6.4 Édition minimale

L'interface doit permettre de :

- créer, renommer, dupliquer, réordonner et supprimer une scène ;
- choisir la scène de départ ;
- ajouter ou retirer une ligne de contrôle ;
- sélectionner une cible uniquement parmi les nœuds connectés ;
- sélectionner uniquement une capacité réellement disponible ;
- définir les valeurs, durées et courbes ;
- déclencher manuellement une scène pour la tester ;
- identifier clairement les lignes non résolues.

La suppression d'une scène référencée par une transition doit demander confirmation et nettoyer ou signaler toutes les références devenues invalides.

---

## 7. Transitions et fades

### 7.1 Transitions temporelles

Une transition peut être :

- instantanée ;
- exprimée en temps ou en mesures ;
- synchronisée sur la prochaine frontière choisie : immédiate, prochain temps ou prochaine mesure ;
- linéaire, ease-in, ease-out ou ease-in-out.

Une durée musicale doit suivre le Transport : si le BPM change pendant la transition, sa fin reste alignée sur la position musicale prévue et non sur une durée murale calculée à l'avance.

### 7.2 Fade In et Fade Out

La Matrix doit proposer des actions explicites **Fade In** et **Fade Out** pour toute capacité de gain audio compatible.

- Fade In : silence vers le niveau cible.
- Fade Out : niveau courant vers le silence.
- Durée : instantanée ou exprimée en temps/mesures.
- La rampe doit être exécutée dans le moteur natif sans zipper noise.
- À la fin d'un Fade Out, la cible peut être automatiquement mutée si l'option est activée.
- Un fade ne doit pas dépendre de l'existence d'un paramètre `Volume` dans le VST : pour un nœud VST, MiniHub doit utiliser son propre étage de gain post-chaîne.

**`[révisé 2026-09-03]` Cet étage n'existe pas : il est à construire.** Dans
`audio_graph.cpp`, `masterLevel` n'est appliqué que sur les nœuds `mixer` ; la
branche `vst` sort la chaîne telle quelle. Le seul gain qui la traverse est
`trackGain.gain`, fourni par `sequencer_->midiTrackGainForOutput()` — c'est le
**volume de piste du séquenceur**, déjà propriétaire de cet emplacement. Trois
contraintes en découlent :

- l'étage Matrix est un **second** gain dans `NodeValues`, appliqué après la
  chaîne. Les deux se multiplient ; aucun n'écrase l'autre ;
- « sans zipper noise » impose une rampe lissée, à la manière des 20 ms de
  `MasterOutput`, pas une écriture atomique nue ;
- ce gain est une **valeur**, pas une topologie : il passe par
  `audioNodeValues()` et jamais par `audioTopologyKey()`. Sinon chaque fade
  recompile le graphe et remet à zéro les lignes de retard PDC
  ([DECISIONS.md](DECISIONS.md) D-004).

Le comportement d'une automation interrompue doit être déterministe : une nouvelle commande sur la même cible remplace la rampe précédente à partir de la valeur courante, sans saut brutal.

---

## 8. Autopilot génératif

Le mode **Autopilot** enchaîne les scènes sans intervention, selon des règles préparées par l'utilisateur.

### 8.1 Règles de sortie

À la fin d'une scène, plusieurs scènes suivantes peuvent être autorisées. Chaque transition déclare :

- la scène destination ;
- son poids ou sa probabilité ;
- un nombre minimal de répétitions de la scène courante ;
- un nombre maximal de répétitions ;
- l'autorisation ou l'interdiction d'une répétition immédiate ;
- une condition d'activation facultative fondée uniquement sur l'état interne connu de la Matrix.

L'interface doit empêcher ou signaler les configurations impossibles : aucune destination valide, probabilités nulles, destination supprimée ou boucle interdite sans autre issue.

### 8.2 Seed et reproductibilité

La Matrix doit offrir :

- une seed saisissable ;
- une action pour générer une nouvelle seed ;
- un mode de seed aléatoire à chaque démarrage ;
- un mode de seed fixe pour reproduire exactement une performance.

La même seed doit gouverner les choix de scènes et toutes les valeurs aléatoires de paramètres. Un **Restart** réinitialise le générateur pseudo-aléatoire et les compteurs pour reproduire le parcours depuis le début.

**`[révisé 2026-09-03]` Règle de tirage.** « Même seed, même suite » n'est pas
une propriété du générateur, c'est une propriété de **ce qui le consomme**. Le
générateur n'est consommé qu'à deux moments — une transition de scène, une
frontière de Random Step — et chaque tirage est indexé par
`(sceneIndex, lineId, stepIndex)`, **jamais** par ordre d'appel, par temps mural
ni par compteur de blocs audio. Sans cette règle, un changement de taille de bloc
casse la reproductibilité, et le live diverge de l'export — qui rend plus vite,
sur un autre thread, avec potentiellement une autre taille de bloc. C'est la
différence entre §15.E qui passe et §15.E intestable.

### 8.3 Commandes globales de la Matrix

L'éditeur et le nœud du Patch Bay doivent exposer au minimum :

- **Run** : démarrer depuis la scène sélectionnée ou la scène de départ ;
- **Stop** : arrêter l'orchestration et les Sequencers qu'elle a démarrés, annuler les événements futurs et effectuer un panic MIDI ;
- **Restart** : revenir à la scène de départ, réinitialiser seed et compteurs, réappliquer l'état initial puis démarrer ;
- **Next Scene** : forcer immédiatement ou à la prochaine frontière musicale le passage vers une scène valide ;
- activation/désactivation de **Autopilot**.

Après `Stop`, les valeurs courantes de gain et de paramètres restent visibles et inchangées. Le prochain `Run` réapplique explicitement l'état d'entrée de la scène choisie.

---

## 9. Horloge et exécution native

### 9.1 Principe

Le renderer sert à éditer le scénario. Le moteur natif est responsable de son exécution musicale.

La Matrix doit publier vers le moteur un plan validé et immuable dans sa structure, équivalent dans son principe aux plans audio et MIDI existants. Le nom exact de cette structure est libre, mais elle doit séparer :

- la topologie et les adresses de capacités ;
- les valeurs modifiables ;
- l'état runtime non persisté ;
- les événements temporels planifiés.

**`[révisé 2026-09-03]` Il n'y a pas un plan, il y en a deux.** L'export offline
**clone les chaînes** dans son propre contexte, compile ses propres
`MidiExecutionPlan` et `AudioExecutionPlan`, et rend sur un thread
`offline-worker` piloté par `offlineExportTransport_`. Un runtime Matrix est
donc **par contexte**, exactement comme la paire `activePlan_` / `exportPlan_`
du séquenceur, et les adresses de paramètres se résolvent dans le `lookup` du
contexte courant — pas dans les instances vivantes. Cette structure bi-contexte
appartient à la **phase 1**, même si le code d'export n'arrive qu'en phase 4 :
l'ajouter après coup revient à réécrire le runtime.

**L'horloge de la Matrix appartient elle aussi au contexte.** En live elle lit
le BPM du `Transport` live ; en export, celui du transport d'export. C'est ce
qui rend §10 possible sans que l'export prenne le contrôle du Transport live.

### 9.2 Contraintes temps réel

- Aucun timer JavaScript ne cadence une scène, un fade ou une automation.
  **`[révisé 2026-09-03]`** Ce que cette règle interdit, c'est la gigue et la
  dérive du renderer. Le compteur propre de la Matrix (D-017) la respecte
  intégralement : il vit dans le moteur, avance par échantillons, et relit le
  BPM global à chaque bloc — il ne dérive donc jamais du séquenceur, dont les
  mesures ont exactement la même longueur.
- Aucune allocation, attente, opération disque ou IPC ne doit être exécutée depuis le callback audio.
- Le thread audio ne doit jamais prendre de verrou bloquant.
- Les commandes VST doivent respecter le modèle de threading des plugins et du moteur existant.
  **`[révisé 2026-09-03]`** Vérifié : `DirectVst3Plugin::setParameter` écrit
  dans un anneau sans verrou (`queueParameter`) et ne prend **pas**
  `beginControlMutation()`. Le chemin d'écriture ne fait donc pas sauter de
  blocs, et l'exigence §16 sur `pluginBlocksSkipped` est atteignable. En
  revanche il tourne sur le thread message, derrière une commande IPC qui
  revalide dix champs d'identité : il ne peut pas porter une rampe. La rampe est
  évaluée dans le moteur ; une écriture bridée (~30 Hz) vers
  `setParamNormalized` reste nécessaire **en plus**, pour que le potentiomètre
  bouge dans l'éditeur natif du plugin sous les yeux de l'utilisateur.
- Les changements doivent être au minimum précis au bloc audio et calculés depuis la position PPQ canonique.
- Les événements en retard ne doivent pas être rejoués en rafale.
- Stop, changement de projet, suppression de nœud, crash/restart moteur et fermeture de l'application doivent annuler proprement les événements devenus invalides.
- Les blocs sautés ou automations abandonnées doivent être observables dans la télémétrie ou le diagnostic existant.

### 9.3 Changements à chaud

Modifier une valeur d'une scène pendant que la Matrix joue ne doit pas recompiler le graphe audio. Les modifications structurelles peuvent publier un nouveau plan hors du thread audio, puis l'échanger de façon sûre.

Le système doit conserver la séparation déjà utilisée par MiniHub entre topologie et valeurs continues afin d'éviter les recompilations répétées pendant le déplacement d'un slider.

---

## 10. Export offline

Une performance générée par la Matrix doit pouvoir être exportée par le Sequencer sans divergence avec la lecture live.

Exigences :

- l'export utilise un instantané figé des scènes, règles, mappings et seed ;
- l'horloge privée d'export pilote aussi la Matrix exportée ;
- les plugins de l'export reçoivent les mêmes automations que ceux du live ;
- les modifications effectuées dans l'interface après le début de l'export n'affectent pas cet export ;
- une seed fixe produit les mêmes choix de scènes et valeurs aléatoires à chaque passe ;
- l'export ne doit pas prendre le contrôle du Transport live ;
- une génération potentiellement infinie exige une durée ou un nombre de scènes explicite avant export.

---

## 11. Persistance et restauration

Tout ce qui suit doit être persisté dans le projet `.minihub` :

- scènes, ordre et identités ;
- scène de départ ;
- actions, états et automations ;
- durées, courbes et quantification ;
- règles Autopilot ;
- seed et mode de seed ;
- mappings Matrix Learn ;
- alias utilisateur ;
- options de fade ;
- état éditorial de l'interface utile au projet.

Ne doivent pas être persistés comme état actif :

- Matrix en cours de lecture ;
- scène runtime actuelle ;
- position temporelle courante ;
- rampe en cours ;
- compteurs de répétition runtime ;
- état interne courant du générateur pseudo-aléatoire.

Les identifiants doivent être validés à la lecture. Les références manquantes sont conservées comme non résolues afin de permettre une réparation ultérieure, mais ne doivent produire aucune commande.

**`[révisé 2026-09-03]` La voie est choisie : le contenu du nœud.** Toute la
configuration Matrix vit dans le `content` de l'instance, donc sous la clé
`nodeInstances` qui existe déjà. **Aucune clé n'est ajoutée à
`core/projectKeys.js`** : l'invariant 6 n'est pas touché, et la donnée hérite
sans effort du cycle de vie que `ProjectManager.bootstrap()` et
`SettingsStore.applicationData()` appliquent déjà. Elle ne peut donc pas migrer
vers les préférences applicatives.

---

## 12. Remplacement du Morpher

### 12.1 Nouveau comportement

- Le Morpher ne doit plus être proposé à la création dans les nouveaux projets.
- La Matrix ne reprend aucune fonction de transport audio du Morpher.
- Aucun câble audio d'un ancien Morpher ne doit être transformé automatiquement en câble de contrôle.

### 12.2 Compatibilité des projets existants

Une migration automatique Morpher → Matrix serait incorrecte, car les deux nœuds n'ont ni la même nature ni les mêmes ports.

Par conséquent :

- un ancien projet contenant un Morpher doit continuer à s'ouvrir sans perte ni corruption ;
- le Morpher existant peut rester fonctionnel sous le libellé **Morpher (legacy)** ;
- il ne doit plus apparaître dans le menu d'ajout ;
- aucune Matrix ne doit être ajoutée automatiquement ;
- la suppression manuelle du dernier Morpher legacy permet au projet de ne plus dépendre de lui ;
- la compatibilité legacy ne doit pas contaminer le nouveau modèle de contrôle de la Matrix.

La suppression définitive du code legacy fera l'objet d'un chantier séparé après confirmation qu'aucun projet utile n'en dépend.

---

## 13. Interface attendue

L'éditeur Matrix doit rester cohérent avec MiniHub, sans framework ni styles inline.

Il doit comporter au minimum :

1. une barre de transport Matrix : Run, Stop, Restart, Next Scene, Autopilot, seed ;
2. une liste ordonnée des scènes avec indication de la scène active ;
3. un éditeur de scène ;
4. une liste des nœuds connectés et de leurs capacités ;
5. les lignes d'actions, d'états et d'automations ;
6. un éditeur de transitions Autopilot ;
7. un état clair pour les cibles déconnectées, plugins absents et paramètres non résolus ;
8. Matrix Learn avec armement, attente, succès, annulation et erreur visibles.

Le nœud dans le Patch Bay doit rester compact et afficher au minimum :

- état arrêté/en cours ;
- scène active ;
- indicateur Autopilot ;
- Run/Stop ;
- port `control-out`.

Les noms de plugins et paramètres doivent être échappés avant toute insertion HTML. Tous les écouteurs et abonnements de l'éditeur doivent être retirés dans `unmount()` sans arrêter le moteur de la Matrix.

---

## 14. Gestion des erreurs et cas limites

Le système doit gérer explicitement :

- câble supprimé pendant une scène ;
- nœud ou plugin supprimé pendant une automation ;
- réorganisation d'une chaîne VST ;
- paramètre VST absent après mise à jour du plugin ;
- projet chargé avec une référence inconnue ;
- moteur natif indisponible ou redémarré ;
- changement de BPM pendant une transition ;
- Stop pendant un fade ;
- nouvelle automation envoyée vers une cible déjà en rampe ;
- scène supprimée alors qu'elle est référencée ;
- Autopilot sans destination valide ;
- export d'une règle infinie sans limite de durée ;
- valeur VST `NaN`, non finie ou hors `[0, 1]` ;
- suppression de la Matrix pendant sa lecture.

Règle générale : aucune erreur de configuration ne doit produire un crash, une note bloquée, un contrôle d'un autre nœud ou une valeur non finie dans le moteur audio.

---

## 15. Critères d'acceptation fonctionnels

Le chantier ne peut être déclaré terminé que si les scénarios suivants passent sur le runtime normal de MiniHub.

### A. Autorité du graphe

1. Ajouter manuellement une Matrix.
2. La connecter à Sequencer et à un nœud VST A, mais pas au VST B.
3. Déclencher une scène.
4. Vérifier que Sequencer et VST A réagissent.
5. Vérifier que VST B ne reçoit strictement aucune commande.
6. Retirer le câble du VST A et vérifier que toute commande future vers lui cesse.

### B. Commandes Sequencer

Une scène doit pouvoir jouer, arrêter, remettre au début et redémarrer l'arrangement sans créer de seconde horloge, sans boucle involontaire et sans perte des contrôles Play/Stop existants.

### C. VST Learn et persistance

1. Armer Matrix Learn sur une ligne `Release`.
2. Bouger Release dans l'éditeur du VST.
3. Vérifier l'identité exacte du paramètre capturé.
4. Sauvegarder puis recharger le projet.
5. Vérifier que le mapping pilote le même paramètre.
6. Retirer le plugin et vérifier que la ligne devient `Unresolved` sans remapping automatique.

### D. Automation synchronisée

Une scène de 8 mesures doit simultanément :

- redémarrer le Sequencer ;
- faire un Fade In du VST A sur 8 mesures ;
- faire évoluer Release de 20 % à 80 % ;
- modifier Decay aléatoirement entre 30 % et 50 % toutes les 2 mesures.

La fin du fade et de la rampe doit rester sur la bonne position musicale même si le BPM change en cours de scène.

### E. Autopilot déterministe

Avec les scènes INTRO, BUILD, BREAK et MAIN, une seed fixe doit produire deux fois la même suite de scènes et les mêmes valeurs aléatoires après Restart. Une autre seed doit pouvoir produire une variation conforme aux règles.

### F. Stop et sécurité

Stop pendant une automation doit :

- annuler les événements futurs ;
- arrêter les Sequencers démarrés par la Matrix ;
- envoyer le panic nécessaire ;
- ne laisser aucune note bloquée ;
- conserver les valeurs courantes sans saut non demandé.

### G. Sauvegarde et chargement

Après sauvegarde et rechargement, toute la configuration est restaurée, mais la Matrix est arrêtée et aucune scène ne démarre seule.

### H. Export

Deux exports offline du même instantané avec la même seed doivent utiliser la même suite de scènes et les mêmes automations. L'export ne doit ni bloquer ni détourner le Transport live.

### I. Morpher legacy

Un ancien projet contenant un Morpher doit s'ouvrir, conserver son routage audio et ne recevoir aucune Matrix automatique. Un nouveau projet ne doit plus proposer de Morpher.

---

## 16. Critères d'acceptation techniques

- Tous les tests JS existants restent au vert — **586** au 2026-09-03, pas 553 :
  ce chiffre est périmé dans `AGENTS.md`, `ARCHITECTURE.md` et `ROADMAP.md`.
- Tous les tests natifs existants restent au vert.
- Des tests ciblés couvrent modèle de scènes, validation, seed, transitions, persistance, références orphelines et connexions.
- Des tests natifs couvrent scheduling, Stop/Restart, remplacement de rampe, changement de BPM et déterminisme.
- Un test VST3 E2E vérifie au moins une vraie automation de paramètre et son absence sur un plugin non ciblé.
- Un test runtime vérifie le câblage réel dans le Patch Bay, la
  sauvegarde/recharge et le runtime packagé. **`[révisé 2026-09-03]`**
  `AGENTS.md` §8 exclut les harnais `runtime-*-gauntlet.mjs` de la définition de
  « fini ». Ce chantier fait **exception explicite** : un gauntlet Matrix est
  exigé à la phase 4, parce qu'aucun test unitaire ne peut prouver qu'un câble
  tiré à la souris gouverne réellement un plugin. Il vaut pour ce chantier et
  n'élargit pas la règle générale.
- Aucune régression de `chainBlocksSkipped` ou `pluginBlocksSkipped` n'est tolérée pendant une automation normale.
- Le protocole IPC reste versionné, en liste blanche et validé.
- Le renderer reste en ES modules, le main en CommonJS, sans bundler ajouté.
- La CSP reste respectée et aucune valeur externe n'est injectée sans échappement.
- `dist/MiniHub` est resynchronisé avec `src/` et le contrôle de provenance passe.

---

## 17. Découpage d'implémentation recommandé

### Phase 1 — Fondations

**`[révisé 2026-09-03]`** La phase 1 d'origine livrait le modèle de scènes
complet, sa persistance et sa validation **sans moteur d'exécution** : on
persistait donc un modèle de données qu'on n'avait jamais fait tourner. Elle est
resserrée autour d'une capacité prouvée de bout en bout, et gagne les deux
structures qu'il est trop tard d'ajouter ensuite.

- type de nœud `matrix` (`singleton`, `stableId: 'matrix'`, `deletable: true`,
  `copyable: false`) et sa famille dans le menu d'ajout ;
- port et connexions `control`, y compris le correctif `nodeInstances.js:289`
  qui rend un `ctrl-in` visible sur un nœud à entrées dynamiques (§4.3) ;
- contrat de capacités ;
- **le compteur de temps musical de la Matrix** (D-017) et sa forme
  **bi-contexte** (§9.1) — ces deux-là ne se rajoutent pas après coup ;
- **une seule** capacité de bout en bout : Sequencer `Play` / `Stop`, câblée,
  persistée, rechargée, prouvée dans le runtime ;
- persistance dans le `content` du nœud, et validation au chargement ;
- interface minimale.

Le modèle de scènes complet arrive avec le runtime qui l'exerce, en phase 2.

### Phase 2 — Contrôle audio et VST

- gain post-chaîne des VST ;
- fades natifs ;
- découverte des paramètres ;
- Matrix Learn ;
- Set et Ramp ;
- contrôles Mixer et Arpégiateur.

### Phase 3 — Moteur génératif

- règles de transitions ;
- Random Range et Random Step ;
- seed reproductible ;
- Autopilot ;
- Run, Stop, Restart et Next Scene complets.

### Phase 4 — Export et gauntlet final

- snapshot Matrix pour l'export offline ;
- transport privé d'export ;
- tests live/export déterministes ;
- compatibilité Morpher legacy ;
- runtime packagé et provenance.

Chaque phase doit rester testable et ne doit pas casser les invariants de l'architecture actuelle.

---

## 18. Hors périmètre de ce chantier

Ne font pas partie de cette demande :

- génération musicale par service IA ou appel réseau ;
- analyse automatique du contenu audio ;
- composition automatique de nouvelles notes MIDI par modèle génératif ;
- langage de script arbitraire exécuté dans les projets ;
- détection sémantique garantie d'un bouton `Release` à partir de son nom ;
- Recorder et Preset Machine ;
- suppression définitive du code Morpher legacy ;
- refonte générale du Patch Bay, du Sequencer ou de l'interface MiniHub.

La Matrix orchestre des nœuds, clips, patterns et paramètres préconfigurés. Elle constitue la base de la génération musicale automatique de MiniHub, mais ne doit pas devenir un moteur d'IA ni une seconde DAW indépendante à l'intérieur de l'application.

---

## 19. Consignes d'intervention dans le dépôt

Avant de modifier le code :

1. lire `AGENTS.md`, puis les sections pertinentes de `INTENT.md` (dont le
   **§8 bis**, qui porte la levée du refus et ses limites), `DECISIONS.md`
   (**D-016**, **D-017**, **D-018**), `ROADMAP.md` et `ARCHITECTURE.md` ;
2. vérifier les noms et contrats réels dans le code au lieu de se fier uniquement à cette spécification ;
3. produire un plan de fichiers et de tests par phase ;
4. signaler toute contradiction réelle avec l'architecture avant d'inventer un contournement.

Pendant l'implémentation :

- préserver tous les invariants listés dans `ARCHITECTURE.md` ;
- faire évoluer les listes blanches, validateurs et versions de format explicitement ;
- ne pas détourner le système Learn du MiniLab ;
- ne pas utiliser l'état visuel du Patch Bay comme état fonctionnel ;
- ne pas masquer une fonctionnalité manquante derrière une simulation uniquement UI ;
- ne déclarer une phase terminée qu'après tests source, natifs et runtime pertinents.

Le rapport final doit lister : fichiers modifiés, décisions techniques, migrations, tests réellement exécutés, résultats, limites restantes et procédure de test utilisateur.
