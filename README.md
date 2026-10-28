# PFE Hard‑Label NLP — mini‑projet et compagnon de recherche

Ce dépôt transforme le cahier des charges en deux blocs volontairement séparés :

1. **Le travail scientifique** : revue traçable, taxonomie, oracle strictement *label-only*, trois méthodes de Word Importance Ranking (WIR), attaque gloutonne et protocole comparatif.
2. **Le compagnon de travail** : tableau de bord mobile, bot Telegram privé et vocabulaire anglais en répétition espacée.

Le tableau de bord et le bot facilitent le travail ; ils ne sont pas présentés comme une contribution scientifique du PFE.

## En ligne (24 h/24, PC éteint)

| Élément | Où | Rôle |
|---|---|---|
| Tableau de bord | <https://pfe-hla.pages.dev> (miroir : <https://mvsss97.github.io/pfe-hla/>) | Cockpit, Bibliothèque, PRISMA, **Agents IA**, **Encadrant**, **Fiches de lecture**, **Comparatif**, **Rédaction**, English Lab, **Actus sécu IA**, cours, **lecteur PDF bilingue** — anglais et français côte à côte partout |
| Bot Telegram | [@PFE_MN_bot](https://t.me/PFE_MN_bot) (Cloudflare Worker, tick toutes les 30 min) | t'écrit à 08:00 (plan), 10:00 et 15:30 (pause anglais), 13:00 (tri), 18:00 (actus sécurité IA), 20:00 (bilan) ; alerte immédiate pour une faille grave liée à l'IA (pas la nuit) ; tri PRISMA, leçons + quiz, rédaction, liste et thèse de l'encadrant ; ouvre les articles dans le **lecteur bilingue** (mini-app Telegram) |
| Agents IA | GitHub Actions : 2 passages complets (~06:17, ~15:47) + 6 passages légers | collecte, tri IA, lecture des PDF, fiches vérifiées, synthèse, **veille sécurité IA**, **traduction FR** — avec la clé **Gemini gratuite** |

### Ce que font les agents à chaque passage (`.github/workflows/daily.yml`)

1. Appliquent tes décisions Telegram au journal PRISMA (`sync-decisions`, puis `sync-ack` une fois la base sauvegardée).
2. Figent le protocole **v1 (provisoire)** et exécutent une seule fois la recherche formelle PRISMA ; la veille `watch` cherche ensuite les nouveautés deux fois par jour.
3. **Trieur IA** : suggestions garder/exclure (I1–I5/E1–E8, pertinence 0–5). Ce ne sont jamais des décisions : tu confirmes sur Telegram (bouton « 🤖 Comme l'IA »).
4. **Lecteur IA** : télécharge les PDF en accès ouvert (arXiv, ACL Anthology, OpenReview…), lit tout le texte et écrit une fiche ; chaque citation est recherchée mot pour mot dans le PDF (✓ / ≈ / ✗).
5. **Synthèse IA** : comparatif, incohérences, lacunes et brouillon d'état de l'art.
6. **Veilleur IA** : failles (avis GitHub, NVD, CISA KEV), nouveaux dépôts GitHub/GitLab, incidents (AI Incident Database), presse spécialisée et arXiv cs.CR ; résumés en français, alerte Telegram pour une faille critique ou exploitée qui touche un logiciel d'IA.
7. **Traducteur IA** : titre et résumé de chaque article, définitions et exemples du vocabulaire en français, affichés sous l'anglais (site et bot).
8. Importent la **liste d'articles de l'encadrant** (`data/supervisor_reading_list.json`, données bibliographiques seulement) : ses priorités 1 et 2 passent en tête de la file de lecture.
9. Publient le site (Cloudflare Pages + miroir GitHub Pages), sauvegardent la base chiffrée (branche `research-db`) et préviennent le bot.

Les consignes des agents sont lisibles dans `agents/prompts/` et leurs formats dans `agents/schemas/`. Le moteur par défaut est Gemini (`GEMINI_API_KEY`, niveau gratuit, chaîne de modèles avec relances si un modèle est saturé) ; Claude Code reste possible en option (`AGENT_BACKEND=claude`).

### Configuration unique (à lancer une fois soi-même)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-secrets.ps1
```

Le script copie `GEMINI_API_KEY` de `.env` vers les secrets GitHub **et vers le bot** (traduction du lecteur PDF), crée le mot de passe de la sauvegarde chiffrée, protège le webhook Telegram par un secret privé et lance un premier passage. Dans PowerShell, tape la commande **sans** le `!` (le `!` ne sert que dans la zone de saisie de Claude Code).

### Lecteur PDF bilingue (`site/reader.html`)

PDF.js (Mozilla, Apache-2.0, dans `site/vendor/pdfjs`) affiche la page telle quelle ; le texte de chaque paragraphe est extrait avec sa position (`site/reader-layout.js`) et repeint en français **au même endroit** sur une copie de la page : colonnes, figures et formules ne bougent pas. Modes 🇬🇧 / 🇫🇷 / côte à côte ; toucher un paragraphe montre l'anglais.

Les pages traduites sont gardées dans le cache du bot (KV). Rien à taper :

- **les agents traduisent à l'avance** (`scripts/pretranslate.mjs`, à chaque passage) les articles que tu as ouverts, puis la liste de l'encadrant, puis les articles qui ont une fiche — même découpage que le lecteur, donc même cache ;
- un article pas encore traduit est **programmé** automatiquement pour le passage suivant (≈ 3 h) ;
- **traduction instantanée** de n'importe quel PDF (fichier local compris) : double-clic une seule fois sur `ACTIVER-LECTEUR.bat` (donne au bot la clé Gemini de `.env`).

Les PDF de la bibliothèque et des sites en accès ouvert (arXiv, ACL, OpenReview…) s'ouvrent pour tout le monde ; un autre lien demande le compte associé au bot (mini-app Telegram, ou lien de `/lecteur`). Le texte envoyé à Gemini (offre gratuite) peut être utilisé par Google : ne pas y ouvrir de document confidentiel.

### Documents privés de l'encadrant

La thèse, le document « Related work hard label » et la présentation restent sur le PC (motifs dans `.gitignore`) : le dépôt et le site sont publics. Seules les références d'articles publiés et des leçons écrites avec nos mots (modules « Thèse de l'encadrant » et « Attaques hard-label récentes ») sont publiées.

## État honnête

- Le squelette reproductible et les tests unitaires du cœur WIR sont inclus.
- La bibliothèque initiale contient des **pistes à vérifier**, pas une revue terminée.
- Aucun **résultat final de PFE** n'est prérempli. Le snapshot contient seulement un smoke test technique DistilBERT sur deux phrases synthétiques, explicitement étiqueté comme tel.
- Le collecteur automatisé actuel couvre OpenAlex et arXiv. IEEE Xplore, ACM DL, ACL Anthology et les bases institutionnelles doivent encore être interrogés/importés avant de parler de revue exhaustive.
- Le cahier des charges ne fixe ni dataset, ni modèle, ni budget de requêtes. Les hypothèses proposées dans `docs/02-protocole-experimental.md` doivent être validées par l'encadrant.
- Le dossier est un dépôt Git et chaque run `review` porte la version du protocole (SHA-256 + commit). La v1 est **provisoire** : la faire valider par l'encadrant (`python -m pfe_hla protocol-status v1 validated`) ou créer une v2.
- Les fiches et la synthèse IA sont des brouillons : relire chaque fiche et ne citer que les éléments marqués ✓ après vérification dans le PDF.
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

Commandes du bot hébergé : `/menu`, `/aujourdhui`, `/tri`, `/fiches`, `/prisma`, `/anglais`, `/apprendre`, `/quiz`, `/redaction`, `/plan`, `/agents`, `/chercher`, `/site`, `/reglages`, `/aide` ; les anciennes (`/today`, `/more`, `/papers`, `/search`, `/words`, `/stats`, `/help`) restent acceptées. Le poller local ci-dessous reste disponible pour un usage hors ligne.

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
