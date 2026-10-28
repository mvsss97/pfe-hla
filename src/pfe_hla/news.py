"""AI-security news watch: repositories, vulnerabilities, incidents, articles, papers.

Every source is free and fail-soft: one failing feed never stops the others.
Items are deduplicated by ``(source, external_id)`` and scored with simple,
explainable keyword rules. ``alert`` is reserved for exploited or high-severity
flaws touching AI software, so Telegram alerts stay rare and meaningful.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import Any

from pfe_hla.collect import _verified_ssl_context
from pfe_hla.library import utc_now

USER_AGENT = "PFE-HLA/0.3 news watch (student research project)"

AI_TERMS = (
    "llm", "large language model", "language model", "gpt", "chatgpt", "openai", "anthropic",
    "claude", "gemini", "llama", "mistral", "prompt injection", "jailbreak", "machine learning",
    "deep learning", "neural network", "artificial intelligence", "generative ai", "genai",
    "ai agent", "agentic", "model context protocol", "mcp server", "retrieval-augmented",
    "embedding", "transformer", "hugging face", "huggingface", "pytorch", "tensorflow",
    "langchain", "llamaindex", "llama-index", "vllm", "ollama", "copilot", "deepfake",
    "adversarial", "diffusion model", "chatbot", "ai model", "ai-powered", "ai-driven",
)
SECURITY_TERMS = (
    "attack", "exploit", "vulnerab", "breach", "hack", "malware", "ransomware", "phishing",
    "jailbreak", "prompt injection", "data leak", "leak", "compromise", "espionage",
    "supply chain", "backdoor", "poison", "deepfake", "fraud", "scam", "cve-", "zero-day",
    "remote code execution", "rce", "privilege escalation", "exfiltrat",
)
AI_PACKAGES = {
    "pip": (
        "torch", "tensorflow", "keras", "transformers", "langchain", "langchain-core",
        "langchain-community", "langchain-experimental", "llama-index", "llama-index-core",
        "vllm", "gradio", "mlflow", "onnx", "onnxruntime", "safetensors", "huggingface-hub",
        "openai", "anthropic", "litellm", "ray", "bentoml", "chromadb", "haystack-ai",
        "dspy", "pyautogen", "crewai", "sentence-transformers", "diffusers", "accelerate",
        "peft", "lmdeploy", "sglang", "open-webui", "xinference",
    ),
    "npm": (
        "langchain", "@langchain/core", "@langchain/community", "openai",
        "@anthropic-ai/sdk", "ai", "llamaindex", "@modelcontextprotocol/sdk",
    ),
}
GITHUB_QUERIES = (
    '"prompt injection"',
    '"llm security"',
    "jailbreak llm",
    '"adversarial attack"',
    '"ai red teaming"',
    '"mcp security"',
)
GITLAB_QUERIES = ("prompt injection", "llm security", "adversarial attack")
RSS_FEEDS = {
    "thehackernews": "https://feeds.feedburner.com/TheHackersNews",
    "bleepingcomputer": "https://www.bleepingcomputer.com/feed/",
    "securityweek": "https://www.securityweek.com/feed/",
}
AIID_FEED = "https://incidentdatabase.ai/rss.xml"
KEV_FEED = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"
NVD_KEYWORDS = ("large language model", "prompt injection", "machine learning")
MIN_NEW_REPO_STARS = 15


@dataclass(slots=True)
class NewsItem:
    source: str
    kind: str  # repo | vulnerability | incident | article | paper
    external_id: str
    title: str
    url: str = ""
    summary: str = ""
    published_at: str = ""
    severity: str = "info"
    score: float = 0.0
    tags: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)


# ─── Scoring ────────────────────────────────────────────────────────────────


def _clean(text: str, limit: int = 600) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def mentions_ai(text: str) -> bool:
    lowered = f" {text.lower()} "
    return bool(re.search(r"\bAI\b", text)) or any(term in lowered for term in AI_TERMS)


def mentions_security(text: str) -> bool:
    lowered = text.lower()
    return any(term in lowered for term in SECURITY_TERMS)


def _iso(value: str) -> str:
    if not value:
        return ""
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return value[:25]
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC).replace(microsecond=0).isoformat()


# ─── HTTP helpers (fail-soft) ───────────────────────────────────────────────


def _get(url: str, *, headers: dict[str, str] | None = None, timeout: int = 40) -> bytes:
    request = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, **(headers or {})}
    )
    with urllib.request.urlopen(  # noqa: S310
        request, timeout=timeout, context=_verified_ssl_context()
    ) as response:
        return response.read()


def _github_headers() -> dict[str, str]:
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


# ─── Parsers (pure: tested offline with fixtures) ───────────────────────────


def parse_github_repos(payload: dict) -> list[NewsItem]:
    items = []
    for repo in payload.get("items", []):
        stars = int(repo.get("stargazers_count") or 0)
        if repo.get("fork") or stars < MIN_NEW_REPO_STARS:
            continue
        description = _clean(repo.get("description") or "")
        items.append(
            NewsItem(
                source="github",
                kind="repo",
                external_id=str(repo.get("full_name")),
                title=str(repo.get("full_name")),
                url=str(repo.get("html_url") or ""),
                summary=description,
                published_at=_iso(str(repo.get("created_at") or "")),
                severity="notable" if stars >= 150 else "info",
                score=min(stars / 100, 5.0),
                tags=["github", *(repo.get("topics") or [])[:4]],
                extra={"stars": stars, "language": repo.get("language")},
            )
        )
    return items


def parse_gitlab_projects(payload: list, *, since: datetime) -> list[NewsItem]:
    items = []
    for project in payload or []:
        created = _iso(str(project.get("created_at") or ""))
        if not created or created < since.isoformat():
            continue
        items.append(
            NewsItem(
                source="gitlab",
                kind="repo",
                external_id=str(project.get("id")),
                title=str(project.get("path_with_namespace") or project.get("name")),
                url=str(project.get("web_url") or ""),
                summary=_clean(project.get("description") or ""),
                published_at=created,
                severity="info",
                score=min(int(project.get("star_count") or 0) / 20, 5.0),
                tags=["gitlab"],
                extra={"stars": project.get("star_count")},
            )
        )
    return items


def parse_github_advisories(payload: list) -> list[NewsItem]:
    items = []
    for advisory in payload or []:
        summary = str(advisory.get("summary") or "")
        if summary.lower().startswith("duplicate advisory") or advisory.get("withdrawn_at"):
            continue
        severity = str(advisory.get("severity") or "").lower()
        packages = sorted(
            {
                str((vuln.get("package") or {}).get("name"))
                for vuln in advisory.get("vulnerabilities") or []
                if (vuln.get("package") or {}).get("name")
            }
        )
        level = "alert" if severity == "critical" else "notable"
        items.append(
            NewsItem(
                source="ghsa",
                kind="vulnerability",
                external_id=str(advisory.get("ghsa_id")),
                title=summary or str(advisory.get("ghsa_id")),
                url=str(advisory.get("html_url") or ""),
                summary=_clean(advisory.get("description") or "", 500),
                published_at=_iso(str(advisory.get("published_at") or "")),
                severity=level,
                score={"critical": 5, "high": 4, "medium": 2.5, "low": 1}.get(severity, 1),
                tags=["faille", severity, *packages[:3]],
                extra={"cve": advisory.get("cve_id"), "packages": packages, "level": severity},
            )
        )
    return items


def _nvd_score(metrics: dict) -> tuple[float | None, str]:
    for key in ("cvssMetricV40", "cvssMetricV31", "cvssMetricV30"):
        for metric in metrics.get(key) or []:
            data = metric.get("cvssData") or {}
            if data.get("baseScore") is not None:
                return float(data["baseScore"]), str(data.get("baseSeverity") or "")
    return None, ""


def parse_nvd(payload: dict) -> list[NewsItem]:
    items = []
    for wrapper in payload.get("vulnerabilities", []):
        cve = wrapper.get("cve") or {}
        description = next(
            (d.get("value", "") for d in cve.get("descriptions") or [] if d.get("lang") == "en"),
            "",
        )
        if not mentions_ai(description):
            continue
        score, label = _nvd_score(cve.get("metrics") or {})
        level = "alert" if score is not None and score >= 9.0 else (
            "notable" if score is not None and score >= 7.0 else "info"
        )
        cve_id = str(cve.get("id"))
        items.append(
            NewsItem(
                source="nvd",
                kind="vulnerability",
                external_id=cve_id,
                title=f"{cve_id} — {_clean(description, 110)}",
                url=f"https://nvd.nist.gov/vuln/detail/{cve_id}",
                summary=_clean(description, 500),
                published_at=_iso(str(cve.get("published") or "")),
                severity=level,
                score=score or 0.0,
                tags=["faille", "cve", label.lower()] if label else ["faille", "cve"],
                extra={"cvss": score},
            )
        )
    return items


def parse_kev(payload: dict, *, since: datetime) -> list[NewsItem]:
    items = []
    for entry in payload.get("vulnerabilities", []):
        added = str(entry.get("dateAdded") or "")
        if not added or added < since.date().isoformat():
            continue
        text = " ".join(
            str(entry.get(key) or "")
            for key in ("vendorProject", "product", "vulnerabilityName", "shortDescription")
        )
        ai_related = mentions_ai(text)
        cve_id = str(entry.get("cveID"))
        items.append(
            NewsItem(
                source="kev",
                kind="vulnerability",
                external_id=cve_id,
                title=f"{cve_id} exploitée : {entry.get('vendorProject')} {entry.get('product')}",
                url=f"https://nvd.nist.gov/vuln/detail/{cve_id}",
                summary=_clean(str(entry.get("shortDescription") or ""), 500),
                published_at=_iso(added + "T00:00:00+00:00"),
                severity="alert" if ai_related else "notable",
                score=5.0 if ai_related else 3.5,
                tags=["faille", "exploitée", "cisa-kev", *(["ia"] if ai_related else [])],
                extra={
                    "ransomware": entry.get("knownRansomwareCampaignUse"),
                    "dueDate": entry.get("dueDate"),
                },
            )
        )
    return items


def _rss_items(xml_bytes: bytes) -> list[dict[str, str]]:
    root = ET.fromstring(xml_bytes)  # noqa: S314 - trusted, well-known feeds
    items = []
    for item in root.iter("item"):
        items.append(
            {
                "title": (item.findtext("title") or "").strip(),
                "link": (item.findtext("link") or "").strip(),
                "description": item.findtext("description") or "",
                "guid": (item.findtext("guid") or item.findtext("link") or "").strip(),
                "pubDate": item.findtext("pubDate") or "",
            }
        )
    return items


def parse_security_feed(name: str, xml_bytes: bytes) -> list[NewsItem]:
    items = []
    for item in _rss_items(xml_bytes):
        text = f"{item['title']} {_clean(item['description'])}"
        if not mentions_ai(text):
            continue
        security = mentions_security(text)
        items.append(
            NewsItem(
                source=name,
                kind="article",
                external_id=item["guid"] or item["link"],
                title=item["title"],
                url=item["link"],
                summary=_clean(item["description"], 400),
                published_at=_iso(item["pubDate"]),
                severity="notable" if security else "info",
                score=2.5 if security else 1.0,
                tags=["article", name],
            )
        )
    return items


def parse_aiid(xml_bytes: bytes) -> list[NewsItem]:
    items = []
    for item in _rss_items(xml_bytes):
        text = f"{item['title']} {_clean(item['description'])}"
        if not mentions_security(text):
            continue  # the watch is about AI *security* incidents
        items.append(
            NewsItem(
                source="aiid",
                kind="incident",
                external_id=item["guid"] or item["link"],
                title=item["title"],
                url=item["link"],
                summary=_clean(item["description"], 400),
                published_at=_iso(item["pubDate"]),
                severity="notable",
                score=3.0,
                tags=["incident-ia", "aiid"],
            )
        )
    return items


def parse_arxiv_security(root: ET.Element) -> list[NewsItem]:
    atom = "{http://www.w3.org/2005/Atom}"
    items = []
    for entry in root.findall(f"{atom}entry"):
        identifier = (entry.findtext(f"{atom}id") or "").rsplit("/", 1)[-1]
        title = " ".join((entry.findtext(f"{atom}title") or "").split())
        if not title:
            continue
        items.append(
            NewsItem(
                source="arxiv",
                kind="paper",
                external_id=identifier,
                title=title,
                url=f"https://arxiv.org/abs/{identifier}",
                summary=_clean(entry.findtext(f"{atom}summary") or "", 500),
                published_at=_iso(entry.findtext(f"{atom}published") or ""),
                severity="info",
                score=1.5,
                tags=["recherche", "cs.CR"],
            )
        )
    return items


# ─── Fetchers ───────────────────────────────────────────────────────────────


def fetch_github(since: datetime) -> list[NewsItem]:
    items: list[NewsItem] = []
    for query in GITHUB_QUERIES:
        q = f"{query} created:>={since.date().isoformat()}"
        url = "https://api.github.com/search/repositories?" + urllib.parse.urlencode(
            {"q": q, "sort": "stars", "order": "desc", "per_page": "15"}
        )
        items.extend(parse_github_repos(json.loads(_get(url, headers=_github_headers()))))
        time.sleep(2)  # search API: 30 requests/minute when authenticated
    return items


def fetch_gitlab(since: datetime) -> list[NewsItem]:
    items: list[NewsItem] = []
    for query in GITLAB_QUERIES:
        url = "https://gitlab.com/api/v4/projects?" + urllib.parse.urlencode(
            {"search": query, "order_by": "created_at", "sort": "desc", "per_page": "20"}
        )
        items.extend(parse_gitlab_projects(json.loads(_get(url)), since=since))
    return items


def fetch_advisories(since: datetime) -> list[NewsItem]:
    items: list[NewsItem] = []
    for ecosystem, packages in AI_PACKAGES.items():
        url = "https://api.github.com/advisories?" + urllib.parse.urlencode(
            {
                "ecosystem": ecosystem,
                "affects": ",".join(packages),
                "published": f">={since.date().isoformat()}",
                "per_page": "40",
                "sort": "published",
                "direction": "desc",
            }
        )
        items.extend(parse_github_advisories(json.loads(_get(url, headers=_github_headers()))))
    return items


def fetch_nvd(since: datetime, now: datetime) -> list[NewsItem]:
    items: list[NewsItem] = []
    for index, keyword in enumerate(NVD_KEYWORDS):
        if index:
            time.sleep(7)  # 5 requests / 30 s without an API key
        url = "https://services.nvd.nist.gov/rest/json/cves/2.0?" + urllib.parse.urlencode(
            {
                "keywordSearch": keyword,
                "pubStartDate": since.strftime("%Y-%m-%dT%H:%M:%S.000"),
                "pubEndDate": now.strftime("%Y-%m-%dT%H:%M:%S.000"),
                "resultsPerPage": "50",
            }
        )
        items.extend(parse_nvd(json.loads(_get(url, timeout=60))))
    return items


def fetch_kev(since: datetime) -> list[NewsItem]:
    return parse_kev(json.loads(_get(KEV_FEED, timeout=60)), since=since)


def fetch_feeds() -> list[NewsItem]:
    items: list[NewsItem] = []
    for name, url in RSS_FEEDS.items():
        try:
            items.extend(parse_security_feed(name, _get(url)))
        except (OSError, ET.ParseError, urllib.error.URLError):
            continue
    return items


def fetch_aiid() -> list[NewsItem]:
    return parse_aiid(_get(AIID_FEED))


def fetch_arxiv_security() -> list[NewsItem]:
    query = 'cat:cs.CR AND (abs:"prompt injection" OR abs:jailbreak OR abs:"adversarial attack")'
    url = "https://export.arxiv.org/api/query?" + urllib.parse.urlencode(
        {
            "search_query": query,
            "sortBy": "submittedDate",
            "sortOrder": "descending",
            "max_results": "12",
        }
    )
    return parse_arxiv_security(ET.fromstring(_get(url)))  # noqa: S314


# ─── Storage ────────────────────────────────────────────────────────────────


def store_items(connection: sqlite3.Connection, items: list[NewsItem]) -> int:
    inserted = 0
    timestamp = utc_now()
    for item in items:
        if not item.external_id or not item.title:
            continue
        cursor = connection.execute(
            """
            INSERT OR IGNORE INTO news_items(
                source, kind, external_id, title, url, summary, published_at, collected_at,
                severity, score, tags_json, extra_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item.source,
                item.kind,
                item.external_id[:300],
                item.title[:300],
                item.url[:500],
                item.summary,
                item.published_at,
                timestamp,
                item.severity,
                item.score,
                json.dumps(item.tags[:8], ensure_ascii=False),
                json.dumps(item.extra, ensure_ascii=False, default=str),
            ),
        )
        inserted += max(cursor.rowcount, 0)
    return inserted


@dataclass(slots=True)
class NewsReport:
    inserted: dict[str, int] = field(default_factory=dict)
    errors: dict[str, str] = field(default_factory=dict)

    @property
    def total(self) -> int:
        return sum(self.inserted.values())


def collect_news(
    connection: sqlite3.Connection,
    *,
    since_days: int = 10,
    fetchers: dict[str, Callable[[], list[NewsItem]]] | None = None,
) -> NewsReport:
    """Run every source; a failing source is reported and skipped."""

    now = datetime.now(UTC).replace(microsecond=0)
    since = now - timedelta(days=since_days)
    fetchers = fetchers or {
        "github": lambda: fetch_github(since),
        "gitlab": lambda: fetch_gitlab(since),
        "ghsa": lambda: fetch_advisories(since),
        "nvd": lambda: fetch_nvd(since, now),
        "kev": lambda: fetch_kev(since),
        "articles": fetch_feeds,
        "aiid": fetch_aiid,
        "arxiv": fetch_arxiv_security,
    }
    report = NewsReport()
    for name, fetcher in fetchers.items():
        try:
            report.inserted[name] = store_items(connection, fetcher())
        except (OSError, ValueError, ET.ParseError, urllib.error.URLError, KeyError) as exc:
            report.errors[name] = f"{type(exc).__name__}: {exc}"[:200]
        connection.commit()
    return report


def recent_news(connection: sqlite3.Connection, *, limit: int = 150) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT * FROM news_items
        ORDER BY COALESCE(NULLIF(published_at, ''), collected_at) DESC, id DESC
        LIMIT ?
        """,
        (limit,),
    )
    return [
        {
            "id": row["id"],
            "key": news_key(row),
            "source": row["source"],
            "kind": row["kind"],
            "title": row["title"],
            "titleFr": row["title_fr"],
            "url": row["url"],
            "summary": row["summary_fr"] or row["summary"],
            "summaryFr": bool(row["summary_fr"]),
            "summaryEn": row["summary"],
            "publishedAt": row["published_at"],
            "collectedAt": row["collected_at"],
            "severity": row["severity"],
            "score": row["score"],
            "tags": json.loads(row["tags_json"] or "[]"),
            "extra": json.loads(row["extra_json"] or "{}"),
        }
        for row in rows
    ]


def news_key(row: sqlite3.Row | dict[str, Any]) -> str:
    """Stable identity of an item across database rebuilds (the bot dedupes on it)."""

    return f"{row['source']}:{row['external_id']}"


def fresh_alerts(
    connection: sqlite3.Connection, *, limit: int = 8, fresh_days: int = 3
) -> list[dict[str, Any]]:
    """Recent alert-level items for the Telegram worker.

    Nothing is written here: the pipeline notifies the bot after the database
    snapshot is saved, so the worker remembers which alerts it already pushed.
    """

    cutoff = (datetime.now(UTC) - timedelta(days=fresh_days)).replace(microsecond=0).isoformat()
    rows = connection.execute(
        """
        SELECT * FROM news_items
        WHERE severity='alert' AND COALESCE(NULLIF(published_at, ''), collected_at) >= ?
        ORDER BY score DESC, id DESC LIMIT ?
        """,
        (cutoff, limit),
    )
    return [
        {
            "key": news_key(row),
            "source": row["source"],
            "kind": row["kind"],
            "title": row["title"],
            "titleFr": row["title_fr"],
            "url": row["url"],
            "summary": (row["summary_fr"] or row["summary"])[:400],
            "summaryFr": bool(row["summary_fr"]),
            "publishedAt": row["published_at"],
            "tags": json.loads(row["tags_json"] or "[]"),
        }
        for row in rows
    ]
