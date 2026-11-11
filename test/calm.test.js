import assert from 'node:assert/strict';
import test from 'node:test';
import calm from '../api/calm.js';
import states from '../api/states.js';
import { setKeepAlive } from '../lib/background.js';
import { CONFIG } from '../lib/config.js';
import { setKvClient } from '../lib/kv.js';

// The whole request path runs here against an in-memory store and a stubbed
// network, so no Mastodon server, model or Redis is needed. `nx` behaves as
// Upstash does, which is what the one-reply-per-thread tests rely on.
const kvStore = new Map();
setKvClient({
	async set(key, value, options = {}) {
		if (options.nx && kvStore.has(key)) return null;
		kvStore.set(key, value);
		return 'OK';
	},
	async get(key) {
		return kvStore.has(key) ? kvStore.get(key) : null;
	},
	async del(...keys) {
		keys.forEach(key => kvStore.delete(key));
	},
	async mget(...keys) {
		return keys.map(key => (kvStore.has(key) ? kvStore.get(key) : null));
	},
	async lpush(key, value) {
		kvStore.set(key, [value, ...(kvStore.get(key) || [])]);
	},
	async ltrim(key, start, stop) {
		kvStore.set(key, (kvStore.get(key) || []).slice(start, stop + 1));
	},
	async expire() {},
	async lrange(key, start, stop) {
		return (kvStore.get(key) || []).slice(start, stop + 1);
	},
});

process.env.CALM_INSTANCES = 'pouet';
process.env.CALM_POUET_HOST = 'pouetfrance.social';
process.env.CALM_POUET_BOT_TOKEN = 'bot-token';
process.env.MISTRAL_API_KEY = 'model-key';

const ANSWER =
	'Les avis divergent sur les moyens des écoles. Les chiffres cités ne sont pas vérifiés ici. Quelle amélioration concrète proposeriez-vous ?';

const post = (overrides = {}) => ({
	id: '100',
	content: '<p>La rentrée est difficile cette année.</p>',
	visibility: 'public',
	created_at: '2026-11-01T10:00:00.000Z',
	language: 'fr',
	account: { username: 'lea', display_name: 'Léa' },
	...overrides,
});

/**
 * One fake network for both services the handler talks to. `calls` records what
 * was sent so a test can assert on the published post, and `overrides` lets a
 * test make a single route fail.
 */
const BOT_ACCOUNT = { id: '42', acct: 'calmtest_bot' };

/** A reply written by the bot itself, as Mastodon would return it. */
const botPost = (overrides = {}) =>
	post({
		id: '900',
		content: '<p>@julien Les avis divergent.</p>',
		account: { id: BOT_ACCOUNT.id, username: BOT_ACCOUNT.acct },
		...overrides,
	});

const stubFetch = ({
	root = post(),
	ancestors = [],
	descendants = [],
	overrides = {},
} = {}) => {
	const calls = [];
	global.fetch = async (url, options = {}) => {
		const body = options.body ? JSON.parse(options.body) : null;
		calls.push({ url, method: options.method || 'GET', body, headers: options.headers });
		const route = Object.keys(overrides).find(key => url.includes(key));
		if (route) return overrides[route];
		const json = payload => ({ ok: true, status: 200, json: async () => payload });
		if (url.includes('verify_credentials')) {
			// The same route identifies the caller and the bot; the token says which.
			return json(
				options.headers?.Authorization === 'Bearer bot-token'
					? BOT_ACCOUNT
					: { id: '7', acct: 'julien' },
			);
		}
		if (url.includes('/context')) return json({ ancestors, descendants });
		if (url.includes('api.mistral.ai')) {
			return json({
				choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: ANSWER } }],
			});
		}
		if (url.includes('/api/v1/statuses') && options.method === 'POST') {
			return json({ id: '999' });
		}
		if (url.includes('/api/v1/statuses/')) return json(root);
		throw new Error(`unexpected fetch: ${url}`);
	};
	return calls;
};

const makeRes = () => {
	const res = {};
	res.status = code => {
		res.code = code;
		return res;
	};
	res.json = payload => {
		res.payload = payload;
		return res;
	};
	return res;
};

const request = (body, { token = 'user-token' } = {}) => ({
	method: 'POST',
	headers: token ? { authorization: `Bearer ${token}` } : {},
	body,
});

const run = async (handler, req) => {
	const res = makeRes();
	await handler(req, res);
	return res;
};

test.beforeEach(() => kvStore.clear());

/**
 * Keys belonging to threads. The session and bot-identity caches are not thread
 * state: they outlive a run on purpose, so they never count as a leak.
 */
const threadKeys = () =>
	[...kvStore.keys()].filter(
		key =>
			!key.startsWith('calm:session:') &&
			!key.startsWith('calm:bot:') &&
			!key.startsWith('calm:factcheck:'),
	);

test('a lotus press publishes one bot reply that mentions the requester', async () => {
	const calls = stubFetch({ descendants: [post({ id: '101', content: '<p>Pas d’accord.</p>' })] });
	const res = await run(calm, request({ instance: 'pouet', statusId: '100' }));

	assert.equal(res.code, 200);
	assert.equal(res.payload.state, 'done');
	assert.equal(res.payload.botStatusId, '999');
	// Every id in the thread comes back, so any lotus on screen can turn red.
	assert.deepEqual(res.payload.statusIds, ['100', '101']);

	const published = calls.find(call => call.method === 'POST' && call.url.includes('/api/v1/statuses'));
	assert.equal(published.body.status, `@julien ${ANSWER}`);
	assert.equal(published.body.in_reply_to_id, '100');
	assert.equal(published.body.visibility, 'public');
	assert.equal(published.body.language, 'fr');
	// The bot posts as itself, and a retry cannot add a second reply. The key
	// names the round: the pressed post and the last post under it.
	assert.equal(published.headers.Authorization, 'Bearer bot-token');
	assert.equal(published.headers['Idempotency-Key'], 'calm:pouet:100:101');
	assert.ok(published.body.status.length <= 500);
});

test('the bot refuses to answer itself while nobody else has spoken', async () => {
	stubFetch();
	const first = await run(calm, request({ instance: 'pouet', statusId: '100' }));
	assert.equal(first.payload.state, 'done');

	// The bot's reply is now the last post under the pressed one.
	const calls = stubFetch({ descendants: [botPost()] });
	const second = await run(calm, request({ instance: 'pouet', statusId: '100' }));
	assert.equal(second.code, 409);
	assert.equal(second.payload.error, 'already_calmed');
	assert.equal(
		calls.some(call => call.url.includes('api.mistral.ai')),
		false,
		'a refused press must cost nothing at the model',
	);
	assert.equal(
		calls.some(call => call.method === 'POST' && call.url.includes('/api/v1/statuses')),
		false,
		'the bot must not post while it still has the last word',
	);
});

test('the bot answers again once the conversation has moved on', async () => {
	stubFetch();
	await run(calm, request({ instance: 'pouet', statusId: '100' }));

	// Someone replied after the bot, so there is something new to calm.
	const human = post({
		id: '901',
		content: '<p>Je ne suis toujours pas d’accord.</p>',
		created_at: '2026-11-01T12:00:00.000Z',
	});
	const calls = stubFetch({ descendants: [botPost(), human] });
	const again = await run(calm, request({ instance: 'pouet', statusId: '100' }));

	assert.equal(again.code, 200);
	assert.equal(again.payload.state, 'done');
	const published = calls.find(
		call => call.method === 'POST' && call.url.includes('/api/v1/statuses'),
	);
	assert.ok(published, 'a second calming reply is published');
	// A new round means a new key, so Mastodon does not dedupe it away.
	assert.equal(published.headers['Idempotency-Key'], 'calm:pouet:100:901');
});

test('a check reports whether a press would work, publishing nothing', async () => {
	stubFetch();
	await run(calm, request({ instance: 'pouet', statusId: '100' }));

	const calls = stubFetch({ descendants: [botPost()] });
	const closed = await run(
		calm,
		request({ instance: 'pouet', statusId: '100', check: true }),
	);
	assert.equal(closed.code, 200);
	assert.equal(closed.payload.canCalm, false);

	assert.equal(
		calls.some(call => call.method === 'POST' && call.url.includes('/api/v1/statuses')),
		false,
		'a check never publishes',
	);
	assert.equal(calls.some(call => call.url.includes('api.mistral.ai')), false);

	// A human reply after the bot opens it again.
	stubFetch({
		descendants: [
			botPost(),
			post({ id: '901', created_at: '2026-11-01T12:00:00.000Z' }),
		],
	});
	const open = await run(
		calm,
		request({ instance: 'pouet', statusId: '100', check: true }),
	);
	assert.equal(open.payload.canCalm, true);
});

test('pressing another post of the same thread does not add a second reply', async () => {
	const reply = post({
		id: '101',
		content: '<p>Pas d’accord.</p>',
		created_at: '2026-11-01T11:00:00.000Z',
	});
	stubFetch({ descendants: [reply] });
	await run(calm, request({ instance: 'pouet', statusId: '101' }));

	// The bot answered under the reply. Pressing the original post is a press
	// on the same conversation, and nobody has spoken since, so it is refused:
	// otherwise one discussion could be calmed once per post in it.
	const botReply = botPost({ created_at: '2026-11-01T12:00:00.000Z' });
	const calls = stubFetch({ descendants: [reply, botReply] });
	const res = await run(calm, request({ instance: 'pouet', statusId: '100' }));

	assert.equal(res.code, 409);
	assert.equal(res.payload.error, 'already_calmed');
	assert.equal(
		calls.some(call => call.method === 'POST' && call.url.includes('/api/v1/statuses')),
		false,
	);
});

test('two presses racing on different posts collapse onto one reply', async () => {
	const reply = post({
		id: '101',
		content: '<p>Pas d’accord.</p>',
		created_at: '2026-11-01T11:00:00.000Z',
	});
	const calls = stubFetch({ descendants: [reply] });

	// Both see the same unchanged thread, so both build the same key and
	// Mastodon keeps only the first post.
	const [first, second] = await Promise.all([
		run(calm, request({ instance: 'pouet', statusId: '100' })),
		run(calm, request({ instance: 'pouet', statusId: '101' })),
	]);

	const published = calls.filter(
		call => call.method === 'POST' && call.url.includes('/api/v1/statuses'),
	);
	const keys = new Set(published.map(call => call.headers['Idempotency-Key']));
	assert.equal(keys.size, 1, 'both presses must use the same idempotency key');
	assert.ok(first.code === 200 && second.code === 200);
});

test('a press on one reply reads every branch of the thread', async () => {
	const pressed = post({ id: '101', content: '<p>Première réponse.</p>' });
	const sibling = post({ id: '102', content: '<p>Autre branche.</p>' });
	const nested = post({ id: '103', content: '<p>Sous la réponse.</p>' });
	const calls = stubFetch({
		root: pressed,
		ancestors: [post()],
		descendants: [nested],
		overrides: {
			'statuses/100/context': {
				ok: true,
				status: 200,
				json: async () => ({
					ancestors: [],
					descendants: [pressed, sibling, nested],
				}),
			},
		},
	});

	const res = await run(calm, request({ instance: 'pouet', statusId: '101' }));

	const model = calls.find(call => call.url.includes('api.mistral.ai'));
	assert.match(model.body.messages[1].content, /Autre branche/);
	assert.deepEqual(res.payload.statusIds, ['100', '101', '102', '103']);

	// The bot still answers under the post that was pressed.
	const published = calls.find(call => call.method === 'POST' && call.url.includes('/api/v1/statuses'));
	assert.equal(published.body.in_reply_to_id, '101');

	// Readers of the other branch see the same lotus.
	const read = await run(states, request({ instance: 'pouet', statusIds: ['102'] }));
	assert.deepEqual(read.payload.states, { 102: 'done' });
});

test('a private thread is refused and leaves no lock behind', async () => {
	stubFetch({ root: post({ visibility: 'private' }) });
	const res = await run(calm, request({ instance: 'pouet', statusId: '100' }));
	assert.equal(res.code, 403);
	assert.equal(res.payload.error, 'restricted_conversation');
	assert.equal(kvStore.size, 0);
});

test('a private reply inside a public thread cannot be answered in public', async () => {
	const calls = stubFetch({
		root: post({ id: '101', visibility: 'private' }),
		ancestors: [post()],
	});

	const res = await run(calm, request({ instance: 'pouet', statusId: '101' }));

	assert.equal(res.code, 403);
	assert.equal(res.payload.error, 'restricted_conversation');
	assert.equal(calls.some(call => call.url.includes('api.mistral.ai')), false);
	assert.equal(kvStore.size, 0);
});

test('an unlisted reply in a public thread keeps the bot reply unlisted', async () => {
	const calls = stubFetch({
		root: post({ id: '101', visibility: 'unlisted' }),
		ancestors: [post()],
	});

	await run(calm, request({ instance: 'pouet', statusId: '101' }));

	const published = calls.find(call => call.method === 'POST' && call.url.includes('/api/v1/statuses'));
	assert.equal(published.body.visibility, 'unlisted');
});

test('a failed model call frees the lotus for another try', async () => {
	stubFetch({
		overrides: { 'api.mistral.ai': { ok: false, status: 500, json: async () => ({}) } },
	});
	const failed = await run(calm, request({ instance: 'pouet', statusId: '100' }));
	assert.equal(failed.code, 502);
	assert.equal(failed.payload.error, 'server');
	assert.deepEqual(
		threadKeys(),
		[],
		'the thread must not stay locked after a failure',
	);

	const calls = stubFetch();
	const retried = await run(calm, request({ instance: 'pouet', statusId: '100' }));
	assert.equal(retried.payload.state, 'done');
	assert.ok(calls.some(call => call.url.includes('api.mistral.ai')));
});

/** A model whose answers come from a list, one per call; the last repeats. */
const scriptedModel = answers => {
	const network = global.fetch;
	const prompts = [];
	let call = 0;
	global.fetch = async (url, options = {}) => {
		if (!url.includes('api.mistral.ai')) return network(url, options);
		prompts.push(JSON.parse(options.body).messages[0].content);
		const content = answers[Math.min(call, answers.length - 1)];
		call += 1;
		return {
			ok: true,
			status: 200,
			json: async () => ({
				choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
			}),
		};
	};
	return prompts;
};

const SEES_THE_IMAGE = 'Hello everyone, this image brings back memories. What stands out to you?';

test('a draft the guard refuses is retried once with the reason, and then published', async () => {
	stubFetch();
	const prompts = scriptedModel([SEES_THE_IMAGE, ANSWER]);

	const res = await run(calm, request({ instance: 'pouet', statusId: '100' }));

	assert.equal(res.code, 200);
	assert.equal(res.payload.state, 'done');
	assert.equal(prompts.length, 2, 'exactly one retry');
	// Only the second prompt names what went wrong.
	assert.equal(prompts[0].includes('could see the media'), false);
	assert.match(prompts[1], /could see the media/);
});

test('a second refusal is not retried again, and frees the lotus', async () => {
	stubFetch();
	const prompts = scriptedModel([SEES_THE_IMAGE]);

	const res = await run(calm, request({ instance: 'pouet', statusId: '100' }));

	assert.equal(res.code, 502);
	assert.equal(res.payload.error, 'invalid_response');
	assert.equal(prompts.length, 2, 'one retry, never a loop');
	assert.deepEqual(threadKeys(), []);
});

const photoPost = () =>
	post({
		content: '<p></p>',
		media_attachments: [
			{
				type: 'image',
				description: 'A crowded school corridor',
				preview_url: 'https://media.example/corridor-small.jpg',
			},
		],
	});

test('the photo itself goes to the model, and describing it is allowed', async () => {
	const calls = stubFetch({ root: photoPost() });
	scriptedModel(['Hello everyone, the photo shows a busy corridor full of students. Let’s keep it kind. What do you think?']);
	const network = global.fetch;
	const sent = [];
	global.fetch = async (url, options = {}) => {
		if (url.includes('api.mistral.ai')) sent.push(JSON.parse(options.body));
		return network(url, options);
	};

	const res = await run(calm, request({ instance: 'pouet', statusId: '100' }));

	assert.equal(res.code, 200, 'it can see the photo, so saying so is true');
	const user = sent[0].messages[1].content;
	assert.ok(Array.isArray(user));
	assert.deepEqual(
		user.find(part => part.type === 'image_url'),
		{ type: 'image_url', image_url: 'https://media.example/corridor-small.jpg' },
	);
	assert.ok(calls.length > 0);
});

test('a thread with no words answers in the language of the person who asked', async () => {
	const video = post({
		content: '<p></p>',
		// The poster's app tagged it French, but nobody wrote anything.
		language: 'fr',
		media_attachments: [
			{ type: 'video', preview_url: 'https://media.example/park-frame.jpg' },
		],
	});
	const calls = stubFetch({ root: video });

	await run(calm, request({ instance: 'pouet', statusId: '100', language: 'en-GB' }));

	const model = calls.find(call => call.url.includes('api.mistral.ai'));
	const thread = JSON.parse(model.body.messages[1].content[0].text);
	assert.equal(thread.readerLanguage, 'en');
	// Stated as an order: as a field alone the model answered in French.
	assert.match(model.body.messages[0].content, /Write your whole reply in English/);
	const published = calls.find(
		call => call.method === 'POST' && call.url.includes('/api/v1/statuses'),
	);
	assert.equal(published.body.language, 'en');
});

test('a thread with words keeps its own language, whoever asks', async () => {
	const calls = stubFetch();

	await run(calm, request({ instance: 'pouet', statusId: '100', language: 'en' }));

	const model = calls.find(call => call.url.includes('api.mistral.ai'));
	assert.equal(JSON.parse(model.body.messages[1].content).readerLanguage, undefined);
	assert.doesNotMatch(model.body.messages[0].content, /Write your whole reply in/);
	const published = calls.find(
		call => call.method === 'POST' && call.url.includes('/api/v1/statuses'),
	);
	assert.equal(published.body.language, 'fr');
});

test('pictures the model refuses fall back to the text and alt text', async () => {
	stubFetch({ root: photoPost() });
	const network = global.fetch;
	const sent = [];
	global.fetch = async (url, options = {}) => {
		if (!url.includes('api.mistral.ai')) return network(url, options);
		const body = JSON.parse(options.body);
		sent.push(body);
		// A model or a picture Mistral will not take: a 400 for the request.
		if (Array.isArray(body.messages[1].content)) {
			return { ok: false, status: 400, json: async () => ({}) };
		}
		return network(url, options);
	};

	const res = await run(calm, request({ instance: 'pouet', statusId: '100' }));

	assert.equal(res.code, 200);
	assert.equal(sent.length, 2);
	assert.equal(typeof sent[1].messages[1].content, 'string', 'second try is text only');
});

test('a refusal the model cannot fix is not retried', async () => {
	stubFetch();
	// A link is refused outright; asking the model again would only repeat it.
	const prompts = scriptedModel(['See https://example.com for it. What next?']);

	const res = await run(calm, request({ instance: 'pouet', statusId: '100' }));

	assert.equal(res.code, 502);
	assert.equal(prompts.length, 1);
});

test('a failed bot post frees the lotus too', async () => {
	let posted = 0;
	const base = stubFetch();
	const inner = global.fetch;
	global.fetch = async (url, options = {}) => {
		if (url.includes('/api/v1/statuses') && options.method === 'POST') {
			posted += 1;
			return { ok: false, status: 422, json: async () => ({}) };
		}
		return inner(url, options);
	};
	const res = await run(calm, request({ instance: 'pouet', statusId: '100' }));
	assert.equal(posted, 1);
	assert.equal(res.code, 502);
	assert.equal(res.payload.error, 'bot_post_failed');
	assert.deepEqual(threadKeys(), []);
	assert.ok(base.length > 0);
});

test('a bot post that timed out cannot be published twice by a second press', async () => {
	stubFetch();
	const network = global.fetch;
	// Mastodon's side of the Idempotency-Key: a key it has seen returns the
	// first status instead of creating another one.
	const published = new Map();
	let responseLost = true;
	global.fetch = async (url, options = {}) => {
		if (!url.includes('/api/v1/statuses') || options.method !== 'POST') {
			return network(url, options);
		}
		const key = options.headers['Idempotency-Key'];
		if (!published.has(key)) published.set(key, `${published.size + 1}`);
		if (responseLost) {
			responseLost = false;
			throw new Error('timeout');
		}
		return { ok: true, status: 200, json: async () => ({ id: published.get(key) }) };
	};

	const first = await run(calm, request({ instance: 'pouet', statusId: '100' }));
	assert.equal(first.payload.error, 'bot_post_failed');

	const second = await run(calm, request({ instance: 'pouet', statusId: '100' }));
	assert.equal(second.payload.state, 'done');
	assert.equal(published.size, 1, 'only one bot reply may exist');
});

test('an unlisted thread keeps the bot reply unlisted', async () => {
	const calls = stubFetch({ root: post({ visibility: 'unlisted' }) });
	await run(calm, request({ instance: 'pouet', statusId: '100' }));
	const published = calls.find(call => call.method === 'POST' && call.url.includes('/api/v1/statuses'));
	assert.equal(published.body.visibility, 'unlisted');
});

test('the request is refused without a valid session or a known instance', async () => {
	stubFetch();
	const anonymous = await run(calm, request({ instance: 'pouet', statusId: '100' }, { token: '' }));
	assert.equal(anonymous.code, 401);

	// An instance the environment does not name is never contacted.
	const calls = stubFetch();
	const unknown = await run(calm, request({ instance: 'evil.example', statusId: '100' }));
	assert.equal(unknown.code, 400);
	assert.equal(unknown.payload.error, 'unknown_instance');
	assert.equal(calls.length, 0);

	const rejected = stubFetch({
		overrides: { verify_credentials: { ok: false, status: 401, json: async () => ({}) } },
	});
	const expired = await run(calm, request({ instance: 'pouet', statusId: '100' }));
	assert.equal(expired.code, 401);
	assert.equal(
		rejected.some(call => call.url.includes('api.mistral.ai')),
		false,
	);
});

test('a malformed status id never reaches Mastodon', async () => {
	const calls = stubFetch();
	const res = await run(calm, request({ instance: 'pouet', statusId: '../../admin' }));
	assert.equal(res.code, 400);
	assert.equal(res.payload.error, 'invalid_request');
	assert.equal(calls.some(call => call.url.includes('/api/v1/statuses')), false);
});

test('states answers for a whole screen in one call', async () => {
	stubFetch();
	await run(calm, request({ instance: 'pouet', statusId: '100' }));

	const res = await run(
		states,
		request({ instance: 'pouet', statusIds: ['100', '555', '100'] }),
	);
	assert.equal(res.code, 200);
	// Only threads the bridge knows about are reported.
	assert.deepEqual(res.payload.states, { 100: 'done' });
});

test('every reader sees the same lotus on the replies of a calmed thread', async () => {
	const reply = post({ id: '101', content: '<p>Pas d’accord.</p>' });
	stubFetch({ descendants: [reply] });
	await run(calm, request({ instance: 'pouet', statusId: '100' }));

	const res = await run(
		states,
		request({ instance: 'pouet', statusIds: ['100', '101'] }),
	);

	assert.deepEqual(res.payload.states, { 100: 'done', 101: 'done' });
});

test('a reply shows loading while the bot writes, and clears if it fails', async () => {
	const reply = post({ id: '101', content: '<p>Pas d’accord.</p>' });
	stubFetch({ descendants: [reply] });
	const network = global.fetch;
	let duringModelCall = null;
	global.fetch = async (url, options = {}) => {
		if (!url.includes('api.mistral.ai')) return network(url, options);
		duringModelCall = await run(
			states,
			request({ instance: 'pouet', statusIds: ['101'] }),
		);
		return { ok: false, status: 500, json: async () => ({}) };
	};

	await run(calm, request({ instance: 'pouet', statusId: '101' }));

	assert.deepEqual(duringModelCall.payload.states, { 101: 'loading' });
	assert.deepEqual(
		threadKeys(),
		[],
		'no key of the thread may outlive a failure',
	);
});

test('two people pressing at the same moment get one bot reply', async () => {
	const calls = stubFetch();
	const network = global.fetch;
	// The second press lands while the first is still at the model, which is the
	// window the lock exists for.
	let second = null;
	global.fetch = async (url, options = {}) => {
		if (url.includes('api.mistral.ai') && !second) {
			second = await run(calm, request({ instance: 'pouet', statusId: '100' }));
		}
		return network(url, options);
	};

	const first = await run(calm, request({ instance: 'pouet', statusId: '100' }));

	assert.equal(first.payload.state, 'done');
	assert.equal(second.payload.state, 'loading');
	assert.equal(second.payload.alreadyRequested, true);
	assert.equal(
		calls.filter(call => call.method === 'POST' && call.url.includes('/api/v1/statuses'))
			.length,
		1,
		'only one bot reply may be published',
	);
});

test('a failed second press leaves the earlier red lotus alone', async () => {
	stubFetch();
	await run(calm, request({ instance: 'pouet', statusId: '100' }));

	// The conversation moved on, so a second press is allowed; this one fails.
	const human = post({ id: '901', created_at: '2026-11-01T12:00:00.000Z' });
	stubFetch({
		descendants: [botPost(), human],
		overrides: { 'api.mistral.ai': { ok: false, status: 500, json: async () => ({}) } },
	});
	const failed = await run(calm, request({ instance: 'pouet', statusId: '100' }));
	assert.equal(failed.code, 502);

	// The earlier bot reply is still in the thread, so the lotus stays red.
	stubFetch();
	const read = await run(states, request({ instance: 'pouet', statusIds: ['100'] }));
	assert.deepEqual(read.payload.states, { 100: 'done' });
});

test('a made-up token cannot read states', async () => {
	stubFetch();
	await run(calm, request({ instance: 'pouet', statusId: '100' }));
	kvStore.forEach((_, key) => {
		if (key.startsWith('calm:session:')) kvStore.delete(key);
	});

	stubFetch({
		overrides: { verify_credentials: { ok: false, status: 401, json: async () => ({}) } },
	});
	const res = await run(
		states,
		request({ instance: 'pouet', statusIds: ['100'] }, { token: 'made-up' }),
	);

	assert.equal(res.code, 401);
	assert.equal(res.payload.error, 'unauthorized');
	assert.equal(res.payload.states, undefined);
});

test('a feed scrolling does not call Mastodon on every state read', async () => {
	const calls = stubFetch();
	const ask = () =>
		run(states, request({ instance: 'pouet', statusIds: ['100'] }));

	await ask();
	await ask();

	const checks = calls.filter(call => call.url.includes('verify_credentials'));
	assert.equal(checks.length, 1);
});

test('a remembered session never stores the token itself', async () => {
	stubFetch();
	await run(
		states,
		request({ instance: 'pouet', statusIds: ['100'] }, { token: 'secret-token' }),
	);

	const stored = JSON.stringify([...kvStore.entries()]);
	assert.equal(stored.includes('secret-token'), false);
	assert.equal(kvStore.size, 1);
});

test('a Mastodon outage is not reported as a bad login', async () => {
	stubFetch({
		overrides: { verify_credentials: { ok: false, status: 503, json: async () => ({}) } },
	});

	const res = await run(states, request({ instance: 'pouet', statusIds: ['100'] }));

	assert.equal(res.code, 502);
	assert.equal(res.payload.error, 'mastodon_unavailable');
});

test('states needs a session and a known instance', async () => {
	const anonymous = await run(
		states,
		request({ instance: 'pouet', statusIds: ['100'] }, { token: '' }),
	);
	assert.equal(anonymous.code, 401);

	const unknown = await run(states, request({ instance: 'evil.example', statusIds: ['100'] }));
	assert.equal(unknown.code, 400);
});

test('only POST is accepted', async () => {
	const res = await run(calm, { method: 'GET', headers: {}, body: null });
	assert.equal(res.code, 405);
});

/**
 * A model that answers only after `delayMs`, so a run can outlast the time a
 * press waits. `fail` makes the late answer an error instead.
 */
const slowModel = ({ delayMs, fail = false }) => {
	const network = global.fetch;
	global.fetch = async (url, options = {}) => {
		if (!url.includes('api.mistral.ai')) return network(url, options);
		await new Promise(resolve => setTimeout(resolve, delayMs));
		if (fail) return { ok: false, status: 500, json: async () => ({}) };
		return network(url, options);
	};
};

/** Records background work instead of handing it to Vercel. */
const recordBackground = () => {
	const pending = [];
	setKeepAlive(promise => pending.push(promise));
	return pending;
};

test('a slow run answers loading, then publishes in the background', async t => {
	const respondWithinMs = CONFIG.respondWithinMs;
	CONFIG.respondWithinMs = 20;
	t.after(() => {
		CONFIG.respondWithinMs = respondWithinMs;
	});
	const pending = recordBackground();
	const calls = stubFetch();
	slowModel({ delayMs: 80 });

	const res = await run(calm, request({ instance: 'pouet', statusId: '100' }));
	// The press is answered before the bot has written anything.
	assert.equal(res.code, 200);
	assert.equal(res.payload.state, 'loading');
	assert.deepEqual(res.payload.statusIds, ['100']);
	const midway = await run(states, request({ instance: 'pouet', statusIds: ['100'] }));
	assert.deepEqual(midway.payload.states, { 100: 'loading' });

	// The run goes on after the answer and finishes the job.
	assert.equal(pending.length, 1);
	await Promise.all(pending);
	const published = calls.filter(
		call => call.method === 'POST' && call.url.includes('/api/v1/statuses'),
	);
	assert.equal(published.length, 1, 'the bot reply is still published');
	const after = await run(states, request({ instance: 'pouet', statusIds: ['100'] }));
	assert.deepEqual(after.payload.states, { 100: 'done' });
});

test('a slow run that fails in the background frees the lotus', async t => {
	const respondWithinMs = CONFIG.respondWithinMs;
	CONFIG.respondWithinMs = 20;
	t.after(() => {
		CONFIG.respondWithinMs = respondWithinMs;
	});
	const pending = recordBackground();
	stubFetch();
	slowModel({ delayMs: 80, fail: true });

	const res = await run(calm, request({ instance: 'pouet', statusId: '100' }));
	assert.equal(res.payload.state, 'loading');

	// Nobody is waiting for the error any more, so the run cleans up after
	// itself: the lotus goes back to how it was and can be pressed again.
	await Promise.all(pending);
	assert.deepEqual(threadKeys(), [], 'no key of the thread may outlive a failure');
	stubFetch();
	const retried = await run(calm, request({ instance: 'pouet', statusId: '100' }));
	assert.equal(retried.payload.state, 'done');
});

test('a quick run still answers done and keeps showing its errors', async () => {
	recordBackground();
	stubFetch({
		overrides: { 'api.mistral.ai': { ok: false, status: 500, json: async () => ({}) } },
	});
	const failed = await run(calm, request({ instance: 'pouet', statusId: '100' }));
	// Within the wait, an error still reaches the person who pressed.
	assert.equal(failed.code, 502);
	assert.equal(failed.payload.error, 'server');
	assert.deepEqual(threadKeys(), []);
});

test('with the fact-check off, nothing is searched', async () => {
	delete process.env.FACTCHECK_MODE;
	const pending = recordBackground();
	const calls = stubFetch();
	const res = await run(calm, request({ instance: 'pouet', statusId: '100' }));
	await Promise.all(pending);
	assert.equal(res.payload.state, 'done');
	assert.ok(!calls.some(call => call.url.includes('serper.dev')));
	assert.equal(
		calls.filter(call => call.url.includes('api.mistral.ai')).length,
		1,
		'only the reply is written',
	);
});

test('in log mode the reply is unchanged and the search is recorded', async t => {
	process.env.FACTCHECK_MODE = 'log';
	process.env.SERPER_API_KEY = 'search-key';
	t.after(() => {
		delete process.env.FACTCHECK_MODE;
		delete process.env.SERPER_API_KEY;
	});
	const pending = recordBackground();
	const calls = stubFetch();
	const network = global.fetch;
	global.fetch = async (url, options = {}) => {
		const body = options.body ? JSON.parse(options.body) : null;
		// The claim step asks for JSON; the reply does not.
		if (url.includes('api.mistral.ai') && body?.response_format) {
			calls.push({ url, method: 'POST', body });
			return {
				ok: true,
				status: 200,
				json: async () => ({
					choices: [{ message: { content: JSON.stringify({ checkable: true, claim: 'Rentrée difficile.', query: 'rentrée scolaire difficultés' }) } }],
				}),
			};
		}
		if (url.includes('serper.dev')) {
			calls.push({ url, method: 'POST', body });
			return {
				ok: true,
				status: 200,
				json: async () => ({
					organic: [{ link: 'https://www.ouest-france.fr/education/rentree', title: 'Rentrée', snippet: 'Les écoles font face à des difficultés.' }],
				}),
			};
		}
		return network(url, options);
	};

	const res = await run(calm, request({ instance: 'pouet', statusId: '100' }));
	await Promise.all(pending);

	assert.equal(res.payload.state, 'done');
	const published = calls.find(call => call.method === 'POST' && call.url.includes('/api/v1/statuses'));
	assert.equal(published.body.status, `@julien ${ANSWER}`, 'the reply does not change in log mode');
	// The claim step starts only once the reply is out, so it never competes
	// with the reply for the model's rate limit.
	const publishedAt = calls.indexOf(published);
	const claimAt = calls.findIndex(call => call.body?.response_format);
	assert.ok(claimAt > publishedAt, 'the fact-check must run after the reply is published');
	assert.ok(!published.body.status.includes('http'));
	const log = kvStore.get('calm:factcheck:log');
	assert.equal(log.length, 1);
	assert.equal(log[0].mode, 'log');
	assert.equal(log[0].evidence[0].url, 'https://www.ouest-france.fr/education/rentree');
});

test('in log mode a failing search never stops the reply', async t => {
	process.env.FACTCHECK_MODE = 'log';
	process.env.SERPER_API_KEY = 'search-key';
	t.after(() => {
		delete process.env.FACTCHECK_MODE;
		delete process.env.SERPER_API_KEY;
	});
	const pending = recordBackground();
	const calls = stubFetch();
	const network = global.fetch;
	global.fetch = async (url, options = {}) => {
		const body = options.body ? JSON.parse(options.body) : null;
		if (url.includes('api.mistral.ai') && body?.response_format) {
			throw new Error('claim step down');
		}
		return network(url, options);
	};
	const res = await run(calm, request({ instance: 'pouet', statusId: '100' }));
	await Promise.all(pending);
	assert.equal(res.payload.state, 'done');
	assert.ok(calls.some(call => call.method === 'POST' && call.url.includes('/api/v1/statuses')));
});

/**
 * A network for "on" mode: the claim step, the search, the reply and the
 * source sentence each answer as given, and the order of the calls is kept.
 */
const onModeNetwork = ({ claim, organic, reply = ANSWER, line, root }) => {
	const calls = stubFetch(root ? { root } : {});
	const network = global.fetch;
	global.fetch = async (url, options = {}) => {
		const body = options.body ? JSON.parse(options.body) : null;
		const answer = content => ({
			ok: true,
			status: 200,
			json: async () => ({
				choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
			}),
		});
		if (url.includes('serper.dev')) {
			calls.push({ url, method: 'POST', body, step: 'search' });
			if (organic instanceof Error) throw organic;
			return { ok: true, status: 200, json: async () => ({ organic }) };
		}
		if (url.includes('api.mistral.ai')) {
			const system = body.messages[0].content;
			if (body.response_format) {
				calls.push({ url, method: 'POST', body, step: 'claim' });
				return answer(JSON.stringify(claim));
			}
			if (system.startsWith('You write one neutral sentence')) {
				calls.push({ url, method: 'POST', body, step: 'line' });
				if (line instanceof Error) return { ok: false, status: 429, json: async () => ({}) };
				return answer(line);
			}
			calls.push({ url, method: 'POST', body, step: 'reply' });
			return answer(reply);
		}
		return network(url, options);
	};
	return calls;
};

const LAW_CLAIM = {
	checkable: true,
	claim: 'La loi de 2018 interdit les téléphones portables dans les collèges.',
	query: 'loi téléphone portable collège 2018',
};
const LAW_RESULT = [
	{
		link: 'https://www.ouest-france.fr/education/portables-interdits',
		title: 'Portables interdits dans les lycées : « Les établissements ne sont pas prêts »',
		snippet: 'Déjà en vigueur de la maternelle au collège depuis 2018, l’interdiction du téléphone portable sera étendue aux lycées dès la rentrée par la loi.',
	},
];
const LAW_LINE =
	'Selon Ouest-France, le téléphone portable est interdit de la maternelle au collège depuis 2018.';

const onMode = t => {
	process.env.FACTCHECK_MODE = 'on';
	process.env.SERPER_API_KEY = 'search-key';
	t.after(() => {
		delete process.env.FACTCHECK_MODE;
		delete process.env.SERPER_API_KEY;
	});
};

const publishedPost = calls =>
	calls.find(call => call.method === 'POST' && call.url.includes('/api/v1/statuses'));

test('in on mode the reply is unchanged and a checked sentence and link follow it', async t => {
	onMode(t);
	const pending = recordBackground();
	const calls = onModeNetwork({ claim: LAW_CLAIM, organic: LAW_RESULT, line: LAW_LINE });

	const res = await run(calm, request({ instance: 'pouet', statusId: '100' }));
	await Promise.all(pending);

	assert.equal(res.payload.state, 'done');
	// One call at a time, in this order.
	assert.deepEqual(
		calls.filter(call => call.step).map(call => call.step),
		['claim', 'search', 'reply', 'line'],
	);
	// Each call goes to its own model, because Mistral's limit is per model:
	// the reply keeps the reply model, the two small steps use others.
	const modelOf = step => calls.find(call => call.step === step).body.model;
	assert.equal(modelOf('reply'), CONFIG.mistral.model);
	assert.equal(modelOf('claim'), CONFIG.factCheck.claimModel);
	assert.equal(modelOf('line'), CONFIG.factCheck.lineModel);
	assert.notEqual(modelOf('claim'), modelOf('reply'));
	assert.notEqual(modelOf('line'), modelOf('reply'));

	// The reply is written exactly as without a source.
	const reply = calls.find(call => call.step === 'reply');
	assert.ok(reply.body.messages[0].content.includes('You have no sources'));
	assert.ok(!JSON.stringify(reply.body).includes('ouest-france.fr'));

	assert.equal(
		publishedPost(calls).body.status,
		`@julien ${ANSWER}\n\n${LAW_LINE}\nhttps://www.ouest-france.fr/education/portables-interdits`,
	);
	assert.equal(
		kvStore.get('calm:factcheck:log')[0].citedUrl,
		'https://www.ouest-france.fr/education/portables-interdits',
	);
});

test('in on mode a sentence that fails a check means no link at all', async t => {
	onMode(t);
	for (const line of [
		'NONE',
		// A figure the source does not give.
		'Selon Ouest-France, le portable est interdit au collège depuis 2015.',
		// A verdict.
		'Selon Ouest-France, il est faux de dire que le portable est autorisé au collège depuis 2018.',
		// Another publisher.
		'Selon l’AFP, le portable est interdit au collège depuis 2018.',
		// The call fails.
		new Error('rate limited'),
	]) {
		kvStore.clear();
		recordBackground();
		const calls = onModeNetwork({ claim: LAW_CLAIM, organic: LAW_RESULT, line });
		const res = await run(calm, request({ instance: 'pouet', statusId: '100' }));
		assert.equal(res.payload.state, 'done', String(line));
		assert.equal(publishedPost(calls).body.status, `@julien ${ANSWER}`, String(line));
	}
});

test('in on mode nothing relevant found means no sentence call at all', async t => {
	onMode(t);
	recordBackground();
	const calls = onModeNetwork({
		claim: LAW_CLAIM,
		organic: [{ link: 'https://www.ouest-france.fr/sport/x', title: 'Football', snippet: 'Le match de samedi.' }],
		line: LAW_LINE,
	});
	await run(calm, request({ instance: 'pouet', statusId: '100' }));
	assert.ok(!calls.some(call => call.step === 'line'), 'two calls only when there is no source');
	assert.equal(publishedPost(calls).body.status, `@julien ${ANSWER}`);
});

test('in on mode a failed search still gives the usual reply', async t => {
	onMode(t);
	recordBackground();
	const calls = onModeNetwork({ claim: LAW_CLAIM, organic: new Error('search down'), line: LAW_LINE });
	const res = await run(calm, request({ instance: 'pouet', statusId: '100' }));
	assert.equal(res.payload.state, 'done');
	assert.equal(publishedPost(calls).body.status, `@julien ${ANSWER}`);
});

test('in on mode a thread in another language gets no source sentence', async t => {
	onMode(t);
	recordBackground();
	const spanish = post({ language: 'es', content: '<p>La ley de 2018 prohíbe el móvil en el colegio.</p>' });
	const calls = onModeNetwork({ claim: LAW_CLAIM, organic: LAW_RESULT, line: LAW_LINE, root: spanish });
	await run(calm, request({ instance: 'pouet', statusId: '100' }));
	assert.equal(publishedPost(calls).body.language, 'es');
	assert.ok(!calls.some(call => call.step === 'line'), 'no English sentence under a Spanish thread');
	assert.equal(publishedPost(calls).body.status, `@julien ${ANSWER}`);
});

test('a rate-limited reply is waited out once, then published', async t => {
	const waitMs = CONFIG.mistral.rateLimitWaitMs;
	CONFIG.mistral.rateLimitWaitMs = 5;
	t.after(() => {
		CONFIG.mistral.rateLimitWaitMs = waitMs;
	});
	const calls = stubFetch();
	const network = global.fetch;
	let modelCalls = 0;
	global.fetch = async (url, options = {}) => {
		if (url.includes('api.mistral.ai')) {
			modelCalls += 1;
			if (modelCalls === 1) return { ok: false, status: 429, json: async () => ({}) };
		}
		return network(url, options);
	};
	const res = await run(calm, request({ instance: 'pouet', statusId: '100' }));
	assert.equal(res.payload.state, 'done');
	assert.equal(modelCalls, 2);
	assert.equal(publishedPost(calls).body.status, `@julien ${ANSWER}`);
});

test('the wait follows Retry-After, capped, and a second 429 fails the press', async t => {
	const maxWait = CONFIG.mistral.maxRateLimitWaitMs;
	CONFIG.mistral.maxRateLimitWaitMs = 20;
	t.after(() => {
		CONFIG.mistral.maxRateLimitWaitMs = maxWait;
	});
	stubFetch();
	const network = global.fetch;
	let modelCalls = 0;
	const started = Date.now();
	global.fetch = async (url, options = {}) => {
		if (url.includes('api.mistral.ai')) {
			modelCalls += 1;
			// Asks for an hour; the cap keeps the press to 20 ms here.
			return { ok: false, status: 429, headers: new Headers({ 'retry-after': '3600' }), json: async () => ({}) };
		}
		return network(url, options);
	};
	const res = await run(calm, request({ instance: 'pouet', statusId: '100' }));
	assert.equal(modelCalls, 2, 'one retry only');
	assert.equal(res.payload.error, 'rate_limit');
	assert.ok(Date.now() - started < 1000, 'the wait is capped');
	assert.deepEqual(threadKeys(), [], 'a failed press frees the lotus');
});

