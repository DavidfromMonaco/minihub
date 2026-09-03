# INTENT.md — ce que MiniHub doit être, et ne pas devenir

Ce document ne décrit **pas** le code. Il décrit l'intention à laquelle le code
doit obéir, et surtout les directions dans lesquelles il ne doit pas partir.

Un agent lit ce fichier **avant** de proposer quoi que ce soit. Une proposition
techniquement bonne mais contraire à ce document est une mauvaise proposition.

Quand ce document et une idée séduisante s'opposent, c'est ce document qui gagne
— ou bien il est modifié explicitement, avec sa raison, et
[DECISIONS.md](DECISIONS.md) enregistre le changement une fois le code écrit.

---

## 1. En une phrase

MiniHub est un **bac à sable musical** bâti autour du contrôleur Arturia
MiniLab 3, où le câblage d'un Patch Bay — et non l'interface affichée — décide
de ce que l'on entend.

## 2. Pour qui

**Un utilisateur : son auteur.** Toutes les décisions se tranchent en faveur de
cet usage-là, sur cette machine-là. Il n'y a pas d'utilisateur hypothétique dont
il faudrait anticiper les besoins.

**Horizon de partage, conditionnel.** Si le produit devient assez bon pour
apporter quelque chose à d'autres, il pourra être distribué. Ce n'est ni un
objectif ni une échéance : c'est une possibilité qu'on garde ouverte.
Conséquence pratique, et la seule : **ne pas coder en dur ce qui est propre à
cette machine** — chemins absolus, noms de périphériques, identifiants de
plugins, répertoires personnels. Tout le reste des contraintes de distribution
(installateur, premier lancement, licences) est **hors périmètre tant que la
décision n'est pas prise**.

Ne pas confondre avec « préparer la distribution ». Ajouter aujourd'hui de la
mécanique d'installation, de mise à jour ou d'onboarding serait travailler pour
un utilisateur qui n'existe pas.

## 3. Les deux usages qui définissent le produit

MiniHub doit tenir **les deux à la fois**. Une proposition qui sert l'un en
dégradant l'autre est à rejeter ou à repenser.

| Usage | Ce que ça exige |
|---|---|
| **Produire un morceau complet** | Le séquenceur, l'enregistrement et l'export doivent être assez solides et fidèles pour finir un titre sans autre logiciel. Timing exact, export sans surprise, projets qui se rouvrent intacts. |
| **Jouer de la musique générative en direct** | Le graphe doit rester manipulable pendant que le son tourne. Aucune opération courante ne doit imposer une coupure audio, un rechargement, ou un état à reconstruire à la main. |

La tension entre les deux est le cœur de l'architecture : c'est elle qui explique
la séparation topologie / valeurs ([DECISIONS.md](DECISIONS.md) D-004), les
chaînes VST `append-only` qui survivent aux plans, et l'interdiction absolue de
bloquer le thread audio.

## 4. Ce que MiniHub est

- Un **Patch Bay** où l'on relie des nœuds par des câbles typés, et où le graphe
  est l'unique autorité du routage.
- Un **hôte VST3** natif : chaînes en série, éditeurs natifs, persistance de
  l'état des plugins.
- Un **séquenceur** d'arrangement MIDI + audio cadencé à l'échantillon, avec
  enregistrement, export multi-format et éditeur de clips.
- Un jeu de **nœuds de traitement** : Mixer, Morpher, Arpégiateur.
- Un **apprentissage de contrôles** reliant potentiomètres et pads physiques aux
  paramètres VST3.

## 5. Le matériel : le MiniLab est la référence, pas une prison

Le MiniLab 3 est le **cas d'usage de référence** : c'est lui qui est modélisé,
dessiné, testé, et c'est sur lui que les arbitrages se tranchent.

Mais l'architecture ne doit **pas rendre impossible** un second contrôleur. Un
identifiant matériel qui s'enracine dans le cœur du graphe est un défaut, pas
une simplification — c'est ce que [DECISIONS.md](DECISIONS.md) D-008 a corrigé
côté JS et n'a pas fini de corriger côté C++.

Nuance à ne pas franchir : **ne pas rendre impossible ≠ généraliser
maintenant**. Écrire une couche d'abstraction pour des contrôleurs qui n'existent
pas dans ce projet est du travail spéculatif.

**Windows est définitif.** WASAPI, le format VST3 Windows, `%APPDATA%`, le
stamping `rcedit` : ce sont des acquis, pas des dettes. Toute abstraction
multi-plateforme proposée « au cas où » est à refuser.

## 6. Ce que MiniHub n'est pas, et ne devient pas

- **Pas un produit multi-utilisateur.** Aucun compte, aucun profil, aucune
  synchronisation, aucun partage de projet entre machines.
- **Pas un service.** Le démarrage ne dépend d'aucun serveur, d'aucune base de
  données, d'aucun compte. L'application doit rester pleinement utilisable sans
  réseau (voir §7).
- **Pas une plateforme extensible.** Pas de système de greffons maison, pas de
  langage de script utilisateur, pas d'API publique. Les greffons, ce sont les
  VST3.
- **Pas un projet à dépendances.** L'absence de bundler, de framework et de
  dépendance runtime est un choix d'identité, pas un retard technique
  ([DECISIONS.md](DECISIONS.md) D-003).
- **Pas un clone de DAW.** Une fonctionnalité ne se justifie jamais par « les
  autres DAW l'ont ». Elle se justifie par l'un des deux usages du §3.

**Hors périmètre par défaut** : sends, sidechains, automation, minimap,
annuler/refaire, disposition automatique du graphe, groupes de nœuds. Les types
de nœuds `video` et `image` existent dans le registre avec des ports vides ;
**rien ne doit les implémenter** tant que cette ligne n'a pas changé.

Le refus n'est pas définitif par principe : il est définitif **par défaut**.
Lever un de ces refus se fait ici, explicitement, avec sa raison — comme la
gestion de presets l'a été au §8.

## 7. Le réseau : autorisé, confiné

MiniHub **n'est pas une application hors ligne par principe** : rien dans son
architecture ne l'interdit. Mais **aucune fonctionnalité n'utilise le réseau
aujourd'hui**, et aucune n'est prévue — le module de presets qui motivait cette
section a été abandonné ([DECISIONS.md](DECISIONS.md) D-013).

Ce qui suit ne décrit donc pas un existant : c'est le cadre que devra respecter
le premier usage du réseau, le jour où il y en aura un.

- **L'application reste pleinement utilisable sans réseau.** Aucune
  fonctionnalité existante ne peut se mettre à en dépendre. Une absence de
  connexion dégrade, elle n'empêche jamais de jouer ni d'ouvrir un projet.
- **Aucune donnée de l'utilisateur ne sort.** Pas de télémétrie, pas de
  statistiques d'usage, pas d'envoi de projet, pas de compte.
- **Le réseau appartient au processus principal.** Le renderer n'a ni disque ni
  réseau : sa CSP est `default-src 'self'` et ne doit pas être élargie. Toute
  requête passe par une commande en liste blanche, avec son validateur, comme
  tout le reste ([ARCHITECTURE.md](ARCHITECTURE.md) §4).
- **Tout contenu distant est une valeur externe.** Il est validé avant d'entrer
  dans l'état, et échappé avant d'atteindre `innerHTML` (invariant 9).
- **Aucune vérification de mise à jour automatique**, tant que la question de la
  distribution n'est pas tranchée (§2).

## 8. Refus reconduit : la gestion de presets

**Statut : tranché le 2026-09-03. Hors périmètre.**

Ce refus avait été levé le 2026-09-02, et un ExecPlan a mené le chantier
jusqu'à l'étape 8 sur 9 avant d'être arrêté. **Le refus est reconduit** ;
[DECISIONS.md](DECISIONS.md) D-013 porte les mesures qui l'ont tranché, dont les
deux qui suffisent : aucun fichier `.vstpreset` n'existe sur la machine, et le
besoin est déjà servi deux fois — par le navigateur de presets de chaque VST3,
et par `capturePluginStates` / `persistPluginStateChunk` qui persistent déjà
l'état de chaque plugin dans le projet.

Ne pas rouvrir ce chantier sur l'argument « il existe des presets à récupérer ».
Ce qui le rouvrirait légitimement est autre chose, et D-013 le nomme : **rappeler
une configuration MiniHub** — une chaîne VST plus un arpégiateur plus des
mappings MiniLab, recallable dans un autre projet. Aucun plugin ne fera jamais
ça, et ça ne traverse aucun réseau.

## 9. Arbitrages

**La règle de conduite, non négociable :** quand une demande entre en conflit
avec l'architecture existante, **le dire avant de construire**, en nommant ce
qui casserait — « si ce module est fait comme ça, ceci se casse, donc voilà
comment le repenser ». Ne jamais construire d'abord et signaler ensuite. Ne
jamais construire en silence en espérant que ça passe.

**L'ordre par défaut**, quand deux qualités s'opposent :

1. **Ne pas casser ce qui marche.** Une régression sur un chemin audio coûte
   plus que n'importe quelle fonctionnalité gagnée.
2. **Solidité et lisibilité** du code existant.
3. **Fonctionnalités nouvelles.**
4. **Élégance visuelle.**

*L'auteur confirme la préférence pour la solidité ; l'ordre exact des rangs 3 et
4 reste à valider par l'usage.*

Corollaire déjà appliqué dans ce dépôt : une passe de consolidation passe avant
un nouveau module, et un invariant énoncé doit devenir un test ou une règle de
`npm run check` — sinon ce n'est qu'un vœu.

## 10. À quoi ressemble un échec

- Le graphe cesse d'être l'autorité : ce qu'on entend dépend de la page ouverte.
- Le thread audio se met à bloquer, et les décrochages deviennent « normaux ».
- Jouer en direct impose une coupure audio pour changer quoi que ce soit.
- Ajouter un type de nœud redevient un chantier de plusieurs fichiers partagés.
- Une dépendance, un bundler ou un framework entre dans le renderer.
- L'application cesse de fonctionner sans réseau.
- La documentation se remet à mentir : `dist/` diverge de `src/`, un invariant
  énoncé n'est plus vrai, une décision est défaite sans entrée dans
  [DECISIONS.md](DECISIONS.md).

## 11. Questions ouvertes

Ces points ne sont **pas tranchés**. Tant qu'ils le restent, un agent ne doit ni
les supposer résolus, ni engager de travail qui en dépend.

1. **Seuil de performance non négociable** — existe-t-il un objectif chiffré
   (par exemple tenir un bloc de 256 échantillons avec N plugins chargés) qui,
   s'il n'est plus atteint, doit bloquer une évolution ?
2. **Rangs 3 et 4 du §9** — fonctionnalités avant élégance visuelle, ou
   l'inverse ?

Le langage visuel, lui, **n'est plus une question ouverte** : le modèle est
tranché ([DECISIONS.md](DECISIONS.md) D-012 — une coquille `base.css`, au plus
une façade `omni-pearl`, jamais mélangées, par défaut `base.css`). Reste un
choix esthétique éditeur par éditeur, qui ne bloque plus rien.
