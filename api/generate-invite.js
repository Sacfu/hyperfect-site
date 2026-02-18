// Vercel Serverless Function: Generate Beta Invite Checkout Links
// Admin-only endpoint to create one-time checkout URLs for specific testers.
//
// Usage: POST /api/generate-invite
// Headers: Authorization: Bearer <ADMIN_SECRET>
// Body: { "email": "tester@example.com", "name": "John" }
//
// Returns: { "url": "https://checkout.stripe.com/...", "sessionId": "cs_..." }
//
// The generated URL is one-time use and expires after 24 hours.
// When the tester completes checkout, the webhook fires → license key generated → emailed.
//
// Environment Variables:
//   STRIPE_SECRET_KEY — Stripe secret key
//   ADMIN_SECRET — secret to protect this endpoint
//   SITE_URL — https://hyperfect.dev
//   BETA_PRICE_ID — price_xxx for the free beta product

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // Admin auth check
    const auth = req.headers.authorization?.replace('Bearer ', '');
    if (auth !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const { email, name } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'email is required' });
        }

        const priceId = process.env.BETA_PRICE_ID;
        if (!priceId) {
            return res.status(500).json({ error: 'BETA_PRICE_ID not configured' });
        }

        const siteUrl = process.env.SITE_URL || 'https://hyperfect.dev';

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'payment',
            customer_email: email,
            success_url: `${siteUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${siteUrl}/?checkout=cancelled`,
            expires_at: Math.floor(Date.now() / 1000) + (24 * 60 * 60), // 24 hours
            metadata: {
                invite_for: name || email,
                source: 'beta_invite',
            },
        });

        return res.status(200).json({
            url: session.url,
            sessionId: session.id,
            email: email,
            expiresIn: '24 hours',
        });
    } catch (err) {
        console.error('Generate invite error:', err.message);
        return res.status(500).json({ error: err.message });
    }
};
