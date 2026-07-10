---
name: agent-skills-hub
description: Search 130,000+ open-source agent skills and MCP servers with security grades (SAFE/CAUTION/UNSAFE) and quality scores checked before install. Use when the user wants to find, vet, compare, or install an agent skill or MCP server.
---

# Agent Skills Hub

Search a security-graded index of 130,000+ open-source AI agent skills and MCP servers, refreshed every 8 hours from GitHub.

## When to use this skill

- The user asks to find an agent skill or MCP server for a task (e.g. "find me a skill for PDF processing")
- The user wants to check whether a skill/MCP server is safe before installing it
- The user wants alternatives to a known skill, ranked by quality score

## How to use

Run the MCP server (no auth, local cached index, works offline after first sync):

```bash
npx -y @agentskillshub/mcp
```

Or the CLI:

```bash
npx -y @agentskillshub/cli search "browser automation" --safe
```

Every result carries:

- **Security grade** — SAFE / CAUTION / UNSAFE / UNAUDITED (35 rule-based flags)
- **Quality score** — 0-100 across 10 weighted dimensions
- Stars, last-commit freshness, and install command

## Links

- Web: https://agentskillshub.top
- Source (MIT): https://github.com/zhuyansen/agent-skills-hub
- Graded dataset (CC-BY-4.0): https://huggingface.co/datasets/jasonzhuyansen/agent-skills-security-grades
