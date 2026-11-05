import { createHash } from 'node:crypto';
import { CONFIG } from './config.js';
import { CalmError } from './conversation.js';
import { getKv } from './kv.js';
import { verifyAccount } from './mastodon.js';

// A hash, so a read of Redis never gives anyone a usable Mastodon token.
const sessionKey = (instanceId, token) =>
	`calm:session:${instanceId}:${createHash('sha256').update(token).digest('hex')}`;

/**
 * Checks a token with its Mastodon server before a read.
 *
 * A feed asks about states on every scroll, so a token that passed is
 * remembered for a few minutes instead of calling Mastodon each time. A token
 * revoked in that window keeps working until the entry expires.
 */
export const verifySession = async (instance, token) => {
	const kv = await getKv();
	const key = sessionKey(instance.id, token);
	if (await kv.get(key)) return;
	try {
		await verifyAccount(instance.host, token);
	} catch (error) {
		const rejected = error?.status === 401 || error?.status === 403;
		throw rejected || error?.message === 'unauthorized'
			? new CalmError('unauthorized', 401)
			: new CalmError('mastodon_unavailable', 502);
	}
	await kv.set(key, 1, { ex: CONFIG.sessionTtlSeconds });
};
