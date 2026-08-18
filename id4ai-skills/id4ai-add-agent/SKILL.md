---
name: id4ai-add-agent
description: "Create an OBO AI agent in AIC and grant it access to one or more MCP servers. Lists available MCP policy sets from PingAuthorize, lets the user select which ones the agent should access, fetches scopes from PAZ, optionally creates the agent in AIC via aic-agent-manager, then authorizes the agent on each selected MCP via paz-manager. This is the id4ai add_agent workflow."
---

# ID4AI Add Agent

Grant an AI agent access to selected MCP servers in PingAuthorize, and optionally create it in AIC.

## Inputs

Set `create_in_aic = true` by default.

Ask only for the `agent_id`.

Only set `create_in_aic = false` if the user explicitly says the agent already exists (e.g. "grant access to existing agent X").

Do not ask about AIC creation. Do not ask for anything else upfront.

## Execution rules

- **Step 1 and step 2 are interactive** — they require showing results and asking for user input. Do not skip these interactions.
- **Steps 3 and 4 run automatically** — after all scopes are confirmed, execute to completion without pausing or asking for confirmation.
- If a required MCP tool is unavailable, **stop immediately and report the error clearly** — do not skip or work around it.

## Workflow

### 1. List available MCPs

Call `list_mcps` on the `paz-manager` MCP (native Claude tool). Show the returned list to the user and ask which MCPs this agent should have access to. The user may select one or more.

### 2. Fetch scopes and select access level for each MCP

For each selected MCP:

1. Call `get_mcp_scopes` on the `paz-manager` MCP:
   - `mcpName`: `<selected mcp name>`

2. Ask the user:

   > "For **\<mcpName\>**, do you want to grant full access or select individual tools?"
   >
   > **a) Full access** — grant all scopes.
   > **b) Individual tools** — show the scope list and let the user pick.

3. Resolve the granted scopes:
   - Option a: use all returned scopes.
   - Option b: display the scopes (one per line), ask the user to select, and use only those selected.

Collect the granted scopes across all selected MCPs into a single flat list.

### 3. Authorize agent on selected MCPs

For each selected MCP, call `authorize_agent` on the `paz-manager` MCP:

- `mcpName`: `<selected mcp name>`
- `agentId`: `<agent_id>`

This call is idempotent — safe to retry. Report the result for each MCP.

### 4. Create agent in AIC

If `create_in_aic = true`, call `create_agent` on the `aic-agent-manager` MCP:

- `agentId`: `<agent_id>`
- `agentMode`: `obo` (hardcoded — token-exchange grant only)
- `agentScopes`: **only the scopes the user selected in step 2** — not the full list returned by `get_mcp_scopes`. If the user chose full access, pass all scopes; if the user chose individual tools, pass only the selected ones.

The response will include the generated client secret. **Display it clearly and immediately** — it will not be retrievable again. Instruct the user to store it securely.

If `create_in_aic = false`, skip this step and say so explicitly.

## Output

Return:

- `agentId`
- list of MCPs the agent was authorized on
- list of scopes assigned
- AIC agent details and client secret (only if created)

## Bundled resources

- `references/`: reserved for future reference docs.
