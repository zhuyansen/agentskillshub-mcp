/**
 * catalog.mjs — shared data access for the AgentSkillsHub MCP server.
 *
 * Reuses the exact same static CDN index the `ash` CLI downloads: a single
 * gzipped file (~1.7MB) cached locally, refreshed with a cheap 77B probe. All
 * searching/auditing is LOCAL — identical ranking to the CLI, and ZERO load on
 * the Hub's backend (the index is a static file on the CDN, not a live query).
 *
 * Zero third-party deps here — Node >= 18 built-ins only (fetch, zlib, fs).
 */

import { gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.env.AGENTSKILLSHUB_BASE || "https://agentskillshub.top";
const META_URL = `${BASE}/search-index-meta.json`;
const INDEX_URL = `${BASE}/search-index.json.gz`;
// utm_source=mcp lets GA4 / Plausible attribute MCP-originated clickthroughs
// separately from the CLI's (utm_source=cli). Anonymous, no in-server telemetry.
const HUB_SKILL = (full) => `${BASE}/skill/${full}/?utm_source=mcp&utm_medium=mcp`;

// Cache is SHARED with the ash CLI on purpose — if a user has both, the index
// is downloaded once and reused. Same dir, same filenames.
const CACHE_DIR = join(process.env.AGENTSKILLSHUB_CACHE || join(homedir(), ".cache", "agentskillshub"));
const CACHE_INDEX = join(CACHE_DIR, "search-index.json");
const CACHE_META = join(CACHE_DIR, "search-index-meta.json");
const TTL_MS = 15 * 60 * 1000; // 15 min — serve cache without probing within this window

export const GRADE = {
  safe: { label: "SAFE", mark: "🟢" },
  caution: { label: "CAUTION", mark: "🟡" },
  unsafe: { label: "UNSAFE", mark: "🔴" },
  reject: { label: "REJECT", mark: "⛔" },
  unknown: { label: "UNAUDITED", mark: "⚪" },
};

export const VERDICT = {
  safe: "Reviewed, no blocking issues — reasonable for general use. Still confirm credential handling for production.",
  caution: "Has caution flags — fine for personal trials; review credentials/maintainer before brand or production use.",
  unsafe: "Flagged unsafe — do NOT run against real credentials or production data.",
  reject: "Rejected — known serious problems. Avoid.",
  unknown: "Never audited by anyone. It's a black box: check the code, what credentials it asks for, and who maintains it before you trust it.",
};

// Generic terms that appear in ~half the catalog — they drown the distinctive
// part of a query. Skipped during scoring unless the whole query is generic.
const STOPWORDS = new Set([
  "ai", "mcp", "mcps", "agent", "agents", "tool", "tools", "skill", "skills",
  "server", "servers", "app", "apps", "工具", "服务器", "服务",
]);

// ─── index loading (shared cache, zero backend load) ─────────────────────────
// 10s cap so a slow/blocked CDN never hangs a background refresh forever.
const FETCH_TIMEOUT_MS = 10 * 1000;
const fetchOpts = () => ({ headers: { "user-agent": "agentskillshub-mcp" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

async function fetchJson(url) {
  const res = await fetch(url, fetchOpts());
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

function readCachedIndex() {
  if (!existsSync(CACHE_INDEX)) return null;
  try {
    return JSON.parse(readFileSync(CACHE_INDEX, "utf8"));
  } catch {
    return null;
  }
}

function cacheFresh() {
  if (!existsSync(CACHE_INDEX)) return false;
  return Date.now() - statSync(CACHE_INDEX).mtimeMs < TTL_MS;
}

async function downloadIndex() {
  const res = await fetch(INDEX_URL, fetchOpts());
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching index`);
  const buf = Buffer.from(await res.arrayBuffer());
  const json = gunzipSync(buf).toString("utf8");
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_INDEX, json);
  const parsed = JSON.parse(json);
  writeFileSync(CACHE_META, JSON.stringify({ v: parsed.v, generated_at: parsed.generated_at, count: parsed.count, min_stars: parsed.min_stars }));
  return parsed;
}

/** Load index, refreshing if stale or if the CDN has a newer generation. */
export async function loadIndex({ force = false } = {}) {
  if (!force && cacheFresh()) {
    const cached = readCachedIndex();
    if (cached) return cached;
  }
  if (!force && existsSync(CACHE_META) && existsSync(CACHE_INDEX)) {
    try {
      const [remote, local] = [await fetchJson(META_URL), JSON.parse(readFileSync(CACHE_META, "utf8"))];
      if (remote.generated_at === local.generated_at) {
        writeFileSync(CACHE_INDEX, readFileSync(CACHE_INDEX)); // bump mtime → reset TTL
        return readCachedIndex();
      }
    } catch {
      const cached = readCachedIndex();
      if (cached) return cached; // offline → serve stale rather than fail
    }
  }
  try {
    return await downloadIndex();
  } catch (err) {
    const cached = readCachedIndex();
    if (cached) return cached;
    throw err;
  }
}

// ─── search / ranking (identical logic to the ash CLI) ───────────────────────
function keywordsOf(row) {
  const raw = Array.isArray(row.wk) ? row.wk : row.w ? String(row.w).split(/\s+/) : [];
  return [...new Set(raw.map((k) => k.toLowerCase()).filter(Boolean))];
}

function tokenize(q) {
  return q
    .toLowerCase()
    .replace(/([a-z0-9])([一-鿿])/g, "$1 $2")
    .replace(/([一-鿿])([a-z0-9])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);
}

function scoreRow(row, tokens) {
  if (!tokens.length) return row.q || 0;
  const name = (row.n || "").toLowerCase();
  const full = (row.f || "").toLowerCase();
  const desc = (row.d || "").toLowerCase();
  const tags = (row.t || []).join(" ").toLowerCase();
  const kws = keywordsOf(row);
  const hasContent = tokens.some((t) => !STOPWORDS.has(t));
  let score = 0;
  for (const tok of tokens) {
    if (hasContent && STOPWORDS.has(tok)) continue;
    if (name === tok) score += 50;
    else if (name.includes(tok)) score += 20;
    if (full.includes(tok)) score += 8;
    if (tags.includes(tok)) score += 10;
    if (desc.includes(tok)) score += 5;
    let kwHits = 0;
    for (const kw of kws) {
      if (kw.length < 2) continue;
      if (tok.includes(kw) || kw.includes(tok)) kwHits++;
    }
    if (kwHits) score += 10 + Math.min(kwHits - 1, 3) * 5;
  }
  if (score === 0) return -1;
  return score + (row.q || 0) / 20 + Math.min(row.s, 50000) / 25000;
}

const RISK_ORDER = { safe: 0, caution: 1, unsafe: 2, reject: 3, unknown: 4 };

function applyFilters(skills, f) {
  return skills.filter((r) => {
    if (f.min_stars && (r.s || 0) < f.min_stars) return false;
    if (f.min_quality && (r.q || 0) < f.min_quality) return false;
    if (f.verified_only && !r.o) return false;
    if (f.category && (r.c || "").toLowerCase() !== f.category.toLowerCase()) return false;
    if (f.platform && !(r.p || []).map((p) => p.toLowerCase()).includes(f.platform.toLowerCase())) return false;
    if (f.max_security_risk && f.max_security_risk !== "any") {
      const cap = RISK_ORDER[f.max_security_risk];
      const g = RISK_ORDER[r.g] ?? 4;
      // "unknown" is never allowed under a risk cap — it's un-audited, not safe.
      if (r.g === "unknown" || g > cap) return false;
    }
    return true;
  });
}

/** Expand a compact index row into the documented MCP output shape. */
export function expand(r) {
  return {
    repo_full_name: r.f,
    name: r.n,
    author: r.a,
    verified: !!r.o,
    description: r.d || "",
    stars: r.s || 0,
    quality_score: Math.round(r.q ?? 0),
    category: r.c || "",
    platforms: r.p || [],
    tags: r.t || [],
    security_grade: r.g || "unknown",
    estimated_tokens: r.k && r.k > 0 && r.k <= 200000 ? r.k : null,
    hub_url: HUB_SKILL(r.f),
    install_hint: `npx skills add ${r.f}`,
  };
}

export function search(index, f) {
  const tokens = tokenize(f.query || "");
  const limit = Math.min(Math.max(1, f.limit || 8), 25);
  return applyFilters(index.skills, f)
    .map((r) => ({ r, score: scoreRow(r, tokens) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => expand(x.r));
}

export function findRow(index, target) {
  const t = (target || "").toLowerCase();
  return index.skills.find((r) => (r.f || "").toLowerCase() === t) || null;
}

export function auditBasic(index, target) {
  const row = findRow(index, target);
  if (!row) {
    return {
      target,
      in_catalog: false,
      note: `"${target}" is not in the quality catalog (stars < 5, or not indexed). Deep audit of any GitHub URL is a Pro feature.`,
      enterprise_url: `${BASE}/enterprise/`,
    };
  }
  const g = row.g || "unknown";
  return {
    target: row.f,
    in_catalog: true,
    security_grade: g,
    security_label: (GRADE[g] || GRADE.unknown).label,
    quality_score: Math.round(row.q ?? 0),
    stars: row.s || 0,
    verified: !!row.o,
    verdict: VERDICT[g] || VERDICT.unknown,
    report_url: `${HUB_SKILL(row.f)}#audit`,
    tier_note:
      "Basic (free). 5-dimension deep audit (code · credentials · vendor · supply-chain · operational) + any GitHub URL (incl. <5★ / private) → Pro.",
    enterprise_url: `${BASE}/enterprise/`,
  };
}

export function installInfo(index, repo_full_name, runtime = "generic") {
  const row = findRow(index, repo_full_name);
  const commands = {
    "claude-code": `npx skills add ${repo_full_name}`,
    cursor: `npx skills add ${repo_full_name}`,
    manual: `git clone https://github.com/${repo_full_name}.git`,
  };
  const g = row ? row.g || "unknown" : "unknown";
  return {
    repo_full_name,
    in_catalog: !!row,
    runtime,
    install_commands: commands,
    recommended_command: commands[runtime] || commands["claude-code"],
    pre_install_safety: {
      security_grade: g,
      security_label: (GRADE[g] || GRADE.unknown).label,
      verdict: VERDICT[g] || VERDICT.unknown,
      must_check: [
        "What credentials does it ask for, and where are they stored?",
        "Is the maintainer identifiable and the repo actively maintained?",
      ],
    },
    hub_url: HUB_SKILL(repo_full_name),
  };
}

export { BASE };
