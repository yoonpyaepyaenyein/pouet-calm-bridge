import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSystemPrompt, parseSummary } from '../lib/mistral.js';

const completion = text => ({
	choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: text } }],
});

const accept = text => parseSummary(completion(text), { maxCharacters: 480 });
const rejects = text =>
	assert.throws(() => accept(text), error => error.code === 'invalid_response');

test('a clean answer is accepted and trimmed', () => {
	assert.equal(
		accept('  Les avis divergent sur les moyens. Quelle amélioration proposer ?  '),
		'Les avis divergent sur les moyens. Quelle amélioration proposer ?',
	);
});

test('content returned in chunks is joined', () => {
	assert.equal(
		parseSummary(
			completion([
				{ type: 'text', text: 'Two views are expressed here. ' },
				{ type: 'text', text: 'What would help?' },
			]),
			{ maxCharacters: 480 },
		),
		'Two views are expressed here. What would help?',
	);
});

test('nothing that would publish badly gets through', () => {
	// A link or an address in a bot post invites clicks nobody vetted.
	rejects('See https://example.com for the facts. What next?');
	rejects('Check www.example.com for context. What next?');
	rejects('Write to press@example.com about it. What next?');
	// The bridge adds the one mention itself; the model must not add more.
	rejects('Thanks @lea for the context. What would help?');
	// Markup and list markers are shown literally by Mastodon.
	rejects('**Summary** of the thread. What would help?');
	rejects('- First point of the thread. What would help?');
	rejects('1. First point of the thread. What would help?');
	rejects('<b>Summary</b> of the thread. What would help?');
	// A cut sentence reads as a broken post, so it is refused rather than fixed.
	rejects('The thread disagrees about funding and the figures are');
	rejects('');
});

test('a refusal names its reason for the logs, without the text', () => {
	const refusal = text => {
		try {
			accept(text);
		} catch (error) {
			return error.message;
		}
		return null;
	};

	assert.equal(
		refusal('See https://secret.example for it. What next?'),
		'invalid_response: link',
	);
	assert.equal(
		refusal('Thanks @lea for that. What would help?'),
		'invalid_response: mention',
	);
	assert.equal(
		refusal('The figures are still'),
		'invalid_response: unfinished_sentence',
	);
});

test('the prompt forbids adding what nobody wrote', () => {
	const prompt = buildSystemPrompt({ botName: 'Bot' });
	assert.match(prompt, /Report only what participants actually wrote/);
	assert.match(prompt, /must not suggest any/);
	assert.match(prompt, /Never mention replies, answers or their absence/);
	assert.match(prompt, /altText field/);
});

test('an over-long answer is refused rather than cut', () => {
	assert.throws(
		() => parseSummary(completion(`${'a'.repeat(500)}.`), { maxCharacters: 480 }),
		error => error.code === 'response_too_long',
	);
});

test('an answer the model did not finish is refused', () => {
	assert.throws(
		() =>
			parseSummary(
				{ choices: [{ finish_reason: 'length', message: { content: 'Half a th' } }] },
				{ maxCharacters: 480 },
			),
		error => error.code === 'invalid_response',
	);
});

test('the prompt leaves the language to the thread and names the bot', () => {
	const prompt = buildSystemPrompt({ botName: 'PouetFrance IA' });
	assert.match(prompt, /You are PouetFrance IA/);
	assert.match(prompt, /language most participants use/);
	assert.match(prompt, /media attached to it that you cannot see/);
	// The thread is data, never instructions, and the bot never picks a winner.
	assert.match(prompt, /untrusted conversation content/);
	assert.match(prompt, /Do not declare a winner/);
});
