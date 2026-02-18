# Nexus — Codex Handoff Summary
**Date:** Feb 18, 2026
**Version:** 1.0.35-beta.1

## What Is Nexus
AI-powered desktop app (Electron 28 + React 18 + Vite + Python FastAPI backend) that automates job applications across LinkedIn, Indeed, Glassdoor. Built by Hyperfect LLC.

## Architecture

### Desktop App (`/` root)
- **Electron entry:** `frontend/electron/main.cjs` (with `preload.cjs`, `updater.cjs`)
- **React frontend:** `frontend/src/` — Vite bundled, pages: Dashboard, Tasks, Profiles, Accounts, Settings
- **Python backend:** `backend/` — FastAPI server (`backend/api/server.py`), platform integrations in `backend/platforms/` (LinkedIn, Indeed, Glassdoor)
- **License gate:** `frontend/src/components/LicenseGate.jsx` — validates keys against `https://www.hyperfect.dev/api/validate-license`, 7-day offline grace, localStorage cached
- **App icon:** `build/app-icon.png` (1024x1024, blue N mark)
- **electron-builder config:** in root `package.json` under `"build"` key. Builds DMG/ZIP (mac x64+arm64), NSIS/portable (win x64), AppImage/deb (linux)

### Landing Page (`/landing-page/` — separate repo: Sacfu/hyperfect-site)
Deployed to Vercel at `www.hyperfect.dev`. Static HTML + Vercel serverless API functions.

**Key files:**
- `index.html` — main landing page with Discord OAuth login, download gating
- `success.html` — post-purchase page, polls for license key display
- `vercel.json` — rewrites `/success` → `success.html`, CORS headers (wildcard for validate-license, restricted for others)

**API endpoints (Vercel serverless, `/landing-page/api/`):**
- `create-checkout.js` — creates Stripe checkout session (POST, body: `{priceId, mode, customerEmail}`)
- `create-payment-link.js` — creates reusable Stripe payment links (POST, admin-auth required)
- `generate-invite.js` — creates one-time beta checkout URLs (POST, admin-auth via Bearer token, body: `{email, name}`)
- `get-license.js` — retrieves license key by Stripe session ID (GET, `?session_id=cs_xxx`). Handles $0 checkouts by searching customers by email as fallback
- `validate-license.js` — validates license keys against Stripe customer metadata (POST, body: `{licenseKey}`, CORS: `*`)
- `webhook.js` — Stripe webhook handler. On `checkout.session.completed`: generates NEXUS-XXXX-XXXX-XXXX-XXXX key, stores on Stripe customer metadata (creates customer if needed for $0 checkouts), emails key via Resend
- `download.js` — Discord-gated downloads. Checks server membership via bot before returning GCS download URL (POST, body: `{token, platform}`)
- `discord-bot.js` — Discord interactions endpoint for slash commands. `/invite email name` generates beta checkout links. Restricted by ADMIN_ROLE_ID
- `discord-register.js` — one-time endpoint to register slash commands with Discord (POST, admin-auth)

### CI/CD (`.github/workflows/build-and-release.yml`)
Triggers on `v*` tags. Builds macOS (x64+arm64), Windows (x64), Linux (x64) in parallel, then creates GitHub Release with all artifacts. macOS builds are signed+notarized when certs are present.

## Services & Environment Variables

### Vercel env vars (landing page):
- `STRIPE_SECRET_KEY` — Stripe live secret key
- `STRIPE_WEBHOOK_SECRET` — webhook signing secret
- `BETA_PRICE_ID` — Stripe price ID for $0 beta product
- `SITE_URL` — `https://hyperfect.dev`
- `ADMIN_SECRET` — `ULD1ArIu6IAkZBO0hKMQrrqRFTKb6sQVchSei0eAJkM`
- `RESEND_API_KEY` — Resend transactional email API key
- `DISCORD_BOT_TOKEN` — Discord bot token
- `DISCORD_GUILD_ID` — Discord server ID
- `DISCORD_PUBLIC_KEY` — Discord app public key (for interaction signature verification)
- `DISCORD_CLIENT_ID` — `1472604757687275723`
- `ADMIN_ROLE_ID` — Discord role ID required to use bot commands (not yet set)
- `DOWNLOAD_URL_MAC_ARM64` — `https://storage.googleapis.com/hyperfect-nexus-releases/Nexus-1.0.34-mac-arm64.dmg`
- `DOWNLOAD_URL_WIN` — `https://storage.googleapis.com/hyperfect-nexus-releases/Nexus-1.0.34-win-x64.exe`
- `DOWNLOAD_URL_LINUX` — `https://storage.googleapis.com/hyperfect-nexus-releases/Nexus-1.0.34-linux-x86_64.AppImage`
- (TODO) `DOWNLOAD_URL_MAC_X64` — needs to be added after x64 build completes

### External services:
- **Stripe** — payments, customer metadata stores license keys
- **Resend** — transactional email from `noreply@admin.hyperfect.dev`
- **GCS bucket** — `hyperfect-nexus-releases` (public), hosts installer binaries
- **Discord** — OAuth for download gating, bot for admin commands
- **GitHub Actions** — CI/CD builds
- **Vercel** — hosting for landing page + API
- **FormSubmit.co** — contact/waitlist forms

### Key IDs:
- Stripe product: `prod_TzyNyXUxPhMKsg` (Nexus Pro, $0 beta)
- Discord app client ID: `1472604757687275723`
- Discord permanent invite: `https://discord.gg/Ynvcw6Dts4`
- GA tracking: `G-8YDQ0S2021`

## Known Issues & Important Notes
1. **Domain redirect:** `hyperfect.dev` redirects to `www.hyperfect.dev`. ALL API calls, webhook URLs, and fetch requests MUST use `www.hyperfect.dev` to avoid POST→GET redirect stripping.
2. **$0 Stripe checkouts:** Don't auto-create customers. Webhook creates one manually and stores license key. `get-license.js` falls back to email-based customer search.
3. **macOS builds:** v1.0.35-beta.1 should produce both arm64 and x64 DMGs. Previous builds were arm64 only.
4. **License key format:** `NEXUS-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}` (25 chars with dashes)
5. **Webhook URL in Stripe must be:** `https://www.hyperfect.dev/api/webhook`

## Development Workflow
- `npm run dev` — runs backend + frontend + Electron with hot reload
- Changes to React components in `frontend/src/` reflect immediately
- Changes to Python backend in `backend/` require restart
- Landing page changes: push to `Sacfu/hyperfect-site` → auto-deploys on Vercel
- App releases: bump version in both package.json files → push tag → CI builds → upload to GCS

## Upcoming Work (Priority Order)

### HIGH — Beta-Critical
1. **End-to-end test the full user flow:** Generate invite → checkout → receive email → download from Discord → install → activate license → use app. Verify on both macOS arm64 and x64.
2. **Upload v1.0.35 binaries to GCS** after CI completes (including new x64 DMG). Update Vercel env vars with new URLs.
3. **Discord bot setup:** Add DISCORD_PUBLIC_KEY to Vercel, set interactions endpoint URL in Discord Developer Portal, register commands, add ADMIN_ROLE_ID.
4. **Test license validation end-to-end** in the actual Electron app (not just browser).
5. **Backend functionality audit:** The Python backend (`backend/api/server.py` is 79.6KB) handles job platform automation. Needs testing with real LinkedIn/Indeed/Glassdoor accounts to verify:
   - Login/session persistence
   - Job search and filtering
   - Application submission
   - Resume parsing and profile matching

### MEDIUM — Polish
6. **Auto-updater:** `frontend/electron/updater.cjs` exists but needs wiring to check for updates from GitHub Releases or a custom update server.
7. **Onboarding flow:** `OnboardingWrapper.jsx` and `Onboarding.jsx` exist — verify they work after license activation, pointer-events fix is applied.
8. **Error handling in LicenseGate:** Better UX for network failures, expired keys, server errors.
9. **Add pricing section to landing page** with real checkout button for when you go paid.
10. **Discord auto-role on purchase:** User requested auto-adding buyers to Discord server. Would need `guilds.join` OAuth scope + bot with manage members permission.

### LOW — Nice to Have
11. **Admin dashboard:** Build a simple page to view all licenses, revoke keys, see usage stats. Currently done through Stripe Dashboard.
12. **Analytics:** Track activation rates, daily active users, feature usage.
13. **Windows code signing:** Currently unsigned. Need a code signing certificate for Windows builds.
14. **Universal macOS binary:** Instead of separate x64/arm64 DMGs, could produce a single universal binary.
15. **Rate limiting on API endpoints** to prevent abuse.

## File Tree (Key Files)
```
nexus/
├── .github/workflows/build-and-release.yml  # CI/CD
├── build/app-icon.png                        # App icon (1024x1024)
├── package.json                              # v1.0.35, electron-builder config
├── frontend/
│   ├── package.json                          # v1.0.35
│   ├── electron/
│   │   ├── main.cjs                          # Electron main process
│   │   ├── preload.cjs                       # IPC bridge
│   │   └── updater.cjs                       # Auto-update logic
│   └── src/
│       ├── App.jsx                           # Root: LicenseGate → AppProvider → AppContent
│       ├── main.jsx                          # React entry
│       ├── components/
│       │   ├── LicenseGate.jsx               # License activation gate
│       │   ├── Onboarding.jsx                # First-run onboarding
│       │   ├── OnboardingWrapper.jsx         # Onboarding state manager
│       │   ├── Sidebar.jsx                   # Navigation sidebar
│       │   ├── CreateTaskModal.jsx           # New task creation
│       │   └── TaskDetailModal.jsx           # Task detail view
│       ├── contexts/AppContext.jsx            # Global app state
│       ├── pages/
│       │   ├── Dashboard.jsx
│       │   ├── Tasks.jsx
│       │   ├── Profiles.jsx
│       │   ├── Accounts.jsx
│       │   └── Settings.jsx
│       └── styles/theme.js
├── backend/
│   ├── api/server.py                         # FastAPI server (79.6KB)
│   ├── core/
│   │   ├── config.py
│   │   ├── licensing.py
│   │   ├── session.py
│   │   └── session_manager.py
│   ├── platforms/
│   │   ├── linkedin/linkedin_platform.py
│   │   ├── indeed/indeed_platform.py
│   │   └── glassdoor/glassdoor_platform.py
│   └── requirements.txt
└── landing-page/                             # Separate repo: Sacfu/hyperfect-site
    ├── index.html                            # Main landing page (~2463 lines)
    ├── success.html                          # Post-purchase license display
    ├── vercel.json                           # Routing + CORS
    ├── package.json                          # Stripe dependency
    ├── api/
    │   ├── create-checkout.js
    │   ├── create-payment-link.js
    │   ├── generate-invite.js
    │   ├── get-license.js
    │   ├── validate-license.js
    │   ├── webhook.js
    │   ├── download.js
    │   ├── discord-bot.js
    │   └── discord-register.js
    └── assets/brand/                         # SVG logos + stripe-product.png
```
