import fetch from 'node-fetch';

// Config is read lazily inside functions so env vars are always current
function cfg() {
  return {
    owner: process.env.GITHUB_OWNER || '',
    repo:  process.env.GITHUB_REPO  || '',
    path:  process.env.GITHUB_PATH  || 'config/routes',
    ref:   process.env.GITHUB_REF   || 'main',
    token: process.env.GITHUB_TOKEN || '',
  };
}

function githubHeaders(token) {
  const h = { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'agentic-dashboard/1.0' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

// Simple in-memory cache (TTL: 60 s)
let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 60_000;

async function fetchRouteFiles() {
  const { owner, repo, path, ref, token } = cfg();
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;

  console.log(`[mcps] GET ${url}`);
  const res = await fetch(url, { headers: githubHeaders(token) });
  const body = await res.text();

  console.log(`[mcps] GitHub response: ${res.status} ${res.statusText}`);
  if (!res.ok) {
    console.error(`[mcps] GitHub error body: ${body.slice(0, 500)}`);
    throw new Error(`GitHub API ${res.status} for ${url} — ${body.slice(0, 200)}`);
  }

  return JSON.parse(body);
}

async function fetchRouteJson(filename) {
  const { owner, repo, path, ref, token } = cfg();
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}/${filename}`;

  console.log(`[mcps] fetching route file: ${url}`);
  const res = await fetch(url, { headers: githubHeaders(token) });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${filename}: HTTP ${res.status} from ${url}`);
  }
  return res.json();
}

function parseRoute(routeJson, filename) {
  const filters = routeJson?.handler?.config?.filters ?? [];
  const filterNames = filters.map(f => (typeof f === 'string' ? f : f?.type ?? 'UnknownFilter'));
  const handlerName = routeJson?.handler?.config?.handler ?? 'ReverseProxyHandler';

  let path = null;
  const cond = routeJson?.condition ?? '';
  const pathMatch = cond.match(/\^([^'")]+)/);
  if (pathMatch) path = pathMatch[1];

  const gatewayPublicUrl = process.env.GATEWAY_PUBLIC_URL || '';

  return {
    id:         routeJson.name ?? filename.replace('.json', ''),
    name:       routeJson.name ?? filename.replace('.json', ''),
    filename,
    condition:  cond,
    path,
    publicUrl:  path ? `${gatewayPublicUrl}${path}` : null,
    baseURI:    routeJson.baseURI ?? routeJson?.properties?.mcpServerUrl ?? null,
    upstream:   routeJson?.properties?.mcpServerUrl ?? null,
    handler:    handlerName,
    capture:    routeJson?.handler?.capture ?? null,
    filters:    filterNames,
    rawFilters: filters,
    status:     'Healthy',
  };
}

async function fetchAndCacheMcps(force = false) {
  const now = Date.now();
  if (!force && _cache && now - _cacheTs < CACHE_TTL) return _cache;

  const { owner, repo, path, ref } = cfg();
  if (!owner || !repo) throw new Error('GITHUB_OWNER and GITHUB_REPO env vars are not set');

  console.log(`[mcps] loading routes — owner="${owner}" repo="${repo}" path="${path}" ref="${ref}"`);
  const files = await fetchRouteFiles();
  console.log(`[mcps] found ${files.length} entries in ${path}, filtering for .json files`);

  const jsonFiles = files.filter(f => f.name.endsWith('.json') && f.type === 'file');
  console.log(`[mcps] ${jsonFiles.length} .json route files: ${jsonFiles.map(f => f.name).join(', ')}`);

  const mcps = await Promise.all(
    jsonFiles.map(async f => {
      try {
        const json = await fetchRouteJson(f.name);
        const parsed = parseRoute(json, f.name);
        console.log(`[mcps] parsed "${parsed.name}" — filters: [${parsed.filters.join(', ')}]`);
        return parsed;
      } catch (e) {
        console.error(`[mcps] skipping ${f.name}: ${e.message}`);
        return null;
      }
    })
  );

  const result = mcps.filter(Boolean);
  console.log(`[mcps] done — ${result.length} MCP servers`);
  _cache = result;
  _cacheTs = now;
  return result;
}

export async function getMcps(req, res) {
  const { owner, repo } = cfg();
  if (!owner || !repo) {
    return res.status(502).json({ error: 'GITHUB_OWNER and GITHUB_REPO env vars are not set' });
  }
  try {
    res.json(await fetchAndCacheMcps(req.query.force === '1'));
  } catch (e) {
    console.error(`[mcps] fatal error: ${e.message}`);
    res.status(502).json({ error: e.message });
  }
}

export async function warmMcpCache() {
  try {
    await fetchAndCacheMcps(false);
  } catch (e) {
    console.error(`[mcps] startup cache warm failed: ${e.message}`);
  }
}

export function getCachedMcps() {
  return _cache ?? [];
}

// Cache is an optimization only: load the source when a function instance is cold.
export async function getMcpsData(force = false) {
  return fetchAndCacheMcps(force);
}

export async function getMcpById(req, res) {
  const { id } = req.params;
  try {
    const mcps = await getMcpsData();
    const mcp = mcps.find(m => m.id === id);
    if (!mcp) return res.status(404).json({ error: 'Not found' });
    res.json(mcp);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
