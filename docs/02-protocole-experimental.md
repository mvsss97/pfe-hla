# Protocole expérimental du mini‑projet WIR

Statut : **protocole cible à faire valider par l'encadrant**. Les valeurs absentes du cahier des charges sont explicitement marquées comme choix de travail. Le runner actuel valide l'oracle, les trois WIR, les budgets et les agrégats ; contrôle aléatoire, POS/NER, similarité, perplexité et tests statistiques restent à implémenter avant l'expérience finale.

## Question et hypothèses

Question principale : sous un budget de requêtes identique et avec un oracle ne révélant que la classe, le vote de voisinage classe-t-il les tokens plus utilement que la suppression ou le masquage binaires ?

- **H0** — À budget identique, les méthodes WIR ont une efficacité d'attaque équivalente.
- **H1** — Le vote de voisinage augmente le succès sous budget ou réduit les requêtes nécessaires, au prix d'un coût WIR initial plus élevé.

Un résultat négatif est acceptable s'il est correctement mesuré et expliqué.

## Menace stricte

L'attaquant connaît le texte d'entrée, l'ensemble des classes et peut appeler `predict(text) -> label`. Il ne reçoit ni score, ni logit, ni gradient, ni état caché. Le tokenizer et l'architecture cible sont considérés inconnus dans le scénario principal. L'attaque est non ciblée : `f(x_adv) != f(x)`.

Le wrapper `BudgetedOracle` est l'unique chemin vers la cible. Toute prédiction — classement WIR, génération/filtrage dépendant de la cible et recherche — consomme une requête. Les scores du modèle réel ne doivent jamais franchir l'adaptateur.

## Pilote réaliste sur la machine actuelle

- Tâche : sentiment binaire SST-2 ou IMDb ; **SST-2 recommandé pour le pilote CPU**.
- Cible : modèle compact finement ajusté, par exemple DistilBERT SST-2 ; version exacte et hash à figer.
- Échantillon pilote : 30 exemples correctement classés, équilibrés si possible.
- Benchmark final proposé : au moins 200 exemples correctement classés, sélection figée avant comparaison.
- Graines : 3 graines pour les composants stochastiques ; mêmes exemples pour toutes les méthodes.
- Budgets proposés : 100, 250, 500 et 1 000 requêtes, avec 500 comme budget principal.

Ces choix sont des hypothèses et non des exigences du cahier des charges.

## Méthodes WIR comparées

1. **Suppression** : retirer le token `w_i`, requêter l'oracle, score 1 si la classe change sinon 0.
2. **Masquage** : remplacer `w_i` par un marqueur neutre configuré, même score binaire.
3. **Vote de voisinage** : générer `m` remplacements admissibles pour `w_i`; le score est la proportion de voisins dont la classe diffère de la classe d'origine.
4. **Aléatoire** : contrôle négatif, même graine et même budget de recherche.

Les égalités sont départagées de façon déterministe par la position du token. Rapporter séparément le coût du classement et celui de la recherche.

## Recherche et contraintes communes

Pour isoler l'effet du WIR, les méthodes utilisent exactement le même générateur de synonymes, les mêmes gates et la même recherche gloutonne. Ordre recommandé des gates : mot non modifiable → compatibilité morphosyntaxique → similarité sémantique locale/globale → fluidité → requête cible.

Choix initiaux à valider : au plus 20 % des tokens lexicaux modifiés ; aucune modification des entités nommées et négations ; similarité cosinus de phrase ≥ 0,80 ; pas de substitution déjà utilisée. La perplexité mesure la fluidité, pas la conservation du sens.

## Mesures

Mesure principale : **ASR sous budget**, uniquement parmi les exemples correctement classés au départ.

Mesures complémentaires :

- requêtes totales par succès et par tentative, moyenne, médiane et quartiles ;
- succès en fonction du budget, ou aire sous cette courbe ;
- taux de tokens modifiés et distance d'édition ;
- similarité sémantique ;
- perplexité ou delta de perplexité ;
- erreurs grammaticales, si l'outil est figé ;
- temps mural et taux de candidats rejetés par chaque gate ;
- évaluation humaine aveugle sur un sous-échantillon : sens préservé et naturel, avec protocole défini à l'avance.

Ne jamais comparer deux ASR si les contraintes, exemples, modèles ou budgets diffèrent sans le signaler.

## Analyse statistique

- Intervalle de confiance bootstrap à 95 % pour ASR, requêtes et taux de modification.
- Test de McNemar pour les succès appariés sur les mêmes exemples.
- Wilcoxon signé-rang pour les requêtes des attaques réussies par les deux méthodes ; rapporter aussi une taille d'effet.
- Correction de Holm si plusieurs comparaisons post-hoc sont réalisées.
- Publier les résultats par exemple, pas seulement les agrégats.

## Ablations

- Nombre de voisins `m` (par exemple 2, 5, 10).
- Avec/sans gate sémantique précoce.
- Budget consacré au WIR versus recherche.
- Générateur lexical versus masked-language model.
- Seuil de similarité.

## Définition de terminé

Un run final possède : configuration sérialisée, versions, graines, liste/hash des exemples, compteur de toutes les requêtes, sorties individuelles, agrégats recalculables, erreurs et journal système. Un résultat de démonstration avec l'oracle lexical ne constitue pas une expérience BERT.
