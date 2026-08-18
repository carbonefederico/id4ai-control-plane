---
name: id4ai-add-mcp
description: "Add an MCP server behind PingGateway with authorization policies. Use when asked to onboard, add, protect, proxy, or publish an MCP server route: publish the route via ping-gateway-manager, then create authorization policies in PingAuthorize via paz-manager (which discovers the live MCP tools internally). This is the id4ai add_mcp workflow."
---

# ID4AI Add MCP

Onboard an MCP server end-to-end: publish the PingGateway route, discover the server's tools, and create authorization policies in PingAuthorize.

## Inputs

### Phase 1 — main inputs

Derive as much as possible from the MCP URL before asking anything:

- `mcp_url`: the URL provided by the user (already known).
- `mcp_server_name`: derive from the last non-empty path segment of `mcp_url` (e.g. `https://host/mcp/products` → `products`).
- `public_path`: derive as the full path portion of `mcp_url` (e.g. `https://host/mcp/products` → `/mcp/products`).
- `user_role`: cannot be derived — ask the user. Explain it is the role required in the user's (subject) token, and becomes a claim-based permission check in the authorization policy.

Present the derived values alongside the `user_role` question in a **single confirmation prompt**, for example:

> I'll set up this MCP with:
> - **Name:** `products`
> - **Public path:** `/mcp/products`
> - **MCP URL:** `https://demo-mcp-ten.vercel.app/mcp/products`
>
> What **user role** should be required to access it? (e.g. `ProductManager`)
> Confirm the above or correct anything.

Do not ask for `mcp_server_name` or `public_path` as open questions — only surface them for correction.

### Phase 2 — agent connection

After phase 1, attempt to call `list_agents` on `aic-agent-manager` silently. This call is **non-fatal** — if it fails for any reason, continue without it and omit option a from the prompt below.

Then ask in a single follow-up prompt:

> "Which agent should be authorized to call this MCP?"
>
> **a) Existing agent** — (only if `list_agents` succeeded) show the IDs for the user to pick one.
> **b) Create a new agent** — ask for the desired agent ID; the agent will be created after the MCP is set up.
> **c) Skip for now** — no agent connected yet.

Resolve `agent_id` from the user's answer:

- Option a: use the selected agent's `id`.
- Option b: use the agent ID provided by the user (store as `new_agent_id`; `agent_id = <new_agent_id>`).
- Option c: set `agent_id = _placeholder_`.


## Execution rules

- Collect phase 1 inputs in a **single upfront prompt**. Collect phase 2 (agent selection) in one follow-up prompt after calling `list_agents`. Do not ask for anything else mid-workflow.
- After all inputs are confirmed, **run all steps to completion without pausing or asking for confirmation**.
- If a **required** MCP tool is unavailable (`add_mcp_route`, `add_mcp`), stop immediately and report the error clearly — do not skip or work around it. Optional calls (`list_agents`) may fail silently.

## Workflow

### 1. Publish the route

Call `add_mcp_route` on the `ping-gateway-manager` MCP (native Claude tool):

- `serverName`: `<mcp_server_name>`
- `mcpUrl`: `<mcp_url>`
- `publicPath`: `<public_path>`

### 2. Create authorization policies

Call `add_mcp` on the `paz-manager` MCP (native Claude tool). Pass `mcpUrl` — paz-manager discovers the tools internally.

- `mcpName`: `<mcp_server_name>`
- `mcpUrl`: `<mcp_url>`
- `audience`: `mcp:<mcp_server_name>`
- `userRole`: `<user_role>`
- `agentId`: `<agent_id>`

### 3. Create agent (if requested in phase 2)

Only run this step if the user chose option b (create a new agent) in phase 2.

Continue with the `id4ai-add-agent` workflow inline:
- Pre-select `<mcp_server_name>` as the target MCP — skip the MCP selection step.
- Use `new_agent_id` as the agent ID — do not ask again.
- Set `create_in_aic = true`.

Skip this step silently if the user chose an existing agent or skipped agent connection.

## Output

Return:

- route publish result
- list of authorization policies created (including discovered tool names)
- agent result (only if created)

## Bundled resources

- `assets/mcp-route-template.json`: PingGateway route template (reference only — used by ping-gateway-manager).
