// Vercel Serverless Function: Gated Download
// Checks if the user is a member of the Nexus Discord server
// before returning the download URL.
//
// Environment Variables:
//   DISCORD_BOT_TOKEN — Bot token from Discord Developer Portal
//   DISCORD_GUILD_ID — Your Discord server ID
//   DOWNLOAD_URL_MAC_ARM64 — GCS/S3 URL for macOS ARM64 DMG
//   DOWNLOAD_URL_MAC_X64 — GCS/S3 URL for macOS x64 DMG
//   DOWNLOAD_URL_WIN — GCS/S3 URL for Windows installer
//   DOWNLOAD_URL_LINUX — GCS/S3 URL for Linux AppImage
//
// Frontend sends: POST /api/download
// Body: { "accessToken": "<discord oauth token>", "platform": "mac-arm64"|"mac-x64"|"win"|"linux" }

module.exports = async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', 'https://hyperfect.dev');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { accessToken, platform } = req.body || {};

    if (!accessToken) {
        return res.status(401).json({ error: 'Discord access token required' });
    }

    const GUILD_ID = process.env.DISCORD_GUILD_ID;
    const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

    if (!GUILD_ID || !BOT_TOKEN) {
        console.error('Missing DISCORD_GUILD_ID or DISCORD_BOT_TOKEN');
        return res.status(500).json({ error: 'Server configuration error' });
    }

    try {
        // Step 1: Get the user's Discord ID from their OAuth token
        const userRes = await fetch('https://discord.com/api/v10/users/@me', {
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!userRes.ok) {
            return res.status(401).json({ error: 'Invalid Discord token' });
        }

        const user = await userRes.json();

        // Step 2: Check if the user is in the Discord server using the bot token
        const memberRes = await fetch(
            `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${user.id}`,
            { headers: { Authorization: `Bot ${BOT_TOKEN}` } }
        );

        if (memberRes.status === 404) {
            return res.status(403).json({
                error: 'not_member',
                message: 'You need to join our Discord server first to download Nexus.',
                invite: 'https://discord.gg/Ynvcw6Dts4',
            });
        }

        if (!memberRes.ok) {
            console.error('Discord API error:', memberRes.status, await memberRes.text());
            return res.status(500).json({ error: 'Could not verify Discord membership' });
        }

        // Step 3: Return the download URL for the requested platform
        const urls = {
            'mac-arm64': process.env.DOWNLOAD_URL_MAC_ARM64,
            'mac-x64': process.env.DOWNLOAD_URL_MAC_X64,
            'win': process.env.DOWNLOAD_URL_WIN,
            'linux': process.env.DOWNLOAD_URL_LINUX,
        };

        const downloadUrl = urls[platform] || urls['mac-arm64'];

        if (!downloadUrl) {
            return res.status(500).json({ error: 'Download URL not configured for this platform' });
        }

        return res.status(200).json({
            downloadUrl,
            user: { id: user.id, username: user.username },
        });

    } catch (err) {
        console.error('Download gate error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};
