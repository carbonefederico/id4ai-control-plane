import https from 'https';
import fetch from 'node-fetch';

function cfg() {
  return {
    baseUrl:  process.env.PAZ_BASE_URL  || 'https://localhost:9443',
    branch:   process.env.PAZ_BRANCH    || '',
    username: process.env.PAZ_USERNAME  || '',
    password: process.env.PAZ_PASSWORD  || '',
    userId:   process.env.PAZ_USER_ID   || 'admin',
  };
}

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function pazHeaders(username, password, userId) {
  const h = { Accept: 'application/json', 'X-User-ID': userId };
  if (username) h['Authorization'] = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  return h;
}

async function pazGet(url) {
  const { username, password, userId } = cfg();
  console.log(`[paz] GET ${url} (X-User-ID: ${userId})`);
  const res = await fetch(url, { headers: pazHeaders(username, password, userId), agent: insecureAgent });
  const body = await res.text();
  console.log(`[paz] ${res.status} ${res.statusText}`);
  if (!res.ok) {
    console.error(`[paz] error body: ${body.slice(0, 500)}`);
    throw new Error(`PAZ ${res.status} — ${body.slice(0, 200)}`);
  }
  return JSON.parse(body);
}

// ── GET /api/paz/mcp-policysets ───────────────────────────────────────────────
export async function getMcpPolicySets(req, res) {
  try {
    const { baseUrl, branch } = cfg();
    const url = `${baseUrl}/api/v2/policy-manager/policysets${branch ? `?branch=${branch}` : ''}`;
    const { data: allSets = [] } = await pazGet(url);

    const mcpRoot = allSets.find(ps => ps.name === 'MCP' && ps.type === 'PolicySet');
    if (!mcpRoot) {
      console.warn('[paz] No policy set named "MCP" found');
      return res.json({ mcpRootFound: false, policysets: [] });
    }

    console.log(`[paz] MCP root id=${mcpRoot.id}, ${mcpRoot.children.length} children`);

    const childIds = new Set(mcpRoot.children.map(c => c.id));
    const children = allSets.filter(ps => childIds.has(ps.id) && ps.type === 'PolicySet');

    console.log(`[paz] children: ${children.map(c => c.name).join(', ')}`);

    res.json({
      mcpRootFound: true,
      mcpRootId: mcpRoot.id,
      policysets: children.map(ps => ({
        id:                 ps.id,
        name:               ps.name,
        disabled:           ps.disabled,
        combiningAlgorithm: ps.combiningAlgorithm?.algorithm ?? null,
        policyCount:        ps.children?.filter(c => c.type === 'Policy').length ?? 0,
      })),
    });
  } catch (e) {
    console.error(`[paz] getMcpPolicySets error: ${e.message}`);
    res.status(502).json({ error: e.message });
  }
}

// ── GET /api/paz/mcp-summary ──────────────────────────────────────────────────
// Returns a name-keyed map of { id, name, policyCount, scopes, audience }
// for all MCP child policy sets. Used to populate the MCP list table.
export async function getMcpPolicySummary(req, res) {
  try {
    const { baseUrl, branch } = cfg();
    const url = `${baseUrl}/api/v2/policy-manager/policysets${branch ? `?branch=${branch}` : ''}`;
    const { data: allSets = [] } = await pazGet(url);

    const mcpRoot = allSets.find(ps => ps.name === 'MCP' && ps.type === 'PolicySet');
    if (!mcpRoot) return res.json({});

    const childIds = new Set(mcpRoot.children.map(c => c.id));
    const children = allSets.filter(ps => childIds.has(ps.id) && ps.type === 'PolicySet');

    const summaries = await Promise.all(children.map(async ps => {
      try {
        const depsUrl = `${baseUrl}/api/v2/policy-manager/policysets/${ps.id}/dependencies${branch ? `?branch=${branch}` : ''}`;
        const { data: items = [] } = await pazGet(depsUrl);
        return buildSummary(ps.id, ps.name, items);
      } catch (e) {
        console.error(`[paz] summary error for ${ps.name}: ${e.message}`);
        return { id: ps.id, name: ps.name, policyCount: 0, scopes: [], audience: null };
      }
    }));

    const result = {};
    for (const s of summaries) result[s.name.toLowerCase()] = s;
    res.json(result);
  } catch (e) {
    console.error(`[paz] getMcpPolicySummary error: ${e.message}`);
    res.status(502).json({ error: e.message });
  }
}

// ── GET /api/paz/policysets/:id/dependencies ──────────────────────────────────
export async function getPolicySetDependencies(req, res) {
  const { id } = req.params;
  try {
    const { baseUrl, branch } = cfg();
    const url = `${baseUrl}/api/v2/policy-manager/policysets/${id}/dependencies${branch ? `?branch=${branch}` : ''}`;
    const { data: items = [] } = await pazGet(url);

    const byId     = Object.fromEntries(items.map(i => [i.id, i]));
    const attrById = Object.fromEntries(
      items.filter(i => i.type === 'ATTRIBUTE').map(i => [i.id, i])
    );

    const root = byId[id];
    if (!root) return res.json({ id, name: null, audience: null, agentSubject: null, policies: [] });

    // Audience: new MCPs store it on the PolicySet condition; old MCPs put it in "Validate Audience" rules
    let audience = extractPolicySetConditionValue(root.condition, 'audience', attrById);
    if (!audience) {
      const validateAudienceRule = items.find(i => i.type === 'Rule' && i.name === 'Validate Audience');
      audience = extractAllConditionValues(validateAudienceRule?.effectSettings?.condition)[0] ?? null;
    }

    const allPolicies = (root.children ?? [])
      .filter(c => c.type === 'Policy')
      .map(c => {
        const p = byId[c.id];
        if (!p) return null;

        const { method, toolName } = extractMethodInfo(p.condition, attrById);

        const rules = (p.children ?? [])
          .filter(r => r.type === 'Rule')
          .map(r => {
            const rule = byId[r.id];
            if (!rule) return null;
            const effectType = rule.effectSettings?.type ?? 'unknown';
            const category   = categorizeRule(rule, attrById);
            const values     = extractRuleValues(rule, attrById);
            const value      = values[0] ?? null;
            return {
              id:               rule.id,
              name:             rule.name,
              disabled:         rule.disabled,
              effect:           effectType,
              effectLabel:      formatEffect(effectType),
              category,
              value,
              values,
              conditionSummary: extractConditionSummary(rule.effectSettings?.condition, attrById),
            };
          })
          .filter(Boolean);

        const scopes = rules.filter(r => r.category === 'scope').map(r => r.value).filter(Boolean);
        const role   = rules.find(r => r.category === 'subject')?.value ?? null;

        return {
          id:                 p.id,
          name:               p.name,
          disabled:           p.disabled,
          combiningAlgorithm: p.combiningAlgorithm?.algorithm ?? null,
          method,
          toolName,
          scopes,
          role,
          rules,
        };
      })
      .filter(Boolean);

    // Agent subjects — read directly from raw PAZ data by rule name so attrById is not needed.
    // The "Allow Actor Subject" rule condition can be a direct comparison, and(single), or or(multiple).
    const commonItem     = (root.children ?? []).map(c => byId[c.id]).find(p => p?.name === 'common');
    const allowRuleItem  = commonItem
      ? (commonItem.children ?? []).map(c => byId[c.id]).find(r => r?.name === 'Allow Actor Subject')
      : null;
    const agentSubjects  = extractAllConditionValues(allowRuleItem?.effectSettings?.condition);

    // Exclude "common" from the tool policy cards
    const policies = allPolicies.filter(p => p.name !== 'common');

    console.log(`[paz] resolved ${policies.length} tool policies for ${id} (audience=${audience}, agents=${agentSubjects.join(',')})`);
    res.json({ id: root.id, name: root.name, audience, agentSubjects, policies });
  } catch (e) {
    console.error(`[paz] getPolicySetDependencies error: ${e.message}`);
    res.status(502).json({ error: e.message });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSummary(id, name, items) {
  const byId     = Object.fromEntries(items.map(i => [i.id, i]));
  const attrById = Object.fromEntries(
    items.filter(i => i.type === 'ATTRIBUTE').map(i => [i.id, i])
  );
  const root = byId[id];
  const policyChildren = (root?.children ?? []).filter(c => c.type === 'Policy');

  // Audience is on the policy set condition, not in any rule
  const audience = extractPolicySetConditionValue(root?.condition, 'audience', attrById);

  const scopes = new Set();
  for (const pc of policyChildren) {
    const p = byId[pc.id];
    if (!p || p.name === 'common') continue;
    for (const rc of (p.children ?? []).filter(c => c.type === 'Rule')) {
      const rule = byId[rc.id];
      if (!rule) continue;
      const cat = categorizeRule(rule, attrById);
      const val = extractRuleValue(rule, attrById);
      if (cat === 'scope' && val) scopes.add(val);
    }
  }

  // policyCount excludes the "common" policy
  const toolPolicyCount = policyChildren.filter(c => {
    const p = byId[c.id];
    return p && p.name !== 'common';
  }).length;

  // agentSubjects from common policy's Allow Actor Subject rule
  const commonItem    = (root?.children ?? []).map(c => byId[c.id]).find(p => p?.name === 'common');
  const allowRuleItem = commonItem
    ? (commonItem.children ?? []).map(c => byId[c.id]).find(r => r?.name === 'Allow Actor Subject')
    : null;
  const agentSubjects = extractAllConditionValues(allowRuleItem?.effectSettings?.condition);

  return { id, name, policyCount: toolPolicyCount, scopes: [...scopes], audience, agentSubjects };
}

// Extracts every constant value from a condition regardless of shape (direct, and, or).
// Used to read agent IDs from "Allow Actor Subject" without needing the attribute map.
function extractAllConditionValues(cond) {
  if (!cond) return [];
  return [
    ...(cond.comparison ? [cond] : []),
    ...(cond.and?.conditions ?? []),
    ...(cond.or?.conditions  ?? []),
  ].map(c => c.comparison?.right?.constant?.value).filter(v => v != null);
}

function ruleConditions(rule) {
  const cond = rule.effectSettings?.condition;
  if (!cond) return [];
  const list = [...(cond.and?.conditions ?? []), ...(cond.or?.conditions ?? [])];
  if (cond.comparison) list.unshift(cond);
  return list;
}

// Rule names are stable and don't require attrById to be populated.
const RULE_NAME_CATEGORY = {
  'Validate Audience':        'audience',
  'Validate Scope':           'scope',
  'Allow Actor Subject':      'agentSubject',
  'Allow Actor Subject Type': 'agentType',
  'Allow Subject':            'subject',
};

function categorizeRule(rule, attrById) {
  // Name-based first — works even when domain attributes are absent from the dependency response
  const byName = RULE_NAME_CATEGORY[rule.name];
  if (byName) return byName;

  // Attribute-based fallback for custom rule names
  for (const c of ruleConditions(rule)) {
    const comp = c.comparison;
    if (!comp) continue;
    const leftName = attrById[comp.left?.attribute?.id]?.name;
    if (!leftName) continue;
    if (leftName === 'audience')            return 'audience';
    if (leftName === 'scope')               return 'scope';
    if (leftName === 'Actor Subject Type')  return 'agentType';
    if (leftName === 'Actor Subject')       return 'agentSubject';
    if (['roles', 'sub', 'email', 'groups'].includes(leftName)) return 'subject';
  }
  return 'other';
}

function extractRuleValues(rule, attrById) {
  const values = [];
  for (const c of ruleConditions(rule)) {
    const comp = c.comparison;
    if (!comp) continue;
    if (comp.right?.constant?.value != null) {
      values.push(comp.right.constant.value);
    } else {
      const rightAttr = attrById[comp.right?.attribute?.id];
      if (rightAttr) {
        const cr = rightAttr.resolvers?.find(r => r.attributeResolverType === 'constant');
        if (cr?.value) values.push(cr.value);
      }
    }
  }
  return values;
}

function extractRuleValue(rule, attrById) {
  return extractRuleValues(rule, attrById)[0] ?? null;
}

// Extracts a constant value from a policy set's top-level condition by attribute name.
// Used to read audience from the "applies to" condition rather than from rules.
function extractPolicySetConditionValue(condition, attrName, attrById) {
  for (const c of condition?.and?.conditions ?? []) {
    const comp = c.comparison;
    if (!comp) continue;
    if (attrById[comp.left?.attribute?.id]?.name === attrName)
      return comp.right?.constant?.value ?? null;
  }
  if (condition?.comparison) {
    const comp = condition.comparison;
    if (attrById[comp.left?.attribute?.id]?.name === attrName)
      return comp.right?.constant?.value ?? null;
  }
  return null;
}

function extractMethodInfo(condition, attrById) {
  const result = { method: null, toolName: null };
  for (const c of condition?.and?.conditions ?? []) {
    const comp = c.comparison;
    if (!comp) continue;
    const attrName = attrById[comp.left?.attribute?.id]?.name;
    const val      = comp.right?.constant?.value;
    if (!attrName || !val) continue;
    if (attrName === 'MCP Method')    result.method   = val;
    if (attrName === 'MCP Tool Name') result.toolName = val;
  }
  return result;
}

function extractConditionSummary(condition, attrById) {
  if (!condition) return null;

  const comparisons = [];
  let joiner = ' AND ';

  if (condition.comparison) {
    comparisons.push(condition.comparison);
  }
  for (const c of condition?.and?.conditions ?? []) {
    if (c.comparison) comparisons.push(c.comparison);
  }
  if (condition?.or?.conditions?.length) {
    joiner = ' OR ';
    for (const c of condition.or.conditions) {
      if (c.comparison) comparisons.push(c.comparison);
    }
  }

  const parts = comparisons.map(comp => {
    const left  = attrById[comp.left?.attribute?.id]?.name ?? null;
    const right = comp.right?.constant?.value
               ?? attrById[comp.right?.attribute?.id]?.name
               ?? null;
    return left && right ? `${left} ${comp.op} ${right}` : null;
  }).filter(Boolean);

  return parts.join(joiner) || null;
}

function formatEffect(type) {
  switch (type) {
    case 'conditionalPermitElseDeny': return 'Conditional Permit';
    case 'unconditionalPermit':       return 'Permit';
    case 'unconditionalDeny':         return 'Deny';
    default:                          return type;
  }
}
