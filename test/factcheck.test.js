import assert from 'node:assert/strict';
import test from 'node:test';
import {
	cleanQuery,
	factCheckMode,
	gatherEvidence,
	matchSource,
	readFactCheckLog,
	recordFactCheck,
	trustedSources,
} from '../lib/factcheck.js';
import { setKvClient } from '../lib/kv.js';

const lists = new Map();
setKvClient({
	async lpush(key, value) {
		lists.set(key, [value, ...(lists.get(key) || [])]);
	},
	async ltrim(key, start, stop) {
		lists.set(key, (lists.get(key) || []).slice(start, stop + 1));
	},
	async expire() {},
	async lrange(key, start, stop) {
		return (lists.get(key) || []).slice(start, stop + 1);
	},
});

process.env.MISTRAL_API_KEY = 'model-key';
process.env.SERPER_API_KEY = 'search-key';

const CONTENT = JSON.stringify({
	original: { author: 'Léa', text: 'Le budget augmente de 40 % selon le rapport.' },
	replies: [{ author: 'Julien', text: 'C’est faux, le chiffre réel est plus bas.' }],
});

/** A model answer, as the claim step expects it. */
const modelSays = payload => ({
	ok: true,
	status: 200,
	json: async () => ({
		choices: [{ message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) } }],
	}),
});

const searchSays = organic => ({ ok: true, status: 200, json: async () => ({ organic }) });

const stubNetwork = ({ model, search }) => {
	const calls = [];
	global.fetch = async (url, options = {}) => {
		calls.push({ url, body: options.body ? JSON.parse(options.body) : null, headers: options.headers });
		if (url.includes('api.mistral.ai')) return typeof model === 'function' ? model(options) : model;
		if (url.includes('serper.dev')) return typeof search === 'function' ? search(options) : search;
		throw new Error(`unexpected fetch: ${url}`);
	};
	return calls;
};

const CHECKABLE = {
	checkable: true,
	claim: 'Le budget augmente de 40 %.',
	query: 'budget hausse 40 % rapport',
};

test('the mode is off unless set to log or on', () => {
	for (const [value, expected] of [
		[undefined, 'off'],
		['', 'off'],
		['LOG', 'log'],
		[' on ', 'on'],
		['yes', 'off'],
	]) {
		if (value === undefined) delete process.env.FACTCHECK_MODE;
		else process.env.FACTCHECK_MODE = value;
		assert.equal(factCheckMode(), expected, String(value));
	}
	delete process.env.FACTCHECK_MODE;
});

test('the allowlist reads hosts and sections, and drops anything else', () => {
	assert.deepEqual(
		trustedSources('https://www.Ouest-France.fr/, lemonde.fr/les-decodeurs/, not a host, javascript:alert(1)'),
		[
			{ host: 'ouest-france.fr', path: '' },
			{ host: 'lemonde.fr', path: '/les-decodeurs' },
		],
	);
	// Unset, the built-in list is used.
	assert.ok(trustedSources('').some(source => source.host === 'factuel.afp.com'));
});

test('only https links from a trusted host and section count', () => {
	const sources = trustedSources('ouest-france.fr,lemonde.fr/les-decodeurs');
	const yes = [
		'https://www.ouest-france.fr/bretagne/article',
		'https://rennes.ouest-france.fr/article',
		'https://www.lemonde.fr/les-decodeurs/article/2026/11/01/x.html',
	];
	const no = [
		'http://www.ouest-france.fr/article',
		'https://ouest-france.fr.example.com/article',
		'https://fakeouest-france.fr/article',
		'https://www.lemonde.fr/politique/article',
		'https://www.lemonde.fr/les-decodeurs-faux/article',
		'https://user:pass@ouest-france.fr/article',
		'not a url',
	];
	for (const url of yes) assert.ok(matchSource(url, sources), url);
	for (const url of no) assert.equal(matchSource(url, sources), null, url);
});

test('a query cannot carry handles, links or search operators', () => {
	assert.equal(
		cleanQuery('budget @julien site:example.com "40 %" -faux OR https://x.y/z mail@x.fr hausse'),
		'budget 40 % faux hausse',
	);
	assert.ok(cleanQuery('mot '.repeat(100)).length <= 120);
});

test('an opinion thread is not searched', async () => {
	const calls = stubNetwork({ model: modelSays({ checkable: false, claim: '', query: '' }) });
	const result = await gatherEvidence({ content: CONTENT });
	assert.equal(result.checkable, false);
	assert.deepEqual(result.evidence, []);
	assert.ok(!calls.some(call => call.url.includes('serper.dev')));
});

test('a factual claim is searched on trusted sites only, and only those results are kept', async () => {
	process.env.FACTCHECK_DOMAINS = 'ouest-france.fr,factuel.afp.com';
	const calls = stubNetwork({
		model: modelSays(CHECKABLE),
		search: searchSays([
			{ link: 'https://www.example.com/blog', title: 'Blog', snippet: 'Untrusted.' },
			{ link: 'https://www.ouest-france.fr/budget', title: 'Budget 2026', snippet: 'Le rapport indique une hausse de 4 %.', date: '2 nov. 2026' },
			{ link: 'https://www.ouest-france.fr/budget', title: 'Budget 2026', snippet: 'Duplicate.' },
			{ link: 'https://factuel.afp.com/budget', title: 'Vérification', snippet: 'Le chiffre de 40 % ne figure pas dans le rapport.' },
			{ link: 'https://www.ouest-france.fr/autre', title: 'Third', snippet: 'Over the limit.' },
		]),
	});
	const result = await gatherEvidence({ content: CONTENT });

	const search = calls.find(call => call.url.includes('serper.dev'));
	assert.equal(search.headers['X-API-KEY'], 'search-key');
	assert.equal(
		search.body.q,
		'budget hausse 40 % rapport (site:ouest-france.fr OR site:factuel.afp.com)',
	);
	assert.deepEqual(
		result.evidence.map(item => [item.id, item.url]),
		[
			['S1', 'https://www.ouest-france.fr/budget'],
			['S2', 'https://factuel.afp.com/budget'],
		],
	);
	assert.equal(result.evidence[0].date, '2 nov. 2026');
	// The thread itself never goes to the search engine, only the query.
	assert.ok(!JSON.stringify(search.body).includes('Julien'));
	delete process.env.FACTCHECK_DOMAINS;
});

test('nothing that goes wrong ever throws', async () => {
	const cases = [
		{ model: { ok: false, status: 500, json: async () => ({}) } },
		{ model: modelSays('not json') },
		{ model: modelSays(CHECKABLE), search: { ok: false, status: 429, json: async () => ({}) } },
		{ model: modelSays(CHECKABLE), search: searchSays('not a list') },
		{ model: () => Promise.reject(new Error('network down')) },
	];
	for (const network of cases) {
		stubNetwork(network);
		const result = await gatherEvidence({ content: CONTENT });
		assert.deepEqual(result.evidence, []);
	}
});

test('no search key means no search, and no error', async () => {
	const key = process.env.SERPER_API_KEY;
	delete process.env.SERPER_API_KEY;
	const calls = stubNetwork({ model: modelSays(CHECKABLE) });
	const result = await gatherEvidence({ content: CONTENT });
	assert.equal(result.skipped, 'no_search_key');
	assert.ok(!calls.some(call => call.url.includes('serper.dev')));
	process.env.SERPER_API_KEY = key;
});

test('a slow search is cut off at the time limit', async t => {
	const { CONFIG } = await import('../lib/config.js');
	const timeoutMs = CONFIG.factCheck.timeoutMs;
	CONFIG.factCheck.timeoutMs = 30;
	t.after(() => {
		CONFIG.factCheck.timeoutMs = timeoutMs;
	});
	stubNetwork({
		model: modelSays(CHECKABLE),
		search: options =>
			new Promise((resolve, reject) => {
				options.signal.addEventListener('abort', () => {
					const error = new Error('aborted');
					error.name = 'AbortError';
					reject(error);
				});
			}),
	});
	const result = await gatherEvidence({ content: CONTENT });
	assert.equal(result.error, 'timeout');
	assert.deepEqual(result.evidence, []);
});

test('the review log keeps the search, never the thread', async () => {
	lists.clear();
	await recordFactCheck({
		instanceId: 'pouet',
		rootId: '100',
		mode: 'log',
		result: {
			checkable: true,
			claim: CHECKABLE.claim,
			query: CHECKABLE.query,
			evidence: [{ id: 'S1', url: 'https://www.ouest-france.fr/budget', site: 'ouest-france.fr', title: 'Budget', snippet: 'Hausse de 4 %.', date: null }],
			ms: 1200,
		},
	});
	const [entry] = await readFactCheckLog();
	assert.equal(entry.rootId, '100');
	assert.equal(entry.query, CHECKABLE.query);
	assert.equal(entry.evidence[0].url, 'https://www.ouest-france.fr/budget');
	assert.ok(!JSON.stringify(entry).includes('Julien'));
	assert.ok(!JSON.stringify(entry).includes('Léa'));
});
