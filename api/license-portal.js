// Vercel Serverless Function: Self-service license dashboard actions
//
// Public:
//   POST /api/license-portal
//   body { action: "request_code", email, licenseKey? }
//   body { action: "verify_code", email, code }
//
// Authenticated (Bearer token returned by verify_code):
//   GET /api/license-portal
//   POST /api/license-portal
//   body { action: "reset_machine", reason? }

const crypto = require('crypto');
const {
  stripe,
  cleanText,
  normalizeEmail,
  normalizeLicenseKey,
  findCustomerByEmail,
  findCustomerByLicenseKey,
  findCustomerByDiscordUserId,
  getLicenseSummary,
  MACHINE_RESET_URL,
} = require('./_license-utils');
const { verifyDiscordMember } = require('./_discord-auth');

const CODE_TTL_MINUTES = 10;
const SESSION_TTL_HOURS = 24;
const RESET_COOLDOWN_MINUTES = 10;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function getSecret() {
  const secret = String(
    process.env.LICENSE_PORTAL_SECRET || process.env.ADMIN_SECRET || process.env.STRIPE_SECRET_KEY || ''
  ).trim();
  if (!secret) throw new Error('License portal secret is not configured');
  return secret;
}

function base64Url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function hashCode(email, code, secret) {
  return crypto
    .createHash('sha256')
    .update(`${normalizeEmail(email)}|${String(code || '').trim()}|${secret}`)
    .digest('hex');
}

function signToken(payload, secret) {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64Url(JSON.stringify(payload));
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function getBearerToken(req) {
  const auth = String(req.headers.authorization || '');
  if (!auth.toLowerCase().startsWith('bearer ')) return '';
  return auth.slice(7).trim();
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendAccessCodeEmail({ email, code }) {
  const resendKey = String(process.env.RESEND_API_KEY || '').trim();
  if (!resendKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }

  const fromEmail = String(
    process.env.LICENSE_PORTAL_FROM || 'Nexus by Hyperfect <noreply@admin.hyperfect.dev>'
  ).trim();
  const safeEmail = normalizeEmail(email);

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [safeEmail],
      subject: 'Your Nexus license dashboard code',
      html: `
        <div style="font-family: -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
          <h2 style="margin: 0 0 12px; color: #0f172a;">Nexus License Dashboard</h2>
          <p style="margin: 0 0 16px; color: #334155;">Use this verification code to manage your license and reset machine activation.</p>
          <div style="font-size: 28px; letter-spacing: 6px; font-weight: 700; color: #1d4ed8; padding: 14px 18px; border-radius: 10px; background: #eff6ff; text-align: center;">${code}</div>
          <p style="margin: 16px 0 0; color: #64748b;">This code expires in ${CODE_TTL_MINUTES} minutes.</p>
        </div>
      `,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Failed to send access code email (${response.status}): ${detail.slice(0, 160)}`);
  }
}

async function loadCustomerForCodeRequest({ email, licenseKey }) {
  let byKey = null;
  let byEmail = null;
  const normalizedEmail = normalizeEmail(email);
  const normalizedKey = normalizeLicenseKey(licenseKey);

  if (normalizedKey) {
    byKey = await findCustomerByLicenseKey(normalizedKey);
  }
  if (normalizedEmail) {
    byEmail = await findCustomerByEmail(normalizedEmail);
  }

  // If both were provided and resolve to different customers, treat as not found.
  if (byKey && byEmail && byKey.id !== byEmail.id) return null;

  return byKey || byEmail || null;
}

function formatDiscordHandle(user) {
  const username = cleanText(user?.username || '', 120);
  const discriminator = cleanText(user?.discriminator || '', 10);
  if (!username) return '';
  if (discriminator && discriminator !== '0') return `${username}#${discriminator}`;
  return username;
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  let secret;
  try {
    secret = getSecret();
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }

  try {
    if (req.method === 'GET') {
      const token = getBearerToken(req);
      const session = verifyToken(token, secret);
      if (!session) {
        return res.status(401).json({ success: false, error: 'Invalid or expired session' });
      }

      const customer = await stripe.customers.retrieve(session.cid);
      if (!customer || customer.deleted) {
        return res.status(404).json({ success: false, error: 'License account not found' });
      }
      if (normalizeEmail(customer.email) !== normalizeEmail(session.email)) {
        return res.status(401).json({ success: false, error: 'Session mismatch' });
      }

      return res.status(200).json({
        success: true,
        license: {
          ...getLicenseSummary(customer),
          manage_url: MACHINE_RESET_URL,
        },
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    const action = cleanText(req.body?.action, 40).toLowerCase();

    if (action === 'request_code') {
      const email = normalizeEmail(req.body?.email || '');
      const licenseKey = normalizeLicenseKey(req.body?.licenseKey || req.body?.license_key || '');
      if (!email && !licenseKey) {
        return res.status(400).json({ success: false, error: 'Email or license key is required' });
      }

      const customer = await loadCustomerForCodeRequest({ email, licenseKey });

      // Don't leak whether the email/key exists.
      if (!customer || !customer.email || !(customer.metadata || {}).license_key) {
        return res.status(200).json({
          success: true,
          message: 'If we found a matching license, a verification code was sent.',
        });
      }

      const code = generateCode();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + CODE_TTL_MINUTES * 60 * 1000);
      const codeHash = hashCode(customer.email, code, secret);

      await stripe.customers.update(customer.id, {
        metadata: {
          ...(customer.metadata || {}),
          license_portal_code_hash: codeHash,
          license_portal_code_expires_at: expiresAt.toISOString(),
          license_portal_code_sent_at: now.toISOString(),
        },
      });

      await sendAccessCodeEmail({ email: customer.email, code });

      return res.status(200).json({
        success: true,
        message: 'If we found a matching license, a verification code was sent.',
      });
    }

    if (action === 'verify_code') {
      const email = normalizeEmail(req.body?.email || '');
      const code = cleanText(req.body?.code || '', 16);
      if (!email || !code) {
        return res.status(400).json({ success: false, error: 'Email and code are required' });
      }

      const customer = await findCustomerByEmail(email);
      if (!customer || customer.deleted || normalizeEmail(customer.email) !== email) {
        return res.status(401).json({ success: false, error: 'Invalid email or code' });
      }

      const metadata = customer.metadata || {};
      const expectedHash = cleanText(metadata.license_portal_code_hash, 128);
      const expiresAt = cleanText(metadata.license_portal_code_expires_at, 64);
      if (!expectedHash || !expiresAt) {
        return res.status(401).json({ success: false, error: 'Invalid email or code' });
      }

      const expiresTs = Date.parse(expiresAt);
      if (!expiresTs || Number.isNaN(expiresTs) || Date.now() > expiresTs) {
        return res.status(401).json({ success: false, error: 'Code expired. Request a new code.' });
      }

      const actualHash = hashCode(email, code, secret);
      if (!crypto.timingSafeEqual(Buffer.from(actualHash), Buffer.from(expectedHash))) {
        return res.status(401).json({ success: false, error: 'Invalid email or code' });
      }

      const token = signToken(
        {
          cid: customer.id,
          email,
          exp: Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000,
        },
        secret
      );

      await stripe.customers.update(customer.id, {
        metadata: {
          ...metadata,
          license_portal_code_hash: '',
          license_portal_code_expires_at: '',
          license_portal_verified_at: new Date().toISOString(),
        },
      });

      return res.status(200).json({
        success: true,
        token,
        license: {
          ...getLicenseSummary(customer),
          manage_url: MACHINE_RESET_URL,
        },
      });
    }

    if (action === 'discord_auth') {
      const discordToken = cleanText(req.body?.discordToken || req.body?.discord_token || '', 4096);
      if (!discordToken) {
        return res.status(400).json({ success: false, error: 'Discord token is required' });
      }

      const discord = await verifyDiscordMember(discordToken);
      if (!discord.ok) {
        const reason = cleanText(discord.reason, 64);
        if (reason === 'missing_server_config') {
          return res.status(500).json({ success: false, error: 'Discord login is not configured on the server' });
        }
        if (reason === 'not_in_server') {
          return res.status(403).json({ success: false, error: 'Join the Nexus Discord server before signing in' });
        }
        return res.status(401).json({ success: false, error: 'Discord authentication failed' });
      }

      const discordUser = discord.user || {};
      const discordUserId = cleanText(discordUser.id, 64);
      if (!discordUserId) {
        return res.status(401).json({ success: false, error: 'Discord user could not be verified' });
      }

      let customer = await findCustomerByDiscordUserId(discordUserId);
      if (!customer || customer.deleted) {
        return res.status(404).json({
          success: false,
          error: 'No license is linked to this Discord account yet. Run /license-bind in Discord first.',
        });
      }

      const metadata = customer.metadata || {};
      if (!(metadata.license_key || '').trim()) {
        return res.status(404).json({
          success: false,
          error: 'No active license key was found for the linked Discord account.',
        });
      }

      const linkedId = cleanText(metadata.license_discord_user_id || '', 64);
      if (linkedId && linkedId !== discordUserId) {
        return res.status(409).json({
          success: false,
          error: 'This license is linked to a different Discord account.',
        });
      }

      const nowIso = new Date().toISOString();
      const updated = await stripe.customers.update(customer.id, {
        metadata: {
          ...metadata,
          license_discord_user_id: discordUserId,
          license_discord_username: formatDiscordHandle(discordUser),
          license_discord_global_name: cleanText(discordUser.global_name || '', 120),
          license_discord_last_login_at: nowIso,
          license_discord_linked_at: metadata.license_discord_linked_at || nowIso,
        },
      });

      const token = signToken(
        {
          cid: updated.id,
          email: normalizeEmail(updated.email || ''),
          exp: Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000,
        },
        secret
      );

      return res.status(200).json({
        success: true,
        token,
        auth: 'discord',
        discord: {
          id: discordUserId,
          username: cleanText(discordUser.username, 120),
          global_name: cleanText(discordUser.global_name, 120),
        },
        license: {
          ...getLicenseSummary(updated),
          manage_url: MACHINE_RESET_URL,
        },
      });
    }

    if (action === 'reset_machine') {
      const token = getBearerToken(req);
      const session = verifyToken(token, secret);
      if (!session) {
        return res.status(401).json({ success: false, error: 'Invalid or expired session' });
      }

      const customer = await stripe.customers.retrieve(session.cid);
      if (!customer || customer.deleted) {
        return res.status(404).json({ success: false, error: 'License account not found' });
      }
      if (normalizeEmail(customer.email) !== normalizeEmail(session.email)) {
        return res.status(401).json({ success: false, error: 'Session mismatch' });
      }

      const metadata = customer.metadata || {};
      const lastResetAtRaw = cleanText(metadata.license_last_reset_at, 64);
      const lastResetTs = lastResetAtRaw ? Date.parse(lastResetAtRaw) : 0;
      if (lastResetTs && Date.now() - lastResetTs < RESET_COOLDOWN_MINUTES * 60 * 1000) {
        return res.status(429).json({
          success: false,
          error: `Please wait ${RESET_COOLDOWN_MINUTES} minutes between reset requests.`,
        });
      }

      const nowIso = new Date().toISOString();
      const resetCount = (parseInt(metadata.license_reset_count || '0', 10) || 0) + 1;
      const reason = cleanText(req.body?.reason || 'self-service', 120);

      const updated = await stripe.customers.update(customer.id, {
        metadata: {
          ...metadata,
          license_hardware_id: '',
          license_hardware_bound_at: '',
          license_last_validation_at: '',
          license_last_app_version: '',
          license_reset_count: String(resetCount),
          license_last_reset_at: nowIso,
          license_last_reset_reason: reason,
        },
      });

      return res.status(200).json({
        success: true,
        message: 'Machine activation reset. You can now activate on another computer.',
        license: {
          ...getLicenseSummary(updated),
          manage_url: MACHINE_RESET_URL,
        },
      });
    }

    return res.status(400).json({ success: false, error: 'Unknown action' });
  } catch (err) {
    console.error('License portal error:', err?.message || String(err));
    return res.status(500).json({ success: false, error: 'License portal request failed' });
  }
};
