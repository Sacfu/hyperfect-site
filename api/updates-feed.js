// Protected generic updater manifest endpoint.
// Route (via vercel rewrite):
//   /api/updates/feed/:channel/:platform/:arch/:manifest
// Returns latest*.yml only for valid licensed machines.

const {
  normalizeChannel,
  normalizePlatform,
  normalizeArch,
  getUpdateSecret,
  signToken,
  getRequestOrigin,
  getUpdateConfig,
  buildManifestYml,
  setUpdaterCors,
  requireValidUpdaterLicense,
  cleanText,
} = require('./_updates-utils');

module.exports = async function handler(req, res) {
  setUpdaterCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const auth = await requireValidUpdaterLicense(req);
    if (!auth.ok) {
      return res.status(auth.status).json(auth.body);
    }

    const channel = normalizeChannel(req.query.channel);
    const platform = normalizePlatform(req.query.platform);
    const arch = normalizeArch(req.query.arch);
    const manifest = cleanText(req.query.manifest || '', 64).toLowerCase();

    if (!platform || !arch) {
      return res.status(400).json({ error: 'Invalid updater platform/arch request' });
    }

    if (manifest && !manifest.endsWith('.yml')) {
      return res.status(404).json({ error: 'Manifest not found' });
    }

    const updateConfig = getUpdateConfig({ channel, platform, arch });
    if (!updateConfig) {
      return res.status(404).json({
        error: `No update configured for ${channel}/${platform}/${arch}`,
      });
    }

    const secret = getUpdateSecret();
    const origin = getRequestOrigin(req);
    const ttlMs = 10 * 60 * 1000;
    const token = signToken(
      {
        channel,
        platform,
        arch,
        artifact: updateConfig.fileName,
        exp: Date.now() + ttlMs,
      },
      secret
    );

    const downloadUrl = `${origin}/api/updates/download/${channel}/${platform}/${arch}/${encodeURIComponent(updateConfig.fileName)}?t=${encodeURIComponent(token)}`;

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
    return res.status(200).send(manifestYml);
  } catch (err) {
    console.error('updates-feed error:', err?.message || String(err));
    return res.status(500).json({ error: 'Could not generate update feed' });
  }
};
