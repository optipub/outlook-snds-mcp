'use strict';

/*
 * Thin REST client for the Outlook SNDS API.
 *
 *   GET /api/report/data/{date?}/{ip?}   most recent (or per-day) data report
 *   GET /api/report/status/ip            owned IP status report
 *
 * Authenticated with a Bearer access token obtained by ./auth.js.
 */

const https = require('https');
const { URL } = require('url');
const auth = require('./auth');

const API_BASE = (process.env.SNDS_API_BASE || 'https://substrate.office.com/ip-domain-management-snds').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = parseInt(process.env.SNDS_REQUEST_TIMEOUT_MS || '60000', 10);

function httpGet(urlStr, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({
      method: 'GET',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'snds-mcp/1.0',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS} ms`)));
    req.on('error', reject);
    req.end();
  });
}

async function apiGet(pathSuffix) {
  const token = await auth.getAccessToken({ interactive: false });
  const resp = await httpGet(API_BASE + pathSuffix, token);

  // Unauthorized / forbidden / redirect-to-login => the session needs refreshing.
  if (resp.status === 401 || resp.status === 403 || (resp.status >= 300 && resp.status < 400)) {
    const e = new Error('SNDS API rejected the access token (HTTP ' + resp.status + '). Your session may have expired — run "snds_authenticate" to sign in again.');
    e.code = 'NEED_AUTH';
    throw e;
  }
  return resp;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function buildDataPath(date, ip) {
  let p = '/api/report/data';
  if (date) {
    if (!DATE_RE.test(date)) throw new Error(`Invalid date "${date}". Expected format yyyy-MM-dd (e.g. 2026-12-31).`);
    p += '/' + encodeURIComponent(date);
    if (ip) {
      if (!IPV4_RE.test(ip)) throw new Error(`Invalid IPv4 address "${ip}".`);
      p += '/' + encodeURIComponent(ip);
    }
  } else if (ip) {
    throw new Error('A "date" (yyyy-MM-dd) is required when filtering by "ip", because the API path is .../data/{date}/{ip}.');
  }
  return p;
}

async function getDataReport({ date, ip } = {}) {
  return apiGet(buildDataPath(date, ip));
}

async function getIpStatus() {
  return apiGet('/api/report/status/ip');
}

module.exports = { API_BASE, apiGet, getDataReport, getIpStatus, buildDataPath };
