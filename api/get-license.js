// Vercel Serverless Function: Retrieve License Key
// Called by the success page after Stripe checkout completes.
// Uses the Stripe session ID to look up the customer and return their license key.
//
// GET /api/get-license?session_id=cs_xxx
//
// Environment Variables:
//   STRIPE_SECRET_KEY

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', 'https://hyperfect.dev');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { session_id } = req.query;

    if (!session_id) {
        return res.status(400).json({ error: 'session_id is required' });
    }

    try {
        // Retrieve the checkout session
        const session = await stripe.checkout.sessions.retrieve(session_id);

        if (!session || !['paid', 'no_payment_required'].includes(session.payment_status)) {
            return res.status(402).json({ error: 'Payment not completed' });
        }

        // Try to get customer from session, or search by email for $0 checkouts
        let customer = null;

        if (session.customer) {
            customer = await stripe.customers.retrieve(session.customer);
        }

        // Fallback: search by email (for $0 checkouts where customer was created by webhook)
        if (!customer?.metadata?.license_key) {
            const email = session.customer_email || session.customer_details?.email;
            if (email) {
                const customers = await stripe.customers.list({ email: email, limit: 1 });
                if (customers.data.length > 0 && customers.data[0].metadata?.license_key) {
                    customer = customers.data[0];
                }
            }
        }

        if (!customer?.metadata?.license_key) {
            // Webhook may not have fired yet — tell frontend to retry
            return res.status(202).json({ pending: true, message: 'License key is being generated...' });
        }

        return res.status(200).json({
            licenseKey: customer.metadata.license_key,
            plan: customer.metadata.plan || 'lifetime',
            email: customer.email || session.customer_email || session.customer_details?.email || '',
        });

    } catch (err) {
        console.error('Get license error:', err.message);
        return res.status(500).json({ error: 'Could not retrieve license' });
    }
};
