// Vercel Serverless Function: Create Stripe Checkout Session
// Supports: one-time payments, subscriptions, free trials, discount codes
//
// Usage: POST /api/create-checkout
// Body: { "priceId": "price_xxx", "mode": "subscription"|"payment", "trialDays": 7, "coupon": "LAUNCH20" }
//
// Environment Variables (set in Vercel Dashboard > Settings > Environment Variables):
//   STRIPE_SECRET_KEY  — your Stripe secret key (sk_live_...)
//   STRIPE_WEBHOOK_SECRET — webhook signing secret (whsec_...)
//   SITE_URL — https://hyperfect.dev

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { priceId, mode = 'subscription', trialDays, coupon, customerEmail } = req.body;

        if (!priceId) {
            return res.status(400).json({ error: 'priceId is required' });
        }

        const sessionParams = {
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            mode: mode, // 'subscription' or 'payment'
            success_url: `${process.env.SITE_URL || 'https://hyperfect.dev'}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.SITE_URL || 'https://hyperfect.dev'}?checkout=cancelled`,
            allow_promotion_codes: true, // Lets users enter discount codes at checkout
        };

        // Pre-fill customer email if provided
        if (customerEmail) {
            sessionParams.customer_email = customerEmail;
        }

        // Add free trial (subscription mode only)
        if (trialDays && mode === 'subscription') {
            sessionParams.subscription_data = {
                trial_period_days: parseInt(trialDays),
            };
        }

        // Apply a specific coupon programmatically
        if (coupon) {
            sessionParams.discounts = [{ coupon: coupon }];
            // Can't use both discounts and allow_promotion_codes
            delete sessionParams.allow_promotion_codes;
        }

        const session = await stripe.checkout.sessions.create(sessionParams);

        return res.status(200).json({
            url: session.url,
            sessionId: session.id,
        });
    } catch (err) {
        console.error('Stripe checkout error:', err.message);
        return res.status(500).json({ error: err.message });
    }
};
