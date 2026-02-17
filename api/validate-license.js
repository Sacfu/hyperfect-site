// Vercel Serverless Function: License Key Validation
// Called by the Nexus desktop app to verify a license key is valid.
//
// POST /api/validate-license
// Body: { "licenseKey": "NEXUS-XXXX-XXXX-XXXX-XXXX" }
//
// Returns:
//   200 { valid: true, plan: "lifetime"|"subscription", email: "..." }
//   400 { valid: false, error: "Invalid license key format" }
//   404 { valid: false, error: "License key not found" }
//
// Environment Variables:
//   STRIPE_SECRET_KEY — your Stripe secret key

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const LICENSE_PATTERN = /^NEXUS-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/;

module.exports = async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ valid: false, error: 'Method not allowed' });
    }

    const { licenseKey } = req.body || {};

    if (!licenseKey || typeof licenseKey !== 'string') {
        return res.status(400).json({ valid: false, error: 'License key is required' });
    }

    const trimmedKey = licenseKey.trim().toUpperCase();

    if (!LICENSE_PATTERN.test(trimmedKey)) {
        return res.status(400).json({ valid: false, error: 'Invalid license key format' });
    }

    try {
        // Search Stripe customers for one whose metadata.license_key matches
        // Stripe doesn't support filtering by metadata directly, so we search
        // through customers. For scale, you'd want a database — but for early
        // beta with <1000 customers, this works fine.
        let found = null;
        let hasMore = true;
        let startingAfter = undefined;

        while (hasMore && !found) {
            const params = { limit: 100 };
            if (startingAfter) params.starting_after = startingAfter;

            const customers = await stripe.customers.list(params);

            for (const customer of customers.data) {
                if (customer.metadata?.license_key === trimmedKey) {
                    found = customer;
                    break;
                }
            }

            hasMore = customers.has_more;
            if (customers.data.length > 0) {
                startingAfter = customers.data[customers.data.length - 1].id;
            }
        }

        if (!found) {
            return res.status(404).json({ valid: false, error: 'License key not found' });
        }

        // Check if the license has been revoked
        if (found.metadata?.license_revoked === 'true') {
            return res.status(403).json({ valid: false, error: 'License has been revoked' });
        }

        // For subscriptions, check if the subscription is still active
        const plan = found.metadata?.plan || 'lifetime';
        if (plan === 'subscription') {
            const subscriptions = await stripe.subscriptions.list({
                customer: found.id,
                status: 'active',
                limit: 1,
            });

            if (subscriptions.data.length === 0) {
                // Check for past_due too (grace period)
                const pastDue = await stripe.subscriptions.list({
                    customer: found.id,
                    status: 'past_due',
                    limit: 1,
                });

                if (pastDue.data.length === 0) {
                    return res.status(403).json({
                        valid: false,
                        error: 'Subscription is no longer active',
                    });
                }
            }
        }

        return res.status(200).json({
            valid: true,
            plan: plan,
            email: found.email || '',
            activated: found.metadata?.license_created || '',
        });
    } catch (err) {
        console.error('License validation error:', err.message);
        return res.status(500).json({ valid: false, error: 'Server error during validation' });
    }
};
