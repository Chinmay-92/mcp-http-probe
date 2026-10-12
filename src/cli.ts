#!/usr/bin/env node
import { type CheckResult, probe, SPEC_VERSION, summarize } from "./index.ts";

const HELP = `mcp-http-probe — conformance checks for MCP Streamable HTTP servers (spec ${SPEC_VERSION})

Usage: mcp-http-probe <url> [options]

Options:
  -H, --header "Name: value"   Extra header on every request (repeatable), e.g. -H "Authorization: Bearer xyz"
  --json                       Print results as JSON
  --strict                     Treat SHOULD warnings as failures
  --timeout <ms>               Per-request timeout (default 10000)
  -h, --help                   Show this help

Exit code: 0 if every MUST check passes (and every SHOULD with --strict), 1 otherwise.`;

const args = process.argv.slice(2);
if (!args.length || args.includes("-h") || args.includes("--help")) {
  console.log(HELP);
  process.exit(args.length ? 0 : 2);
}

let url = "";
const headers: Record<string, string> = {};
let json = false;
let strict = false;
let timeoutMs = 10_000;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-H" || a === "--header") {
    const [k, ...v] = (args[++i] ?? "").split(":");
    if (k && v.length) headers[k.trim().toLowerCase()] = v.join(":").trim();
  } else if (a === "--json") json = true;
  else if (a === "--strict") strict = true;
  else if (a === "--timeout") timeoutMs = Number(args[++i]);
  else url = a;
}

const results = await probe(url, { headers, timeoutMs });
const s = summarize(results);
const failed = s.failed > 0 || (strict && s.warnings > 0);

if (json) {
  console.log(JSON.stringify({ url, spec: SPEC_VERSION, ...s, ok: !failed, results }, null, 2));
} else {
  const tty = process.stdout.isTTY;
  const c = (code: number, t: string) => (tty ? `\x1b[${code}m${t}\x1b[0m` : t);
  const icon: Record<CheckResult["status"], string> = { pass: c(32, "✔"), fail: c(31, "✖"), warn: c(33, "▲"), skip: c(90, "–") };
  console.log(`\n${c(1, "mcp-http-probe")} ${url}  ${c(90, `(spec ${SPEC_VERSION})`)}\n`);
  for (const r of results) {
    console.log(`${icon[r.status]} ${c(90, r.level.padEnd(6))} ${r.title}`);
    if (r.detail && r.status !== "pass") console.log(`         ${c(90, r.detail)}`);
    if (r.status === "fail") console.log(`         ${c(90, r.ref)}`);
  }
  console.log(`\n${s.passed} passed, ${s.failed} failed, ${s.warnings} warnings\n`);
}
process.exit(failed ? 1 : 0);
