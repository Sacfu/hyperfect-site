const crypto = require('crypto');
const { cleanText, validateLicenseRecord } = require('./_license-utils');

const ALLOWED_CHANNELS = new Set(['stable', 'beta']);
const ALLOWED_PLATFORMS = new Set(['mac', 'win', 'linux']);
const ALLOWED_ARCHES = new Set(['x64', 'arm64']);

function normalizeChannel(value) {
  const channel = cleanText(value, 16).toLowerCase();
  return ALLOWED_CHANNELS.has(channel) ? channel : 'stable';
}

function normalizePlatform(value) {
  const platform = cleanText(value, 16).toLowerCase();
  return ALLOWED_PLATFORMS.has(platform) ? platform : '';
}

function normalizeArch(value) {
  const arch = cleanText(value, 16).toLowerCase();
  return ALLOWED_ARCHES.has(arch) ? arch : '';
}

function parseNumeric(value, fallback = 0) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function toBase64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(input) {
  const padded = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLength), 'base64').toString('utf8');
}

function getUpdateSecret() {
  const secret = String(
    process.env.UPDATE_LINK_SECRET ||
      process.env.LICENSE_PORTAL_SECRET ||
      process.env.ADMIN_SECRET ||
      process.env.STRIPE_SECRET_KEY ||
      ''
  ).trim();
  if (!secret) {
    throw new Error('Update signing secret is not configured');
  }
  return secret;
}

function signToken(payload, secret) {
  const body = toBase64Url(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${body}.${signature}`;
}

function verifyToken(token, secret) {
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) return null;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

  if (expected.length !== signature.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;

  try {
    const payload = JSON.parse(fromBase64Url(body));
    if (!payload || typeof payload !== 'object') return null;
    if (!payload.exp || Date.now() > Number(payload.exp)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function getRequestOrigin(req) {
  const proto = cleanText(req.headers['x-forwarded-proto'] || 'https', 16).toLowerCase() || 'https';
  const host = cleanText(req.headers['x-forwarded-host'] || req.headers.host || 'www.hyperfect.dev', 200);
  return `${proto}://${host}`;
}

function getArtifactEnv(channel, platform, arch, suffix) {
  const keyWithArch = `UPDATE_${channel.toUpperCase()}_${platform.toUpperCase()}_${arch.toUpperCase()}_${suffix}`;
  const keyWithoutArch = `UPDATE_${channel.toUpperCase()}_${platform.toUpperCase()}_${suffix}`;
  return String(process.env[keyWithArch] || process.env[keyWithoutArch] || '').trim();
}

function getFileNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname || '';
    const parts = pathname.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : '';
  } catch (_) {
    const parts = String(url || '').split('?')[0].split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : '';
  }
}

function getUpdateConfig({ channel, platform, arch }) {
  const normalizedChannel = normalizeChannel(channel);
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedArch = normalizeArch(arch);

  if (!normalizedPlatform || !normalizedArch) {
    return null;
  }

  const version = getArtifactEnv(normalizedChannel, normalizedPlatform, normalizedArch, 'VERSION');
  const fileUrl = getArtifactEnv(normalizedChannel, normalizedPlatform, normalizedArch, 'FILE_URL');
  const sha512 = getArtifactEnv(normalizedChannel, normalizedPlatform, normalizedArch, 'SHA512');
  const size = parseNumeric(getArtifactEnv(normalizedChannel, normalizedPlatform, normalizedArch, 'SIZE'), 0);
  const releaseDateRaw = getArtifactEnv(normalizedChannel, normalizedPlatform, normalizedArch, 'RELEASE_DATE');
  const releaseNotes = getArtifactEnv(normalizedChannel, normalizedPlatform, normalizedArch, 'RELEASE_NOTES');
  const fileNameEnv = getArtifactEnv(normalizedChannel, normalizedPlatform, normalizedArch, 'FILE_NAME');

  if (!version || !fileUrl || !sha512 || !size) {
    return null;
  }

  const releaseDate = releaseDateRaw || new Date().toISOString();
  const fileName = fileNameEnv || getFileNameFromUrl(fileUrl);
  if (!fileName) return null;

  return {
    channel: normalizedChannel,
    platform: normalizedPlatform,
    arch: normalizedArch,
    version,
    fileUrl,
    sha512,
    size,
    releaseDate,
    releaseNotes,
    fileName,
  };
}

function yamlEscape(value) {
  return String(value || '').replace(/"/g, '\\"');
}

function buildManifestYml({ version, releaseDate, sha512, size, fileUrl, releaseNotes = '' }) {
  const notes = cleanText(releaseNotes, 2000);
  const notesLine = notes ? `\nreleaseNotes: \"${yamlEscape(notes)}\"` : '';

  return [
    `version: ${version}`,
    `releaseDate: \"${releaseDate}\"`,
    'files:',
    `  - url: \"${fileUrl}\"`,
    `    sha512: \"${sha512}\"`,
    `    size: ${size}`,
    `path: \"${fileUrl}\"`,
    `sha512: \"${sha512}\"${notesLine}`,
    '',
  ].join('\n');
}

function setUpdaterCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Nexus-License-Key, X-Nexus-Hardware-Id, X-Nexus-App-Version'
  );
}

function extractUpdaterAuth(req) {
  const auth = String(req.headers.authorization || '').trim();
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const key = cleanText(req.headers['x-nexus-license-key'] || bearer, 120);
  const hardwareId = cleanText(req.headers['x-nexus-hardware-id'] || '', 160);
  const appVersion = cleanText(req.headers['x-nexus-app-version'] || '', 64);
  return { key, hardwareId, appVersion };
}

async function requireValidUpdaterLicense(req) {
  const { key, hardwareId, appVersion } = extractUpdaterAuth(req);

  if (!key || !hardwareId) {
    return {
      ok: false,
      status: 401,
      body: {
        valid: false,
        error: 'Missing updater credentials (license key and hardware ID required)',
      },
    };
  }

  const result = await validateLicenseRecord({
    key,
    hardwareId,
    appVersion,
    bindHardware: true,
  });

  if (result.status !== 200 || !result.body?.valid) {
    return {
      ok: false,
      status: result.status,
      body: result.body,
    };
  }

  return { ok: true, status: 200, body: result.body };
}

module.exports = {
  normalizeChannel,
  normalizePlatform,
  normalizeArch,
  getUpdateSecret,
  signToken,
  verifyToken,
  getRequestOrigin,
  getUpdateConfig,
  buildManifestYml,
  setUpdaterCors,
  requireValidUpdaterLicense,
  cleanText,
};
