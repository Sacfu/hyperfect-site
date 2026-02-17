// Vercel Serverless Function: Stripe Webhook Handler
// Listens for successful payments/subscriptions, generates license keys,
// and emails them to the customer via Resend.
//
// Environment Variables (set in Vercel Dashboard > Settings > Environment Variables):
//   STRIPE_SECRET_KEY — your Stripe secret key (sk_live_...)
//   STRIPE_WEBHOOK_SECRET — webhook signing secret (whsec_...)
//   RESEND_API_KEY — Resend API key for transactional emails (re_...)

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const crypto = require('crypto');

// Generate a unique license key: NEXUS-XXXX-XXXX-XXXX-XXXX
function generateLicenseKey() {
    const segments = [];
    for (let i = 0; i < 4; i++) {
        segments.push(crypto.randomBytes(2).toString('hex').toUpperCase());
    }
    return `NEXUS-${segments.join('-')}`;
}

// Vercel requires raw body for webhook signature verification
module.exports.config = {
    api: {
        bodyParser: false,
    },
};

async function getRawBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
}

// Send the license key via Resend transactional email
async function sendLicenseEmail(email, licenseKey, plan) {
    if (!process.env.RESEND_API_KEY) {
        console.log('RESEND_API_KEY not set — skipping email delivery');
        return;
    }

    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: 'Nexus by Hyperfect <onboarding@resend.dev>',
            to: email,
            subject: 'Your Nexus License Key',
            html: `
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 40px 20px;">
                    <div style="text-align: center; margin-bottom: 32px;">
                        <h1 style="font-size: 24px; color: #fafafa; margin: 0;">Welcome to Nexus</h1>
                        <p style="color: #a1a1aa; font-size: 14px; margin-top: 8px;">Thanks for your purchase! Here's your license key.</p>
                    </div>

                    <div style="background: #1a1a2e; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
                        <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #71717a; margin-bottom: 12px;">Your License Key</div>
                        <div style="font-family: 'SF Mono', 'Fira Code', Consolas, monospace; font-size: 20px; font-weight: 700; color: #ffffff; letter-spacing: 2px; padding: 12px; background: rgba(37,99,235,0.08); border-radius: 8px;">
                            ${licenseKey}
                        </div>
                        <div style="font-size: 12px; color: #71717a; margin-top: 12px;">Plan: ${plan === 'subscription' ? 'Subscription' : 'Lifetime'}</div>
                    </div>

                    <div style="background: rgba(37,99,235,0.06); border: 1px solid rgba(37,99,235,0.15); border-radius: 8px; padding: 16px; margin: 24px 0;">
                        <h3 style="font-size: 14px; color: #fafafa; margin: 0 0 8px 0;">Getting Started</h3>
                        <ol style="color: #a1a1aa; font-size: 13px; line-height: 1.8; margin: 0; padding-left: 16px;">
                            <li>Download Nexus from our Discord server</li>
                            <li>Open the app and enter your license key</li>
                            <li>Upload your resume and configure your job preferences</li>
                            <li>Create your first search and let Nexus work</li>
                        </ol>
                    </div>

                    <div style="text-align: center; margin-top: 32px; padding-top: 24px; border-top: 1px solid rgba(255,255,255,0.06);">
                        <p style="color: #71717a; font-size: 12px; margin: 0;">Questions? Reply to this email or reach us at <a href="mailto:Hyperfectllc@gmail.com" style="color: #2563eb;">Hyperfectllc@gmail.com</a></p>
                        <p style="color: #52525b; font-size: 11px; margin-top: 8px;">&copy; 2026 Hyperfect LLC &bull; <a href="https://hyperfect.dev" style="color: #52525b;">hyperfect.dev</a></p>
                    </div>
                </div>
            `,
        }),
    });

    if (!res.ok) {
        console.error('Failed to send license email:', await res.text());
    } else {
        console.log(`License email sent to ${email}`);
    }
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const rawBody = await getRawBody(req);
    const sig = req.headers['stripe-signature'];

    let event;
    try {
        event = stripe.webhooks.constructEvent(
            rawBody,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    switch (event.type) {
        case 'checkout.session.completed': {
            const session = event.data.object;
            const customerEmail = session.customer_email || session.customer_details?.email;
            const licenseKey = generateLicenseKey();
            const plan = session.mode === 'subscription' ? 'subscription' : 'lifetime';

            console.log('=== NEW LICENSE KEY GENERATED ===');
            console.log(`Email: ${customerEmail}`);
            console.log(`License: ${licenseKey}`);
            console.log(`Session: ${session.id}`);
            console.log(`Mode: ${session.mode}`);
            console.log(`Amount: ${session.amount_total / 100} ${session.currency?.toUpperCase()}`);
            console.log('================================');

            // Store the license key on the Stripe customer
            if (session.customer) {
                try {
                    await stripe.customers.update(session.customer, {
                        metadata: {
                            license_key: licenseKey,
                            license_created: new Date().toISOString(),
                            plan: plan,
                        },
                    });
                } catch (err) {
                    console.error('Failed to update customer metadata:', err.message);
                }
            }

            // Email the license key to the customer
            if (customerEmail) {
                await sendLicenseEmail(customerEmail, licenseKey, plan);
            }

            break;
        }

        case 'customer.subscription.deleted': {
            const subscription = event.data.object;
            console.log(`Subscription cancelled: ${subscription.id}`);
            // Could revoke the license here by updating customer metadata
            break;
        }

        default:
            break;
    }

    return res.status(200).json({ received: true });
};
