# Contributing

Thanks for your interest in improving the Outlook SNDS MCP!

## Project layout

```
manifest.json          # MCPB manifest (tools, runtime, metadata)
server/
  index.js             # MCP stdio server + tool definitions/dispatch
  auth.js              # OAuth 2.0 auth-code + PKCE loopback flow, token cache
  snds.js              # SNDS REST client
.github/workflows/     # CI: pack + attach .mcpb on tagged releases
```

The runtime has **zero dependencies** — it uses only Node.js built-ins
(`http`, `https`, `crypto`, `readline`). Please keep it that way unless there's
a compelling reason not to; it keeps the bundle tiny and the install bulletproof.

## Local development

Requires Node 18+.

```bash
# Syntax check
node --check server/index.js

# Smoke-test the protocol over stdio (no sign-in required)
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | SNDS_TOKEN_DIR=$(mktemp -d) node server/index.js
```

## Building the bundle

```bash
npx @anthropic-ai/mcpb validate manifest.json
npx @anthropic-ai/mcpb pack . outlook-snds.mcpb
```

## Releasing

Bump `version` in both `manifest.json` and `server/package.json`, commit, then:

```bash
git tag v1.0.1
git push origin v1.0.1
```

CI validates the manifest, packs the bundle, and attaches `outlook-snds.mcpb`
to the GitHub Release.

## Guidelines

- Keep tool names and descriptions clear — they're what the model reads.
- Don't commit tokens, secrets, or anything from `~/.snds-mcp/`.
- Open an issue before large changes so we can align on direction.
