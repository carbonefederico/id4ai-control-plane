# id4ai-add-mcp

First iteration of the `id4ai` MCP onboarding workflow. It discovers the tools exposed by an MCP server, derives one scope per tool, generates a PingGateway route, validates it, and publishes the route to GitHub through a pull request.

## ID4AI naming

This package uses the skill name `id4ai-add-mcp`. It is intended to sit next to other ID4AI skills such as:

- `id4ai-deploy-mcp`
- `id4ai-add-agent`
- future authorization/policy skills

The human command/concept can still be expressed as `id4ai add_mcp`.

## Scope convention

For MCP server `crm` and tool `get_customer`, the generated scope is:

```text
mcp:crm:get_customer
```

The mapping is deterministic. This iteration does not merge tools into broad `read`, `write`, or `admin` scopes.

## Prerequisites

- Python 3.9+
- `git`
- GitHub CLI `gh`
- Network access to the MCP HTTP endpoint
- Permission to read and create branches/PRs in the target GitHub repository

Authenticate GitHub before using the publish step:

```bash
gh auth login
gh auth status
```

Do not store GitHub tokens, MCP bearer tokens, client secrets, or other credentials inside this skill or generated route files.

## 1. Discover an MCP server

Pass the complete MCP endpoint URL, including its MCP path:

```bash
python scripts/discover_mcp.py \
  --server-name crm \
  --url https://mcp.example.com/mcp \
  --output build/crm-manifest.json
```

The script performs MCP initialization and `tools/list`, following pagination when the server returns `nextCursor`.

Example manifest fragment:

```json
{
  "mcpServerName": "crm",
  "mcpUrl": "https://mcp.example.com/mcp",
  "tools": [
    {
      "name": "get_customer",
      "normalizedName": "get_customer",
      "scope": "mcp:crm:get_customer"
    }
  ]
}
```

## 2. Generate a PingGateway route

Choose the public PingGateway path. The backend path is taken from `mcpUrl` in the manifest.

```bash
python scripts/generate_route.py \
  --manifest build/crm-manifest.json \
  --public-path /crm \
  --output build/crm.json
```

For an MCP URL of `https://mcp.example.com/mcp`, the route will use:

- route name: `crm`
- `mcpServerUrl`: `https://mcp.example.com`
- rewrite: `/crm` -> `/mcp`
- Host header: `mcp.example.com`

The route always includes these filters in order:

```text
McpAuditFilter
McpValidationFilter
MCPPingAuthorizeFilter
UriPathRewriteFilter
HeaderFilter
```

The authorization filter is present, but policy generation is intentionally reserved for the next iteration.

## 3. Validate

```bash
python scripts/validate_route.py build/crm.json \
  --manifest build/crm-manifest.json
```

A valid route prints:

```text
VALID
```

## 4. Publish to GitHub

The publish helper clones the target repository to a temporary directory, creates a branch, copies the generated route, commits it, pushes, and opens a PR.

```bash
bash scripts/publish_github.sh \
  --repo my-org/pinggateway-config \
  --route build/crm.json \
  --target-dir config/routes \
  --server-name crm
```

Default branch name:

```text
id4ai/add-mcp-crm
```

Default commit message:

```text
feat(pinggateway): add MCP route crm
```

The script prints the pull request URL when successful.

You can override the branch name:

```bash
bash scripts/publish_github.sh \
  --repo my-org/pinggateway-config \
  --route build/crm.json \
  --target-dir config/routes \
  --server-name crm \
  --branch feature/onboard-crm-mcp
```

## Suggested end-to-end invocation for an agent

Conceptually:

```text
id4ai add_mcp
  server_name: crm
  mcp_url: https://mcp.example.com/mcp
  public_path: /crm
  github_repo: my-org/pinggateway-config
  github_target_dir: config/routes
```

The skill should then:

1. discover tools;
2. show the discovered tool-to-scope mapping;
3. generate the PingGateway route;
4. validate it;
5. publish it to a GitHub branch and open a PR;
6. return the PR URL.

## Next iteration

The manifest is intentionally preserved as the contract for policy generation. A future skill can consume entries such as:

```json
{
  "name": "delete_customer",
  "scope": "mcp:crm:delete_customer"
}
```

and generate the corresponding PingGateway authorization policies without rediscovering or reinterpreting the MCP tool inventory.
