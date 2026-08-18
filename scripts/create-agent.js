import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { importJWK, SignJWT } from 'jose';

const host             = process.env.AIC_HOST;
const serviceAccountId = process.env.SERVICE_ACCOUNT_ID;
const jwkPath          = process.env.JWK_PATH    || './privateKey.jwk';
const realm            = process.env.REALM        || '/realms/root/realms/alpha';

// Agent config — AGENT_ID is required (env var or first CLI arg)
const agentId     = process.env.AGENT_ID || process.argv[2];

// AGENT_MODE controls grant types:
//   'autonomous' (default) — client_credentials + token-exchange (background tasks, system integrations)
//   'obo'                  — token-exchange only (act on behalf of a user)
const agentMode   = (process.env.AGENT_MODE || 'autonomous').toLowerCase();

// Space-separated list of allowed scopes the agent may request in a token exchange
const agentScopes = (process.env.AGENT_SCOPES || 'openid profile email').split(/\s+/);

if (!host || !serviceAccountId) {
  console.error('Missing required env vars: AIC_HOST, SERVICE_ACCOUNT_ID');
  process.exit(1);
}

if (!agentId) {
  console.error('Usage: AGENT_ID=<id> node --env-file-if-exists=.env create-agent.js');
  console.error('   or: node --env-file-if-exists=.env create-agent.js <agent-id>');
  process.exit(1);
}

if (!['autonomous', 'obo'].includes(agentMode)) {
  console.error(`Invalid AGENT_MODE "${agentMode}" — must be "autonomous" or "obo"`);
  process.exit(1);
}

const tokenEndpoint = `https://${host}/am/oauth2/access_token`;

// ── Token acquisition ───────────────────────────────────────────────────────

const jwk        = JSON.parse(readFileSync(jwkPath, 'utf8'));
const privateKey = await importJWK(jwk, 'RS256');

const now       = Math.floor(Date.now() / 1000);
const assertion = await new SignJWT({})
  .setProtectedHeader({ alg: 'RS256' })
  .setIssuer(serviceAccountId)
  .setSubject(serviceAccountId)
  .setAudience(tokenEndpoint)
  .setJti(randomUUID())
  .setExpirationTime(now + 180)
  .sign(privateKey);

const tokenRes = await fetch(tokenEndpoint, {
  method:  'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id:  'service-account',
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
    scope: 'fr:am:*',
  }),
});

if (!tokenRes.ok) {
  console.error(`Token request failed — HTTP ${tokenRes.status}`);
  console.error(await tokenRes.text());
  process.exit(1);
}

const { access_token } = await tokenRes.json();

// ── Agent creation ──────────────────────────────────────────────────────────

// OBO agents exchange a user token and don't need client_credentials.
// Autonomous agents also obtain their own token via client_credentials first.
const grantTypes = agentMode === 'obo'
  ? ['urn:ietf:params:oauth:grant-type:token-exchange']
  : ['client_credentials', 'urn:ietf:params:oauth:grant-type:token-exchange'];

const agentBody = {
  aiAgentIdentityAttributes: {
    inherited: false,
    value: { name: agentId, oauth2ClientId: agentId },
  },
  coreOAuth2ClientConfig: {
    status:     { inherited: false, value: 'Active' },
    clientType: { inherited: false, value: 'Confidential' },
    scopes:     { inherited: false, value: agentScopes },
  },
  advancedOAuth2ClientConfig: {
    grantTypes:              { inherited: false, value: grantTypes },
    tokenEndpointAuthMethod: { inherited: false, value: 'client_secret_post' },
  },
};

console.log(`Creating agent "${agentId}" (mode: ${agentMode}, scopes: ${agentScopes.join(' ')}) …`);

const createUrl = `https://${host}/am/json${realm}/realm-config/agents/AIAgent/${encodeURIComponent(agentId)}`;
const createRes = await fetch(createUrl, {
  method:  'PUT',
  headers: {
    'Accept-API-Version': 'resource=2.0',
    'Content-Type':       'application/json',
    'Authorization':      `Bearer ${access_token}`,
    'If-None-Match':      '*',
  },
  body: JSON.stringify(agentBody),
});

const createBody = await createRes.json();

if (!createRes.ok) {
  if (createRes.status === 412) {
    console.error(`Agent "${agentId}" already exists (HTTP 412). Remove If-None-Match to upsert.`);
  } else {
    console.error(`Create agent failed — HTTP ${createRes.status}`);
    console.error(JSON.stringify(createBody, null, 2));
  }
  process.exit(1);
}

const idmUid = createBody?.aiAgentIdentityUid?.value ?? createBody?.aiAgentIdentityUid ?? '(not returned)';

console.log(`\nAgent created — HTTP ${createRes.status}`);
console.log('agentId           :', agentId);
console.log('aiAgentIdentityUid:', idmUid, '← needed for privilege creation');
console.log('\nFull response:');
console.log(JSON.stringify(createBody, null, 2));
