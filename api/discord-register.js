// Vercel Serverless Function: Register Discord Slash Commands
// Run this ONCE to register the /invite command with Discord.
//
// Usage: POST /api/discord-register
// Headers: Authorization: Bearer <ADMIN_SECRET>
//
// Environment Variables:
//   DISCORD_BOT_TOKEN — bot token
//   DISCORD_CLIENT_ID — application client ID (1472604757687275723)
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
    ];

    const clientId = process.env.DISCORD_CLIENT_ID || '1472604757687275723';

    try {
        const response = await fetch(
            `https://discord.com/api/v10/applications/${clientId}/commands`,
            {
                method: 'PUT',
                headers: {
                    'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(commands),
            }
        );

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json({ error: data });
        }

        return res.status(200).json({
            success: true,
            commands: data.map(c => ({ name: c.name, id: c.id })),
            message: 'Slash commands registered. They may take up to 1 hour to appear globally.',
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
