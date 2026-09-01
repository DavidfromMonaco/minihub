# MiniHub Engine 2 — Plan de test

Date : 2026-08-24  
Principe : un succès fonctionnel n'annule jamais un échec de ressources.

## 1. Environnement reproductible

```powershell
cd engine2-prototype
.\scripts\fetch-dependencies.ps1
.\scripts\build.ps1 -Configuration Release
.\scripts\build.ps1 -Configuration Release -Asan
.\scripts\run-validation.ps1
```

`fetch-dependencies.ps1` vérifie les hashes Git épinglés. `build.ps1` reconstruit
un environnement enfant sans doublon Windows `Path`/`PATH`, nécessaire à MSBuild
18. `run-validation.ps1` conserve stdout, stderr, durée et code de sortie de
chaque exécutable natif dans `engine2-prototype/artifacts/validation/`.

## 2. Matrice

| Suite | Charge | Condition de réussite |
|---|---:|---|
| Core Release | 10 exports + 100 transports | PCM exact, somme exacte, MIDI exact, boucle, PDC, 0 stream offline |
| Core ASan | même charge | mêmes résultats et aucun diagnostic ASan |
| Load/unload réel | 100 cycles Dexed+Vital après warm-up | 100/100, son sur les 2 pistes, mémoire en plateau, aucun handle résiduel |
| Transport réel | 100 cycles sans unload | 100/100, son sur les 2 pistes, mémoire/handles plats, aucun résidu après unload |
| Déterminisme plugins | 10 exports Dexed puis 10 Vital | exécution complète ; exactitude caractérisée séparément |
| Export réel offline | 96 000 frames | audio non silencieux et 0 stream PortAudio |
| Realtime/offline déterministe | 96 000 frames par chemin | taille et PCM strictement identiques |
| Realtime/offline VST | 96 000 frames par chemin | taille égale, onset <= 256 samples, niveaux comparables |
| Session unique | deuxième `PortAudioDevice` | ouverture refusée pendant que le premier possède la session |
| Isolation ressource | 20 cycles 2x Dexed, puis 2x Vital | attribuer la croissance au chemin reproductible |

## 3. Séquences détaillées

### Core déterministe

Deux synthés sinusoïdaux déterministes reçoivent des séquences sample-based. Dix
graphes frais rendent 96 000 frames. Les tableaux float32 sont comparés sample
par sample et écrits en WAV. Trois rendus supplémentaires prouvent pour chaque
sample `both == track1_only + track2_only`.

Un note-on placé à l'offset 17 doit modifier l'état exactement à 17 ; le premier
sample sinusoïdal non nul attendu est 18 parce que la phase initiale vaut zéro.

Le transport effectue 100 fois Play/Stop/Seek/Play/Stop sans reconstruire le
graphe. Une boucle `[32,100)` traitée depuis 90 sur 32 samples doit terminer à 54.

### PDC

Track A annonce et produit une latence de 0. Track B annonce et produit un délai
de 127 samples. Le graphe doit appliquer 127 samples à A et zéro à B ; deux
impulsions de 0,25 doivent se sommer en une seule impulsion master de 0,5 à 127.
Tous les autres samples doivent être strictement nuls.

### Création/destruction réelle

Un warm-up non compté charge, joue et détruit Dexed/Vital. Chacun des 100 cycles
mesurés :

1. crée les deux `PluginInstance` ;
2. initialize/setup/activate/start ;
3. Play et traite les deux simultanément ;
4. Stop ;
5. Go to Start, Play, traite ;
6. Stop ;
7. stopProcessing/deactivate/terminate/détruit ;
8. relève private bytes et handles tous les 10 cycles.

La mémoire des quatre derniers relevés doit tenir dans une bande de 16 MiB et le
nombre de handles final ne doit pas dépasser le niveau après warm-up. Le test
continue toujours jusqu'au cycle 100 si le traitement reste possible.

### Transport sans unload

Un seul graphe Dexed+Vital reste chargé pendant 100 cycles
Play/Stop/Seek/Play/Stop. Les private bytes et handles sont relevés tous les dix
cycles. Le graphe est détruit seulement après le centième cycle, puis les
ressources résiduelles sont comparées au démarrage du processus.

### Déterminisme réel

Dexed et Vital sont testés séparément avec dix instances fraîches. Une différence
n'invalide pas automatiquement le core : elle doit être rapportée comme état ou
randomness plugin tant que le contrôle déterministe reste exact. Une absence de
son, un crash ou une création incomplète reste un FAIL.

### WASAPI et comparaison

Le monitoring capture en RAM exactement 96 000 frames produites par le callback,
puis écrit le WAV après fermeture du stream. L'offline rend le même nombre de
frames en appelant directement `AudioGraph::processBlock`. La suite déterministe
demande l'égalité exacte ; la suite VST compare longueur, onset, peak et RMS car
les modes VST `kRealtime`/`kOffline` et états frais peuvent diverger.

## 4. Diagnostics mémoire et codes natifs

La configuration MSVC AddressSanitizer applique `/fsanitize=address` au moteur,
aux helpers SDK et à PortAudio. Elle détecte notamment heap overflow,
use-after-free instrumentable, double/invalid free et accès hors limites. MSVC
Windows ne fournit pas LeakSanitizer ; les fuites progressives sont donc évaluées
avec `PrivateUsage` et `GetProcessHandleCount`.

`HeapEnableTerminationOnCorruption` est activé. Les sorties natives
`0xC0000374` (heap corruption) et `0xC0000005` (access violation) sont annotées
comme crash dans le résumé et constituent toujours un FAIL.

Codes propres du prototype :

- `0` : suite réussie ;
- `2` : core ;
- `3` : load/unload VST ;
- `4` : transport VST ;
- `5` : caractérisation déterminisme plugin ;
- `6` : export offline réel ;
- `7` : WASAPI/comparaison ;
- `10/11` : exception native interceptée.

## 5. Règle de verdict

Le verdict global est PASS uniquement si chaque ligne requise est PASS, stderr
ASan est vide, aucun crash code n'apparaît et les compteurs de ressources ne
progressent pas. Tout résultat partiel donne un verdict global FAIL et interdit
le branchement à MiniHub.

