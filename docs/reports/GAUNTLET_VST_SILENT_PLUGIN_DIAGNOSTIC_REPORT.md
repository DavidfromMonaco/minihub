# GAUNTLET — Diagnostic des VST/VST3 muets dans MiniHub

Date du diagnostic : 23 août 2026  
Plateforme : Windows, runtime packagé `dist/MiniHub/MiniHub.exe`  
Périphérique audio utilisé : `Casque (High Definition Audio Device)`  
Configuration effective : 48 000 Hz, blocs matériels de 480 samples, traitement VST en simple précision

## Verdict exécutif

La divergence a été reproduite et sa cause racine a été identifiée avant toute correction : MiniHub construisait toujours un buffer stéréo pour chaque node VST, alors que certains VST3 gardaient tous leurs bus auxiliaires actifs. `Infinite Space Piano 2` exposait ainsi 16 bus de sortie stéréo, soit 32 canaux actifs, à un graphe qui ne lui fournissait que 2 canaux. Le mapper VST3 de JUCE tentait alors d'associer les 32 canaux déclarés au buffer de 2 canaux et sortait des limites au premier rendu.

La correction générique négocie maintenant un layout compatible avec le contrat stéréo de MiniHub avant `prepareToPlay()` : le bus principal accepté est conservé, les bus auxiliaires sont désactivés, le layout complet est vérifié puis appliqué, et un plugin incompatible est refusé explicitement. Aucun nom de plugin ni workaround spécifique n'a été ajouté.

Après correction, dans le vrai runtime MiniHub :

- `Infinite Space Piano 2` ouvre son UI, exécute `processBlock()`, produit du son depuis son clavier interne et depuis le MIDI entrant ;
- le niveau post-plugin atteint exactement le node de sortie MiniHub ;
- Dexed, le VST de référence, reste audible ;
- le Sequencer déclenche le VST corrigé ;
- le scan complet trouve 55 plugins sans crash ni blocage ;
- l'ouverture/fermeture d'UI, le chargement de projet et la suppression/réajout restent opérationnels.

Le verdict global du gauntlet reste néanmoins **FAIL**, uniquement parce qu'aucun MiniLab 3 physique n'était détecté par la machine de test (`No MiniLab 3 detected`). Le chemin MIDI logiciel réel a été validé jusqu'au VST, avec réaction visuelle et audio, mais l'étape USB/WebMIDI provenant du matériel ne peut pas être déclarée testée.

## Plugins comparés

### Référence fonctionnelle

- Nom : Dexed
- Format : VST3
- UID : `0xd7709eec`
- Entrées : 0 bus, 0 canal
- Sorties : 1 bus principal stéréo activé, 2 canaux au total
- Précision : simple
- Suspendu : non
- Bypass host : non
- Bypass processeur : non

### Plugin initialement muet / défaillant

- Nom : Infinite Space Piano 2
- Format : VST3
- UID : `0xe15a3733`
- Layout brut déclaré : 0 bus d'entrée ; 16 bus de sortie stéréo tous activés ; 32 canaux de sortie au total
- Bus principal : stéréo, activé
- Précision : simple
- Suspendu : non
- Bypass host : non
- Bypass processeur : non

`Halloween Sounds` a aussi été contrôlé comme second exemple multi-sorties : il expose le même contrat brut de 16 bus stéréo/32 sorties. Après correction, il est préparé en 0 entrée/2 sorties et reçoit les événements MIDI sans faire tomber le moteur.

## Reproduction comparative avant correction

Les deux plugins ont été instanciés dans le même exécutable MiniHub, avec le même périphérique, le même sample rate, le même bloc, le même node de sortie et la même injection MIDI.

| Check | Dexed — VST OK | Infinite Space Piano 2 — avant correction |
| --- | --- | --- |
| Instance créée | Oui | Oui |
| Format / UID | VST3 / `0xd7709eec` | VST3 / `0xe15a3733` |
| `prepareToPlay()` | Oui, 48 000 Hz / 480 | Oui, 48 000 Hz / 480 |
| Précision | Simple | Simple |
| Bus d'entrée | 0 | 0 |
| Bus de sortie | 1 stéréo activé | 16 stéréo activés |
| Canaux d'entrée / sortie | 0 / 2 | 0 / 32 |
| Suspendu | Non | Non |
| Bypass | Non | Non |
| Ajout à la chaîne active | Oui | Oui |
| `processBlock()` terminé | Oui | 0 appel terminé ; crash dans le premier appel |
| Compteur observé | 256 blocs sur le snapshot comparatif | 0 bloc terminé |
| MIDI transmis | Note On C4, canal 1, vélocité 100, position 0 | Non mesurable avant le crash du premier rendu |
| Peak avant traitement | 0 | 0 avant entrée dans le premier rendu |
| Peak après traitement | `0,12521736` | Non disponible : access violation |
| Peak au node de sortie | Signal présent et identique au post-plugin | Non disponible : moteur tombé |

À `16:34:40.606Z`, le moteur a quitté avec le code Windows `3221225477 (0xC0000005)`. La télémétrie immédiatement précédente montrait bien 16 bus de sortie actifs et 32 sorties, puis `prepareToPlay()`, l'ajout à la chaîne et le premier callback audio. Le compteur était incrémenté après le retour du plugin : sa valeur 0 signifie donc « aucun appel terminé », pas « le host n'a jamais tenté d'appeler le plugin ».

Cette reproduction ne correspond pas au cas A. Ce n'est pas non plus un simple problème MIDI : le défaut intervient avant qu'une note puisse être rendue et concerne le contrat audio. Il s'agit d'un contrat bus/buffer invalide, proche du cas B mais avec trop de canaux actifs plutôt que zéro canal. Le crash/restart automatique du moteur peut se présenter côté interface comme un plugin chargé mais muet.

## Cause racine

Le graphe MiniHub alloue volontairement deux canaux par node dans `AudioExecutionPlan::compile()` et transmet ce buffer à `Chain::processBlock()`. Avant correction, `PluginInstance::create()` ne ramenait pas le layout VST3 accepté à ce contrat. La phase de préparation conservait donc, pour les plugins concernés, 32 ou 64 canaux actifs.

Dans JUCE, `HostBufferMapper::getVst3LayoutForJuceBuffer()` parcourt chaque bus actif et `associateBufferTo()` appelle `AudioBuffer::getWritePointer(channelStartOffset + canalMappe)`. Avec 32 canaux actifs et un `AudioBuffer` de 2 canaux, l'index dépasse le buffer. L'access violation observée est la conséquence directe de ce désaccord.

Le précédent appel historique à `setPlayConfigDetails(2, 2, ...)` n'était pas une solution sûre : il demandait arbitrairement deux entrées à des instruments qui en déclarent zéro et ne permettait pas de vérifier qu'un layout complet avait réellement été accepté/appliqué.

Fichier et fonctions responsables :

- `native/audio-engine/src/plugin_host.cpp`
  - `PluginInstance::create()` : absence de négociation explicite avec le contrat du graphe ;
  - `PluginInstance::prepareToPlay()` : préparation du layout laissé actif par l'instance ;
- contrat consommateur : `native/audio-engine/src/audio_graph.cpp`, qui crée correctement un buffer stéréo pour le graphe stéréo MiniHub.

## Correction appliquée

La fonction `configureBusesForStereoGraph()` a été ajoutée et appelée immédiatement après l'instanciation, avant l'écoute des paramètres et avant `prepareToPlay()`.

Elle effectue les opérations suivantes :

1. lit le layout accepté par le plugin ;
2. conserve les layouts principaux déjà compatibles (zéro entrée pour un instrument, mono ou stéréo selon les capacités) ;
3. désactive tous les bus auxiliaires d'entrée et de sortie ;
4. si un bus principal dépasse deux canaux, demande d'abord la stéréo puis le mono uniquement si le plugin déclare ce fallback compatible ;
5. vérifie le layout complet avec `checkBusesLayoutSupported()` ;
6. applique le layout avec `setBusesLayout()` ;
7. vérifie que les totaux réellement appliqués ne dépassent pas deux entrées et deux sorties ;
8. renvoie une erreur contrôlée au lieu de lancer un plugin avec un contrat dangereux.

Pour `Infinite Space Piano 2`, le résultat appliqué est :

- bus sortie 0 : activé, stéréo, 2 canaux ;
- bus sortie 1 à 15 : désactivés, 0 canal ;
- total : 0 entrée, 2 sorties ;
- buffer réel : 2 canaux, 480 samples ;
- suspendu : non ; bypass : non.

Le contrôle du layout est accepté et appliqué avant activation. Une interrogation tardive de `checkBusesLayoutSupported()` pendant que certains VST3 sont actifs peut renvoyer faux dans JUCE ; ce retour tardif n'est pas utilisé comme preuve d'échec. Les résultats de `setBusesLayout()`, les bus réellement actifs et les totaux 0/2 sont les données autoritatives.

## Validation audio et MIDI après correction

### Clavier interne du plugin

L'éditeur natif d'`Infinite Space Piano 2` a été ouvert dans MiniHub et une touche de son clavier graphique a été maintenue, sans envoyer de MIDI depuis MiniHub.

- compteur `processBlock()` : 8 451 au premier snapshot non silencieux ;
- événements MIDI MiniHub cumulés : 0 ;
- peak avant : 0 ;
- peak après plugin : `0,041065648` ;
- peak au node de sortie MiniHub : `0,041065648` ;
- décroissance observée : `0,021951606`, `0,01563815`, `0,01666018`, puis extinction.

Cela démontre que le clavier interne ne dépendait pas du routing MIDI MiniHub et que, une fois le contrat audio corrigé, son signal traverse bien tout le graphe. Le cas C et le cas D sont écartés pour cette instance.

### MIDI entrant MiniHub vers le VST

Une Note On C4 a été envoyée par le chemin IPC réel du renderer/main vers le moteur, le node étant connecté au node de sortie.

- canal : 1 ;
- note : 60 ;
- vélocité : 100 ;
- sample position : 0 ;
- Note On reçue : oui ;
- Note Off reçue : oui ;
- contenu du `MidiBuffer` transmis à `processBlock()` : 1 événement Note On dans le bloc d'attaque, puis 1 Note Off dans le bloc de relâchement ;
- compteur au premier snapshot non silencieux : 11 473 blocs ;
- peak avant : 0 ;
- peak après plugin : `0,065719634` ;
- peak au node de sortie : `0,065719634`.

Le clavier visuel du plugin s'est coloré pendant la Note On, ce qui confirme également la réception côté plugin.

### Sequencer MiniHub vers le VST

Un clip MIDI natif a déclenché la note 60, canal 1, vélocité 93, durée 2 PPQ :

- Note On observée dans le `MidiBuffer`, position 0 ;
- Note Off observée ;
- compteur `processBlock()` au snapshot : 38 683 ;
- peak post-plugin : `0,048578233` ;
- moteur resté en état `running`.

Les événements All Notes Off/All Sound Off de panic expliquent la hausse du compteur MIDI total lors des changements de plan ; les compteurs Note On/Note Off et la dernière note permettent de distinguer la note musicale testée.

### Non-régression Dexed et sortie audio

Après correction, Dexed a produit :

- Note On canal 1, note 60, vélocité 100, position 0 ;
- premier snapshot : 7 blocs ;
- peak post-plugin : `0,097715162` ;
- peak node de sortie : `0,097715162`.

Après suppression puis réajout de l'instance Dexed :

- nouvelle génération runtime prête ;
- compteur : 99 blocs au snapshot ;
- peak post-plugin : `0,080462292` ;
- peak node de sortie : `0,080462292` ;
- aucun crash ni erreur.

## Cycle de vie, UI, projet et scan

- UI du VST multi-sorties dans le binaire final non instrumenté : ouverture confirmée à 1 000 × 681, fermeture confirmée, moteur toujours `running`.
- Projet réel chargé depuis l'écran Home : `Saves/Duo Nappe Arpeggios.minihub`.
- Deux instances Analog Lab V recréées ; leurs états sérialisés ont été relus (472 675 et 333 926 caractères), sans erreur moteur.
- Le test automatisé de round-trip disque/save-load du projet passe dans la suite JavaScript.
- Suppression/réajout d'une instance dans le runtime réel : états `chainChanged` vide, `loading`, puis `ready`, génération renouvelée, audio encore présent.
- Scan VST3 complet dans le runtime réel : 55 plugins en 26,055 s, passage `scanning=true` puis `false`, moteur `running`, aucune erreur, aucun hang.
- Smoke test final du binaire non instrumenté : moteur `running`, instance multi-sorties `ready`, UI ouverte/fermée, aucune erreur.

`Infinite Space Piano 2` charge ses samples en arrière-plan sans exposer cet état dans l'événement `ready`. Une note jouée immédiatement après création a pu rester silencieuse ; les tests sonores concluants ont été faits après chargement du contenu. Ce comportement de chargement appartient au plugin et ne remet pas en cause la négociation des bus, mais MiniHub ne peut actuellement pas afficher sa progression.

## Test de régression VST3 ajouté

Le VST3 déterministe utilisé par les tests déclare réellement 16 bus de sortie stéréo actifs, soit 32 sorties, et synthétise une sinusoïde à partir du MIDI.

Le test vérifie deux contrats :

1. instanciation JUCE directe avec un buffer correct de 32 canaux : création, préparation, Note On audible et Note Off silencieuse ;
2. instanciation par le host MiniHub : négociation vers 0 entrée/2 sorties, un seul bus de sortie actif, rendu live, Sequencer, Arpeggiator, Mixer, Audio Output et export WAV.

Ce test aurait reproduit le défaut de buffer et empêche le retour d'une configuration multi-sorties non négociée.

## Tests exécutés

| Test | Résultat |
| --- | --- |
| Runtime MiniHub packagé, comparaison Dexed / Infinite Space Piano 2 | Réussi |
| Runtime : clavier interne → VST → Audio Output | Réussi, peaks identiques plugin/sortie |
| Runtime : MIDI entrant → VST → Audio Output | Réussi, réaction visuelle et audio |
| Runtime : Sequencer → VST | Réussi |
| Runtime : ouverture/fermeture UI | Réussi |
| Runtime : chargement du projet sauvegardé | Réussi |
| Runtime : suppression/réajout | Réussi avec Dexed ; réinstanciation multi-sorties sans crash |
| Runtime : scan complet | Réussi, 55 plugins, 26,055 s |
| `npm test` | 499/499 réussis |
| `mlh_native_tests.exe --all` | 1 220 checks réussis |
| `mlh_native_tests.exe --vst3-e2e` | 35 checks réussis |
| Build Release final et `sync:dist` | Réussi |
| Hash moteur build vs distribution | Identique : `875E417FF1B16B40F407C5DBFE1938C72BD9386E41911868E16EB13E3E7D231C` |

Les seuls avertissements de compilation observés concernent l'API JUCE dépréciée `MidiBuffer::Iterator` dans `midi_graph.cpp`; ils sont antérieurs et sans rapport avec cette correction.

## Fichiers modifiés pour cette correction

- `native/audio-engine/src/plugin_host.cpp`
  - négociation générique et vérifiée des bus avant préparation ;
  - préparation sans forcer arbitrairement 2 entrées/2 sorties.
- `native/audio-engine/src/plugin_host.h`
  - accès de contrat minimal utilisé par le test natif.
- `native/audio-engine/test/deterministic_test_instrument.cpp`
  - instrument VST3 de régression à 16 bus stéréo/32 sorties.
- `native/audio-engine/test/native_tests.cpp`
  - reproduction directe du contrat 32 canaux et validation du contrat MiniHub 0/2.
- `dist/MiniHub/resources/native/mlh-audio-engine.exe`
  - binaire Release final synchronisé.

La télémétrie temporaire (`processBlock`, MIDI, peaks et dumps de bus) a été retirée du code de production après collecte. Le test de contrat multi-sorties reste permanent.

## Limites restantes

1. Aucun MiniLab 3 physique n'était connecté/détecté. La chaîne USB/WebMIDI réelle `MiniLab → renderer` n'a donc pas pu être exercée.
2. Le chemin situé après cette entrée a bien été exercé dans le runtime réel : commande MIDI versionnée, file temps réel, `MidiBuffer`, réaction visuelle du VST, audio post-plugin et node de sortie.
3. La progression de chargement des samples d'`Infinite Space Piano 2` n'est pas exposée par son API ; `ready` signifie que l'instance VST est prête, pas nécessairement que tout son contenu est immédiatement jouable.
4. Le fichier de projet utilisateur a été chargé mais n'a pas été réécrit pendant le test manuel afin d'éviter une modification non sollicitée ; le save/load disque est couvert par la suite automatisée.

## Verdict final

**FAIL** pour le gauntlet complet, car la validation obligatoire avec un MiniLab physique n'a pas pu être effectuée sur cette machine.

La correction logicielle du host est toutefois **validée dans le runtime MiniHub réel** : la cause racine est prouvée, le VST multi-sorties précédemment défaillant produit du son par son clavier interne, le MIDI entrant et le Sequencer, le signal atteint Audio Output sans perte, et les VST existants restent fonctionnels.

Pour transformer ce verdict en PASS, il reste un seul contrôle manuel : connecter le MiniLab 3, confirmer sa détection, jouer une Note On/Off sur `Infinite Space Piano 2`, vérifier la réaction du clavier visuel et entendre/mesurer le même signal en sortie.
