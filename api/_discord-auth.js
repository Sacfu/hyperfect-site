const DISCORD_API_BASE = 'https://discord.com/api/v10';

function cleanText(value, maxLen = 240) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLen);
}

async function verifyDiscordAdmin(accessToken) {
    const token = cleanText(accessToken, 2048);
    if (!token) {
        return { ok: false, reason: 'missing_access_token' };
    }

    const guildId = cleanText(process.env.DISCORD_GUILD_ID, 64);
    const botToken = cleanText(process.env.DISCORD_BOT_TOKEN, 256);
    const adminRoleId = cleanText(process.env.ADMIN_ROLE_ID, 64);

    if (!guildId || !botToken || !adminRoleId) {
        return { ok: false, reason: 'missing_server_config' };
    }

    const userRes = await fetch(`${DISCORD_API_BASE}/users/@me`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) {
        return { ok: false, reason: 'invalid_discord_token', status: userRes.status };
    }

    const user = await userRes.json().catch(() => null);
    if (!user?.id) {
        return { ok: false, reason: 'invalid_discord_user' };
    }

    const memberRes = await fetch(`${DISCORD_API_BASE}/guilds/${guildId}/members/${user.id}`, {
        headers: { Authorization: `Bot ${botToken}` },
    });
    if (memberRes.status === 404) {
        return { ok: false, reason: 'not_in_server', user };
    }
    if (!memberRes.ok) {
        return { ok: false, reason: 'discord_member_lookup_failed', status: memberRes.status, user };
    }

    const member = await memberRes.json().catch(() => null);
    const roles = Array.isArray(member?.roles) ? member.roles : [];
    if (!roles.includes(adminRoleId)) {
        return { ok: false, reason: 'not_admin_role', user, roles };
    }

    return {
        ok: true,
        reason: 'ok',
        user: {
            id: user.id,
            username: cleanText(user.username, 120),
            global_name: cleanText(user.global_name, 120),
            discriminator: cleanText(user.discriminator, 10),
        },
        roles,
    };
}

module.exports = {
    verifyDiscordAdmin,
};
