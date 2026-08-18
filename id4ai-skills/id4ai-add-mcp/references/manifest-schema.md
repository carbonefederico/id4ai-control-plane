# MCP discovery manifest contract

The discovery manifest is the stable handoff between `id4ai-add-mcp` and future authorization-policy generation.

```json
{
  "schemaVersion": 1,
  "mcpServerName": "crm",
  "mcpUrl": "https://mcp.example.com/mcp",
  "protocolVersion": "2025-06-18",
  "serverInfo": {},
  "tools": [
    {
      "name": "get_customer",
      "normalizedName": "get_customer",
      "description": "Retrieve a customer",
      "inputSchema": {"type": "object"},
      "scope": "mcp:crm:get_customer"
    }
  ]
}
```

Rules:

- `mcpServerName` is normalized once and reused as the PingGateway route name.
- `name` preserves the MCP-reported tool name.
- `normalizedName` is deterministic and must not encode semantic inference.
- `scope` is exactly `mcp:<mcpServerName>:<normalizedName>`.
- Future authorization policy generation should consume this manifest rather than call `tools/list` independently.
