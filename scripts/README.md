# Scripts

Standalone CLI utilities for direct AIC agent management, independent of the MCP server layer. Useful for testing authentication flows or provisioning agents outside of Claude Code.

---

## create-agent.js

Creates an AIC AI agent directly via the AIC REST API.

```bash
node create-agent.js [agent_id]
```

Reads configuration from environment variables (or `.env`). Authenticates using JWT-bearer (RS256 JWK private key), then PUTs the agent definition via the AIC REST API. Prints the full AIC response including `aiAgentIdentityUid`.

| Variable | Description |
|----------|-------------|
| `AIC_HOST` | AIC tenant hostname |
| `SERVICE_ACCOUNT_ID` | Service account client ID |
| `JWK_PATH` | Path to RS256 JWK private key file |
| `REALM` | AIC realm path |
| `AGENT_ID` | Agent ID (overridden by first CLI argument if provided) |
| `AGENT_MODE` | `obo` or `autonomous` |
| `AGENT_SCOPES` | Space-separated list of OAuth2 scopes |

---

## get-aic-token.js

Retrieves an AIC service account access token. Useful for verifying that the JWK key and service account configuration are correct.

```bash
node get-aic-token.js
```

Uses the same environment variables as `create-agent.js`.

---

## Configuration

Place a `.env` file in this directory with the required variables. A `privateKey.jwk` file containing the RS256 private key must be present at the path specified by `JWK_PATH`.
