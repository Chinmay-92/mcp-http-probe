# mcp-http-probe

[![npm](https://img.shields.io/npm/v/mcp-http-probe?color=e46a2e)](https://www.npmjs.com/package/mcp-http-probe)
[![ci](https://github.com/Chinmay-92/mcp-http-probe/actions/workflows/ci.yml/badge.svg)](https://github.com/Chinmay-92/mcp-http-probe/actions/workflows/ci.yml)
[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-mcp--http--probe-2ea44f?logo=github)](https://github.com/marketplace/actions/mcp-http-probe)
[![MCP spec](https://img.shields.io/badge/MCP-2025--11--25-4a78a8)](https://modelcontextprotocol.io/specification/2025-11-25)
[![license](https://img.shields.io/github/license/Chinmay-92/mcp-http-probe)](LICENSE)

Black-box conformance checks for [Model Context Protocol](https://modelcontextprotocol.io) servers that use the **Streamable HTTP** transport, spec revision **2025-11-25**.

Point it at any MCP endpoint. It runs 20+ checks taken from the transport, lifecycle, session, security and tools sections of the spec, then tells you what is broken and links to the rule.

```bash
npx mcp-http-probe http://127.0.0.1:8787/mcp
npx mcp-http-probe https://example.com/mcp -H "Authorization: Bearer $TOKEN" --json
```

```
mcp-http-probe http://127.0.0.1:8787/mcp  (spec 2025-11-25)

✔ SHOULD Rejects POST whose Accept omits text/event-stream
✔ MUST   Rejects a foreign Origin (https://mcp-http-probe.invalid) with 403
✔ MUST   initialize succeeds over POST
✔ MUST   Mcp-Session-Id uses only visible ASCII (0x21-0x7E)
✔ MUST   Accepted notification returns 202 with no body
✔ MUST   Unsupported MCP-Protocol-Version header returns 400
✔ MUST   Unknown Mcp-Session-Id returns 404
✔ MUST   Every tool has an inputSchema of type object
✔ MUST   GET returns an SSE stream or 405
✔ MUST   Requests on a terminated session return 404
...
23 passed, 0 failed, 0 warnings
```

## Why

Unit tests in the official SDKs check that the SDKs are correct. They don't check *your* server: the express glue, the session map, the auth middleware and the reverse proxy in front of it. Those are where real servers break.

- **DNS rebinding.** The spec says servers MUST validate `Origin`. The TypeScript SDK's transport leaves that protection off by default. A server built from the README example fails this check (see `test/probe.test.ts`).
- **Sessions.** A hand-rolled session map often returns 400 or 500 where the spec requires 404 for an unknown or terminated `Mcp-Session-Id`. Clients rely on that 404 to start a new session.
- **Notifications.** A notification must get `202 Accepted`. Returning `200 {}` confuses strict clients.
- **Protocol version header.** An unsupported `MCP-Protocol-Version` must get a 400.
- **Tool schemas.** Tool names must follow the 2025-11-25 character rules, and `inputSchema` must be an object schema.

It runs in CI in about a second and needs no SDK, so it works for servers written in any language.

## Checks

| id | level | rule |
|---|---|---|
| `accept-header` | SHOULD | POST with `Accept` lacking `text/event-stream` is rejected (406/400) |
| `origin-validation` | MUST | foreign `Origin` → 403 (DNS rebinding protection) |
| `initialize` | MUST | `initialize` succeeds over POST |
| `content-type` | MUST | responses are `application/json` or `text/event-stream` |
| `protocol-version` | SHOULD | server negotiates `2025-11-25` |
| `server-info`, `capabilities` | MUST | initialize result shape |
| `session-id-charset` | MUST | `Mcp-Session-Id` is visible ASCII only |
| `notification-202` | MUST | accepted notification → 202 |
| `ping` | MUST | `ping` → empty result |
| `method-not-found` | SHOULD | unknown method → `-32601` |
| `protocol-version-header` | MUST | unsupported `MCP-Protocol-Version` → 400 |
| `session-required` | SHOULD | missing session id → 400 |
| `session-unknown` | MUST | unknown session id → 404 |
| `tools-list`, `tool-input-schema`, `tool-unique` | MUST | `tools/list` shape |
| `tool-names`, `tool-descriptions` | SHOULD | 2025-11-25 tool naming, descriptions present |
| `get-stream` | MUST | GET → SSE stream or 405 |
| `session-delete`, `session-terminated` | SHOULD/MUST | DELETE ends the session; later requests → 404 |

The exit code is `1` if any MUST check fails, or any SHOULD check with `--strict`.

## GitHub Action

Gate pull requests on spec conformance. The action writes a results table to the job summary and annotates failures. It is listed on the [GitHub Marketplace](https://github.com/marketplace/actions/mcp-http-probe).

```yaml
- run: node server.js &            # start your MCP server
- uses: Chinmay-92/mcp-http-probe@v1
  with:
    url: http://127.0.0.1:8787/mcp
    strict: true                   # also fail on SHOULD warnings
    headers: |
      Authorization: Bearer ${{ secrets.MCP_TEST_TOKEN }}
```

Outputs: `passed`, `failed`, `warnings`.

Or use the CLI directly in any CI system:

```bash
npx mcp-http-probe http://127.0.0.1:8787/mcp --strict
```

## A server that passes

[`examples/reference-server.ts`](examples/reference-server.ts) is about 40 lines on the official TypeScript SDK and passes every check in `--strict` mode, including the Origin validation that the SDK leaves off by default. Copy it as a starting point.

## Library use

```ts
import { probe, summarize } from "mcp-http-probe";
const results = await probe("http://127.0.0.1:8787/mcp", { headers: { authorization: "Bearer x" } });
console.log(summarize(results)); // { passed, failed, warnings }
```

## Development

```bash
npm test         # runs against a reference SDK server, an origin-unsafe server and a deliberately sloppy one
npm run build    # emits dist/
```

Releases are published from CI with npm trusted publishing and provenance. Bump `version` in `package.json`, commit, then push a matching tag (`git tag v1.0.1 && git push --tags`). The workflow publishes to npm, creates the GitHub release and moves the `v1` tag.

MIT licensed. It began as part of [Hearth](https://github.com/Chinmay-92/hearth), an Alexa+ caregiving MCP server, for the Amazon *Build, Ship, Shape* hackathon.
