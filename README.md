# Outlook SNDS MCP

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Built with MCPB](https://img.shields.io/badge/built%20with-MCPB-7C3AED.svg)](https://github.com/anthropics/mcpb)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-0-success.svg)](#why-zero-dependencies)

An [MCP](https://modelcontextprotocol.io) server that brings the **Outlook.com
Smart Network Data Services (SNDS)** REST API into Claude / Cowork / Claude
Desktop and any other MCP client.

Sign in once with your Microsoft account — the server handles the full OAuth 2.0
authorization-code + PKCE flow over a loopback (`http://localhost`) redirect,
caches the tokens, and refreshes them automatically. Then just ask for your IP
reputation data.

> SNDS gives senders per-IP insight into how Outlook.com sees their mail:
> volume, complaint rates, spam-filter verdicts, trap hits, and block/bot status.

Built & maintained by the **[Postmaster+](https://postmasterplus.com)** team at **[OptiPub](https://optipub.com)**.

## Install

**From a release (recommended)**

1. Download `outlook-snds.mcpb` from the [latest release](../../releases/latest).
2. In Cowork / Claude Desktop: **Settings → Capabilities → install extension**, pick the file (or just double-click it).
3. No configuration required.

**From source** — see [Build](#build).

## Use with other MCP clients (Cursor, VS Code, Windsurf, …)

The `.mcpb` is just a packaging convenience for Claude Desktop / Cowork.
Underneath, this is a standard **stdio MCP server**, so any client that runs
local MCP servers can use it directly — no `.mcpb` required. Just point the
client at `server/index.js`.

Clone or download the repo first, then add a server entry:

**Cursor** — edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project):

```json
{
  "mcpServers": {
    "outlook-snds": {
      "command": "node",
      "args": ["/absolute/path/to/outlook-snds-mcp/server/index.js"]
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`), **Windsurf**, **Claude Desktop** (manual
config), and most other clients use the same `command` + `args` shape — only the
config file location differs. Optional environment overrides (see
[Configuration](#configuration-optional)) go in an `"env": { ... }` object.

The first tool call opens your browser for the SNDS sign-in, exactly as in
Cowork — the localhost OAuth loopback works on any local desktop client.

> **Remote-only clients (e.g. Perplexity, ChatGPT connectors):** these accept
> only a remote HTTPS MCP server URL, not a local command, so this stdio build
> can't be added directly. Using it there would require hosting it as a remote
> server with a web-based OAuth redirect.

## Usage

Run `snds_authenticate` once (your browser opens for a Microsoft sign-in), then:

| Ask | Tool |
| --- | --- |
| "Sign me in to SNDS" | `snds_authenticate` |
| "Am I signed in to SNDS?" | `snds_auth_status` |
| "Show my latest SNDS data report" | `get_data_report` |
| "SNDS data for 2026-12-31" | `get_data_report { date: "2026-12-31" }` |
| "SNDS data for 1.2.3.4 on 2026-12-31" | `get_data_report { date: "2026-12-31", ip: "1.2.3.4" }` |
| "Any blocked/bot/junked IPs?" | `get_ip_status` |
| "Sign me out of SNDS" | `snds_sign_out` |

`get_data_report` takes an optional `date` (`yyyy-MM-dd`) and an optional `ip`
(IPv4). A date is required to filter by IP, because the API path is
`/api/report/data/{date}/{ip}`.

## How authentication works

| Field | Value |
| --- | --- |
| Authorize | `https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize` |
| Token | `https://login.microsoftonline.com/consumers/oauth2/v2.0/token` |
| Client ID | `a53a6cc1-a1cd-46f7-a4aa-281cdabec33c` (the SNDS portal's **public** client) |
| Scope | `a53a6cc1-a1cd-46f7-a4aa-281cdabec33c/.default offline_access openid profile` |
| Redirect | `http://localhost:<dynamic-port>` (loopback) |

On sign-in the server starts a short-lived HTTP listener on `127.0.0.1`, opens
your browser to the Microsoft login, receives the authorization code on the
loopback URL, and exchanges it (with the PKCE code verifier) for tokens.

**No secrets ship in this repo.** It's a public OAuth client using PKCE — there
is no client secret. Tokens are stored only on your machine at
`~/.snds-mcp/tokens.json` with `0600` permissions, and are git-ignored.

## REST endpoints wrapped

Base URL: `https://substrate.office.com/ip-domain-management-snds`

- `GET /api/report/data/{date?}/{ip?}` — IP Data report
- `GET /api/report/status/ip` — IP Status report

## Configuration (optional)

Everything defaults to the SNDS portal values. Override via environment
variables if you need to:

| Variable | Default |
| --- | --- |
| `SNDS_CLIENT_ID` | `a53a6cc1-a1cd-46f7-a4aa-281cdabec33c` |
| `SNDS_AUTHORITY` | `https://login.microsoftonline.com/consumers` |
| `SNDS_SCOPE` | `<client-id>/.default offline_access openid profile` |
| `SNDS_API_BASE` | `https://substrate.office.com/ip-domain-management-snds` |
| `SNDS_TOKEN_DIR` | `~/.snds-mcp` |
| `SNDS_LOGIN_TIMEOUT_MS` | `180000` |
| `SNDS_REQUEST_TIMEOUT_MS` | `60000` |

## Build

Requires Node 18+.

```bash
npx @anthropic-ai/mcpb validate manifest.json
npx @anthropic-ai/mcpb pack . outlook-snds.mcpb
```

Pushing a tag like `v1.0.0` triggers CI to validate, pack, and attach the
`.mcpb` to a GitHub Release automatically (see
[`.github/workflows/release.yml`](.github/workflows/release.yml)).

## Why zero dependencies

The runtime uses only Node.js built-ins (`http`, `https`, `crypto`,
`readline`). That keeps the bundle tiny (~11 KB), removes supply-chain risk, and
means there's nothing to `npm install` at runtime.

## Contributing

PRs and issues welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © OptiPub

---

*Not affiliated with or endorsed by Microsoft. "Outlook", "Outlook.com", and
"SNDS" are trademarks of Microsoft Corporation.*
