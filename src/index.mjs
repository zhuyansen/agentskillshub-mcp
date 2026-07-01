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

const VERSION = "0.1.0";

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
