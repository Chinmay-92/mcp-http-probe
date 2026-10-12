// mcp-http-probe: black-box conformance checks for MCP servers that speak the
// Streamable HTTP transport (spec revision 2025-11-25). Zero dependencies;
// uses the platform fetch.

export const SPEC_VERSION = "2025-11-25";

export type Level = "MUST" | "SHOULD" | "INFO";
export type Status = "pass" | "fail" | "warn" | "skip";

export type CheckResult = {
  id: string;
  level: Level;
  title: string;
  status: Status;
  detail?: string;
  /** Section of the spec the check is derived from. */
  ref: string;
};

export type ProbeOptions = {
  /** Extra headers sent on every request, e.g. Authorization. */
  headers?: Record<string, string>;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Origin used for the DNS-rebinding check. */
  foreignOrigin?: string;
  fetch?: typeof fetch;
};

type RpcResponse = { status: number; headers: Headers; contentType: string; body: string; message: any | null };

const T = "https://modelcontextprotocol.io/specification/2025-11-25";
const REF = {
  transport: `${T}/basic/transports#streamable-http`,
  security: `${T}/basic/transports#security-warning`,
  session: `${T}/basic/transports#session-management`,
  version: `${T}/basic/transports#protocol-version-header`,
  lifecycle: `${T}/basic/lifecycle#initialization`,
  tools: `${T}/server/tools#tool-names`,
  toolSchema: `${T}/server/tools#tool`,
  ping: `${T}/basic/utilities/ping`,
  jsonrpc: `${T}/basic#responses`,
};

/** Extract the JSON-RPC message with the given id from a JSON or SSE body. */
export function extractMessage(contentType: string, body: string, id?: number | string): any | null {
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed)) return parsed.find((m) => id === undefined || m.id === id) ?? null;
      return parsed;
    } catch {
      return null;
    }
  }
  if (contentType.includes("text/event-stream")) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      try {
        const msg = JSON.parse(data);
        if (id === undefined || msg.id === id) return msg;
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

export const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export async function probe(url: string, opts: ProbeOptions = {}): Promise<CheckResult[]> {
  const f = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const results: CheckResult[] = [];
  const add = (r: CheckResult) => results.push(r);
  const ok = (cond: boolean, level: Level, id: string, title: string, ref: string, detail?: string) =>
    add({ id, level, title, ref, status: cond ? "pass" : level === "MUST" ? "fail" : "warn", detail: cond ? undefined : detail });

  let nextId = 1;
  let sessionId: string | null = null;
  let negotiated = SPEC_VERSION;
  let initialized = false;

  async function send(method: "POST" | "GET" | "DELETE", body?: unknown, extra: Record<string, string> = {}, withSession = true): Promise<RpcResponse> {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.headers ?? {}),
      ...(withSession && sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(withSession && initialized ? { "mcp-protocol-version": negotiated } : {}),
      ...extra,
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await f(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
      const contentType = res.headers.get("content-type") ?? "";
      // A GET stream stays open by design; don't wait for it to finish.
      const text = method === "GET" && contentType.includes("text/event-stream") ? "" : await res.text();
      const id = body && typeof body === "object" && "id" in body ? (body as { id: number }).id : undefined;
      return { status: res.status, headers: res.headers, contentType, body: text, message: extractMessage(contentType, text, id) };
    } finally {
      clearTimeout(timer);
      if (method === "GET") ctrl.abort();
    }
  }
  const rpc = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) });
  const initParams = { protocolVersion: SPEC_VERSION, capabilities: {}, clientInfo: { name: "mcp-http-probe", version: "0.1.0" } };

  // ---- 1. Accept header enforcement (before we have a session) ----------
  try {
    const res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: initParams }),
    });
    await res.text();
    ok(res.status === 406 || res.status === 400, "SHOULD", "accept-header", "Rejects POST whose Accept omits text/event-stream", REF.transport, `got HTTP ${res.status}`);
    const sid = res.headers.get("mcp-session-id");
    if (sid && res.ok) {
      // Clean up the stray session we may have created.
      await f(url, { method: "DELETE", headers: { "mcp-session-id": sid, ...(opts.headers ?? {}) } }).catch(() => {});
    }
  } catch (err) {
    add({ id: "reachable", level: "MUST", title: "Server is reachable", ref: REF.transport, status: "fail", detail: String(err) });
    return results;
  }

  // ---- 2. DNS rebinding: foreign Origin must be refused -------------------
  {
    const foreign = opts.foreignOrigin ?? "https://mcp-http-probe.invalid";
    const r = await send("POST", rpc("initialize", initParams), { origin: foreign }, false);
    ok(r.status === 403, "MUST", "origin-validation", `Rejects a foreign Origin (${foreign}) with 403`, REF.security, `got HTTP ${r.status}`);
    const sid = r.headers.get("mcp-session-id");
    if (sid) await send("DELETE", undefined, { "mcp-session-id": sid }, false).catch(() => {});
  }

  // ---- 3. Initialize ------------------------------------------------------
  const init = await send("POST", rpc("initialize", initParams), {}, false);
  const initOk = init.status === 200 && init.message?.result;
  ok(Boolean(initOk), "MUST", "initialize", "initialize succeeds over POST", REF.lifecycle, `HTTP ${init.status} ${init.body.slice(0, 200)}`);
  if (!initOk) return results;

  ok(/application\/json|text\/event-stream/.test(init.contentType), "MUST", "content-type", "Response is application/json or text/event-stream", REF.transport, init.contentType || "(none)");
  negotiated = init.message.result.protocolVersion;
  ok(negotiated === SPEC_VERSION, "SHOULD", "protocol-version", `Negotiates protocol ${SPEC_VERSION}`, REF.lifecycle, `server chose ${negotiated}`);
  ok(Boolean(init.message.result.serverInfo?.name && init.message.result.serverInfo?.version), "MUST", "server-info", "serverInfo has name and version", REF.lifecycle);
  ok(typeof init.message.result.capabilities === "object", "MUST", "capabilities", "Result includes a capabilities object", REF.lifecycle);

  sessionId = init.headers.get("mcp-session-id");
  initialized = true;
  if (sessionId) {
    ok(/^[\x21-\x7E]+$/.test(sessionId), "MUST", "session-id-charset", "Mcp-Session-Id uses only visible ASCII (0x21-0x7E)", REF.session, JSON.stringify(sessionId));
  } else {
    add({ id: "session-id", level: "INFO", title: "Server is stateless (no Mcp-Session-Id issued)", status: "pass", ref: REF.session });
  }

  // ---- 4. initialized notification -> 202 ---------------------------------
  const notif = await send("POST", { jsonrpc: "2.0", method: "notifications/initialized" });
  ok(notif.status === 202, "MUST", "notification-202", "Accepted notification returns 202 with no body", REF.transport, `got HTTP ${notif.status}`);

  // ---- 5. ping ------------------------------------------------------------
  const ping = await send("POST", rpc("ping"));
  ok(ping.status === 200 && ping.message?.result && Object.keys(ping.message.result).length === 0, "MUST", "ping", "ping returns an empty result", REF.ping, ping.body.slice(0, 200));

  // ---- 6. Unknown method -> -32601 ----------------------------------------
  const unknown = await send("POST", rpc("probe/does-not-exist"));
  ok(unknown.message?.error?.code === -32601, "SHOULD", "method-not-found", "Unknown method returns JSON-RPC -32601", REF.jsonrpc, unknown.body.slice(0, 200));

  // ---- 7. Unsupported MCP-Protocol-Version header -> 400 -------------------
  const badVer = await send("POST", rpc("ping"), { "mcp-protocol-version": "1999-01-01" });
  ok(badVer.status === 400, "MUST", "protocol-version-header", "Unsupported MCP-Protocol-Version header returns 400", REF.version, `got HTTP ${badVer.status}`);

  // ---- 8. Session enforcement ---------------------------------------------
  if (sessionId) {
    const missing = await send("POST", rpc("ping"), { "mcp-protocol-version": negotiated }, false);
    ok(missing.status === 400, "SHOULD", "session-required", "Request without Mcp-Session-Id returns 400", REF.session, `got HTTP ${missing.status}`);
    const bogus = await send("POST", rpc("ping"), { "mcp-session-id": "mcp-http-probe-unknown-session", "mcp-protocol-version": negotiated }, false);
    ok(bogus.status === 404, "MUST", "session-unknown", "Unknown Mcp-Session-Id returns 404", REF.session, `got HTTP ${bogus.status}`);
  }

  // ---- 9. tools/list shape -------------------------------------------------
  if (init.message.result.capabilities?.tools) {
    const list = await send("POST", rpc("tools/list"));
    const tools: any[] = list.message?.result?.tools ?? [];
    ok(Array.isArray(list.message?.result?.tools), "MUST", "tools-list", "tools/list returns a tools array", REF.toolSchema, list.body.slice(0, 200));
    const badNames = tools.filter((t) => !TOOL_NAME_RE.test(String(t.name)));
    ok(!badNames.length, "SHOULD", "tool-names", "Tool names are 1-128 chars of [A-Za-z0-9_.-]", REF.tools, badNames.map((t) => t.name).join(", "));
    const badSchemas = tools.filter((t) => !t.inputSchema || t.inputSchema.type !== "object");
    ok(!badSchemas.length, "MUST", "tool-input-schema", "Every tool has an inputSchema of type object", REF.toolSchema, badSchemas.map((t) => t.name).join(", "));
    const dupes = tools.map((t) => t.name).filter((n, i, a) => a.indexOf(n) !== i);
    ok(!dupes.length, "MUST", "tool-unique", "Tool names are unique", REF.tools, dupes.join(", "));
    const undocumented = tools.filter((t) => !t.description);
    ok(!undocumented.length, "SHOULD", "tool-descriptions", "Every tool has a description", REF.toolSchema, undocumented.map((t) => t.name).join(", "));
    add({ id: "tool-count", level: "INFO", title: `Server exposes ${tools.length} tool(s)`, status: "pass", ref: REF.toolSchema, detail: tools.map((t) => t.name).join(", ") });
  }

  // ---- 10. GET stream: text/event-stream or 405 ---------------------------
  const get = await send("GET", undefined, { accept: "text/event-stream" });
  ok(get.status === 405 || (get.status === 200 && get.contentType.includes("text/event-stream")), "MUST", "get-stream", "GET returns an SSE stream or 405", REF.transport, `HTTP ${get.status} ${get.contentType}`);

  // ---- 11. DELETE ends the session -----------------------------------------
  if (sessionId) {
    const del = await send("DELETE");
    if (del.status === 405) {
      add({ id: "session-delete", level: "INFO", title: "Server does not allow client-initiated session termination (405)", status: "pass", ref: REF.session });
    } else {
      ok(del.status >= 200 && del.status < 300, "SHOULD", "session-delete", "DELETE terminates the session", REF.session, `got HTTP ${del.status}`);
      const after = await send("POST", rpc("ping"));
      ok(after.status === 404, "MUST", "session-terminated", "Requests on a terminated session return 404", REF.session, `got HTTP ${after.status}`);
    }
  }

  return results;
}

export function summarize(results: CheckResult[]) {
  return {
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    warnings: results.filter((r) => r.status === "warn").length,
  };
}
