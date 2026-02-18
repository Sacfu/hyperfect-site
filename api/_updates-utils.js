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

function getEnvUpdateConfig({ channel, platform, arch }) {
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
    source: 'env',
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

function getGitHubRepoConfig() {
  return {
    owner: cleanText(process.env.UPDATE_GH_OWNER || 'Sacfu', 100),
    repo: cleanText(process.env.UPDATE_GH_REPO || 'nexus', 100),
    token: cleanText(process.env.UPDATE_GH_TOKEN || process.env.GITHUB_RELEASE_TOKEN || '', 500),
  };
}

function getUpdatesSourceMode() {
  const mode = cleanText(process.env.UPDATE_SOURCE || 'auto', 16).toLowerCase();
  if (mode === 'env' || mode === 'github') return mode;
  return 'auto';
}

async function githubRequest(path, { token = '', accept = 'application/vnd.github+json', redirect = 'follow' } = {}) {
  const headers = {
    Accept: accept,
    'User-Agent': 'Hyperfect-Nexus-Updater',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`https://api.github.com${path}`, {
    method: 'GET',
    headers,
    redirect,
  });

  return response;
}

async function githubJson(path, { token = '' } = {}) {
  const response = await githubRequest(path, { token, accept: 'application/vnd.github+json' });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`GitHub API ${response.status}: ${detail.slice(0, 180)}`);
  }
  return response.json();
}

function pickReleaseForChannel(releases, channel) {
  const visible = (Array.isArray(releases) ? releases : []).filter((release) => release && !release.draft);
  if (visible.length === 0) return null;

  if (channel === 'beta') {
    return visible.find((release) => !!release.prerelease) || visible[0];
  }

  return visible.find((release) => !release.prerelease) || visible[0];
}

function firstAssetByNames(assets, candidateNames) {
  const byName = new Map((assets || []).map((asset) => [String(asset.name || '').toLowerCase(), asset]));
  for (const candidate of candidateNames) {
    const found = byName.get(String(candidate).toLowerCase());
    if (found) return found;
  }
  return null;
}

function pickManifestAsset(assets, { channel, platform, arch }) {
  const candidates = [];

  if (platform === 'mac') {
    if (arch === 'arm64') {
      candidates.push('latest-mac-arm64.yml', 'latest-mac-beta.yml', 'latest-mac.yml');
    } else {
      candidates.push('latest-mac.yml', 'latest-mac-x64.yml', 'latest-mac-beta.yml');
    }
  } else if (platform === 'win') {
    if (channel === 'beta') {
      candidates.push('latest-beta.yml');
    }
    candidates.push('latest.yml');
  } else if (platform === 'linux') {
    candidates.push('latest-linux.yml', `latest-linux-${arch}.yml`, 'latest.yml');
  }

  const direct = firstAssetByNames(assets, candidates);
  if (direct) return direct;

  const regex =
    platform === 'mac'
      ? /latest.*mac.*\.yml$/i
      : platform === 'linux'
        ? /latest.*linux.*\.yml$/i
        : /^latest(?!.*(mac|linux)).*\.yml$/i;

  return (assets || []).find((asset) => regex.test(String(asset.name || '')));
}

function parseManifestYml(ymlText) {
  const text = String(ymlText || '');
  if (!text) return null;

  const versionMatch = text.match(/^\s*version:\s*"?([^\n"]+)"?\s*$/m);
  const releaseDateMatch = text.match(/^\s*releaseDate:\s*"?([^\n"]+)"?\s*$/m);
  const pathMatch = text.match(/^\s*path:\s*"?([^\n"]+)"?\s*$/m);
  const notesMatch = text.match(/^\s*releaseNotes:\s*"?([^\n"]+)"?\s*$/m);

  const fileBlockMatch = text.match(/-\s*url:\s*"?([^\n"]+)"?\s*\n\s*sha512:\s*"?([^\n"]+)"?\s*\n\s*size:\s*(\d+)/m);
  const shaMatches = [...text.matchAll(/^\s*sha512:\s*"?([^\n"]+)"?\s*$/gm)];

  const version = cleanText(versionMatch?.[1] || '', 80);
  const releaseDate = cleanText(releaseDateMatch?.[1] || '', 80) || new Date().toISOString();
  const fileUrl = cleanText(fileBlockMatch?.[1] || pathMatch?.[1] || '', 400);
  const sha512 = cleanText(fileBlockMatch?.[2] || (shaMatches.length > 0 ? shaMatches[shaMatches.length - 1][1] : ''), 3000);
  const size = parseNumeric(fileBlockMatch?.[3] || '0', 0);
  const releaseNotes = cleanText(notesMatch?.[1] || '', 2000);
  const fileName = getFileNameFromUrl(fileUrl);

  if (!version || !fileUrl || !sha512 || !size || !fileName) {
    return null;
  }

  return {
    version,
    releaseDate,
    fileUrl,
    sha512,
    size,
    releaseNotes,
    fileName,
  };
}

function findAssetByName(assets, fileName) {
  const normalized = String(fileName || '').toLowerCase();
  if (!normalized) return null;

  const direct = (assets || []).find((asset) => String(asset.name || '').toLowerCase() === normalized);
  if (direct) return direct;

  const decoded = decodeURIComponent(normalized);
  return (assets || []).find((asset) => String(asset.name || '').toLowerCase() === decoded);
}

async function getGitHubUpdateConfig({ channel, platform, arch }) {
  const normalizedChannel = normalizeChannel(channel);
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedArch = normalizeArch(arch);

  if (!normalizedPlatform || !normalizedArch) {
    return null;
  }

  const gh = getGitHubRepoConfig();
  if (!gh.owner || !gh.repo) return null;

  try {
    const releases = await githubJson(`/repos/${gh.owner}/${gh.repo}/releases?per_page=20`, { token: gh.token });
    const release = pickReleaseForChannel(releases, normalizedChannel);
    if (!release) return null;

    const manifestAsset = pickManifestAsset(release.assets || [], {
      channel: normalizedChannel,
      platform: normalizedPlatform,
      arch: normalizedArch,
    });
    if (!manifestAsset || !manifestAsset.url) return null;

    const manifestResponse = await githubRequest(
      `/repos/${gh.owner}/${gh.repo}/releases/assets/${manifestAsset.id}`,
      {
        token: gh.token,
        accept: 'application/octet-stream',
      }
    );

    if (!manifestResponse.ok) {
      const detail = await manifestResponse.text().catch(() => '');
      throw new Error(`Manifest asset fetch failed (${manifestResponse.status}): ${detail.slice(0, 180)}`);
    }

    const manifestText = await manifestResponse.text();
    const parsed = parseManifestYml(manifestText);
    if (!parsed) return null;

    const binaryAsset = findAssetByName(release.assets || [], parsed.fileName);
    if (!binaryAsset) {
      throw new Error(`Release asset not found: ${parsed.fileName}`);
    }

    return {
      source: 'github',
      channel: normalizedChannel,
      platform: normalizedPlatform,
      arch: normalizedArch,
      version: parsed.version,
      releaseDate: parsed.releaseDate,
      releaseNotes: parsed.releaseNotes || cleanText(release.body || '', 2000),
      sha512: parsed.sha512,
      size: parsed.size,
      fileName: parsed.fileName,
      owner: gh.owner,
      repo: gh.repo,
      releaseTag: cleanText(release.tag_name || '', 120),
      binaryAssetId: binaryAsset.id,
      binaryAssetName: cleanText(binaryAsset.name || parsed.fileName, 200),
    };
  } catch (err) {
    console.error('GitHub updater config lookup failed:', err?.message || String(err));
    return null;
  }
}

async function getUpdateConfig({ channel, platform, arch }) {
  const mode = getUpdatesSourceMode();

  if (mode === 'env' || mode === 'auto') {
    const envConfig = getEnvUpdateConfig({ channel, platform, arch });
    if (envConfig) return envConfig;
    if (mode === 'env') return null;
  }

  return getGitHubUpdateConfig({ channel, platform, arch });
}

async function getGitHubAssetRedirect({ owner, repo, assetId }) {
  const gh = getGitHubRepoConfig();
  const resolvedOwner = cleanText(owner || gh.owner, 100);
  const resolvedRepo = cleanText(repo || gh.repo, 100);
  const resolvedAssetId = parseNumeric(assetId, 0);

  if (!resolvedOwner || !resolvedRepo || !resolvedAssetId) {
    throw new Error('Invalid GitHub asset lookup request');
  }

  const response = await githubRequest(
    `/repos/${resolvedOwner}/${resolvedRepo}/releases/assets/${resolvedAssetId}`,
    {
      token: gh.token,
      accept: 'application/octet-stream',
      redirect: 'manual',
    }
  );

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    if (!location) {
      throw new Error('GitHub asset redirect missing location header');
    }
    return { redirectUrl: location };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`GitHub asset fetch failed (${response.status}): ${detail.slice(0, 180)}`);
  }

  return { streamResponse: response };
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
  getGitHubAssetRedirect,
  buildManifestYml,
  setUpdaterCors,
  requireValidUpdaterLicense,
  cleanText,
};
