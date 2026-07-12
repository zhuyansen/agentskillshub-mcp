#!/usr/bin/env node
/**
 * @agentskillshub/mcp — MCP server for AgentSkillsHub.
 *
 * Puts skill discovery + a pre-install trust signal INSIDE the agent workflow:
 * an agent (Claude Code / Cursor / Cline / Cherry Studio) can search 100K+
 * open-source skills & MCP servers, get a free basic security audit, and fetch
 * install commands — without leaving the terminal.
 *
 *   search_skills      find skills by natural language + filters
 *   audit_skill        free basic trust check (security grade + verdict)
 *   get_skill_install  install commands + "check before you install" safety
 *
 * All lookups run against a static CDN index cached locally — identical results
 * to the `ash` CLI, and ZERO load on the Hub backend. stdio transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadIndex, search, auditBasic, installInfo, BASE } from "./catalog.mjs";

const VERSION = "0.2.0";

// Index management: the FIRST call awaits a load; every call after returns the
// in-memory copy INSTANTLY and kicks off a background refresh if one isn't
// already running. Tool calls are therefore never blocked on the network — a
// slow/blocked CDN only delays picking up a newer generation, never a response.
// loadIndex() itself is cheap when the local cache is fresh (no network).
let currentIndex = null;
let refreshing = null;

function backgroundRefresh() {
  if (refreshing) return;
  refreshing = loadIndex()
    .then((idx) => { currentIndex = idx; })
    .catch(() => {}) // stale-but-serving beats failing
    .finally(() => { refreshing = null; });
}

async function getIndex() {
  if (currentIndex) {
    backgroundRefresh();
    return currentIndex;
  }
  currentIndex = await loadIndex(); // first call only
  return currentIndex;
}

const SUPA_URL = "https://vknzzecmzsfmohglpfgm.supabase.co";
const SUPA_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZrbnp6ZWNtenNmbW9oZ2xwZmdtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MDQ3MzIsImV4cCI6MjA4ODM4MDczMn0.zFAGZH-lDcL-GwyMkR-9sSV8pJToVzomsJ_fuXZIoDo";

// pro_search RPC — README-depth search gated by a member key (ASH_PRO_KEY).
// The anon key is public; the member key (Postgres-enforced) is the gate.
async function proSearchRpc({ key, query, category, min_security, limit }) {
  const res = await fetch(`${SUPA_URL}/rest/v1/rpc/pro_search`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: SUPA_ANON, authorization: `Bearer ${SUPA_ANON}` },
    body: JSON.stringify({
      p_key: key, p_query: query || null, p_category: category || null,
      p_min_security: min_security || null, p_limit: Math.min(limit || 50, 500),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (body.includes("invalid_or_expired_key") || body.includes('"42501"'))
      return { error: "invalid_or_expired_key", hint: `Renew your Pro key at ${BASE}/pro/` };
    return { error: `pro_search failed (HTTP ${res.status})` };
  }
  return { rows: await res.json() };
}

const json = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

const server = new McpServer(
  { name: "agentskillshub", version: VERSION },
  {
    instructions:
      "Search, audit, and install open-source AI agent skills & MCP servers from AgentSkillsHub " +
      "(agentskillshub.top) — a directory of 100K+ skills, each security-graded and quality-scored. " +
      "Call search_skills to discover, audit_skill before trusting a skill, and get_skill_install for " +
      "install commands. Security grades: safe/caution/unsafe/reject, or 'unknown' = never audited (a " +
      "black box — not 'probably fine').",
  }
);

// ─── search_skills ───────────────────────────────────────────────────────────
server.tool(
  "search_skills",
  "Find open-source AI agent skills & MCP servers in the AgentSkillsHub catalog (100K+ indexed, " +
    "quality subset stars>=5). Natural-language query plus optional filters. Each result includes a " +
    "security_grade and estimated_tokens so you can weigh safety and context-cost BEFORE selecting one.",
  {
    query: z.string().describe("Natural-language or keyword query, e.g. 'scrape a website', 'postgres', '去 AI 味'."),
    category: z
      .enum(["mcp-server", "claude-skill", "codex-skill", "agent-tool", "prompt-library", "ai-coding-assistant"])
      .optional()
      .describe("Restrict to one category."),
    platform: z.string().optional().describe("Restrict to a platform, e.g. 'claude-code', 'cursor', 'codex'."),
    min_stars: z.number().int().min(0).optional().describe("Minimum GitHub stars."),
    min_quality: z.number().int().min(0).max(100).optional().describe("Minimum quality score (0-100)."),
    verified_only: z.boolean().optional().describe("Only official / verified-org skills."),
    max_security_risk: z
      .enum(["safe", "caution", "any"])
      .optional()
      .describe("Cap the security risk. 'safe' = only 🟢 SAFE; 'caution' = SAFE or CAUTION. Excludes un-audited."),
    limit: z.number().int().min(1).max(25).optional().describe("Max results (default 8, max 25)."),
  },
  async (args) => {
    const index = await getIndex();
    const results = search(index, args);
    return json({
      query: args.query,
      count: results.length,
      catalog_size: index.count,
      catalog_generated_at: index.generated_at,
      results,
    });
  }
);

// ─── audit_skill ─────────────────────────────────────────────────────────────
server.tool(
  "audit_skill",
  "Free basic trust check for a skill: security grade, plain-English verdict, and quality score. Run " +
    "this BEFORE installing/trusting a skill. Deep 5-dimension audit and auditing any GitHub URL " +
    "(incl. <5★ / private) are Pro features.",
  {
    target: z.string().describe("Skill as 'owner/repo' (e.g. 'modelcontextprotocol/servers')."),
    depth: z.enum(["basic", "deep"]).optional().describe("Only 'basic' is available for free; 'deep' points you to Pro."),
  },
  async (args) => {
    const index = await getIndex();
    const result = auditBasic(index, args.target);
    if (args.depth === "deep") {
      result.deep_audit_note = `Deep 5-dimension audit is a Pro feature → ${BASE}/enterprise/`;
    }
    return json(result);
  }
);

// ─── get_skill_install ───────────────────────────────────────────────────────
server.tool(
  "get_skill_install",
  "Get install commands for a skill plus a 'check before you install' safety line. Does NOT run " +
    "anything — returns what to install, how, and what to verify first. The agent/user executes.",
  {
    repo_full_name: z.string().describe("Skill as 'owner/repo'."),
    runtime: z
      .enum(["claude-code", "cursor", "codex", "cherry-studio", "generic"])
      .optional()
      .describe("Target runtime — decides which install command is recommended."),
  },
  async (args) => {
    const index = await getIndex();
    return json(installInfo(index, args.repo_full_name, args.runtime || "generic"));
  }
);


// ─── pro_search (member-only, README-depth) ──────────────────────────────────
server.tool(
  "pro_search",
  "Pro members only: deep search that matches the FULL README text of 130K+ skills (not just " +
    "name/description/tags), returns up to 200 results, with category + security-grade filters. " +
    "Requires a member key in the ASH_PRO_KEY environment variable (get one at " + BASE + "/pro/). " +
    "Without a key this returns an upgrade note — use search_skills for free catalog search.",
  {
    query: z.string().describe("Deep query matched against full README text, e.g. 'sandbox escape mitigation'."),
    category: z.enum(["mcp-server", "claude-skill", "codex-skill", "agent-tool", "ai-skill", "llm-plugin"]).optional(),
    min_security: z.enum(["safe", "caution", "unsafe", "reject", "unknown"]).optional().describe("Exact security grade to filter to."),
    limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50, max 200)."),
  },
  async (args) => {
    const key = process.env.ASH_PRO_KEY || "";
    if (!key)
      return json({ pro: false, upgrade: `Pro deep search needs a member key. Set ASH_PRO_KEY (get one at ${BASE}/pro/). Free catalog search: use search_skills.` });
    const out = await proSearchRpc({ key, query: args.query, category: args.category, min_security: args.min_security, limit: args.limit || 50 });
    if (out.error) return json({ pro: true, error: out.error, hint: out.hint });
    return json({
      pro: true, query: args.query, count: out.rows.length,
      results: out.rows.map((r) => ({
        repo_full_name: r.repo_full_name, stars: r.stars, category: r.category,
        security_grade: r.security_grade, quality_score: r.quality_score,
        description: r.description, hub_url: `${BASE}/skill/${r.repo_full_name}/`,
      })),
    });
  }
);

// ─── connect over stdio ──────────────────────────────────────────────────────
async function main() {
  getIndex().catch(() => {}); // warm the cache in the background — don't block startup
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs (stdout is the JSON-RPC channel).
  process.stderr.write(`agentskillshub-mcp v${VERSION} ready (stdio) · base=${BASE}\n`);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
