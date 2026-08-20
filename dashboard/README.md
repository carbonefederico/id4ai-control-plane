# ID4AI Control Plane Dashboard

A single Express application that serves the dashboard UI and its REST API. The project is structured for local Node.js development and a single Vercel project.

## Layout

- `api/index.js` — Express application and Vercel function entry point
- `api/routes/` — AIC, GitHub, and PingAuthorize integrations
- `public/` — static dashboard assets
- `dev.js` — local development launcher

The browser uses same-origin `/api/...` requests in both environments.

## Local development

```bash
cd dashboard
npm install
npm run dev
```

Open [http://localhost:3033](http://localhost:3033).

The local launcher loads `dashboard/.env`, starts the Express app, and warms the MCP route cache. The package's `dev` script is the single command for the dashboard UI and API. The cache is also loaded lazily by API requests, so correctness does not depend on startup warming.

Useful endpoints:

- `GET /health`
- `GET /api/summary`
- `GET /api/agents`
- `GET /api/mcps`
- `GET /api/paz/mcp-policysets`
- `GET /api/paz/mcp-summary`

The separate `mcp-server` project is not started by the dashboard command.

## Environment variables

Copy the template and fill in values for the services you use:

```bash
cp .env.example .env
```

Required integrations use:

- `AIC_HOST`, `AIC_SERVICE_ACCOUNT_ID`, `AIC_JWK`, `AIC_REALM`, `AIC_SCOPES`
- `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_PATH`, `GITHUB_REF`, `GITHUB_TOKEN`
- `PAZ_BASE_URL`, `PAZ_BRANCH`, `PAZ_USER_ID`
- `GATEWAY_PUBLIC_URL`

`AIC_JWK` is a private-key JWK encoded as a JSON environment-variable value. Do not commit `.env` or expose these values to the browser. `PORT` controls local development and defaults to `3033`.

## Vercel deployment

Create one Vercel project for this repository and set its **Root Directory** to `dashboard`.

Vercel will use `api/index.js` for the API function and serve files under `public/` as static assets. No frontend build command is required. Configure the environment variables above in the Vercel project settings for the appropriate Production, Preview, and Development environments.

Verify after deployment:

```text
/
/css/styles.css
/js/app.js
/health
/api/summary
/api/agents
/api/mcps
```

The AIC private JWK, GitHub token, and other service credentials must be configured as server-side Vercel environment variables, not committed to the repository.
