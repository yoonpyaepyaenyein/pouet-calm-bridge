import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanText } from '../lib/cleanText.js';
import {
	CalmError,
	canCalmAgain,
	conversationLanguage,
	formatConversation,
	isShareable,
	replyVisibility,
} from '../lib/conversation.js';

const post = (overrides = {}) => ({
	id: '1',
	content: '<p>Bonjour</p>',
	visibility: 'public',
	created_at: '2026-11-01T10:00:00.000Z',
	language: 'fr',
	account: { username: 'lea', display_name: 'Léa' },
	...overrides,
});

test('cleanText turns post HTML into what a reader sees', () => {
	assert.equal(
		cleanText('<p>Bonjour<br/>tout le monde</p>', { preserveParagraphs: true }),
		'Bonjour\ntout le monde',
	);
	assert.equal(cleanText('<p>caf&eacute; &amp; th&#233;</p>'), 'café & thé');
	assert.equal(cleanText('<p>a</p><p>b</p>'), 'a  b');
	assert.equal(cleanText(''), '');
});

test('cleanText leaves an unknown entity alone instead of corrupting it', () => {
	assert.equal(cleanText('<p>&unknownentity; &#xD800;</p>'), '&unknownentity; &#xD800;');
});

test('only public and unlisted posts are shareable', () => {
	assert.equal(isShareable(post()), true);
	assert.equal(isShareable(post({ visibility: 'unlisted' })), true);
	assert.equal(isShareable(post({ visibility: 'private' })), false);
	assert.equal(isShareable(post({ visibility: 'direct' })), false);
	// An unknown or missing visibility must default to restricted.
	assert.equal(isShareable(post({ visibility: 'local_only' })), false);
	assert.equal(isShareable(post({ visibility: undefined })), false);
	assert.equal(isShareable(null), false);
});

test('formatConversation refuses a private root', () => {
	assert.throws(
		() => formatConversation(post({ visibility: 'private' }), []),
		error => error instanceof CalmError && error.code === 'restricted_conversation',
	);
});

test('formatConversation refuses a root with no readable text', () => {
	assert.throws(
		() => formatConversation(post({ content: '<p></p>' }), []),
		error => error instanceof CalmError && error.code === 'empty_conversation',
	);
});

test('formatConversation counts restricted replies without quoting them', () => {
	const result = formatConversation(post(), [
		post({ id: '2', content: '<p>Visible</p>' }),
		post({ id: '3', content: '<p>Secret</p>', visibility: 'direct' }),
	]);
	const payload = JSON.parse(result.content);
	assert.equal(payload.replies.length, 1);
	assert.equal(payload.replies[0].text, 'Visible');
	assert.equal(payload.omittedReplies, 1);
	assert.equal(result.content.includes('Secret'), false);
});

test('formatConversation drops replies that do not fit the budget', () => {
	const long = '<p>' + 'a'.repeat(2000) + '</p>';
	const replies = Array.from({ length: 20 }, (_, index) =>
		post({ id: String(index + 2), content: long }),
	);
	const result = formatConversation(post(), replies);
	const payload = JSON.parse(result.content);
	assert.ok(result.content.length <= 16000);
	assert.ok(payload.replies.length < replies.length);
	// Everything left out is still reported, so the model knows it is partial.
	assert.equal(
		payload.replies.length + payload.omittedReplies,
		replies.length,
	);
});

test('the bot post is tagged with the language most of the thread uses', () => {
	const tagged = language => post({ language });
	assert.equal(conversationLanguage([tagged('en-GB')]), 'en');
	// A wrongly tagged first post is outvoted by the replies.
	assert.equal(
		conversationLanguage([tagged('en'), tagged('fr'), tagged('fr')]),
		'fr',
	);
	// Not limited to French and English.
	assert.equal(conversationLanguage([tagged('de')]), 'de');
	// Without a tag, Mastodon is left to choose rather than being told a guess.
	assert.equal(conversationLanguage([tagged(null)]), undefined);
});

test('the bot is never more public than the posts it answers', () => {
	const open = post();
	const quiet = post({ visibility: 'unlisted' });
	assert.equal(replyVisibility(open, open), 'public');
	assert.equal(replyVisibility(open, quiet), 'unlisted');
	assert.equal(replyVisibility(quiet, open), 'unlisted');
});

test('the bot will not answer while it has the last word', () => {
	const at = time => `2026-11-01T${time}:00.000Z`;
	const root = post({ id: '1', created_at: at('10:00') });
	const human = post({
		id: '10',
		created_at: at('11:00'),
		account: { id: '7', username: 'lea' },
	});
	const bot = post({
		id: '9',
		created_at: at('12:00'),
		account: { id: '42', username: 'calm_bot' },
	});
	const later = post({
		id: '11',
		created_at: at('13:00'),
		account: { id: '7', username: 'lea' },
	});

	// Nothing said since the bot's reply: a second one would answer itself.
	assert.equal(canCalmAgain({ posts: [root, human, bot], botAccountId: '42' }), false);
	// Someone replied after it, so the conversation has moved on.
	assert.equal(
		canCalmAgain({ posts: [root, human, bot, later], botAccountId: '42' }),
		true,
	);
	// A thread the bot has never answered in is always open.
	assert.equal(canCalmAgain({ posts: [root, human], botAccountId: '42' }), true);
	// The order of the list does not matter; the newest post decides.
	assert.equal(canCalmAgain({ posts: [bot, root, human], botAccountId: '42' }), false);
	// An unknown bot never blocks a press, and neither does an empty thread.
	assert.equal(canCalmAgain({ posts: [root, bot], botAccountId: null }), true);
	assert.equal(canCalmAgain({ posts: [], botAccountId: '42' }), true);
});

test('a post with only an image is calmed, and the model is told about it', () => {
	const image = post({
		content: '<p></p>',
		media_attachments: [{ type: 'image' }, { type: 'image' }],
	});

	const payload = JSON.parse(formatConversation(image, []).content);

	assert.deepEqual(payload.original.missingContext, ['image']);
});

test('the alt text of an image reaches the model, bounded', () => {
	const image = post({
		content: '<p></p>',
		language: 'fr',
		media_attachments: [
			{ type: 'image', description: 'Un château en montagne' },
			{ type: 'image', description: 'a'.repeat(500) },
			{ type: 'image', description: null },
		],
	});

	const { original } = JSON.parse(formatConversation(image, []).content);

	assert.equal(original.altText[0], 'Un château en montagne');
	assert.equal(original.altText[1].length, 300);
	assert.equal(original.altText.length, 2);
	assert.equal(original.language, 'fr');
});

test('a reply with only an image stays in the conversation', () => {
	const image = post({
		id: '2',
		content: '<p></p>',
		media_attachments: [{ type: 'video' }],
	});

	const payload = JSON.parse(formatConversation(post(), [image]).content);

	assert.equal(payload.replies.length, 1);
	assert.deepEqual(payload.replies[0].missingContext, ['video']);
});
