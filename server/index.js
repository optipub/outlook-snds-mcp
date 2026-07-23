#!/usr/bin/env node
'use strict';

/*
 * Outlook SNDS MCP server (stdio transport).
 *
 * Minimal, dependency-free implementation of the Model Context Protocol over
 * newline-delimited JSON-RPC 2.0. Exposes the Smart Network Data Services REST
 * API behind a Microsoft-account OAuth (auth-code + PKCE, loopback) sign-in.
 */

const readline = require('readline');
const auth = require('./auth');
const snds = require('./snds');

const SERVER_NAME = 'outlook-snds';
const SERVER_VERSION = '1.0.4';
const PROTOCOL_VERSION = '2025-06-18';

/* ----------------------------------- tools ----------------------------------- */

const TOOLS = [
  {
    name: 'snds_authenticate',
    description:
      'Sign in to Outlook SNDS. Opens your browser for a Microsoft-account login (OAuth 2.0 authorization-code + PKCE, loopback redirect) and caches the tokens for later calls. Run this once before fetching reports; tokens are refreshed automatically afterward.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'snds_auth_status',
    description:
      'Check whether you are currently signed in to SNDS, which account is cached, and when the access token expires.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'snds_sign_out',
    description: 'Delete the cached SNDS tokens from disk (sign out). You will need to run snds_authenticate again to fetch data.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_data_report',
    description:
      'Get the SNDS IP Data report (per-IP traffic and reputation metrics: RCPT/DATA commands, message recipients, spam filter result, complaint rate, trap hits, sample HELO/MAIL, comments). With no arguments it returns the most recent available report. Optionally pass a date (yyyy-MM-dd) for a specific day, and optionally an IPv4 address to filter to a single IP (a date is required to filter by IP). Calls GET /api/report/data/{date?}/{ip?}.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Optional report date in yyyy-MM-dd format, e.g. 2026-12-31. Omit for the most recent available report.' },
        ip: { type: 'string', description: 'Optional IPv4 address to filter the report to a single IP, e.g. 1.2.3.4. Requires "date" to also be set.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_ip_status',
    description:
      'Get the SNDS IP Status report for the IPs you own — the set of IPs with an abnormal status at Outlook.com (e.g. Blocked, Bot, Junked) as of the last 24 hours. Calls GET /api/report/status/ip.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/* --------------------------------- formatting --------------------------------- */

function formatResponse(resp, label) {
  if (resp.status === 200) {
    let parsed;
    try { parsed = JSON.parse(resp.body); } catch (_) { parsed = null; }
    const payload = parsed !== null ? JSON.stringify(parsed, null, 2) : (resp.body || '(empty body)');
    let count = '';
    if (Array.isArray(parsed)) count = ` — ${parsed.length} row(s)`;
    else if (parsed && Array.isArray(parsed.value)) count = ` — ${parsed.value.length} row(s)`;
    return `${label}: HTTP 200 OK${count}\n\n${payload}`;
  }
  if (resp.status === 404) return `${label}: HTTP 404 Not Found — no data available for that query.`;
  if (resp.status === 400) return `${label}: HTTP 400 Bad Request — check the date (yyyy-MM-dd) and IPv4 formats.\n${resp.body || ''}`.trim();
  return `${label}: HTTP ${resp.status}\n${resp.body || ''}`.trim();
}

function fmtTime(ms) {
  if (!ms) return 'unknown';
  try { return new Date(ms).toISOString(); } catch (_) { return String(ms); }
}

/* -------------------------------- tool dispatch -------------------------------- */

async function callTool(name, args) {
  switch (name) {
    case 'snds_authenticate': {
      const rec = await auth.interactiveLogin();
      return `Signed in to SNDS${rec.account ? ` as ${rec.account}` : ''}. Access token valid until ${fmtTime(rec.expires_at)}. You can now fetch reports.`;
    }
    case 'snds_auth_status': {
      const cache = auth.loadCache();
      if (!cache) return 'Not signed in. Run snds_authenticate to sign in.';
      const silent = await auth.getAccessTokenSilent();
      if (silent.ok) {
        return `Signed in${silent.account ? ` as ${silent.account}` : ''}. Access token valid until ${fmtTime(silent.expires_at)}${cache.refresh_token ? ' (auto-refresh enabled).' : '.'}`;
      }
      return `Cached session for ${cache.account || 'an account'} is no longer usable (${silent.reason}${silent.error ? ': ' + silent.error : ''}). Run snds_authenticate to sign in again.`;
    }
    case 'snds_sign_out': {
      const removed = auth.clearCache();
      return removed ? 'Signed out — cached SNDS tokens deleted.' : 'No cached tokens to remove.';
    }
    case 'get_data_report': {
      const resp = await snds.getDataReport({ date: args.date, ip: args.ip });
      const label = `SNDS IP Data report${args.date ? ` for ${args.date}` : ' (most recent)'}${args.ip ? `, IP ${args.ip}` : ''}`;
      return formatResponse(resp, label);
    }
    case 'get_ip_status': {
      const resp = await snds.getIpStatus();
      return formatResponse(resp, 'SNDS IP Status report');
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/* ------------------------------ JSON-RPC plumbing ------------------------------ */

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function sendResult(id, result) { send({ jsonrpc: '2.0', id, result }); }
function sendError(id, code, message, data) { send({ jsonrpc: '2.0', id, error: { code, message, data } }); }

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return;
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  try {
    switch (method) {
      case 'initialize':
        sendResult(id, {
          protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
        return;
      case 'notifications/initialized':
      case 'initialized':
        return; // notification — no response
      case 'ping':
        if (isRequest) sendResult(id, {});
        return;
      case 'tools/list':
        sendResult(id, { tools: TOOLS });
        return;
      case 'tools/call': {
        const toolName = params && params.name;
        const toolArgs = (params && params.arguments) || {};
        try {
          const text = await callTool(toolName, toolArgs);
          sendResult(id, { content: [{ type: 'text', text }] });
        } catch (e) {
          sendResult(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
        }
        return;
      }
      default:
        if (isRequest) sendError(id, -32601, `Method not found: ${method}`);
        return;
    }
  } catch (e) {
    if (isRequest) sendError(id, -32603, `Internal error: ${e.message}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch (_) { return; }
  if (Array.isArray(msg)) msg.forEach(handleMessage);
  else handleMessage(msg);
});
rl.on('close', () => process.exit(0));

process.stderr.write(`[SNDS MCP] ${SERVER_NAME} v${SERVER_VERSION} ready (client ${auth.CLIENT_ID}, API ${snds.API_BASE}).\n`);
