# MiniHub — Rapport d’isolation audio inter-pistes

Date : 24 août 2026  
Statut : preuves DSP automatisées conformes ; validation auditive sur la machine utilisateur encore requise. Ce document ne constitue pas un « FINAL PASS ».

## Résumé

Le scénario signalé a été reconstruit avec deux pistes, deux chemins DSP et deux instances VST réellement indépendants : Track 2 joue de 0 à 7 s ; Track 1 reste silencieuse pendant 3 s, joue de 3 à 5 s, puis s’arrête pendant que Track 2 continue jusqu’à 7 s. Les mesures sont prises avant, pendant et après Track 1.

Aucune baisse ni mutation du stem Track 2 n’a été reproduite dans Engine 2. Pour les sources déterministes, la référence `R` (Track 2 avec Track 1 inactive) et `R2` (Track 2 avec Track 1 active au milieu du rendu) sont identiques sample par sample, avec une différence maximale de `0`, donc strictement sous `1e-6`. Le premier buffer qui diffère est la sortie du Mixer, où Track 1 est ajoutée comme prévu ; la composante 880 Hz de Track 2 y reste inchangée.

La cause du défaut audible observé par l’utilisateur n’est donc pas localisée dans les buffers DSP testés. L’inventer ou modifier PortAudio/WASAPI sans preuve aurait violé le périmètre demandé. La cause racine établie ici est celle de l’insuffisance du gauntlet précédent : il validait le Master/la somme, pas le stem isolé de Track 2.

## Reproduction exacte et probes

Calendrier commun à tous les nouveaux cas :

- 0–3 s : Track 2 seule ;
- 3–5 s : Track 1 + Track 2 ;
- 5–7 s : Track 2 seule après l’arrêt de Track 1 ;
- 48 kHz, blocs de 480 échantillons ;
- Track 1 : gain `0.7` ; Track 2 : gain `0.8` ;
- référence rendue avec le même Track 2 mais Track 1 hors de la fenêtre.

Les probes couvrent `source Track 2 → sortie VST 2 → post Track Gain → entrée Mixer Track 2 → sortie Mixer → Audio Output → Master`. Les fenêtres spectrales déterministes sont prises à 1–1,5 s, 3,75–4,25 s et 6–6,5 s.

| Étage, test sine sans VST | Avant | Pendant | Après | Différence R/R2 |
|---|---:|---:|---:|---:|
| Source Track 2, composante 880 Hz | 0.25 | 0.25 | 0.25 | 0 |
| Sortie VST 2 | sans objet | sans objet | sans objet | sans objet |
| Post Track Gain 2 | 0.20 | 0.20 | 0.20 | 0 |
| Entrée Mixer Track 2 | 0.20 | 0.20 | 0.20 | 0 |
| Sortie Mixer, composante 880 Hz | 0.20 | 0.20 | 0.20 | 0 |
| Master, composante 880 Hz | 0.20 | 0.20 | 0.20 | 0 |
| Master, composante 440 Hz Track 1, PDC ON | `1.20e-17` | 0.14 | `1.72e-15` | changement attendu |
| Master, composante 440 Hz Track 1, PDC OFF | `4.08e-17` | 0.14 | `1.68e-15` | changement attendu |

La différence maximale du buffer Mixer/Master entre le rendu de référence et le rendu avec Track 1 vaut `0.14`, exactement l’ajout attendu de Track 1. Il n’y a aucun étage où le niveau propre de Track 2 change.

## Test automatisé `crossTrackLevelIsolation`

Le test est enregistré dans CTest sous le nom exact `crossTrackLevelIsolation` et s’exécute avec `mlh_native_tests --cross-track-isolation`. Il impose :

- `R == R2` sample par sample aux probes source Track 2, post-gain et entrée Mixer pour les sources déterministes ;
- amplitude 880 Hz invariante avant/pendant/après ;
- apparition puis disparition de 440 Hz ;
- changement effectif du Mixer/Master ;
- adresses source, post-gain et entrée Mixer distinctes entre Track 1 et Track 2 ;
- identité `trackId`, gain et destination de Track 2 stables ;
- variantes PDC ON et PDC OFF ;
- audio/audio, VST déterministe, Dexed/Dexed, Dexed/Vital et Vital/Vital.

Résultats finaux :

- `ctest -C Release -R crossTrackLevelIsolation --output-on-failure` : 1/1 test réussi ;
- `MLH_RUN_COMMERCIAL_ISOLATION=1 mlh_native_tests --cross-track-isolation` : 52/52 contrôles réussis ;
- suite native core : 1307 contrôles réussis ;
- suite VST3 end-to-end : 61 contrôles réussis ;
- suite JavaScript : 540 tests réussis, 0 échec.

## Test interne 440/880 sans VST

Deux nœuds sine de diagnostic, non exposés à l’IPC ni aux projets utilisateur, alimentent deux chemins indépendants. Track 1 émet 440 Hz à `0.20`, puis son gain `0.7` produit `0.14`. Track 2 émet 880 Hz à `0.25`, puis son gain `0.8` produit `0.20`.

PDC ON et OFF donnent les mêmes résultats :

- `sourceDiff = 0` ;
- `postGainDiff = 0` ;
- `mixerInputDiff = 0` ;
- amplitude 880 Hz = `0.20 / 0.20 / 0.20` ;
- amplitude 440 Hz au Master ≈ `0 / 0.14 / 0` ;
- `mixerDiff = 0.14`, car le Master change réellement.

## Test audio/audio

Deux WAV déterministes sont lus sans MIDI ni VST : Track 2, 880 Hz continu pendant 7 s ; Track 1, 440 Hz de 3 à 5 s.

- différence maximale du stem Track 2 entre `R` et `R2` : `0` ;
- amplitude Track 2 avant/pendant/après : `0.20 / 0.20 / 0.20` ;
- peaks de la sortie Mixer avant/pendant/après : `0.20 / 0.332025 / 0.20`.

Track 2 ne baisse pas lorsque le clip audio Track 1 démarre.

## VST distincts

Chaque variante utilise quatre objets pour éliminer toute ambiguïté : deux instances actives, Track 1 et Track 2, plus deux instances du rendu de référence. Les pointeurs `PluginInstance`, buffers de sortie et entrées Mixer sont distincts. Le VST déterministe donne l’égalité sample par sample ; Dexed et Vital sont évalués en niveau RMS, car deux instances Vital démarrent avec des phases d’oscillateur différentes.

| Variante | Track 2 RMS avant / pendant / après | Référence | Ratio actif/référence | Track 1 RMS | Mixer RMS |
|---|---|---|---|---|---|
| VST déterministe / déterministe | `0.537401 / 0.537401 / 0.537401` | identique sample par sample | `1 / 1 / 1` | `0 / 0.470226 / 0` | `0.537401 / 0.714082 / 0.537401` |
| Dexed / Dexed | `0.0476483 / 0.0476483 / 0.0476483` | mêmes RMS | `1 / 1 / 1` | `0 / 0.0270232 / 0` | `0.0476483 / 0.0608065 / 0.0476483` |
| Dexed / Vital | `0.114395 / 0.114395 / 0.114395` | mêmes RMS | `1 / 1 / 1`, spread `7.57e-10` | `0 / 0.0270232 / 0` | `0.114395 / 0.122896 / 0.114395` |
| Vital / Vital | `0.114395 / 0.114395 / 0.114395` | mêmes RMS | `1 / 1 / 1`, spread `2.43e-9` | `0 / 0.100656 / 0` | `0.114395 / 0.131791 / 0.114395` |

Probes supplémentaires de Track 2 :

- déterministe : peak brut VST `0.95 / 0.95 / 0.95`, post-gain `0.76 / 0.76 / 0.76`, différence stem/entrée Mixer `0 / 0` ;
- Dexed/Dexed : peak brut `0.133354 / 0.133354 / 0.133354`, post-gain `0.0440795 / 0.0440795 / 0.0440795` ;
- Dexed/Vital : peak brut `0.349885 / 0.349591 / 0.349641`, post-gain `0.279673 / 0.279614 / 0.279713` ;
- Vital/Vital : peak brut `0.350122 / 0.350006 / 0.349990`, post-gain `0.280005 / 0.279993 / 0.279966`.

Les faibles variations de peak bloc par bloc de Vital ne coïncident pas avec l’activation de Track 1 et le RMS de fenêtre reste invariant. Le contrôle commercial porte sur le niveau, tandis que la preuve sample par sample est fournie par les sources et le VST déterministes.

## Audit buffers et aliasing

Exemple d’adresses du rendu final :

| Mode | Piste | Source | Scratch PDC | Post-gain | Entrée Mixer |
|---|---|---|---|---|---|
| PDC ON | Track 1 | `0x1BE2A9867C0` | direct/null | `0x1BE2A9886E0` | `0x1BE2A9886E0` |
| PDC ON | Track 2 | `0x1BE2A980370` | `0x1BE2A985830` | `0x1BE2A982210` | `0x1BE2A985830` |
| PDC OFF | Track 1 | `0x1BE2A999640` | direct/null | `0x1BE2A99B560` | `0x1BE2A99B560` |
| PDC OFF | Track 2 | `0x1BE2A996790` | direct/null | `0x1BE2A995800` | `0x1BE2A995800` |

Avec PDC OFF, une entrée Mixer peut légitimement référencer le buffer post-gain de sa propre piste ; elle ne référence jamais celui de l’autre piste. Avec PDC ON, le retard de Track 2 utilise son scratch dédié. Aucun alias inter-pistes, `clear()` croisé, destination commune, move/swap prématuré ou invalidation de référence n’a été observé. Les buffers scratch VST appartiennent à chaque `PluginInstance`, et les tests confirment des instances et stockages distincts.

## Audit Mixer, gains et identités

Le Mixer efface uniquement sa propre sortie au début du nœud, puis exécute pour chaque entrée non mutée un `output.addFrom(..., level * masterLevel)`. Son helper scalaire calcule `sum += value[i] * level[i]`, puis applique le master. Il n’existe ni division par le nombre d’entrées, ni moyenne, normalisation, remplacement ou reset entre deux sources.

Les contrôles de piste recherchent le runtime par `track.id == trackId`. Pour la piste MIDI, le gain est résolu par son `outputId` vers sa chaîne dédiée. Les traces autour des trois phases ont conservé :

- `trackId = track-2` ;
- `gainApplied = 0.8` ;
- `destinationBuffer = active-b:audio-in` ;
- une `TrackRuntime` propre à la piste et un `chainId` inchangé.

Aucune écriture du gain Track 1 dans Track 2 n’a été mesurée.

## PDC ON/OFF

La PDC n’a pas été supprimée. Le compilateur du graphe accepte seulement, à des fins de test, un drapeau `pdcEnabled` dont la valeur par défaut reste `true` en production.

- PDC ON : Track 1 possède une latence diagnostique de 32 samples ; Track 2 reçoit son retard compensatoire dans un buffer dédié ; différences Track 2 `0 / 0 / 0` aux trois probes isolées.
- PDC OFF : chemin direct sans delay line ; différences Track 2 `0 / 0 / 0`.

L’activation de Track 1 ne reconstruit pas le graphe dans ce rendu, ne remet pas à zéro un retard appartenant à Track 2 et ne change pas son gain.

## Premier étage différent, cause racine et correction

Premier étage différent : **sortie Mixer**, jamais le stem Track 2. La différence y est l’apparition attendue de Track 1 à 440 Hz ; le contenu 880 Hz reste à `0.20` jusque dans le Master.

Cause racine du défaut audible : **non établie dans Engine 2 par les mesures disponibles**. Tous les étages internes demandés préservent Track 2. Le seul défaut démontré était un défaut de couverture : le précédent gauntlet confondait validité du Master et invariance d’un stem.

Correction effectuée : ajout du test de régression `crossTrackLevelIsolation`, de sources sine internes réservées au banc, de captures de stems/adresses/identités/gains, d’une variante PDC OFF diagnostique et d’un gauntlet du runtime packagé. Aucune modification spéculative du Mixer, du gain DSP, de PortAudio, WASAPI, des codecs, de l’UI, du scanner ou du lifecycle VST n’a été faite.

## Limite du test runtime packagé

Le nouveau `MiniHub.exe` a été lancé avec Dexed et Vital et le gauntlet runtime a préparé les deux chaînes, le graphe et le séquenceur. Sur cette machine de validation, PortAudio a cependant signalé : `No default audio output could be opened: Pa_OpenStream: Invalid device`, avec `audioDeviceOpen=false`. Sans callback audio, le transport ne progresse pas ; cette tentative n’est donc pas comptée comme preuve audio runtime. Aucun processus MiniHub, moteur ou scanner n’est resté actif après nettoyage.

Cette limite explique le statut de livraison : les invariants du moteur natif sont couverts, mais l’écoute sur la machine où le défaut est réellement audible reste indispensable.

## Nouveau MiniHub.exe

- exécutable : `C:\Users\666di\Desktop\LM Studio\Minilab Hub\dist\MiniHub\MiniHub.exe` ;
- taille : `225580032` octets ;
- horodatage : `2026-08-24 20:06:30 +02:00` ;
- SHA-256 : `B4245464056214A762DC5BF119A65F8A40206C21F7BEA12BC40E1FD8FECFA3B4` ;
- moteur packagé : `resources\native\mlh-audio-engine.exe`, `5811712` octets ;
- SHA-256 moteur : `65F75907AC9539AE9706CEC600B2646E7917220BC62107191FC91ACC189E80F8` ;
- empreinte de provenance runtime combinée : `8d92c75b69f6dd82080b40c721b691da391bc6c9ca57dd244610ece5b1a4d99f`.

CROSS-TRACK ISOLATION — READY FOR USER TEST
