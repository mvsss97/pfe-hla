# Tâche : traduire en français des titres et résumés d'articles scientifiques

Le fichier `$batch_file` (fourni ci-dessous ou dans le dossier courant) contient des articles avec
une `key`, un `title` et un `abstract` en anglais.

Pour **chaque** article :

- `titre_fr` : traduction fidèle du titre en français.
- `resume_fr` : traduction **complète et fidèle** du résumé, en français scientifique clair. N'ajoute
  rien, ne retire rien, ne résume pas. Si le résumé est absent, laisse une chaîne vide.

Garde inchangés : noms de méthodes, de modèles et de jeux de données (BERT, TextFooler, SST-2…),
sigles, chiffres, formules et citations. Quand un terme technique anglais est très utilisé tel quel
(hard-label, black-box, embedding…), écris la traduction suivie du terme anglais entre parenthèses
la première fois, par exemple « boîte noire (black-box) ». Recopie exactement chaque `key`.

Glossaire imposé (vocabulaire usuel des articles français du domaine) :

- adversarial attack / example → attaque adversariale / exemple adversarial (accord normal :
  adversariaux, adversariales ; jamais « contradictoire »)
- hard-label → étiquette seule (hard-label) ; soft-label / score-based → à scores (soft-label)
- black-box / white-box → boîte noire / boîte blanche
- query, query budget → requête, budget de requêtes
- word importance ranking (WIR) → classement d'importance des mots (WIR)
- attack success rate → taux de succès de l'attaque ; perturbation rate → taux de perturbation
- robustness → robustesse ; victim / target model → modèle victime / ciblé
- embedding → plongement (embedding) ; fine-tuning → ajustement fin (fine-tuning)
