import app from './api/index.js';
import { warmMcpCache } from './api/routes/mcps.js';

const PORT = Number(process.env.PORT) || 3033;
const environment = process.env.NODE_ENV || 'development';

app.listen(PORT, () => {
  console.log(`ID4AI dashboard running on http://localhost:${PORT} (${environment})`);
  console.log(`  GitHub source: ${process.env.GITHUB_OWNER || 'your-org'}/${process.env.GITHUB_REPO || 'your-gateway-repo'} @ ${process.env.GITHUB_PATH || 'config/routes'}`);
  console.log('  Set GITHUB_OWNER, GITHUB_REPO, GITHUB_PATH env vars to point at your repo.');
  warmMcpCache();
});
