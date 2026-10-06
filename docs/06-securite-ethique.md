# Sécurité, éthique et limites d'usage

- Le jeton Telegram partagé dans la conversation est compromis. Le révoquer via `@BotFather`, générer un nouveau jeton et le conserver uniquement dans `.env` ou dans les secrets de l'hébergeur.
- Associer le bot avec un code long et un identifiant de chat autorisé. Un inconnu ne doit pouvoir ni lire la bibliothèque, ni déclencher des traitements coûteux.
- Ne jamais exporter `.env`, la base privée, les PDF sous licence ou des données personnelles vers le site statique.
- Respecter les limites et conditions des API bibliographiques et des modèles cibles. Journaliser les erreurs 429 sans contourner les quotas.
- Exécuter les attaques uniquement sur des modèles/données autorisés. Le mémoire étudie la robustesse ; il ne doit pas fournir un service public d'évasion contre des tiers.
- Rapporter les échecs, la sélection des exemples et tout filtrage. Ne pas choisir seulement les cas où l'attaque réussit.
- Les résumés automatiques peuvent se tromper. Une affirmation chiffrée nécessite un renvoi au texte intégral vérifié.

