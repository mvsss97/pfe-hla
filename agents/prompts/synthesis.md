# Tâche : synthèse et comparaison des fiches de lecture

Le fichier `$sheets_file` (fourni ci-dessous ou dans le dossier courant) contient les fiches de lecture déjà produites (une par
article, identifiée par `key`, avec titre, auteurs, année). Elles sont des brouillons IA dont les
citations ont été vérifiées automatiquement (`checks`).

Produis :

- `vue_ensemble` : 5 à 8 phrases qui résument où en est la littérature lue pour ce PFE.
- `comparatif` : une ligne par article (`key` exacte) avec accès oracle, méthode WIR, candidats,
  recherche, datasets, modèles, budget, résultat principal et une note de `comparabilite`
  (qu'est-ce qui empêche de comparer directement ces chiffres avec les autres ?).
- `etat_de_lart` : 3 à 6 sections (titre + paragraphe) pour le chapitre « État de l'art » du mémoire.
  Cite les articles sous la forme « Auteur et al. (année) » et liste leurs `cles`. N'utilise que ce qui
  figure dans les fiches.
- `incoherences` : contradictions ou chiffres impossibles à comparer entre fiches (budgets différents,
  ASR calculé différemment, mêmes datasets avec des résultats divergents…).
- `lacunes_pistes` : manques de la littérature qui pourraient devenir la contribution du PFE,
  justifiés par les fiches.
- `prochaines_etapes` : 3 à 6 actions concrètes pour l'étudiant (lecture, expérience, rédaction).
