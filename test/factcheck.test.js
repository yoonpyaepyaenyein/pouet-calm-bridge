import assert from 'node:assert/strict';
import test from 'node:test';
import {
	defaultDomains,
	claimFigures,
	cleanQuery,
	figuresCovered,
	isAboutClaim,
	quantitiesIn,
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
			{ link: 'https://www.ouest-france.fr/budget', title: 'Budget 2026', snippet: 'Le rapport ne dit pas que le budget augmente de 40 %.', date: '2 nov. 2026' },
			{ link: 'https://www.ouest-france.fr/budget', title: 'Budget 2026', snippet: 'Le budget augmente de 40 %, duplicate.' },
			{ link: 'https://factuel.afp.com/budget', title: 'Vérification', snippet: 'Non, le budget n’augmente pas de 40 % : le chiffre ne figure pas dans le rapport.' },
			{ link: 'https://www.ouest-france.fr/autre', title: 'Third', snippet: 'Le budget augmente de 40 %, over the limit.' },
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

test('each source gives at most one result, so one site cannot fill every slot', async () => {
	process.env.FACTCHECK_DOMAINS = 'ouest-france.fr,factuel.afp.com';
	stubNetwork({
		model: modelSays(CHECKABLE),
		search: searchSays([
			{ link: 'https://www.ouest-france.fr/a', title: 'A', snippet: 'Le budget augmente de 40 % selon Ouest-France.' },
			{ link: 'https://rennes.ouest-france.fr/b', title: 'B', snippet: 'Le budget augmente de 40 %, second article.' },
			{ link: 'https://factuel.afp.com/c', title: 'C', snippet: 'L’AFP vérifie si le budget augmente de 40 %.' },
		]),
	});
	const result = await gatherEvidence({ content: CONTENT });
	assert.deepEqual(
		result.evidence.map(item => item.url),
		['https://www.ouest-france.fr/a', 'https://factuel.afp.com/c'],
	);
	delete process.env.FACTCHECK_DOMAINS;
});

test('a result about something else is dropped before the model sees it', async () => {
	// The real dry run: a claim about a 40 % rise, and the search returned a
	// 5 % deficit and a 2-3 % rise. The model then tried to cite one of them.
	const claim = 'Le nouveau budget augmente les dépenses de 40 % selon un rapport officiel';
	process.env.FACTCHECK_DOMAINS = 'ouest-france.fr,lemonde.fr/les-decodeurs';
	stubNetwork({
		model: modelSays({ checkable: true, claim, query: 'budget dépenses augmentation rapport' }),
		search: searchSays([
			{ link: 'https://www.ouest-france.fr/economie/budget-2027', title: 'Ce que l’on sait du projet de budget 2027', snippet: 'Le gouvernement vise 5 % de déficit en 2027 après 5,4 % en 2026.' },
			{ link: 'https://www.lemonde.fr/les-decodeurs/article/secu', title: 'Que contient le budget de la « Sécu »', snippet: 'Hausse des dépenses d’assurance-maladie de 2 à 3 %.' },
		]),
	});
	const result = await gatherEvidence({ content: CONTENT });
	assert.deepEqual(result.evidence, []);
	assert.equal(result.offTopic, 2);
	delete process.env.FACTCHECK_DOMAINS;
});

test('a result must carry every number of the claim and share its subject', () => {
	const law = 'La loi de 2018 interdit les téléphones portables dans les collèges en France';
	// The real result the dry run found: it settles the claim.
	assert.ok(
		isAboutClaim(law, {
			title: 'Les téléphones bientôt interdits au lycée ? Le dispositif',
			snippet: 'En effet, une loi de 2018 encadre déjà l’utilisation des smartphones, bannis dans les écoles et collèges.',
		}),
	);
	// Same subject, another year.
	assert.ok(!isAboutClaim(law, { title: 'Portable au collège', snippet: 'Une loi de 2010 interdit les téléphones.' }));
	// Same year, another subject.
	assert.ok(!isAboutClaim(law, { title: 'Réforme 2018', snippet: 'La loi de 2018 sur le logement.' }));
	// "5,4" and "5.4" are the same figure.
	assert.ok(isAboutClaim('Le déficit atteint 5,4 % du budget national', { title: 'Déficit', snippet: 'Un déficit de 5.4 % du budget national.' }));
});

test('the built-in list searches franceinfo on its current host', () => {
	const sources = trustedSources('');
	assert.ok(matchSource('https://www.franceinfo.fr/vrai-ou-fake/canons-a-son_123.html', sources));
	assert.ok(!sources.some(source => source.host === 'francetvinfo.fr'));
});

test('Les Surligneurs are searched as a whole site, under their own name', async () => {
	const { sourceName } = await import('../lib/factcheck.js');
	const sources = trustedSources('');
	assert.ok(matchSource('https://lessurligneurs.eu/peut-on-reduire-la-contribution-francaise/', sources));
	assert.equal(sourceName('lessurligneurs.eu'), 'Les Surligneurs');
});

test('the fact-check models can be changed without touching the reply model', async () => {
	const { CONFIG } = await import('../lib/config.js');
	assert.equal(CONFIG.factCheck.claimModel, process.env.FACTCHECK_CLAIM_MODEL?.trim() || 'ministral-8b-latest');
	assert.equal(CONFIG.factCheck.lineModel, process.env.FACTCHECK_LINE_MODEL?.trim() || 'ministral-3b-latest');
});

test('figures are compared with their unit', () => {
	assert.deepEqual(quantitiesIn('40 %, 40 pour cent, 40 milliards d’euros, 5,4 % et 2018'), [
		{ value: '40', unit: '%' },
		{ value: '40', unit: '%' },
		{ value: '40', unit: 'bn' },
		{ value: '5.4', unit: '%' },
		{ value: '2018', unit: '' },
	]);
	// A bare figure may meet any unit; a figure with a unit needs the same one.
	assert.ok(figuresCovered(quantitiesIn('2018'), quantitiesIn('depuis 2018')));
	assert.ok(!figuresCovered(quantitiesIn('40 %'), quantitiesIn('40 milliards')));
});

test('a claim about 40 % is not settled by articles about 40 billion euros', () => {
	// The real dry run: the search returned both of these for a 40 % claim.
	const claim = 'le nouveau budget augmente les dépenses de 40 % selon un rapport officiel';
	assert.ok(!isAboutClaim(claim, {
		title: 'Budget 2026. Comment trouver 40 milliards d’euros ?',
		snippet: 'Pour le budget 2026, trouver 40 milliards d’euros. 40 milliards d’euros à trouver pour ramener le déficit public à 4,6 % en 2026.',
	}));
	assert.ok(!isAboutClaim(claim, {
		title: 'Budget 2026 : où trouver les 40 milliards d’euros voulus',
		snippet: 'Avec pour objectifs des économies de 40 milliards d’euros. pour 2026 des dépenses à leur niveau de 2025',
	}));
});

test('a unit the model dropped is taken back from the thread', async () => {
	// The real dry run: the post said "40 %" and the claim came back as "40".
	const thread = 'Le nouveau budget augmente les dépenses de 40 % selon le rapport.';
	const claim = 'le nouveau budget augmente les dépenses de 40 selon un rapport';
	assert.deepEqual(claimFigures(claim, thread), [{ value: '40', unit: '%' }]);
	assert.ok(!isAboutClaim(claim, { title: 'Budget 2026', snippet: 'trouver 40 milliards d’euros pour le budget et les dépenses' }, claimFigures(claim, thread)));
	// A figure nobody wrote with a unit stays bare.
	assert.deepEqual(claimFigures('la loi de 2018', 'depuis la loi de 2018'), [{ value: '2018', unit: '' }]);

	// End to end: the claim step drops the unit, the search returns 40 billion.
	process.env.FACTCHECK_DOMAINS = 'ouest-france.fr';
	stubNetwork({
		model: modelSays({ checkable: true, claim, query: 'budget dépenses augmentation rapport' }),
		search: searchSays([
			{ link: 'https://www.ouest-france.fr/budget-2026', title: 'Budget 2026', snippet: 'Trouver 40 milliards d’euros : le budget et les dépenses.' },
		]),
	});
	const result = await gatherEvidence({
		content: JSON.stringify({ original: { text: thread }, replies: [{ text: 'C’est faux.' }] }),
	});
	assert.deepEqual(result.figures, [{ value: '40', unit: '%' }]);
	assert.deepEqual(result.evidence, []);
	delete process.env.FACTCHECK_DOMAINS;
});

test('the claim prompt keeps figures as the thread wrote them', async () => {
	const calls = stubNetwork({ model: modelSays({ checkable: false, claim: '', query: '' }) });
	await gatherEvidence({ content: CONTENT });
	const prompt = calls.find(call => call.url.includes('api.mistral.ai')).body.messages[0].content;
	assert.ok(prompt.includes('never one of your own'));
	assert.ok(prompt.includes('keep each figure with its unit'));
	// French sources are searched in French, whatever the thread's language.
	assert.ok(prompt.includes('Write the claim and the query in French'));
});

test('each app searches its own newspaper, never the other one', () => {
	const hosts = id => trustedSources('', id).map(source => source.host);
	assert.ok(hosts('pouet').includes('ouest-france.fr'));
	assert.ok(!hosts('pouet').includes('humanite.fr'));
	assert.ok(hosts('humanite').includes('humanite.fr'));
	assert.ok(!hosts('humanite').includes('ouest-france.fr'), 'a competitor is not "our" news');
	// The fact-checkers are shared, and an unknown app gets only those.
	for (const id of ['pouet', 'humanite', 'other']) {
		assert.ok(hosts(id).includes('factuel.afp.com'), id);
	}
	assert.deepEqual(defaultDomains('other'), defaultDomains('other').filter(d => d !== 'ouest-france.fr' && d !== 'humanite.fr'));
});

test('the Ouest-France app searches ouest-france.fr, under the id the app sends', async () => {
	// The app sends "ouestFrance"; the instance id the bridge keeps is lower case.
	process.env.CALM_INSTANCES = 'pouet,humanite,ouestfrance';
	process.env.CALM_OUESTFRANCE_HOST = 'social.ouest-france.fr';
	process.env.CALM_OUESTFRANCE_BOT_TOKEN = 'of-token';
	try {
		const { getInstance } = await import('../lib/config.js');
		const instance = getInstance('ouestFrance');
		assert.equal(instance.id, 'ouestfrance');
		assert.equal(instance.host, 'social.ouest-france.fr');
		const hosts = trustedSources('', instance.id).map(source => source.host);
		assert.equal(hosts[0], 'ouest-france.fr', 'its own newspaper comes first');
		assert.ok(!hosts.includes('humanite.fr'), 'not another app\'s newspaper');
		assert.ok(hosts.includes('factuel.afp.com'));
	} finally {
		delete process.env.CALM_INSTANCES;
		delete process.env.CALM_OUESTFRANCE_HOST;
		delete process.env.CALM_OUESTFRANCE_BOT_TOKEN;
	}
});

test('Humanité articles at any section path are matched and named', async () => {
	const { sourceName } = await import('../lib/factcheck.js');
	const sources = trustedSources('', 'humanite');
	// The real article URLs from the site: sections vary, as with 20 Minutes.
	for (const url of [
		'https://www.humanite.fr/monde/aide-humanitaire/une-question-de-vie-ou-de-mort-bombardements',
		'https://www.humanite.fr/social-et-economie/casse-industrielle/la-liquidation-judiciaire-de-fibre-excellence',
	]) {
		assert.ok(matchSource(url, sources), url);
	}
	assert.equal(sourceName('humanite.fr'), 'L’Humanité');
	assert.ok(!matchSource('https://humanite.fr.example.com/x', sources));
});

test('an instance can set its own list, which wins over the built-in one', async () => {
	process.env.FACTCHECK_DOMAINS = '';
	stubNetwork({
		model: modelSays(CHECKABLE),
		search: searchSays([
			{ link: 'https://www.humanite.fr/social/budget', title: 'Budget', snippet: 'Le budget augmente de 40 % selon le rapport.' },
			{ link: 'https://www.ouest-france.fr/budget', title: 'Budget', snippet: 'Le budget augmente de 40 % selon le rapport.' },
		]),
	});
	const result = await gatherEvidence({ content: CONTENT, instance: { id: 'humanite' } });
	assert.deepEqual(result.evidence.map(item => item.site), ['humanite.fr']);
	const custom = await gatherEvidence({ content: CONTENT, instance: { id: 'humanite', factCheckDomains: 'ouest-france.fr' } });
	assert.deepEqual(custom.evidence.map(item => item.site), ['ouest-france.fr']);
});

