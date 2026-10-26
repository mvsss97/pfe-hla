# Tâche : pré-tri titre/résumé (screening PRISMA)

Lis le fichier `$batch_file` (fourni ci-dessous ou dans le dossier courant). Il contient une liste de
notices bibliographiques (`key`, `title`, `abstract`, `year`, `venue`, `language`).

Pour **chaque** notice, propose une suggestion de tri selon les critères I1–I5 / E1–E8 :

- `decision` : `include` si la notice semble répondre à I1–I4 (I5 se vérifie plus tard) ;
  `exclude` si un critère d'exclusion s'applique clairement ; `uncertain` sinon (résumé absent,
  accès oracle impossible à déterminer, sujet limite).
- `reason_code` : obligatoire si `exclude` (E1, E2, E3, E4, E5 ou E8 uniquement), sinon `null`.
- `access_regime` : ce que l'attaque observe du modèle cible d'après le titre/résumé.
- `contribution_type` : attaque, défense, benchmark, revue (survey), analyse, autre.
- `relevance` (0–5) : utilité pour CE PFE (5 = attaque textuelle hard-label avec classement des mots ;
  3 = baseline soft-label ou composant réutilisable ; 0 = hors sujet).
- `confidence` (0–1) : ta confiance dans la suggestion.
- `rationale` : 1 à 2 phrases en français simple qui citent le critère utilisé (ex. « I2 : attaque
  décisionnelle sur BERT » ou « E1 : images uniquement »).

Ne saute aucune notice et recopie exactement la `key`. N'invente rien qui ne soit pas dans la notice.
