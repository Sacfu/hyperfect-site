const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const LICENSE_PATTERN = /^NEXUS-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/;
const MACHINE_RESET_URL = 'https://www.hyperfect.dev/license-dashboard';
const ACTIVE_SUB_STATUSES = new Set(['active', 'trialing', 'past_due']);

function cleanText(value, maxLen = 256) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function normalizeEmail(value) {
  return cleanText(value, 320).toLowerCase();
}

function normalizeLicenseKey(value) {
  return cleanText(value, 64).toUpperCase();
}

function normalizeHardwareId(value) {
  return cleanText(value, 128).toLowerCase();
}

function maskHardwareId(value) {
  const hardwareId = normalizeHardwareId(value);
  if (!hardwareId) return '';
  if (hardwareId.length <= 10) return hardwareId;
  return `${hardwareId.slice(0, 6)}...${hardwareId.slice(-4)}`;
}

function mapPlanToTier(plan) {
  const normalized = cleanText(plan, 32).toLowerCase();
  if (normalized === 'subscription') return 'pro';
  if (normalized === 'basic' || normalized === 'pro' || normalized === 'unlimited') {
    return normalized;
  }
  return 'unlimited';
}

async function listCustomersPaged(eachCustomer) {
  let hasMore = true;
  let startingAfter = undefined;

  while (hasMore) {
    const params = { limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;

    const customers = await stripe.customers.list(params);
    for (const customer of customers.data || []) {
      const shouldStop = await eachCustomer(customer);
      if (shouldStop) return;
    }

    hasMore = !!customers.has_more;
    if (customers.data && customers.data.length > 0) {
      startingAfter = customers.data[customers.data.length - 1].id;
    } else {
      hasMore = false;
    }
  }
}

async function findCustomerByLicenseKey(rawKey) {
  const key = normalizeLicenseKey(rawKey);
  if (!key || !LICENSE_PATTERN.test(key)) return null;

  let found = null;
  await listCustomersPaged(async (customer) => {
    if ((customer?.metadata || {}).license_key === key) {
      found = customer;
      return true;
    }
    return false;
  });
  return found;
}

async function findCustomerByEmail(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email) return null;

  const result = await stripe.customers.list({ email, limit: 20 });
  for (const customer of result.data || []) {
    if (normalizeEmail(customer.email) === email) {
      return customer;
    }
  }
  return null;
}

async function findCustomerByDiscordUserId(rawDiscordUserId) {
  const discordUserId = cleanText(rawDiscordUserId, 64);
  if (!discordUserId) return null;

  let found = null;
  await listCustomersPaged(async (customer) => {
    const metadata = customer?.metadata || {};
    const linkedId = cleanText(metadata.license_discord_user_id || metadata.discord_user_id || '', 64);
    if (linkedId && linkedId === discordUserId) {
      found = customer;
      return true;
    }
    return false;
  });
  return found;
}

async function hasActiveSubscription(customerId) {
  if (!customerId) return false;
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 20,
  });
  return (subscriptions.data || []).some((sub) => ACTIVE_SUB_STATUSES.has(String(sub.status || '').toLowerCase()));
}

function getLicenseSummary(customer) {
  const metadata = customer?.metadata || {};
  const plan = metadata.plan || 'lifetime';
  const tier = mapPlanToTier(plan);
  const hardwareId = metadata.license_hardware_id || '';

  return {
    customer_id: customer?.id || '',
    email: customer?.email || '',
    license_key: metadata.license_key || '',
    license_key_masked: metadata.license_key
      ? `${metadata.license_key.slice(0, 11)}-****-${metadata.license_key.slice(-4)}`
      : '',
    license_created: metadata.license_created || '',
    plan,
    tier,
    license_revoked: metadata.license_revoked === 'true',
    machine_locked: !!hardwareId,
    hardware_id_masked: maskHardwareId(hardwareId),
    hardware_bound_at: metadata.license_hardware_bound_at || '',
    last_validation_at: metadata.license_last_validation_at || '',
    last_app_version: metadata.license_last_app_version || '',
    reset_count: parseInt(metadata.license_reset_count || '0', 10) || 0,
    last_reset_at: metadata.license_last_reset_at || '',
  };
}

async function validateLicenseRecord({
  key,
  hardwareId = '',
  appVersion = '',
  bindHardware = true,
}) {
  const normalizedKey = normalizeLicenseKey(key);
  const normalizedHardware = normalizeHardwareId(hardwareId);
  const normalizedVersion = cleanText(appVersion, 64);

  if (!normalizedKey || !LICENSE_PATTERN.test(normalizedKey)) {
    return {
      status: 400,
      body: { valid: false, error: 'Invalid license key format' },
    };
  }

  if (bindHardware && !normalizedHardware) {
    return {
      status: 400,
      body: { valid: false, error: 'Hardware ID is required for activation' },
    };
  }

  const customer = await findCustomerByLicenseKey(normalizedKey);
  if (!customer) {
    return {
      status: 404,
      body: { valid: false, error: 'License key not found' },
    };
  }

  const metadata = customer.metadata || {};
  if (metadata.license_revoked === 'true') {
    return {
      status: 403,
      body: { valid: false, error: 'License has been revoked' },
    };
  }

  const plan = metadata.plan || 'lifetime';
  if (String(plan).toLowerCase() === 'subscription') {
    const active = await hasActiveSubscription(customer.id);
    if (!active) {
      return {
        status: 403,
        body: { valid: false, error: 'Subscription is no longer active' },
      };
    }
  }

  const existingHardwareId = normalizeHardwareId(metadata.license_hardware_id || '');
  const nowIso = new Date().toISOString();
  let effectiveHardware = existingHardwareId;

  if (bindHardware && normalizedHardware) {
    if (existingHardwareId && existingHardwareId !== normalizedHardware) {
      return {
        status: 409,
        body: {
          valid: false,
          code: 'machine_mismatch',
          error: 'License is already active on another machine. Reset machine activation from your license dashboard to move computers.',
          manage_url: MACHINE_RESET_URL,
          machine_locked: true,
          hardware_id_masked: maskHardwareId(existingHardwareId),
        },
      };
    }

    const updatedMetadata = {
      ...metadata,
      license_last_validation_at: nowIso,
      license_last_app_version: normalizedVersion || metadata.license_last_app_version || '',
    };

    if (!existingHardwareId) {
      updatedMetadata.license_hardware_id = normalizedHardware;
      updatedMetadata.license_hardware_bound_at = nowIso;
      effectiveHardware = normalizedHardware;
    }

    await stripe.customers.update(customer.id, { metadata: updatedMetadata });
  }

  const tier = mapPlanToTier(plan);
  return {
    status: 200,
    body: {
      valid: true,
      plan,
      tier,
      email: customer.email || '',
      activated: metadata.license_created || '',
      expires_at: tier === 'unlimited' ? null : '',
      machine_locked: !!(effectiveHardware || existingHardwareId),
      hardware_id_masked: maskHardwareId(effectiveHardware || existingHardwareId),
      manage_url: MACHINE_RESET_URL,
    },
    customer_id: customer.id,
  };
}

module.exports = {
  stripe,
  LICENSE_PATTERN,
  MACHINE_RESET_URL,
  cleanText,
  normalizeEmail,
  normalizeLicenseKey,
  normalizeHardwareId,
  findCustomerByLicenseKey,
  findCustomerByEmail,
  findCustomerByDiscordUserId,
  getLicenseSummary,
  validateLicenseRecord,
};
