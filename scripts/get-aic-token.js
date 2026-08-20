import { randomUUID } from 'node:crypto';
import { importJWK, SignJWT } from 'jose';

const host             = process.env.AIC_HOST;
const serviceAccountId = process.env.SERVICE_ACCOUNT_ID;
const scopes           = process.env.SCOPES || 'fr:am:* fr:idm:*';
const realm            = process.env.REALM  || '/realms/root/realms/alpha';

if (!host || !serviceAccountId || !process.env.AIC_JWK) {
  console.error('Missing required env vars: AIC_HOST, SERVICE_ACCOUNT_ID, AIC_JWK');
  process.exit(1);
}

const tokenEndpoint = `https://${host}/am/oauth2/access_token`;

const jwk        = JSON.parse(process.env.AIC_JWK);
const privateKey = await importJWK(jwk, 'RS256');

// Build and sign the JWT assertion (180-second expiry matches the curl example)
const now       = Math.floor(Date.now() / 1000);
const assertion = await new SignJWT({})
  .setProtectedHeader({ alg: 'RS256' })
  .setIssuer(serviceAccountId)
  .setSubject(serviceAccountId)
  .setAudience(tokenEndpoint)
  .setJti(randomUUID())
  .setExpirationTime(now + 180)
  .sign(privateKey);

// Exchange the JWT assertion for an access token
const res = await fetch(tokenEndpoint, {
  method:  'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id:  'service-account',
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
    scope: scopes,
  }),
});

if (!res.ok) {
  const body = await res.text();
  console.error(`Token request failed — HTTP ${res.status}`);
  console.error(body);
  process.exit(1);
}

const { access_token, expires_in, token_type } = await res.json();

console.log('token_type  :', token_type);
console.log('expires_in  :', expires_in, 's');
console.log('access_token:', access_token);

// List AI agents
console.log('\n── AI Agents ──────────────────────────────────────────────────────────');
const agentsUrl = `https://${host}/am/json${realm}/realm-config/agents/AIAgent?_queryFilter=true`;
const agentsRes = await fetch(agentsUrl, {
  headers: {
    'Accept-API-Version': 'resource=2.0',
    'Authorization':      `Bearer ${access_token}`,
  },
});

if (!agentsRes.ok) {
  const body = await agentsRes.text();
  console.error(`List agents failed — HTTP ${agentsRes.status}`);
  console.error(body);
  process.exit(1);
}

const agentsJson = await agentsRes.json();
console.log(JSON.stringify(agentsJson, null, 2));
