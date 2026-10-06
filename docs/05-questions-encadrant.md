# Décisions à faire valider par l'encadrant

Le cahier des charges laisse ces choix ouverts. Les figer tôt évitera un benchmark impossible à défendre.

1. Le composant du mini-projet est-il obligatoirement le WIR ou seulement un exemple ?
2. Quel dataset, quelle langue, quelle tâche et quel checkpoint cible ?
3. Le tokenizer et l'architecture sont-ils connus de l'attaquant ?
4. Attaque non ciblée seulement, ou ciblée également ?
5. Quels budgets maximums incluent-ils les requêtes de classement WIR ?
6. Quelles modifications sont interdites : stop words, négations, noms propres, entités ?
7. Quels seuils valident sens, taux de modification, grammaire et fluidité ?
8. Quelles baselines doivent être réimplémentées et lesquelles peuvent utiliser TextAttack ?
9. Combien d'exemples et de graines sont attendus ?
10. PRISMA est-il souhaité, ou une revue narrative suffit-elle ?
11. Quel format est attendu : rapport, notebook, dépôt, démonstration, slides ?
12. Quelle date réelle et quels jalons de validation ?

Proposition par défaut en attendant : SST-2, DistilBERT, attaque non ciblée, 200 exemples initialement corrects, budgets 100/250/500/1 000, trois graines, taux de modification ≤ 20 %, similarité ≥ 0,80 et comparaison suppression/masque/vote/aléatoire.

