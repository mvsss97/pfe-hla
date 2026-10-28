(() => {
  "use strict";

  const ROUTES = [
    ["cockpit", "Cockpit"],
    ["bibliotheque", "Bibliothèque"],
    ["prisma", "PRISMA"],
    ["agents", "Agents IA"],
    ["encadrant", "Encadrant"],
    ["fiches", "Fiches de lecture"],
    ["comparatif", "Comparatif"],
    ["taxonomie", "Taxonomie"],
    ["experiences", "Expériences WIR"],
    ["redaction", "Rédaction"],
    ["english", "English Lab"],
    ["actus", "Actus sécu IA"],
    ["guide", "Guide"],
  ];

  const STORAGE = {
    theme: "hardlabel.theme",
    savedPapers: "hardlabel.savedPapers",
    vocabulary: "hardlabel.vocabulary.progress",
    redaction: "hardlabel.redaction.checklist",
    thesis: "hardlabel.these.done",
  };

  const DEFAULT_PRISMA = Object.freeze({
    identified: 0,
    uniqueRecords: 0,
    duplicates: 0,
    screened: 0,
    excluded: 0,
    reportsSought: 0,
    reportsNotRetrieved: 0,
    assessed: 0,
    fullExcluded: 0,
    included: 0,
    pendingScreening: 0,
    pendingDecision: 0,
  });

  const DEFAULT_VOCABULARY = [
    {
      term: "query budget",
      type: "noun phrase",
      fr: "budget de requêtes",
      synonyms: ["query limit", "request allowance"],
      example: "The attack must stay within a strict query budget.",
    },
    {
      term: "perturbation",
      type: "noun",
      fr: "modification contrôlée de l’entrée",
      synonyms: ["alteration", "modification"],
      example: "A valid perturbation should preserve the original meaning.",
    },
    {
      term: "decision boundary",
      type: "noun phrase",
      fr: "frontière de décision",
      synonyms: ["classification boundary"],
      example: "The attack searches for a sentence beyond the decision boundary.",
    },
    {
      term: "surrogate model",
      type: "noun phrase",
      fr: "modèle substitut",
      synonyms: ["proxy model", "substitute model"],
      example: "Our threat model does not assume access to a surrogate model.",
    },
    {
      term: "ablation study",
      type: "noun phrase",
      fr: "étude d’ablation",
      synonyms: ["component analysis"],
      example: "The ablation study isolates the effect of word ranking.",
    },
    {
      term: "robustness",
      type: "noun",
      fr: "robustesse, résistance aux perturbations",
      synonyms: ["resilience", "stability"],
      example: "We evaluate the classifier’s robustness under hard-label attacks.",
    },
    {
      term: "entailment",
      type: "noun",
      fr: "implication logique entre deux textes",
      synonyms: ["logical implication"],
      example: "The benchmark includes a natural language entailment task.",
    },
    {
      term: "synonym substitution",
      type: "noun phrase",
      fr: "remplacement par un synonyme",
      synonyms: ["lexical replacement"],
      example: "Synonym substitution reduces the discrete search space.",
    },
    {
      term: "fluency",
      type: "noun",
      fr: "fluidité naturelle du texte",
      synonyms: ["naturalness", "readability"],
      example: "Human raters assess grammaticality and fluency.",
    },
    {
      term: "reproducibility",
      type: "noun",
      fr: "reproductibilité",
      synonyms: ["repeatability"],
      example: "Fixed seeds improve the reproducibility of the comparison.",
    },
  ];

  const state = {
    backend: null,
    prisma: { ...DEFAULT_PRISMA },
    vocabulary: [...DEFAULT_VOCABULARY],
    vocabularyProgress: {},
    protocol: null,
    completedRuns: [],
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  function readJSON(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch (_error) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_error) {
      showToast("Le stockage local n’est pas disponible.");
      return false;
    }
  }

  function safeInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  function formatDate(date, options = { day: "numeric", month: "short" }) {
    return new Intl.DateTimeFormat("fr-FR", options).format(date);
  }

  let toastTimer;
  function showToast(message) {
    const toast = $("#toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
  }

  function setTheme(theme) {
    const normalized = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = normalized;
    try {
      localStorage.setItem(STORAGE.theme, normalized);
    } catch (_error) {
      // The visual theme still works for this session.
    }
    const label = normalized === "dark" ? "Passer au thème clair" : "Passer au thème sombre";
    $("#theme-toggle")?.setAttribute("aria-label", label);
    $("#mobile-theme")?.setAttribute("aria-label", label);
  }

  function initializeTheme() {
    let saved = null;
    try {
      saved = localStorage.getItem(STORAGE.theme);
    } catch (_error) {
      saved = null;
    }
    const preferred = window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
    setTheme(saved || preferred);
    [$("#theme-toggle"), $("#mobile-theme")].forEach((button) => {
      button?.addEventListener("click", () => {
        setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
      });
    });
  }

  function currentRoute() {
    const candidate = location.hash.replace(/^#/, "").split("/")[0];
    return ROUTES.some(([route]) => route === candidate) ? candidate : "cockpit";
  }

  function routeDetail() {
    return decodeURIComponent(location.hash.replace(/^#/, "").split("/")[1] || "");
  }

  function showRoute(route, options = {}) {
    const valid = ROUTES.some(([candidate]) => candidate === route) ? route : "cockpit";
    $$('[data-view]').forEach((view) => {
      view.hidden = view.dataset.view !== valid;
    });
    $$('[data-route]').forEach((link) => {
      if (link.dataset.route === valid) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    const label = ROUTES.find(([candidate]) => candidate === valid)?.[1] || "Cockpit";
    $("#view-label").textContent = label;
    document.title = `${label} · HardLabel Lab`;
    if (!options.initial && location.hash.split("/")[0] !== `#${valid}`) history.replaceState(null, "", `#${valid}`);
    if (valid === "fiches") renderSheetDetail(routeDetail());
    if (options.focus) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      $("#main-content")?.focus({ preventScroll: true });
    }
  }

  function initializeNavigation() {
    showRoute(currentRoute(), { initial: true });
    window.addEventListener("hashchange", () => showRoute(currentRoute(), { focus: true }));
    $$('[data-go]').forEach((button) => {
      button.addEventListener("click", () => {
        location.hash = button.dataset.go;
      });
    });
    document.addEventListener("keydown", (event) => {
      if (event.altKey && !event.ctrlKey && /^[1-9]$/.test(event.key) && ROUTES[Number(event.key) - 1]) {
        event.preventDefault();
        location.hash = ROUTES[Number(event.key) - 1][0];
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        location.hash = "bibliotheque";
        setTimeout(() => $("#library-search")?.focus(), 0);
      }
    });
  }

  function initializeDate() {
    const date = new Intl.DateTimeFormat("fr-FR", {
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(new Date());
    $("#current-date").textContent = date.charAt(0).toUpperCase() + date.slice(1);
  }

  const storedPaperIds = readJSON(STORAGE.savedPapers, []);
  let savedPapers = new Set(Array.isArray(storedPaperIds) ? storedPaperIds : []);

  function syncPaperButtons() {
    $$("[data-paper]").forEach((card) => {
      const button = $(".save-paper", card);
      if (!button) return;
      const saved = savedPapers.has(card.dataset.id);
      button.setAttribute("aria-pressed", String(saved));
      button.textContent = saved ? "✓ À lire" : "＋ À lire";
    });
  }

  function filterPapers() {
    const query = normalizeText($("#library-search")?.value);
    const access = $("#access-filter")?.value || "all";
    const component = $("#component-filter")?.value || "all";
    const savedMode = $("#saved-filter")?.value || "all";
    let visible = 0;

    $$("[data-paper]").forEach((card) => {
      const matchesQuery = !query || normalizeText(`${card.dataset.search} ${card.textContent}`).includes(query);
      const matchesAccess = access === "all" || card.dataset.access === access;
      const components = (card.dataset.component || "").split(/\s+/);
      const matchesComponent = component === "all" || components.includes(component);
      const isSaved = savedPapers.has(card.dataset.id);
      const matchesSaved = savedMode === "all" || (savedMode === "saved" ? isSaved : !isSaved);
      const show = matchesQuery && matchesAccess && matchesComponent && matchesSaved;
      card.hidden = !show;
      if (show) visible += 1;
    });

    $("#library-count").textContent = String(visible);
    $("#library-empty").hidden = visible !== 0;
  }

  function initializeLibrary() {
    ["#library-search", "#access-filter", "#component-filter", "#saved-filter"].forEach((selector) => {
      $(selector)?.addEventListener("input", filterPapers);
      $(selector)?.addEventListener("change", filterPapers);
    });
    $("#paper-grid")?.addEventListener("click", (event) => {
      const button = event.target.closest(".save-paper");
      if (!button) return;
      const card = button.closest("[data-paper]");
      if (!card) return;
      if (savedPapers.has(card.dataset.id)) savedPapers.delete(card.dataset.id);
      else savedPapers.add(card.dataset.id);
      writeJSON(STORAGE.savedPapers, [...savedPapers]);
      syncPaperButtons();
      filterPapers();
      showToast(savedPapers.has(card.dataset.id) ? "Ajouté à la liste de lecture." : "Retiré de la liste de lecture.");
    });
    syncPaperButtons();
    filterPapers();
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function readerHref(key) {
    return `reader.html?k=${encodeURIComponent(key)}`;
  }

  function safeWebUrl(value) {
    try {
      const url = new URL(String(value));
      return ["https:", "http:"].includes(url.protocol) ? url.href : null;
    } catch (_error) {
      return null;
    }
  }

  function normalizePaperCollection(raw) {
    if (Array.isArray(raw)) return raw;
    if (!raw || typeof raw !== "object") return [];
    for (const key of ["items", "records", "papers", "results"]) {
      if (Array.isArray(raw[key])) return raw[key];
    }
    return [];
  }

  function verifiedPaperAnalysis(paper) {
    const analysis = paper?.paper_analysis;
    return analysis && typeof analysis === "object" && analysis.verification_status === "verified"
      ? analysis
      : null;
  }

  function verifiedAccessCategory(analysis) {
    if (!analysis) return "unknown";
    const categories = new Map([
      ["hard-label", "hard"],
      ["hard_label", "hard"],
      ["hard label", "hard"],
      ["decision-based", "hard"],
      ["decision_based", "hard"],
      ["decision based", "hard"],
      ["label-only", "hard"],
      ["label_only", "hard"],
      ["label only", "hard"],
      ["score-based", "score"],
      ["score_based", "score"],
      ["score based", "score"],
      ["soft-label", "score"],
      ["soft_label", "score"],
      ["soft label", "score"],
    ]);
    return categories.get(String(analysis.access_regime || "").trim().toLowerCase()) || "unknown";
  }

  function hasVerifiedDetail(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return normalized !== "" && !["unknown", "none", "n/a", "not applicable"].includes(normalized);
  }

  function renderBackendPapers(rawPapers) {
    const papers = normalizePaperCollection(rawPapers);
    if (!papers.length) return;
    const grid = $("#paper-grid");
    if (!grid) return;
    grid.replaceChildren();

    papers.forEach((paper, index) => {
      if (!paper || typeof paper !== "object") return;
      const title = String(paper.title || paper.name || `Référence ${index + 1}`);
      const authors = Array.isArray(paper.authors) ? paper.authors.join(", ") : String(paper.authors || "Auteurs à vérifier");
      const statusValue = String(paper.status || paper.stage || "seed");
      const statusLabel = statusValue.replace(/[_-]+/g, " ");
      const venue = String(paper.venue || paper.source || "Source à vérifier");
      const year = paper.year ? String(paper.year) : "s. d.";
      const summary = String(paper.summary || paper.abstract || "Résumé non fourni dans le snapshot.");
      const inFormalReview = paper.inFormalReview === true;
      const analysis = verifiedPaperAnalysis(paper);
      const access = verifiedAccessCategory(analysis);
      const componentList = [];
      if (hasVerifiedDetail(analysis?.importance_method)) componentList.push("wir");
      if (hasVerifiedDetail(analysis?.search_method)) componentList.push("search");
      if (hasVerifiedDetail(analysis?.perturbation_space)) componentList.push("candidates");
      const components = componentList.join(" ");
      const id = String(paper.id || paper.key || `${normalizeText(title).replace(/[^a-z0-9]+/g, "-")}-${index}`);

      const card = element("article", "paper-card");
      card.dataset.paper = "";
      card.dataset.id = id;
      card.dataset.access = access;
      card.dataset.component = components;
      card.dataset.corpus = inFormalReview ? "formal" : "candidate";
      card.dataset.search = `${title} ${authors} ${summary}`;

      const top = element("div", "paper-top");
      const corpusLabel = inFormalReview ? "Corpus formel" : "Candidat / pilote";
      const badge = element(
        "span",
        `status ${inFormalReview ? "cyan" : "neutral"}`,
        `${corpusLabel} · ${statusLabel}`,
      );
      top.append(badge, element("span", "", `${venue} · ${year}`));
      card.append(top, element("h2", "", title));
      if (paper.titleFr) card.append(element("p", "fr-line", `🇫🇷 ${paper.titleFr}`));
      card.append(element("p", "authors", authors), element("p", "", summary));
      if (paper.abstractFr) {
        const french = element("details", "fr-details");
        french.append(element("summary", "", "🇫🇷 Résumé en français"), element("p", "", paper.abstractFr));
        card.append(french);
      }
      card.dataset.search += ` ${paper.titleFr || ""} ${paper.abstractFr || ""}`;

      const tagRow = element("div", "tag-row");
      const scientificTags = analysis
        ? [access === "hard" ? "hard-label" : access === "score" ? "score-based" : "accès vérifié · autre", ...componentList]
        : ["cadre à vérifier"];
      scientificTags.forEach((tag) => tagRow.append(element("span", "", tag)));
      if (paper.ai && typeof paper.ai === "object") {
        const verdict = { include: "IA : garder", exclude: `IA : exclure ${paper.ai.code || ""}`, uncertain: "IA : incertain" }[paper.ai.decision] || "IA";
        const aiTag = element("span", "ai-tag", `${verdict} · ${paper.ai.relevance ?? "?"}/5`);
        aiTag.title = String(paper.ai.rationale || "");
        tagRow.append(aiTag);
      }
      if (paper.triage && typeof paper.triage === "object") {
        const human = { include: "toi : gardé", exclude: `toi : exclu ${paper.triage.code || ""}`, uncertain: "toi : incertain", later: "toi : plus tard" }[paper.triage.decision];
        if (human) tagRow.append(element("span", "human-tag", human));
      }
      const supervisorPick = Array.isArray(paper.tags) && paper.tags.includes("encadrant");
      if (supervisorPick) tagRow.append(element("span", "human-tag", "🎓 encadrant"));
      card.append(tagRow);
      card.dataset.search += ` ${paper.ai?.rationale || ""}${supervisorPick ? " encadrant" : ""}`;

      const actions = element("div", "card-actions");
      const sourceUrl = safeWebUrl(paper.url || paper.source_url || paper.doi_url || paper.pdfUrl);
      if (sourceUrl) {
        const link = element("a", "", "Source primaire");
        link.href = sourceUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        actions.append(link);
      } else {
        actions.append(element("span", "microcopy", "Lien à vérifier"));
      }
      if (paper.sheet && paper.key) {
        const sheetLink = element("a", "", "Fiche IA");
        sheetLink.href = `#fiches/${encodeURIComponent(paper.key)}`;
        actions.append(sheetLink);
      }
      if (paper.readerUrl && paper.key) {
        const readerLink = element("a", "", "📖 Lire (FR/EN)");
        readerLink.href = readerHref(paper.key);
        actions.append(readerLink);
      }
      const save = element("button", "save-paper", "＋ À lire");
      save.type = "button";
      save.setAttribute("aria-pressed", "false");
      actions.append(save);
      card.append(actions);
      grid.append(card);
    });

    const intro = $("#library-title")?.nextElementSibling;
    if (intro) {
      intro.textContent = "Références chargées depuis le snapshot ; les badges séparent le corpus formel des candidats et pilotes.";
    }
    const note = $(".seed-note");
    if (note) {
      note.textContent = "Seules les références liées à une collecte de revue formelle valide alimentent PRISMA. Les candidats et pilotes restent hors corpus.";
    }
    syncPaperButtons();
    filterPapers();
  }

  function normalizePrisma(raw) {
    if (!raw || typeof raw !== "object") return null;
    const value = (keys) => {
      for (const key of keys) {
        if (raw[key] !== undefined) return safeInteger(raw[key]);
      }
      return 0;
    };
    return {
      identified: value(["identified", "records_identified", "identifiees"]),
      uniqueRecords: value(["uniqueRecords", "unique_records", "records_after_duplicates"]),
      duplicates: value(["duplicates", "duplicates_removed", "doublons"]),
      screened: value(["screened", "records_screened", "criblees"]),
      excluded: value(["excluded", "excluded_screen", "screen_excluded", "excluded_title_abstract"]),
      reportsSought: value(["reportsSought", "reports_sought", "sought"]),
      reportsNotRetrieved: value(["reportsNotRetrieved", "reports_not_retrieved", "not_retrieved"]),
      assessed: value(["assessed", "reports_assessed", "full_text_assessed"]),
      fullExcluded: value(["fullExcluded", "full_excluded", "reports_excluded", "excluded_full_text"]),
      included: value(["included", "studies_included", "incluses"]),
      pendingScreening: value(["pendingScreening", "pending_screening"]),
      pendingDecision: value(["pendingDecision", "pending_decision"]),
    };
  }

  function prismaWarnings(values) {
    const warnings = [];
    if (values.duplicates > values.identified) warnings.push("les doublons dépassent les références identifiées");
    if (values.screened > Math.max(0, values.identified - values.duplicates)) warnings.push("le criblage dépasse le corpus dédoublonné");
    if (values.excluded > values.screened) warnings.push("les exclusions au tri dépassent les références criblées");
    if (values.reportsSought > Math.max(0, values.screened - values.excluded)) warnings.push("les rapports recherchés dépassent les références retenues au tri");
    if (values.reportsNotRetrieved > values.reportsSought) warnings.push("les rapports non récupérés dépassent les rapports recherchés");
    if (values.assessed > Math.max(0, values.reportsSought - values.reportsNotRetrieved)) warnings.push("les textes évalués dépassent les rapports récupérés");
    if (values.fullExcluded > values.assessed) warnings.push("les textes exclus dépassent les textes évalués");
    if (values.included > Math.max(0, values.assessed - values.fullExcluded)) warnings.push("les inclusions dépassent les textes éligibles restants");
    return warnings;
  }

  function renderPrisma() {
    Object.entries(state.prisma).forEach(([key, value]) => {
      $$(`[data-prisma-output="${key}"]`).forEach((output) => {
        output.textContent = String(value);
      });
    });
    $("#cockpit-included").textContent = String(state.prisma.included);

    const message = $("#prisma-validation");
    const warnings = prismaWarnings(state.prisma);
    const allZero = Object.values(state.prisma).every((value) => value === 0);
    message.classList.toggle("is-warning", warnings.length > 0);
    if (warnings.length) message.textContent = `À vérifier : ${warnings.join(" ; ")}.`;
    else if (allZero) message.textContent = "État initial cohérent : tous les compteurs sont à zéro.";
    else message.textContent = "Les relations principales du flux sont cohérentes.";
  }

  function initializePrisma() {
    state.prisma = { ...DEFAULT_PRISMA };
    renderPrisma();
  }

  function buildProtocolFromForm() {
    const form = $("#experiment-form");
    const methods = $$("input[name='methods']:checked", form).map((input) => input.value);
    if (!methods.length) {
      showToast("Choisissez au moins une heuristique WIR.");
      return null;
    }
    const data = new FormData(form);
    return {
      status: "non_execute",
      objective: "Comparer des heuristiques WIR avec accès strictement hard-label",
      threat_model: {
        oracle_output: "discrete_label_only",
        scores: false,
        logits: false,
        gradients: false,
      },
      dataset: data.get("dataset"),
      target_model: data.get("model"),
      max_queries_per_example: safeInteger(data.get("budget")),
      random_seed: safeInteger(data.get("seed")),
      methods,
      metrics_planned: ["attack_success_rate", "queries", "perturbation_rate", "semantic_similarity", "runtime"],
      results: null,
    };
  }

  function renderProtocol(protocol) {
    state.protocol = protocol;
    $("#protocol-json").textContent = JSON.stringify(protocol, null, 2);
    $("#copy-protocol").disabled = false;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_error) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      return copied;
    }
  }

  function initializeExperiments() {
    $("#experiment-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const protocol = buildProtocolFromForm();
      if (!protocol) return;
      renderProtocol(protocol);
      showToast("Plan généré — aucune expérience n’a été lancée.");
    });
    $("#copy-protocol")?.addEventListener("click", async () => {
      if (!state.protocol) return;
      const copied = await copyText(JSON.stringify(state.protocol, null, 2));
      showToast(copied ? "Plan copié." : "Copie impossible : sélectionnez le texte manuellement.");
    });
  }

  function normalizeVocabulary(raw) {
    const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.items) ? raw.items : [];
    return list
      .filter((item) => item && (item.term || item.word))
      .map((item) => ({
        term: String(item.term || item.word),
        type: String(item.type || item.part_of_speech || "term"),
        fr: String(item.fr || item.translation || item.definition_fr || item.definition || "Traduction à compléter"),
        synonyms: Array.isArray(item.synonyms) ? item.synonyms.map(String) : item.synonyms ? [String(item.synonyms)] : [],
        example: String(item.example || item.sentence || "Exemple à compléter dans le carnet."),
        definition: String(item.definition || ""),
        definitionFr: String(item.definitionFr || ""),
        exampleFr: String(item.exampleFr || ""),
        snapshotProgress: {
          repetitions: safeInteger(item.repetitions),
          interval: safeInteger(item.intervalDays ?? item.interval_days),
          ease: Number.isFinite(Number(item.easeFactor ?? item.ease_factor)) ? Number(item.easeFactor ?? item.ease_factor) : 2.5,
          due: localDateISO(item.dueAt || item.due_at || todayISO()),
        },
      }));
  }

  function localDateISO(value = new Date()) {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return todayISO();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function todayISO() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function addDaysISO(days) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + days);
    return localDateISO(date);
  }

  function wordProgress(term) {
    const progress = state.vocabularyProgress[term];
    if (progress && typeof progress === "object") return progress;
    const snapshot = state.vocabulary.find((word) => word.term === term)?.snapshotProgress;
    return snapshot || { repetitions: 0, interval: 0, ease: 2.5, due: todayISO() };
  }

  function dueWords() {
    const today = todayISO();
    return state.vocabulary
      .filter((word) => wordProgress(word.term).due <= today)
      .sort((a, b) => wordProgress(a.term).due.localeCompare(wordProgress(b.term).due));
  }

  let sessionWords = [];
  let sessionIndex = 0;

  function makeSession() {
    const due = dueWords();
    const source = due.length
      ? due
      : [...state.vocabulary].sort((a, b) => wordProgress(a.term).due.localeCompare(wordProgress(b.term).due));
    sessionWords = source.slice(0, Math.min(5, source.length));
    sessionIndex = 0;
    renderVocabulary();
  }

  function renderVocabList() {
    const list = $("#vocab-list");
    if (!list) return;
    list.replaceChildren();
    state.vocabulary.forEach((word, index) => {
      const progress = wordProgress(word.term);
      const row = element("li");
      row.append(element("span", "", String(index + 1).padStart(2, "0")));
      const text = element("div");
      text.append(element("b", "", word.term), element("small", "", word.fr));
      row.append(text);
      const dueDate = new Date(`${progress.due}T12:00:00`);
      const time = element("time", "", progress.due <= todayISO() ? "dû" : formatDate(dueDate));
      time.dateTime = progress.due;
      row.append(time);
      list.append(row);
    });
  }

  function renderVocabularyStats() {
    const due = dueWords().length;
    const learned = state.vocabulary.filter((word) => wordProgress(word.term).repetitions > 0).length;
    const next = state.vocabulary
      .map((word) => wordProgress(word.term).due)
      .sort()[0];
    $("#due-count").textContent = String(due);
    $("#cockpit-due").textContent = String(due);
    $("#learned-count").textContent = String(learned);
    $("#next-review").textContent = !next || next <= todayISO() ? "Aujourd’hui" : formatDate(new Date(`${next}T12:00:00`), { day: "numeric", month: "long" });
  }

  function renderVocabulary() {
    renderVocabularyStats();
    renderVocabList();
    const panel = $("#flashcard-panel");
    if (!panel) return;
    const done = sessionIndex >= sessionWords.length || sessionWords.length === 0;
    $("#session-done").hidden = !done;
    $("#flashcard").hidden = done;
    $("#reveal-answer").hidden = done;
    $("#grade-row").hidden = true;
    $("#word-answer").hidden = true;
    $("#session-progress").textContent = String(Math.min(sessionIndex, sessionWords.length));

    if (done) return;
    const word = sessionWords[sessionIndex];
    $("#card-position").textContent = `${sessionIndex + 1} / ${sessionWords.length}`;
    $("#word-type").textContent = word.type;
    $("#word-term").textContent = word.term;
    $("#word-fr").textContent = word.fr;
    $("#word-synonyms").textContent = word.synonyms.length ? word.synonyms.join(" · ") : "—";
    $("#word-example").textContent = word.example;
    for (const [id, value] of [["definition", word.definition], ["definition-fr", word.definitionFr]]) {
      const target = $(`#word-${id}`);
      if (target) target.textContent = value || "";
      const row = $(`#word-${id}-row`);
      if (row) row.hidden = !value;
    }
    const exampleFr = $("#word-example-fr");
    if (exampleFr) {
      exampleFr.textContent = word.exampleFr ? `🇫🇷 « ${word.exampleFr} »` : "";
      exampleFr.hidden = !word.exampleFr;
    }
  }

  function revealVocabularyAnswer() {
    if (sessionIndex >= sessionWords.length) return;
    $("#word-answer").hidden = false;
    $("#reveal-answer").hidden = true;
    $("#grade-row").hidden = false;
    $("#grade-row button")?.focus();
  }

  function reviewCurrentWord(grade) {
    const word = sessionWords[sessionIndex];
    if (!word || $("#word-answer").hidden) return;
    const qualityMap = { again: 1, hard: 3, good: 4, easy: 5 };
    const quality = qualityMap[grade];
    if (!quality) return;
    const previous = wordProgress(word.term);
    let repetitions = previous.repetitions || 0;
    let interval = previous.interval || 0;
    let ease = previous.ease || 2.5;

    ease = Math.max(1.3, ease + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
    if (quality < 3) {
      repetitions = 0;
      interval = 1;
    } else {
      repetitions += 1;
      if (repetitions === 1) interval = 1;
      else if (repetitions === 2) interval = 3;
      else interval = Math.max(1, Math.round(interval * ease));
    }

    state.vocabularyProgress[word.term] = {
      repetitions,
      interval,
      ease: Number(ease.toFixed(2)),
      due: addDaysISO(interval),
      lastGrade: grade,
    };
    writeJSON(STORAGE.vocabulary, state.vocabularyProgress);
    sessionIndex += 1;
    renderVocabulary();
  }

  function initializeVocabulary() {
    const progress = readJSON(STORAGE.vocabulary, {});
    state.vocabularyProgress = progress && typeof progress === "object" ? progress : {};
    makeSession();
    $("#reveal-answer")?.addEventListener("click", revealVocabularyAnswer);
    $("#grade-row")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-grade]");
      if (button) reviewCurrentWord(button.dataset.grade);
    });
    $("#restart-session")?.addEventListener("click", makeSession);
    $("#reset-vocab")?.addEventListener("click", () => {
      if (!window.confirm("Effacer toutes les dates de révision enregistrées sur cet appareil ?")) return;
      state.vocabularyProgress = {};
      writeJSON(STORAGE.vocabulary, {});
      makeSession();
      showToast("Progression du vocabulaire réinitialisée.");
    });
    document.addEventListener("keydown", (event) => {
      if (currentRoute() !== "english") return;
      if (/^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(event.target.tagName)) return;
      if (event.code === "Space" && $("#word-answer")?.hidden === true) {
        event.preventDefault();
        revealVocabularyAnswer();
      }
      if (/^[1-4]$/.test(event.key) && $("#word-answer")?.hidden === false) {
        event.preventDefault();
        reviewCurrentWord(["again", "hard", "good", "easy"][Number(event.key) - 1]);
      }
    });
  }

  function normalizeRuns(raw) {
    if (Array.isArray(raw)) return raw;
    if (!raw || typeof raw !== "object") return [];
    for (const key of ["runs", "items", "records", "experiments"]) {
      if (Array.isArray(raw[key])) return raw[key];
    }
    return [];
  }

  function completedRun(run) {
    const status = normalizeText(run?.status || run?.state);
    return Boolean(run?.completedAt || run?.completed_at || run?.finishedAt || run?.finished_at) || ["completed", "complete", "executed", "done", "success", "termine", "execute"].includes(status);
  }

  function isSmokeRun(run) {
    return normalizeText(`${run?.name || ""} ${run?.dataset || ""}`).includes("smoke");
  }

  function metricValue(run, keys) {
    const metrics = run.metrics && typeof run.metrics === "object" ? run.metrics : {};
    for (const key of keys) {
      if (metrics[key] !== undefined && metrics[key] !== null) return String(metrics[key]);
      if (run[key] !== undefined && run[key] !== null) return String(run[key]);
    }
    return "—";
  }

  function renderCompletedRuns(raw) {
    const runs = normalizeRuns(raw).filter(completedRun);
    state.completedRuns = runs;
    const count = runs.length;
    const smokeCount = runs.filter(isSmokeRun).length;
    const onlySmoke = count > 0 && smokeCount === count;
    $("#cockpit-runs").textContent = String(count);
    const countBadge = $("#experiment-count-badge");
    countBadge.textContent = `${count} run${count > 1 ? "s" : ""}`;
    countBadge.classList.toggle("amber", onlySmoke);
    if (!count) return;
    $("#cockpit-runs-note").textContent = onlySmoke
      ? "tests smoke · aucune conclusion"
      : "runs présents dans le snapshot";
    const kicker = $("#experiment-kicker");
    kicker.replaceChildren(
      element("span"),
      document.createTextNode(
        onlySmoke
          ? `Banc d’essai · ${count} test${count > 1 ? "s" : ""} smoke`
          : `Banc d’essai · ${count} run${count > 1 ? "s" : ""} enregistré${count > 1 ? "s" : ""}`,
      ),
    );
    $("#results-title").textContent = onlySmoke ? "Résultats smoke enregistrés" : "Résultats enregistrés";
    $("#experiments-summary").textContent = onlySmoke
      ? "Ces exécutions synthétiques contrôlent le pipeline ; le benchmark scientifique reste à planifier."
      : "Consulter les runs enregistrés et préparer la prochaine comparaison reproductible.";
    const resultsStatus = $("#results-status");
    resultsStatus.textContent = onlySmoke ? "SMOKE · synthétique" : "Snapshot SQLite";
    resultsStatus.classList.toggle("amber", onlySmoke);
    resultsStatus.classList.toggle("cyan", !onlySmoke);
    const truth = $("#experiment-truth");
    truth.textContent = onlySmoke
      ? `${count} test${count > 1 ? "s" : ""} smoke synthétique${count > 1 ? "s" : ""} chargé${count > 1 ? "s" : ""}. Ils valident le pipeline technique et ne constituent pas des résultats scientifiques finaux.`
      : `${count} run${count > 1 ? "s" : ""} chargé${count > 1 ? "s" : ""} depuis le snapshot. Les métriques manquantes restent indiquées par un tiret.`;
    const tbody = $("#results-body");
    tbody.replaceChildren();
    runs.forEach((run, index) => {
      const row = document.createElement("tr");
      const smoke = isSmokeRun(run);
      const method = element("th", "run-cell");
      method.scope = "row";
      const methodTitle = element("div", "run-title");
      methodTitle.append(element("b", "", String(run.method || run.heuristic || `Run ${index + 1}`)));
      if (smoke) methodTitle.append(element("span", "status amber", "SMOKE"));
      method.append(methodTitle);
      method.append(
        element(
          "small",
          "",
          [run.name, run.dataset, run.model].filter(Boolean).map(String).join(" · ") || "Contexte non fourni",
        ),
      );
      row.append(
        method,
        element("td", "", metricValue(run, ["asr", "attack_success_rate"])),
        element("td", "", metricValue(run, ["queries", "mean_queries", "avg_queries"])),
        element(
          "td",
          "",
          metricValue(run, [
            "mean_changed_tokens",
            "mean_change_rate_successful",
            "perturbation_rate",
            "tokens_modified",
          ]),
        ),
        element("td", "", metricValue(run, ["semantic_similarity", "similarity"])),
      );
      const statusCell = document.createElement("td");
      statusCell.append(
        element("span", `status ${smoke ? "amber" : "cyan"}`, String(run.status || "Exécuté")),
      );
      row.append(statusCell);
      tbody.append(row);
    });
  }

  function updateCockpitFromPapers(rawPapers) {
    const papers = normalizePaperCollection(rawPapers);
    const analysed = papers.filter(
      (paper) => paper?.paper_analysis?.verification_status === "verified",
    ).length;
    $("#cockpit-analysed").textContent = String(analysed);
    const runs = state.completedRuns.length;
    if (analysed || runs || state.prisma.included) {
      const banner = $("#cockpit-truth");
      $(".truth-icon", banner).textContent = "✓";
      const paragraph = $("p", banner);
      paragraph.replaceChildren();
      paragraph.append(element("strong", "", "Snapshot du projet chargé. "));
      paragraph.append(document.createTextNode("Les compteurs affichent uniquement les éléments explicitement enregistrés ; les valeurs absentes restent à zéro."));
    }
  }

  function renderSnapshotHealth(snapshot) {
    const generated = snapshot.generatedAt ? new Date(snapshot.generatedAt) : null;
    $("#sync-time").textContent = generated && !Number.isNaN(generated.getTime())
      ? new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(generated)
      : "Date non fournie";

    const runs = Array.isArray(snapshot.searchRuns) ? snapshot.searchRuns : [];
    const errors = runs.filter((run) => normalizeText(run?.status) === "error" || String(run?.error || "").trim());
    const latest = [...runs].sort((a, b) => String(b.finishedAt || b.startedAt || "").localeCompare(String(a.finishedAt || a.startedAt || "")))[0];
    const latestOk = latest && normalizeText(latest.status) === "ok";
    const health = $("#search-health");
    health.classList.toggle("is-warning", errors.length > 0);
    if (!runs.length) {
      $("#search-health-text").textContent = "Aucun run de recherche";
    } else if (errors.length) {
      $("#search-health-text").textContent = `${errors.length} erreur${errors.length > 1 ? "s" : ""} consignée${errors.length > 1 ? "s" : ""} · dernier run ${latestOk ? "OK" : "en erreur"}`;
      const recentError = errors.sort((a, b) => String(b.finishedAt || "").localeCompare(String(a.finishedAt || "")))[0];
      if (recentError?.error) health.title = String(recentError.error);
    } else {
      $("#search-health-text").textContent = `${runs.length} collecte${runs.length > 1 ? "s" : ""} sans erreur`;
    }

    const evidence = snapshot.evidence && typeof snapshot.evidence === "object" ? snapshot.evidence : {};
    const exact = safeInteger(evidence.exact_quote);
    const valueOnly = safeInteger(evidence.value_only);
    const notFound = safeInteger(evidence.not_found);
    $("#evidence-health").textContent = `${exact} exacte${exact > 1 ? "s" : ""} · ${valueOnly} valeur seule · ${notFound} introuvable`;
  }

  async function loadBackendState() {
    try {
      const response = await fetch("data/state.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const snapshot = await response.json();
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("format invalide");
      state.backend = snapshot;
      $("#data-mode").textContent = "Snapshot projet + préférences locales";
      renderSnapshotHealth(snapshot);

      if (snapshot.papers) renderBackendPapers(snapshot.papers);
      if (snapshot.prisma) {
        const prisma = normalizePrisma(snapshot.prisma);
        if (prisma) {
          state.prisma = prisma;
          renderPrisma();
          $("#prisma-intro").textContent = `${prisma.identified} références identifiées, ${prisma.duplicates} doublons retirés et ${prisma.pendingScreening} références en attente de criblage dans le snapshot.`;
          const badge = $("#prisma-corpus-badge");
          badge.replaceChildren(element("b", "", String(prisma.uniqueRecords)));
          badge.append(document.createTextNode(" références uniques"));
        }
      }
      const vocabulary = normalizeVocabulary(snapshot.vocabulary);
      if (vocabulary.length) {
        state.vocabulary = vocabulary;
        makeSession();
      }
      if (snapshot.experiments) renderCompletedRuns(snapshot.experiments);
      if (snapshot.agents) renderAgents(snapshot.agents);
      if (snapshot.supervisor) {
        supervisorState = snapshot.supervisor;
        renderSupervisor();
      }
      if (snapshot.protocol && typeof snapshot.protocol === "object") {
        const protocol = snapshot.protocol;
        const status = protocol.status === "validated" ? "validé par l’encadrant" : "provisoire, à faire valider par l’encadrant";
        $("#prisma-intro").textContent += ` Protocole ${protocol.version} (${status}), empreinte SHA-256 ${String(protocol.sha256 || "").slice(0, 12)}…`;
      }
      updateCockpitFromPapers(snapshot.papers);
      const generated = snapshot.generatedAt ? new Date(snapshot.generatedAt) : null;
      $("#prisma-status").textContent = generated && !Number.isNaN(generated.getTime())
        ? `Snapshot · ${formatDate(generated)}`
        : "Snapshot chargé";
    } catch (_error) {
      $("#data-mode").textContent = "Mode local · seeds explicites";
    }
  }

  // ─── Agents IA, fiches, comparatif, rédaction ──────────────────────────────

  const ACCESS_LABELS = {
    "hard-label": "hard-label",
    "score-based": "score-based",
    "white-box": "white-box",
    mixed: "mixte",
    "not-applicable": "non applicable",
    unknown: "à vérifier",
  };
  const TASK_LABELS = { screening: "Trieur", reading: "Lecteur", synthesis: "Synthèse", news: "Veilleur", translation: "Traducteur", pipeline: "Pipeline" };
  const ELIGIBILITY_LABELS = { include: "garder", exclude: "exclure", uncertain: "incertain" };

  let sheetsState = { sheets: [], synthesis: null };
  let learningState = null;
  let supervisorState = null;
  let newsState = [];

  function formatDateTime(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
  }

  function textList(items, emptyText = "Non précisé.") {
    const list = element("ul", "plain-list");
    const values = Array.isArray(items) ? items.filter((item) => String(item || "").trim()) : [];
    if (!values.length) list.append(element("li", "microcopy", emptyText));
    values.forEach((item) => list.append(element("li", "", String(item))));
    return list;
  }

  function checkBadge(check) {
    if (!check) return element("span", "check-badge none", "non vérifié");
    const labels = { exact_quote: "✓ trouvé", value_only: "≈ valeur seule", not_found: "✗ introuvable" };
    const kinds = { exact_quote: "ok", value_only: "approx", not_found: "missing" };
    const page = check.page ? ` p. ${check.page}` : "";
    return element("span", `check-badge ${kinds[check.status] || "none"}`, `${labels[check.status] || check.status}${page}`);
  }

  function renderAgents(agents) {
    const runs = Array.isArray(agents.runs) ? agents.runs : [];
    $("#agents-screened").textContent = String(safeInteger(agents.screenedPapers));
    $("#agents-sheets").textContent = String(safeInteger(agents.sheets));
    $("#agents-queue").textContent = String(safeInteger(agents.readingQueue));
    $("#agents-last").textContent = agents.lastSuccessAt ? formatDateTime(agents.lastSuccessAt) : "—";
    const latest = runs[0];
    const waiting = latest && latest.task === "pipeline" && latest.status === "skipped";
    $("#agents-token").hidden = !waiting;
    const status = $("#agents-status");
    status.textContent = waiting ? "En attente de la clé IA" : agents.lastSuccessAt ? `Actifs · ${formatDateTime(agents.lastSuccessAt)}` : "Aucun passage";
    status.className = `status large ${waiting ? "amber" : agents.lastSuccessAt ? "cyan" : "neutral"}`;
    const totals = agents.totals || {};
    for (const task of ["screening", "reading", "synthesis", "news", "translation"]) {
      const node = $(`#agent-${task}`);
      if (!node) continue;
      const total = totals[task];
      node.textContent = total ? `${total.ok} réussi(s) · ${total.error} erreur(s)` : "pas encore lancé";
    }
    const collect = $("#agent-collect");
    if (collect && state.backend?.searchRuns) {
      const ok = state.backend.searchRuns.filter((run) => run.status === "ok").length;
      collect.textContent = `${ok} collecte(s) réussie(s)`;
    }
    const body = $("#agents-log");
    body.replaceChildren();
    if (!runs.length) {
      const row = element("tr");
      const cell = element("td", "", "Aucun passage enregistré.");
      cell.colSpan = 7;
      row.append(cell);
      body.append(row);
    }
    runs.forEach((run) => {
      const row = element("tr");
      const statusCell = element("td");
      const kind = run.status === "ok" ? "cyan" : run.status === "skipped" ? "amber" : "danger";
      statusCell.append(element("span", `status ${kind}`, run.status === "ok" ? "OK" : run.status === "skipped" ? "en attente" : "erreur"));
      const seconds = run.durationMs ? `${Math.round(run.durationMs / 1000)} s` : "—";
      row.append(
        element("td", "", formatDateTime(run.startedAt)),
        element("td", "", TASK_LABELS[run.task] || run.task),
        element("td", "", run.target || "—"),
        statusCell,
        element("td", "", run.model || "—"),
        element("td", "", seconds),
        element("td", "", run.detail || ""),
      );
      body.append(row);
    });
    $("#agents-log-count").textContent = `${runs.length} entrée${runs.length > 1 ? "s" : ""}`;
    const health = $("#agents-health");
    if (health) {
      health.replaceChildren();
      const link = element("a", "", waiting ? "En attente de la clé IA" : `${safeInteger(agents.sheets)} fiche(s) · ${safeInteger(agents.screenedPapers)} pré-triés`);
      link.href = "#agents";
      health.append(link);
    }
  }

  function sheetAccess(item) {
    return String(item?.sheet?.acces_oracle?.regime || "unknown");
  }

  function renderSheetsGrid() {
    const grid = $("#sheets-grid");
    if (!grid) return;
    const query = normalizeText($("#sheets-search")?.value);
    const accessFilter = $("#sheets-access")?.value || "all";
    grid.replaceChildren();
    let visible = 0;
    sheetsState.sheets.forEach((item) => {
      const sheet = item.sheet || {};
      const access = sheetAccess(item);
      const haystack = normalizeText(`${item.title} ${(item.authors || []).join(" ")} ${sheet.resume_simple} ${sheet.methode} ${(sheet.evaluation?.datasets || []).join(" ")}`);
      const accessOk = accessFilter === "all" || access === accessFilter || (accessFilter === "other" && !["hard-label", "score-based", "white-box"].includes(access));
      if ((query && !haystack.includes(query)) || !accessOk) return;
      visible += 1;
      const card = element("article", `paper-card${access === "hard-label" ? " priority" : ""}`);
      const top = element("div", "paper-top");
      top.append(
        element("span", `status ${access === "hard-label" ? "cyan" : "neutral"}`, ACCESS_LABELS[access] || access),
        element("span", "", `${item.venue || "source ?"} · ${item.year || "s. d."}`),
      );
      const summary = item.checks?.summary || {};
      const tags = element("div", "tag-row");
      tags.append(
        element("span", "", `pertinence ${sheet.pertinence_pfe?.score ?? "?"}/5`),
        element("span", "", `IA : ${ELIGIBILITY_LABELS[sheet.eligibilite?.suggestion] || "?"}`),
        element("span", "", `citations ✓${summary.exact_quote ?? 0} ≈${summary.value_only ?? 0} ✗${summary.not_found ?? 0}`),
      );
      const actions = element("div", "card-actions");
      const open = element("a", "", "Lire la fiche");
      open.href = `#fiches/${encodeURIComponent(item.key)}`;
      actions.append(open);
      if (item.pdfUrl) {
        const reader = element("a", "", "📖 Article FR/EN");
        reader.href = readerHref(item.key);
        actions.append(reader);
      }
      const source = safeWebUrl(item.url || item.pdfUrl);
      if (source) {
        const link = element("a", "", "Source");
        link.href = source;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        actions.append(link);
      }
      card.append(
        top,
        element("h2", "", item.title),
        element("p", "authors", (item.authors || []).slice(0, 6).join(", ") || "Auteurs à vérifier"),
        element("p", "", String(sheet.resume_simple || "").slice(0, 420)),
        tags,
        actions,
      );
      grid.append(card);
    });
    $("#sheets-count").textContent = String(sheetsState.sheets.length);
    $("#sheets-empty").hidden = visible > 0;
    if (!sheetsState.sheets.length) $("#sheets-empty").hidden = false;
  }

  function section(title, ...children) {
    const wrap = element("section", "sheet-section");
    wrap.append(element("h3", "", title), ...children);
    return wrap;
  }

  function renderSheetDetail(key) {
    const panel = $("#sheet-detail");
    if (!panel) return;
    const item = key ? sheetsState.sheets.find((candidate) => candidate.key === key) : null;
    if (!item) {
      panel.hidden = true;
      panel.replaceChildren();
      return;
    }
    const sheet = item.sheet || {};
    const checks = Array.isArray(item.checks?.citations) ? item.checks.citations : [];
    const checkFor = (field) => checks.find((check) => check.field === field);
    panel.replaceChildren();

    const head = element("div", "panel-head");
    const titles = element("div");
    titles.append(element("p", "overline", `Fiche de lecture · ${item.year || "s. d."} · ${item.venue || ""}`), element("h2", "", item.title));
    const close = element("a", "text-button", "✕ Fermer");
    close.href = "#fiches";
    head.append(titles, close);
    panel.append(head);
    panel.append(element("p", "authors", (item.authors || []).join(", ")));

    const warning = element("p", "seed-note");
    warning.append(element("b", "", "Brouillon IA à vérifier. "), document.createTextNode(`Écrit par ${item.model || "un modèle IA"} le ${formatDateTime(item.createdAt)} à partir du texte intégral (PDF SHA-256 ${String(item.documentSha256 || "").slice(0, 12)}…). Ne cite que ce qui est marqué ✓ après relecture.`));
    panel.append(warning);

    const links = element("div", "card-actions");
    if (item.pdfUrl) {
      const reader = element("a", "", "📖 Lire l’article traduit (même mise en page)");
      reader.href = readerHref(item.key);
      links.append(reader);
    }
    for (const [label, url] of [["Source", item.url], ["PDF", item.pdfUrl]]) {
      const safe = safeWebUrl(url);
      if (!safe) continue;
      const link = element("a", "", label);
      link.href = safe;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      links.append(link);
    }
    panel.append(links);

    panel.append(section("En bref (pour débutant)", element("p", "", sheet.resume_simple || "—")));
    panel.append(section("Problème", element("p", "", sheet.probleme || "—")));
    panel.append(section("Contributions", textList(sheet.contributions)));
    panel.append(section("Méthode", element("p", "", sheet.methode || "—")));

    const access = sheet.acces_oracle || {};
    const accessBlock = element("div");
    accessBlock.append(element("p", "", `${ACCESS_LABELS[access.regime] || access.regime || "?"} — ${access.justification || ""}`));
    if (access.citation) {
      const quote = element("blockquote", "", `« ${access.citation} » `);
      quote.append(checkBadge(checkFor("acces_oracle")));
      accessBlock.append(quote);
    }
    panel.append(section("Accès de l’attaquant (oracle)", accessBlock));

    const components = sheet.composants || {};
    const dl = element("dl", "kv-grid");
    for (const [label, value] of [
      ["Classement des mots (WIR)", components.wir],
      ["Candidats de substitution", components.candidats],
      ["Filtres / contraintes", components.filtres],
      ["Stratégie de recherche", components.recherche],
      ["Budget de requêtes", components.budget_requetes],
    ]) {
      const row = element("div");
      row.append(element("dt", "", label), element("dd", "", value || "—"));
      dl.append(row);
    }
    panel.append(section("Composants de l’attaque", dl));

    const grid = sheet.grille_hard_label;
    if (grid && typeof grid === "object") {
      const gridList = element("dl", "kv-grid");
      for (const [label, value] of [
        ["Initialisation", grid.initialisation],
        ["Réduction de l’espace de recherche", grid.reduction_espace],
        ["Optimisation", grid.optimisation],
        ["Filtres avant requête", grid.filtres_avant_requete],
        ["Importance des mots", grid.importance_mots],
      ]) {
        const row = element("div");
        row.append(element("dt", "", label), element("dd", "", value || "—"));
        gridList.append(row);
      }
      panel.append(section("Grille hard-label (étapes communes des attaques récentes)", gridList));
    }

    const evaluation = sheet.evaluation || {};
    const evalGrid = element("dl", "kv-grid");
    for (const [label, values] of [
      ["Datasets", evaluation.datasets],
      ["Modèles attaqués", evaluation.modeles_cibles],
      ["Métriques", evaluation.metriques],
      ["Baselines", evaluation.baselines],
    ]) {
      const row = element("div");
      row.append(element("dt", "", label), element("dd", "", (values || []).join(", ") || "—"));
      evalGrid.append(row);
    }
    panel.append(section("Évaluation", evalGrid));

    const resultsWrap = element("div", "table-wrap");
    const table = element("table");
    const thead = element("thead");
    const headRow = element("tr");
    ["Résultat", "Valeur", "Citation dans l’article", "Vérification"].forEach((label) => headRow.append(element("th", "", label)));
    thead.append(headRow);
    const tbody = element("tbody");
    (sheet.resultats || []).forEach((result, index) => {
      const row = element("tr");
      const badge = element("td");
      badge.append(checkBadge(checkFor(`resultats[${index}]`)));
      row.append(element("td", "", result.affirmation || ""), element("td", "", result.valeur || ""), element("td", "", result.citation || "(dans un tableau)"), badge);
      tbody.append(row);
    });
    table.append(thead, tbody);
    resultsWrap.append(table);
    panel.append(section("Résultats annoncés", resultsWrap));

    const critique = element("div", "guide-grid");
    for (const [label, values] of [
      ["Points forts", sheet.points_forts],
      ["Faiblesses", sheet.faiblesses],
      ["Menaces à la validité", sheet.menaces_validite],
      ["Limites déclarées par les auteurs", sheet.limites_auteurs],
    ]) {
      const box = element("div");
      box.append(element("h4", "", label), textList(values));
      critique.append(box);
    }
    panel.append(section("Regard critique", critique));

    const repro = sheet.reproductibilite || {};
    const reproText = element("p", "", `${repro.code_disponible === true ? "Code publié" : repro.code_disponible === false ? "Code non publié" : "Disponibilité du code non précisée"}. ${repro.commentaire || ""}`);
    const reproBlock = element("div");
    reproBlock.append(reproText);
    const codeUrl = safeWebUrl(repro.lien_code);
    if (codeUrl) {
      const link = element("a", "", codeUrl);
      link.href = codeUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      reproBlock.append(link);
    }
    panel.append(section("Reproductibilité", reproBlock));

    const quality = sheet.qualite || {};
    const qualityLabels = {
      menace_definie: "Menace définie",
      budget_complet: "Budget complet",
      baselines_comparables: "Baselines comparables",
      contraintes_operationnalisees: "Contraintes opérationnalisées",
      echantillon_decrit: "Échantillon décrit",
      variance_ou_ic: "Variance / IC",
      reproductible: "Reproductible",
      limites_rapportees: "Limites rapportées",
    };
    const qualityGrid = element("div", "quality-grid");
    let score = 0;
    Object.entries(qualityLabels).forEach(([field, label]) => {
      const ok = Number(quality[field]) === 1;
      score += ok ? 1 : 0;
      qualityGrid.append(element("span", ok ? "q-ok" : "q-ko", `${ok ? "✓" : "✗"} ${label}`));
    });
    panel.append(section(`Qualité (protocole) · ${score}/8`, qualityGrid));

    const eligibility = sheet.eligibilite || {};
    panel.append(section("Éligibilité suggérée par l’IA", element("p", "", `${ELIGIBILITY_LABELS[eligibility.suggestion] || "?"}${eligibility.code_exclusion ? ` (${eligibility.code_exclusion})` : ""} — ${eligibility.justification || ""} La décision reste la tienne (bouton sur Telegram).`)));

    const relevance = sheet.pertinence_pfe || {};
    panel.append(section(`Pertinence pour ton PFE · ${relevance.score ?? "?"}/5`, element("p", "", `${(relevance.questions || []).join(", ")} — ${relevance.pourquoi || ""}`)));
    panel.append(section("Pistes de contribution pour ton PFE", textList(sheet.pistes_contribution)));

    const sentence = element("div");
    sentence.append(element("blockquote", "", sheet.phrase_etat_de_lart || "—"));
    const copy = element("button", "text-button", "Copier la phrase");
    copy.type = "button";
    copy.addEventListener("click", () => copyText(sheet.phrase_etat_de_lart || ""));
    sentence.append(copy);
    panel.append(section("Phrase pour l’état de l’art (à reformuler)", sentence));

    const vocab = element("ul", "plain-list");
    (sheet.vocabulaire || []).forEach((word, index) => {
      const line = element("li");
      line.append(element("b", "", word.terme || ""), document.createTextNode(` = ${word.traduction_fr || ""} — 🇬🇧 ${word.definition_en || ""} `));
      if (word.definition_fr) line.append(element("span", "fr-line", `🇫🇷 ${word.definition_fr} `));
      if (word.exemple_en) line.append(element("i", "", `« ${word.exemple_en} » `));
      line.append(checkBadge(checkFor(`vocabulaire[${index}]`)));
      if (word.exemple_fr) line.append(element("span", "fr-line", ` 🇫🇷 « ${word.exemple_fr} »`));
      vocab.append(line);
    });
    panel.append(section("Vocabulaire anglais (ajouté à l’English Lab)", vocab));

    panel.hidden = false;
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function fillChecklist(selector, items, renderItem) {
    const list = $(selector);
    if (!list) return;
    list.replaceChildren();
    const values = Array.isArray(items) ? items : [];
    if (!values.length) {
      const empty = element("li");
      empty.append(element("span", "", "—"), document.createTextNode("Rien pour l’instant."));
      list.append(empty);
      return;
    }
    values.forEach((item) => {
      const line = element("li");
      line.append(element("span", "", "•"), renderItem(item));
      list.append(line);
    });
  }

  function titleForKey(key) {
    const sheet = sheetsState.sheets.find((item) => item.key === key);
    if (!sheet) return key;
    const firstAuthor = String((sheet.authors || [])[0] || "").split(" ").pop();
    return firstAuthor ? `${firstAuthor} et al. (${sheet.year || "s. d."})` : sheet.title;
  }

  function renderComparatif() {
    const synthesis = sheetsState.synthesis;
    const content = synthesis?.content || null;
    const body = $("#comparatif-body");
    if (!body) return;
    body.replaceChildren();
    let rows = Array.isArray(content?.comparatif) ? content.comparatif : [];
    if (!rows.length) {
      rows = sheetsState.sheets.map((item) => {
        const sheet = item.sheet || {};
        const components = sheet.composants || {};
        const evaluation = sheet.evaluation || {};
        return {
          key: item.key,
          acces: ACCESS_LABELS[sheetAccess(item)] || sheetAccess(item),
          wir: components.wir,
          candidats: components.candidats,
          recherche: components.recherche,
          datasets: (evaluation.datasets || []).join(", "),
          modeles: (evaluation.modeles_cibles || []).join(", "),
          budget: components.budget_requetes,
          resultat_principal: (sheet.resultats || [])[0] ? `${sheet.resultats[0].affirmation} : ${sheet.resultats[0].valeur}` : "",
          comparabilite: "Fiche seule (synthèse pas encore produite)",
        };
      });
    }
    if (!rows.length) {
      const row = element("tr");
      const cell = element("td", "", "Aucune fiche pour l’instant.");
      cell.colSpan = 10;
      row.append(cell);
      body.append(row);
    }
    rows.forEach((item) => {
      const row = element("tr");
      const titleCell = element("th");
      const link = element("a", "", titleForKey(item.key));
      link.href = `#fiches/${encodeURIComponent(item.key)}`;
      titleCell.append(link);
      row.append(titleCell);
      ["acces", "wir", "candidats", "recherche", "datasets", "modeles", "budget", "resultat_principal", "comparabilite"].forEach((field) => {
        row.append(element("td", "", item[field] || "—"));
      });
      body.append(row);
    });
    const status = $("#synthesis-status");
    if (synthesis) {
      status.textContent = `Synthèse · ${formatDateTime(synthesis.createdAt)}`;
      status.className = "status cyan large";
      $("#comparatif-intro").textContent = `Synthèse de ${synthesis.keys?.length || rows.length} fiche(s) par ${synthesis.model || "l’agent synthèse"}. Les cellules disent aussi pourquoi certains chiffres ne sont pas directement comparables.`;
    }
    $("#synthesis-overview").textContent = content?.vue_ensemble || (sheetsState.sheets.length ? "La synthèse sera produite au prochain passage des agents (il faut au moins deux fiches)." : "La synthèse apparaîtra dès que deux fiches de lecture existeront.");
    const keysText = (keys) => (Array.isArray(keys) && keys.length ? ` (${keys.map(titleForKey).join(", ")})` : "");
    fillChecklist("#synthesis-inconsistencies", content?.incoherences, (item) => document.createTextNode(`${item.description}${keysText(item.cles)}`));
    fillChecklist("#synthesis-gaps", content?.lacunes_pistes, (item) => document.createTextNode(`${item.piste} — ${item.justification}${keysText(item.cles)}`));
    fillChecklist("#synthesis-next", content?.prochaines_etapes, (item) => document.createTextNode(String(item)));
    const sota = $("#synthesis-sota");
    const sections = Array.isArray(content?.etat_de_lart) ? content.etat_de_lart : [];
    if (sections.length) {
      sota.replaceChildren();
      sections.forEach((part) => {
        sota.append(element("h3", "", part.titre || ""), element("p", "", part.paragraphe || ""));
      });
      const copy = $("#copy-sota");
      copy.disabled = false;
      copy.onclick = () => copyText(sections.map((part) => `${part.titre}\n\n${part.paragraphe}`).join("\n\n"));
    }
  }

  function currentWeek(learning) {
    const start = new Date(`${learning?.startDate || "2026-10-06"}T00:00:00`);
    const days = Math.floor((Date.now() - start.getTime()) / 86400000);
    return Math.min(Math.max(Math.floor(days / 7) + 1, 1), 16);
  }

  function renderRedaction() {
    const container = $("#redaction-steps");
    if (!container || !learningState) return;
    const steps = Array.isArray(learningState.redaction) ? learningState.redaction : [];
    const week = currentWeek(learningState);
    $("#redaction-week").textContent = `Semaine ${week} / 16`;
    const done = readJSON(STORAGE.redaction, {});
    container.replaceChildren();
    steps.forEach((step) => {
      const current = week >= step.from && week <= step.to;
      const card = element("article", `panel step-card${current ? " current" : ""}`);
      card.id = `redaction-${step.id}`;
      const head = element("div", "panel-head");
      const titles = element("div");
      titles.append(element("p", "overline", step.when || ""), element("h2", "", step.title || ""));
      head.append(titles, element("span", `status ${current ? "amber" : "neutral"}`, current ? "Étape du moment" : `S${step.from}${step.to !== step.from ? `–${step.to}` : ""}`));
      card.append(head, element("p", "", step.goal || ""));
      const list = element("ul", "step-checklist");
      (step.checklist || []).forEach((item, index) => {
        const id = `${step.id}-${index}`;
        const line = element("li");
        const label = element("label", "check");
        const box = element("input");
        box.type = "checkbox";
        box.checked = Boolean(done[id]);
        box.addEventListener("change", () => {
          const saved = readJSON(STORAGE.redaction, {});
          if (box.checked) saved[id] = true;
          else delete saved[id];
          writeJSON(STORAGE.redaction, saved);
        });
        label.append(box, element("span", "", item));
        line.append(label);
        list.append(line);
      });
      card.append(list);
      if (step.tip) card.append(element("p", "microcopy", `💡 ${step.tip}`));
      if (step.deliverable) card.append(element("p", "deliverable", `Livrable : ${step.deliverable}`));
      container.append(card);
    });
  }

  const READING_LABELS = {
    sheet: ["✅ fiche écrite", "cyan"],
    queued: ["⏳ en lecture", "amber"],
    no_pdf: ["📕 pas de PDF libre", "danger"],
    error: ["⚠️ à réessayer", "danger"],
    not_queued: ["▫️ non demandée", "neutral"],
  };

  function renderSupervisor() {
    const body = $("#supervisor-body");
    if (!body || !supervisorState) return;
    const papers = Array.isArray(supervisorState.papers) ? supervisorState.papers : [];
    const families = supervisorState.families && typeof supervisorState.families === "object" ? supervisorState.families : {};
    const select = $("#supervisor-family");
    if (select && select.options.length <= 1) {
      Object.entries(families).forEach(([value, label]) => {
        if (!papers.some((paper) => paper.family === value)) return;
        const option = element("option", "", label);
        option.value = value;
        select.append(option);
      });
    }
    const family = select?.value || "all";
    const count = (reading) => papers.filter((paper) => paper.reading === reading).length;
    $("#supervisor-count").textContent = String(papers.length);
    $("#supervisor-sheets").textContent = String(count("sheet"));
    $("#supervisor-queued").textContent = String(count("queued"));
    $("#supervisor-nopdf").textContent = String(count("no_pdf") + count("error"));
    body.replaceChildren();
    const visible = papers.filter((paper) => family === "all" || paper.family === family);
    if (!visible.length) {
      const row = element("tr");
      const cell = element("td", "", "La liste sera importée au prochain passage des agents.");
      cell.colSpan = 6;
      row.append(cell);
      body.append(row);
    }
    visible.forEach((paper) => {
      const row = element("tr");
      const priority = element("td");
      priority.append(element("span", `status ${paper.priority === 1 ? "amber" : "neutral"}`, `P${paper.priority ?? "?"}`));
      const title = element("td");
      title.append(element("b", "", paper.short || ""), element("br"), element("span", "microcopy", `${paper.title || ""} · ${paper.venue || "?"} ${paper.year || ""}`));
      if (paper.titleFr) title.append(element("br"), element("span", "fr-line", `🇫🇷 ${paper.titleFr}`));
      const [label, kind] = READING_LABELS[paper.reading] || [paper.reading || "?", "neutral"];
      const reading = element("td");
      const badge = element("span", `status ${kind}`, label);
      if (paper.readingError) badge.title = paper.readingError;
      reading.append(badge);
      const links = element("td");
      if (paper.pdf) {
        const readerLink = element("a", "", "📖 Lire");
        readerLink.href = readerHref(paper.key);
        links.append(readerLink, document.createTextNode(" "));
      }
      if (paper.reading === "sheet") {
        const sheetLink = element("a", "", "Fiche");
        sheetLink.href = `#fiches/${encodeURIComponent(paper.key)}`;
        links.append(sheetLink, document.createTextNode(" "));
      }
      const source = safeWebUrl(paper.url);
      if (source) {
        const sourceLink = element("a", "", "Source");
        sourceLink.href = source;
        sourceLink.target = "_blank";
        sourceLink.rel = "noopener noreferrer";
        links.append(sourceLink);
      }
      row.append(priority, title, element("td", "", families[paper.family] || paper.family || ""), element("td", "", paper.role || ""), reading, links);
      body.append(row);
    });
  }

  function renderThesisPlan() {
    const list = $("#thesis-plan");
    const plan = Array.isArray(learningState?.supervisor?.thesisPlan) ? learningState.supervisor.thesisPlan : [];
    if (!list || !plan.length) return;
    const done = readJSON(STORAGE.thesis, {});
    const progress = () => {
      const saved = readJSON(STORAGE.thesis, {});
      $("#thesis-progress").textContent = `${plan.filter((step) => saved[step.id]).length} / ${plan.length}`;
    };
    list.replaceChildren();
    plan.forEach((step) => {
      const line = element("li");
      const label = element("label", "check");
      const box = element("input");
      box.type = "checkbox";
      box.checked = Boolean(done[step.id]);
      box.addEventListener("change", () => {
        const saved = readJSON(STORAGE.thesis, {});
        if (box.checked) saved[step.id] = true;
        else delete saved[step.id];
        writeJSON(STORAGE.thesis, saved);
        progress();
      });
      const text = element("span");
      text.append(element("b", "", step.title || ""), document.createTextNode(` (${step.pages || ""}) — ${step.goal || ""} `));
      if (step.lesson) {
        const lesson = element("a", "", "leçon");
        lesson.href = `learning.html#${encodeURIComponent(step.lesson)}`;
        text.append(lesson);
      }
      label.append(box, text);
      line.append(label);
      list.append(line);
    });
    progress();
    const questions = $("#supervisor-questions");
    const items = Array.isArray(learningState?.supervisor?.questions) ? learningState.supervisor.questions : [];
    if (questions && items.length) {
      questions.replaceChildren(...items.map((question) => element("li", "", question)));
    }
  }

  const NEWS_KINDS = { vulnerability: "🔓 Faille", repo: "🧪 Dépôt", incident: "⚠️ Incident IA", article: "📰 Presse", paper: "📄 Recherche" };
  const NEWS_SOURCES = {
    github: "GitHub", gitlab: "GitLab", ghsa: "GitHub Advisory", nvd: "NVD (NIST)", kev: "CISA KEV (exploitée)",
    thehackernews: "The Hacker News", bleepingcomputer: "BleepingComputer", securityweek: "SecurityWeek",
    aiid: "AI Incident Database", arxiv: "arXiv cs.CR",
  };
  const SEVERITY_LABELS = { alert: ["🚨 Alerte", "danger"], notable: ["🔸 Important", "amber"], info: ["▫️ Info", "neutral"] };

  function renderNews() {
    const grid = $("#news-grid");
    if (!grid) return;
    const query = normalizeText($("#news-search")?.value);
    const kind = $("#news-kind")?.value || "all";
    const severity = $("#news-severity")?.value || "all";
    grid.replaceChildren();
    let visible = 0;
    newsState.forEach((item) => {
      if (kind !== "all" && item.kind !== kind) return;
      if (severity === "alert" && item.severity !== "alert") return;
      if (severity === "notable" && item.severity === "info") return;
      const tags = Array.isArray(item.tags) ? item.tags : [];
      if (query && !normalizeText(`${item.title} ${item.titleFr || ""} ${item.summary} ${item.source} ${tags.join(" ")}`).includes(query)) return;
      visible += 1;
      const [severityLabel, severityKind] = SEVERITY_LABELS[item.severity] || SEVERITY_LABELS.info;
      const card = element("article", `paper-card${item.severity === "alert" ? " priority" : ""}`);
      const top = element("div", "paper-top");
      const date = item.publishedAt || item.collectedAt;
      top.append(element("span", `status ${severityKind}`, severityLabel), element("span", "", `${NEWS_KINDS[item.kind] || item.kind} · ${NEWS_SOURCES[item.source] || item.source} · ${date ? formatDateTime(date) : "date ?"}`));
      const tagRow = element("div", "tag-row");
      const extra = item.extra && typeof item.extra === "object" ? item.extra : {};
      if (extra.stars) tagRow.append(element("span", "", `⭐ ${extra.stars}`));
      if (extra.cvss) tagRow.append(element("span", "", `CVSS ${extra.cvss}`));
      tags.slice(0, 5).forEach((tag) => tagRow.append(element("span", "", tag)));
      if (!item.summaryFr) tagRow.append(element("span", "", "résumé en anglais"));
      const actions = element("div", "card-actions");
      const url = safeWebUrl(item.url);
      if (url) {
        const open = element("a", "", "Lire la source");
        open.href = url;
        open.target = "_blank";
        open.rel = "noopener noreferrer";
        actions.append(open);
      }
      card.append(top, element("h2", "", item.title || ""));
      if (item.titleFr) card.append(element("p", "fr-line", `🇫🇷 ${item.titleFr}`));
      card.append(element("p", "", `${item.summaryFr ? "🇫🇷 " : ""}${String(item.summary || "").slice(0, 600)}`));
      if (item.summaryFr && item.summaryEn) {
        const english = element("details", "fr-details");
        english.append(element("summary", "", "🇬🇧 Texte original"), element("p", "", String(item.summaryEn).slice(0, 700)));
        card.append(english);
      }
      card.append(tagRow, actions);
      grid.append(card);
    });
    $("#news-count").textContent = String(newsState.length);
    $("#news-empty").hidden = visible > 0;
  }

  async function loadNewsState() {
    try {
      const response = await fetch("data/news.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      newsState = Array.isArray(data?.items) ? data.items : [];
    } catch (_error) {
      newsState = [];
    }
    renderNews();
  }

  async function loadSheetsState() {
    try {
      const response = await fetch("data/sheets.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      sheetsState = {
        sheets: Array.isArray(data?.sheets) ? data.sheets : [],
        synthesis: data?.synthesis && typeof data.synthesis === "object" ? data.synthesis : null,
      };
    } catch (_error) {
      sheetsState = { sheets: [], synthesis: null };
    }
    renderSheetsGrid();
    renderComparatif();
    if (currentRoute() === "fiches") renderSheetDetail(routeDetail());
  }

  async function loadLearning() {
    try {
      const response = await fetch("data/learning.json", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      learningState = await response.json();
    } catch (_error) {
      learningState = null;
      const container = $("#redaction-steps");
      if (container) container.replaceChildren(element("p", "microcopy", "Étapes indisponibles hors ligne."));
      return;
    }
    renderRedaction();
    renderThesisPlan();
  }

  function initializeResearchViews() {
    ["#sheets-search", "#sheets-access"].forEach((selector) => {
      $(selector)?.addEventListener("input", renderSheetsGrid);
      $(selector)?.addEventListener("change", renderSheetsGrid);
    });
    ["#news-search", "#news-kind", "#news-severity"].forEach((selector) => {
      $(selector)?.addEventListener("input", renderNews);
      $(selector)?.addEventListener("change", renderNews);
    });
    $("#supervisor-family")?.addEventListener("change", renderSupervisor);
  }

  function researchSnapshot() {
    return {
      source: state.backend ? "data/state.json + local preferences" : "local fallback seeds",
      prisma: { ...state.prisma },
      library: {
        visible: $$("[data-paper]").filter((card) => !card.hidden).length,
        saved: savedPapers.size,
      },
      experiments: {
        completed_runs: state.completedRuns.length,
        staged_protocol: state.protocol,
      },
      vocabulary: {
        due: dueWords().length,
        total: state.vocabulary.length,
      },
    };
  }

  function registerWebMCP() {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const report = (error) => console.warn("WebMCP tool registration failed", error);

    try {
      void Promise.resolve(context.registerTool({
        name: "get_research_snapshot",
        title: "Lire l’état du PFE",
        description: "Retourne les compteurs PRISMA, les runs réellement chargés, la liste de lecture et les révisions dues.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute() {
          return researchSnapshot();
        },
      }, { signal: lifecycle.signal })).catch(report);

      void Promise.resolve(context.registerTool({
        name: "stage_wir_protocol",
        title: "Préparer un protocole WIR",
        description: "Prépare et affiche un protocole non exécuté dans le banc d’essai, sans lancer de calcul.",
        inputSchema: {
          type: "object",
          properties: {
            dataset: { type: "string", enum: ["SST-2", "IMDB", "AG News"] },
            model: { type: "string" },
            budget: { type: "integer", minimum: 1 },
            seed: { type: "integer", minimum: 0 },
            methods: { type: "array", minItems: 1, items: { type: "string" } },
          },
          required: ["dataset", "model", "budget", "seed", "methods"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute(input) {
          if (!input || typeof input !== "object" || !Array.isArray(input.methods) || !input.methods.length) {
            throw new TypeError("A valid protocol configuration is required.");
          }
          const protocol = {
            status: "non_execute",
            objective: "Comparer des heuristiques WIR avec accès strictement hard-label",
            threat_model: { oracle_output: "discrete_label_only", scores: false, logits: false, gradients: false },
            dataset: String(input.dataset),
            target_model: String(input.model),
            max_queries_per_example: safeInteger(input.budget),
            random_seed: safeInteger(input.seed),
            methods: input.methods.map(String),
            metrics_planned: ["attack_success_rate", "queries", "perturbation_rate", "semantic_similarity", "runtime"],
            results: null,
          };
          renderProtocol(protocol);
          location.hash = "experiences";
          return { status: protocol.status, staged: true, dataset: protocol.dataset, methods: protocol.methods.length };
        },
      }, { signal: lifecycle.signal })).catch(report);
    } catch (error) {
      report(error);
    }
  }

  initializeTheme();
  initializeNavigation();
  initializeDate();
  initializeLibrary();
  initializePrisma();
  initializeExperiments();
  initializeVocabulary();
  initializeResearchViews();
  registerWebMCP();
  void loadBackendState();
  void loadSheetsState();
  void loadLearning();
  void loadNewsState();
})();
