# Tâche : fiche de lecture complète d'un article

Article : **$title** ($year, $venue).

Le texte intégral extrait du PDF est le fichier `$text_file` (fourni ci-dessous, ou dans le dossier
courant si tu disposes d'outils de lecture : utilise alors Read avec offset/limit et Grep). Les pages
sont séparées par des marqueurs `<<<PAGE n>>>`. Lis **tout** le texte avant de remplir la fiche.

Remplis chaque champ en français simple, pour un étudiant débutant :

- `resume_simple` : 4 à 6 phrases, comme si tu expliquais l'article à un débutant.
- `probleme`, `contributions`, `methode` : ce que les auteurs font réellement.
- `acces_oracle` : que voit l'attaquant (classe seule = hard-label ; probabilités = score-based ;
  gradients = white-box) ? Justifie, avec une `citation` exacte du texte.
- `composants` : comment les mots importants sont choisis (WIR), d'où viennent les substitutions
  (candidats), quels filtres (sens, grammaire, POS…), quelle stratégie de recherche, et le budget de
  requêtes. Écris « non précisé dans le texte » si l'info manque.
- `grille_hard_label` : lis l'attaque à travers les étapes communes des attaques hard-label
  récentes — `initialisation` (comment le premier exemple adversarial est obtenu : aléatoire,
  global, aucun…), `reduction_espace` (réversion des substitutions, réduction de la perturbation),
  `optimisation` (GA, évolution différentielle, recherche locale, échantillonnage, gradient
  estimé…), `filtres_avant_requete` (ce qui est écarté sans interroger le modèle : contraintes,
  déduplication, prédiction de succès…), `importance_mots` (comment l'attaque choisit les mots
  importants, et si ce choix coûte des requêtes). Pour une attaque qui n'est pas hard-label,
  explique brièvement l'équivalent ou écris « non applicable ».
- `evaluation` : datasets, modèles attaqués, métriques, baselines (noms exacts du texte).
- `resultats` : 3 à 6 résultats chiffrés importants. `valeur` = le nombre tel qu'écrit dans
  l'article (ex. « 88.4% ») ; `citation` = la phrase exacte qui le contient (copiée mot pour mot,
  ou vide si le chiffre n'est que dans un tableau).
- `points_forts`, `faiblesses`, `menaces_validite` : ton regard critique de relecteur, en pensant à
  la comparabilité (mêmes exemples ? même budget ? requêtes du WIR comptées ?).
- `reproductibilite` : code publié ? lien exact s'il apparaît dans le texte.
- `limites_auteurs` : limites déclarées par les auteurs eux-mêmes.
- `qualite` : 1 ou 0 pour chacune des 8 questions de qualité du protocole.
- `eligibilite` : ta suggestion après lecture intégrale (codes autorisés : E1, E2, E5, E6, E8).
- `pertinence_pfe` : score 0–5, questions de recherche concernées, et pourquoi.
- `pistes_contribution` : idées concrètes que l'étudiant pourrait tester dans son PFE.
- `phrase_etat_de_lart` : une phrase prête à citer dans un état de l'art, au format
  « Auteur et al. (année) … ».
- `vocabulaire` : 5 termes anglais scientifiques importants de l'article, avec traduction française,
  définition anglaise simple (`definition_en`) et sa version française (`definition_fr`), une phrase
  d'exemple **copiée de l'article** (`exemple_en`) et sa traduction française (`exemple_fr`).
