// Every value the bridge needs comes from the environment, so no key, token or
// instance host is written down in this repository.

/**
 * Instances the bridge will talk to, with the bot token it posts as.
 *
 * CALM_INSTANCES is a comma separated list of ids, and each id has its own
 * host and bot token:
 *
 *   CALM_INSTANCES=pouet
 *   CALM_POUET_HOST=pouetfrance.social
 *   CALM_POUET_BOT_TOKEN=...
 *
 * Adding a second instance (ouest, humanite) is two more variables, no code.
 */
const instanceEnvKey = id => id.toUpperCase().replace(/[^A-Z0-9]/g, '_');

const normalizeHost = value =>
	String(value || '')
		.trim()
		.replace(/^https?:\/\//i, '')
		.replace(/\/+$/, '')
		.toLowerCase();

const readInstances = () => {
	const ids = String(process.env.CALM_INSTANCES || '')
		.split(',')
		.map(id => id.trim().toLowerCase())
		.filter(Boolean);
	const instances = new Map();
	for (const id of ids) {
		const key = instanceEnvKey(id);
		const host = normalizeHost(process.env[`CALM_${key}_HOST`]);
		const botToken = String(process.env[`CALM_${key}_BOT_TOKEN`] || '').trim();
		// An instance without both values stays unusable rather than half working.
		if (host && botToken) instances.set(id, { id, host, botToken });
	}
	return instances;
};

/**
 * The allowlist is the bridge's main protection: the app sends an instance id,
 * never a host, so a caller can never make the bridge call an arbitrary server.
 */
export const getInstance = id => {
	const instances = readInstances();
	return instances.get(String(id || '').trim().toLowerCase()) || null;
};

export const getInstanceIds = () => [...readInstances().keys()];

export const CONFIG = {
	// How long one thread stays locked while the bot is working. A crashed run
	// releases the lotus by itself instead of spinning forever.
	lockTtlSeconds: 180,
	// How long a calmed thread is remembered, so the lotus stays red. The bot may
	// still be asked again once the conversation has moved on; what prevents a
	// second reply is the last post being the bot's, not this key.
	doneTtlSeconds: 60 * 60 * 24 * 30,
	// How long the bot's own account id is remembered, so recognising its replies
	// costs one Mastodon call rather than one per press.
	botIdentityTtlSeconds: 60 * 60 * 24,
	// Status ids one state request may ask about (about two feed pages).
	maxStateIds: 60,
	// Posts of one thread remembered for the lotus. A longer thread only leaves
	// its later replies plain; the root still holds the lock.
	maxThreadIds: 200,
	// How long a token Mastodon accepted is trusted for state reads.
	sessionTtlSeconds: 300,
	// Replies sent to the model. The app used the same bound.
	maxReplies: 50,
	// Characters of conversation JSON sent to the model.
	maxConversationCharacters: 16000,
	mistral: {
		endpoint: 'https://api.mistral.ai/v1/chat/completions',
		model: process.env.MISTRAL_MODEL?.trim() || 'mistral-small-latest',
		temperature: 0.1,
		maxTokens: 250,
		timeoutMs: 30000,
	},
	// Mastodon's own limit is 500; the mention needs room inside it.
	maxStatusCharacters: 500,
	httpTimeoutMs: 15000,
};
