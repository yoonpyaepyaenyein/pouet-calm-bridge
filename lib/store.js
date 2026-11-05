import { CONFIG } from './config.js';
import { getKv } from './kv.js';

// One key per thread. The thread's root status id is the identity, so pressing
// the lotus on a reply and on the original post reach the same thread.
const threadKey = (instanceId, rootId) => `calm:${instanceId}:${rootId}`;

/**
 * The lock is a separate, short lived key.
 *
 * It has to be separate from the state above, because a calmed thread keeps its
 * `done` state for a month and may still be calmed again once the conversation
 * has moved on. Were they one key, `nx` would refuse every later press.
 */
const lockKey = (instanceId, rootId) => `calm:lock:${instanceId}:${rootId}`;

/** The thread's other posts, whose keys only tell readers what the lotus shows. */
const replyIds = (rootId, statusIds = []) =>
	statusIds.filter(id => id !== rootId).slice(0, CONFIG.maxThreadIds);

/**
 * Copies a thread's state onto its replies, so a reader who only sees a reply
 * gets the same lotus. The root's key stays the lock, and a reply that misses
 * its copy just shows a plain lotus, so a failure here never fails the run.
 */
const markReplies = async (kv, { instanceId, rootId, statusIds, state, ex }) => {
	await Promise.allSettled(
		replyIds(rootId, statusIds).map(id =>
			kv.set(threadKey(instanceId, id), { state }, { ex }),
		),
	);
};

/**
 * Takes the lock for a thread, or reports who already holds it.
 *
 * `nx` makes Redis write the key only when it does not exist yet, so when two
 * people press the lotus at the same moment exactly one request gets `claimed`
 * and the other is told the thread is already loading. That is what replaces a
 * job queue: no worker, no ordering, just one winner per thread.
 */
export const claimThread = async ({
	instanceId,
	rootId,
	requester,
	statusIds,
}) => {
	const kv = await getKv();
	const claimed = await kv.set(
		lockKey(instanceId, rootId),
		{ requester: requester || null, startedAt: Date.now() },
		{ ex: CONFIG.lockTtlSeconds, nx: true },
	);
	if (claimed !== 'OK') {
		// Someone else is mid-run. The lotus shows loading either way, so the
		// second caller is told that rather than starting a second bot reply.
		return { claimed: false, entry: { state: 'loading' } };
	}
	// What the lotus showed before this run, so a failure can put it back: a
	// thread calmed last week must not turn white because a later press failed.
	const previous = await kv.get(threadKey(instanceId, rootId));
	const entry = { state: 'loading', startedAt: Date.now() };
	await kv.set(threadKey(instanceId, rootId), entry, {
		ex: CONFIG.lockTtlSeconds,
	});
	await markReplies(kv, {
		instanceId,
		rootId,
		statusIds,
		state: 'loading',
		ex: CONFIG.lockTtlSeconds,
	});
	return { claimed: true, entry, previousState: previous?.state || null };
};

/** The bot answered: keep it long enough that the lotus stays red. */
export const finishThread = async ({
	instanceId,
	rootId,
	botStatusId,
	statusIds,
}) => {
	const kv = await getKv();
	// Restoring an earlier `done` passes no id; keep the one already stored.
	const known = botStatusId
		? String(botStatusId)
		: (await kv.get(threadKey(instanceId, rootId)))?.botStatusId || null;
	await kv.set(
		threadKey(instanceId, rootId),
		{ state: 'done', botStatusId: known, finishedAt: Date.now() },
		{ ex: CONFIG.doneTtlSeconds },
	);
	await markReplies(kv, {
		instanceId,
		rootId,
		statusIds,
		state: 'done',
		ex: CONFIG.doneTtlSeconds,
	});
	await kv.del(lockKey(instanceId, rootId));
};

/**
 * The run ended without a new reply: free the lock and put the lotus back as it
 * was. `previousState` is `done` when the thread had already been calmed, so a
 * failed second press leaves the earlier reply's red lotus alone.
 */
export const releaseThread = async ({
	instanceId,
	rootId,
	statusIds,
	previousState = null,
}) => {
	const kv = await getKv();
	if (previousState === 'done') {
		await finishThread({ instanceId, rootId, statusIds });
		return;
	}
	await kv.del(
		threadKey(instanceId, rootId),
		...replyIds(rootId, statusIds).map(id => threadKey(instanceId, id)),
	);
	await kv.del(lockKey(instanceId, rootId));
};

export const readThread = async ({ instanceId, rootId }) => {
	const kv = await getKv();
	return (await kv.get(threadKey(instanceId, rootId))) || null;
};

/**
 * The bot's own account id, remembered so that recognising its replies costs
 * one Mastodon call a day rather than one per press. Only the id is stored,
 * never the bot token.
 */
export const readBotIdentity = async instanceId => {
	const kv = await getKv();
	const entry = await kv.get(`calm:bot:${instanceId}`);
	return entry?.id ? String(entry.id) : null;
};

export const rememberBotIdentity = async (instanceId, id) => {
	const kv = await getKv();
	await kv.set(
		`calm:bot:${instanceId}`,
		{ id: String(id) },
		{ ex: CONFIG.botIdentityTtlSeconds },
	);
};

/**
 * States for the status ids on one screen, in a single round trip.
 *
 * The app does not know which post starts a thread, so it sends every id it is
 * showing and the bridge answers for the ones it knows about.
 */
export const readThreadStates = async ({ instanceId, ids }) => {
	if (!ids.length) return {};
	const kv = await getKv();
	const entries = await kv.mget(...ids.map(id => threadKey(instanceId, id)));
	const states = {};
	ids.forEach((id, index) => {
		const entry = entries[index];
		if (entry?.state === 'loading' || entry?.state === 'done') {
			states[id] = entry.state;
		}
	});
	return states;
};
