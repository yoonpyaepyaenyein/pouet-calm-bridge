import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIG } from '../lib/config.js';
import { sourceName } from '../lib/factcheck.js';
import {
	lineProblem,
	sourcePrefix,
	sourceRoom,
	withSource,
	writeSourceLine,
} from '../lib/sourceLine.js';

process.env.MISTRAL_API_KEY = 'model-key';

const CLAIM = 'La loi de 2018 interdit les téléphones portables dans les collèges.';
const SOURCE = {
	id: 'S1',
	url: 'https://www.ouest-france.fr/education/portables-interdits',
	name: 'Ouest-France',
	title: 'Portables interdits dans les lycées : « Les établissements ne sont pas prêts »',
	snippet: 'Déjà en vigueur de la maternelle au collège depuis 2018, l’interdiction du téléphone portable sera étendue aux lycées dès la rentrée par la loi.',
};
const check = (line, extra = {}) =>
	lineProblem(line, {
		claim: CLAIM,
		source: SOURCE,
		prefix: sourcePrefix('Ouest-France', 'fr'),
		maxCharacters: 200,
		...extra,
	});

test('a sentence that reports the source in its own words passes', () => {
	assert.equal(
		check('Selon Ouest-France, le téléphone portable est interdit de la maternelle au collège depuis 2018.'),
		null,
	);
});

test('each rule refuses what it protects readers from', () => {
	const cases = {
		none: 'NONE',
		no_prefix: 'Ouest-France indique que le portable est interdit au collège depuis 2018.',
		too_long: `Selon Ouest-France, le portable est interdit au collège depuis 2018${' et'.repeat(80)}.`,
		markup: 'Selon Ouest-France, le portable est interdit au collège depuis 2018, voir https://x.fr.',
		unfinished: 'Selon Ouest-France, le portable est interdit au collège depuis 2018',
		new_number: 'Selon Ouest-France, le portable est interdit au collège depuis 2015.',
		off_claim: 'Selon Ouest-France, les établissements ne sont pas prêts.',
		verdict: 'Selon Ouest-France, il est faux de dire que le portable est autorisé au collège en 2018.',
		copied: 'Selon Ouest-France, déjà en vigueur de la maternelle au collège depuis 2018, l’interdiction du téléphone portable.',
	};
	for (const [problem, line] of Object.entries(cases)) {
		assert.equal(check(line), problem, line);
	}
});

test('a section called "Vrai ou faux" is a name, not a verdict', () => {
	const source = { ...SOURCE, name: 'franceinfo', title: 'Vrai ou faux : le portable au collège' };
	assert.equal(
		lineProblem(
			'Selon franceinfo, la rubrique Vrai ou faux indique que le téléphone portable est interdit au collège depuis 2018.',
			{ claim: CLAIM, source, prefix: sourcePrefix('franceinfo', 'fr'), maxCharacters: 200 },
		),
		null,
	);
});

test('the opening follows the reply language', () => {
	assert.equal(sourcePrefix('AFP', 'fr'), 'Selon l’AFP, ');
	assert.equal(sourcePrefix('Le Monde', 'fr'), 'Selon Le Monde, ');
	assert.equal(sourcePrefix('AFP', 'en'), 'According to AFP, ');
	assert.equal(sourceName('droitalinfo.org'), "Droit à l'Info");
});

test('the link goes under its sentence, and the room left is counted as Mastodon does', () => {
	assert.equal(withSource('@lea Bonjour.', 'Selon X, y.', SOURCE), `@lea Bonjour.\n\nSelon X, y.\n${SOURCE.url}`);
	assert.equal(withSource('@lea Bonjour.', null, SOURCE), '@lea Bonjour.');
	// 500 - 100 - blank line (2) - line break (1) - link (23)
	assert.equal(sourceRoom('a'.repeat(100)), CONFIG.maxStatusCharacters - 100 - 26);
});

const modelReturns = response => {
	const calls = [];
	global.fetch = async (url, options) => {
		calls.push(JSON.parse(options.body));
		return response;
	};
	return calls;
};

test('the sentence is asked for once, with the source as data', async () => {
	const line = 'Selon Ouest-France, le téléphone portable est interdit de la maternelle au collège depuis 2018.';
	const calls = modelReturns({
		ok: true,
		status: 200,
		json: async () => ({ choices: [{ message: { content: line } }] }),
	});
	assert.equal(
		await writeSourceLine({ claim: CLAIM, source: SOURCE, language: 'fr', maxCharacters: 200 }),
		line,
	);
	assert.equal(calls.length, 1);
	assert.ok(calls[0].messages[0].content.includes('Start exactly with "Selon Ouest-France, "'));
	// Asked for less than the real limit (200), with a single fact.
	assert.ok(calls[0].messages[0].content.includes('at most 160 characters'));
	assert.ok(calls[0].messages[0].content.includes('no "but", "mais"'));
	assert.ok(calls[0].messages[1].content.includes('"publisher":"Ouest-France"'));
});

test('a sentence refused for the rate limit is asked once more after a short wait', async t => {
	const waitMs = CONFIG.factCheck.lineRateLimitWaitMs;
	CONFIG.factCheck.lineRateLimitWaitMs = 5;
	t.after(() => {
		CONFIG.factCheck.lineRateLimitWaitMs = waitMs;
	});
	const line = 'Selon Ouest-France, le téléphone portable est interdit de la maternelle au collège depuis 2018.';
	let calls = 0;
	global.fetch = async () => {
		calls += 1;
		return calls === 1
			? { ok: false, status: 429, json: async () => ({}) }
			: { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: line } }] }) };
	};
	assert.equal(
		await writeSourceLine({ claim: CLAIM, source: SOURCE, language: 'fr', maxCharacters: 200 }),
		line,
	);
	assert.equal(calls, 2);
});

test('a failed or refused sentence gives no sentence, and never throws', async t => {
	const waitMs = CONFIG.factCheck.lineRateLimitWaitMs;
	CONFIG.factCheck.lineRateLimitWaitMs = 5;
	t.after(() => {
		CONFIG.factCheck.lineRateLimitWaitMs = waitMs;
	});
	modelReturns({ ok: false, status: 429, json: async () => ({}) });
	assert.equal(await writeSourceLine({ claim: CLAIM, source: SOURCE, language: 'fr', maxCharacters: 200 }), null);
	modelReturns({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'NONE' } }] }) });
	assert.equal(await writeSourceLine({ claim: CLAIM, source: SOURCE, language: 'fr', maxCharacters: 200 }), null);
	global.fetch = async () => {
		throw new Error('network down');
	};
	assert.equal(await writeSourceLine({ claim: CLAIM, source: SOURCE, language: 'fr', maxCharacters: 200 }), null);
});

test('a claim with a figure needs a sentence giving that figure', () => {
	// The real dry run: written under a claim of a 40 % rise in spending, it
	// reads as calling the claim wrong without saying anything about 40 %.
	const claim = 'le nouveau budget augmente les dépenses de 40 % selon un rapport officiel';
	const source = { title: 'Budget 2026', snippet: '40 milliards d’euros à trouver pour ramener le déficit public à 4,6 % en 2026.' };
	assert.equal(
		lineProblem('Selon Ouest-France, le gouvernement vise à réduire le déficit public en économisant plutôt qu’en augmentant les dépenses.', {
			claim, source, prefix: sourcePrefix('Ouest-France', 'fr'), maxCharacters: 200,
		}),
		'missing_figure',
	);
});

test('markdown around the publisher is dropped before the checks', async () => {
	const written = 'Selon *Ouest-France*, l’interdiction des téléphones portables s’applique déjà aux collèges en France depuis 2018.';
	global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: written } }] }) });
	assert.equal(
		await writeSourceLine({ claim: CLAIM, source: SOURCE, language: 'fr', maxCharacters: 200 }),
		'Selon Ouest-France, l’interdiction des téléphones portables s’applique déjà aux collèges en France depuis 2018.',
	);
});

