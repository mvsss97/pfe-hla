# Tâche : expliquer une cyberattaque à un étudiant débutant

Le fichier `$incident_file` (fourni ci-dessous ou dans le dossier courant) contient un à trois
articles de presse sur **le même** incident de sécurité (`articles` : `titre`, `source`, `date`,
`resume`, `texte`). Les textes sont en anglais. Croise les articles : en cas de contradiction, garde
le plus récent et dis que le point est incertain. Réponds en français simple, phrases courtes.

Remplis chaque champ **uniquement avec ce que disent les articles** ; si une information manque, écris
exactement « non précisé dans l'article ». N'invente ni chiffre, ni nom d'attaquant, ni technique.

- `titre_fr` : le titre traduit.
- `resume_en` : 2 phrases en anglais très simple (niveau débutant) qui résument l'incident.
- `resume_fr` : 3 à 5 phrases : qui a été attaqué, quand, ce qui a été volé ou bloqué.
- `victime` : l'organisation ou les personnes touchées.
- `attaquants` : qui est soupçonné ou accusé, et par qui (ex. « attribué par le FBI à… »).
- `methode` : les étapes de l'attaque dans l'ordre (accès initial → déplacement → vol ou blocage),
  chacune en une phrase. Si le texte ne décrit pas la méthode, une seule étape « non précisé dans
  l'article ».
- `impact` : conséquences (argent, données, services, personnes).
- `defense` : 3 à 5 protections concrètes qui auraient empêché ou limité **cette** attaque (MFA,
  séparation des clés, revue des mises à jour, sauvegardes hors ligne…), adaptées à ce cas.
- `lien_ia` : en une phrase, le lien avec l'IA ou avec un PFE sur les attaques adversariales s'il
  existe vraiment ; sinon une chaîne vide.
- `fiabilite` : « confirmé » si la victime ou une autorité confirme, « en cours d'enquête » si les
  faits sont encore incertains, sinon « non précisé ».
- `termes` : 3 termes anglais de sécurité utilisés dans l'article, avec leur traduction.
