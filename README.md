# PFE Hard‑Label NLP — mini‑projet et compagnon de recherche

Ce dépôt transforme le cahier des charges en deux blocs volontairement séparés :

1. **Le travail scientifique** : revue traçable, taxonomie, oracle strictement *label-only*, trois méthodes de Word Importance Ranking (WIR), attaque gloutonne et protocole comparatif.
2. **Le compagnon de travail** : tableau de bord mobile, bot Telegram privé et vocabulaire anglais en répétition espacée.

Le tableau de bord et le bot facilitent le travail ; ils ne sont pas présentés comme une contribution scientifique du PFE.

## État honnête

- Le squelette reproductible et les tests unitaires du cœur WIR sont inclus.
- La bibliothèque initiale contient des **pistes à vérifier**, pas une revue terminée.
- Aucun **résultat final de PFE** n'est prérempli. Le snapshot contient seulement un smoke test technique DistilBERT sur deux phrases synthétiques, explicitement étiqueté comme tel.
- Le collecteur automatisé actuel couvre OpenAlex et arXiv. IEEE Xplore, ACM DL, ACL Anthology et les bases institutionnelles doivent encore être interrogés/importés avant de parler de revue exhaustive.
- Le cahier des charges ne fixe ni dataset, ni modèle, ni budget de requêtes. Les hypothèses proposées dans `docs/02-protocole-experimental.md` doivent être validées par l'encadrant.
- Le dossier n'est pas encore un dépôt Git et les runs ne portent pas encore le hash du protocole. Avant le premier `--run-kind review`, versionner/archiver le protocole et lier cette version aux exécutions ; jusque-là, utiliser `pilot`.
- Le jeton Telegram publié dans la conversation doit être révoqué. Ne jamais le recopier dans ce dépôt.

## Démarrage sous Windows

Prérequis : Python 3.11 ou 3.12. Un environnement local Python 3.12 est déjà préparé dans `.venv` sur la machine auditée.

```powershell
winget install --id Python.Python.3.12 -e
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
python -m pfe_hla init --seed
python -m pfe_hla export
python -m pfe_hla serve
```

Ouvrir ensuite <http://127.0.0.1:8000>. L'installation `.[ml]` est optionnelle et volumineuse ; elle ne doit être faite qu'au moment d'utiliser un vrai modèle Transformer.

## Parcours conseillé

```powershell
# Voir les articles de départ et les compteurs réels
python -m pfe_hla papers
python -m pfe_hla stats

# Collecter des métadonnées (arXiv + OpenAlex)
python -m pfe_hla collect --limit 20 --run-kind pilot

# Après validation et gel du protocole seulement : exécution comptée par PRISMA
python -m pfe_hla collect --limit 100 --run-kind review

# Obtenir des suggestions transparentes, puis décider manuellement
python -m pfe_hla suggest
python -m pfe_hla screen 1 include --reason "Accès hard-label et expérience NLP pertinents"
python -m pfe_hla screen 1 include --stage full_text --reason "Protocole complet vérifié"
python -m pfe_hla decide 1 keep --note "Inclus dans la synthèse"

# Lecture intégrale : installer une fois l'extra PDF, puis extraire et vérifier
python -m pip install -e ".[review]"
python -m pfe_hla fetch-pdf 1
python -m pfe_hla verify-evidence 1 --claim "Budget annoncé" --quote "exact excerpt" --value "500"

# Réviser l'anglais
python -m pfe_hla words --limit 3
python -m pfe_hla review 1 4

# Démonstration hors ligne du protocole (oracle lexical, pas une expérience BERT)
python -m pfe_hla demo --method neighborhood

# Smoke test avec un vrai classifieur Transformer (téléchargement lourd, CPU possible).
# Utiliser un chemin distinct par run ; --overwrite est volontairement explicite.
python -m pip install -e ".[ml]"
python -m pfe_hla benchmark --input data/smoke_quick.jsonl --budget 10 `
  --output artifacts/smoke-AAAA-MM-JJ.jsonl --run-name smoke-AAAA-MM-JJ `
  --dataset synthetic-quick-smoke --record

# Actualiser les données publiques du site
python -m pfe_hla export
```

Les suggestions automatiques ne deviennent jamais silencieusement des décisions humaines. Une exclusion manuelle exige un code et un motif afin de conserver un diagramme PRISMA défendable.

La vérification de preuve est volontairement prudente : `exact_quote` indique seulement que la phrase normalisée existe dans une page, `value_only` que la valeur existe sans la phrase, et `not_found` qu'elle n'a pas été retrouvée. Le contexte scientifique doit encore être contrôlé par une personne.

La couche PDF actuelle conserve un document courant par article. Ne pas remplacer/refetcher un PDF après avoir enregistré des preuves destinées au mémoire : avant le benchmark final, faire évoluer ce stockage vers des versions immuables (hash PDF + texte, version de l'extracteur et lien preuve→version). Le smoke actuel a été vérifié, mais cette limite interdit de présenter la couche comme une archive probante complète.

## Telegram, sans exposer le nouveau jeton

1. Dans `@BotFather`, exécuter `/revoke` pour le jeton divulgué, puis générer un nouveau jeton.
2. Copier `.env.example` vers `.env` et renseigner le **nouveau** jeton.
3. Choisir une longue valeur aléatoire pour `TELEGRAM_PAIRING_CODE`.
4. Lancer `python -m pfe_hla bot-poll --watch`.
5. Depuis le téléphone, envoyer `/start VOTRE_CODE` au bot, puis supprimer ce message.

Commandes : `/today`, `/more`, `/papers`, `/search`, `/words`, `/stats`, `/site`, `/help`.

Pour un envoi quotidien lorsque le PC est allumé :

```powershell
python -m pfe_hla digest
```

Le déploiement permanent est une étape séparée : GitHub Actions peut lancer la collecte et l'export, tandis qu'un petit service hébergé doit recevoir les mises à jour Telegram. Aucun secret ne doit être placé dans les fichiers du site statique.

Le workflow fourni emploie le cache GitHub Actions comme continuité pratique, pas comme sauvegarde scientifique garantie. Son digest est donc **en lecture seule**, sans boutons associés aux identifiants SQLite. Pour rendre les boutons distants interactifs, il faut d'abord une base durable unique partagée avec le poller (par exemple D1 ou PostgreSQL) ; ne jamais réconcilier des décisions par simple identifiant numérique entre deux bases.

## Structure

```text
data/                 métadonnées de départ et base SQLite locale ignorée par Git
docs/                 protocole de revue, protocole expérimental, taxonomie, feuille de route
site/                 interface statique mobile
src/pfe_hla/research/ cœur expérimental hard-label/WIR
src/pfe_hla/          collecte, PRISMA, anglais, Telegram et export
tests/                tests sans appel à un modèle distant
```

## Principes de validité

- L'oracle expérimental ne retourne qu'une classe ; les scores/logits restent derrière l'adaptateur cible.
- Toutes les requêtes, y compris celles utilisées par le WIR, comptent dans le budget.
- L'ASR est calculé uniquement sur les exemples correctement classés au départ.
- Similarité sémantique et fluidité sont rapportées séparément.
- Les fiches de lecture distinguent les faits vérifiés dans le PDF des résumés provisoires.
- Chaque configuration, graine et environnement doit accompagner un résultat.

Commencer par [les décisions à faire valider](docs/05-questions-encadrant.md), puis figer [le protocole expérimental](docs/02-protocole-experimental.md) avant de lancer le benchmark final.

Les fichiers `data/smoke_sentiment.jsonl` (huit phrases) et `data/smoke_quick.jsonl` (deux phrases) servent uniquement à vérifier la chaîne technique. Ils ne remplacent pas SST-2/IMDb et leurs sorties ne doivent pas être présentées comme résultats finaux. `data/smoke_substitutions.json` est un petit lexique de synonymes de démarrage ; un générateur de candidats scientifiquement validé reste nécessaire pour le benchmark principal. Chaque nouvel artefact JSONL inclut désormais modèle/révision disponible, tokenizer, versions, horodatage et hashes des entrées ; un chemin existant n'est remplacé qu'avec `--overwrite`.
