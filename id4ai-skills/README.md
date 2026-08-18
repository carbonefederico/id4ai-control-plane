# ID4AI Skills

Two Claude Code skills that implement the primary automation workflows. Each skill is invoked as a slash command from within a Claude Code session and orchestrates calls to the three MCP servers to complete a multi-step configuration task end-to-end.

---

## id4ai-add-mcp

**Slash command:** `/id4ai-add-mcp`  
**Folder:** `id4ai-add-mcp/`

Onboards an MCP server — publishes its PingGateway route and creates a complete set of PingAuthorize authorization policies in a single guided flow.

### Workflow

1. Reads a `.id4ai` config file from the current directory (if present) to pre-fill defaults: `mcpServerName`, `publicPath`, `userRole`, `agentId`.
2. Prompts the user for: `mcp_server_name`, `mcp_url`, `public_path`, `user_role`, `agent_id` — collected in a single prompt.
3. Calls **`add_mcp_route`** (ping-gateway-manager) → commits the route JSON to GitHub; PingGateway picks it up on reload.
4. Calls **`add_mcp`** (paz-manager) with `mcpUrl` → paz-manager auto-discovers the live MCP tools and creates the full policy set (common policy + one policy per tool).
5. Optionally runs `id4ai-add-agent` inline if the user wants to create an agent for this MCP immediately (skipping the MCP selection step since it is already known).

### Bundled Assets

| File | Purpose |
|------|---------|
| `assets/mcp-route-template.json` | Reference copy of the PingGateway route template |
| `references/manifest-schema.md` | Schema for the tool manifest format used during policy creation |
| `scripts/discover_mcp.py` | Python script for CLI-based MCP tool discovery (alternative to built-in auto-discovery) |
| `agents/openai.yaml` | OpenAI agent definition for use with an OpenAI-compatible agent |

---

## id4ai-add-agent

**Slash command:** `/id4ai-add-agent`  
**Folder:** `id4ai-add-agent/`

Creates an OBO AI agent identity in AIC and grants it access to one or more protected MCP servers.

### Workflow

1. Prompts the user for `agent_id` only. Assumes the agent should be created in AIC unless told otherwise.
2. Calls **`list_mcps`** (paz-manager) → displays the available MCP servers → asks which ones to grant access to.
3. For each selected MCP, calls **`get_mcp_scopes`** (paz-manager) → collects all tool scopes for that MCP.
4. For each selected MCP, calls **`authorize_agent`** (paz-manager) → adds the agent to the `Allow Actor Subject` rule in the `common` policy.
5. Calls **`create_agent`** (aic-agent-manager) with `agentMode: obo` and the full collected scope list → creates the OAuth2 client in AIC.
6. Displays the `clientSecret` prominently (it is only available at creation time).

### Output

A summary containing: agent ID, authorized MCP servers, granted scopes, AIC agent details, and the one-time client secret.

---

## Scope Convention

Scopes follow the pattern `mcp:<server_name>:<tool_name>` — for example, `mcp:crm:get_customer`. One scope per tool; no coarse-grained merging. Scopes are derived automatically from the PAZ policy set when an agent is granted access.
