// Vercel Serverless Function: Canonical app license validation endpoint
// POST /api/keys/validate
//
// Body:
//   {
//     "key": "NEXUS-....",
//     "hardware_id": "machine fingerprint",
//     "app_version": "1.0.0"
//   }

const { validateLicenseRecord, cleanText } = require('../_license-utils');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ valid: false, error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const key = cleanText(body.key || body.licenseKey || '', 80);
    const hardwareId = cleanText(body.hardware_id || body.hardwareId || '', 160);
    const appVersion = cleanText(body.app_version || body.appVersion || '', 64);

    const result = await validateLicenseRecord({
      key,
      hardwareId,
      appVersion,
      bindHardware: true,
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Key validation error:', err?.message || String(err));
    return res.status(500).json({ valid: false, error: 'Server error during validation' });
  }
};
