const API_BASE = '/api';

// ── Navigation ────────────────────────────────────────────────────────────────
const pages = { dashboard: 'Dashboard', agents: 'Agents', mcps: 'MCP Servers' };
const navItems = document.querySelectorAll('.nav-item');
const pageEls = document.querySelectorAll('.page');
const crumb = document.getElementById('crumb-current');

function showPage(name) {
  if (!pages[name]) return;
  pageEls.forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
  navItems.forEach(n => n.classList.toggle('active', n.dataset.page === name));
  crumb.textContent = pages[name];
  if (name === 'agents') { showListView('agents'); loadAgents(); }
  if (name === 'mcps') { showListView('mcps'); loadMcps(); }
  if (name === 'dashboard') loadDashboard();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

navItems.forEach(item => item.addEventListener('click', () => showPage(item.dataset.page)));
document.querySelectorAll('[data-page-link]').forEach(el => el.addEventListener('click', () => showPage(el.dataset.pageLink)));

// ── Refresh button ────────────────────────────────────────────────────────────
document.querySelectorAll('[data-action="refresh"]').forEach(btn => btn.addEventListener('click', async () => {
  btn.innerHTML = '<span class="button-icon"><span class="spinner"></span></span>Syncing…';
  btn.disabled = true;
  await loadDashboard(true);
  await loadMcps(true);
  btn.innerHTML = '<span class="button-icon">✓</span>Sources synced';
  btn.disabled = false;
  setTimeout(() => { btn.innerHTML = '<span class="button-icon">↻</span>Refresh sources'; }, 2000);
}));

document.querySelectorAll('[data-action="export"]').forEach(btn => btn.addEventListener('click', () => window.print()));

// ── Search / filter ───────────────────────────────────────────────────────────
document.querySelectorAll('[data-filter]').forEach(input => input.addEventListener('input', e => {
  const value = e.target.value.toLowerCase();
  const table = e.target.closest('.panel').querySelector('tbody');
  if (!table) return;
  table.querySelectorAll('tr').forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(value) ? '' : 'none';
  });
}));

// ── Helper: fetch with error handling ─────────────────────────────────────────
async function apiFetch(path) {
  const res = await fetch(API_BASE + path);
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

function showError(containerId, message) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<div class="error-banner">⚠ ${message}</div>`;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function loadDashboard(force = false) {
  try {
    const data = await apiFetch('/summary');
    document.getElementById('kpi-mcps-value').textContent   = data.mcpCount   ?? '—';
    document.getElementById('kpi-agents-value').textContent = data.agentCount ?? '—';
    // kpi-tools-value is set below from pazSummary once it loads
    const syncEl = document.getElementById('last-sync');
    if (syncEl) syncEl.textContent = 'Last sync ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' CET';
  } catch (e) {
    console.warn('Dashboard summary unavailable:', e.message);
  }

  try {
    const [agents, pazSummary] = await Promise.all([
      window._agentData   ? Promise.resolve(window._agentData)   : apiFetch('/agents').then(d => { window._agentData = d; return d; }),
      window._pazSummary  ? Promise.resolve(window._pazSummary)  : apiFetch('/paz/mcp-summary').then(d => { window._pazSummary = d; return d; }),
    ]);
    const toolCount = Object.values(pazSummary).reduce((s, i) => s + (i.policyCount || 0), 0);
    const toolsEl = document.getElementById('kpi-tools-value');
    if (toolsEl) toolsEl.textContent = toolCount || '—';
    renderCoverageByAgent(agents, pazSummary);
    renderCoverageMcpList(agents, pazSummary);
    renderAccessGraph(agents, pazSummary);
  } catch (e) {
    console.warn('Coverage/graph data unavailable:', e.message);
    const g = document.getElementById('agent-mcp-graph');
    if (g) g.innerHTML = `<div class="error-banner" style="margin:0">⚠ Could not load data: ${e.message}</div>`;
  }
}

function renderCoverageByAgent(agents, pazSummary) {
  const el = document.getElementById('coverage-by-agent');
  const countEl = document.getElementById('coverage-agent-count');
  if (!el) return;
  if (!agents.length) { el.innerHTML = '<div class="empty-state" style="padding:20px"><strong>No agents</strong></div>'; return; }
  const rows = agents
    .map(a => ({ agent: a, count: Object.values(pazSummary).filter(i => i.agentSubjects?.includes(a.id)).length }))
    .sort((a, b) => b.count - a.count);
  const max = Math.max(...rows.map(r => r.count), 1);
  const colors = ['', 'purple', 'cyan', 'green', ''];
  el.innerHTML = rows.map(({ agent, count }, i) =>
    `<div class="bar-row">
      <div class="bar-label"><span>${agent.name}</span><span>${count} MCP${count !== 1 ? 's' : ''}</span></div>
      <div class="bar-track"><div class="bar-fill ${colors[i % colors.length]}" style="width:${Math.round(count / max * 100)}%"></div></div>
    </div>`
  ).join('');
  if (countEl) countEl.textContent = `${agents.length} agents`;
}

function renderCoverageMcpList(agents, pazSummary) {
  const el = document.getElementById('coverage-mcp-list');
  if (!el) return;
  const agentIds = new Set(agents.map(a => a.id));
  const entries = Object.entries(pazSummary)
    .map(([name, info]) => ({ name, agentCount: (info.agentSubjects || []).filter(id => agentIds.has(id)).length }))
    .sort((a, b) => b.agentCount - a.agentCount);
  if (!entries.length) { el.innerHTML = '<div class="empty-state" style="padding:20px"><strong>No MCP policy sets</strong></div>'; return; }
  const max = Math.max(...entries.map(e => e.agentCount), 1);
  const colors = ['cyan', '', 'purple', 'green', ''];
  el.innerHTML = entries.map(({ name, agentCount }, i) =>
    `<div class="bar-row">
      <div class="bar-label"><span>${name}</span><span>${agentCount} agent${agentCount !== 1 ? 's' : ''}</span></div>
      <div class="bar-track"><div class="bar-fill ${colors[i % colors.length]}" style="width:${Math.round(agentCount / max * 100)}%"></div></div>
    </div>`
  ).join('');
}

function renderAccessGraph(agents, pazSummary) {
  const container = document.getElementById('agent-mcp-graph');
  if (!container) return;

  const mcpEntries = Object.entries(pazSummary).filter(([, i]) => (i.agentSubjects || []).length > 0);
  const mcpNames   = mcpEntries.map(([n]) => n);

  if (!agents.length || !mcpNames.length) {
    container.innerHTML = '<div class="empty-state"><strong>No access grants</strong>No agent is listed in any MCP Allow Actor Subject rule.</div>';
    return;
  }

  const edges = [];
  for (const [mcpName, info] of mcpEntries)
    for (const agentId of (info.agentSubjects || []))
      if (agents.find(a => a.id === agentId)) edges.push({ agentId, mcpName });

  const W       = container.clientWidth || 800;
  const nodeR   = 8;
  const agentX  = Math.min(240, W * 0.28);
  const mcpX    = W - Math.min(240, W * 0.28);
  const padY    = 48;
  const agentGap = Math.max(48, 420 / Math.max(agents.length, 1));
  const mcpGap   = Math.max(48, 420 / Math.max(mcpNames.length, 1));
  const H = Math.max(agents.length * agentGap, mcpNames.length * mcpGap) + padY * 2;

  const agentPos = agents.map((a, i) => ({ ...a, cx: agentX, cy: padY + i * agentGap + agentGap / 2 }));
  const mcpPos   = mcpNames.map((n, i) => ({ name: n, cx: mcpX, cy: padY + i * mcpGap + mcpGap / 2 }));

  const edgesSvg = edges.map(({ agentId, mcpName }) => {
    const a = agentPos.find(p => p.id === agentId);
    const m = mcpPos.find(p => p.name === mcpName);
    if (!a || !m) return '';
    const mx = (a.cx + m.cx) / 2;
    return `<path class="graph-edge" data-agent="${agentId}" data-mcp="${mcpName}"
      d="M${a.cx + nodeR},${a.cy} C${mx},${a.cy} ${mx},${m.cy} ${m.cx - nodeR},${m.cy}"
      fill="none" stroke="var(--artifact-border-dark)" stroke-width="1.5" stroke-linecap="round"/>`;
  }).join('');

  const agentNodes = agentPos.map(({ id, name, cx, cy }) =>
    `<g class="graph-node graph-agent" data-agent="${id}" style="cursor:pointer">
      <circle cx="${cx}" cy="${cy}" r="${nodeR}" fill="var(--artifact-purple-background)" stroke="var(--artifact-purple)" stroke-width="1.5"/>
      <text x="${cx - nodeR - 8}" y="${cy + 4}" text-anchor="end" fill="var(--artifact-text-primary)" font-size="11.5" font-family="Inter,sans-serif">${name}</text>
    </g>`
  ).join('');

  const mcpNodes = mcpPos.map(({ name, cx, cy }) =>
    `<g class="graph-node graph-mcp" data-mcp="${name}" style="cursor:pointer">
      <circle cx="${cx}" cy="${cy}" r="${nodeR}" fill="var(--artifact-cyan-background)" stroke="var(--artifact-cyan)" stroke-width="1.5"/>
      <text x="${cx + nodeR + 8}" y="${cy + 4}" text-anchor="start" fill="var(--artifact-text-primary)" font-size="11.5" font-family="Inter,sans-serif">${name}</text>
    </g>`
  ).join('');

  container.innerHTML = `<svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}">
    <text x="${agentX}" y="22" text-anchor="middle" fill="var(--artifact-text-secondary)" font-size="10" font-family="SF Mono,Consolas,monospace" letter-spacing="0.1em">AGENTS</text>
    <text x="${mcpX}" y="22" text-anchor="middle" fill="var(--artifact-text-secondary)" font-size="10" font-family="SF Mono,Consolas,monospace" letter-spacing="0.1em">MCP SERVERS</text>
    <g>${edgesSvg}</g>
    <g>${agentNodes}</g>
    <g>${mcpNodes}</g>
  </svg>`;

  const svg = container.querySelector('svg');

  const resetGraph = () => {
    svg.querySelectorAll('.graph-edge').forEach(e => { e.style.opacity = ''; e.style.stroke = ''; e.style.strokeWidth = ''; });
    svg.querySelectorAll('.graph-node').forEach(n => n.style.opacity = '');
  };

  const highlightAgent = agentId => {
    svg.querySelectorAll('.graph-edge').forEach(e => e.style.opacity = '0.05');
    svg.querySelectorAll('.graph-node').forEach(n => n.style.opacity = '0.15');
    svg.querySelectorAll(`.graph-edge[data-agent="${agentId}"]`).forEach(e => { e.style.opacity = '1'; e.style.stroke = 'var(--artifact-purple)'; e.style.strokeWidth = '2.5'; });
    svg.querySelectorAll(`.graph-agent[data-agent="${agentId}"]`).forEach(n => n.style.opacity = '1');
    new Set(edges.filter(e => e.agentId === agentId).map(e => e.mcpName))
      .forEach(m => svg.querySelectorAll(`.graph-mcp[data-mcp="${m}"]`).forEach(n => n.style.opacity = '1'));
  };

  const highlightMcp = mcpName => {
    svg.querySelectorAll('.graph-edge').forEach(e => e.style.opacity = '0.05');
    svg.querySelectorAll('.graph-node').forEach(n => n.style.opacity = '0.15');
    svg.querySelectorAll(`.graph-edge[data-mcp="${mcpName}"]`).forEach(e => { e.style.opacity = '1'; e.style.stroke = 'var(--artifact-cyan)'; e.style.strokeWidth = '2.5'; });
    svg.querySelectorAll(`.graph-mcp[data-mcp="${mcpName}"]`).forEach(n => n.style.opacity = '1');
    new Set(edges.filter(e => e.mcpName === mcpName).map(e => e.agentId))
      .forEach(a => svg.querySelectorAll(`.graph-agent[data-agent="${a}"]`).forEach(n => n.style.opacity = '1'));
  };

  svg.addEventListener('mouseover', e => {
    const an = e.target.closest('.graph-agent');
    const mn = e.target.closest('.graph-mcp');
    if (an) highlightAgent(an.dataset.agent);
    else if (mn) highlightMcp(mn.dataset.mcp);
  });
  svg.addEventListener('mouseout', e => {
    if (!e.relatedTarget?.closest?.('.graph-node')) resetGraph();
  });
  svg.querySelectorAll('.graph-agent').forEach(node =>
    node.addEventListener('click', () => {
      const agent = agents.find(a => a.id === node.dataset.agent);
      if (agent) { showPage('agents'); setTimeout(() => openAgentDetail(agent), 80); }
    })
  );
  svg.querySelectorAll('.graph-mcp').forEach(node =>
    node.addEventListener('click', () => showPage('mcps'))
  );
}

// ── MCP Servers ───────────────────────────────────────────────────────────────
async function loadMcps(force = false) {
  const tbody = document.getElementById('mcps-tbody');
  const statActive = document.getElementById('mcp-stat-active-value');
  if (!tbody) return;

  tbody.innerHTML = '<tr class="loading-row"><td colspan="6"><span class="spinner"></span> Loading MCP servers from GitHub…</td></tr>';

  // Fetch GitHub routes, PAZ policy set list, and PAZ scope summary in parallel
  const [mcpsResult, pazResult, summaryResult] = await Promise.allSettled([
    apiFetch('/mcps'),
    apiFetch('/paz/mcp-policysets'),
    apiFetch('/paz/mcp-summary'),
  ]);

  if (mcpsResult.status === 'rejected') {
    tbody.innerHTML = `<tr><td colspan="6"><div class="error-banner">⚠ Failed to load MCP servers: ${mcpsResult.reason.message}</div></td></tr>`;
    return;
  }

  const mcps = mcpsResult.value;

  // Build a name→policyset lookup (case-insensitive)
  const pazByName = {};
  if (pazResult.status === 'fulfilled' && pazResult.value.mcpRootFound) {
    for (const ps of pazResult.value.policysets) {
      pazByName[ps.name.toLowerCase()] = ps;
    }
  }
  const pazAvailable = pazResult.status === 'fulfilled';
  // name→{id,name,policyCount,scopes,audience}
  const pazSummary = summaryResult.status === 'fulfilled' ? summaryResult.value : {};
  window._pazData = pazByName;
  window._pazSummary = pazSummary;

  // Update stat tiles
  if (statActive) statActive.textContent = mcps.length;
  const navCount = document.querySelector('[data-page="mcps"] .count');
  if (navCount) navCount.textContent = mcps.length;

  if (!mcps.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><strong>No MCP servers found</strong>Check the GitHub config in the backend.</td></tr>';
    return;
  }

  tbody.innerHTML = mcps.map(mcp => {
    const key = mcp.name.toLowerCase();
    const matchedPs  = pazByName[key];
    const summary    = pazSummary[key];

    // SCOPES column — from PAZ summary
    let scopesCell;
    if (!pazAvailable) {
      scopesCell = '<span class="secondary" style="font-size:11px">PAZ unavailable</span>';
    } else if (summary?.scopes?.length) {
      scopesCell = summary.scopes.map(s => `<span class="scope">${s}</span>`).join('');
    } else {
      scopesCell = '<span class="secondary" style="font-size:11px">—</span>';
    }

    // POLICIES column
    let policiesCell;
    if (!pazAvailable) {
      policiesCell = '<span class="secondary" style="font-size:11px">PAZ unavailable</span>';
    } else if (matchedPs) {
      const count = summary?.policyCount ?? matchedPs.policyCount ?? 0;
      policiesCell = `<span class="status allow"><i class="dot"></i>${count} polic${count !== 1 ? 'ies' : 'y'}</span>`;
    } else {
      policiesCell = '<span class="status neutral">No policy set</span>';
    }

    const statusClass = mcp.status === 'Healthy' ? 'allow' : 'warn';
    const initials = mcp.name.replace(/mcp/gi, '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '⌁';
    const publicUrl = mcp.publicUrl || mcp.path || '—';

    return `<tr class="clickable-row" data-detail-mcp="${mcp.id}">
      <td><div class="entity">
        <div class="entity-icon">${initials}</div>
        <div><div class="entity-name">${mcp.name}</div><div class="entity-sub">${mcp.path || ''}</div></div>
      </div></td>
      <td class="mono">${publicUrl}</td>
      <td class="mono secondary">${mcp.upstream || '—'}</td>
      <td>${scopesCell}</td>
      <td>${policiesCell}</td>
      <td><span class="status ${statusClass}"><i class="dot"></i>${mcp.status}</span></td>
    </tr>`;
  }).join('');

  // Re-attach click handlers
  tbody.querySelectorAll('[data-detail-mcp]').forEach(row => {
    row.addEventListener('click', () => openMcpDetail(row.dataset.detailMcp, mcps));
  });

  window._mcpData = mcps;
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tabId) {
  document.querySelectorAll('.tab-btn[data-tab]').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tab === tabId)
  );
  document.querySelectorAll('.tab-panel').forEach(panel =>
    panel.classList.toggle('tab-hidden', panel.id !== tabId)
  );
}

document.querySelectorAll('.tab-btn[data-tab]').forEach(btn =>
  btn.addEventListener('click', () => switchTab(btn.dataset.tab))
);

// ── MCP Detail View ───────────────────────────────────────────────────────────
async function openMcpDetail(id, mcps) {
  const mcp = (mcps || window._mcpData || []).find(m => m.id === id);
  if (!mcp) return;

  // Header
  document.getElementById('mcp-detail-title').textContent = mcp.name;
  document.getElementById('mcp-detail-subtitle').textContent = mcp.publicUrl || mcp.path || mcp.name;

  // Route Config tab — always available immediately from GitHub data
  renderRouteConfig(mcp);

  // Show panel on Policies tab by default
  showDetailView('mcps');
  switchTab('mcp-tab-policies');

  // Policies tab — async fetch from PAZ
  const policiesEl = document.getElementById('mcp-policies-content');
  const pazPs = (window._pazData || {})[mcp.name.toLowerCase()];

  if (!pazPs) {
    policiesEl.innerHTML = `<div class="empty-state">
      <strong>No matching policy set</strong>
      No policy set named "${mcp.name}" found under the MCP root in PingAuthorize.
    </div>`;
    return;
  }

  policiesEl.innerHTML = '<div class="policy-loading"><span class="spinner"></span></div>';

  try {
    const deps = await apiFetch(`/paz/policysets/${pazPs.id}/dependencies`);
    policiesEl.innerHTML = renderPolicies(deps);
  } catch (e) {
    policiesEl.innerHTML = `<div class="error-banner" style="margin:0">⚠ Failed to load policies: ${e.message}</div>`;
  }
}

function renderRouteConfig(mcp) {
  const filters    = mcp.filters    || [];
  const rawFilters = mcp.rawFilters || [];
  const mapEl = document.getElementById('mcp-agent-map');

  if (!filters.length) {
    mapEl.innerHTML = '<div class="empty-state"><strong>No filter chain defined</strong>This route has no configured filters.</div>';
    return;
  }

  mapEl.innerHTML = filters.map((f, i) => {
    const raw       = rawFilters[i];
    const isObj     = typeof raw === 'object' && raw !== null;
    const typeName  = isObj ? raw.type : f;
    const configStr = isObj && raw.config ? JSON.stringify(raw.config, null, 2) : '';
    return `<div class="access-row">
      <div class="access-cell"><span class="field-label">Filter ${i + 1}</span><strong>${typeName}</strong></div>
      <div class="access-arrow">→</div>
      <div class="access-cell"><span class="field-label">Config</span>
        <div class="mono secondary" style="white-space:pre;font-size:10px;line-height:1.45">${configStr || 'Default configuration'}</div>
      </div>
      <div class="access-arrow">→</div>
      <div class="access-cell"><span class="field-label">Handler</span><strong class="mono">${mcp.handler || 'ReverseProxyHandler'}</strong></div>
    </div>`;
  }).join('');
}

function renderPolicies(deps) {
  if (!deps.policies?.length) {
    return '<div class="empty-state"><strong>No policies defined</strong>This policy set has no child policies yet.</div>';
  }

  // MCP-level security: audience (from policy set condition) + allowed agent (from "common" policy)
  const summaryHtml = (deps.audience || deps.agentSubject) ? `
    <div class="policy-mcp-security">
      <div class="policy-mcp-security-head">MCP Security</div>
      ${deps.audience ? `
        <div class="policy-chip-row">
          <span class="field-label">Expected Audience</span>
          <span class="chip-audience">${deps.audience}</span>
        </div>` : ''}
      ${deps.agentSubjects?.length ? `
        <div class="policy-chip-row">
          <span class="field-label">Allowed Agents</span>
          <div class="chip-list">${deps.agentSubjects.map(a => `<span class="chip-agent">${a}</span>`).join('')}</div>
        </div>` : ''}
    </div>` : '';

  const rows = deps.policies.map(policy => {
    const toolLabel     = policy.toolName || policy.name;
    const methodBadge   = policy.method ? `<span class="scope" style="margin-left:6px">${policy.method}</span>` : '';
    const disabledBadge = policy.disabled ? ' <span class="status warn" style="font-size:10px;margin-left:4px">Disabled</span>' : '';

    const scopeChips = policy.scopes?.length
      ? `<div class="chip-list">${policy.scopes.map(s => `<span class="scope">${s}</span>`).join('')}</div>`
      : '<span class="secondary" style="font-size:11px">—</span>';

    const roleChip = policy.role
      ? `<span class="chip-role">${policy.role}</span>`
      : '<span class="secondary" style="font-size:11px">—</span>';

    return `<tr>
      <td style="white-space:nowrap;text-align:left"><strong>${toolLabel}</strong>${disabledBadge}${methodBadge}</td>
      <td style="text-align:left">${scopeChips}</td>
      <td style="text-align:left">${roleChip}</td>
    </tr>`;
  }).join('');

  const tableHtml = `<div class="table-wrap"><table style="min-width:0">
    <thead><tr><th style="text-align:left">TOOL</th><th style="text-align:left">EXPECTED SCOPE</th><th style="text-align:left">EXPECTED USER ROLE</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;

  return summaryHtml + tableHtml;
}


// ── Agents — live from AIC ────────────────────────────────────────────────────
async function loadAgents() {
  const tbody = document.getElementById('agents-tbody');
  if (!tbody) return;

  tbody.innerHTML = '<tr class="loading-row"><td colspan="3"><span class="spinner"></span> Loading agents from AIC…</td></tr>';

  try {
    const [agents, pazSummary] = await Promise.all([
      apiFetch('/agents'),
      window._pazSummary
        ? Promise.resolve(window._pazSummary)
        : apiFetch('/paz/mcp-summary').catch(() => ({})),
    ]);
    window._agentData  = agents;
    window._pazSummary = pazSummary;

    // Stat cards
    const activeCount  = agents.filter(a => a.status === 'Active').length;
    const allScopes    = new Set(agents.flatMap(a => a.scopes));
    const totalEl      = document.getElementById('agent-stat-total');
    const totalNoteEl  = document.getElementById('agent-stat-total-note');
    const activeEl     = document.getElementById('agent-stat-active');
    const activeNoteEl = document.getElementById('agent-stat-active-note');
    const scopesEl     = document.getElementById('agent-stat-scopes');
    if (totalEl)      totalEl.textContent      = agents.length;
    if (totalNoteEl)  totalNoteEl.textContent  = `${activeCount} active · ${agents.length - activeCount} paused`;
    if (activeEl)     activeEl.textContent     = activeCount;
    if (activeNoteEl) activeNoteEl.textContent = `${agents.length - activeCount} paused`;
    if (scopesEl)     scopesEl.textContent     = allScopes.size;

    // Nav badge
    const navCount = document.querySelector('[data-page="agents"] .count');
    if (navCount) navCount.textContent = agents.length;

    if (!agents.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty-state"><strong>No agents found</strong>Check AIC configuration in the backend.</td></tr>';
      return;
    }

    tbody.innerHTML = agents.map(agent => {
      const initials  = (agent.name || agent.id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || 'AG';
      const statusCls = agent.status === 'Active' ? 'allow' : 'warn';

      // Derive MCP access from PAZ Allowed Agents rules
      const mcpServers = Object.entries(pazSummary)
        .filter(([, info]) => info.agentSubjects?.includes(agent.id))
        .map(([name]) => name);
      const mcpHtml = mcpServers.length
        ? mcpServers.map(s => `<span class="scope">${s}</span>`).join('')
        : '<span class="secondary" style="font-size:11px">—</span>';

      return `<tr class="clickable-row" data-agent-id="${agent.id}">
        <td><div class="entity">
          <div class="entity-icon">${initials}</div>
          <div><div class="entity-name">${agent.name}</div><div class="entity-sub mono">${agent.id}</div></div>
        </div></td>
        <td>${mcpHtml}</td>
        <td><span class="status ${statusCls}"><i class="dot"></i>${agent.status}</span></td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-agent-id]').forEach(row => {
      row.addEventListener('click', () => {
        const agent = agents.find(a => a.id === row.dataset.agentId);
        if (agent) openAgentDetail(agent);
      });
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="3"><div class="error-banner">⚠ Failed to load agents: ${e.message}</div></td></tr>`;
  }
}

async function openAgentDetail(agent) {
  document.getElementById('agent-detail-title').textContent = agent.name;
  document.getElementById('agent-detail-subtitle').textContent = agent.id;
  showDetailView('agents');

  const mapEl = document.getElementById('agent-access-map');
  mapEl.innerHTML = '<div class="policy-loading"><span class="spinner"></span></div>';

  // Load PAZ summary + MCP list if not yet cached (may already be populated from MCP page)
  await Promise.allSettled([
    window._pazSummary
      ? Promise.resolve()
      : apiFetch('/paz/mcp-summary').then(d => { window._pazSummary = d; }).catch(() => {}),
    window._mcpData
      ? Promise.resolve()
      : apiFetch('/mcps').then(d => { window._mcpData = d; }).catch(() => {}),
  ]);

  renderAgentAccessMap(agent, mapEl);
}

// Groups mcp:<server>:<tool> scopes into { serverName: [{ tool, scope }] }
function groupScopesByMcp(scopes) {
  const map = {};
  for (const scope of scopes) {
    const parts = scope.split(':');
    if (parts[0] !== 'mcp' || parts.length < 3) continue;
    const server = parts[1];
    const tool   = parts.slice(2).join(':');
    if (!map[server]) map[server] = [];
    map[server].push({ tool, scope });
  }
  return map;
}

function renderAgentAccessMap(agent, mapEl) {
  const pazSummary = window._pazSummary || {};
  const mcpList    = window._mcpData    || [];

  // MCPs where this agent appears in the PAZ Allowed Agents rule
  const grantedMcps = Object.entries(pazSummary)
    .filter(([, info]) => info.agentSubjects?.includes(agent.id));

  if (!grantedMcps.length) {
    mapEl.innerHTML = '<div class="empty-state"><strong>No access found</strong>This agent does not appear in any MCP policy set\'s Allowed Agents rule.</div>';
    return;
  }

  mapEl.innerHTML = grantedMcps.map(([mcpName, pazInfo]) => {
    const mcpServer = mcpList.find(m => m.name.toLowerCase() === mcpName);

    const serverCell = mcpServer
      ? `<strong>${mcpServer.name}</strong><div class="entity-sub mono">${mcpServer.publicUrl || mcpServer.path || '—'}</div>`
      : `<strong>${mcpName}</strong><div class="entity-sub secondary">Not in Gateway config</div>`;

    const toolsHtml = (pazInfo.scopes || []).map(scope => {
      const tool = scope.split(':').slice(2).join(':') || scope;
      return `<div class="policy-info-row">
        <span class="entity-name" style="min-width:140px">${tool}</span>
        <span class="scope" style="font-size:10px">${scope}</span>
      </div>`;
    }).join('') || '<span class="secondary" style="font-size:11px">—</span>';

    const policyCell = `<span class="status allow"><i class="dot"></i>${pazInfo.policyCount} polic${pazInfo.policyCount !== 1 ? 'ies' : 'y'}</span>`;

    return `<div class="access-row">
      <div class="access-cell"><span class="field-label">MCP Server</span>${serverCell}</div>
      <div class="access-arrow">→</div>
      <div class="access-cell"><span class="field-label">Accessible Tools</span>${toolsHtml}</div>
      <div class="access-arrow">→</div>
      <div class="access-cell"><span class="field-label">PingAuthorize</span>${policyCell}</div>
    </div>`;
  }).join('');
}

// ── Show / hide list vs detail ────────────────────────────────────────────────
function showDetailView(type) {
  const list = document.getElementById(type === 'agents' ? 'agents-list-state' : 'mcps-list-state');
  const detail = document.querySelector(`[data-glean-id="${type === 'agents' ? 'agent-detail-view' : 'mcp-detail-view'}"]`);
  list.classList.add('detail-hidden');
  detail.classList.remove('detail-hidden');
}

function showListView(type) {
  const list = document.getElementById(type === 'agents' ? 'agents-list-state' : 'mcps-list-state');
  const detail = document.querySelector(`[data-glean-id="${type === 'agents' ? 'agent-detail-view' : 'mcp-detail-view'}"]`);
  if (!list || !detail) return;
  list.classList.remove('detail-hidden');
  detail.classList.add('detail-hidden');
}

document.querySelectorAll('[data-back-detail]').forEach(button => button.addEventListener('click', () => showListView(button.dataset.backDetail)));

// ── Boot ──────────────────────────────────────────────────────────────────────
loadDashboard();
