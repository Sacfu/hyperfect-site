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
//   /waitlist-list [status] [limit] — List waitlist entries
//   /waitlist-status <email> — Show a single waitlist entry
//   /waitlist-add <email> [name] [notes] — Add/update a waitlist entry
//   /waitlist-approve <email> [notes] — Approve a waitlist entry
//   /waitlist-reject <email> <reason> — Reject a waitlist entry
//   /waitlist-invite <email> [notes] [name] — Add if missing, approve, and generate invite link
//
// Environment Variables:
//   DISCORD_PUBLIC_KEY — from Discord Developer Portal (for signature verification)
//   STRIPE_SECRET_KEY — Stripe secret
//   BETA_PRICE_ID — price ID for the beta product
//   SITE_URL — https://www.hyperfect.dev
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

const WAITLIST_STATUSES = new Set(['pending', 'approved', 'rejected', 'invited', 'converted']);

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

function ephemeral(content) {
    return {
        type: INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE,
        data: {
            content,
            flags: 64, // Ephemeral
        },
    };
}

function cleanText(value, maxLen = 500) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLen);
}

function normalizeEmail(value) {
    return cleanText(value, 240).toLowerCase();
}

function getOptionValue(options, key, fallback = '') {
    return options?.find(o => o?.name === key)?.value ?? fallback;
}

function getWaitlistStatus(metadata = {}) {
    const status = cleanText(metadata.waitlist_status, 32).toLowerCase();
    if (WAITLIST_STATUSES.has(status)) return status;
    if (metadata.waitlist === 'true') return 'pending';
    return '';
}

function isWaitlistCustomer(metadata = {}) {
    if (!metadata || typeof metadata !== 'object') return false;
    if (metadata.waitlist === 'true') return true;
    return WAITLIST_STATUSES.has(cleanText(metadata.waitlist_status, 32).toLowerCase());
}

function mapWaitlistCustomer(customer) {
    const metadata = customer?.metadata || {};
    const status = getWaitlistStatus(metadata);
    return {
        customer_id: customer.id,
        email: customer.email || '',
        name: metadata.waitlist_name || customer.name || '',
        status: status || 'pending',
        submissions: parseInt(metadata.waitlist_submission_count || '1', 10) || 1,
        source: metadata.waitlist_source || '',
        notes: metadata.waitlist_review_notes || metadata.waitlist_notes || '',
        last_submitted_at: metadata.waitlist_last_submitted_at || metadata.waitlist_created_at || '',
    };
}

async function findCustomerByEmail(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const result = await stripe.customers.list({ email: normalized, limit: 10 });
    for (const customer of result.data || []) {
        if (normalizeEmail(customer.email) === normalized) return customer;
    }
    return null;
}

async function listWaitlistEntries(statusFilter = 'pending', limit = 10) {
    const normalizedStatus = cleanText(statusFilter, 32).toLowerCase() || 'pending';
    const useStatus = normalizedStatus === 'all' ? 'all' : (WAITLIST_STATUSES.has(normalizedStatus) ? normalizedStatus : 'pending');
    const maxRows = Math.max(1, Math.min(25, parseInt(String(limit || 10), 10) || 10));

    const rows = [];
    let hasMore = true;
    let startingAfter = null;
    let pagesScanned = 0;

    while (hasMore && rows.length < maxRows && pagesScanned < 20) {
        pagesScanned += 1;
        const page = await stripe.customers.list({
            limit: 100,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
        });

        const customers = page.data || [];
        for (const customer of customers) {
            if (!isWaitlistCustomer(customer.metadata || {})) continue;
            const mapped = mapWaitlistCustomer(customer);
            if (useStatus !== 'all' && mapped.status !== useStatus) continue;
            rows.push(mapped);
            if (rows.length >= maxRows) break;
        }

        hasMore = !!page.has_more;
        startingAfter = customers.length ? customers[customers.length - 1].id : null;
    }

    rows.sort((a, b) => {
        const aTs = new Date(a.last_submitted_at || 0).getTime();
        const bTs = new Date(b.last_submitted_at || 0).getTime();
        return bTs - aTs;
    });

    return { status: useStatus, entries: rows };
}

async function createInviteSession(email, name, metadata = {}, expiresHours = 24) {
    const priceId = process.env.BETA_PRICE_ID;
    if (!priceId) throw new Error('BETA_PRICE_ID not configured');
    const siteUrl = process.env.SITE_URL || 'https://www.hyperfect.dev';
    return stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: 'payment',
        customer_email: email,
        success_url: `${siteUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${siteUrl}/?checkout=cancelled`,
        expires_at: Math.floor(Date.now() / 1000) + (expiresHours * 60 * 60),
        metadata: {
            invite_for: name || email,
            source: 'discord_bot',
            ...metadata,
        },
    });
}

async function updateWaitlistByEmail(email, nextStatus, notes, commandMeta = {}) {
    const normalized = normalizeEmail(email);
    const requestedStatus = cleanText(nextStatus, 32).toLowerCase();
    if (!WAITLIST_STATUSES.has(requestedStatus)) {
        throw new Error('Invalid waitlist status');
    }

    const customer = await findCustomerByEmail(normalized);
    if (!customer || customer.deleted || !isWaitlistCustomer(customer.metadata || {})) {
        return { ok: false, error: 'Waitlist customer not found' };
    }

    const previous = customer.metadata || {};
    const now = new Date().toISOString();
    const metadata = {
        ...previous,
        waitlist: 'true',
        waitlist_status: requestedStatus,
        waitlist_review_notes: cleanText(notes, 500),
        waitlist_updated_at: now,
        waitlist_reviewed_at: now,
        waitlist_reviewed_by: cleanText(commandMeta.reviewedBy, 120),
    };

    const updated = await stripe.customers.update(customer.id, { metadata });
    return { ok: true, customer: updated, entry: mapWaitlistCustomer(updated) };
}

async function ensureWaitlistCustomer(email, name = '', notes = '', source = 'discord_waitlist_add') {
    const normalized = normalizeEmail(email);
    if (!normalized) return { ok: false, error: 'Email is required.' };

    const cleanName = cleanText(name, 120);
    const cleanNotes = cleanText(notes, 500);
    const cleanSource = cleanText(source, 64) || 'discord_waitlist_add';
    const now = new Date().toISOString();

    const existing = await findCustomerByEmail(normalized);
    if (existing && !existing.deleted) {
        const previous = existing.metadata || {};
        const currentStatus = getWaitlistStatus(previous) || 'pending';
        const nextStatus = currentStatus === 'rejected' ? 'pending' : currentStatus;
        const submissionCount = (parseInt(previous.waitlist_submission_count || '0', 10) || 0) + 1;

        const updated = await stripe.customers.update(existing.id, {
            name: cleanName || existing.name || undefined,
            metadata: {
                ...previous,
                waitlist: 'true',
                waitlist_status: nextStatus,
                waitlist_name: cleanName || previous.waitlist_name || existing.name || '',
                waitlist_source: previous.waitlist_source || cleanSource,
                waitlist_interest: previous.waitlist_interest || cleanNotes,
                waitlist_submission_count: String(submissionCount),
                waitlist_last_submitted_at: now,
                waitlist_updated_at: now,
                waitlist_created_at: previous.waitlist_created_at || now,
                waitlist_review_notes: cleanNotes || previous.waitlist_review_notes || '',
            },
        });
        return { ok: true, created: false, customer: updated, entry: mapWaitlistCustomer(updated) };
    }

    const created = await stripe.customers.create({
        email: normalized,
        name: cleanName || undefined,
        metadata: {
            waitlist: 'true',
            waitlist_status: 'pending',
            waitlist_name: cleanName,
            waitlist_source: cleanSource,
            waitlist_interest: cleanNotes,
            waitlist_submission_count: '1',
            waitlist_last_submitted_at: now,
            waitlist_updated_at: now,
            waitlist_created_at: now,
            waitlist_review_notes: cleanNotes,
        },
    });
    return { ok: true, created: true, customer: created, entry: mapWaitlistCustomer(created) };
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
        const actor = cleanText(member?.user?.username || body?.user?.username || 'unknown', 120);

        if (!process.env.STRIPE_SECRET_KEY) {
            return res.status(200).json(ephemeral('Stripe is not configured on the server (missing STRIPE_SECRET_KEY).'));
        }

        // Optional: restrict to admin role
        if (process.env.ADMIN_ROLE_ID) {
            const hasRole = member?.roles?.includes(process.env.ADMIN_ROLE_ID);
            if (!hasRole) {
                return res.status(200).json(ephemeral('You do not have permission to use this command.'));
            }
        }

        if (name === 'invite') {
            const email = normalizeEmail(getOptionValue(options, 'email'));
            const testerName = cleanText(getOptionValue(options, 'name', email), 120);

            if (!email) {
                return res.status(200).json(ephemeral('Email is required.'));
            }

            try {
                const session = await createInviteSession(email, testerName, {
                    invited_by: actor,
                    command: 'invite',
                }, 24);
                return res.status(200).json(
                    ephemeral(`**Beta invite generated for ${testerName}**\nEmail: ${email}\nCheckout link (expires in 24h):\n${session.url}`)
                );
            } catch (err) {
                console.error('Discord invite error:', err.message);
                return res.status(200).json(ephemeral(`Error: ${err.message}`));
            }
        }

        if (name === 'waitlist-list') {
            const status = cleanText(getOptionValue(options, 'status', 'pending'), 32).toLowerCase();
            const limit = parseInt(String(getOptionValue(options, 'limit', 10)), 10) || 10;
            try {
                const result = await listWaitlistEntries(status, limit);
                if (!result.entries.length) {
                    return res.status(200).json(
                        ephemeral(`No waitlist entries found for status: **${result.status}**.`)
                    );
                }

                const lines = result.entries.map((entry, idx) => {
                    const nameText = cleanText(entry.name, 80) || 'Unknown';
                    return `${idx + 1}. ${nameText} <${entry.email}> — **${entry.status}** (submissions: ${entry.submissions})`;
                });

                return res.status(200).json(
                    ephemeral(`Waitlist (${result.status}) — showing ${result.entries.length}:\n${lines.join('\n')}`)
                );
            } catch (err) {
                return res.status(200).json(ephemeral(`Error listing waitlist: ${err.message}`));
            }
        }

        if (name === 'waitlist-status') {
            const email = normalizeEmail(getOptionValue(options, 'email'));
            if (!email) return res.status(200).json(ephemeral('Email is required.'));
            try {
                const customer = await findCustomerByEmail(email);
                if (!customer || customer.deleted || !isWaitlistCustomer(customer.metadata || {})) {
                    return res.status(200).json(ephemeral(`No waitlist entry found for ${email}.`));
                }
                const entry = mapWaitlistCustomer(customer);
                return res.status(200).json(
                    ephemeral(
                        `Waitlist entry:\nEmail: ${entry.email}\nName: ${entry.name || 'Unknown'}\nStatus: **${entry.status}**\nSubmissions: ${entry.submissions}\nSource: ${entry.source || 'n/a'}`
                    )
                );
            } catch (err) {
                return res.status(200).json(ephemeral(`Error fetching entry: ${err.message}`));
            }
        }

        if (name === 'waitlist-add') {
            const email = normalizeEmail(getOptionValue(options, 'email'));
            const waitlistName = cleanText(getOptionValue(options, 'name', ''), 120);
            const notes = cleanText(getOptionValue(options, 'notes', ''), 500);
            if (!email) return res.status(200).json(ephemeral('Email is required.'));
            try {
                const seeded = await ensureWaitlistCustomer(email, waitlistName, notes, 'discord_waitlist_add');
                if (!seeded.ok) return res.status(200).json(ephemeral(seeded.error || 'Could not add waitlist entry.'));
                const entry = seeded.entry || {};
                return res.status(200).json(
                    ephemeral(
                        `${seeded.created ? 'Added' : 'Updated'} waitlist entry for ${email}.\nStatus: **${entry.status || 'pending'}**`
                    )
                );
            } catch (err) {
                return res.status(200).json(ephemeral(`Error adding waitlist entry: ${err.message}`));
            }
        }

        if (name === 'waitlist-approve') {
            const email = normalizeEmail(getOptionValue(options, 'email'));
            const notes = cleanText(getOptionValue(options, 'notes', ''), 500);
            if (!email) return res.status(200).json(ephemeral('Email is required.'));
            try {
                const updated = await updateWaitlistByEmail(email, 'approved', notes, { reviewedBy: actor });
                if (!updated.ok) return res.status(200).json(ephemeral(updated.error));
                return res.status(200).json(
                    ephemeral(`Approved waitlist entry for ${email}. Status is now **${updated.entry.status}**.`)
                );
            } catch (err) {
                return res.status(200).json(ephemeral(`Error approving entry: ${err.message}`));
            }
        }

        if (name === 'waitlist-reject') {
            const email = normalizeEmail(getOptionValue(options, 'email'));
            const reason = cleanText(getOptionValue(options, 'reason', ''), 500);
            if (!email) return res.status(200).json(ephemeral('Email is required.'));
            if (!reason) return res.status(200).json(ephemeral('Rejection reason is required.'));
            try {
                const updated = await updateWaitlistByEmail(email, 'rejected', reason, { reviewedBy: actor });
                if (!updated.ok) return res.status(200).json(ephemeral(updated.error));
                return res.status(200).json(
                    ephemeral(`Rejected waitlist entry for ${email}. Reason saved.`)
                );
            } catch (err) {
                return res.status(200).json(ephemeral(`Error rejecting entry: ${err.message}`));
            }
        }

        if (name === 'waitlist-invite') {
            const email = normalizeEmail(getOptionValue(options, 'email'));
            const waitlistName = cleanText(getOptionValue(options, 'name', ''), 120);
            const notes = cleanText(getOptionValue(options, 'notes', ''), 500);
            if (!email) return res.status(200).json(ephemeral('Email is required.'));
            try {
                const seeded = await ensureWaitlistCustomer(email, waitlistName, notes, 'discord_waitlist_invite');
                if (!seeded.ok) return res.status(200).json(ephemeral(seeded.error || 'Could not prepare waitlist entry.'));

                const approved = await updateWaitlistByEmail(email, 'approved', notes, { reviewedBy: actor });
                if (!approved.ok) return res.status(200).json(ephemeral(approved.error));

                const entry = approved.entry || {};
                const session = await createInviteSession(email, entry.name || email, {
                    source: 'waitlist_approval',
                    waitlist_customer_id: entry.customer_id || '',
                    invited_by: actor,
                    command: 'waitlist-invite',
                }, 24);

                const previous = approved.customer.metadata || {};
                const now = new Date().toISOString();
                await stripe.customers.update(approved.customer.id, {
                    metadata: {
                        ...previous,
                        waitlist: 'true',
                        waitlist_status: 'invited',
                        waitlist_invited_at: now,
                        waitlist_updated_at: now,
                    },
                });

                return res.status(200).json(
                    ephemeral(`Approved + invited ${email}.\nInvite link (expires in 24h):\n${session.url}`)
                );
            } catch (err) {
                return res.status(200).json(ephemeral(`Error inviting entry: ${err.message}`));
            }
        }

        // Unknown command
        return res.status(200).json(ephemeral('Unknown command.'));
    }

    return res.status(400).json({ error: 'Unknown interaction type' });
};
