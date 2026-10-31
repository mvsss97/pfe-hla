"""Security news watch: AI security first, plus the major cyber incidents.

Kinds: ``repo``, ``vulnerability``, ``incident`` (AI incidents), ``article``
(AI-security press), ``paper`` and ``cyber`` (any major attack: exchange
hacks, breaches, ransomware, supply-chain attacks, exploited zero-days…).

Every source is free and fail-soft: one failing feed never stops the others.
Items are deduplicated by ``(source, external_id)`` and scored with simple,
explainable keyword rules. ``alert`` is reserved for exploited or critical
flaws touching AI software and for very large attacks (≥ $50M stolen or
≥ 10M people affected), so Telegram alerts stay rare and meaningful.
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
# Major cyber incidents (any sector), including crypto-exchange and DeFi hacks.
CYBER_FEEDS = {
    "krebsonsecurity": "https://krebsonsecurity.com/feed/",
    "therecord": "https://therecord.media/feed",
    "databreaches": "https://databreaches.net/feed/",
    "rekt": "https://rekt.news/rss/feed.xml",
    "cointelegraph": "https://cointelegraph.com/rss/tag/hacks",
}
INCIDENT_PATTERN = re.compile(
    r"\b(hack(ed|ers?|s)?|breach(ed|es)?|stole|stolen|theft|heist|drain(ed|er)?|exploit(ed|s)?|"
    r"ransomware|extortion|leak(ed|s)?|compromis(e|ed)|attack(ed|s)?|scam|phish(ing)?|backdoor(ed)?|"
    r"zero-day|0-day|malware|wiper|ddos|exposed|intrusion|cyberattack|spyware|botnet)\b",
    re.IGNORECASE,
)
NOT_AN_EVENT = re.compile(
    r"\b(webinar|deal|deals|sponsored|how to|tips|review|podcast|week in review)\b", re.I
)
CRYPTO_TERMS = (
    "crypto", "bitcoin", "ethereum", "exchange", "defi", "wallet", "token", "blockchain", "binance",
    "bybit", "coinbase", "kraken", "solana", "stablecoin", "bridge", "web3",
)
CATEGORY_RULES = (
    ("rançongiciel", re.compile(r"ransomware|extortion", re.I)),
    ("fuite de données", re.compile(r"breach|leak|exposed|stolen data|data theft|records", re.I)),
    ("chaîne d'approvisionnement", re.compile(r"supply[- ]chain|npm|pypi|dependenc|package", re.I)),
    ("zero-day", re.compile(r"zero-day|0-day|actively exploited|exploited in the wild", re.I)),
    ("hameçonnage", re.compile(r"phish|social engineering|impersonat", re.I)),
    (
        "espionnage",
        re.compile(r"espionage|state-sponsored|apt\d*|nation-state|lazarus|north korea", re.I),
    ),
    ("DDoS", re.compile(r"\bddos\b|denial[- ]of[- ]service", re.I)),
)
MONEY_PATTERN = re.compile(r"\$\s?(\d+(?:[.,]\d+)?)\s?(billion|million|bn|b|m)\b", re.I)
PEOPLE_PATTERN = re.compile(
    r"(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(billion|million)?\s+(?:\w+\s+){0,2}"
    r"(users|customers|records|accounts|people|patients|individuals|members|clients)",
    re.I,
)
# Court or police news about an old attack is notable, never an alert.
JUSTICE_PATTERN = re.compile(
    r"sentenced|prison|jail|arrested|extradit|charged|pleads? guilty|indicted"
    r"|gets \d+ (?:month|year)",
    re.I,
)
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


CONTENT_NS = "{http://purl.org/rss/1.0/modules/content/}encoded"


def _rss_items(xml_bytes: bytes) -> list[dict[str, str]]:
    root = ET.fromstring(xml_bytes)  # noqa: S314 - trusted, well-known feeds
    items = []
    for item in root.iter("item"):
        items.append(
            {
                "title": (item.findtext("title") or "").strip(),
                "link": (item.findtext("link") or "").strip(),
                "description": item.findtext("description") or "",
                "content": item.findtext(CONTENT_NS) or "",
                "guid": (item.findtext("guid") or item.findtext("link") or "").strip(),
                "pubDate": item.findtext("pubDate") or "",
            }
        )
    return items


def _amount(match: re.Match[str]) -> float:
    value = float(match.group(1).replace(",", "."))
    unit = (match.group(2) or "").lower()
    if unit in {"billion", "bn", "b"}:
        return value * 1e9
    if unit in {"million", "m"}:
        return value * 1e6
    return value


def incident_scale(text: str) -> tuple[float, float]:
    """Largest dollar amount and largest number of people mentioned."""

    money = max((_amount(match) for match in MONEY_PATTERN.finditer(text)), default=0.0)
    people = 0.0
    for match in PEOPLE_PATTERN.finditer(text):
        raw = match.group(1).replace(",", "")
        if not raw.replace(".", "").isdigit():
            continue
        value = float(raw) * {"billion": 1e9, "million": 1e6}.get((match.group(2) or "").lower(), 1)
        people = max(people, value)
    return money, people


def incident_categories(text: str) -> list[str]:
    tags = [name for name, pattern in CATEGORY_RULES if pattern.search(text)]
    if any(term in text.lower() for term in CRYPTO_TERMS):
        tags.insert(0, "crypto")
    return tags


def cyber_item(
    name: str, item: dict[str, str], *, always_incident: bool = False
) -> NewsItem | None:
    """A major attack of any sector, graded by its scale."""

    text = f"{item['title']} {_clean(item['description'], 1500)}"
    if NOT_AN_EVENT.search(item["title"]):
        return None
    if not always_incident and not INCIDENT_PATTERN.search(text):
        return None
    money, people = incident_scale(text)
    if (money >= 50e6 or people >= 10e6) and not JUSTICE_PATTERN.search(item["title"]):
        severity, score = "alert", 5.0
    elif money >= 1e6 or people >= 1e5 or re.search(
        r"ransomware|breach|hacked|stolen|heist|drained|actively exploited|zero-day", text, re.I
    ):
        severity, score = "notable", 3.0
    else:
        severity, score = "info", 1.0
    return NewsItem(
        source=name,
        kind="cyber",
        external_id=item["guid"] or item["link"],
        title=item["title"],
        url=item["link"],
        summary=_clean(item["description"], 400),
        published_at=_iso(item["pubDate"]),
        severity=severity,
        score=score + min(money / 1e9, 2.0),
        tags=["cyberattaque", *incident_categories(text)][:6],
        extra={"usd": money or None, "people": people or None, "event": event_key(money, people)},
    )


def event_key(money: float, people: float) -> str:
    """Articles about the same attack share its headline figure (2 significant digits)."""

    if money >= 1e6:
        return f"usd:{float(f'{money:.2g}'):.3g}"
    if people >= 1e5:
        return f"people:{float(f'{people:.2g}'):.3g}"
    return ""


def parse_security_feed(name: str, xml_bytes: bytes) -> list[NewsItem]:
    """AI-security articles, and every other major incident as ``cyber``."""

    items = []
    for item in _rss_items(xml_bytes):
        text = f"{item['title']} {_clean(item['description'])}"
        if not mentions_ai(text):
            incident = cyber_item(name, item)
            if incident is not None:
                items.append(incident)
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


def parse_cyber_feed(name: str, xml_bytes: bytes) -> list[NewsItem]:
    """Incident-focused feeds (rekt.news, crypto hacks): every story is an incident."""

    items = []
    for item in _rss_items(xml_bytes):
        incident = cyber_item(name, item, always_incident=name == "rekt")
        if incident is not None:
            items.append(incident)
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


def fetch_cyber_feeds() -> list[NewsItem]:
    items: list[NewsItem] = []
    for name, url in CYBER_FEEDS.items():
        try:
            items.extend(parse_cyber_feed(name, _get(url)))
        except (OSError, ET.ParseError, urllib.error.URLError):
            continue
    return items


BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130 Safari/537.36"
}


def _paragraph_text(html: str, limit: int) -> str:
    """Paragraphs of the article body (the <article> element when the page has one)."""

    match = re.search(r"<article\b.*?</article>", html, re.S | re.I)
    if match:
        inner = re.findall(r"<p[^>]*>(.*?)</p>", match.group(0), re.S | re.I)
        text = _clean(" ".join(inner), limit)
        if len(text) > 500:
            return text
    paragraphs = re.findall(r"<p[^>]*>(.*?)</p>", html, re.S | re.I)
    return _clean(" ".join(paragraphs), limit)


def fetch_article_text(url: str, *, source: str = "", limit: int = 14000) -> str:
    """Full text of a news article: the page itself, else the feed's full content."""

    text = ""
    try:
        html = urllib.request.urlopen(  # noqa: S310
            urllib.request.Request(url, headers=BROWSER_HEADERS), timeout=30,
            context=_verified_ssl_context(),
        ).read().decode("utf-8", "replace")
        text = _paragraph_text(html, limit)
    except (OSError, urllib.error.URLError, ValueError):
        text = ""
    feed = CYBER_FEEDS.get(source) or RSS_FEEDS.get(source)
    if len(text) < 800 and feed:
        try:
            for item in _rss_items(_get(feed)):
                if url in {item["link"], item["guid"]}:
                    body = item["content"] or item["description"]
                    candidate = _paragraph_text(body, limit) or _clean(body, limit)
                    if len(candidate) > len(text):
                        text = candidate
                    break
        except (OSError, ET.ParseError, urllib.error.URLError):
            pass
    return text


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
        "cyber": fetch_cyber_feeds,
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
    ).fetchall()
    roots = cluster_events([_cluster_input(row) for row in rows])
    return [
        {
            "id": row["id"],
            "key": news_key(row),
            "event": roots.get(int(row["id"]), int(row["id"])),
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


def incident_reports(connection: sqlite3.Connection) -> dict[int, dict[str, Any]]:
    """Analyst reports by news id (what happened, how, consequences, defence)."""

    return {
        int(row["news_id"]): {
            **json.loads(row["report_json"]),
            "model": row["model"],
            "sourceChars": row["source_chars"],
            "createdAt": row["created_at"],
        }
        for row in connection.execute("SELECT * FROM incident_reports")
    }


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
        ORDER BY score DESC, id DESC
        """,
        (cutoff,),
    )
    # One alert per attack: ten articles about the same hack share an event,
    # and the worker remembers the event key, not the article.
    roots = event_roots(connection)
    selected, seen = [], set()
    for row in rows:
        root = roots.get(int(row["id"]))
        key = f"event:{root}" if root else news_key(row)
        if key in seen:
            continue
        seen.add(key)
        selected.append((key, row))
        if len(selected) >= limit:
            break
    return [
        {
            "key": key,
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
        for key, row in selected
    ]


# Words that open many unrelated headlines: never an event's lead actor.
GENERIC_LEADS = frozenset(
    """a an as at the this that these those its it in on for from with after before over under
    up down new top inside why how what when who week weekly daily update updates patch patches
    warning warns alert report reports study survey experts researchers police europol fbi cisa
    doj us uk eu north south korea korean chinese russian iranian state threat actors actor
    campaign hackers hacker attackers attack attacks cyber cyberattack exploit exploits
    exploited exploiter critical flaw flaws bug bugs vulnerability vulnerabilities ransomware
    malware data breach breaches massive major million billion record security zero day phishing
    scam scams google microsoft apple amazon meta secret service crypto bitcoin ethereum""".split()
)
CLUSTER_KINDS = ("cyber", "incident")
CVE_PATTERN = re.compile(r"CVE-\d{4}-\d{4,}", re.I)


def lead_actor(title: str) -> str:
    """First capitalised, non-generic word of a headline ("Binance", "Drift"…)."""

    for word in re.findall(r"[A-Za-z][\w.-]*", title.replace("\u2019", "'")):
        clean = word.removesuffix("'s").strip(".-").lower()
        if word[0].isupper() and len(clean) >= 3 and clean not in GENERIC_LEADS:
            return clean
    return ""


def _event_keys(item: dict[str, Any]) -> tuple[set[str], str]:
    """Shared keys (headline figure, CVE ids) and the lead-actor key of one item."""

    extra = item.get("extra") or {}
    text = f"{item['title']} {extra.get('cve') or ''}"
    keys = {f"cve:{cve.upper()}" for cve in CVE_PATTERN.findall(text)}
    if str(item.get("external_id", "")).upper().startswith("CVE-"):
        keys.add(f"cve:{str(item['external_id']).upper()}")
    if extra.get("event"):
        keys.add(f"figure:{extra['event']}")
    actor = lead_actor(item["title"]) if item.get("kind") in CLUSTER_KINDS else ""
    return keys, (f"actor:{actor}" if actor else "")


def cluster_events(items: list[dict[str, Any]]) -> dict[int, int]:
    """Map each item id to the id of the first article of its event.

    Items sharing a headline figure, a CVE id or the lead actor of the root
    article belong to the same event; ids grow with time, so the root (and the
    alert key built from it) stays stable from one pipeline run to the next.
    """

    clusters: list[tuple[int, set[str], str]] = []
    roots: dict[int, int] = {}
    for item in sorted(items, key=lambda value: value["id"]):
        keys, actor = _event_keys(item)
        match = next(
            (
                cluster
                for cluster in clusters
                if keys & cluster[1] or (actor and actor == cluster[2])
            ),
            None,
        )
        if match is None:
            clusters.append((item["id"], set(keys), actor))
            roots[item["id"]] = item["id"]
        else:
            match[1].update(keys)
            roots[item["id"]] = match[0]
    return roots


def _cluster_input(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "kind": row["kind"],
        "title": row["title"],
        "external_id": row["external_id"],
        "extra": json.loads(row["extra_json"] or "{}"),
    }


def event_roots(connection: sqlite3.Connection, *, days: int = 14) -> dict[int, int]:
    rows = connection.execute(
        "SELECT * FROM news_items WHERE collected_at >= ? ORDER BY id",
        ((datetime.now(UTC) - timedelta(days=days)).replace(microsecond=0).isoformat(),),
    )
    return cluster_events([_cluster_input(row) for row in rows])
