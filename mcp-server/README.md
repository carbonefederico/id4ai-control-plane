# MCP Server

A single Node.js process (port `3034`) that hosts three independent MCP servers on separate HTTP paths. Each server exposes tools that Claude Code uses to automate one component of the identity infrastructure.

Entry point: `server.js`  
Transport: `StreamableHTTPServerTransport` (stateless per request)

---

## paz-manager → `/ping-authorize/mcp`

Manages PingAuthorize authorization policies for MCP servers. Every onboarded MCP server gets its own policy set under the `MCP` root, with one policy per tool plus a shared `common` policy that controls agent-level access.

### Tools

| Tool | Description |
|------|-------------|
| `list_mcps` | Lists all MCP policy sets under the `MCP` root in PAZ. Returns id, name, disabled flag, and policy count. |
| `add_mcp` | Creates a complete policy set for an MCP server: a `common` policy (Allow Actor Subject), a `tools/list` policy, and one policy per tool. Can auto-discover tools via `mcpUrl` or accept an explicit `tools` array. |
| `add_policy` | Adds a single tool policy to an existing MCP policy set. |
| `authorize_agent` | Grants an agent access to an MCP by appending its identity to the `Allow Actor Subject` rule in the `common` policy. Idempotent — converts a single subject to an OR condition automatically. |
| `remove_mcp` | Removes an MCP policy set and all its policies from PAZ, respecting referential integrity by clearing children first. |
| `get_mcp_scopes` | Returns all OAuth2 scopes for an MCP, derived from the `Validate Scope` rules. Scopes follow the pattern `mcp:<mcpName>:<toolName>`. |

### Policy Structure per MCP

Each policy set carries an audience condition (`audience Equals mcp:<mcpName>`). Inside it, every tool policy contains three rules:

- **Validate Scope** — token must contain `mcp:<mcpName>:<toolName>`
- **Allow Subject** — user must have the required role
- **Allow Actor Subject** — agent identity check (shared via the `common` policy)

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PAZ_BASE_URL` | PingAuthorize base URL (default: `https://localhost:9443`) |
| `PAZ_BRANCH` | PAZ policy branch UUID |
| `PAZ_USER_ID` | `X-User-ID` header value |

---

## aic-agent-manager → `/aic-agent-manager/mcp`

Manages AI Agent OAuth2 clients in PingOne Advanced Identity Cloud (AIC). Authentication to AIC uses a service account with an RS256 JWK private key via JWT-bearer grant.

### Tools

| Tool | Description |
|------|-------------|
| `list_agents` | Lists all AIC AI agents. Returns `id`, `status`, `scopes`, `idmUid` for each. |
| `create_agent` | Creates an OBO or autonomous AI agent in AIC. OBO agents use token-exchange grant only. Autonomous agents add `client_credentials`. Returns agent details and a one-time `clientSecret`. |
| `get_agent` | Fetches an existing AIC AI agent by ID. Returns `id`, `status`, `scopes`, `idmUid`. |
| `delete_agent` | Deletes an AIC AI agent by ID. Idempotent. |
| `update_agent_scopes` | Replaces the OAuth2 scope list on an existing agent. |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `AIC_HOST` | AIC tenant hostname |
| `AIC_SERVICE_ACCOUNT_ID` | Service account client ID |
| `AIC_JWK_PATH` | Path to RS256 JWK private key file |
| `AIC_REALM` | AIC realm path |
| `AIC_SCOPES` | Scopes for the service account token |

---

## ping-gateway-manager → `/ping-gateway-manager/mcp`

Manages PingGateway route files stored as JSON in a GitHub repository. Routes are committed via the GitHub Contents API and picked up by PingGateway on reload.

### Tools

| Tool | Description |
|------|-------------|
| `list_mcp_routes` | Lists all `.json` route files in the configured GitHub repo path. Returns route names and SHAs. |
| `get_mcp_route` | Fetches and decodes the full JSON content for a route by server name. |
| `add_mcp_route` | Renders a PingGateway route from the standard template and commits it to GitHub (creates or updates). Params: `serverName`, `mcpUrl`, `publicPath`. |
| `delete_mcp_route` | Deletes a route JSON file from GitHub. Idempotent. |

### Route Template

Every generated route always includes this filter chain, in order:

1. `McpAuditFilter` — logs the request
2. `McpValidationFilter` — validates MCP protocol compliance
3. `MCPPingAuthorizeFilter` — calls PAZ for authorization
4. `UriPathRewriteFilter` — rewrites the path to the upstream URL
5. `HeaderFilter` — injects required headers
6. `ReverseProxyHandler` — proxies to the upstream MCP server

### Environment Variables

| Variable | Description |
|----------|-------------|
| `GITHUB_OWNER` | GitHub organization or user |
| `GITHUB_REPO` | Repository name |
| `GITHUB_PATH` | Path inside repo for route files (default: `config/routes`) |
| `GITHUB_REF` | Git branch (default: `main`) |
| `GITHUB_TOKEN` | GitHub personal access token |
