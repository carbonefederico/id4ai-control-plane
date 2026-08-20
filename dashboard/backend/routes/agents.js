import { randomUUID } from 'node:crypto';
import { importJWK, SignJWT } from 'jose';

function aicCfg() {
  return {
    host:             process.env.AIC_HOST               || '',
    serviceAccountId: process.env.AIC_SERVICE_ACCOUNT_ID || '',
    scopes:           process.env.AIC_SCOPES             || 'fr:am:* fr:idm:*',
    realm:            process.env.AIC_REALM              || '/realms/root/realms/alpha',
  };
}

let _tokenCache  = null;
let _tokenExpiry = 0;

async function getAicToken() {
  if (_tokenCache && Date.now() < _tokenExpiry) return _tokenCache;

  const { host, serviceAccountId, scopes } = aicCfg();
  const tokenEndpoint = `https://${host}/am/oauth2/access_token`;

  const jwk        = JSON.parse(process.env.AIC_JWK);
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
    throw new Error(`AIC token request failed — HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const { access_token, expires_in } = await res.json();
  _tokenCache  = access_token;
  _tokenExpiry = Date.now() + (expires_in - 30) * 1000; // refresh 30 s before expiry
  return access_token;
}

function normalizeAgent(a) {
  return {
    id:     a._id,
    name:   a.coreOAuth2ClientConfig?.clientName?.[0] || a._id,
    status: a.coreOAuth2ClientConfig?.status          || 'Active',
    scopes: a.coreOAuth2ClientConfig?.scopes          || [],
    idmUid: a.aiAgentIdentityUid                      || null,
  };
}

export async function getAgents(_req, res) {
  const { host, realm } = aicCfg();

  if (!host) {
    console.warn('[agents] AIC_HOST not configured — returning empty list');
    return res.json([]);
  }

  try {
    const token = await getAicToken();
    const url   = `https://${host}/am/json${realm}/realm-config/agents/AIAgent?_queryFilter=true`;
    console.log(`[agents] GET ${url}`);

    const r = await fetch(url, {
      headers: {
        'Accept-API-Version': 'resource=2.0',
        'Authorization':      `Bearer ${token}`,
      },
    });

    if (!r.ok) {
      const body = await r.text();
      throw new Error(`AIC agents API HTTP ${r.status}: ${body.slice(0, 200)}`);
    }

    const { result } = await r.json();
    console.log(`[agents] returning ${result.length} agents`);
    res.json(result.map(normalizeAgent));
  } catch (e) {
    console.error('[agents] error:', e.message);
    res.status(502).json({ error: e.message });
  }
}
