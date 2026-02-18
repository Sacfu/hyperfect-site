// Vercel Serverless Function: Discord Bot Interactions Handler
// Handles slash commands sent from Discord via interactions endpoint.
//
// Setup:
//   1. Go to Discord Developer Portal → Your App → General Information
//   2. Copy "Public Key" → add as DISCORD_PUBLIC_KEY env var in Vercel
//   3. Set "Interactions Endpoint URL" to: https://www.hyperfect.dev/api/discord-bot
//   4. Register slash commands using the /api/discord-register endpoint
//
// Slash Commands:
//   /invite <email> [name] — Generate a beta checkout link for a tester
//
// Environment Variables:
//   DISCORD_PUBLIC_KEY — from Discord Developer Portal (for signature verification)
//   DISCORD_BOT_TOKEN — bot token
//   STRIPE_SECRET_KEY — Stripe secret
//   BETA_PRICE_ID — price ID for the free beta product
//   SITE_URL — https://hyperfect.dev
//   ADMIN_ROLE_ID — (optional) Discord role ID required to use commands

const nacl = require('tweetnacl');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Discord interaction types
const INTERACTION_TYPE = {
    PING: 1,
    APPLICATION_COMMAND: 2,
};

const INTERACTION_RESPONSE_TYPE = {
    PONG: 1,
    CHANNEL_MESSAGE: 4,
};

// Verify Discord request signature using tweetnacl
function verifyDiscordSignature(rawBody, signature, timestamp) {
    const publicKey = process.env.DISCORD_PUBLIC_KEY;
    if (!publicKey) return false;

    try {
        return nacl.sign.detached.verify(
            Buffer.from(timestamp + rawBody),
            Buffer.from(signature, 'hex'),
            Buffer.from(publicKey, 'hex')
        );
    } catch {
        return false;
    }
}

// We need raw body for signature verification
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
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];

    // Verify signature
    if (!signature || !timestamp || !verifyDiscordSignature(rawBody.toString(), signature, timestamp)) {
        return res.status(401).json({ error: 'Invalid signature' });
    }

    const body = JSON.parse(rawBody.toString());

    // Handle Discord PING (required for endpoint verification)
    if (body.type === INTERACTION_TYPE.PING) {
        return res.status(200).json({ type: INTERACTION_RESPONSE_TYPE.PONG });
    }

    // Handle slash commands
    if (body.type === INTERACTION_TYPE.APPLICATION_COMMAND) {
        const { name, options } = body.data;
        const member = body.member;

        // Optional: restrict to admin role
        if (process.env.ADMIN_ROLE_ID) {
            const hasRole = member?.roles?.includes(process.env.ADMIN_ROLE_ID);
            if (!hasRole) {
                return res.status(200).json({
                    type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE,
                    data: {
                        content: 'You do not have permission to use this command.',
                        flags: 64, // Ephemeral — only visible to the user who ran it
                    },
                });
            }
        }

        if (name === 'invite') {
            const email = options?.find(o => o.name === 'email')?.value;
            const testerName = options?.find(o => o.name === 'name')?.value || email;

            if (!email) {
                return res.status(200).json({
                    type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE,
                    data: { content: 'Email is required.', flags: 64 },
                });
            }

            try {
                const priceId = process.env.BETA_PRICE_ID;
                const siteUrl = process.env.SITE_URL || 'https://hyperfect.dev';

                const session = await stripe.checkout.sessions.create({
                    payment_method_types: ['card'],
                    line_items: [{ price: priceId, quantity: 1 }],
                    mode: 'payment',
                    customer_email: email,
                    success_url: `${siteUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
                    cancel_url: `${siteUrl}/?checkout=cancelled`,
                    expires_at: Math.floor(Date.now() / 1000) + (24 * 60 * 60),
                    metadata: {
                        invite_for: testerName,
                        source: 'discord_bot',
                        invited_by: member?.user?.username || 'unknown',
                    },
                });

                return res.status(200).json({
                    type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE,
                    data: {
                        content: `**Beta invite generated for ${testerName}**\nEmail: ${email}\nCheckout link (expires in 24h):\n${session.url}`,
                        flags: 64, // Ephemeral — only you can see this
                    },
                });
            } catch (err) {
                console.error('Discord invite error:', err.message);
                return res.status(200).json({
                    type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE,
                    data: { content: `Error: ${err.message}`, flags: 64 },
                });
            }
        }

        // Unknown command
        return res.status(200).json({
            type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE,
            data: { content: 'Unknown command.', flags: 64 },
        });
    }

    return res.status(400).json({ error: 'Unknown interaction type' });
};
