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
            description: 'Generate a beta checkout link for a tester',
            options: [
                {
                    name: 'email',
                    description: "The tester's email address",
                    type: 3, // STRING
                    required: true,
                },
                {
                    name: 'name',
                    description: "The tester's name (optional)",
                    type: 3, // STRING
                    required: false,
                },
            ],
        },
        {
            name: 'waitlist-list',
            description: 'List waitlist entries by status',
            options: [
                {
                    name: 'status',
                    description: 'Filter status',
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
                    description: 'How many entries to return (1-25)',
                    type: 4, // INTEGER
                    required: false,
                    min_value: 1,
                    max_value: 25,
                },
            ],
        },
        {
            name: 'waitlist-status',
            description: 'Get one waitlist entry by email',
            options: [
                {
                    name: 'email',
                    description: 'Waitlist email',
                    type: 3, // STRING
                    required: true,
                },
            ],
        },
        {
            name: 'waitlist-add',
            description: 'Add or update a waitlist entry',
            options: [
                {
                    name: 'email',
                    description: 'Waitlist email',
                    type: 3, // STRING
                    required: true,
                },
                {
                    name: 'name',
                    description: 'Optional name for the entry',
                    type: 3, // STRING
                    required: false,
                },
                {
                    name: 'notes',
                    description: 'Optional notes/interest',
                    type: 3, // STRING
                    required: false,
                },
            ],
        },
        {
            name: 'waitlist-approve',
            description: 'Approve a waitlist entry',
            options: [
                {
                    name: 'email',
                    description: 'Waitlist email',
                    type: 3, // STRING
                    required: true,
                },
                {
                    name: 'notes',
                    description: 'Optional internal notes',
                    type: 3, // STRING
                    required: false,
                },
            ],
        },
        {
            name: 'waitlist-reject',
            description: 'Reject a waitlist entry',
            options: [
                {
                    name: 'email',
                    description: 'Waitlist email',
                    type: 3, // STRING
                    required: true,
                },
                {
                    name: 'reason',
                    description: 'Reason for rejection',
                    type: 3, // STRING
                    required: true,
                },
            ],
        },
        {
            name: 'waitlist-invite',
            description: 'Add if needed, approve, and generate invite link',
            options: [
                {
                    name: 'email',
                    description: 'Waitlist email',
                    type: 3, // STRING
                    required: true,
                },
                {
                    name: 'notes',
                    description: 'Optional review notes',
                    type: 3, // STRING
                    required: false,
                },
                {
                    name: 'name',
                    description: 'Optional name when creating missing entries',
                    type: 3, // STRING
                    required: false,
                },
            ],
        },
    ];

    const clientId = process.env.DISCORD_CLIENT_ID || '1472604757687275723';
    const guildId = process.env.DISCORD_GUILD_ID;
    const authHeaders = {
        'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
    };

    if (!process.env.DISCORD_BOT_TOKEN) {
        return res.status(500).json({ error: 'DISCORD_BOT_TOKEN is not configured' });
    }

    try {
        const registerResults = {};

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
                registerResults.guild_error = guildData;
            } else {
                registerResults.guild = guildData.map(c => ({ name: c.name, id: c.id }));
            }
        }

        return res.status(200).json({
            success: true,
            commands: registerResults,
            message: guildId
                ? 'Slash commands registered globally and for guild scope (guild appears almost instantly).'
                : 'Slash commands registered globally. They may take up to 1 hour to appear.',
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
