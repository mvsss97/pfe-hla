# Taxonomie de travail

Une attaque est décrite comme une chaîne de modules. Cette décomposition évite de comparer des noms d'algorithmes alors que plusieurs composants changent simultanément.

| Axe | Valeurs à coder | Question de vérification |
|---|---|---|
| Accès | white-box, scores, top-k, hard-label | Quelle information sort réellement de l'API ? |
| Objectif | ciblé, non ciblé | Quelle condition définit le succès ? |
| Granularité | caractère, sous-mot, mot, phrase | Quelle unité est modifiée ? |
| WIR | gradient, probabilité, suppression, masque, vote local, surrogate | Le calcul respecte-t-il l'accès annoncé ? |
| Candidats | fautes, embeddings, WordNet, MLM, paraphrase | Comment l'espace de recherche est-il construit ? |
| Gates | POS, entités, grammaire, sens, fluidité | Avant ou après la requête cible ? |
| Recherche | greedy, beam, génétique, MCTS, optimisation frontière | Qu'est-ce qui guide la prochaine action ? |
| Coût | requêtes WIR, recherche, total, temps | Toutes les requêtes sont-elles comptées ? |
| Qualité | edits, similarité, perplexité, humain | Les mesures de sens et fluidité sont-elles séparées ? |

## Bibliographie de départ, non encore « incluse »

| Travail | Rôle pressenti | Vigilance |
|---|---|---|
| Maheshwary et al. (2021), hard-label black-box | baseline centrale | vérifier initialisation, compte des requêtes et contraintes dans le PDF |
| TextDecepter (2020) | attaque hard-label annoncée | vérifier statut, versions et protocole |
| TextFooler (2020) | WIR/candidats soft-label | son WIR à probabilités ne respecte pas le scénario strict |
| PWWS (2019) | contraste WIR par saliency pondérée | dépend explicitement de probabilités |
| BAE (2020) | génération contextuelle de candidats | distinguer générateur et fonction objectif |
| BERT-Attack (2020) | substitutions via BERT | vérifier le régime d'accès |
| TextBugger (2019) | perturbations caractère/mot | séparer ses variantes white/black-box |
| Alzantot et al. (2018) | recherche génétique | coût de requêtes et comparabilité |
| TextAttack (2020) | cadre modulaire | outil d'implémentation, pas baseline unique |

Les descriptions ci-dessus sont des orientations de lecture. Un chiffre ou détail expérimental ne passe dans le mémoire qu'après ajout de son emplacement et de son statut de vérification dans `paper_analysis`.

