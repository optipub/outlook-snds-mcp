'use strict';

/*
 * OAuth 2.0 Authorization Code + PKCE flow for Outlook SNDS.
 *
 * Uses the SNDS portal's public client against the Microsoft "consumers"
 * tenant, with a loopback (http://localhost:<dynamic-port>) redirect. Tokens
 * (access + refresh) are cached on disk and refreshed silently when possible.
 *
 * All values are overridable via environment variables so the bundle can be
 * pointed at a different client / authority / scope without code changes.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { URL, URLSearchParams } = require('url');

const CLIENT_ID = process.env.SNDS_CLIENT_ID || 'a53a6cc1-a1cd-46f7-a4aa-281cdabec33c';
const AUTHORITY = (process.env.SNDS_AUTHORITY || 'https://login.microsoftonline.com/consumers').replace(/\/+$/, '');
const AUTHORIZE_URL = `${AUTHORITY}/oauth2/v2.0/authorize`;
const TOKEN_URL = `${AUTHORITY}/oauth2/v2.0/token`;
// `.default` pulls the statically-configured permissions for the resource.
// The reserved OIDC scopes can be combined with it and are needed to get a
// refresh token + account identity back.
const SCOPE = process.env.SNDS_SCOPE || `${CLIENT_ID}/.default offline_access openid profile`;

const TOKEN_DIR = (process.env.SNDS_TOKEN_DIR && process.env.SNDS_TOKEN_DIR.trim())
  ? process.env.SNDS_TOKEN_DIR.trim()
  : path.join(os.homedir(), '.snds-mcp');
const TOKEN_PATH = path.join(TOKEN_DIR, 'tokens.json');

const LOGIN_TIMEOUT_MS = parseInt(process.env.SNDS_LOGIN_TIMEOUT_MS || '180000', 10);

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  } catch (_) {
    return null;
  }
}

function saveCache(obj) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(obj, null, 2), { mode: 0o600 });
  try { fs.chmodSync(TOKEN_PATH, 0o600); } catch (_) {}
}

function clearCache() {
  try { fs.unlinkSync(TOKEN_PATH); return true; } catch (_) { return false; }
}

function postForm(urlStr, form) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString();
    const u = new URL(urlStr);
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch (_) { json = { raw: data }; }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(json);
        } else {
          const desc = json.error_description || json.error || data || '';
          reject(new Error(`Token endpoint returned HTTP ${res.statusCode}: ${desc}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function decodeJwtPayload(jwt) {
  try {
    const p = jwt.split('.')[1];
    return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function storeTokenResponse(tok, prev) {
  const now = Date.now();
  const rec = {
    access_token: tok.access_token,
    expires_at: now + ((tok.expires_in || 3600) * 1000),
    refresh_token: tok.refresh_token || (prev && prev.refresh_token) || null,
    scope: tok.scope || SCOPE,
    obtained_at: now,
  };
  if (tok.id_token) {
    const c = decodeJwtPayload(tok.id_token);
    if (c) {
      rec.account = c.preferred_username || c.email || c.name || null;
      rec.id_claims = { name: c.name, preferred_username: c.preferred_username, email: c.email };
    }
  } else if (prev) {
    rec.account = prev.account;
    rec.id_claims = prev.id_claims;
  }
  saveCache(rec);
  return rec;
}

function htmlPage(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f3f3f3;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border-radius:10px;box-shadow:0 2px 16px rgba(0,0,0,.12);padding:36px 44px;max-width:440px;text-align:center}
h1{font-size:20px;margin:0 0 12px;color:#0f6cbd}p{font-size:14px;color:#333;line-height:1.5;margin:0}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch (_) {
    /* URL is also written to stderr so the user can open it manually */
  }
}

function interactiveLogin() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  return new Promise((resolve, reject) => {
    let redirectUri;
    let settled = false;
    const server = http.createServer();

    const done = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { server.close(); } catch (_) {}
      fn();
    };

    const timer = setTimeout(() => {
      done(() => reject(new Error(`Sign-in timed out after ${Math.round(LOGIN_TIMEOUT_MS / 1000)}s. Run snds_authenticate again.`)));
    }, LOGIN_TIMEOUT_MS);

    server.on('request', (req, res) => {
      const u = new URL(req.url, 'http://localhost');
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      const retState = u.searchParams.get('state');

      if (!code && !err) { res.writeHead(404); res.end('Not found'); return; }

      const reply = (body) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(body); };

      if (err) {
        const d = u.searchParams.get('error_description') || '';
        reply(htmlPage('Sign-in failed', `${err}: ${d}`));
        done(() => reject(new Error(`Authorization error: ${err} ${d}`)));
        return;
      }
      if (retState !== state) {
        reply(htmlPage('Sign-in failed', 'State value did not match (possible CSRF). Please try again.'));
        done(() => reject(new Error('OAuth state mismatch.')));
        return;
      }

      postForm(TOKEN_URL, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: CLIENT_ID,
        code_verifier: verifier,
        scope: SCOPE,
      }).then((tok) => {
        const rec = storeTokenResponse(tok, loadCache());
        reply(htmlPage('Signed in to SNDS', `You're authenticated${rec.account ? ` as <b>${rec.account}</b>` : ''}. You can close this tab and return to your assistant.`));
        done(() => resolve(rec));
      }).catch((e) => {
        reply(htmlPage('Token exchange failed', e.message));
        done(() => reject(e));
      });
    });

    server.on('error', (e) => done(() => reject(e)));

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      redirectUri = `http://localhost:${port}`;
      const authUrl = `${AUTHORIZE_URL}?` + new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: redirectUri,
        response_mode: 'query',
        scope: SCOPE,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      }).toString();
      process.stderr.write(`\n[SNDS MCP] Opening your browser to sign in. If it does not open automatically, paste this URL:\n${authUrl}\n\n`);
      openBrowser(authUrl);
    });
  });
}

async function getAccessTokenSilent() {
  const cache = loadCache();
  if (!cache) return { ok: false, reason: 'no_cache' };
  if (cache.access_token && Date.now() < cache.expires_at - 60000) {
    return { ok: true, token: cache.access_token, account: cache.account, expires_at: cache.expires_at };
  }
  if (cache.refresh_token) {
    try {
      const tok = await postForm(TOKEN_URL, {
        grant_type: 'refresh_token',
        refresh_token: cache.refresh_token,
        client_id: CLIENT_ID,
        scope: SCOPE,
      });
      const rec = storeTokenResponse(tok, cache);
      return { ok: true, token: rec.access_token, account: rec.account, expires_at: rec.expires_at };
    } catch (e) {
      return { ok: false, reason: 'refresh_failed', error: e.message };
    }
  }
  return { ok: false, reason: 'expired_no_refresh' };
}

async function getAccessToken({ interactive = false } = {}) {
  const silent = await getAccessTokenSilent();
  if (silent.ok) return silent.token;
  if (!interactive) {
    const e = new Error('Not signed in to SNDS. Run the "snds_authenticate" tool first.');
    e.code = 'NEED_AUTH';
    throw e;
  }
  const rec = await interactiveLogin();
  return rec.access_token;
}

module.exports = {
  CLIENT_ID,
  AUTHORITY,
  SCOPE,
  TOKEN_PATH,
  interactiveLogin,
  getAccessToken,
  getAccessTokenSilent,
  loadCache,
  clearCache,
};
