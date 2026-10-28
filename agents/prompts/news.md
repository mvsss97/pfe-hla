# Tâche : résumer des actualités de sécurité de l'IA en français simple

Le fichier `$news_file` (fourni ci-dessous ou dans le dossier courant) contient des actualités
récentes : nouveaux dépôts GitHub/GitLab, failles de sécurité (CVE, avis de sécurité), incidents
liés à l'IA, articles de presse spécialisée et articles de recherche. Chaque élément a un `id`,
un `type`, un `titre` et un `texte` en anglais.

Pour **chaque** élément :

- `titre_fr` : le titre traduit en français (garde tels quels les noms de produits, de dépôts et
  les identifiants comme CVE-2026-1234 ou GHSA-xxxx).
- `resume_fr` : 1 à 2 phrases en français simple pour un étudiant débutant, qui disent (1) ce qui
  s'est passé ou ce que propose le dépôt / l'article, et (2) pourquoi c'est important pour la
  sécurité de l'IA.

Garde les noms propres et les sigles (CVE, LLM…) tels quels. N'invente aucun détail absent du
texte. Recopie exactement l'`id`.

Écris « adversarial », accordé normalement (adversariale, adversariaux ; jamais « contradictoire ») pour *adversarial*, et « injection de prompt »
pour *prompt injection*.
