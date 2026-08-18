import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import express from 'express';
import https from 'node:https';
import fetch from 'node-fetch';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { importJWK, SignJWT } from 'jose';

// ── Attribute IDs ─────────────────────────────────────────────────────────────
// Discovered from GET /api/v2/policy-manager/policysets/:id/dependencies
// (items of type ATTRIBUTE in the response). Replace if your PAZ instance differs.
const ATTR = {
  SCOPE:              '447bf9bf-0cf0-4b62-9b55-58fc9f606f49', // scope
  AUDIENCE:           '906145d2-15d2-43b5-968a-375d13d907d2', // audience
  ROLES:              '4025b1cd-5d9e-4115-908e-285d8c00c233', // roles
  ACTOR_SUBJECT:      '4b03a172-49b8-470c-8ecc-3b0cf7eb0ede', // Actor Subject
  ACTOR_SUBJECT_TYPE: '853419ab-af25-4fd8-a684-f15c5c243967', // Actor Subject Type
  MCP_METHOD:         '87b1002a-9bdc-4ae8-afab-39e198e15276', // MCP Method
  MCP_TOOL_NAME:      '2ff01783-c350-4ca7-9d25-f7201033374f', // MCP Tool Name
};

// ── PAZ client ────────────────────────────────────────────────────────────────

function pazCfg() {
  return {
    baseUrl: process.env.PAZ_BASE_URL || 'https://localhost:9443',
    branch:  process.env.PAZ_BRANCH   || '',
    userId:  process.env.PAZ_USER_ID  || 'admin',
  };
}

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

async function pazRequest(method, path, body) {
  const { baseUrl, branch, userId } = pazCfg();
  const qs = branch ? `?branch=${branch}` : '';
  const url = `${baseUrl}${path}${qs}`;
  console.log(`[paz] ${method} ${url}`);

  const headers = {
    'Content-Type': 'application/json',
    Accept:         'application/json',
    'X-User-ID':    userId,
  };

  const res = await fetch(url, {
    method,
    agent: insecureAgent,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  console.log(`[paz] → ${res.status}`);
  if (!res.ok) {
    // 404 on DELETE is idempotent — the item is already gone
    if (method === 'DELETE' && res.status === 404) return null;
    throw new Error(`PAZ ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

// ── Policy shape builders ─────────────────────────────────────────────────────

function cmp(attrId, op, value) {
  return { comparison: { left: { attribute: { id: attrId } }, op, right: { constant: { value } } } };
}

function andCond(...comparisons) {
  return { and: { conditions: comparisons } };
}

// Rules shared across all tools in a policy set — created once in the "common" policy.
// Audience validation is handled by the policy set condition (applies-to), not here.
function buildCommonRules(agentId) {
  return [
    {
      name: 'Allow Actor Subject',
      effectSettings: {
        type: 'conditionalPermitElseDeny',
        condition: andCond(cmp(ATTR.ACTOR_SUBJECT, 'Equals', agentId)),
      },
    },
  ];
}

// Rules specific to a single tool/list policy
function buildToolRules(mcpName, toolName, userRole) {
  const scope = `mcp:${mcpName}:${toolName}`;
  return [
    {
      name: 'Validate Scope',
      effectSettings: {
        type: 'conditionalPermitElseDeny',
        condition: andCond(cmp(ATTR.SCOPE, 'Contains', scope)),
      },
    },
    {
      name: 'Allow Subject',
      effectSettings: {
        type: 'conditionalPermitElseDeny',
        condition: andCond(cmp(ATTR.ROLES, 'Equals', userRole)),
      },
    },
  ];
}

// "common" policy has no condition — applies to every request through the policy set
function buildCommonPolicy() {
  return {
    type: 'Policy',
    name: 'common',
    combiningAlgorithm: { algorithm: 'DenyOverrides' },
  };
}

function buildPolicy(toolName, method = 'tools/call') {
  // tools/list has no tool name — match on method only
  const conditions = method === 'tools/list'
    ? [cmp(ATTR.MCP_METHOD, 'Equals', 'tools/list')]
    : [cmp(ATTR.MCP_METHOD, 'Equals', method), cmp(ATTR.MCP_TOOL_NAME, 'Equals', toolName)];
  return {
    type: 'Policy',
    name: toolName,
    combiningAlgorithm: { algorithm: 'DenyOverrides' },
    condition: andCond(...conditions),
  };
}

// Generic helper: creates rules, creates policy, wires rules into policy.
async function createPolicyFromRules(policyShape, ruleDefs) {
  const ruleRefs = [];
  for (const def of ruleDefs) {
    const r = await pazRequest('POST', '/api/v2/policy-manager/rules', { type: 'Rule', ...def });
    console.log(`[paz] rule "${def.name}" id=${r.id}`);
    ruleRefs.push({ id: r.id, type: 'Rule' });
  }
  const pol = await pazRequest('POST', '/api/v2/policy-manager/policies', policyShape);
  console.log(`[paz] policy "${policyShape.name}" id=${pol.id}`);
  await pazRequest('PUT', `/api/v2/policy-manager/policies/${pol.id}`, { ...pol, children: ruleRefs });
  return pol;
}

// ── list_mcps implementation ──────────────────────────────────────────────────

async function listMcps() {
  const { data: allSets } = await pazRequest('GET', '/api/v2/policy-manager/policysets');
  const mcpRoot = allSets.find(ps => ps.name === 'MCP' && ps.type === 'PolicySet');
  if (!mcpRoot) throw new Error('MCP root policy set not found.');

  const childIds = new Set(mcpRoot.children.map(c => c.id));
  const children = allSets
    .filter(ps => childIds.has(ps.id))
    .map(ps => ({
      id:           ps.id,
      name:         ps.name,
      disabled:     ps.disabled,
      policyCount:  ps.children?.filter(c => c.type === 'Policy').length ?? 0,
    }));

  return { mcpRootId: mcpRoot.id, count: children.length, mcps: children };
}

// ── MCP tool discovery ────────────────────────────────────────────────────────

const MCP_PROTOCOL_VERSION = '2025-06-18';

async function discoverMcpTools(mcpUrl) {
  let sessionId = null;
  let requestId = 0;

  async function mcpPost(payload, expectResponse = true) {
    const headers = {
      'Content-Type':          'application/json',
      'Accept':                'application/json, text/event-stream',
      'MCP-Protocol-Version':  MCP_PROTOCOL_VERSION,
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const res = await fetch(mcpUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;

    if (!expectResponse) return null;

    const contentType = res.headers.get('content-type') || '';
    const body = await res.text();

    if (contentType.includes('text/event-stream')) {
      for (const line of body.split('\n')) {
        if (line.startsWith('data:')) {
          try { const obj = JSON.parse(line.slice(5).trim()); if (obj) return obj; } catch {}
        }
      }
      throw new Error('MCP endpoint returned SSE without a JSON-RPC data event');
    }

    return body.trim() ? JSON.parse(body) : null;
  }

  async function mcpRequest(method, params) {
    const id = ++requestId;
    const payload = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
    const response = await mcpPost(payload);
    if (!response) throw new Error(`No response for ${method}`);
    if (response.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(response.error)}`);
    return response.result ?? {};
  }

  const init = await mcpRequest('initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities:    {},
    clientInfo:      { name: 'paz-manager', version: '1.0.0' },
  });

  if (!init.capabilities?.tools) throw new Error('MCP server did not advertise the tools capability');

  await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);

  const tools = [];
  const seen  = new Set();
  let cursor  = undefined;

  while (true) {
    const result = await mcpRequest('tools/list', cursor !== undefined ? { cursor } : {});
    for (const tool of result.tools ?? []) {
      if (!tool.name) throw new Error('tools/list returned a tool without a name');
      if (seen.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
      seen.add(tool.name);
      tools.push({ name: tool.name, description: tool.description ?? '' });
    }
    cursor = result.nextCursor;
    if (!cursor) break;
  }

  return tools;
}

// ── add_mcp implementation ────────────────────────────────────────────────────

async function addMcp({ mcpName, audience, tools, mcpUrl, userRole, agentId }) {
  if (mcpUrl) {
    console.log(`[add_mcp] discovering tools from ${mcpUrl}`);
    tools = await discoverMcpTools(mcpUrl);
    console.log(`[add_mcp] discovered ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);
  }
  // 1. Find MCP root policy set
  const { data: allSets } = await pazRequest('GET', '/api/v2/policy-manager/policysets');
  const mcpRoot = allSets.find(ps => ps.name === 'MCP' && ps.type === 'PolicySet');
  if (!mcpRoot) {
    throw new Error('MCP root policy set not found. Create a policy set named "MCP" in PingAuthorize first.');
  }

  // Guard: prevent duplicate
  const childIds = new Set(mcpRoot.children.map(c => c.id));
  const existingChildren = allSets.filter(ps => childIds.has(ps.id));
  if (existingChildren.some(ps => ps.name.toLowerCase() === mcpName.toLowerCase())) {
    throw new Error(`Policy set "${mcpName}" already exists under the MCP root.`);
  }

  // 2. Create the new MCP policy set — audience check lives here as the "applies to" condition
  const mcpPs = await pazRequest('POST', '/api/v2/policy-manager/policysets', {
    type: 'PolicySet',
    name: mcpName,
    combiningAlgorithm: { algorithm: 'DenyOverrides' },
    condition: andCond(cmp(ATTR.AUDIENCE, 'Equals', audience)),
  });
  console.log(`[add_mcp] created policy set "${mcpName}" id=${mcpPs.id}`);

  const createdPolicies = [];

  // 3. Create the "common" policy (Allow Actor Subject) — first in the set
  console.log(`[add_mcp] creating common policy`);
  const commonPol = await createPolicyFromRules(buildCommonPolicy(), buildCommonRules(agentId));
  createdPolicies.push({ id: commonPol.id, name: 'common', method: null, scope: null });

  // 4. tools/list policy (Validate Scope + Allow Subject only)
  console.log(`[add_mcp] processing tools/list`);
  const listPol = await createPolicyFromRules(buildPolicy('list', 'tools/list'), buildToolRules(mcpName, 'list', userRole));
  createdPolicies.push({ id: listPol.id, name: 'list', method: 'tools/list', scope: `mcp:${mcpName}:list` });

  // 5. Per-tool policies (Validate Scope + Allow Subject only)
  for (const tool of tools) {
    console.log(`[add_mcp] processing tool "${tool.name}"`);
    const pol = await createPolicyFromRules(buildPolicy(tool.name, 'tools/call'), buildToolRules(mcpName, tool.name, userRole));
    createdPolicies.push({ id: pol.id, name: tool.name, method: 'tools/call', scope: `mcp:${mcpName}:${tool.name}` });
  }

  // 6. Wire all policies into the MCP policy set
  await pazRequest('PUT', `/api/v2/policy-manager/policysets/${mcpPs.id}`, {
    ...mcpPs,
    children: createdPolicies.map(p => ({ id: p.id, type: 'Policy' })),
  });
  console.log(`[add_mcp] wired ${createdPolicies.length} policies into "${mcpName}"`);

  // 5. Wire the new policy set as a child of the MCP root
  // Re-fetch root to get the latest version (optimistic locking)
  const freshRoot = await pazRequest('GET', `/api/v2/policy-manager/policysets/${mcpRoot.id}`);
  await pazRequest('PUT', `/api/v2/policy-manager/policysets/${mcpRoot.id}`, {
    ...freshRoot,
    children: [...freshRoot.children, { id: mcpPs.id, type: 'PolicySet' }],
  });
  console.log(`[add_mcp] registered "${mcpName}" under MCP root`);

  return {
    policySetId: mcpPs.id,
    mcpName,
    audience,
    policies: createdPolicies,
  };
}

// ── add_policy implementation ─────────────────────────────────────────────────

async function addPolicy({ mcpName, toolName, method, userRole }) {
  // 1. Find the target policy set under the MCP root
  const { data: allSets } = await pazRequest('GET', '/api/v2/policy-manager/policysets');
  const mcpRoot = allSets.find(ps => ps.name === 'MCP' && ps.type === 'PolicySet');
  if (!mcpRoot) throw new Error('MCP root policy set not found.');

  const childIds = new Set(mcpRoot.children.map(c => c.id));
  const mcpPs = allSets.find(ps => childIds.has(ps.id) && ps.name.toLowerCase() === mcpName.toLowerCase());
  if (!mcpPs) throw new Error(`Policy set "${mcpName}" not found under the MCP root.`);

  // 2. Create the policy — tool rules only (audience/actor subject live in the common policy)
  const pol = await createPolicyFromRules(buildPolicy(toolName, method), buildToolRules(mcpName, toolName, userRole));

  // 3. Add the policy to the existing policy set
  const freshPs = await pazRequest('GET', `/api/v2/policy-manager/policysets/${mcpPs.id}`);
  await pazRequest('PUT', `/api/v2/policy-manager/policysets/${mcpPs.id}`, {
    ...freshPs,
    children: [...freshPs.children, { id: pol.id, type: 'Policy' }],
  });
  console.log(`[add_policy] added policy "${toolName}" to "${mcpName}"`);

  return {
    policySetId: mcpPs.id,
    mcpName,
    policy: { id: pol.id, name: toolName, method, scope: `mcp:${mcpName}:${toolName}` },
  };
}

// ── authorize_agent implementation ───────────────────────────────────────────

async function authorizeAgent({ mcpName, agentId }) {
  // 1. Find the MCP policy set
  const { data: allSets } = await pazRequest('GET', '/api/v2/policy-manager/policysets');
  const mcpRoot = allSets.find(ps => ps.name === 'MCP' && ps.type === 'PolicySet');
  if (!mcpRoot) throw new Error('MCP root policy set not found.');

  const childIds = new Set(mcpRoot.children.map(c => c.id));
  const mcpPs = allSets.find(ps => childIds.has(ps.id) && ps.name.toLowerCase() === mcpName.toLowerCase());
  if (!mcpPs) throw new Error(`Policy set "${mcpName}" not found under the MCP root.`);

  // 2. Get dependencies to resolve the common policy and its rules
  const { data: items } = await pazRequest('GET', `/api/v2/policy-manager/policysets/${mcpPs.id}/dependencies`);
  const byId = Object.fromEntries(items.map(i => [i.id, i]));

  // Re-fetch the policy set to get ordered children with latest version
  const freshPs = await pazRequest('GET', `/api/v2/policy-manager/policysets/${mcpPs.id}`);
  const commonRef = freshPs.children.find(c => byId[c.id]?.type === 'Policy' && byId[c.id]?.name === 'common');
  if (!commonRef) throw new Error(`No "common" policy found in "${mcpName}".`);

  const commonPolicy = byId[commonRef.id];

  // 3. Find the "Allow Actor Subject" rule
  const ruleRef = commonPolicy.children?.find(c => byId[c.id]?.type === 'Rule' && byId[c.id]?.name === 'Allow Actor Subject');
  if (!ruleRef) throw new Error(`No "Allow Actor Subject" rule found in the "common" policy of "${mcpName}".`);

  const rule = byId[ruleRef.id];
  const cond = rule.effectSettings?.condition;

  // 4. Collect every existing agent value from the condition (handles single, and, or)
  const existingComps = [
    ...(cond?.comparison ? [cond] : []),
    ...(cond?.and?.conditions ?? []),
    ...(cond?.or?.conditions  ?? []),
  ].map(c => c.comparison).filter(Boolean);

  const currentAgents = existingComps.map(c => c.right?.constant?.value).filter(Boolean);

  if (currentAgents.includes(agentId)) {
    return { mcpName, agentId, alreadyAuthorized: true, agents: currentAgents };
  }

  // 5. Rebuild condition as OR over all agents (existing + new)
  const allAgents = [...currentAgents, agentId];
  const newCondition = { or: { conditions: allAgents.map(a => cmp(ATTR.ACTOR_SUBJECT, 'Equals', a)) } };

  // Re-fetch the rule to get the latest version before PUT
  const freshRule = await pazRequest('GET', `/api/v2/policy-manager/rules/${rule.id}`);
  await pazRequest('PUT', `/api/v2/policy-manager/rules/${rule.id}`, {
    ...freshRule,
    effectSettings: { ...freshRule.effectSettings, condition: newCondition },
  });
  console.log(`[authorize_agent] "${mcpName}" Allow Actor Subject updated — agents: ${allAgents.join(', ')}`);

  return { mcpName, agentId, ruleId: rule.id, agents: allAgents };
}

// ── remove_mcp implementation ─────────────────────────────────────────────────

async function removeMcp({ mcpName }) {
  // 1. Find MCP root and the target policy set
  const { data: allSets } = await pazRequest('GET', '/api/v2/policy-manager/policysets');
  const mcpRoot = allSets.find(ps => ps.name === 'MCP' && ps.type === 'PolicySet');
  if (!mcpRoot) throw new Error('MCP root policy set not found.');

  const childIds = new Set(mcpRoot.children.map(c => c.id));
  const target = allSets.find(ps => childIds.has(ps.id) && ps.name.toLowerCase() === mcpName.toLowerCase());
  if (!target) throw new Error(`Policy set "${mcpName}" not found under the MCP root.`);

  // 2. Fetch the full dependency tree to discover all policies and rules
  const { data: items } = await pazRequest('GET', `/api/v2/policy-manager/policysets/${target.id}/dependencies`);
  const byId     = Object.fromEntries(items.map(i => [i.id, i]));
  const rules    = items.filter(i => i.type === 'Rule');
  const policies = items.filter(i => i.type === 'Policy');

  // 3. Clear rule references from each policy (PAZ ref-integrity: parent must not reference child before delete)
  for (const pol of policies) {
    const full = byId[pol.id];
    if (full?.children?.length) {
      await pazRequest('PUT', `/api/v2/policy-manager/policies/${pol.id}`, { ...full, children: [] });
      console.log(`[remove_mcp] cleared rules from policy "${pol.name}"`);
    }
  }

  // 4. Delete rules
  for (const rule of rules) {
    await pazRequest('DELETE', `/api/v2/policy-manager/rules/${rule.id}`);
    console.log(`[remove_mcp] deleted rule "${rule.name}" id=${rule.id}`);
  }

  // 5. Clear policy references from the policy set
  const freshTarget = await pazRequest('GET', `/api/v2/policy-manager/policysets/${target.id}`);
  if (freshTarget.children?.length) {
    await pazRequest('PUT', `/api/v2/policy-manager/policysets/${target.id}`, { ...freshTarget, children: [] });
    console.log(`[remove_mcp] cleared policies from policy set "${target.name}"`);
  }

  // 6. Delete policies
  for (const pol of policies) {
    await pazRequest('DELETE', `/api/v2/policy-manager/policies/${pol.id}`);
    console.log(`[remove_mcp] deleted policy "${pol.name}" id=${pol.id}`);
  }

  // 7. Remove from MCP root children (re-fetch to get latest version)
  const freshRoot = await pazRequest('GET', `/api/v2/policy-manager/policysets/${mcpRoot.id}`);
  await pazRequest('PUT', `/api/v2/policy-manager/policysets/${mcpRoot.id}`, {
    ...freshRoot,
    children: freshRoot.children.filter(c => c.id !== target.id),
  });

  // 8. Delete the policy set itself
  await pazRequest('DELETE', `/api/v2/policy-manager/policysets/${target.id}`);
  console.log(`[remove_mcp] deleted policy set "${target.name}" id=${target.id}`);

  return {
    removed: {
      policySetId:      target.id,
      mcpName:          target.name,
      policiesDeleted:  policies.length,
      rulesDeleted:     rules.length,
    },
  };
}

// ── get_mcp_scopes implementation ─────────────────────────────────────────────

async function getMcpScopes({ mcpName }) {
  // 1. Find the MCP policy set by name
  const { data: allSets } = await pazRequest('GET', '/api/v2/policy-manager/policysets');
  const mcpRoot = allSets.find(ps => ps.name === 'MCP' && ps.type === 'PolicySet');
  if (!mcpRoot) throw new Error('MCP root policy set not found.');

  const childIds = new Set(mcpRoot.children.map(c => c.id));
  const mcpPs = allSets.find(ps => childIds.has(ps.id) && ps.name.toLowerCase() === mcpName.toLowerCase());
  if (!mcpPs) throw new Error(`Policy set "${mcpName}" not found under the MCP root.`);

  // 2. Pull the full dependency tree — policies and rules with their content
  const { data: items } = await pazRequest('GET', `/api/v2/policy-manager/policysets/${mcpPs.id}/dependencies`);

  // 3. Collect scope values from every "Validate Scope" rule
  const scopes = [];
  for (const item of items) {
    if (item.type !== 'Rule' || item.name !== 'Validate Scope') continue;
    const cond = item.effectSettings?.condition;
    if (!cond) continue;

    // Direct comparison (edge case)
    if (cond.comparison?.left?.attribute?.id === ATTR.SCOPE) {
      const val = cond.comparison.right?.constant?.value;
      if (val && !scopes.includes(val)) scopes.push(val);
      continue;
    }

    // Standard structure: { and: { conditions: [{ comparison: ... }] } }
    for (const sub of cond.and?.conditions ?? []) {
      if (sub.comparison?.left?.attribute?.id === ATTR.SCOPE) {
        const val = sub.comparison.right?.constant?.value;
        if (val && !scopes.includes(val)) scopes.push(val);
      }
    }
  }

  scopes.sort();
  return { mcpName, policySetId: mcpPs.id, scopes, count: scopes.length };
}

// ── MCP server factory (new instance per request for stateless operation) ─────

function createServer() {
  const server = new McpServer({ name: 'paz-manager', version: '1.0.0' });

  server.tool(
    'list_mcps',
    'List all MCP policy sets registered under the MCP root in PingAuthorize.',
    {},
    async () => {
      try {
        const result = await listMcps();
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error('[list_mcps] error:', err.message);
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    'add_mcp',
    'Create a PingAuthorize policy set for an MCP server. ' +
    'Generates one policy per tool with five standard rules: ' +
    'Validate Audience, Validate Scope, Allow Actor Subject, Allow Actor Subject Type, Allow Subject. ' +
    'Provide mcpUrl to discover tools automatically, or pass tools explicitly.',
    {
      mcpName: z.string()
        .describe('MCP server name — becomes the policy set name and the middle segment of every scope (mcp:<mcpName>:<tool>)'),
      audience: z.string()
        .describe('Expected token audience for all policies, e.g. "mcp:customer"'),
      mcpUrl: z.string().url().optional()
        .describe('MCP server URL — when provided, tools are discovered automatically and the tools array is ignored'),
      tools: z.array(z.object({
        name:        z.string().describe('Tool name, e.g. "echo"'),
        description: z.string().optional(),
      })).optional()
        .describe('Tools to generate policies for — required when mcpUrl is not provided'),
      userRole: z.string()
        .describe('Role claim value that identifies allowed human callers, e.g. "helpdesk"'),
      agentId: z.string()
        .describe('Actor Subject value that identifies allowed AI agent callers, e.g. "testAgent"'),
    },
    async ({ mcpName, audience, tools, mcpUrl, userRole, agentId }) => {
      if (!mcpUrl && (!tools || tools.length === 0)) {
        return { isError: true, content: [{ type: 'text', text: 'Error: either mcpUrl or tools must be provided' }] };
      }
      try {
        const result = await addMcp({ mcpName, audience, tools, mcpUrl, userRole, agentId });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        console.error('[add_mcp] error:', err.message);
        return {
          isError: true,
          content: [{ type: 'text', text: `Error: ${err.message}` }],
        };
      }
    },
  );

  server.tool(
    'add_policy',
    'Add a single tool policy to an existing MCP policy set. ' +
    'Audience and actor-subject validation live in the shared "common" policy — ' +
    'this creates only Validate Scope and Allow Subject rules. ' +
    'Use method "tools/list" to protect the tool-listing endpoint, ' +
    'or "tools/call" (default) for a specific tool.',
    {
      mcpName:  z.string().describe('Name of the existing MCP policy set'),
      toolName: z.string().describe('Policy name and scope suffix, e.g. "list" for tools/list or "echo" for a specific tool'),
      method:   z.enum(['tools/call', 'tools/list']).default('tools/call').describe('MCP method this policy protects'),
      userRole: z.string().describe('Role claim value for allowed human callers'),
    },
    async ({ mcpName, toolName, method, userRole }) => {
      try {
        const result = await addPolicy({ mcpName, toolName, method, userRole });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error('[add_policy] error:', err.message);
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    'authorize_agent',
    'Grant an agent access to an MCP server by adding it to the "Allow Actor Subject" rule ' +
    'in the shared "common" policy. Converts a single-agent condition to an OR condition ' +
    'automatically when more than one agent is authorized. Idempotent — safe to call if the agent is already allowed.',
    {
      mcpName: z.string().describe('Name of the MCP policy set, e.g. "cards"'),
      agentId: z.string().describe('Actor Subject value identifying the agent, e.g. "financial_advisor_agent"'),
    },
    async ({ mcpName, agentId }) => {
      try {
        const result = await authorizeAgent({ mcpName, agentId });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error('[authorize_agent] error:', err.message);
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    'remove_mcp',
    'Remove an MCP server policy set from PingAuthorize, deleting all its policies and rules.',
    {
      mcpName: z.string().describe('Name of the MCP policy set to remove (must be a direct child of the MCP root)'),
    },
    async ({ mcpName }) => {
      try {
        const result = await removeMcp({ mcpName });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        console.error('[remove_mcp] error:', err.message);
        return {
          isError: true,
          content: [{ type: 'text', text: `Error: ${err.message}` }],
        };
      }
    },
  );

  server.tool(
    'get_mcp_scopes',
    'Return the list of OAuth2 scopes associated with an MCP server, derived from its Validate Scope rules in PingAuthorize. ' +
    'Scopes follow the pattern mcp:<mcpName>:<toolName>.',
    {
      mcpName: z.string().describe('Name of the MCP policy set, e.g. "customer"'),
    },
    async ({ mcpName }) => {
      try {
        const result = await getMcpScopes({ mcpName });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error('[get_mcp_scopes] error:', err.message);
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    },
  );

  return server;
}

// ══════════════════════════════════════════════════════════════════════════════
// AIC Agent Manager MCP
// ══════════════════════════════════════════════════════════════════════════════

function aicCfg() {
  return {
    host:             process.env.AIC_HOST               || '',
    serviceAccountId: process.env.AIC_SERVICE_ACCOUNT_ID || '',
    jwkPath:          process.env.AIC_JWK_PATH           || './aic-privateKey.jwk',
    scopes:           process.env.AIC_SCOPES             || 'fr:am:* fr:idm:*',
    realm:            process.env.AIC_REALM              || '/realms/root/realms/alpha',
  };
}

let _aicTokenCache  = null;
let _aicTokenExpiry = 0;

async function getAicToken() {
  if (_aicTokenCache && Date.now() < _aicTokenExpiry) return _aicTokenCache;

  const { host, serviceAccountId, jwkPath, scopes } = aicCfg();
  const tokenEndpoint = `https://${host}/am/oauth2/access_token`;

  const jwk        = JSON.parse(readFileSync(jwkPath, 'utf8'));
  const privateKey = await importJWK(jwk, 'RS256');
  const now        = Math.floor(Date.now() / 1000);

  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(serviceAccountId)
    .setSubject(serviceAccountId)
    .setAudience(tokenEndpoint)
    .setJti(randomUUID())
    .setExpirationTime(now + 180)
    .sign(privateKey);

  const res = await fetch(tokenEndpoint, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:  'service-account',
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
      scope: scopes,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`AIC token request failed — HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const { access_token, expires_in } = await res.json();
  _aicTokenCache  = access_token;
  _aicTokenExpiry = Date.now() + (expires_in - 30) * 1000;
  return access_token;
}

async function aicRequest(method, path, body, extraHeaders = {}) {
  const { host, realm } = aicCfg();
  const url = `https://${host}/am/json${realm}${path}`;
  console.log(`[aic] ${method} ${url}`);

  const token = await getAicToken();
  const headers = {
    'Accept-API-Version': 'resource=2.0',
    'Content-Type':       'application/json',
    'Authorization':      `Bearer ${token}`,
    ...extraHeaders,
  };

  const res = await fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  console.log(`[aic] → ${res.status}`);
  if (!res.ok) {
    if (method === 'DELETE' && res.status === 404) return null;
    throw new Error(`AIC ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

function normalizeAgent(a) {
  return {
    id:     a._id,
    status: a.coreOAuth2ClientConfig?.status?.value     || 'Active',
    scopes: a.coreOAuth2ClientConfig?.scopes?.value     || [],
    idmUid: a.aiAgentIdentityUid?.value || a.aiAgentIdentityUid || null,
  };
}

// ── AIC agent operations ──────────────────────────────────────────────────────

async function aicGetAgent(agentId) {
  const raw = await aicRequest('GET', `/realm-config/agents/AIAgent/${encodeURIComponent(agentId)}`);
  return normalizeAgent(raw);
}

async function aicCreateAgent({ agentId, agentMode = 'obo', agentScopes = [] }) {
  const clientSecret = randomUUID();

  // OBO agents only need token-exchange; autonomous agents also need client_credentials.
  const grantTypes = agentMode === 'autonomous'
    ? ['client_credentials', 'urn:ietf:params:oauth:grant-type:token-exchange']
    : ['urn:ietf:params:oauth:grant-type:token-exchange'];

  const body = {
    aiAgentIdentityAttributes: {
      inherited: false,
      value: { name: agentId, oauth2ClientId: agentId },
    },
    coreOAuth2ClientConfig: {
      status:     { inherited: false, value: 'Active' },
      clientType: { inherited: false, value: 'Confidential' },
      scopes:     { inherited: false, value: agentScopes },
    },
    advancedOAuth2ClientConfig: {
      grantTypes:              { inherited: false, value: grantTypes },
      tokenEndpointAuthMethod: { inherited: false, value: 'client_secret_post' },
    },
    userpassword: clientSecret,
  };

  const raw = await aicRequest('PUT', `/realm-config/agents/AIAgent/${encodeURIComponent(agentId)}`, body, { 'If-None-Match': '*' });
  return { ...normalizeAgent(raw), clientSecret };
}

async function aicListAgents() {
  const data = await aicRequest('GET', '/realm-config/agents/AIAgent?_queryFilter=true');
  const result = data?.result ?? [];
  return result.map(normalizeAgent);
}

async function aicDeleteAgent(agentId) {
  await aicRequest('DELETE', `/realm-config/agents/AIAgent/${encodeURIComponent(agentId)}`);
  return { agentId, deleted: true };
}

async function aicUpdateAgentScopes({ agentId, scopes }) {
  const raw = await aicRequest('GET', `/realm-config/agents/AIAgent/${encodeURIComponent(agentId)}`);
  const { _rev, ...body } = raw;
  body.coreOAuth2ClientConfig = {
    ...raw.coreOAuth2ClientConfig,
    scopes: { inherited: false, value: scopes },
  };
  const updated = await aicRequest('PUT', `/realm-config/agents/AIAgent/${encodeURIComponent(agentId)}`, body);
  return normalizeAgent(updated);
}

// ── AIC MCP server factory ────────────────────────────────────────────────────

function createAicServer() {
  const server = new McpServer({ name: 'aic-agent-manager', version: '1.0.0' });

  server.tool(
    'create_agent',
    'Create an OBO AI agent in AIC. Returns the agent details and its client secret — the secret is only returned once.',
    {
      agentId:      z.string().describe('Unique identifier for the agent, e.g. "financial_advisor_agent"'),
      agentMode:    z.enum(['obo', 'autonomous']).default('obo').describe('Agent grant type mode. "obo" = token-exchange only; "autonomous" = client_credentials + token-exchange'),
      agentScopes:  z.array(z.string()).default([]).describe('OAuth2 scopes to grant, e.g. ["mcp:cards:get_card", "mcp:cards:list_cards"]'),
    },
    async ({ agentId, agentMode, agentScopes }) => {
      try {
        const result = await aicCreateAgent({ agentId, agentMode, agentScopes });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error('[create_agent] error:', err.message);
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    'list_agents',
    'List all AIC AI agents. Returns id, status, scopes, and idmUid for each agent.',
    {},
    async () => {
      try {
        const result = await aicListAgents();
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error('[list_agents] error:', err.message);
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    'get_agent',
    'Get details of an existing AIC AI agent by ID.',
    {
      agentId: z.string().describe('Agent identifier to look up'),
    },
    async ({ agentId }) => {
      try {
        const result = await aicGetAgent(agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error('[get_agent] error:', err.message);
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    'delete_agent',
    'Delete an AIC AI agent by ID. Idempotent — safe to call if the agent does not exist.',
    {
      agentId: z.string().describe('Agent identifier to delete'),
    },
    async ({ agentId }) => {
      try {
        const result = await aicDeleteAgent(agentId);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error('[delete_agent] error:', err.message);
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    'update_agent_scopes',
    'Replace the OAuth2 scopes on an existing AIC AI agent. Fetches the current agent state first, then PUTs the updated version.',
    {
      agentId: z.string().describe('Agent identifier to update'),
      scopes:  z.array(z.string()).describe('New complete scope list — replaces the existing scopes entirely'),
    },
    async ({ agentId, scopes }) => {
      try {
        const result = await aicUpdateAgentScopes({ agentId, scopes });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error('[update_agent_scopes] error:', err.message);
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    },
  );

  return server;
}

// ── PingGateway route manager ─────────────────────────────────────────────────

const ROUTE_TEMPLATE = `{
  "name": "{{mcp_server_name}}",
  "condition": "\${find(request.uri.path, '^{{public_path}}')}",
  "properties": {
    "mcpServerUrl": "{{mcp_server_origin}}"
  },
  "baseURI": "&{mcpServerUrl}",
  "handler": {
    "type": "Chain",
    "capture": "all",
    "config": {
      "filters": [
        "McpAuditFilter",
        "McpValidationFilter",
        "MCPPingAuthorizeFilter",
        {
          "type": "UriPathRewriteFilter",
          "config": {
            "mappings": {
              "{{public_path}}": "{{upstream_path}}"
            }
          }
        },
        {
          "type": "HeaderFilter",
          "config": {
            "messageType": "REQUEST",
            "replace": {
              "host": [
                "{{backend_host}}"
              ]
            }
          }
        }
      ],
      "handler": "ReverseProxyHandler"
    }
  }
}`;

function gwCfg() {
  return {
    owner: process.env.GITHUB_OWNER || '',
    repo:  process.env.GITHUB_REPO  || '',
    path:  process.env.GITHUB_PATH  || 'config/routes',
    ref:   process.env.GITHUB_REF   || 'main',
    token: process.env.GITHUB_TOKEN || '',
  };
}

function normalizeServerName(name) {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

async function githubContents(method, filename, body) {
  const { owner, repo, path, token } = gwCfg();
  if (!owner || !repo) throw new Error('GITHUB_OWNER and GITHUB_REPO env vars are not set');

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}/${filename}`;
  const headers = {
    'Accept':     'application/vnd.github.v3+json',
    'User-Agent': 'ping-gateway-manager/1.0',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...(body   ? { 'Content-Type': 'application/json' } : {}),
  };

  const res = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  // 404 on GET means file does not exist — not an error
  if (method === 'GET' && res.status === 404) return null;

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${method} ${filename} → ${res.status}: ${text.slice(0, 300)}`);
  }

  // DELETE returns 200 with a body; everything else does too
  return res.json();
}

async function listMcpRoutes() {
  const { owner, repo, path, ref, token } = gwCfg();
  if (!owner || !repo) throw new Error('GITHUB_OWNER and GITHUB_REPO env vars are not set');

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
  const res = await fetch(url, {
    headers: {
      'Accept':     'application/vnd.github.v3+json',
      'User-Agent': 'ping-gateway-manager/1.0',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API GET ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }

  const files = await res.json();
  return files
    .filter(f => f.type === 'file' && f.name.endsWith('.json'))
    .map(f => ({ routeName: f.name.replace('.json', ''), sha: f.sha }));
}

async function getMcpRoute({ serverName }) {
  const normalized = normalizeServerName(serverName);
  const existing   = await githubContents('GET', `${normalized}.json`);
  if (!existing) return null;
  const content = JSON.parse(Buffer.from(existing.content, 'base64').toString('utf8'));
  return { routeName: normalized, sha: existing.sha, content };
}

async function addMcpRoute({ serverName, mcpUrl, publicPath }) {
  const { ref } = gwCfg();
  const normalized  = normalizeServerName(serverName);
  const parsed      = new URL(mcpUrl);
  const origin      = parsed.origin;
  const upstreamPath = parsed.pathname;
  const backendHost = parsed.hostname;

  const route = ROUTE_TEMPLATE
    .replaceAll('{{mcp_server_name}}',    normalized)
    .replaceAll('{{public_path}}',        publicPath)
    .replaceAll('{{mcp_server_origin}}',  origin)
    .replaceAll('{{upstream_path}}',      upstreamPath)
    .replaceAll('{{backend_host}}',       backendHost);

  const filename = `${normalized}.json`;
  const existing = await githubContents('GET', filename);
  const verb     = existing ? 'update' : 'add';

  const result = await githubContents('PUT', filename, {
    message: `feat(gateway): ${verb} MCP route ${normalized}`,
    content: Buffer.from(route).toString('base64'),
    branch:  ref,
    ...(existing ? { sha: existing.sha } : {}),
  });

  return {
    routeName: normalized,
    sha:       result.content.sha,
    url:       result.content.html_url,
    committed: true,
  };
}

async function deleteMcpRoute({ serverName }) {
  const { ref } = gwCfg();
  const normalized = normalizeServerName(serverName);
  const filename   = `${normalized}.json`;

  const existing = await githubContents('GET', filename);
  if (!existing) return { routeName: normalized, deleted: false, reason: 'not found' };

  await githubContents('DELETE', filename, {
    message: `feat(gateway): remove MCP route ${normalized}`,
    sha:     existing.sha,
    branch:  ref,
  });

  return { routeName: normalized, deleted: true };
}

function createGatewayServer() {
  const server = new McpServer({ name: 'ping-gateway-manager', version: '1.0.0' });

  server.tool(
    'list_mcp_routes',
    'List all MCP route JSON files currently published in the GitHub routes repository.',
    {},
    async () => {
      try {
        const result = await listMcpRoutes();
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error('[list_mcp_routes] error:', err.message);
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    'get_mcp_route',
    'Get the full route JSON content for a single PingGateway MCP route by server name.',
    {
      serverName: z.string().describe('Server name to retrieve, e.g. "customer"'),
    },
    async ({ serverName }) => {
      try {
        const result = await getMcpRoute({ serverName });
        if (!result) return { isError: true, content: [{ type: 'text', text: `Route "${serverName}" not found` }] };
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error('[get_mcp_route] error:', err.message);
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    'add_mcp_route',
    'Generate a PingGateway MCP route JSON from the standard template and publish it to GitHub via the Contents API.',
    {
      serverName: z.string().describe('Human name for the MCP server, e.g. "customer" — normalized to lowercase + underscores'),
      mcpUrl:     z.string().url().describe('Full upstream MCP URL, e.g. "https://internal.corp/mcp/customer"'),
      publicPath: z.string().describe('Public path exposed by the gateway, e.g. "/mcp/customer"'),
    },
    async ({ serverName, mcpUrl, publicPath }) => {
      try {
        const result = await addMcpRoute({ serverName, mcpUrl, publicPath });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error('[add_mcp_route] error:', err.message);
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    'delete_mcp_route',
    'Delete a PingGateway MCP route JSON from GitHub. Idempotent — safe to call if the route does not exist.',
    {
      serverName: z.string().describe('Server name to delete, e.g. "customer"'),
    },
    async ({ serverName }) => {
      try {
        const result = await deleteMcpRoute({ serverName });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        console.error('[delete_mcp_route] error:', err.message);
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    },
  );

  return server;
}

// ── HTTP transport ────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Handle both POST (JSON-RPC) and GET (SSE for server notifications)
app.all('/ping-authorize/mcp', async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('finish', () => server.close().catch(() => {}));
  } catch (err) {
    console.error('[mcp] transport error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.all('/aic-agent-manager/mcp', async (req, res) => {
  const server = createAicServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('finish', () => server.close().catch(() => {}));
  } catch (err) {
    console.error('[aic-mcp] transport error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.all('/ping-gateway-manager/mcp', async (req, res) => {
  const server = createGatewayServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('finish', () => server.close().catch(() => {}));
  } catch (err) {
    console.error('[gw-mcp] transport error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

const PORT = Number(process.env.MCP_PORT) || 3034;
app.listen(PORT, () => {
  console.log(`PAZ Manager MCP         →  http://localhost:${PORT}/ping-authorize/mcp`);
  console.log(`AIC Agent Manager MCP   →  http://localhost:${PORT}/aic-agent-manager/mcp`);
  console.log(`PingGateway Manager MCP →  http://localhost:${PORT}/ping-gateway-manager/mcp`);
  console.log(`PAZ base URL            →  ${process.env.PAZ_BASE_URL    || 'https://localhost:9443'}`);
  console.log(`AIC host                →  ${process.env.AIC_HOST        || '(AIC_HOST not set)'}`);
  console.log(`GitHub repo             →  ${process.env.GITHUB_OWNER    || '?'}/${process.env.GITHUB_REPO || '?'} @ ${process.env.GITHUB_PATH || 'config/routes'}`);
});
