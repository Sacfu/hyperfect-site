// Vercel Serverless Function: Register Discord Slash Commands
// Performs a forced cleanup + re-register to eliminate duplicate stale commands.
//
// Usage: POST /api/discord-register
// Headers: Authorization: Bearer <ADMIN_SECRET>

const COMMANDS = [
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

const DESIRED_NAMES = new Set(COMMANDS.map(command => command.name));
const LEGACY_NAMES = new Set([
    'waitlist-list',
    'waitlist-status',
    'waitlist-add',
    'waitlist-approve',
    'waitlist-reject',
    'waitlist-invite',
]);

function makeScopeUrls(clientId, guildId) {
    const global = `https://discord.com/api/v10/applications/${clientId}/commands`;
    const guild = guildId
        ? `https://discord.com/api/v10/applications/${clientId}/guilds/${guildId}/commands`
        : null;
    return { global, guild };
}

async function discordApi(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = { raw: text };
    }
    return { ok: response.ok, status: response.status, data };
}

function summarizeCommands(commands) {
    if (!Array.isArray(commands)) return [];
    return commands.map(command => ({
        id: command.id,
        name: command.name,
    }));
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const auth = req.headers.authorization?.replace('Bearer ', '');
    if (auth !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const botToken = process.env.DISCORD_BOT_TOKEN;
    if (!botToken) {
        return res.status(500).json({ error: 'DISCORD_BOT_TOKEN is not configured' });
    }

    const clientId = process.env.DISCORD_CLIENT_ID || '1472604757687275723';
    const guildId = process.env.DISCORD_GUILD_ID;
    const registerGlobal = String(process.env.DISCORD_REGISTER_GLOBAL || '').trim().toLowerCase() === 'true';
    const headers = {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
    };
    const urls = makeScopeUrls(clientId, guildId);

    const details = {
        guild_id: guildId || null,
        register_global: registerGlobal,
        before: {},
        after: {},
        cleanup: {
            removed_global: [],
            removed_guild: [],
        },
    };

    try {
        const beforeGlobal = await discordApi(urls.global, { method: 'GET', headers });
        details.before.global = summarizeCommands(beforeGlobal.data);

        if (urls.guild) {
            const beforeGuild = await discordApi(urls.guild, { method: 'GET', headers });
            details.before.guild = summarizeCommands(beforeGuild.data);
        }

        // Forced purge to avoid stale command collisions.
        const purgeGlobal = await discordApi(urls.global, {
            method: 'PUT',
            headers,
            body: JSON.stringify([]),
        });
        if (!purgeGlobal.ok) {
            return res.status(purgeGlobal.status).json({
                error: 'Failed to clear global commands',
                details: purgeGlobal.data,
            });
        }

        if (urls.guild) {
            const purgeGuild = await discordApi(urls.guild, {
                method: 'PUT',
                headers,
                body: JSON.stringify([]),
            });
            if (!purgeGuild.ok) {
                return res.status(purgeGuild.status).json({
                    error: 'Failed to clear guild commands',
                    details: purgeGuild.data,
                });
            }

            const writeGuild = await discordApi(urls.guild, {
                method: 'PUT',
                headers,
                body: JSON.stringify(COMMANDS),
            });
            if (!writeGuild.ok) {
                return res.status(writeGuild.status).json({
                    error: 'Failed to register guild commands',
                    details: writeGuild.data,
                });
            }

            if (registerGlobal) {
                const writeGlobal = await discordApi(urls.global, {
                    method: 'PUT',
                    headers,
                    body: JSON.stringify(COMMANDS),
                });
                if (!writeGlobal.ok) {
                    return res.status(writeGlobal.status).json({
                        error: 'Failed to register global commands',
                        details: writeGlobal.data,
                    });
                }
            } else {
                // Extra safety pass: remove any desired/legacy names lingering in global scope.
                const currentGlobal = await discordApi(urls.global, { method: 'GET', headers });
                if (currentGlobal.ok && Array.isArray(currentGlobal.data)) {
                    for (const command of currentGlobal.data) {
                        const name = String(command?.name || '').toLowerCase();
                        if (!DESIRED_NAMES.has(name) && !LEGACY_NAMES.has(name)) continue;
                        const removed = await discordApi(`${urls.global}/${command.id}`, {
                            method: 'DELETE',
                            headers,
                        });
                        if (removed.ok) {
                            details.cleanup.removed_global.push({ id: command.id, name });
                        }
                    }
                }
            }
        } else {
            const writeGlobal = await discordApi(urls.global, {
                method: 'PUT',
                headers,
                body: JSON.stringify(COMMANDS),
            });
            if (!writeGlobal.ok) {
                return res.status(writeGlobal.status).json({
                    error: 'Failed to register global commands',
                    details: writeGlobal.data,
                });
            }
        }

        const afterGlobal = await discordApi(urls.global, { method: 'GET', headers });
        details.after.global = summarizeCommands(afterGlobal.data);
        if (urls.guild) {
            const afterGuild = await discordApi(urls.guild, { method: 'GET', headers });
            details.after.guild = summarizeCommands(afterGuild.data);
        }

        return res.status(200).json({
            success: true,
            message: urls.guild
                ? (registerGlobal
                    ? 'Guild and global commands re-registered.'
                    : 'Guild commands re-registered and global scope purged.')
                : 'Global commands re-registered.',
            details,
            note: registerGlobal
                ? 'Discord may still cache command metadata briefly.'
                : 'If stale duplicates still show, Discord client cache/global propagation can take up to ~1 hour.',
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
