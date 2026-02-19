// Vercel Serverless Function: Download + Updater Feed Gateway
//
// POST /api/download
//   Body: { accessToken, platform }
//   Existing Discord-gated website download flow.
//
// GET /api/download?mode=feed&channel=beta|stable&platform=mac|win|linux&arch=x64|arm64&manifest=latest*.yml
//   Protected updater manifest for licensed machine.
//
// GET /api/download?mode=file&channel=...&platform=...&arch=...&artifact=...&t=<signed_token>
//   Protected updater artifact redirect/stream.

const {
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
} = require('./_updates-utils');

function setDownloadCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Nexus-License-Key, X-Nexus-Hardware-Id, X-Nexus-App-Version'
  );
}

function selectManifestHint(value, arch) {
  const candidates = (Array.isArray(value) ? value : [value])
    .map((entry) => normalizeManifestName(entry))
    .filter(Boolean);

  if (candidates.length === 0) return '';

  const archMarker = arch === 'arm64' ? 'arm64' : (arch === 'x64' ? 'x64' : '');
  if (archMarker) {
    const archSpecific = candidates.find((name) => name.includes(archMarker));
    if (archSpecific) return archSpecific;
  }

  const preferredAliases = [
    'beta-mac.yml',
    'latest-mac.yml',
    'latest-mac-beta.yml',
    'beta.yml',
    'latest.yml',
  ];
  const aliasMatch = preferredAliases.find((alias) => candidates.includes(alias));
  if (aliasMatch) return aliasMatch;

  return candidates[candidates.length - 1];
}

function decodeArtifactParam(value) {
  const raw = String(value || '');
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return raw;
  }
}

async function handleUpdaterFeed(req, res) {
  setUpdaterCors(res);

  const auth = await requireValidUpdaterLicense(req);
  if (!auth.ok) {
    return res.status(auth.status).json(auth.body);
  }

  const channel = normalizeChannel(req.query.channel);
  const platform = normalizePlatform(req.query.platform);
  const arch = normalizeArch(req.query.arch);
  const manifest = selectManifestHint(req.query.manifest, arch);
  const debugRequested = cleanText(req.query.debug || '', 8) === '1';
  const debug = debugRequested ? {} : null;

  if (!platform || !arch) {
    return res.status(400).json({ error: 'Invalid updater platform/arch request' });
  }

  const updateConfig = await getUpdateConfig({
    channel,
    platform,
    arch,
    requestedManifest: manifest,
    debug,
  });
  if (!updateConfig) {
    if (debugRequested) {
      return res.status(404).json({
        error: `No update configured for ${channel}/${platform}/${arch}`,
        debug,
      });
    }
    return res.status(404).json({
      error: `No update configured for ${channel}/${platform}/${arch}`,
    });
  }

  if (debugRequested) {
    return res.status(200).json({
      update: {
        source: updateConfig.source || 'unknown',
        channel,
        platform,
        arch,
        version: updateConfig.version,
        releaseDate: updateConfig.releaseDate,
        fileName: updateConfig.fileName,
        releaseTag: updateConfig.releaseTag || null,
      },
      debug,
    });
  }

  const secret = getUpdateSecret();
  const origin = getRequestOrigin(req);
  // Keep token alive long enough for slow/retried updater downloads.
  const ttlMs = 2 * 60 * 60 * 1000;

  const tokenPayload = {
    source: updateConfig.source || 'env',
    channel,
    platform,
    arch,
    artifact: updateConfig.fileName,
    exp: Date.now() + ttlMs,
  };

  if (updateConfig.source === 'github') {
    tokenPayload.owner = updateConfig.owner;
    tokenPayload.repo = updateConfig.repo;
    tokenPayload.assetId = updateConfig.binaryAssetId;
    tokenPayload.assetName = updateConfig.binaryAssetName || updateConfig.fileName;
    tokenPayload.releaseTag = updateConfig.releaseTag || '';
  }

  const token = signToken(tokenPayload, secret);

  // Use a pathname that ends with the real artifact filename so electron-updater
  // derives a safe temp/cache file name from URL.pathname (instead of full query URL).
  const downloadUrl = `${origin}/api/update/${encodeURIComponent(updateConfig.fileName)}?channel=${encodeURIComponent(channel)}&platform=${encodeURIComponent(platform)}&arch=${encodeURIComponent(arch)}&t=${encodeURIComponent(token)}`;

  const manifestYml = buildManifestYml({
    version: updateConfig.version,
    releaseDate: updateConfig.releaseDate,
    sha512: updateConfig.sha512,
    size: updateConfig.size,
    fileUrl: downloadUrl,
    releaseNotes: updateConfig.releaseNotes,
  });

  res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method === 'HEAD') {
    return res.status(200).end();
  }
  return res.status(200).send(manifestYml);
}

async function handleUpdaterFile(req, res) {
  setUpdaterCors(res);

  const channel = normalizeChannel(req.query.channel);
  const platform = normalizePlatform(req.query.platform);
  const arch = normalizeArch(req.query.arch);
  const artifact = cleanText(decodeArtifactParam(req.query.artifact), 200);
  const token = cleanText(req.query.t || '', 800);
  const manifestHint = selectManifestHint(req.query?.manifest, arch);

  if (!platform || !arch || !artifact) {
    return res.status(400).json({ error: 'Invalid download request' });
  }

  // Fallback path for older/malformed updater URLs that do not preserve
  // signed token query params. We still require a valid licensed machine
  // via updater auth headers.
  if (!token) {
    const auth = await requireValidUpdaterLicense(req);
    if (!auth.ok) {
      return res.status(auth.status).json(auth.body);
    }

    const updateConfig = await getUpdateConfig({
      channel,
      platform,
      arch,
      requestedManifest: manifestHint,
    });
    if (!updateConfig || updateConfig.fileName !== artifact) {
      return res.status(404).json({ error: 'Update artifact not configured' });
    }

    if (updateConfig.source === 'github') {
      const redirectTarget = await getGitHubAssetRedirect({
        owner: updateConfig.owner,
        repo: updateConfig.repo,
        assetId: updateConfig.binaryAssetId,
      });

      if (redirectTarget.redirectUrl) {
        return res.redirect(302, redirectTarget.redirectUrl);
      }

      const response = redirectTarget.streamResponse;
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const disposition = response.headers.get('content-disposition') || `attachment; filename=\"${artifact}\"`;
      const contentLength = response.headers.get('content-length') || '';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', disposition);
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }
      if (req.method === 'HEAD') {
        return res.status(200).end();
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!contentLength) {
        res.setHeader('Content-Length', String(buffer.length));
      }
      return res.status(200).send(buffer);
    }

    if (!updateConfig.fileUrl) {
      return res.status(404).json({ error: 'Update artifact URL not configured' });
    }
    return res.redirect(302, updateConfig.fileUrl);
  }

  const secret = getUpdateSecret();
  const tokenPayload = verifyToken(token, secret);
  if (!tokenPayload) {
    return res.status(401).json({ error: 'Invalid or expired download token' });
  }

  if (
    tokenPayload.channel !== channel ||
    tokenPayload.platform !== platform ||
    tokenPayload.arch !== arch ||
    tokenPayload.artifact !== artifact
  ) {
    return res.status(401).json({ error: 'Download token scope mismatch' });
  }

  res.setHeader('Cache-Control', 'private, no-store');

  if (tokenPayload.source === 'github') {
    const assetId = Number.parseInt(String(tokenPayload.assetId || '0'), 10);
    if (!Number.isFinite(assetId) || assetId <= 0) {
      return res.status(400).json({ error: 'Invalid GitHub asset token payload' });
    }

    const redirectTarget = await getGitHubAssetRedirect({
      owner: tokenPayload.owner,
      repo: tokenPayload.repo,
      assetId,
    });

    if (redirectTarget.redirectUrl) {
      return res.redirect(302, redirectTarget.redirectUrl);
    }

    const response = redirectTarget.streamResponse;
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const disposition = response.headers.get('content-disposition') || `attachment; filename=\"${artifact}\"`;
    const contentLength = response.headers.get('content-length') || '';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', disposition);
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    if (req.method === 'HEAD') {
      return res.status(200).end();
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!contentLength) {
      res.setHeader('Content-Length', String(buffer.length));
    }
    return res.status(200).send(buffer);
  }

  const updateConfig = await getUpdateConfig({
    channel,
    platform,
    arch,
    requestedManifest: manifestHint,
  });
  if (!updateConfig || updateConfig.fileName !== artifact || !updateConfig.fileUrl) {
    return res.status(404).json({ error: 'Update artifact not configured' });
  }

  return res.redirect(302, updateConfig.fileUrl);
}

module.exports = async function handler(req, res) {
  setDownloadCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();

  const mode = cleanText(req.query?.mode || '', 16).toLowerCase();
  const artifactHint = cleanText(decodeArtifactParam(req.query?.artifact), 200);
  const manifestHint = selectManifestHint(req.query?.manifest, normalizeArch(req.query?.arch));
  const hasArtifactHint = artifactHint.length > 0;
  const hasTokenHint = String(req.query?.t || '').trim().length > 0;

  const shouldHandleFile = (req.method === 'GET' || req.method === 'HEAD') && (
    mode === 'file' ||
    hasArtifactHint ||
    hasTokenHint
  );
  const shouldHandleFeed = (req.method === 'GET' || req.method === 'HEAD') && (
    !shouldHandleFile && (
    mode === 'feed' ||
    (!!manifestHint && manifestHint.endsWith('.yml'))
    )
  );

  if (shouldHandleFeed) {
    try {
      return await handleUpdaterFeed(req, res);
    } catch (err) {
      console.error('Updater feed error:', err?.message || String(err));
      return res.status(500).json({ error: 'Could not generate updater feed' });
    }
  }

  if (shouldHandleFile) {
    try {
      return await handleUpdaterFile(req, res);
    } catch (err) {
      console.error('Updater download error:', err?.message || String(err));
      return res.status(500).json({ error: 'Could not serve updater download' });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { accessToken, platform } = req.body || {};

  if (!accessToken) {
    return res.status(401).json({ error: 'Discord access token required' });
  }

  const GUILD_ID = process.env.DISCORD_GUILD_ID;
  const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

  if (!GUILD_ID || !BOT_TOKEN) {
    console.error('Missing DISCORD_GUILD_ID or DISCORD_BOT_TOKEN');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    const userRes = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!userRes.ok) {
      return res.status(401).json({ error: 'Invalid Discord token' });
    }

    const user = await userRes.json();

    const memberRes = await fetch(
      `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${user.id}`,
      { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
    );

    if (memberRes.status === 404) {
      return res.status(403).json({
        error: 'not_member',
        message: 'You need to join our Discord server first to download Nexus.',
        invite: 'https://discord.gg/Ynvcw6Dts4',
      });
    }

    if (!memberRes.ok) {
      console.error('Discord API error:', memberRes.status, await memberRes.text());
      return res.status(500).json({ error: 'Could not verify Discord membership' });
    }

    const urls = {
      'mac-arm64': process.env.DOWNLOAD_URL_MAC_ARM64,
      'mac-x64': process.env.DOWNLOAD_URL_MAC_X64,
      win: process.env.DOWNLOAD_URL_WIN,
      linux: process.env.DOWNLOAD_URL_LINUX,
    };

    const downloadUrl = urls[platform] || urls['mac-arm64'];

    if (!downloadUrl) {
      return res.status(500).json({ error: 'Download URL not configured for this platform' });
    }

    return res.status(200).json({
      downloadUrl,
      user: { id: user.id, username: user.username },
    });
  } catch (err) {
    console.error('Download gate error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
