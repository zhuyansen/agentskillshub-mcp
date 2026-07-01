/**
 * smoke.mjs — end-to-end MCP handshake test over stdio.
 *
 * Spawns the real server, speaks JSON-RPC, and asserts:
 *   1. initialize handshake succeeds
 *   2. tools/list returns the 3 tools
 *   3. search_skills returns results
 *   4. audit_skill returns a grade
 *   5. get_skill_install returns install commands
 *
 * Exits non-zero on any failure. No test framework — just Node built-ins.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "src", "index.mjs");

const proc = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
const pending = new Map();
proc.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout on ${method}`)), 30000);
    pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const assert = (cond, label) => {
  if (!cond) { console.error(`✗ ${label}`); proc.kill(); process.exit(1); }
  console.log(`✓ ${label}`);
};

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.0" },
  });
  assert(init.result?.serverInfo?.name === "agentskillshub", "initialize → serverInfo.name = agentskillshub");
  notify("notifications/initialized", {});

  const list = await rpc("tools/list", {});
  const names = (list.result?.tools || []).map((t) => t.name).sort();
  assert(
    JSON.stringify(names) === JSON.stringify(["audit_skill", "get_skill_install", "search_skills"]),
    `tools/list → [${names.join(", ")}]`
  );

  const s = await rpc("tools/call", { name: "search_skills", arguments: { query: "postgres", category: "mcp-server", limit: 3 } });
  const sData = JSON.parse(s.result.content[0].text);
  assert(sData.count > 0 && sData.results[0].repo_full_name, `search_skills "postgres" → ${sData.count} results (top: ${sData.results[0]?.repo_full_name})`);
  assert(["safe", "caution", "unsafe", "reject", "unknown"].includes(sData.results[0].security_grade), `  top result has security_grade = ${sData.results[0].security_grade}`);

  const target = sData.results[0].repo_full_name;
  const a = await rpc("tools/call", { name: "audit_skill", arguments: { target } });
  const aData = JSON.parse(a.result.content[0].text);
  assert(aData.in_catalog === true && aData.security_grade, `audit_skill ${target} → grade ${aData.security_grade}, verdict present`);

  const i = await rpc("tools/call", { name: "get_skill_install", arguments: { repo_full_name: target, runtime: "claude-code" } });
  const iData = JSON.parse(i.result.content[0].text);
  assert(iData.recommended_command?.includes(target), `get_skill_install ${target} → "${iData.recommended_command}"`);
  assert(iData.pre_install_safety?.security_grade, `  pre_install_safety.grade = ${iData.pre_install_safety.security_grade}`);

  console.log("\n✅ all smoke checks passed");
  proc.kill();
  process.exit(0);
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  proc.kill();
  process.exit(1);
}
