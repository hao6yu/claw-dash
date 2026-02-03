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
 * 
 * Configuration via environment variables:
 * - PORT (default: 8889)
 * - GLANCES_URL (default: http://localhost:61208)
 */

const http = require('http');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Configuration
const PORT = process.env.PORT || 8889;
const DB_PATH = path.join(__dirname, 'history.db');
const HOME_DIR = os.homedir();

// Auto-detect openclaw path
function findOpenclawPath() {
  const possiblePaths = [
    path.join(HOME_DIR, '.nvm/versions/node', process.version, 'bin/openclaw'),
    '/usr/local/bin/openclaw',
    '/opt/homebrew/bin/openclaw',
    'openclaw' // Fallback to PATH
  ];
  
  for (const p of possiblePaths) {
    try {
      if (p === 'openclaw' || fs.existsSync(p)) {
        execSync(`${p} --version`, { encoding: 'utf8', timeout: 5000 });
        return p;
      }
    } catch (e) {
      continue;
    }
  }
  return 'openclaw'; // Fallback
}

const OPENCLAW_PATH = findOpenclawPath();

// Cache for last known OpenClaw state
let lastKnownOpenClaw = null;

// Simple SQLite reader (no dependencies)
function queryDb(sql, params = []) {
  try {
    // Use sqlite3 CLI
    const escaped = sql.replace(/'/g, "''");
    const result = execSync(`sqlite3 -json "${DB_PATH}" "${escaped}"`, {
      encoding: 'utf8',
      timeout: 5000
    });
    return JSON.parse(result || '[]');
  } catch (e) {
    return [];
  }
}

function get24HourTokens() {
  // Get token stats from last 24 hours
  const since = Math.floor(Date.now() / 1000) - 86400;
  const rows = queryDb(`SELECT * FROM openclaw_stats WHERE timestamp > ${since} ORDER BY timestamp`);
  
  if (rows.length === 0) return { tokens24h: 0, samples: 0 };
  
  // Calculate token delta over 24h period
  const first = rows[0];
  const last = rows[rows.length - 1];
  const tokenDelta = last.tokens - first.tokens;
  
  return {
    tokens24h: Math.max(0, tokenDelta), // In case of reset
    samples: rows.length,
    history: rows  // For charting
  };
}

function getOpenClawStats() {
  try {
    const openclawPath = OPENCLAW_PATH;
    const result = execSync(`${openclawPath} status --json`, {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, HOME: HOME_DIR }
    });
    const status = JSON.parse(result);
    const sessions = status.sessions || {};
    const recent = sessions.recent || [];
    const totalTokens = recent.slice(0, 10).reduce((sum, s) => sum + (s.totalTokens || 0), 0);
    
    // Get 24h stats from database
    const stats24h = get24HourTokens();
    
    // Get main session context info
    const mainSession = recent.find(s => s.key === 'agent:main:main') || recent[0] || {};
    
    const stats = {
      installed: true,
      status: 'running',
      sessions: sessions.count || 0,
      tokens: totalTokens,
      tokens24h: stats24h.tokens24h,
      lastUpdated: Date.now(),
      // Extended stats
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
    
    // Cache for when service is down
    lastKnownOpenClaw = stats;
    
    return stats;
  } catch (e) {
    // Service is down - return last known state if available
    if (lastKnownOpenClaw) {
      return {
        ...lastKnownOpenClaw,
        status: 'down',
        lastUpdated: lastKnownOpenClaw.lastUpdated,
        cached: true
      };
    }
    
    // Try to get last known from database
    const rows = queryDb('SELECT * FROM openclaw_stats ORDER BY timestamp DESC LIMIT 1');
    if (rows.length > 0) {
      const last = rows[0];
      const stats24h = get24HourTokens();
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
    
    return { installed: false, status: 'unknown', error: e.message };
  }
}

function getHistory(range) {
  const ranges = {
    '1h': 3600,
    '8h': 28800,
    '24h': 86400,
    '7d': 604800,
    '30d': 2592000
  };
  const seconds = ranges[range] || 3600;
  const since = Math.floor(Date.now() / 1000) - seconds;
  
  const rows = queryDb(`SELECT * FROM metrics WHERE timestamp > ${since} ORDER BY timestamp`);
  return {
    range,
    count: rows.length,
    metrics: rows
  };
}

// Claude pricing (per million tokens)
const PRICING = {
  'claude-opus-4-5': { input: 15, output: 75 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'default': { input: 15, output: 75 }
};

function getCronJobs() {
  try {
    const openclawPath = OPENCLAW_PATH;
    const result = execSync(`${openclawPath} cron list --json`, {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, HOME: HOME_DIR }
    });
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
}

function getTokenBreakdown() {
  try {
    const openclawPath = OPENCLAW_PATH;
    const result = execSync(`${openclawPath} status --json`, {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, HOME: HOME_DIR }
    });
    const status = JSON.parse(result);
    const recent = status.sessions?.recent || [];
    
    const model = recent[0]?.model || 'default';
    
    // Sum totalTokens across recent sessions (this is cumulative usage)
    let totalTokens = 0;
    recent.slice(0, 10).forEach(s => {
      totalTokens += s.totalTokens || 0;
    });
    
    // Estimate input/output split (typical ratio is ~20% input, 80% output for chat)
    // This is an approximation since OpenClaw doesn't track cumulative input/output
    const estimatedInput = Math.round(totalTokens * 0.25);
    const estimatedOutput = Math.round(totalTokens * 0.75);
    
    const pricing = PRICING[model] || PRICING.default;
    const inputCost = (estimatedInput / 1000000) * pricing.input;
    const outputCost = (estimatedOutput / 1000000) * pricing.output;
    
    return {
      input: estimatedInput,
      output: estimatedOutput,
      total: totalTokens,
      model,
      estimated: true, // Flag that input/output is estimated
      cost: {
        input: inputCost,
        output: outputCost,
        total: inputCost + outputCost,
        currency: 'USD'
      }
    };
  } catch (e) {
    return { input: 0, output: 0, total: 0, cost: { total: 0 } };
  }
}

function getConnections() {
  try {
    const result = execSync(`/usr/sbin/lsof -i -P 2>/dev/null | grep ESTABLISHED | head -20`, {
      encoding: 'utf8',
      timeout: 5000
    });
    
    const connections = [];
    const lines = result.trim().split('\n').filter(Boolean);
    
    for (const line of lines) {
      const parts = line.split(/\s+/);
      const process = parts[0];
      const connection = parts[8] || '';
      
      // Parse connection like "192.168.50.2:59113->17.42.251.72:993"
      const match = connection.match(/->([^:]+):(\d+)/);
      if (match) {
        const host = match[1];
        const port = match[2];
        // Skip local connections
        if (!host.includes('localhost') && !host.includes('127.0.0.1')) {
          connections.push({ process, host, port: parseInt(port) });
        }
      }
    }
    
    // Dedupe and limit
    const unique = [...new Map(connections.map(c => [`${c.process}-${c.host}`, c])).values()];
    return unique.slice(0, 10);
  } catch (e) {
    return [];
  }
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

function getProcessInsights() {
  // Get current top processes from Glances
  let currentProcs = [];
  try {
    const result = execSync('curl -s http://localhost:61208/api/4/processlist', {
      encoding: 'utf8',
      timeout: 5000
    });
    const procs = JSON.parse(result);
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
  
  // Get 24h historical averages from database
  const since24h = Math.floor(Date.now() / 1000) - 86400;
  const historicalAvg = queryDb(`
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
  
  // Compare current to historical and detect anomalies
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
    
    // Detect anomalies (>100% higher than average)
    if (hist) {
      if (hist.cpu > 1 && proc.cpu > hist.cpu * 2) {
        insight.anomaly = 'cpu_high';
      } else if (hist.ram > 50 && proc.ram_mb > hist.ram * 1.5) {
        insight.anomaly = 'ram_high';
      }
    }
    
    return insight;
  });
  
  // Find any anomalies to highlight
  const anomalies = insights.filter(i => i.anomaly);
  
  return {
    processes: insights.slice(0, 8),
    anomalies,
    hasHistory: historicalAvg.length > 0
  };
}

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  if (url.pathname === '/openclaw' || url.pathname === '/api/openclaw') {
    res.writeHead(200);
    res.end(JSON.stringify(getOpenClawStats()));
  } else if (url.pathname === '/openclaw/history' || url.pathname === '/api/openclaw/history') {
    // Return 24h token usage history for charting
    const stats24h = get24HourTokens();
    res.writeHead(200);
    res.end(JSON.stringify(stats24h));
  } else if (url.pathname === '/history' || url.pathname === '/api/history') {
    const range = url.searchParams.get('range') || '1h';
    res.writeHead(200);
    res.end(JSON.stringify(getHistory(range)));
  } else if (url.pathname === '/cron' || url.pathname === '/api/cron') {
    res.writeHead(200);
    res.end(JSON.stringify({ jobs: getCronJobs() }));
  } else if (url.pathname === '/tokens' || url.pathname === '/api/tokens') {
    res.writeHead(200);
    res.end(JSON.stringify(getTokenBreakdown()));
  } else if (url.pathname === '/connections' || url.pathname === '/api/connections') {
    res.writeHead(200);
    res.end(JSON.stringify({ connections: getConnections() }));
  } else if (url.pathname === '/quote' || url.pathname === '/api/quote') {
    res.writeHead(200);
    res.end(JSON.stringify(getRandomQuote()));
  } else if (url.pathname === '/processes' || url.pathname === '/api/processes') {
    res.writeHead(200);
    res.end(JSON.stringify(getProcessInsights()));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🦞 API Server running on http://0.0.0.0:${PORT}`);
});
