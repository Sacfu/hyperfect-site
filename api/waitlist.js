// Vercel Serverless Function: Waitlist Intake + Admin Review
//
// Public:
//   POST /api/waitlist
//   Body: { name, email, message, consent, source }
//
// Admin (Authorization: Bearer <ADMIN_SECRET>):
//   GET /api/waitlist?status=pending|approved|rejected|invited|converted|all&limit=50&cursor=cus_xxx
//   PATCH /api/waitlist
//   Body: { customer_id?, email?, status, notes?, send_invite? }
//
// Data is persisted on Stripe customers via metadata.
// This keeps costs low while providing a queue-style review workflow.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const WAITLIST_STATUSES = new Set([
    'pending',
    'approved',
    'rejected',
    'invited',
    'converted',
]);

const WAITLIST_NOTIFY_ENABLED = String(process.env.WAITLIST_NOTIFY_ENABLED || 'true')
    .trim()
    .toLowerCase() !== 'false';
const WAITLIST_NOTIFY_ENDPOINT = String(
    process.env.WAITLIST_NOTIFY_ENDPOINT || 'https://formsubmit.co/ajax/Hyperfectllc@gmail.com'
).trim();

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function getBearerToken(req) {
    const auth = req.headers.authorization || '';
    if (!auth.toLowerCase().startsWith('bearer ')) return '';
    return auth.slice(7).trim();
}

function requireAdmin(req, res) {
    const expected = String(process.env.ADMIN_SECRET || '').trim();
    const received = getBearerToken(req);
    if (!expected || received !== expected) {
        res.status(401).json({ success: false, error: 'Unauthorized' });
        return false;
    }
    return true;
}

function cleanText(value, maxLen) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLen);
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function emailLooksValid(value) {
    // Pragmatic email validation for intake.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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
    const isWaitlist = isWaitlistCustomer(metadata);
    const status = getWaitlistStatus(metadata);
    const fallbackCreatedAt = customer?.created
        ? new Date(customer.created * 1000).toISOString()
        : null;
    return {
        customer_id: customer.id,
        email: customer.email || '',
        name: metadata.waitlist_name || customer.name || '',
        status: isWaitlist ? (status || 'pending') : '',
        is_waitlist: isWaitlist,
        interest: metadata.waitlist_interest || '',
        source: metadata.waitlist_source || '',
        notes: metadata.waitlist_notes || '',
        submissions: parseInt(metadata.waitlist_submission_count || '1', 10) || 1,
        created_at: metadata.waitlist_created_at || fallbackCreatedAt,
        updated_at: metadata.waitlist_updated_at || null,
        last_submitted_at: metadata.waitlist_last_submitted_at || null,
        invited_at: metadata.waitlist_invited_at || null,
        converted_at: metadata.waitlist_converted_at || null,
        license_key: metadata.license_key || '',
    };
}

async function sendWaitlistNotification({
    name,
    email,
    interest,
    source,
    consent,
    status,
    alreadyJoined,
    customerId,
    submissions,
}) {
    if (!WAITLIST_NOTIFY_ENABLED || !WAITLIST_NOTIFY_ENDPOINT) return;

    const joinedText = alreadyJoined ? 'Updated Existing Waitlist Entry' : 'New Waitlist Signup';
    const messageLines = [
        `Type: ${joinedText}`,
        `Name: ${name || 'N/A'}`,
        `Email: ${email || 'N/A'}`,
        `Status: ${status || 'pending'}`,
        `Source: ${source || 'website_waitlist'}`,
        `Submissions: ${submissions || 1}`,
        `Customer ID: ${customerId || 'N/A'}`,
        `Consent: ${consent ? 'yes' : 'no'}`,
        `Interest: ${interest || '(none provided)'}`,
    ];

    const payload = {
        name: 'Nexus Waitlist',
        email: 'noreply@hyperfect.dev',
        message: messageLines.join('\n'),
        _subject: `Nexus Waitlist: ${joinedText}`,
        _template: 'table',
        _captcha: 'false',
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);

    try {
        const response = await fetch(WAITLIST_NOTIFY_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            console.error(`Waitlist notify failed (HTTP ${response.status}): ${detail.slice(0, 200)}`);
        }
    } catch (err) {
        console.error('Waitlist notify request failed:', err?.message || String(err));
    } finally {
        clearTimeout(timeout);
    }
}

async function findCustomerByEmail(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;

    // Stripe supports list-by-email; still validate exact match to be safe.
    const result = await stripe.customers.list({ email: normalized, limit: 10 });
    for (const customer of result.data || []) {
        if (normalizeEmail(customer.email) === normalized) {
            return customer;
        }
    }
    return null;
}

async function createInviteForCustomer(email, name, customerId) {
    const priceId = process.env.BETA_PRICE_ID;
    if (!priceId) {
        return { ok: false, error: 'BETA_PRICE_ID not configured' };
    }

    const siteUrl = process.env.SITE_URL || 'https://www.hyperfect.dev';
    const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{ price: priceId, quantity: 1 }],
        mode: 'payment',
        customer_email: email,
        success_url: `${siteUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${siteUrl}/?checkout=cancelled`,
        expires_at: Math.floor(Date.now() / 1000) + (72 * 60 * 60), // 72 hours
        metadata: {
            source: 'waitlist_approval',
            invite_for: name || email,
            waitlist_customer_id: customerId || '',
        },
    });

    return {
        ok: true,
        invite_url: session.url,
        session_id: session.id,
        expires_in: '72 hours',
    };
}

async function handlePublicSubmit(req, res) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const name = cleanText(body.name, 120);
    const email = normalizeEmail(body.email);
    const interest = cleanText(body.message, 480);
    const source = cleanText(body.source || 'website_waitlist', 64) || 'website_waitlist';
    const consent = !!body.consent;

    if (!name) {
        return res.status(400).json({ success: false, error: 'Name is required' });
    }
    if (!email || !emailLooksValid(email)) {
        return res.status(400).json({ success: false, error: 'Valid email is required' });
    }

    const now = new Date().toISOString();
    const existing = await findCustomerByEmail(email);

    if (existing) {
        const previous = existing.metadata || {};
        const currentStatus = getWaitlistStatus(previous) || 'pending';
        const nextStatus = currentStatus === 'rejected' ? 'pending' : currentStatus;
        const submissionCount = (parseInt(previous.waitlist_submission_count || '0', 10) || 0) + 1;

        const updated = await stripe.customers.update(existing.id, {
            name: name || existing.name || undefined,
            metadata: {
                ...previous,
                waitlist: 'true',
                waitlist_status: nextStatus,
                waitlist_name: name,
                waitlist_interest: interest,
                waitlist_source: source,
                waitlist_consent: consent ? 'true' : 'false',
                waitlist_submission_count: String(submissionCount),
                waitlist_last_submitted_at: now,
                waitlist_updated_at: now,
                waitlist_created_at: previous.waitlist_created_at || now,
            },
        });

        await sendWaitlistNotification({
            name,
            email,
            interest,
            source,
            consent,
            status: getWaitlistStatus(updated.metadata) || nextStatus,
            alreadyJoined: true,
            customerId: updated.id,
            submissions: submissionCount,
        });

        return res.status(200).json({
            success: true,
            status: getWaitlistStatus(updated.metadata) || nextStatus,
            already_joined: true,
            customer_id: updated.id,
        });
    }

    const created = await stripe.customers.create({
        email,
        name,
        description: 'Nexus waitlist signup',
        metadata: {
            waitlist: 'true',
            waitlist_status: 'pending',
            waitlist_name: name,
            waitlist_interest: interest,
            waitlist_source: source,
            waitlist_consent: consent ? 'true' : 'false',
            waitlist_submission_count: '1',
            waitlist_last_submitted_at: now,
            waitlist_updated_at: now,
            waitlist_created_at: now,
        },
    });

    await sendWaitlistNotification({
        name,
        email,
        interest,
        source,
        consent,
        status: 'pending',
        alreadyJoined: false,
        customerId: created.id,
        submissions: 1,
    });

    return res.status(200).json({
        success: true,
        status: 'pending',
        already_joined: false,
        customer_id: created.id,
    });
}

async function handleAdminList(req, res) {
    if (!requireAdmin(req, res)) return;

    const statusFilter = cleanText(req.query.status || 'all', 32).toLowerCase();
    const normalizedStatus = statusFilter === 'all' ? 'all' : statusFilter;
    if (normalizedStatus !== 'all' && !WAITLIST_STATUSES.has(normalizedStatus)) {
        return res.status(400).json({ success: false, error: 'Invalid status filter' });
    }

    const limitRequested = parseInt(req.query.limit || '50', 10);
    const limit = Math.max(1, Math.min(100, Number.isFinite(limitRequested) ? limitRequested : 50));
    const cursor = cleanText(req.query.cursor, 64);

    const rows = [];
    let hasMore = true;
    let startingAfter = cursor || null;
    let nextCursor = null;
    let pagesScanned = 0;

    // Scan Stripe pages until we collect enough waitlist rows.
    while (hasMore && rows.length < limit && pagesScanned < 20) {
        pagesScanned += 1;
        const page = await stripe.customers.list({
            limit: 100,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
        });

        const customers = page.data || [];
        for (const customer of customers) {
            const mapped = mapWaitlistCustomer(customer);
            if (!mapped.is_waitlist || !mapped.status) continue;
            if (normalizedStatus !== 'all' && mapped.status !== normalizedStatus) continue;
            rows.push(mapped);
            if (rows.length >= limit) break;
        }

        hasMore = !!page.has_more;
        startingAfter = customers.length ? customers[customers.length - 1].id : null;
        nextCursor = hasMore ? startingAfter : null;
    }

    rows.sort((a, b) => {
        const aTs = new Date(a.last_submitted_at || a.created_at || 0).getTime();
        const bTs = new Date(b.last_submitted_at || b.created_at || 0).getTime();
        return bTs - aTs;
    });

    return res.status(200).json({
        success: true,
        status: normalizedStatus,
        count: rows.length,
        next_cursor: nextCursor,
        entries: rows,
    });
}

async function handleAdminUpdate(req, res) {
    if (!requireAdmin(req, res)) return;

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const customerId = cleanText(body.customer_id, 64);
    const email = normalizeEmail(body.email);
    const requestedStatus = cleanText(body.status, 32).toLowerCase();
    const notes = cleanText(body.notes, 500);
    const sendInvite = !!body.send_invite;

    if (!customerId && !email) {
        return res.status(400).json({ success: false, error: 'customer_id or email is required' });
    }
    if (!WAITLIST_STATUSES.has(requestedStatus)) {
        return res.status(400).json({ success: false, error: 'Invalid status value' });
    }

    let customer = null;
    if (customerId) {
        customer = await stripe.customers.retrieve(customerId);
    } else {
        customer = await findCustomerByEmail(email);
    }

    if (!customer || customer.deleted) {
        return res.status(404).json({ success: false, error: 'Waitlist customer not found' });
    }
    if (!isWaitlistCustomer(customer.metadata || {})) {
        return res.status(404).json({ success: false, error: 'Waitlist customer not found' });
    }

    const previous = customer.metadata || {};
    const now = new Date().toISOString();
    const metadata = {
        ...previous,
        waitlist: 'true',
        waitlist_status: requestedStatus,
        waitlist_updated_at: now,
        waitlist_reviewed_at: now,
        waitlist_review_notes: notes,
    };

    let invite = null;
    if (sendInvite) {
        if (!normalizeEmail(customer.email)) {
            return res.status(400).json({ success: false, error: 'Customer is missing an email; cannot generate invite' });
        }
        const inviteResult = await createInviteForCustomer(
            normalizeEmail(customer.email),
            previous.waitlist_name || customer.name || customer.email || '',
            customer.id
        );

        if (!inviteResult.ok) {
            return res.status(500).json({ success: false, error: inviteResult.error || 'Could not create invite' });
        }

        invite = inviteResult;
        metadata.waitlist_status = 'invited';
        metadata.waitlist_invited_at = now;
    }

    const updated = await stripe.customers.update(customer.id, { metadata });
    return res.status(200).json({
        success: true,
        entry: mapWaitlistCustomer(updated),
        invite,
    });
}

module.exports = async function handler(req, res) {
    setCors(res);

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (!process.env.STRIPE_SECRET_KEY) {
        return res.status(500).json({ success: false, error: 'STRIPE_SECRET_KEY not configured' });
    }

    try {
        if (req.method === 'POST') return await handlePublicSubmit(req, res);
        if (req.method === 'GET') return await handleAdminList(req, res);
        if (req.method === 'PATCH') return await handleAdminUpdate(req, res);
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    } catch (err) {
        console.error('Waitlist API error:', err.message);
        return res.status(500).json({ success: false, error: 'Waitlist request failed' });
    }
};
