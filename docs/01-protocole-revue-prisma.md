# Protocole de revue — PRISMA comme journal de traçabilité

Version initiale : 2026-10-06. Ce protocole doit être daté et figé avant le tri final. Toute modification ultérieure devra être consignée et justifiée dans une archive versionnée.

**Limite actuelle :** la base relie les notices aux runs `review`, mais ne stocke pas encore le hash/version du protocole qui les gouverne, et ce dossier n'est pas encore initialisé comme dépôt Git. Jusqu'à l'ajout de ce lien, rester en mode `pilot`; avant le premier run `review`, archiver cette version, calculer son SHA-256 et faire valider la version par l'encadrant.

## Objectif et questions de recherche

La revue vise les attaques adversariales contre des classifieurs de texte, avec un intérêt principal pour le régime **black-box hard-label**.

- **RQ1** — Quelles attaques NLP fonctionnent lorsque l'oracle ne renvoie que l'étiquette finale ?
- **RQ2** — Comment estimer l'importance des mots sans probabilité, logit ni gradient ?
- **RQ3** — Quels espaces de perturbation, filtres et stratégies de recherche sont employés ?
- **RQ4** — Comment l'efficacité en requêtes, le succès et la qualité linguistique sont-ils mesurés ?
- **RQ5** — Quelles comparaisons sont réellement valides compte tenu des datasets, modèles, budgets et contraintes ?

Cadre PICOC adapté : population = classifieurs NLP de type Transformer ; intervention = attaque adversariale décisionnelle ; comparaison = heuristiques WIR et recherches concurrentes ; résultats = succès, coût en requêtes, perturbation, sens et fluidité ; contexte = accès black-box à l'inférence.

## Sources et requêtes

Sources minimales : ACL Anthology, IEEE Xplore, ACM Digital Library, AAAI, NDSS, arXiv et OpenAlex pour le repérage/dédoublonnage. Scopus ou Web of Science seront ajoutés si l'établissement fournit l'accès.

**État de l'outil :** l'automatisation fournie interroge seulement OpenAlex et arXiv, avec un nombre de réponses borné par exécution et sans pagination exhaustive. Elle constitue un pilote de veille. Les autres sources ci-dessus exigent encore un export institutionnel ou un connecteur documenté avant la revue finale.

Requête conceptuelle, adaptée à la syntaxe de chaque base :

```text
("hard-label" OR "label-only" OR "decision-based" OR "score-free")
AND (adversarial OR attack OR evasion)
AND (text OR NLP OR language OR BERT OR transformer)
```

Requête de rappel pour les méthodes à adapter :

```text
("black-box" OR query-based)
AND ("adversarial text" OR "text attack")
AND ("word importance" OR saliency OR substitution OR masking)
```

Chaque exécution conserve : source, requête conceptuelle, expression réellement envoyée à l'API, URL complète avec paramètres non secrets (limite, tri, pagination/sélection), nature du run (`pilot`, `review` ou `watch`), date, nombre de réponses, erreur éventuelle et identifiants des notices. Une recherche par boule de neige avant/arrière est journalisée séparément. Seuls les runs gelés `review` alimentent PRISMA ; les références seed, pilotes et veilles `watch` restent un backlog et ne peuvent pas recevoir une décision de screening formel tant qu'un run `review` documenté ne les a pas retrouvées.

## Critères d'éligibilité

### Inclusion

- **I1** — Porte sur une attaque, une évaluation de robustesse ou une défense utile aux classifieurs de texte/NLP.
- **I2** — Étudie directement un accès hard-label/décisionnel, ou fournit un composant/baseline explicitement adaptable au cadre étudié.
- **I3** — Décrit une méthode, un benchmark, une étude empirique ou une revue scientifique.
- **I4** — Publication en anglais, de 2018 à la date finale de recherche.
- **I5** — Texte intégral accessible pour vérifier protocole et résultats.

### Exclusion

- **E1** — Modalité non textuelle uniquement.
- **E2** — Hors attaques adversariales/robustesse NLP.
- **E3** — Hors fenêtre temporelle.
- **E4** — Langue autre que l'anglais.
- **E5** — Tutoriel, billet, brevet ou annonce sans protocole scientifique.
- **E6** — Hors sujet après lecture intégrale.
- **E7** — Texte intégral non récupérable après recherche raisonnable.
- **E8** — Doublon d'une version plus complète ; la relation entre versions est conservée.

Un article soft-label important peut entrer dans la **taxonomie des baselines** sans être compté comme méthode hard-label. Cette distinction doit apparaître dans la table d'extraction.

## Sélection

1. Importer les notices et dédoublonner par DOI, identifiant arXiv puis titre normalisé.
2. Effectuer le tri titre/résumé. Le programme peut suggérer, mais la décision finale est humaine.
3. Récupérer le texte intégral et appliquer I1–I5/E1–E8.
4. Faire vérifier les cas incertains par l'encadrant ; conserver la décision et le motif.
5. Produire le diagramme de flux depuis le journal SQLite, sans retaper les nombres.

Les codes E1–E5/E8 sont disponibles au tri titre/résumé. Au texte intégral, E1/E2/E5/E6/E7/E8 sont autorisés ; E7 est réservé à une exclusion pour rapport non récupéré et ne peut jamais accompagner une inclusion. Une décision incertaine reste dans sa file (`identified` ou `sought`) jusqu'à résolution, sans être comptée comme screening terminé.

## Extraction et contrôle qualité

Pour chaque étude : menace, données, modèle, langue, objectif ciblé/non ciblé, accès réellement exposé, méthode WIR, génération des candidats, filtres, recherche, budget, ASR, requêtes, taux de modification, similarité, fluidité, validation humaine, code et limites.

Chaque chiffre utilisé dans un tableau reçoit : page/table, phrase ou cellule source, statut de vérification. Un résumé généré automatiquement reste « non vérifié » jusqu'à comparaison au PDF.

Questions de qualité, notées 0/1 : menace définie ; budget complet ; baselines comparables ; contraintes opérationnalisées ; taille et sélection de l'échantillon ; variance/IC ; code ou détails reproductibles ; limites rapportées. Le score sert à discuter la confiance, pas à maquiller une exclusion après coup.

## Ce que PRISMA ne résout pas

PRISMA documente la sélection des sources. Il ne garantit ni la qualité des expériences, ni la validité d'une attaque, ni l'absence de fuite de scores. Le protocole expérimental demeure séparé.
