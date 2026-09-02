# PLANS.md — comment on produit un plan d'exécution

Un **ExecPlan** est un document de travail vivant pour une tâche qui ne tient pas
dans une session. Il vit dans `plans/active/`, il est **mis à jour pendant** le
travail, et il part dans `plans/done/` quand la tâche est finie.

Il ne remplace ni [ROADMAP.md](ROADMAP.md) (le *quoi*, à l'échelle du projet) ni
[ARCHITECTURE.md](ARCHITECTURE.md) (le *comment*, à l'échelle du code).

---

## 1. Quand écrire un plan — et quand ne pas en écrire

**Écris un plan si au moins deux de ces conditions sont vraies :**

- la tâche touche plus de cinq fichiers, ou plus d'un processus (renderer, main,
  natif) ;
- elle ne se termine pas dans une seule session de travail ;
- elle est réversible seulement au prix d'un `git revert` (déplacement de code,
  changement de format persisté, renommage d'identité) ;
- elle traverse un invariant d'ARCHITECTURE §13 ou une entrée de
  [DECISIONS.md](DECISIONS.md).

**N'écris pas de plan** pour une correction locale, l'ajout d'un test, un
renommage interne à un fichier, ou toute tâche dont la description tient en une
phrase et la vérification en une commande. Un plan pour ça est du bruit qu'il
faudra ensuite maintenir.

## 2. Règles

- **Un seul plan actif à la fois.** `plans/active/` contient zéro ou un fichier.
  Deux chantiers simultanés sur ce projet, c'est deux chantiers inachevés.
- **Le plan est vivant.** Chaque étape terminée est cochée dans le fichier, avec
  la commande qui l'a prouvée. Un plan écrit une fois puis jamais rouvert n'a
  servi à rien : c'est le fichier qu'on relit après un `/clear`, un plantage, ou
  trois jours d'interruption.
- **Une étape = une vérification mécanique.** Si tu ne peux pas écrire la
  commande qui prouve qu'une étape est faite, l'étape est mal découpée.
- **Le plan ne redécrit pas l'architecture.** Il *renvoie* aux sections
  concernées. Un plan qui recopie ARCHITECTURE.md deviendra faux avant la fin du
  chantier.
- **Ce qui est hors périmètre est écrit noir sur blanc.** C'est la section qui
  empêche un chantier de trois jours d'en devenir un de trois semaines.
- **Fini = déplacé.** `git mv plans/active/X.md plans/done/X.md`, avec la ligne
  de résultat renseignée. Rien ne reste dans `active/`.
- **Un plan abandonné va aussi dans `done/`**, avec le résultat « abandonné » et
  la raison. Ce qui n'a pas marché vaut ce qui a marché.

## 3. Structure obligatoire

Le nom du fichier est un `slug` en minuscules décrivant la tâche :
`plans/active/eclater-nodeinstances.md`.

```markdown
# <Titre> — ExecPlan

**Objectif** — une phrase. Ce qui sera vrai à la fin et ne l'est pas aujourd'hui.
**Origine** — ROADMAP §N, ou la raison qui a déclenché le chantier.
**Statut** — en cours | bloqué (sur quoi) | fini le AAAA-MM-JJ | abandonné (pourquoi)

## Contexte
Les fichiers concernés, les sections d'ARCHITECTURE.md à relire, les entrées de
DECISIONS.md que la tâche approche. Rien d'autre.

## Contraintes
Ce qui ne doit pas bouger : invariants traversés, formats persistés, API
publiques. Une contrainte par ligne.

## Hors périmètre
Ce que ce plan ne fera pas, et qui sera tentant. Nommer explicitement.

## Étapes
- [ ] 1. <action précise, un fichier ou un groupe cohérent>
      Vérification : `<commande>`
- [ ] 2. …

## Point de retour
Le commit ou la branche depuis lequel on peut repartir si le chantier tourne mal.

## Fini quand
La liste complète des commandes vertes (voir AGENTS.md §8), plus les critères
propres à cette tâche.

## Journal
AAAA-MM-JJ — ce qui a été fait, ce qui a surpris, ce qui a changé dans le plan.
```

## 4. Découpage des étapes

Une étape est bonne quand elle laisse le dépôt **vert** : `npm test` et
`npm run check` passent à la fin de chaque étape, pas seulement à la fin du plan.
Un chantier qui ne peut pas être découpé ainsi doit d'abord être précédé d'une
étape préparatoire qui le rend possible — typiquement, ajouter les tests qui
verrouillent le comportement actuel avant de déplacer quoi que ce soit.

Formuler l'action, pas l'intention : « extraire `createDisposers()` dans
`core/disposers.js` et l'utiliser dans les neuf écouteurs de `mount()` » plutôt
que « nettoyer la gestion des écouteurs ».
