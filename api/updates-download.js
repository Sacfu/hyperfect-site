// Protected updater download endpoint.
// Route (via vercel rewrite):
//   /api/updates/download/:channel/:platform/:arch/:artifact
// Validates license + signed short-lived token then redirects to storage URL.

const {
  normalizeChannel,
  normalizePlatform,
  normalizeArch,
  getUpdateSecret,
  verifyToken,
  getUpdateConfig,
  getGitHubAssetRedirect,
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
    const artifact = cleanText(decodeURIComponent(req.query.artifact || ''), 200);
    const token = cleanText(req.query.t || '', 800);

    if (!platform || !arch || !artifact || !token) {
      return res.status(400).json({ error: 'Invalid download request' });
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
      const buffer = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const disposition = response.headers.get('content-disposition') || `attachment; filename=\"${artifact}\"`;

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', disposition);
      res.setHeader('Content-Length', String(buffer.length));
      return res.status(200).send(buffer);
    }

    const updateConfig = await getUpdateConfig({ channel, platform, arch });
    if (!updateConfig || updateConfig.fileName !== artifact || !updateConfig.fileUrl) {
      return res.status(404).json({ error: 'Update artifact not configured' });
    }

    return res.redirect(302, updateConfig.fileUrl);
  } catch (err) {
    console.error('updates-download error:', err?.message || String(err));
    return res.status(500).json({ error: 'Could not serve update download' });
  }
};
