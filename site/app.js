(() => {
  "use strict";

  const ROUTES = [
    ["cockpit", "Cockpit"],
    ["bibliotheque", "Bibliothèque"],
    ["prisma", "PRISMA"],
    ["taxonomie", "Taxonomie"],
    ["experiences", "Expériences WIR"],
    ["english", "English Lab"],
    ["guide", "Guide"],
  ];

  const STORAGE = {
    theme: "hardlabel.theme",
    savedPapers: "hardlabel.savedPapers",
    vocabulary: "hardlabel.vocabulary.progress",
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
    const candidate = location.hash.replace(/^#/, "");
    return ROUTES.some(([route]) => route === candidate) ? candidate : "cockpit";
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
    if (!options.initial && location.hash !== `#${valid}`) history.replaceState(null, "", `#${valid}`);
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
      if (event.altKey && !event.ctrlKey && /^[1-7]$/.test(event.key)) {
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
      card.append(top, element("h2", "", title), element("p", "authors", authors), element("p", "", summary));

      const tagRow = element("div", "tag-row");
      const scientificTags = analysis
        ? [access === "hard" ? "hard-label" : access === "score" ? "score-based" : "accès vérifié · autre", ...componentList]
        : ["cadre à vérifier"];
      scientificTags.forEach((tag) => tagRow.append(element("span", "", tag)));
      card.append(tagRow);

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
      updateCockpitFromPapers(snapshot.papers);
      const generated = snapshot.generatedAt ? new Date(snapshot.generatedAt) : null;
      $("#prisma-status").textContent = generated && !Number.isNaN(generated.getTime())
        ? `Snapshot · ${formatDate(generated)}`
        : "Snapshot chargé";
    } catch (_error) {
      $("#data-mode").textContent = "Mode local · seeds explicites";
    }
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
  registerWebMCP();
  void loadBackendState();
})();
