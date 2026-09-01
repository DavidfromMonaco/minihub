# MINIHub — Faisabilité de Tracktion Engine

Date de vérification : 24 août 2026  
Périmètre : recherche officielle et prototype Windows isolé ; aucune modification du moteur MiniHub existant.

## Conclusion

Tracktion Engine couvre bien, sur le papier et dans son API, les briques DAW recherchées : pistes et clips, MIDI, VST3, graphe audio, transport, tempo, effets, compensation de latence et rendu offline. Il existe aussi une voie commerciale réaliste pour distribuer un MiniHub propriétaire, mais elle impose **deux licences distinctes**, Tracktion Engine et JUCE.

La faisabilité fonctionnelle générale est donc bonne, mais la révision testée n'est pas validable pour une migration : le prototype a révélé un défaut amont dans la sélection des pistes à rendre, des exports VST non reproductibles entre passes et une corruption mémoire/violation d'accès pendant le scénario de stabilité. Le verdict d'adoption immédiate est **FAIL**.

## Versions vérifiées

| Élément | Situation au 24 août 2026 | Version réellement testée |
|---|---|---|
| Tracktion Engine, dernière release GitHub | `v3.2.0` marquée Latest | — |
| Tracktion Engine, branche `develop` | `VERSION.md` = `3.5.0` | `3.5.0`, commit `494e91d2ff546353b69723a5e992dd71d1a0204b` du 3 août 2026 |
| Chaîne retournée par `Engine::getVersion()` | incohérente avec `VERSION.md` | `Tracktion Engine v3.1.0` |
| JUCE, dernière release officielle | `9.0.1` | — |
| JUCE épinglé par Tracktion `develop` | branche JUCE 8 | `JUCE v8.0.13`, commit `37c894f83d379179b2070d437ccd0f1cd9af9576` (`8.0.13-7-g37c894f83d`) |

Sources officielles : [VERSION.md de Tracktion](https://raw.githubusercontent.com/Tracktion/tracktion_engine/develop/VERSION.md), [releases Tracktion](https://github.com/Tracktion/tracktion_engine/releases), [releases JUCE](https://github.com/juce-framework/JUCE/releases), [README Tracktion](https://github.com/Tracktion/tracktion_engine/blob/develop/README.md).

La version « actuelle » doit donc être qualifiée : `3.2.0` est la dernière release publiée, tandis que `3.5.0` est la version déclarée par la branche de développement officielle. Le prototype a choisi `develop` pour évaluer l'état le plus récent, en enregistrant les deux commits exacts pour rendre le résultat reproductible.

## Matrice de capacités

| Besoin MiniHub | Vérification officielle | Appréciation |
|---|---|---|
| Windows | Windows figure parmi les plateformes supportées. Le projet exige C++20. | Supporté |
| Compatibilité JUCE | Tracktion est livré comme module JUCE et embarque JUCE en sous-module. | Supporté ; version à épingler strictement |
| Hébergement VST3 | Les formats de plugins externes supportés par JUCE sont exposés par Tracktion. JUCE fournit le host VST3. | Supporté et chargé dans le prototype |
| Routage MIDI/audio | Entrées/sorties MIDI, MIDI clips, racks, patch bay, aux et sous-mix sont annoncés. | Supporté |
| Pistes et clips | Pistes audio, pistes dossier/sous-mix, clips audio, MIDI et step clips. | Supporté |
| Transport et tempo | Transport complet, scrubbing, tempo, signatures et changements de tempo. | Supporté ; Play/Stop/retour/tempo validés avant le crash de stabilité |
| Compensation de latence | « Perfect plugin delay compensation » dans la liste officielle. | Supporté par l'API ; activé dans le prototype, pas mesuré avec une impulsion dédiée |
| FX | Effets internes, plugins externes, racks et automation. | Supporté |
| Rendu/export offline | Rendu en arrière-plan d'un Edit et rendu de pistes/clips/notes spécifiques. | Supporté en principe ; réserves critiques observées sur les VST testés |
| Périphérique/session audio unique | JUCE recommande une instance globale d'`AudioDeviceManager`, qui gère un périphérique actif. | Architecture adaptée ; une seule session Core Audio active mesurée |

La [liste officielle des fonctionnalités](https://github.com/Tracktion/tracktion_engine/blob/develop/FEATURES.md) documente notamment le transport, la PDC, le MIDI, les pistes, les plugins/FX et le rendu sélectif. La [page produit Tracktion](https://www.tracktion.com/develop/tracktion-engine) décrit le modèle `Engine` → `Edit` → audio/MIDI/plugins → playback ou render. La [documentation JUCE d'AudioDeviceManager](https://docs.juce.com/master/classjuce_1_1AudioDeviceManager.html) préconise une instance globale et un seul périphérique audio sélectionné.

## Gestion audio Windows proposée

Le modèle approprié pour MiniHub est :

1. un seul processus natif audio supervisé par Electron ;
2. une seule instance `tracktion::engine::Engine` ;
3. son unique `DeviceManager`/`juce::AudioDeviceManager` ;
4. un `Edit` de session persistant ;
5. toutes les pistes et tous les VST sommés dans ce graphe avant la sortie matérielle.

Le prototype compile uniquement WASAPI et sélectionne le type JUCE `Windows Audio`, c'est-à-dire le chemin partagé. ASIO, DirectSound et le type `Windows Audio (Exclusive Mode)` sont désactivés dans cette cible. La sonde Core Audio externe a trouvé exactement une session active pour le processus, malgré les deux VST en lecture.

Attention au cycle de fermeture : dans la révision testée, `tracktion::engine::DeviceManager::closeDevices()` retire les périphériques logiques/callbacks mais ne ferme pas à lui seul l'objet audio courant de JUCE. Le prototype doit appeler également `juce::AudioDeviceManager::closeAudioDevice()`. Même avec cette séquence, le test trois cycles reste instable.

## Licences

### Tracktion Engine

Le fichier de licence officiel publie Tracktion Engine sous double licence **GPLv3 ou ultérieure / commerciale** : [LICENSE.md](https://github.com/Tracktion/tracktion_engine/blob/develop/LICENSE.md).

Les conditions commerciales affichées le 24 août 2026 sont résumées ci-dessous. Les montants sont par développeur et hors taxes ; les seuils portent sur le revenu ou financement brut global selon l'accord.

| Offre | Prix affiché | Plafond revenu/financement | Engagement | Branding |
|---|---:|---:|---:|---|
| Personal | gratuit, 1 siège | 50 k$ | aucun | « Powered by Tracktion Engine » |
| Indie | 35 $/mois/développeur | 200 k$ | 12 mois | requis |
| Pro 1 | 50 $/mois/développeur | 400 k$ | 12 mois | optionnel |
| Pro 2 | 150 $/mois/développeur | 2 M$ | 12 mois | optionnel |
| Pro 3 | 300 $/mois/développeur | 10 M$ | 12 mois | optionnel |
| Enterprise | sur devis | aucun | conditions spécifiques | optionnel |

Source contractuelle actuelle : [Tracktion Engine EULA](https://engine.tracktion.com/agreement). Le README officiel précise également que Tracktion Engine et JUCE sont deux produits juridiquement séparés et qu'une licence de l'un ne couvre pas l'autre.

### JUCE

Le JUCE épinglé et compilé par le prototype est JUCE 8. Son `LICENSE.md` le place sous double licence **AGPLv3 / commerciale JUCE 8**. L'[EULA JUCE 8](https://juce.com/legal/juce-8-licence/) affiche :

| Offre JUCE 8 | Prix affiché | Plafond revenu/financement | Engagement abonnement |
|---|---:|---:|---:|
| Starter | gratuit | 20 k$ | — |
| Indie | 40 $/mois/utilisateur ou 800 $ perpétuel | 300 k$ | 1 mois |
| Pro | 175 $/mois/utilisateur ou 3 500 $ perpétuel | aucun | 12 mois |

Chaque personne qui contribue à du code directement ou transitivement dépendant de JUCE doit disposer du siège approprié. Les conditions d'abonnement comprennent aussi des obligations de continuité pour continuer à développer et distribuer le produit ; une licence perpétuelle évite ce point pour la version majeure achetée.

JUCE 9.0.1 est désormais la version publique la plus récente, avec une [EULA JUCE 9](https://juce.com/legal/juce-9-licence/) aux mêmes montants affichés. Elle ne remplace pas automatiquement la licence JUCE 8 applicable au commit réellement compilé.

### Implications pour MiniHub

- La voie open source est juridiquement possible : GPLv3 autorise la combinaison avec AGPLv3, mais les obligations AGPL s'appliquent alors à la combinaison. Voir la [FAQ GNU officielle](https://www.gnu.org/licenses/gpl-faq#AllCompatibility) et la [section 13 de GPLv3](https://www.gnu.org/licenses/gpl-3.0.html#section13).
- Pour un MiniHub distribué comme produit propriétaire, la voie réaliste est **commerciale pour Tracktion Engine et commerciale pour JUCE**, simultanément.
- La licence MIT déclarée actuellement dans `package.json` ne suffit pas à redistribuer un binaire lié à Tracktion/JUCE sous la voie open source sans publier le code source correspondant et respecter l'ensemble des obligations GPL/AGPL.
- Les seuils commerciaux se basent sur les revenus/financements de l'entité, pas uniquement les ventes MiniHub.
- Il faut obtenir par écrit de Tracktion et de JUCE la confirmation du niveau, des sièges, du branding, de la redistribution desktop et des droits sur la version majeure avant toute migration.

Cette section est une analyse technique des textes publiés, pas un avis juridique.

## Risques techniques constatés dans la révision 3.5.0 `develop`

1. `toBitSet(const juce::Array<Track*>&)` active tous les bits de toutes les pistes au lieu de respecter le tableau reçu. Un rendu demandé pour une piste contient donc toutes les pistes si ce helper est utilisé. [Code amont exact au commit testé](https://github.com/Tracktion/tracktion_engine/blob/494e91d2ff546353b69723a5e992dd71d1a0204b/modules/tracktion_engine/model/edit/tracktion_EditUtilities.cpp#L250-L264).
2. `Engine::getVersion()` retourne encore `v3.1.0` alors que `VERSION.md` et l'en-tête du module annoncent `3.5.0`. [Code amont](https://github.com/Tracktion/tracktion_engine/blob/494e91d2ff546353b69723a5e992dd71d1a0204b/modules/tracktion_engine/utilities/tracktion_Engine.cpp#L141-L144).
3. Les passes offline successives de Dexed et Vital ne repartent pas du même état DSP ; le master répété n'est pas identique au premier rendu.
4. Le processus termine par `0xC0000374` (corruption du tas) ou `0xC0000005` (violation d'accès), selon l'exécution, pendant le troisième cycle ou le teardown final.

Le premier défaut peut être contourné en construisant directement `Renderer::Parameters::tracksToDo`, ce que fait le prototype. Les trois autres empêchent de qualifier cette révision comme remplacement sûr du moteur actuel.

## Décision de faisabilité

| Axe | Verdict |
|---|---|
| Couverture fonctionnelle DAW | PASS documentaire |
| Windows et session audio unique | PASS prototype |
| Sommation linéaire sans cache-misère | PASS prototype |
| Transport | PASS avant teardown |
| Export de master et stems | PARTIEL : fichiers produits, helper amont défectueux contourné |
| Déterminisme des VST testés | FAIL |
| Stabilité multi-cycle et fermeture | FAIL |
| Voie de licence | PASS conditionnel à deux licences commerciales et validation juridique |

**Verdict global : FAIL pour une migration MiniHub maintenant.**

La recommandation est de conserver le moteur actuel. Une nouvelle évaluation ne serait justifiée qu'avec une release Tracktion stable contenant un correctif du masque de pistes, une réponse du support sur le cycle de vie des VST/renders et un gauntlet ASan de longue durée sans crash.

## Sources officielles principales

- [Tracktion Engine README](https://github.com/Tracktion/tracktion_engine/blob/develop/README.md)
- [Tracktion Engine FEATURES](https://github.com/Tracktion/tracktion_engine/blob/develop/FEATURES.md)
- [Tracktion Engine VERSION](https://github.com/Tracktion/tracktion_engine/blob/develop/VERSION.md)
- [Tracktion Engine releases](https://github.com/Tracktion/tracktion_engine/releases)
- [Tracktion Engine licence](https://github.com/Tracktion/tracktion_engine/blob/develop/LICENSE.md)
- [Tracktion Engine EULA et offres](https://engine.tracktion.com/agreement)
- [JUCE releases](https://github.com/juce-framework/JUCE/releases)
- [JUCE 8 EULA](https://juce.com/legal/juce-8-licence/)
- [JUCE 9 EULA](https://juce.com/legal/juce-9-licence/)
- [JUCE AudioDeviceManager](https://docs.juce.com/master/classjuce_1_1AudioDeviceManager.html)
- [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq)
