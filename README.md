# ID4AI Control Plane

**Automate AI agent identity creation and MCP server protection across PingOne Advanced Identity Cloud, PingAuthorize, and PingGateway.**

The ID4AI Control Plane is a purpose-built system for governing how AI agents discover and call tools exposed via the Model Context Protocol (MCP). It eliminates manual configuration across three Ping Identity products by providing Claude Code skills that orchestrate the full lifecycle — from publishing a gateway route to issuing an OAuth2 client — as well as a live dashboard that shows the resulting access topology at a glance.

---

## Why This Exists

AI agents that call MCP servers need:

1. **An identity** — an OAuth2 client in AIC that can obtain tokens (via token exchange for OBO agents, or client credentials for autonomous agents).
2. **A protected route** — a PingGateway route that proxies the upstream MCP server and enforces authentication and authorization on every request.
3. **Fine-grained policies** — PingAuthorize policies that gate access per MCP tool, per agent identity, and per user role.

Setting this up by hand across three systems is error-prone and slow. This project automates the whole flow with two skills (`id4ai-add-mcp` and `id4ai-add-agent`) and three MCP servers that Claude Code uses to talk to each product.

---

## Repository Layout

```
id4ai-control-plane/
├── mcp-server/      # Three MCP servers (paz-manager, aic-agent-manager, ping-gateway-manager)
├── backend/         # Express API that powers the dashboard
├── frontend/        # Single-page dashboard UI (vanilla JS)
├── id4ai-skills/    # Claude Code skills for the two primary workflows
└── scripts/         # Standalone CLI utilities for AIC agent management
```

---

## Architecture

```
Claude Code
  └── skills: id4ai-add-mcp, id4ai-add-agent
        │
        ▼
  MCP Server (port 3034)
  ├─ paz-manager           → PingAuthorize (policy sets, tool policies, agent subjects)
  ├─ aic-agent-manager     → Advanced Identity Cloud (OAuth2 AI agent clients)
  └─ ping-gateway-manager  → GitHub (PingGateway route JSON files)

  Dashboard (backend port 3001 + frontend SPA)
  ├─ reads GitHub          → published MCP routes
  ├─ reads AIC             → live agent list
  └─ reads PingAuthorize   → policy sets, scopes, authorized agents
```

At runtime, every AI agent call flows through:

```
AI Agent → PingGateway (route + filters) → PingAuthorize (policy eval) → upstream MCP server
```

The gateway validates the token, PAZ evaluates the per-tool policy, and only then does the upstream MCP tool execute.

---

## Scope Convention

MCP tool access is represented as OAuth2 scopes following the pattern:

```
mcp:<server_name>:<tool_name>
```

Example: `mcp:crm:get_customer`. One scope per tool. Scopes are created automatically when an MCP server is onboarded and are assigned to agents when they are granted access.

---

## Subfolders

| Folder | Description |
|--------|-------------|
| [mcp-server/](mcp-server/README.md) | The three MCP servers that Claude Code uses to automate configuration |
| [backend/](backend/README.md) | REST API serving the dashboard with live data from AIC, PAZ, and GitHub |
| [frontend/](frontend/README.md) | Single-page dashboard: agent topology, MCP inventory, policy viewer |
| [id4ai-skills/](id4ai-skills/README.md) | `id4ai-add-mcp` and `id4ai-add-agent` Claude Code skills |
| [scripts/](scripts/README.md) | CLI scripts for direct AIC agent management |

---

## Quick Start

Each subfolder has its own `package.json`. Start the MCP server and the dashboard API independently:

```bash
# MCP server
cd mcp-server && npm install && node server.js

# Dashboard
cd backend && npm install && node server.js
# Then open http://localhost:3001
```

Required environment variables are documented in each subfolder's README.
