# Dashboard — Frontend

Single-page application (vanilla HTML/CSS/JS, no build step) served by the backend at `http://localhost:3033`. Provides a live view of AI agent identities, protected MCP servers, authorization policies, and the access topology between them.

Files: `index.html`, `js/app.js`, `css/styles.css`

---

## Sections

### Dashboard

Overview of the entire access topology.

- **KPI tiles** — live counts of agents, MCP servers, and tools (policy count from PAZ).
- **Coverage by agent** — bar chart showing how many MCP servers each agent is authorized on.
- **Policy coverage** — bar chart showing how many agents are authorized per MCP server.
- **Agent access map** — interactive SVG bipartite graph. Nodes on the left are agents; nodes on the right are MCP servers. Edges represent authorization grants. Hover highlights a node's connections; click navigates to the detail view.

### Agents

Live table of AIC AI agents.

- Columns: agent name, MCP servers accessible, status.
- Stat cards for total agents, active count, unique scopes.
- **Agent detail view** (on row click): lists each accessible MCP server and, per server, the tools the agent can call with their scopes. Cross-references AIC scope list with PAZ policy sets.

### MCP Servers

Live table of PingGateway routes.

- Columns: server name, public URL, upstream URL, scopes, policy count, status.
- Stat tiles for active routes, total exposed tools, audiences.
- **MCP detail view** (on row click) with two tabs:
  - **Policies** — PAZ policy set summary: audience condition, authorized agents, and per-tool policies (scope and required user role).
  - **Route Config** — visual filter chain: each PingGateway filter with its configuration, ending at the reverse proxy handler.

### Policies *(stub)*

Table of authorization policies. Currently shows 4 demo records; not yet wired to live PAZ data.

### Access Logs *(stub)*

Table of gateway access events (time, agent, server/tool, policy decision, latency). Currently shows 5 demo records; not yet wired to gateway log files.

---

## Data Flow

The app calls the backend API (`/api/...`) for all data. Results are cached in memory across navigation (`window._agentData`, `window._pazSummary`, `window._mcpData`) to avoid redundant requests within a session.
