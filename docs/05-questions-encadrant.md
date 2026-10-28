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

## Documents reçus de l'encadrant (thèse, « Related work hard label », présentation)

13. La présentation porte sur des attaques hard-label en **vision** (HopSkipJump, CIFAR-10) alors que le cahier des charges parle de **texte** : le PFE reste-t-il centré sur le NLP, la vision servant d'inspiration ?
14. Parmi les articles du document « Related work hard label », lesquels lire en premier pour en discuter ensemble ? (Ils sont importés dans la page « Encadrant » du site avec une priorité provisoire.)
15. La description de **HQA-Attack** dans le document semble différer de l'article (NeurIPS 2023) : quelle lecture retenir ?
16. **AGA** (PPSN 2022) : quelle est la référence exacte (titre, auteurs) ?
17. Les requêtes de l'initialisation et du classement des mots doivent-elles entrer dans le budget annoncé ?
18. Peut-on réutiliser le code de vos travaux comme baseline (dépôt, versions) ?
19. Faut-il évaluer l'attaque contre au moins une défense (FGWS, entraînement adversarial…) ?
