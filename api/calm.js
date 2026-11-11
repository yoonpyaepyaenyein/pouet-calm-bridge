import { keepAlive } from '../lib/background.js';
import { CONFIG, getInstance } from '../lib/config.js';
import {
	factCheckMode,
	gatherEvidence,
	recordFactCheck,
} from '../lib/factcheck.js';
import {
	SOURCE_LANGUAGES,
	sourceRoom,
	withSource,
	writeSourceLine,
} from '../lib/sourceLine.js';
import {
	CalmError,
	canCalmAgain,
	conversationLanguage,
	formatConversation,
	isShareable,
	replyVisibility,
} from '../lib/conversation.js';
import { readBearerToken, readJsonBody, sendError, sendJson } from '../lib/http.js';
import { loadConversation, postStatus, verifyAccount } from '../lib/mastodon.js';
import { summarizeConversation } from '../lib/mistral.js';
import {
	claimThread,
	finishThread,
	readBotIdentity,
	releaseThread,
	rememberBotIdentity,
} from '../lib/store.js';

/**
 * The bot's own account id on this instance, so its replies can be told from
 * everyone else's. Cached for a day. A lookup that fails leaves the bot
 * unidentified, and an unidentified bot lets the press through: refusing on a
 * Redis or Mastodon hiccup would be the worse failure.
 */
const getBotAccountId = async instance => {
	const cached = await readBotIdentity(instance.id).catch(() => null);
	if (cached) return cached;
	const account = await verifyAccount(instance.host, instance.botToken).catch(
		() => null,
	);
	if (!account?.id) return null;
	await rememberBotIdentity(instance.id, account.id).catch(() => {});
	return account.id;
};

/**
 * Writes the calming message and publishes it as the bot. Runs after the thread
 * is locked, and may outlive the request that started it (see `respondWithinMs`),
 * so it takes everything it needs as arguments and returns the bot's post id.
 */
const writeAndPublish = async ({
	body,
	instance,
	requester,
	conversation,
	rootId,
	statusIds,
}) => {
	const { root, replies, subject } = conversation;
	// Only a plain language code is taken from the app, e.g. "en" or "fr-FR".
	const readerLanguage = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/i.test(
		String(body.language || ''),
	)
		? String(body.language).toLowerCase().split('-')[0]
		: undefined;
	const { content, images, textless } = formatConversation(root, replies, {
		subject,
		readerLanguage,
	});
	const language =
		textless && readerLanguage
			? readerLanguage
			: conversationLanguage([root, ...replies]);

	// In "on" mode the search runs before anything is written, one call at a
	// time, so the model is never asked for two things at once (its rate limit
	// is per minute). It has its own time limit and never throws.
	const mode = factCheckMode();
	const found = mode === 'on' ? await gatherEvidence({ content }) : null;

	const mention = `@${requester.acct}`;
	const text = await summarizeConversation({
		content,
		images,
		botName: instance.botName || 'PouetFrance IA',
		// The mention and the space before it are published too, so the model's
		// own budget has to leave room for them inside Mastodon's 500.
		maxCharacters: CONFIG.maxStatusCharacters - mention.length - 1,
	});

	// The reply is the same as without a source. A source that settles the claim
	// adds one checked sentence and its link underneath; if the sentence cannot
	// be written or fails a check, the reply goes out alone, never with a bare
	// link.
	let post = `${mention} ${text}`;
	let citedUrl = null;
	const source = found?.evidence?.[0];
	const room = Math.min(CONFIG.factCheck.maxLineCharacters, sourceRoom(post));
	if (
		source &&
		SOURCE_LANGUAGES.has(language) &&
		room >= CONFIG.factCheck.minLineCharacters
	) {
		const line = await writeSourceLine({
			claim: found.claim,
			figures: found.figures,
			source,
			language,
			maxCharacters: room,
		});
		if (line) {
			post = withSource(post, line, source);
			citedUrl = source.url;
		}
	}

	// The bot answers under the pressed post, and never more publicly than the
	// thread it is in.
	const published = await postStatus(instance.host, instance.botToken, {
		text: post,
		inReplyToId: conversation.subjectId,
		visibility: replyVisibility(root, subject),
		language,
		// One key per round of the conversation: the thread plus its newest post
		// at the time of the press. A post that succeeded but timed out on the
		// way back is not published twice by a retry, two people pressing
		// different posts of the same unchanged thread collapse onto one reply,
		// and a thread that has since moved on gets a new key and a new reply.
		idempotencyKey: `calm:${instance.id}:${rootId}:${
			statusIds[statusIds.length - 1] || 'first'
		}`,
	}).catch(() => {
		throw new CalmError('bot_post_failed', 502);
	});

	const botStatusId = String(published?.id || '');
	await finishThread({ instanceId: instance.id, rootId, botStatusId, statusIds });

	// Every fact-check is recorded for review, with the source the reply cited.
	// In "log" mode it only runs now, after the reply is out, so it can neither
	// delay the reply nor compete with it for the model's rate limit.
	const record = result =>
		recordFactCheck({
			instanceId: instance.id,
			rootId,
			mode,
			result,
			citedUrl,
		});
	if (found) {
		keepAlive(record(found).catch(() => {}));
	} else if (mode === 'log') {
		keepAlive(gatherEvidence({ content }).then(record).catch(() => {}));
	}
	return { botStatusId };
};

/**
 * POST /api/calm  { instance, statusId, check? }  Authorization: Bearer <token>
 *
 * One press of the lotus. The bridge reads the thread, asks the model for a
 * calming message and publishes it as the bot account, mentioning the person
 * who asked so they are notified.
 *
 * The bot may be asked again later: a calmed thread that has carried on gets a
 * fresh reply. What it will not do is answer itself, so a press is refused
 * while the last post under the pressed one is the bot's own.
 *
 * With `check: true` nothing is published. The bridge only reports whether a
 * press would work, which is how the app decides between the confirmation
 * sheet and the "already calmed" one before spending anything on the model.
 *
 * There is no queue and no worker. The run starts inside this request and, if
 * it is slow, finishes after the answer has gone (see `respondWithinMs`). A
 * short lived Redis lock stands in for a queue, so a second person pressing the
 * lotus is told the bot is already answering rather than starting a second
 * reply.
 */
export default async function handler(req, res) {
	if (req.method !== 'POST') {
		return sendJson(res, 405, { error: 'method_not_allowed' });
	}

	let claim = null;
	let workStarted = false;
	let instance = null;
	let rootId = null;
	let statusIds = [];
	try {
		const body = readJsonBody(req);
		if (!body) throw new CalmError('invalid_request', 400);
		const token = readBearerToken(req);
		if (!token) throw new CalmError('unauthorized', 401);

		// The app sends an instance id, never a host: the bridge will only ever
		// call a server named in its own environment.
		instance = getInstance(body.instance);
		if (!instance) throw new CalmError('unknown_instance', 400);
		const statusId = String(body.statusId || '').trim();
		if (!statusId || !/^[A-Za-z0-9_-]{1,64}$/.test(statusId)) {
			throw new CalmError('invalid_request', 400);
		}

		// Mastodon decides who the caller is; the bridge never takes their word.
		const requester = await verifyAccount(instance.host, token).catch(() => {
			throw new CalmError('unauthorized', 401);
		});

		// Read the thread with the user's own token: they can only ask the bot to
		// read a conversation they can already see themselves.
		const conversation = await loadConversation(
			instance.host,
			token,
			statusId,
		).catch(error => {
			throw error?.status === 404
				? new CalmError('status_not_found', 404)
				: new CalmError('mastodon_unavailable', 502);
		});
		const { root, replies, subject } = conversation;
		rootId = String(root.id);
		statusIds = conversation.statusIds;

		// Checked before the lock, so a private thread never leaves a key behind.
		// The pressed post counts too: the bot replies under it, in public view.
		if (!isShareable(root) || !isShareable(subject)) {
			throw new CalmError('restricted_conversation', 403);
		}

		// Nobody has spoken since the bot's own reply, so there is nothing new to
		// calm. Checked before the lock and before the model, so a repeated press
		// costs one Mastodon read and nothing else.
		const botAccountId = await getBotAccountId(instance);
		const open = canCalmAgain({
			posts: [root, ...replies],
			botAccountId,
		});

		// A check only reports; it never locks the thread or publishes anything.
		if (body.check === true) {
			return sendJson(res, 200, {
				canCalm: open,
				rootId,
				statusIds: conversation.statusIds,
			});
		}
		if (!open) throw new CalmError('already_calmed', 409);

		claim = await claimThread({
			instanceId: instance.id,
			rootId,
			requester: requester.acct,
			statusIds,
		});
		if (!claim.claimed) {
			// Not an error: the app shows the same lotus state either way.
			return sendJson(res, 200, {
				state: claim.entry.state === 'done' ? 'done' : 'loading',
				rootId,
				statusIds: conversation.statusIds,
				alreadyRequested: true,
			});
		}

		// The run is seen through even if this request answers first. It frees the
		// lotus itself when it fails, because nobody may be waiting for it then.
		const work = writeAndPublish({
			body,
			instance,
			requester,
			conversation,
			rootId,
			statusIds,
		}).catch(async error => {
			await releaseThread({
				instanceId: instance.id,
				rootId,
				statusIds,
				previousState: claim.previousState,
			}).catch(() => {});
			throw error;
		});
		workStarted = true;
		keepAlive(work.catch(() => {}));

		// Most runs finish well inside the app's wait and answer "done", with any
		// error shown to the person who pressed. A slow one answers "loading"
		// instead; the app follows the thread until the bot's reply turns it red.
		let timer;
		const late = new Promise(resolve => {
			timer = setTimeout(() => resolve(null), CONFIG.respondWithinMs);
		});
		const finished = await Promise.race([work, late]).finally(() =>
			clearTimeout(timer),
		);
		if (!finished) {
			return sendJson(res, 200, {
				state: 'loading',
				rootId,
				statusIds: conversation.statusIds,
			});
		}
		return sendJson(res, 200, {
			state: 'done',
			rootId,
			statusIds: conversation.statusIds,
			botStatusId: finished.botStatusId,
		});
	} catch (error) {
		// A failed run must not leave the lotus spinning for everyone else. A
		// thread that was already red stays red: the earlier reply is still there.
		// Once the run has started it frees the lotus itself.
		if (claim?.claimed && !workStarted && instance && rootId) {
			await releaseThread({
				instanceId: instance.id,
				rootId,
				statusIds,
				previousState: claim.previousState,
			}).catch(() => {});
		}
		return sendError(res, error);
	}
}
