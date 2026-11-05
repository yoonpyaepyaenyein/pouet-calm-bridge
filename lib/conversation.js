import { CONFIG } from './config.js';
import { cleanText } from './cleanText.js';

/**
 * Only public and unlisted posts leave the instance.
 *
 * Ported from conversationSummary.privacy.ts in the mobile app. An unknown or
 * missing visibility counts as restricted, so a new Mastodon visibility can
 * never leak a private thread to a model provider by default.
 */
export const isShareable = post =>
	post?.visibility === 'public' || post?.visibility === 'unlisted';

export class CalmError extends Error {
	constructor(code, status = 400, reason = null) {
		super(reason ? `${code}: ${reason}` : code);
		this.code = code;
		this.status = status;
	}
}

const plain = post => ({
	author: cleanText(post.account?.display_name || post.account?.username || '')
		.replace(/\s+/g, ' ')
		.trim(),
	text: cleanText(post.content, { preserveParagraphs: true }),
	missingContext: [
		...new Set((post.media_attachments || []).map(media => media.type)),
	],
	altText: (post.media_attachments || [])
		.map(media => cleanText(media.description || '').slice(0, 300))
		.filter(Boolean)
		.slice(0, 4),
});

const hasContent = post => post.text || post.missingContext.length;

/**
 * The thread as JSON for the model, with restricted replies counted but never
 * quoted, and the whole payload kept inside a character budget.
 */
export const formatConversation = (root, replies) => {
	if (!isShareable(root)) throw new CalmError('restricted_conversation', 403);
	const original = { ...plain(root), language: root.language || null };
	if (!hasContent(original)) throw new CalmError('empty_conversation', 422);

	const eligible = [];
	let restricted = 0;
	for (const post of replies) {
		if (!isShareable(post)) {
			restricted += 1;
			continue;
		}
		const entry = plain(post);
		if (hasContent(entry)) eligible.push(entry);
	}

	const conversation = {
		original,
		replies: [],
		omittedReplies: restricted + eligible.length,
	};
	const size = () => JSON.stringify(conversation).length;
	if (size() > CONFIG.maxConversationCharacters) {
		throw new CalmError('conversation_too_long', 422);
	}
	for (const reply of eligible) {
		if (conversation.replies.length >= CONFIG.maxReplies) break;
		conversation.replies.push(reply);
		conversation.omittedReplies -= 1;
		if (size() > CONFIG.maxConversationCharacters) {
			conversation.replies.pop();
			conversation.omittedReplies += 1;
			break;
		}
	}
	return {
		content: JSON.stringify(conversation),
		omittedReplies: conversation.omittedReplies,
	};
};

/**
 * The language tag on the bot's post. The model chooses the language it writes
 * in from the text, so this is only the best label available: the most used tag
 * in the thread, with ties going to the earliest post.
 */
export const conversationLanguage = posts => {
	const counts = new Map();
	for (const post of posts) {
		const tag = String(post?.language || '').toLowerCase().split('-')[0];
		if (tag) counts.set(tag, (counts.get(tag) || 0) + 1);
	}
	let language;
	for (const [tag, count] of counts) {
		if (!language || count > counts.get(language)) language = tag;
	}
	return language;
};

/** The bot never posts more publicly than any post it is answering. */
export const replyVisibility = (...posts) =>
	posts.some(post => post.visibility === 'unlisted') ? 'unlisted' : 'public';

/**
 * Whether the bot may answer in this thread again.
 *
 * It may not when the newest post in the whole conversation is its own: nobody
 * has said anything since, so a second calming message would only answer
 * itself. Once a participant replies, the conversation has moved on and the
 * lotus works again.
 *
 * The question is about the thread, not about the post that was pressed. The
 * lotus on the original post and on each of its replies are all pressable, and
 * they all lead to the same conversation, so judging only the pressed post's
 * own branch would let the same discussion be calmed once per post in it.
 */
export const canCalmAgain = ({ posts = [], botAccountId }) => {
	if (!botAccountId) return true;
	let newest = null;
	for (const post of posts) {
		if (!post?.id) continue;
		if (!newest) {
			newest = post;
			continue;
		}
		const left = Date.parse(post.created_at) || 0;
		const right = Date.parse(newest.created_at) || 0;
		if (left > right) newest = post;
		else if (left === right && String(post.id) > String(newest.id)) newest = post;
	}
	if (!newest) return true;
	return String(newest.account?.id || '') !== String(botAccountId);
};
