import { CONFIG } from './config.js';

const request = async (host, path, { token, method = 'GET', body, idempotencyKey } = {}) => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CONFIG.httpTimeoutMs);
	try {
		const headers = { Accept: 'application/json' };
		if (token) headers.Authorization = `Bearer ${token}`;
		if (body) headers['Content-Type'] = 'application/json';
		// Mastodon drops a repeated post carrying a key it has already seen, so a
		// retry after a timeout cannot put a second bot reply in the thread.
		if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
		const response = await fetch(`https://${host}${path}`, {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});
		if (!response.ok) {
			const error = new Error(`mastodon_${response.status}`);
			error.status = response.status;
			throw error;
		}
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
};

/**
 * Who the caller is, according to their own instance.
 *
 * The app sends the user's Mastodon token and the bridge asks Mastodon to
 * identify it. That way the bridge never stores a password, never trusts an
 * account id sent by the caller, and a stolen or expired token simply fails.
 */
export const verifyAccount = async (host, token) => {
	const account = await request(host, '/api/v1/accounts/verify_credentials', {
		token,
	});
	if (!account?.id || !account?.acct) throw new Error('unauthorized');
	return { id: String(account.id), acct: String(account.acct) };
};

export const getStatus = (host, token, statusId) =>
	request(host, `/api/v1/statuses/${encodeURIComponent(statusId)}`, { token });

export const getContext = (host, token, statusId) =>
	request(host, `/api/v1/statuses/${encodeURIComponent(statusId)}/context`, {
		token,
	});

/**
 * The whole thread as the bot will read it: the first post, then every reply in
 * time order. The pressed status may be anywhere inside it, so ancestors and
 * descendants are joined and the earliest post becomes the root.
 */
export const loadConversation = async (host, token, statusId) => {
	const [status, context] = await Promise.all([
		getStatus(host, token, statusId),
		getContext(host, token, statusId),
	]);
	// A boost carries no text of its own; the conversation is the boosted post's.
	const subject = status.reblog || status;
	const subjectContext = status.reblog
		? await getContext(host, token, subject.id)
		: context;
	// A reply's context only holds its own branch, so a press on one reply would
	// miss the others. The root's context holds the whole conversation.
	const top = subjectContext.ancestors?.[0];
	const topContext = top ? await getContext(host, token, top.id) : null;
	const posts = [
		...(subjectContext.ancestors || []),
		subject,
		...(subjectContext.descendants || []),
		...(topContext?.descendants || []),
	];
	const byId = new Map();
	for (const post of posts) {
		if (post?.id && !byId.has(String(post.id))) byId.set(String(post.id), post);
	}
	const ordered = [...byId.values()].sort((a, b) => {
		const left = Date.parse(a.created_at) || 0;
		const right = Date.parse(b.created_at) || 0;
		if (left !== right) return left - right;
		return String(a.id).localeCompare(String(b.id));
	});
	const root = ordered[0];
	if (!root) throw new Error('empty_conversation');
	return {
		root,
		replies: ordered.slice(1),
		/** Every id in this thread, so the app can match any lotus on screen. */
		statusIds: ordered.map(post => String(post.id)),
		subject,
		subjectId: String(subject.id),
	};
};

export const postStatus = (host, token, { text, inReplyToId, visibility, language, idempotencyKey }) =>
	request(host, '/api/v1/statuses', {
		token,
		method: 'POST',
		idempotencyKey,
		body: {
			status: text,
			in_reply_to_id: inReplyToId,
			visibility,
			...(language ? { language } : {}),
		},
	});
