PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS schema_meta (
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS papers (
    id INTEGER PRIMARY KEY,
    canonical_key TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    external_id TEXT,
    doi TEXT,
    arxiv_id TEXT,
    title TEXT NOT NULL,
    abstract TEXT NOT NULL DEFAULT '',
    authors_json TEXT NOT NULL DEFAULT '[]',
    publication_year INTEGER,
    venue TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'en',
    url TEXT NOT NULL DEFAULT '',
    pdf_url TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'identified' CHECK (
        status IN ('identified', 'screened', 'sought', 'assessed', 'included', 'excluded')
    ),
    exclusion_code TEXT,
    screening_reason TEXT NOT NULL DEFAULT '',
    discovered_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_papers_status ON papers(status);
CREATE INDEX IF NOT EXISTS idx_papers_doi ON papers(doi);
CREATE INDEX IF NOT EXISTS idx_papers_arxiv ON papers(arxiv_id);

CREATE TABLE IF NOT EXISTS paper_aliases (
    paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    alias_type TEXT NOT NULL,
    alias_value TEXT NOT NULL,
    PRIMARY KEY (alias_type, alias_value)
);

CREATE INDEX IF NOT EXISTS idx_paper_aliases_paper ON paper_aliases(paper_id);

CREATE TABLE IF NOT EXISTS search_runs (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    query TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    returned_count INTEGER NOT NULL DEFAULT 0,
    inserted_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'error')),
    error TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS search_run_details (
    run_id INTEGER PRIMARY KEY REFERENCES search_runs(id) ON DELETE CASCADE,
    executed_query TEXT NOT NULL,
    request_url TEXT NOT NULL,
    run_kind TEXT NOT NULL CHECK (run_kind IN ('review', 'pilot', 'watch')),
    protocol_version TEXT
);

CREATE INDEX IF NOT EXISTS idx_search_run_kind ON search_run_details(run_kind);

CREATE TABLE IF NOT EXISTS paper_hits (
    run_id INTEGER NOT NULL REFERENCES search_runs(id) ON DELETE CASCADE,
    paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    source_rank INTEGER NOT NULL,
    PRIMARY KEY (run_id, paper_id)
);

CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY,
    paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    decision TEXT NOT NULL CHECK (decision IN ('keep', 'reject', 'pending')),
    reason_code TEXT,
    note TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT 'cli',
    decided_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decisions_paper ON decisions(paper_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS screening_events (
    id INTEGER PRIMARY KEY,
    paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    stage TEXT NOT NULL CHECK (stage IN ('title_abstract', 'full_text')),
    decision TEXT NOT NULL CHECK (decision IN ('include', 'exclude', 'uncertain')),
    reason_code TEXT,
    rationale TEXT NOT NULL,
    reviewer TEXT NOT NULL DEFAULT 'human',
    screened_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_screening_paper ON screening_events(paper_id, screened_at DESC);

CREATE TABLE IF NOT EXISTS paper_analysis (
    paper_id INTEGER PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
    access_regime TEXT NOT NULL DEFAULT 'unknown',
    attack_level TEXT NOT NULL DEFAULT 'unknown',
    importance_method TEXT NOT NULL DEFAULT '',
    search_method TEXT NOT NULL DEFAULT '',
    perturbation_space TEXT NOT NULL DEFAULT '',
    constraints_text TEXT NOT NULL DEFAULT '',
    datasets_text TEXT NOT NULL DEFAULT '',
    models_text TEXT NOT NULL DEFAULT '',
    query_budget_text TEXT NOT NULL DEFAULT '',
    metrics_text TEXT NOT NULL DEFAULT '',
    evidence_json TEXT NOT NULL DEFAULT '[]',
    verification_status TEXT NOT NULL DEFAULT 'not_checked' CHECK (
        verification_status IN ('not_checked', 'partial', 'verified', 'conflict')
    ),
    notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS paper_documents (
    paper_id INTEGER PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
    pdf_path TEXT NOT NULL,
    text_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    page_count INTEGER NOT NULL,
    character_count INTEGER NOT NULL,
    extraction_status TEXT NOT NULL CHECK (
        extraction_status IN ('downloaded', 'extracted', 'error')
    ),
    error TEXT NOT NULL DEFAULT '',
    extracted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
    id INTEGER PRIMARY KEY,
    paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    claim TEXT NOT NULL,
    quote TEXT NOT NULL DEFAULT '',
    value_text TEXT NOT NULL DEFAULT '',
    page_number INTEGER,
    verification_status TEXT NOT NULL CHECK (
        verification_status IN ('exact_quote', 'value_only', 'not_found')
    ),
    context TEXT NOT NULL DEFAULT '',
    verified_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_paper ON evidence(paper_id, verification_status);

CREATE TABLE IF NOT EXISTS vocabulary (
    id INTEGER PRIMARY KEY,
    term TEXT NOT NULL UNIQUE COLLATE NOCASE,
    translation_fr TEXT NOT NULL,
    definition_en TEXT NOT NULL,
    synonyms_json TEXT NOT NULL DEFAULT '[]',
    example_en TEXT NOT NULL,
    source_paper_id INTEGER REFERENCES papers(id) ON DELETE SET NULL,
    ease REAL NOT NULL DEFAULT 2.5,
    interval_days INTEGER NOT NULL DEFAULT 0,
    repetitions INTEGER NOT NULL DEFAULT 0,
    due_at TEXT NOT NULL,
    last_reviewed_at TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vocabulary_due ON vocabulary(due_at);

CREATE TABLE IF NOT EXISTS vocabulary_reviews (
    id INTEGER PRIMARY KEY,
    vocabulary_id INTEGER NOT NULL REFERENCES vocabulary(id) ON DELETE CASCADE,
    quality INTEGER NOT NULL CHECK (quality BETWEEN 0 AND 5),
    reviewed_at TEXT NOT NULL,
    previous_interval INTEGER NOT NULL,
    next_interval INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Schema v2: frozen protocol versions, AI assistance and the Telegram triage loop.
-- AI rows are suggestions or drafts; they never replace a human screening event.

CREATE TABLE IF NOT EXISTS protocol_versions (
    version TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    git_commit TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'provisional' CHECK (
        status IN ('provisional', 'validated', 'retired')
    ),
    frozen_at TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS ai_screening (
    id INTEGER PRIMARY KEY,
    paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    decision TEXT NOT NULL CHECK (decision IN ('include', 'exclude', 'uncertain')),
    reason_code TEXT,
    access_regime TEXT NOT NULL DEFAULT 'unknown',
    contribution_type TEXT NOT NULL DEFAULT 'other',
    relevance INTEGER NOT NULL DEFAULT 0 CHECK (relevance BETWEEN 0 AND 5),
    confidence REAL NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
    rationale TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    prompt_version TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_screening_paper ON ai_screening(paper_id, id DESC);

CREATE TABLE IF NOT EXISTS triage_events (
    id INTEGER PRIMARY KEY,
    paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    decision TEXT NOT NULL CHECK (decision IN ('include', 'exclude', 'uncertain', 'later')),
    reason_code TEXT,
    channel TEXT NOT NULL DEFAULT 'telegram',
    event_ref TEXT NOT NULL DEFAULT '',
    decided_at TEXT NOT NULL,
    carried_event_id INTEGER REFERENCES screening_events(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_triage_paper ON triage_events(paper_id, id DESC);

CREATE TABLE IF NOT EXISTS reading_queue (
    paper_id INTEGER PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
    priority INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    queued_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    done_at TEXT
);

CREATE TABLE IF NOT EXISTS paper_sheets (
    paper_id INTEGER PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
    sheet_json TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('full_text', 'abstract')),
    document_sha256 TEXT NOT NULL DEFAULT '',
    checks_json TEXT NOT NULL DEFAULT '{}',
    model TEXT NOT NULL DEFAULT '',
    prompt_version TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS synthesis (
    id INTEGER PRIMARY KEY,
    content_json TEXT NOT NULL,
    paper_ids_json TEXT NOT NULL DEFAULT '[]',
    model TEXT NOT NULL DEFAULT '',
    prompt_version TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY,
    task TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'skipped')),
    model TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    detail TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS experiments (
    id INTEGER PRIMARY KEY,
    run_name TEXT NOT NULL,
    method TEXT NOT NULL,
    dataset TEXT NOT NULL,
    model TEXT NOT NULL,
    seed INTEGER NOT NULL,
    config_json TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    artifact_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
