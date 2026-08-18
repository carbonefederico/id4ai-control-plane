# Backend — Dashboard API Server

Express API server (port `3001`) that serves the frontend SPA and exposes REST endpoints backed by live data from AIC, PingAuthorize, and GitHub.

Entry point: `server.js`

---

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Returns `{status:"ok"}` |
| `GET /api/mcps` | Lists MCP servers by reading route JSON files from GitHub (60 s in-memory cache). Parses filter chain, upstream URL, and public path. Accepts `?force=1` to bust the cache. |
| `GET /api/mcps/:id` | Returns a single MCP server by route name. |
| `GET /api/agents` | Lists AIC AI agents live via JWT-bearer auth. Returns normalized `{id, name, status, scopes, idmUid}`. Returns an empty array if `AIC_HOST` is unset. |
| `GET /api/summary` | Aggregates KPIs: live MCP count, live agent count, PAZ policy count. |
| `GET /api/paz/mcp-policysets` | Returns the MCP root policy set and its direct children from PAZ. |
| `GET /api/paz/mcp-summary` | Returns a name-keyed map of `{id, name, policyCount, scopes, audience, agentSubjects}` for all MCP child policy sets. Used by the dashboard. |
| `GET /api/paz/policysets/:id/dependencies` | Returns the full policy/rule tree for one PAZ policy set, with resolved attribute names, methods, tool names, scopes, roles, and audience. |
| `GET /api/policies` | Stub — returns 4 demo policies (not yet wired to PAZ). |
| `GET /api/logs` | Stub — returns 5 demo access log events (not yet wired to gateway logs). |

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP port (default: `3001`) |
| `AIC_HOST` | AIC tenant hostname |
| `AIC_SERVICE_ACCOUNT_ID` | Service account client ID |
| `AIC_JWK_PATH` | Path to RS256 JWK private key |
| `AIC_REALM` | AIC realm path |
| `AIC_SCOPES` | Scopes for service account token |
| `PAZ_BASE_URL` | PingAuthorize base URL |
| `PAZ_BRANCH` | PAZ policy branch UUID |
| `PAZ_USERNAME` / `PAZ_PASSWORD` | PAZ basic auth |
| `PAZ_USER_ID` | `X-User-ID` header for PAZ |
| `GITHUB_OWNER` / `GITHUB_REPO` | GitHub repository for route files |
| `GITHUB_PATH` | Path inside repo (default: `config/routes`) |
| `GITHUB_REF` | Git branch (default: `main`) |
| `GITHUB_TOKEN` | GitHub personal access token |
| `GATEWAY_PUBLIC_URL` | Base URL prepended to the MCP public path in API responses |

---

## Running

```bash
npm install
node server.js
```

The backend also serves the `../frontend` directory at `/`, so opening `http://localhost:3001` loads the dashboard.
