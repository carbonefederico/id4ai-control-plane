import express from 'express';
import cors from 'cors';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getMcps, getMcpById, getCachedMcps, warmMcpCache } from './routes/mcps.js';
import { getMcpPolicySets, getMcpPolicySummary, getPolicySetDependencies } from './routes/policies.js';
import { getAgents } from './routes/agents.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3033;

app.use(cors());
app.use(express.json());

// Serve the frontend from ../frontend
app.use(express.static(join(__dirname, '..', 'frontend')));

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── MCP routes ────────────────────────────────────────────────────────────────
// GET /api/mcps          — list all MCP servers parsed from GitHub route files
// GET /api/mcps/:id      — get a single MCP server by route name
app.get('/api/mcps', getMcps);
app.get('/api/mcps/:id', getMcpById);

// ── Summary (dashboard KPIs) ──────────────────────────────────────────────────
// Aggregates counts from all connected sources.
// Agents, policies, and events are stubbed — wire up AIC / Authorize / log files here.
app.get('/api/summary', async (_req, res) => {
  try {
    const mcps = getCachedMcps();
    // Fetch live agent count from AIC (non-blocking — falls back to null on error)
    let agentCount = null;
    try {
      const aicRes = await fetch(`http://localhost:${PORT}/api/agents`);
      if (aicRes.ok) agentCount = (await aicRes.json()).length;
    } catch { /* AIC not configured */ }

    res.json({
      mcpCount:    mcps.length,
      agentCount,
      policyCount: 24,    // TODO: pull from PingAuthorize
      events24h:   1842,  // TODO: parse gateway log files
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Agents — live from AIC ────────────────────────────────────────────────────
app.get('/api/agents', getAgents);

// ── PingAuthorize — MCP policy sets ──────────────────────────────────────────
// GET /api/paz/mcp-policysets              — MCP root + child policy sets
// GET /api/paz/mcp-summary                 — scopes/audience/policy-count per MCP
// GET /api/paz/policysets/:id/dependencies — full policy/rule tree for one set
app.get('/api/paz/mcp-policysets', getMcpPolicySets);
app.get('/api/paz/mcp-summary', getMcpPolicySummary);
app.get('/api/paz/policysets/:id/dependencies', getPolicySetDependencies);

// ── Policies (stub — wire to PingAuthorize) ───────────────────────────────────
app.get('/api/policies', (_req, res) => {
  res.json([
    { id: 'pol-7f31a', name: 'claims-read-standard', scope: 'claims.read', tool: 'get_claim_status', conditions: 'tenant = agent.tenant', decision: 'allow', updated: '2026-08-01' },
    { id: 'pol-91c8e', name: 'travel-booking-step-up', scope: 'booking.write', tool: 'book_flight', conditions: 'risk < medium · mfa = true', decision: 'allow', updated: '2026-07-30' },
    { id: 'pol-4bd27', name: 'finance-export-deny', scope: 'report.export', tool: 'export_report', conditions: 'device_trust = high', decision: 'conditional', updated: '2026-07-29' },
    { id: 'pol-a17d2', name: 'employee-data-boundary', scope: 'employee.read', tool: 'get_employee', conditions: 'region ∈ EU', decision: 'allow', updated: '2026-07-28' },
  ]);
});

// ── Logs (stub — wire to Gateway log files) ───────────────────────────────────
app.get('/api/logs', (_req, res) => {
  res.json([
    { id: 'evt_8bd71', time: '14:31:42.208', agent: 'Claims Assistant', server: 'claims-mcp', tool: 'get_claim_status', policy: 'pol-7f31a', decision: 'allowed', latencyMs: 82 },
    { id: 'evt_8bd70', time: '14:31:38.917', agent: 'Travel Concierge', server: 'travel-mcp', tool: 'book_flight', policy: 'pol-91c8e', decision: 'allowed', latencyMs: 116 },
    { id: 'evt_8bd6f', time: '14:30:59.483', agent: 'Finance Copilot', server: 'finance-mcp', tool: 'export_report', policy: 'pol-4bd27', decision: 'denied', latencyMs: 44 },
    { id: 'evt_8bd6e', time: '14:30:32.114', agent: 'Claims Assistant', server: 'claims-mcp', tool: 'update_claim', policy: 'pol-7f31a', decision: 'allowed', latencyMs: 91 },
    { id: 'evt_8bd6d', time: '14:29:17.041', agent: 'HR Advisor', server: 'people-mcp', tool: 'get_employee', policy: 'pol-a17d2', decision: 'allowed', latencyMs: 63 },
  ]);
});

app.listen(PORT, () => {
  console.log(`ID4AI API running on http://localhost:${PORT}`);
  console.log(`  GitHub source: ${process.env.GITHUB_OWNER || 'your-org'}/${process.env.GITHUB_REPO || 'your-gateway-repo'} @ ${process.env.GITHUB_PATH || 'config/routes'}`);
  console.log(`  Set GITHUB_OWNER, GITHUB_REPO, GITHUB_PATH env vars to point at your repo.`);
  warmMcpCache();
});
