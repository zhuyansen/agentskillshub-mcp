# AgentSkillsHub MCP Server

**[🌐 Website](https://agentskillshub.top)** · **[🔎 Browse Skills](https://agentskillshub.top)** · **[🛡️ Security Report](https://agentskillshub.top/blog/securing-117k-ai-skills/)** · **[🏢 Enterprise](https://agentskillshub.top/enterprise/)**

Search, audit, and install open-source **AI agent skills & MCP servers** from inside your agent — Claude Code, Cursor, Cline, Cherry Studio, or any MCP client. Every result is **security-graded** and **quality-scored** by [AgentSkillsHub](https://agentskillshub.top), a directory of 100K+ skills. The trust signal comes *before* you install.

```jsonc
// add to your MCP client config
{
  "mcpServers": {
    "agentskillshub": {
      "command": "npx",
      "args": ["-y", "@agentskillshub/mcp"]
    }
  }
}
```

That's it — no API key, no signup. The server downloads a static catalog index once (~1.7 MB, cached locally) and does all searching **locally**, so it's fast, works offline after the first run, and puts **zero load** on the Hub backend.

## Why an MCP server

Discovering a skill is easy. Knowing whether it's *safe to run against your credentials* is not. This server puts search + a trust check right in the agent's tool loop:

```
need a capability → search_skills → audit_skill → get_skill_install → install
```

Your agent sees the **security grade** and **estimated token cost** of a skill *before* it picks one — signals other directories don't give it.

## Tools

| Tool | What it does |
|---|---|
| **`search_skills`** | Find skills by natural-language query + filters (`category`, `platform`, `min_stars`, `min_quality`, `verified_only`, `max_security_risk`, `limit`). Returns each result's `security_grade` and `estimated_tokens`. |
| **`audit_skill`** | Free basic trust check for an `owner/repo`: security grade, plain-English verdict, quality score. |
| **`get_skill_install`** | Install commands for a runtime + a "check before you install" safety line. Returns instructions; it does **not** run anything. |

### Example

> **User:** find me a safe way to query Postgres from Claude Code

The agent calls `search_skills({ query: "query postgres", category: "mcp-server", max_security_risk: "safe" })` and gets back graded results:

```
call518/MCP-PostgreSQL-Ops   150★   🟢 SAFE     quality 75/100
sgaunet/postgresql-mcp         6★   🟡 CAUTION  ~17.2k tok
```

then `audit_skill` / `get_skill_install` before it installs anything.

## Security grades

🟢 SAFE · 🟡 CAUTION · 🔴 UNSAFE · ⛔ REJECT · ⚪ UNAUDITED

⚪ **UNAUDITED** is not "probably fine" — it means *no one has audited it*. The `search_skills` filter `max_security_risk` excludes un-audited skills, never silently treats them as safe.

We security-graded the whole catalog and wrote up what we found: **[We security-graded 117,854 AI agent skills](https://agentskillshub.top/blog/securing-117k-ai-skills/)**.

## Free vs. Pro

- **Free (this server):** `search_skills` · `audit_skill` (basic) · `get_skill_install`, for any catalogued skill.
- **Pro / Enterprise:** 5-dimension deep audit (code · credentials · vendor · supply-chain · operational), any GitHub URL (incl. <5★ / private), CI/batch auditing, compliance evidence → <https://agentskillshub.top/enterprise/>

## Env

| Var | Default |
|---|---|
| `AGENTSKILLSHUB_BASE` | `https://agentskillshub.top` |
| `AGENTSKILLSHUB_CACHE` | `~/.cache/agentskillshub` (shared with the `ash` CLI) |

## Related

- **CLI:** [`@agentskillshub/cli`](https://www.npmjs.com/package/@agentskillshub/cli) — the same search/audit/install from your terminal (`npx @agentskillshub/cli search "…"`).

MIT © AgentSkillsHub
