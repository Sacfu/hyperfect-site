// Vercel Serverless Function: Stripe Webhook Handler
// Listens for successful payments/subscriptions, generates license keys
//
// Environment Variables (set in Vercel Dashboard > Settings > Environment Variables):
//   STRIPE_SECRET_KEY — your Stripe secret key (sk_live_...)
//   STRIPE_WEBHOOK_SECRET — webhook signing secret (whsec_...)

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
// This config tells Vercel not to parse the body
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

    // Handle the event
    switch (event.type) {
        case 'checkout.session.completed': {
            const session = event.data.object;
            const customerEmail = session.customer_email || session.customer_details?.email;
            const licenseKey = generateLicenseKey();

            console.log('=== NEW LICENSE KEY GENERATED ===');
            console.log(`Email: ${customerEmail}`);
            console.log(`License: ${licenseKey}`);
            console.log(`Session: ${session.id}`);
            console.log(`Mode: ${session.mode}`);
            console.log(`Amount: ${session.amount_total / 100} ${session.currency?.toUpperCase()}`);
            console.log('================================');

            // Store the license key as metadata on the Stripe customer
            // This way you can see all license keys in your Stripe Dashboard
            if (session.customer) {
                try {
                    await stripe.customers.update(session.customer, {
                        metadata: {
                            license_key: licenseKey,
                            license_created: new Date().toISOString(),
                            plan: session.mode === 'subscription' ? 'subscription' : 'lifetime',
                        },
                    });
                } catch (err) {
                    console.error('Failed to update customer metadata:', err.message);
                }
            }

            // Send the license key via Stripe receipt email isn't possible directly,
            // but the license is stored on the customer in Stripe Dashboard.
            //
            // For automated email delivery, you have two options:
            //
            // Option A: Use Stripe's built-in receipts + customer metadata
            //   → You can see license keys in Stripe Dashboard > Customers
            //
            // Option B: Add an email service (Resend, SendGrid, etc.)
            //   → Uncomment and configure the sendLicenseEmail function below
            //
            // await sendLicenseEmail(customerEmail, licenseKey);

            break;
        }

        case 'customer.subscription.deleted': {
            // Subscription cancelled — you could revoke the license here
            const subscription = event.data.object;
            console.log(`Subscription cancelled: ${subscription.id}`);
            break;
        }

        default:
            // Unhandled event type
            break;
    }

    return res.status(200).json({ received: true });
};

// ============================================================
// OPTIONAL: Email delivery via Resend (https://resend.com)
// Uncomment and set RESEND_API_KEY env var to enable
// ============================================================
//
// async function sendLicenseEmail(email, licenseKey) {
//     const res = await fetch('https://api.resend.com/emails', {
//         method: 'POST',
//         headers: {
//             'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
//             'Content-Type': 'application/json',
//         },
//         body: JSON.stringify({
//             from: 'Nexus by Hyperfect <noreply@hyperfect.dev>',
//             to: email,
//             subject: 'Your Nexus License Key',
//             html: `
//                 <h2>Thanks for purchasing Nexus!</h2>
//                 <p>Here's your license key:</p>
//                 <div style="background:#f4f4f5;padding:1rem;border-radius:8px;font-family:monospace;font-size:1.25rem;text-align:center;margin:1.5rem 0;">
//                     ${licenseKey}
//                 </div>
//                 <p>Enter this key in Nexus > Settings > License to activate.</p>
//                 <p>Questions? Reply to this email or reach us at Hyperfectllc@gmail.com</p>
//                 <p>— The Hyperfect Team</p>
//             `,
//         }),
//     });
//     if (!res.ok) {
//         console.error('Failed to send license email:', await res.text());
//     }
// }
