#!/usr/bin/env node
/**
 * Mac Mini Dashboard - API Server
 * 
 * Endpoints:
 * - /api/openclaw - OpenClaw stats (with 24hr token tracking)
 * - /api/history - Historical system metrics from SQLite
 * - /api/tokens - Token breakdown and cost estimate
 * - /api/cron - Scheduled jobs list
 * - /api/connections - Active network connections
 * - /api/processes - Process insights with historical comparison
 * - /api/quote - Random programming quote
 * - /api/health - Health checks for API dependencies
 * 
 * Configuration via environment variables:
 * - PORT (default: 8889)
 * - API_BIND_ADDRESS (default: 127.0.0.1)
 * - GLANCES_URL (default: http://127.0.0.1:61208/api/4)
 */

const http = require('http');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Configuration
const PORT = process.env.PORT || 8889;
const API_BIND_ADDRESS = process.env.API_BIND_ADDRESS || '127.0.0.1';
const GLANCES_URL = process.env.GLANCES_URL || 'http://127.0.0.1:61208/api/4';
const DB_PATH = path.join(__dirname, 'history.db');
const HOME_DIR = os.homedir();
const ALLOWED_GLANCES_ENDPOINTS = new Set(['cpu', 'mem', 'fs', 'load', 'network', 'processlist', 'uptime']);
const LSOF_PATH = fs.existsSync('/usr/sbin/lsof') ? '/usr/sbin/lsof' : 'lsof';

// Auto-detect openclaw path
function getOpenclawCandidates() {
  const possiblePaths = [
    process.env.OPENCLAW_PATH || null,
    path.join(HOME_DIR, '.nvm/versions/node', process.version, 'bin/openclaw'),
    '/usr/local/bin/openclaw',
    '/opt/homebrew/bin/openclaw',
    'openclaw' // Fallback to PATH
  ].filter(Boolean);
  return [...new Set(possiblePaths)];
}

// Cache for last known OpenClaw state
let lastKnownOpenClaw = null;
const cacheStore = new Map();
let openclawPathPromise = null;

function formatError(error) {
  if (!error) return 'unknown';
  if (typeof error.message === 'string' && error.message.length) return error.message;
  return String(error);
}

function runCommand(command, args, timeoutMs = 5000, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 5,
        env: { ...process.env, ...envOverrides }
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

async function withCache(key, ttlMs, loader, options = {}) {
  const { allowStaleOnError = false } = options;
  const now = Date.now();
  const existing = cacheStore.get(key);

  if (existing && existing.value !== undefined && now - existing.timestamp < ttlMs) {
    return existing.value;
  }
  if (existing?.inFlight) {
    return existing.inFlight;
  }

  const inFlight = (async () => {
    try {
      const value = await loader();
      cacheStore.set(key, { value, timestamp: Date.now(), inFlight: null });
      return value;
    } catch (error) {
      if (allowStaleOnError && existing && existing.value !== undefined) {
        cacheStore.set(key, { value: existing.value, timestamp: existing.timestamp, inFlight: null });
        return existing.value;
      }
      cacheStore.set(key, { value: existing?.value, timestamp: existing?.timestamp || 0, inFlight: null });
      throw error;
    }
  })();

  cacheStore.set(key, {
    value: existing?.value,
    timestamp: existing?.timestamp || 0,
    inFlight
  });

  return inFlight;
}

async function getOpenclawPath() {
  if (openclawPathPromise) return openclawPathPromise;

  openclawPathPromise = (async () => {
    for (const candidate of getOpenclawCandidates()) {
      if (candidate !== 'openclaw' && !fs.existsSync(candidate)) continue;
      try {
        await runCommand(candidate, ['--version'], 5000, { HOME: HOME_DIR });
        return candidate;
      } catch (e) {
        continue;
      }
    }
    return null;
  })();

  return openclawPathPromise;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function getAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return null;

  try {
    const originUrl = new URL(origin);
    const requestHost = (req.headers.host || '').split(':')[0];
    const localHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

    if (localHosts.has(originUrl.hostname)) return origin;
    if (requestHost && originUrl.hostname === requestHost) return origin;
  } catch (e) {
    return null;
  }

  return null;
}

async function fetchWithTimeout(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGlancesJson(endpoint) {
  const response = await fetchWithTimeout(`${GLANCES_URL}/${endpoint}`);
  if (!response.ok) {
    throw new Error(`Glances returned ${response.status}`);
  }
  return response.json();
}

async function proxyGlancesEndpoint(res, endpoint) {
  if (!ALLOWED_GLANCES_ENDPOINTS.has(endpoint)) {
    sendJson(res, 404, { error: 'Glances endpoint not found' });
    return;
  }

  try {
    const response = await fetchWithTimeout(`${GLANCES_URL}/${endpoint}`);
    if (!response.ok) {
      sendJson(res, 502, { error: `Glances returned ${response.status}` });
      return;
    }

    const body = await response.text();
    const contentType = response.headers.get('content-type') || 'application/json; charset=utf-8';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(body);
  } catch (e) {
    sendJson(res, 502, { error: 'Failed to reach Glances' });
  }
}

async function queryDb(sql, options = {}) {
  const { throwOnError = false } = options;
  try {
    const result = await runCommand('sqlite3', ['-json', DB_PATH, sql], 5000);
    return JSON.parse(result || '[]');
  } catch (e) {
    if (throwOnError) throw e;
    return [];
  }
}

async function getOpenClawStatusJson() {
  return withCache('openclaw-status-json', 10000, async () => {
    const openclawPath = await getOpenclawPath();
    if (!openclawPath) {
      throw new Error('openclaw not found');
    }
    const result = await runCommand(openclawPath, ['status', '--json'], 15000, { HOME: HOME_DIR });
    // Strip any non-JSON prefix (e.g. config warnings) before parsing
    const jsonStart = result.indexOf('{');
    const jsonStr = jsonStart >= 0 ? result.slice(jsonStart) : result;
    return JSON.parse(jsonStr);
  });
}

async function get24HourTokens() {
  return withCache('openclaw-24h-tokens', 15000, async () => {
    const since = Math.floor(Date.now() / 1000) - 86400;
    const rows = await queryDb(`SELECT * FROM openclaw_stats WHERE timestamp > ${since} ORDER BY timestamp`);

    if (rows.length === 0) return { tokens24h: 0, samples: 0 };

    const first = rows[0];
    const last = rows[rows.length - 1];
    const tokenDelta = last.tokens - first.tokens;

    return {
      tokens24h: Math.max(0, tokenDelta),
      samples: rows.length,
      history: rows
    };
  });
}

async function getOpenClawStats() {
  return withCache('openclaw-stats', 10000, async () => {
    try {
      const status = await getOpenClawStatusJson();
      const sessions = status.sessions || {};
      const recent = sessions.recent || [];
      const totalTokens = recent.slice(0, 10).reduce((sum, s) => sum + (s.totalTokens || 0), 0);
      const stats24h = await get24HourTokens();
      const mainSession = recent.find(s => s.key === 'agent:main:main') || recent[0] || {};

      const stats = {
        installed: true,
        status: 'running',
        sessions: sessions.count || 0,
        tokens: totalTokens,
        tokens24h: stats24h.tokens24h,
        lastUpdated: Date.now(),
        model: mainSession.model || status.sessions?.defaults?.model || 'unknown',
        contextUsed: mainSession.percentUsed || 0,
        contextTotal: mainSession.contextTokens || 200000,
        contextRemaining: mainSession.remainingTokens || 0,
        memoryChunks: status.memory?.chunks ?? null,
        memoryFiles: status.memory?.files ?? null,
        gatewayLatency: status.gateway?.connectLatencyMs || null,
        gatewayStatus: status.gateway?.reachable ? 'connected' : 'disconnected',
        heartbeatInterval: status.heartbeat?.agents?.[0]?.every || null,
        channels: status.channelSummary || []
      };

      lastKnownOpenClaw = stats;
      return stats;
    } catch (e) {
      if (lastKnownOpenClaw) {
        return {
          ...lastKnownOpenClaw,
          status: 'down',
          lastUpdated: lastKnownOpenClaw.lastUpdated,
          cached: true
        };
      }

      const rows = await queryDb('SELECT * FROM openclaw_stats ORDER BY timestamp DESC LIMIT 1');
      if (rows.length > 0) {
        const last = rows[0];
        const stats24h = await get24HourTokens();
        return {
          installed: true,
          status: 'down',
          sessions: last.sessions,
          tokens: last.tokens,
          tokens24h: stats24h.tokens24h,
          lastUpdated: last.timestamp * 1000,
          cached: true
        };
      }

      const openclawPath = await getOpenclawPath();
      return {
        installed: Boolean(openclawPath),
        status: 'unknown',
        error: formatError(e)
      };
    }
  });
}

async function getHistory(range) {
  const ranges = {
    '1h': 3600,
    '8h': 28800,
    '24h': 86400,
    '7d': 604800,
    '30d': 2592000
  };
  const normalizedRange = Object.prototype.hasOwnProperty.call(ranges, range) ? range : '1h';

  return withCache(`history:${normalizedRange}`, 5000, async () => {
    const seconds = ranges[normalizedRange];
    const since = Math.floor(Date.now() / 1000) - seconds;
    const rows = await queryDb(`SELECT * FROM metrics WHERE timestamp > ${since} ORDER BY timestamp`);

    return {
      range: normalizedRange,
      count: rows.length,
      metrics: rows
    };
  });
}

// Claude pricing (per million tokens)
const PRICING = {
  'claude-opus-4-5': { input: 15, output: 75 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'default': { input: 15, output: 75 }
};

function resolvePricing(model) {
  const normalized = String(model || '').toLowerCase();
  const pricingRules = [
    { key: 'claude-opus-4-5', test: value => value.includes('opus-4-5') },
    { key: 'claude-sonnet-4', test: value => value.includes('sonnet-4') },
    { key: 'claude-3-5-sonnet', test: value => value.includes('3-5-sonnet') || value.includes('3.5-sonnet') }
  ];

  for (const rule of pricingRules) {
    if (rule.test(normalized)) {
      return { modelFamily: rule.key, pricing: PRICING[rule.key] };
    }
  }

  return { modelFamily: 'default', pricing: PRICING.default };
}

async function getCronJobs() {
  return withCache('cron-jobs', 15000, async () => {
    try {
      const openclawPath = await getOpenclawPath();
      if (!openclawPath) return [];

      const result = await runCommand(openclawPath, ['cron', 'list', '--json'], 10000, { HOME: HOME_DIR });
      const data = JSON.parse(result);
      return (data.jobs || []).map(job => ({
        id: job.id,
        name: job.name || 'Unnamed',
        enabled: job.enabled,
        schedule: job.schedule?.expr || job.schedule?.kind || 'unknown',
        nextRun: job.state?.nextRunAtMs || null,
        lastRun: job.state?.lastRunAtMs || null,
        lastStatus: job.state?.lastStatus || null
      }));
    } catch (e) {
      return [];
    }
  });
}

async function getTokenBreakdown() {
  return withCache('token-breakdown', 10000, async () => {
    try {
      const status = await getOpenClawStatusJson();
      const recent = status.sessions?.recent || [];
      const model = recent[0]?.model || status.sessions?.defaults?.model || 'default';
      const totalTokens = recent.slice(0, 10).reduce((sum, session) => sum + (session.totalTokens || 0), 0);

      const estimatedInput = Math.round(totalTokens * 0.25);
      const estimatedOutput = Math.round(totalTokens * 0.75);
      const { modelFamily, pricing } = resolvePricing(model);
      const inputCost = (estimatedInput / 1000000) * pricing.input;
      const outputCost = (estimatedOutput / 1000000) * pricing.output;

      return {
        input: estimatedInput,
        output: estimatedOutput,
        total: totalTokens,
        model,
        pricingModel: modelFamily,
        estimated: true,
        estimateLabel: 'Estimated from total tokens (25% input / 75% output split)',
        cost: {
          input: inputCost,
          output: outputCost,
          total: inputCost + outputCost,
          currency: 'USD'
        }
      };
    } catch (e) {
      return {
        input: 0,
        output: 0,
        total: 0,
        estimated: true,
        estimateLabel: 'Estimate unavailable (OpenClaw status not reachable)',
        cost: { total: 0, currency: 'USD' }
      };
    }
  });
}

async function getConnections() {
  return withCache('connections', 5000, async () => {
    try {
      const result = await runCommand(LSOF_PATH, ['-i', '-P'], 5000);
      const connections = [];
      const lines = result.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        if (!line.includes('ESTABLISHED')) continue;
        const parts = line.split(/\s+/);
        const process = parts[0];
        const connection = parts.find(token => token.includes('->')) || '';
        const match = connection.match(/->([^:]+):(\d+)/);
        if (!match) continue;

        const host = match[1];
        const port = match[2];
        if (host.includes('localhost') || host.includes('127.0.0.1') || host === '::1') continue;

        connections.push({ process, host, port: parseInt(port, 10) });
        if (connections.length >= 20) break;
      }

      const unique = [...new Map(connections.map(c => [`${c.process}-${c.host}`, c])).values()];
      return unique.slice(0, 10);
    } catch (e) {
      return [];
    }
  });
}

async function getHealthStatus() {
  return withCache('health', 5000, async () => {
    const checks = {};
    let degraded = false;

    checks.api = {
      ok: true,
      uptimeSeconds: Math.floor(process.uptime())
    };

    const dbStart = Date.now();
    try {
      const rows = await queryDb('SELECT timestamp FROM metrics ORDER BY timestamp DESC LIMIT 1', { throwOnError: true });
      const lastTs = rows[0]?.timestamp ?? null;
      checks.database = {
        ok: true,
        latencyMs: Date.now() - dbStart,
        hasData: rows.length > 0,
        lastSampleAgeSec: lastTs ? Math.max(0, Math.floor(Date.now() / 1000) - lastTs) : null
      };
    } catch (e) {
      const errorText = formatError(e);
      if (errorText.includes('no such table: metrics')) {
        checks.database = {
          ok: true,
          initialized: false,
          latencyMs: Date.now() - dbStart,
          hasData: false,
          note: 'collector not initialized yet'
        };
      } else {
        degraded = true;
        checks.database = {
          ok: false,
          latencyMs: Date.now() - dbStart,
          error: errorText
        };
      }
    }

    const glancesStart = Date.now();
    try {
      await fetchGlancesJson('cpu');
      checks.glances = {
        ok: true,
        latencyMs: Date.now() - glancesStart
      };
    } catch (e) {
      degraded = true;
      checks.glances = {
        ok: false,
        latencyMs: Date.now() - glancesStart,
        error: formatError(e)
      };
    }

    const openclawStart = Date.now();
    const openclawPath = await getOpenclawPath();
    if (!openclawPath) {
      checks.openclaw = {
        ok: true,
        installed: false,
        optional: true,
        latencyMs: Date.now() - openclawStart
      };
    } else {
      try {
        await getOpenClawStatusJson();
        checks.openclaw = {
          ok: true,
          installed: true,
          latencyMs: Date.now() - openclawStart
        };
      } catch (e) {
        degraded = true;
        checks.openclaw = {
          ok: false,
          installed: true,
          latencyMs: Date.now() - openclawStart,
          error: formatError(e)
        };
      }
    }

    return {
      status: degraded ? 'degraded' : 'ok',
      timestamp: Date.now(),
      checks
    };
  });
}

// Fun programming quotes
const QUOTES = [
  { text: "Any fool can write code that a computer can understand. Good programmers write code that humans can understand.", author: "Martin Fowler" },
  { text: "First, solve the problem. Then, write the code.", author: "John Johnson" },
  { text: "Code is like humor. When you have to explain it, it's bad.", author: "Cory House" },
  { text: "Make it work, make it right, make it fast.", author: "Kent Beck" },
  { text: "The best error message is the one that never shows up.", author: "Thomas Fuchs" },
  { text: "Simplicity is the soul of efficiency.", author: "Austin Freeman" },
  { text: "Delete code is debugged code.", author: "Jeff Sickel" },
  { text: "It's not a bug, it's an undocumented feature.", author: "Anonymous" },
  { text: "Talk is cheap. Show me the code.", author: "Linus Torvalds" },
  { text: "Programs must be written for people to read.", author: "Harold Abelson" },
  { text: "The computer was born to solve problems that did not exist before.", author: "Bill Gates" },
  { text: "Measuring programming progress by lines of code is like measuring aircraft building progress by weight.", author: "Bill Gates" },
  { text: "Walking on water and developing software from a specification are easy if both are frozen.", author: "Edward Berard" },
  { text: "The only way to go fast is to go well.", author: "Robert C. Martin" },
  { text: "Weeks of coding can save you hours of planning.", author: "Unknown" },
  { text: "A ship in harbor is safe, but that's not what ships are built for.", author: "John A. Shedd" },
];

function getRandomQuote() {
  return QUOTES[Math.floor(Math.random() * QUOTES.length)];
}

async function getProcessInsights() {
  return withCache('process-insights', 10000, async () => {
    let currentProcs = [];
    try {
      const procs = await fetchGlancesJson('processlist');
      const seen = new Set();

      for (const p of procs.sort((a, b) => (b.cpu_percent || 0) - (a.cpu_percent || 0)).slice(0, 10)) {
        const name = p.name || 'unknown';
        if (seen.has(name)) continue;
        seen.add(name);

        currentProcs.push({
          name,
          cpu: p.cpu_percent || 0,
          ram_mb: (p.memory_info?.rss || 0) / (1024 * 1024)
        });
      }
    } catch (e) {
      // Ignore errors
    }

    const since24h = Math.floor(Date.now() / 1000) - 86400;
    const historicalAvg = await queryDb(`
      SELECT name, 
             AVG(cpu) as avg_cpu, 
             AVG(ram_mb) as avg_ram,
             COUNT(*) as samples
      FROM process_metrics 
      WHERE timestamp > ${since24h}
      GROUP BY name
      HAVING samples > 5
    `);

    const avgMap = {};
    for (const row of historicalAvg) {
      avgMap[row.name] = { cpu: row.avg_cpu, ram: row.avg_ram, samples: row.samples };
    }

    const insights = currentProcs.map(proc => {
      const hist = avgMap[proc.name];
      const insight = {
        name: proc.name,
        cpu: Math.round(proc.cpu * 10) / 10,
        ram_mb: Math.round(proc.ram_mb),
        avg_cpu: hist ? Math.round(hist.cpu * 10) / 10 : null,
        avg_ram: hist ? Math.round(hist.ram) : null,
        anomaly: null
      };

      if (hist) {
        if (hist.cpu > 1 && proc.cpu > hist.cpu * 2) {
          insight.anomaly = 'cpu_high';
        } else if (hist.ram > 50 && proc.ram_mb > hist.ram * 1.5) {
          insight.anomaly = 'ram_high';
        }
      }

      return insight;
    });

    const anomalies = insights.filter(i => i.anomaly);

    return {
      processes: insights.slice(0, 8),
      anomalies,
      hasHistory: historicalAvg.length > 0
    };
  });
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  const allowedOrigin = getAllowedOrigin(req);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(allowedOrigin ? 204 : 403);
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const glancesPath = url.pathname.startsWith('/api/glances/')
    ? url.pathname.slice('/api/glances/'.length)
    : url.pathname.startsWith('/glances/')
      ? url.pathname.slice('/glances/'.length)
      : null;

  if (glancesPath) {
    await proxyGlancesEndpoint(res, glancesPath);
    return;
  }
  
  try {
    if (url.pathname === '/openclaw' || url.pathname === '/api/openclaw') {
      sendJson(res, 200, await getOpenClawStats());
    } else if (url.pathname === '/openclaw/history' || url.pathname === '/api/openclaw/history') {
      const stats24h = await get24HourTokens();
      sendJson(res, 200, stats24h);
    } else if (url.pathname === '/history' || url.pathname === '/api/history') {
      const range = url.searchParams.get('range') || '1h';
      sendJson(res, 200, await getHistory(range));
    } else if (url.pathname === '/cron' || url.pathname === '/api/cron') {
      sendJson(res, 200, { jobs: await getCronJobs() });
    } else if (url.pathname === '/tokens' || url.pathname === '/api/tokens') {
      sendJson(res, 200, await getTokenBreakdown());
    } else if (url.pathname === '/connections' || url.pathname === '/api/connections') {
      sendJson(res, 200, { connections: await getConnections() });
    } else if (url.pathname === '/quote' || url.pathname === '/api/quote') {
      sendJson(res, 200, getRandomQuote());
    } else if (url.pathname === '/processes' || url.pathname === '/api/processes') {
      sendJson(res, 200, await getProcessInsights());
    } else if (url.pathname === '/health' || url.pathname === '/api/health') {
      sendJson(res, 200, await getHealthStatus());
    } else {
      sendJson(res, 404, { error: 'Not found' });
    }
  } catch (e) {
    sendJson(res, 500, { error: 'Internal server error', detail: formatError(e) });
  }
});

server.listen(PORT, API_BIND_ADDRESS, () => {
  console.log(`🦞 API Server running on http://${API_BIND_ADDRESS}:${PORT}`);
});
