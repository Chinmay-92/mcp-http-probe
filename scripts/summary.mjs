// Renders mcp-http-probe --json output as a GitHub job summary and step outputs.
import { appendFileSync, readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const icon = { pass: "✅", fail: "❌", warn: "⚠️", skip: "➖" };
const rows = report.results
  .map((r) => `| ${icon[r.status]} | ${r.level} | ${r.title.replace(/\|/g, "\\|")} | ${r.status === "pass" ? "" : (r.detail ?? "").replace(/\|/g, "\\|").slice(0, 160)} |`)
  .join("\n");
const md = `### MCP HTTP Probe: ${report.ok ? "passed" : "failed"}

\`${report.url}\` · spec ${report.spec} · **${report.passed} passed, ${report.failed} failed, ${report.warnings} warnings**

| | Level | Check | Detail |
|---|---|---|---|
${rows}
`;
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `passed=${report.passed}\nfailed=${report.failed}\nwarnings=${report.warnings}\n`);
console.log(md);
for (const r of report.results.filter((r) => r.status === "fail")) console.log(`::error title=MCP probe: ${r.id}::${r.title}${r.detail ? ` (${r.detail})` : ""}`);
for (const r of report.results.filter((r) => r.status === "warn")) console.log(`::warning title=MCP probe: ${r.id}::${r.title}${r.detail ? ` (${r.detail})` : ""}`);
