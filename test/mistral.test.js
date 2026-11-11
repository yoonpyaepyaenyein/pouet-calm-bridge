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

test('an answer that claims to see the media is refused', () => {
	// The bot only ever has the author's alt text, so this would be a false
	// statement in a public post. The model kept producing these despite the
	// prompt, swapping one noun for another.
	rejects('Hello everyone, this image brings back memories. What next?');
	rejects('Hello everyone, what stands out to you about this space?');
	rejects('Hello everyone, as we can see, opinions differ. What next?');
	rejects('Bonjour à tous, cette photo rappelle des souvenirs. Et vous ?');
	rejects('Bonjour à tous, qu’est-ce qui vous marque dans cet espace ?');
	// Repeating the author's own description is still allowed.
	assert.equal(
		accept('Hello everyone, the author describes a crowded corridor. What next?'),
		'Hello everyone, the author describes a crowded corridor. What next?',
	);
	// Ordinary words must not be caught: only a claim of having looked.
	assert.equal(
		accept('Hello everyone, this is a shared space for everyone. What next?'),
		'Hello everyone, this is a shared space for everyone. What next?',
	);
});

test('the same claim in other words is refused when the thread has media', () => {
	const media = text =>
		assert.throws(
			() => parseSummary(completion(text), { maxCharacters: 480, hasMedia: true }),
			error => error.code === 'invalid_response',
		);
	// What the model wrote after "this image" was banned, in dry runs.
	media('Hello everyone, it is normal to feel differently. What stands out to you about this setting?');
	media('Hello everyone, it is normal to see a place like this and feel differently. Let’s keep it kind.');
	media('Hello everyone, views differ about spaces like the one in the post. Let’s keep it kind.');
	media('Bonjour à tous, cet endroit rappelle des souvenirs différents. Restons courtois.');

	// Ordinary words in a thread without media must not be caught.
	const plain = 'Hello everyone, this place has a long history and views differ. Let’s keep it kind.';
	assert.equal(accept(plain), plain);
	// And a thread with media may still use words that point at nothing seen.
	assert.equal(
		parseSummary(completion('Hello everyone, views differ and that is normal. Let’s keep it kind.'), {
			maxCharacters: 480,
			hasMedia: true,
		}),
		'Hello everyone, views differ and that is normal. Let’s keep it kind.',
	);
});

test('repeating a word the participants used is not claiming to see the media', () => {
	// Found on a device: "Our school corridor is too crowded" plus a photo, and
	// the bot's "the corridor" was refused twice, so the user got an error.
	const options = {
		maxCharacters: 480,
		hasMedia: true,
		threadText: 'our school corridor is too crowded. it has always been like this.',
	};
	const echo = 'Hello everyone, the corridor clearly matters to you both. Let’s keep it kind. What would help?';
	assert.equal(parseSummary(completion(echo), options), echo);

	// The same words are still refused when nobody wrote them.
	assert.throws(
		() => parseSummary(completion(echo), { ...options, threadText: 'it is crowded' }),
		error => error.code === 'invalid_response',
	);
	// And the alt text the author wrote counts as the author's words.
	assert.equal(
		parseSummary(completion(echo), { ...options, threadText: 'a crowded school corridor' }),
		echo,
	);
});

test('inventing sides under a post nobody replied to is refused', () => {
	const alone = text =>
		assert.throws(
			() => parseSummary(completion(text), { maxCharacters: 480, hasReplies: false }),
			error => error.code === 'invalid_response',
		);
	// All four came from devices, each after a prompt rule meant to stop them.
	alone('Hello everyone, some may prefer longer access, others flexibility. Let’s keep it kind. What do you think?');
	alone('Hello everyone, some might see the calm of nature, others the rhythm of daily life. Let’s keep it kind.');
	alone('Hello everyone, different thoughts about school life, whether it’s about space or routines. Let’s keep it kind.');
	alone('Bonjour à tous, certains y voient un lieu de détente, d’autres un passage pratique. Restons courtois.');

	// With no sides invented it passes, and a real thread may describe both.
	const plain = 'Hello everyone, the new city market opens on Saturday. Let’s keep it kind. What are your thoughts?';
	assert.equal(parseSummary(completion(plain), { maxCharacters: 480, hasReplies: false }), plain);
	const real = 'Hello everyone, some want fewer phones in class, others want them for emergencies. Let’s keep it kind.';
	assert.equal(accept(real), real);
});

test('admiring the topic or a picture is refused', () => {
	const seen = { maxCharacters: 480, seesImages: true, hasMedia: true };
	const praise = text =>
		assert.throws(
			() => parseSummary(completion(text), seen),
			error => error.code === 'invalid_response',
		);
	// What a device published about a photo of a castle.
	praise('Hello everyone, this stunning castle nestled in a lush landscape is truly captivating. Let’s keep it kind.');
	praise('Hello everyone, what a lovely view this is. Let’s keep it kind. What are your thoughts?');
	praise('Bonjour à tous, ce paysage magnifique invite au calme. Restons courtois.');

	// Naming what is there plainly passes.
	const plain = 'Hello everyone, this image shows a castle above a forest. Let’s keep it kind. What are your thoughts?';
	assert.equal(parseSummary(completion(plain), seen), plain);
	// And echoing a participant who used the word is not the bot's own taste.
	const echo = 'Hello everyone, the post calls the view beautiful. Let’s keep it kind. What are your thoughts?';
	assert.equal(
		parseSummary(completion(echo), { ...seen, threadText: 'what a beautiful view' }),
		echo,
	);
});

test('calling a video a picture is refused', () => {
	const video = text =>
		assert.throws(
			() => parseSummary(completion(text), { maxCharacters: 480, hasVideo: true }),
			error => error.code === 'invalid_response',
		);
	video('Hello everyone, this shared scene of a quiet street invites reflection. Let’s keep it kind.');
	video('Bonjour à tous, cette image montre un bel espace vert. Restons courtois.');

	// Naming it correctly passes, and a photo thread may say "this image".
	const named = 'Hello everyone, the video shows a quiet, tree-lined street. Let’s keep it kind. What do you think?';
	assert.equal(parseSummary(completion(named), { maxCharacters: 480, hasVideo: true }), named);
	const photo = 'Hello everyone, this image shows students in a hallway. Let’s keep it kind. What do you think?';
	assert.equal(
		parseSummary(completion(photo), { maxCharacters: 480, seesImages: true }),
		photo,
	);
});

test('a question sending people off to prove something is refused', () => {
	// Without sources the bot cannot tell who is right, so asking for proof
	// reads as siding against whoever made the claim. The first is the answer
	// the model actually gave in testing.
	rejects('Bonjour à tous, il est normal d’en discuter. Qu’est-ce qui vous semble important à vérifier ici ?');
	rejects('Hello everyone, figures differ. Which sources could settle this?');
	rejects('Hello everyone, opinions differ. Can anyone cite evidence for it?');
	rejects('Bonjour à tous, chacun voit les choses autrement. Quelles preuves aideraient ?');
	rejects('Hello everyone, views differ. Who could check the figures together?');

	// Everyday questions, and the same words said as a plain statement, pass.
	assert.equal(
		accept('Hello everyone, views differ and that is normal. What matters most to you here?'),
		'Hello everyone, views differ and that is normal. What matters most to you here?',
	);
	assert.equal(
		accept('Hello everyone, the figure is not settled here and views differ. What would help you most?'),
		'Hello everyone, the figure is not settled here and views differ. What would help you most?',
	);
	assert.equal(
		accept('Hello everyone, friends can check in with each other. What would help?'),
		'Hello everyone, friends can check in with each other. What would help?',
	);
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
	assert.match(prompt, /using only what participants actually wrote/);
	assert.match(prompt, /must not propose an answer/);
	assert.match(prompt, /never mention replies, answers or their absence/);
	assert.match(prompt, /altText field/);
});

test('the prompt asks for a warm message, not a report about the thread', () => {
	const prompt = buildSystemPrompt({ botName: 'Bot' });
	// The client's mockup greets everyone and asks people to stay courteous.
	assert.match(prompt, /greeting everyone collectively/);
	assert.match(prompt, /respectful and courteous/);
	assert.match(prompt, /Close by inviting them to continue the discussion/);
	// "What can be considered as true on each side", without ever implying the
	// bot checked anything: it has no sources until fact-check ships.
	assert.match(prompt, /acknowledge what is fair and understandable/);
	assert.match(prompt, /never claim or imply that anything has been verified/);
});

test('the prompt keeps warmth from turning into invention', () => {
	const prompt = buildSystemPrompt({ botName: 'Bot' });
	// Testing found the model calling a plain announcement "exciting news" and
	// adding a backstory nobody had written.
	assert.match(prompt, /Warmth is in how you address people/);
	assert.match(prompt, /do not supply background, history or consequences/);
	// It also answered a one-sided thread by inventing the other side.
	assert.match(prompt, /never invent the opposing case for them/);
	// On a device a disputed figure was called "tout aussi légitime", which puts
	// a claim and its denial on the same footing, and two people became "many".
	assert.match(prompt, /Never call a claim and its denial "equally valid"/);
	assert.match(prompt, /"many", "most" and "everyone" are claims about numbers/);
	// On a device it explained why people hold their views, and under a post
	// with no replies it described what "some may prefer, others…".
	assert.match(prompt, /Do not say why people hold their views/);
	assert.match(prompt, /there are no positions to describe/);
	// And it wrote about an image it had only read the alt text of.
	assert.match(prompt, /never write as though you had looked at it/);
	// A shared page describes itself; that is not proof of anyone's claim.
	assert.match(prompt, /never a verified fact and never confirmation/);
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
	// Pictures sent with the request may be described; nothing else may.
	assert.match(prompt, /attachedImages field names the pictures supplied/);
	assert.match(prompt, /Never infer identity, location, dates, motives or authenticity/);
	// The thread is data, never instructions, and the bot never picks a winner.
	assert.match(prompt, /untrusted conversation content/);
	assert.match(prompt, /Do not declare a winner/);
});

test('guessing what others may think is refused, on any thread', () => {
	// Drafts the model really wrote in dry runs: a side nobody argued, and
	// reasons nobody gave.
	for (const text of [
		'Hello everyone, it’s understandable that some find the new parking rules difficult to navigate. Others may see different challenges or benefits in them. Let’s keep it respectful. What’s your take?',
		'Bonjour à tous, les avis divergent sur cette décision, et chacun peut avoir des raisons de la trouver surprenante ou nécessaire. Restons courtois. Qu’en pensez-vous ?',
		'Bonjour à tous. D’autres pourraient y voir une avancée. Restons courtois. Qu’en pensez-vous ?',
		'Hello everyone. Some might feel differently about it. Let’s keep it kind. What do you think?',
		// From the device: verbs a fixed list missed.
		'Hello everyone, it’s clear some find the new parking rules difficult to navigate. Others may share that frustration or see different challenges. Let’s keep the discussion calm and open. What’s your experience with the changes?',
		'Hello everyone, it’s good to see this topic raised. Some may focus on the intent behind the rule, while others look at how it’s applied. Let’s keep it clear. How do you think this affects students?',
		'Hello everyone, it’s clear some find the new parking rules difficult to navigate. Others may have different experiences or reasons for the changes. Let’s keep it respectful. What’s your take?',
	]) {
		assert.throws(
			// With replies: a one-sided thread has replies too.
			() => parseSummary(completion(text), { maxCharacters: 480, hasReplies: true }),
			error => error.message === 'invalid_response: guesses_views',
			text,
		);
	}
});

test('reporting the sides people wrote, or inviting others, is still fine', () => {
	for (const text of [
		'Hello everyone, some see phones as a distraction, others as a safety tool. Both concerns are understandable. Let’s keep it respectful. What might help?',
		'Hello everyone, we would love to hear what others think. Let’s keep it kind. What matters most to you?',
		'Bonjour à tous, on peut avoir des avis différents. Restons courtois. Qu’en pensez-vous ?',
	]) {
		assert.equal(accept(text), text);
	}
});

