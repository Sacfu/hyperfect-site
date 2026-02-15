// Vercel Serverless Function: Create Reusable Stripe Payment Links
// These are shareable URLs you can send to anyone — they don't expire.
//
// Usage: POST /api/create-payment-link
// Headers: Authorization: Bearer <ADMIN_SECRET> (set as env var)
// Body: { "priceId": "price_xxx", "trialDays": 7, "coupon": "LAUNCH20" }
//
// Environment Variables:
//   STRIPE_SECRET_KEY — your Stripe secret key
//   ADMIN_SECRET — a secret you choose to protect this endpoint (any random string)

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // Simple auth check — so random people can't create links
    const auth = req.headers.authorization?.replace('Bearer ', '');
    if (auth !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const { priceId, trialDays, coupon, label } = req.body;

        if (!priceId) {
            return res.status(400).json({ error: 'priceId is required' });
        }

        const linkParams = {
            line_items: [{ price: priceId, quantity: 1 }],
            allow_promotion_codes: true,
            after_completion: {
                type: 'redirect',
                redirect: {
                    url: 'https://hyperfect.dev?checkout=success',
                },
            },
        };

        // Add trial if specified (requires subscription price)
        if (trialDays) {
            linkParams.subscription_data = {
                trial_period_days: parseInt(trialDays),
            };
        }

        // Apply coupon
        if (coupon) {
            linkParams.discounts = [{ coupon }];
            delete linkParams.allow_promotion_codes;
        }

        // Custom label for your reference
        if (label) {
            linkParams.metadata = { label };
        }

        const paymentLink = await stripe.paymentLinks.create(linkParams);

        return res.status(200).json({
            url: paymentLink.url,
            id: paymentLink.id,
            label: label || null,
        });
    } catch (err) {
        console.error('Payment link error:', err.message);
        return res.status(500).json({ error: err.message });
    }
};
