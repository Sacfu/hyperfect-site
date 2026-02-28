// Vercel Serverless Function: License key validation (legacy endpoint)
// POST /api/validate-license
//
// Body:
//   {
//     "licenseKey": "NEXUS-....",
//     "hardware_id": "optional-machine-id",
//     "app_version": "1.0.0"
//   }
//
// This endpoint remains compatible with existing app and web flows.

const { validateLicenseRecord, cleanText } = require('./_license-utils');

// ──── Rate limiting for license validation (anti brute-force) ────
const _licenseRateMap = new Map();
const LICENSE_RATE_WINDOW_MS = 60_000; // 1 minute
const LICENSE_RATE_MAX = 10;           // 10 validation attempts per IP per minute

function isLicenseRateLimited(ip) {
    const now = Date.now();
    const key = String(ip || 'unknown');
    const entry = _licenseRateMap.get(key);
    if (!entry || (now - entry.windowStart) > LICENSE_RATE_WINDOW_MS) {
        _licenseRateMap.set(key, { windowStart: now, count: 1 });
        if (_licenseRateMap.size > 5000) {
            for (const [k, v] of _licenseRateMap) {
                if ((now - v.windowStart) > LICENSE_RATE_WINDOW_MS) _licenseRateMap.delete(k);
            }
        }
        return false;
    }
    entry.count += 1;
    return entry.count > LICENSE_RATE_MAX;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ valid: false, error: 'Method not allowed' });
  }

  // Rate limit check
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.headers['x-real-ip']
      || req.socket?.remoteAddress
      || 'unknown';
  if (isLicenseRateLimited(clientIP)) {
    return res.status(429).json({ valid: false, error: 'Too many validation attempts. Please try again later.' });
  }

  try {
    const body = req.body || {};
    const licenseKey = cleanText(body.licenseKey || body.key || '', 80);
    const hardwareId = cleanText(body.hardware_id || body.hardwareId || '', 160);
    const appVersion = cleanText(body.app_version || body.appVersion || '', 64);

    const result = await validateLicenseRecord({
      key: licenseKey,
      hardwareId,
      appVersion,
      bindHardware: !!hardwareId,
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('License validation error:', err?.message || String(err));
    return res.status(500).json({ valid: false, error: 'Server error during validation' });
  }
};
