import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { z } from "zod";
import { type CheckResult, extractMessage, probe, summarize, TOOL_NAME_RE } from "../src/index.ts";

const byId = (rs: CheckResult[], id: string) => rs.find((r) => r.id === id)?.status;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

/** A reference server built on the official SDK, with Origin validation turned on. */
function sdkServer(opts: { validateOrigin: boolean }) {
  const app = express();
  app.use(express.json());
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  app.all("/mcp", async (req, res) => {
    const origin = req.headers.origin;
    if (opts.validateOrigin && origin && !origin.startsWith("http://127.0.0.1")) return res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: "bad origin" }, id: null });
    const sid = req.header("mcp-session-id");
    let t = sid ? sessions.get(sid) : undefined;
    if (!t) {
      if (sid) return res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      if (req.method !== "POST" || !isInitializeRequest(req.body)) return res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "no session" }, id: null });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => void sessions.set(id, transport) });
      transport.onclose = () => transport.sessionId && sessions.delete(transport.sessionId);
      const mcp = new McpServer({ name: "ref", version: "1.0.0" });
      mcp.registerTool("echo", { description: "Echo text", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text }] }));
      await mcp.connect(transport);
      t = transport;
    }
    await t.handleRequest(req, res, req.body);
  });
  return createServer(app);
}

/** A sloppy hand-rolled server that gets several transport rules wrong. */
function sloppyServer() {
  return createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const msg = body ? JSON.parse(body) : null;
    res.setHeader("content-type", "application/json");
    res.setHeader("mcp-session-id", "has spaces in it");
    if (!msg || msg.id === undefined) return res.end("{}"); // 200 for notifications and GET: wrong
    const result =
      msg.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "sloppy", version: "0" } }
        : msg.method === "tools/list"
          ? { tools: [{ name: "do stuff!", inputSchema: { type: "string" } }] }
          : msg.method === "ping"
            ? {}
            : undefined;
    res.end(JSON.stringify(result ? { jsonrpc: "2.0", id: msg.id, result } : { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "nope" } }));
  });
}

describe("extractMessage", () => {
  test("parses JSON bodies and picks from batches", () => {
    assert.deepEqual(extractMessage("application/json", '{"jsonrpc":"2.0","id":1,"result":{}}', 1), { jsonrpc: "2.0", id: 1, result: {} });
    assert.equal(extractMessage("application/json", '[{"id":1},{"id":2}]', 2).id, 2);
  });
  test("finds the matching response in an SSE stream, skipping notifications", () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\nevent: message\nid: 7\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":true}}\n\n';
    assert.deepEqual(extractMessage("text/event-stream", sse, 3).result, { ok: true });
  });
  test("tool name rule", () => {
    assert.ok(TOOL_NAME_RE.test("family_digest"));
    assert.ok(TOOL_NAME_RE.test("admin.tools-list"));
    assert.ok(!TOOL_NAME_RE.test("do stuff!"));
    assert.ok(!TOOL_NAME_RE.test("x".repeat(129)));
  });
});

describe("probe", () => {
  const servers: Server[] = [];
  let good: string, noOrigin: string, sloppy: string;
  before(async () => {
    const s = [sdkServer({ validateOrigin: true }), sdkServer({ validateOrigin: false }), sloppyServer()];
    servers.push(...s);
    [good, noOrigin, sloppy] = await Promise.all(s.map(listen));
  });
  after(() => servers.forEach((s) => s.close()));

  test("a compliant SDK-based server passes every MUST", async () => {
    const rs = await probe(good);
    const failures = rs.filter((r) => r.status === "fail");
    assert.deepEqual(failures, []);
    assert.equal(byId(rs, "session-terminated"), "pass");
  });

  test("flags a server that skips Origin validation (DNS rebinding)", async () => {
    const rs = await probe(noOrigin);
    assert.equal(byId(rs, "origin-validation"), "fail");
    assert.equal(summarize(rs).failed, 1);
  });

  test("catches the sloppy server's transport mistakes", async () => {
    const rs = await probe(sloppy);
    assert.equal(byId(rs, "notification-202"), "fail");
    assert.equal(byId(rs, "session-id-charset"), "fail");
    assert.equal(byId(rs, "protocol-version"), "warn");
    assert.equal(byId(rs, "tool-names"), "warn");
    assert.equal(byId(rs, "tool-input-schema"), "fail");
    assert.equal(byId(rs, "session-unknown"), "fail");
    assert.equal(byId(rs, "get-stream"), "fail");
  });

  test("reports an unreachable server instead of throwing", async () => {
    const rs = await probe("http://127.0.0.1:1/mcp", { timeoutMs: 500 });
    assert.equal(rs[0].id, "reachable");
    assert.equal(rs[0].status, "fail");
  });
});
