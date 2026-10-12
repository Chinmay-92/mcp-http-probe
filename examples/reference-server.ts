// A minimal MCP server on the official TypeScript SDK that passes every probe
// check: Streamable HTTP, sessions, and Origin validation (which the SDK
// transport does not do by default). Run: node examples/reference-server.ts
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { z } from "zod";

const port = Number(process.env.PORT ?? 8787);
const app = express();
app.use(express.json());
const sessions = new Map<string, StreamableHTTPServerTransport>();
const error = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

app.all("/mcp", async (req, res) => {
  // The spec says servers MUST validate Origin. Allow only local browser origins here.
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return res.status(403).json(error(-32000, "Forbidden origin"));

  const sid = req.header("mcp-session-id");
  let transport = sid ? sessions.get(sid) : undefined;
  if (!transport) {
    if (sid) return res.status(404).json(error(-32001, "Session not found"));
    if (req.method !== "POST" || !isInitializeRequest(req.body)) return res.status(400).json(error(-32000, "Initialize first"));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => void sessions.set(id, t) });
    t.onclose = () => void (t.sessionId && sessions.delete(t.sessionId));
    const server = new McpServer({ name: "reference", version: "1.0.0" });
    server.registerTool("echo", { description: "Echo text back", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text }] }));
    await server.connect(t);
    transport = t;
  }
  await transport.handleRequest(req, res, req.body);
});

app.listen(port, "127.0.0.1", () => console.log(`reference MCP server on http://127.0.0.1:${port}/mcp`));
