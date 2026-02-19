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

function normalizeManifestName(value) {
  const raw = cleanText(value || '', 200).toLowerCase();
  if (!raw) return '';
  const base = raw.split('/').filter(Boolean).pop() || raw;
  return base.endsWith('.yml') ? base : '';
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

function getEnvUpdateConfig({ channel, platform, arch, debug = null }) {
  const normalizedChannel = normalizeChannel(channel);
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedArch = normalizeArch(arch);

  if (!normalizedPlatform || !normalizedArch) {
    if (debug) debug.env = { matched: false, reason: 'invalid-platform-or-arch' };
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
    if (debug) {
      debug.env = {
        matched: false,
        reason: 'missing-required-env-metadata',
        hasVersion: !!version,
        hasFileUrl: !!fileUrl,
        hasSha512: !!sha512,
        hasSize: !!size,
      };
    }
    return null;
  }

  const releaseDate = releaseDateRaw || new Date().toISOString();
  const fileName = fileNameEnv || getFileNameFromUrl(fileUrl);
  if (!fileName) {
    if (debug) debug.env = { matched: false, reason: 'missing-file-name' };
    return null;
  }

  const config = {
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

  if (debug) {
    debug.env = {
      matched: true,
      source: 'env',
      version: config.version,
      fileName: config.fileName,
    };
  }

  return config;
}

function getGitHubRepoConfig() {
  return {
    owner: cleanText(process.env.UPDATE_GH_OWNER || 'Sacfu', 100),
    repo: cleanText(process.env.UPDATE_GH_REPO || 'nexus', 100),
    token: cleanText(process.env.UPDATE_GH_TOKEN || process.env.GITHUB_RELEASE_TOKEN || '', 500),
  };
}

function getUpdatesSourceMode() {
  const mode = cleanText(process.env.UPDATE_SOURCE || 'github', 16).toLowerCase();
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

function listReleasesForChannel(releases, channel) {
  const visible = (Array.isArray(releases) ? releases : []).filter((release) => release && !release.draft);
  if (visible.length === 0) return [];

  const preferred = [];
  const fallback = [];
  for (const release of visible) {
    if (channel === 'beta') {
      if (release.prerelease) preferred.push(release);
      else fallback.push(release);
    } else if (!release.prerelease) {
      preferred.push(release);
    } else {
      fallback.push(release);
    }
  }

  return preferred.concat(fallback);
}

function firstAssetByNames(assets, candidateNames) {
  const byName = new Map((assets || []).map((asset) => [String(asset.name || '').toLowerCase(), asset]));
  for (const candidate of candidateNames) {
    const found = byName.get(String(candidate).toLowerCase());
    if (found) return found;
  }
  return null;
}

function listManifestAssets(assets, { channel, platform, arch, requestedManifest = '' }) {
  const source = Array.isArray(assets) ? assets : [];
  const manifests = source.filter((asset) => /\.yml$/i.test(String(asset?.name || '')));
  const ordered = [];
  const seen = new Set();
  const requested = normalizeManifestName(requestedManifest);

  function pushAsset(asset) {
    if (!asset) return;
    const id = String(asset.id || '') || String(asset.name || '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    ordered.push(asset);
  }

  function pushByNames(names) {
    for (const name of names) {
      pushAsset(firstAssetByNames(manifests, [name]));
    }
  }

  function pushByRegex(regex) {
    for (const asset of manifests) {
      const name = String(asset.name || '');
      if (regex.test(name)) {
        pushAsset(asset);
      }
    }
  }

  function pushRequestedAliases() {
    if (!requested) return false;

    const aliases = [requested];
    if (platform === 'mac') {
      if (requested === 'beta-mac.yml') {
        if (arch === 'arm64') aliases.push('beta-mac-arm64.yml', 'latest-mac-arm64.yml', 'latest-mac.yml');
        else aliases.push('beta-mac-x64.yml', 'latest-mac-x64.yml', 'latest-mac.yml');
      } else if (requested === 'latest-mac.yml') {
        if (arch === 'arm64') aliases.push('latest-mac-arm64.yml', 'beta-mac-arm64.yml', 'beta-mac.yml');
        else aliases.push('latest-mac-x64.yml', 'beta-mac-x64.yml', 'beta-mac.yml');
      } else if (requested === 'latest-mac-beta.yml') {
        if (arch === 'arm64') aliases.push('latest-mac-arm64-beta.yml', 'beta-mac-arm64.yml', 'beta-mac.yml');
        else aliases.push('latest-mac-x64-beta.yml', 'beta-mac-x64.yml', 'beta-mac.yml');
      }
    } else if (platform === 'linux') {
      if (requested === 'latest-linux.yml') aliases.push(`latest-linux-${arch}.yml`, `beta-linux-${arch}.yml`);
      if (requested === 'beta-linux.yml') aliases.push(`beta-linux-${arch}.yml`, `latest-linux-${arch}.yml`);
    } else if (platform === 'win') {
      if (requested === 'beta.yml') aliases.push('latest.yml');
      if (requested === 'latest.yml' && channel === 'beta') aliases.push('beta.yml');
    }

    for (const name of aliases) {
      pushAsset(firstAssetByNames(manifests, [name]));
    }

    return ordered.length > 0;
  }

  // If a specific manifest is requested (e.g. beta-mac.yml), pin to that mapping.
  // This prevents cross-arch or fallback manifest drift that can cause checksum mismatches.
  if (requested) {
    pushRequestedAliases();
    return ordered;
  }

  if (platform === 'mac') {
    if (arch === 'arm64') {
      pushByNames([
        'beta-mac-arm64.yml',
        'beta-mac.yml',
        'latest-mac-arm64.yml',
        'latest-mac-arm64-beta.yml',
        'latest-mac-beta-arm64.yml',
        'latest-mac-universal.yml',
        'latest-mac-universal-beta.yml',
      ]);
      pushByRegex(/(beta|latest).*mac.*(arm64|universal).*\.yml$/i);
    } else {
      pushByNames(['beta-mac-x64.yml', 'beta-mac.yml', 'latest-mac-x64.yml', 'latest-mac.yml', 'latest-mac-beta.yml']);
      pushByRegex(/(beta|latest).*mac.*x64.*\.yml$/i);
    }
    pushByNames(['beta-mac.yml', 'latest-mac-beta.yml', 'latest-mac.yml']);
    pushByRegex(/(beta|latest).*mac.*\.yml$/i);
  } else if (platform === 'linux') {
    pushByNames([`beta-linux-${arch}.yml`, 'beta-linux.yml', `latest-linux-${arch}.yml`, 'latest-linux.yml', 'latest.yml']);
    pushByRegex(/(beta|latest).*linux.*\.yml$/i);
  } else {
    // windows
    if (channel === 'beta') pushByNames(['beta.yml', 'latest-beta.yml']);
    pushByNames(['latest.yml']);
    pushByRegex(/^(beta|latest)(?!.*(mac|linux)).*\.yml$/i);
  }

  // Last-resort fallback for any remaining manifest assets.
  for (const asset of manifests) {
    pushAsset(asset);
  }

  return ordered;
}

function isArtifactCompatible(fileName, platform, arch) {
  const name = String(fileName || '').toLowerCase();
  if (!name) return false;

  const isMacLike = name.includes('mac') || name.includes('darwin') || name.endsWith('.dmg');
  const isLinuxLike = name.includes('linux') || name.endsWith('.appimage') || name.endsWith('.deb');
  const isWinLike = name.includes('win') || name.includes('windows') || name.endsWith('.exe') || name.includes('nsis');

  if (platform === 'mac' && !isMacLike) return false;
  if (platform === 'linux' && !isLinuxLike) return false;
  if (platform === 'win') {
    if (!isWinLike) return false;
    if (isMacLike || isLinuxLike) return false;
  }

  const hasArm = name.includes('arm64') || name.includes('aarch64');
  const hasX64 = name.includes('x64') || name.includes('amd64');
  const hasUniversal = name.includes('universal');

  if (arch === 'arm64') {
    if (hasX64 && !hasUniversal) return false;
    return true;
  }

  if (arch === 'x64') {
    if (hasArm && !hasUniversal) return false;
    return true;
  }

  return true;
}

function parseLooseSemver(version) {
  const raw = cleanText(version || '', 80);
  if (!raw) return null;

  const [core, prerelease = ''] = raw.split('-', 2);
  const segments = core
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isFinite(value));

  if (segments.length === 0) return null;
  while (segments.length < 3) segments.push(0);

  return { raw, core: segments.slice(0, 3), prerelease };
}

function compareLooseSemver(a, b) {
  const pa = parseLooseSemver(a);
  const pb = parseLooseSemver(b);

  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;

  for (let idx = 0; idx < 3; idx += 1) {
    if (pa.core[idx] > pb.core[idx]) return 1;
    if (pa.core[idx] < pb.core[idx]) return -1;
  }

  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (pa.prerelease && pb.prerelease) {
    return pa.prerelease.localeCompare(pb.prerelease);
  }

  return 0;
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
  const releaseDateRaw = cleanText(releaseDateMatch?.[1] || '', 80);
  const releaseDate = releaseDateRaw.replace(/^['"]+|['"]+$/g, '') || new Date().toISOString();
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

async function getGitHubUpdateConfig({ channel, platform, arch, requestedManifest = '', debug = null }) {
  const normalizedChannel = normalizeChannel(channel);
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedArch = normalizeArch(arch);
  const normalizedManifest = normalizeManifestName(requestedManifest);

  if (!normalizedPlatform || !normalizedArch) {
    return null;
  }

  const gh = getGitHubRepoConfig();
  if (!gh.owner || !gh.repo) return null;

  try {
    const releases = await githubJson(`/repos/${gh.owner}/${gh.repo}/releases?per_page=50`, { token: gh.token });
    const releaseCandidates = listReleasesForChannel(releases, normalizedChannel);
    if (releaseCandidates.length === 0) return null;

    if (debug) {
      debug.github = {
        owner: gh.owner,
        repo: gh.repo,
        tokenConfigured: !!gh.token,
        releasesFetched: Array.isArray(releases) ? releases.length : 0,
        channelCandidates: releaseCandidates.length,
        candidates: [],
      };
    }

    let bestConfig = null;
    for (const release of releaseCandidates) {
      const releaseDebug = debug ? {
        tag: cleanText(release.tag_name || '', 120),
        prerelease: !!release.prerelease,
        draft: !!release.draft,
        publishedAt: cleanText(release.published_at || '', 80),
        manifestAssets: 0,
        manifestMatches: [],
      } : null;

      const candidates = listManifestAssets(release.assets || [], {
        channel: normalizedChannel,
        platform: normalizedPlatform,
        arch: normalizedArch,
        requestedManifest: normalizedManifest,
      });
      if (releaseDebug) {
        releaseDebug.manifestAssets = candidates.length;
      }
      if (candidates.length === 0) continue;

      for (const manifestAsset of candidates) {
        const manifestResponse = await githubRequest(
          `/repos/${gh.owner}/${gh.repo}/releases/assets/${manifestAsset.id}`,
          {
            token: gh.token,
            accept: 'application/octet-stream',
          }
        );

        if (!manifestResponse.ok) {
          const detail = await manifestResponse.text().catch(() => '');
          console.error(`Manifest asset fetch failed (${manifestResponse.status}): ${detail.slice(0, 180)}`);
          if (releaseDebug) {
            releaseDebug.manifestMatches.push({
              manifest: cleanText(manifestAsset.name || '', 160),
              ok: false,
              reason: `manifest-fetch-${manifestResponse.status}`,
            });
          }
          continue;
        }

        const manifestText = await manifestResponse.text();
        const parsed = parseManifestYml(manifestText);
        if (!parsed) {
          if (releaseDebug) {
            releaseDebug.manifestMatches.push({
              manifest: cleanText(manifestAsset.name || '', 160),
              ok: false,
              reason: 'manifest-parse-failed',
            });
          }
          continue;
        }
        if (!isArtifactCompatible(parsed.fileName, normalizedPlatform, normalizedArch)) {
          if (releaseDebug) {
            releaseDebug.manifestMatches.push({
              manifest: cleanText(manifestAsset.name || '', 160),
              ok: false,
              reason: 'artifact-incompatible',
              fileName: parsed.fileName,
              version: parsed.version,
            });
          }
          continue;
        }

        const binaryAsset = findAssetByName(release.assets || [], parsed.fileName);
        if (!binaryAsset) {
          if (releaseDebug) {
            releaseDebug.manifestMatches.push({
              manifest: cleanText(manifestAsset.name || '', 160),
              ok: false,
              reason: 'binary-asset-not-found',
              fileName: parsed.fileName,
              version: parsed.version,
            });
          }
          continue;
        }

        const candidateConfig = {
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

        if (releaseDebug) {
          releaseDebug.manifestMatches.push({
            manifest: cleanText(manifestAsset.name || '', 160),
            ok: true,
            version: candidateConfig.version,
            fileName: candidateConfig.fileName,
          });
        }

        if (!bestConfig) {
          bestConfig = candidateConfig;
          continue;
        }

        const cmp = compareLooseSemver(candidateConfig.version, bestConfig.version);
        if (cmp > 0) {
          bestConfig = candidateConfig;
          continue;
        }
        if (cmp < 0) {
          continue;
        }

        // Same parsed version: prefer the most recently published release.
        const candidatePublishedAt = Date.parse(String(release.published_at || ''));
        const bestPublishedAt = Date.parse(String(bestConfig.releaseDate || ''));
        if (Number.isFinite(candidatePublishedAt) && Number.isFinite(bestPublishedAt) && candidatePublishedAt > bestPublishedAt) {
          bestConfig = candidateConfig;
        }
      }

      if (debug && releaseDebug) {
        debug.github.candidates.push(releaseDebug);
      }
    }

    if (debug) {
      debug.github.selected = bestConfig
        ? {
            version: bestConfig.version,
            releaseTag: bestConfig.releaseTag,
            fileName: bestConfig.fileName,
          }
        : null;
    }
    return bestConfig;
  } catch (err) {
    console.error('GitHub updater config lookup failed:', err?.message || String(err));
    if (debug) {
      debug.github = {
        ...(debug.github || {}),
        error: err?.message || String(err),
      };
    }
    return null;
  }
}

async function getUpdateConfig({ channel, platform, arch, requestedManifest = '', debug = null }) {
  const normalizedManifest = normalizeManifestName(requestedManifest);
  const mode = getUpdatesSourceMode();
  if (debug) {
    debug.mode = mode;
    debug.request = {
      channel: normalizeChannel(channel),
      platform: normalizePlatform(platform),
      arch: normalizeArch(arch),
      requestedManifest: normalizedManifest || null,
    };
  }

  if (mode === 'env') {
    const envConfig = getEnvUpdateConfig({ channel, platform, arch, debug });
    if (envConfig) return envConfig;
    return null;
  }

  if (mode === 'github' || mode === 'auto') {
    const githubConfig = await getGitHubUpdateConfig({
      channel,
      platform,
      arch,
      requestedManifest: normalizedManifest,
      debug,
    });
    if (githubConfig) return githubConfig;
    if (mode === 'github') return null;
  }

  // Auto-mode fallback when GitHub metadata is unavailable.
  return getEnvUpdateConfig({ channel, platform, arch, debug });
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
  normalizeManifestName,
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
