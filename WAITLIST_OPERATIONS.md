# Nexus Waitlist Operations

This document explains how the new waitlist flow works and how to operate approvals.

## Overview

Waitlist submissions now go to `/api/waitlist` and are stored on Stripe customers via metadata.

No paid database is required for this phase.

## Data Model (Stripe customer metadata)

- `waitlist=true`
- `waitlist_status=pending|approved|rejected|invited|converted`
- `waitlist_name`
- `waitlist_interest`
- `waitlist_source`
- `waitlist_consent=true|false`
- `waitlist_submission_count`
- `waitlist_last_submitted_at`
- `waitlist_created_at`
- `waitlist_updated_at`
- `waitlist_review_notes` (admin)
- `waitlist_invited_at` (admin)
- `waitlist_converted_at` (webhook)

## Endpoints

### Public submit

`POST /api/waitlist`

Body:

```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "message": "I want to automate my daily applications.",
  "consent": true,
  "source": "website_waitlist"
}
```

### Admin list

`GET /api/waitlist?status=pending&limit=50`

Headers:

`Authorization: Bearer <ADMIN_SECRET>`

### Admin update / approve / invite

`PATCH /api/waitlist`

Headers:

`Authorization: Bearer <ADMIN_SECRET>`

Body example (approve + invite):

```json
{
  "customer_id": "cus_123",
  "status": "approved",
  "send_invite": true,
  "notes": "Great fit for beta."
}
```

## Admin UI

A simple internal admin page is included:

- `/waitlist-admin.html`

This page asks for your `ADMIN_SECRET` and calls the waitlist endpoints.

## Required environment variables (Vercel)

- `STRIPE_SECRET_KEY`
- `ADMIN_SECRET`
- `BETA_PRICE_ID` (required for invite generation)
- `SITE_URL` (recommended `https://www.hyperfect.dev`)

## Deployment checklist

1. Push `landing-page` changes to `Sacfu/hyperfect-site`.
2. Confirm Vercel deploy succeeds.
3. Open `/waitlist-admin.html`, load pending entries, test:
   - approve
   - approve + invite
   - reject
4. Verify approved+invite returns Stripe checkout URL.
5. Complete one invite checkout and confirm status becomes `converted` in Stripe metadata.
