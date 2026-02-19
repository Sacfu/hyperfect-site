// Vercel Serverless Function: Register Discord Slash Commands
// Registers admin slash commands used for invites + waitlist operations.
//
// Usage: POST /api/discord-register
// Headers: Authorization: Bearer <ADMIN_SECRET>
//
// Environment Variables:
//   DISCORD_BOT_TOKEN — bot token
//   DISCORD_CLIENT_ID — application client ID (1472604757687275723)
//   DISCORD_GUILD_ID — (optional) guild/server ID for instant command availability
//   ADMIN_SECRET — admin secret to protect this endpoint

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const auth = req.headers.authorization?.replace('Bearer ', '');
    if (auth !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const commands = [
        {
            name: 'invite',
            description: 'Admin: generate a beta checkout link',
            options: [
                {
                    name: 'email',
                    description: 'Tester email address',
                    type: 3, // STRING
                    required: true,
                },
                {
                    name: 'name',
                    description: 'Optional tester name',
                    type: 3, // STRING
                    required: false,
                },
            ],
        },
        {
            name: 'waitlist',
            description: 'Admin: review and invite waitlist entries',
            options: [
                {
                    name: 'action',
                    description: 'What to do',
                    type: 3, // STRING
                    required: true,
                    choices: [
                        { name: 'list', value: 'list' },
                        { name: 'status', value: 'status' },
                        { name: 'approve', value: 'approve' },
                        { name: 'reject', value: 'reject' },
                        { name: 'invite', value: 'invite' },
                    ],
                },
                {
                    name: 'email',
                    description: 'Email (required for status/approve/reject/invite)',
                    type: 3, // STRING
                    required: false,
                },
                {
                    name: 'status',
                    description: 'Status filter (used with list)',
                    type: 3, // STRING
                    required: false,
                    choices: [
                        { name: 'pending', value: 'pending' },
                        { name: 'approved', value: 'approved' },
                        { name: 'invited', value: 'invited' },
                        { name: 'converted', value: 'converted' },
                        { name: 'rejected', value: 'rejected' },
                        { name: 'all', value: 'all' },
                    ],
                },
                {
                    name: 'limit',
                    description: 'List size (1-25, used with list)',
                    type: 4, // INTEGER
                    required: false,
                    min_value: 1,
                    max_value: 25,
                },
                {
                    name: 'name',
                    description: 'Optional name (used for invite when creating missing entry)',
                    type: 3, // STRING
                    required: false,
                },
                {
                    name: 'notes',
                    description: 'Notes (required for reject action)',
                    type: 3, // STRING
                    required: false,
                },
            ],
        },
        {
            name: 'license-bind',
            description: 'Link your Discord account to your Nexus license',
            options: [
                {
                    name: 'license_key',
                    description: 'Your Nexus license key',
                    type: 3, // STRING
                    required: true,
                },
                {
                    name: 'email',
                    description: 'Optional purchase email for extra verification',
                    type: 3, // STRING
                    required: false,
                },
            ],
        },
    ];

    const clientId = process.env.DISCORD_CLIENT_ID || '1472604757687275723';
    const guildId = process.env.DISCORD_GUILD_ID;
    const registerGlobal = String(process.env.DISCORD_REGISTER_GLOBAL || '').trim().toLowerCase() === 'true';
    const authHeaders = {
        'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
    };

    if (!process.env.DISCORD_BOT_TOKEN) {
        return res.status(500).json({ error: 'DISCORD_BOT_TOKEN is not configured' });
    }

    try {
        const registerResults = {};
        if (guildId) {
            const guildResponse = await fetch(
                `https://discord.com/api/v10/applications/${clientId}/guilds/${guildId}/commands`,
                {
                    method: 'PUT',
                    headers: authHeaders,
                    body: JSON.stringify(commands),
                }
            );
            const guildData = await guildResponse.json();
            if (!guildResponse.ok) {
                return res.status(guildResponse.status).json({ error: guildData });
            }
            registerResults.guild = guildData.map(c => ({ name: c.name, id: c.id }));

            if (registerGlobal) {
                const globalResponse = await fetch(
                    `https://discord.com/api/v10/applications/${clientId}/commands`,
                    {
                        method: 'PUT',
                        headers: authHeaders,
                        body: JSON.stringify(commands),
                    }
                );
                const globalData = await globalResponse.json();
                if (!globalResponse.ok) {
                    registerResults.global_error = globalData;
                } else {
                    registerResults.global = globalData.map(c => ({ name: c.name, id: c.id }));
                }
            } else {
                // Prevent duplicate commands in guilds by clearing global command set.
                const clearGlobalResponse = await fetch(
                    `https://discord.com/api/v10/applications/${clientId}/commands`,
                    {
                        method: 'PUT',
                        headers: authHeaders,
                        body: JSON.stringify([]),
                    }
                );
                const clearGlobalData = await clearGlobalResponse.json().catch(() => ({}));
                registerResults.global_cleared = clearGlobalResponse.ok;
                if (!clearGlobalResponse.ok) {
                    registerResults.global_clear_error = clearGlobalData;
                }
            }
        } else {
            const globalResponse = await fetch(
                `https://discord.com/api/v10/applications/${clientId}/commands`,
                {
                    method: 'PUT',
                    headers: authHeaders,
                    body: JSON.stringify(commands),
                }
            );
            const globalData = await globalResponse.json();
            if (!globalResponse.ok) {
                return res.status(globalResponse.status).json({ error: globalData });
            }
            registerResults.global = globalData.map(c => ({ name: c.name, id: c.id }));
        }

        return res.status(200).json({
            success: true,
            commands: registerResults,
            message: guildId
                ? (registerGlobal
                    ? 'Commands registered for guild and global scope.'
                    : 'Commands registered for guild scope and global commands cleared to avoid duplicates.')
                : 'Commands registered globally. They may take up to 1 hour to appear.',
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
