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

/**
 * What a shared link says about itself.
 *
 * Mastodon fetches a preview for every link it sees and hands it over as the
 * post's card, so this costs no request of our own. Without it a post that is
 * mostly a URL reaches the model as an unreadable address and the bot cannot
 * tell what is being discussed. Only the words are passed on: no URL, no image,
 * no author or provider, so nothing here can become a link in the bot's reply.
 */
const linkPreview = card => {
	if (!card) return undefined;
	const title = cleanText(card.title || '').slice(0, 150);
	const description = cleanText(card.description || '').slice(0, 300);
	if (!title && !description) return undefined;
	return {
		...(title ? { title } : {}),
		...(description ? { description } : {}),
	};
};

/**
 * A picture's address the model provider can fetch itself, or null.
 *
 * Mistral downloads the image from this address, so the bridge never fetches it
 * and never sends a credential. The smaller preview is preferred: it is enough
 * to see what a photo shows and keeps the request inside the time budget.
 */
const imageAddress = media => {
	// A video's own url is the video file; only its preview is a picture.
	const url = String(
		media.type === 'image' ? media.preview_url || media.url || '' : media.preview_url || '',
	);
	return /^https:\/\/\S+$/.test(url) && url.length <= 2048 ? url : null;
};

/**
 * What each kind of attachment can show the model. A video cannot be sent, but
 * Mastodon renders a still frame of it, which is enough to know what it is of:
 * without it, a post that is only a video left the model saying "this looks
 * like an interesting topic" about nothing in particular.
 */
const PICTURE_KIND = { image: 'picture', video: 'video still', gifv: 'video still' };

/**
 * The pictures shown to the model: those of the original post, then those of
 * the post that was pressed, up to a fixed number. Pictures elsewhere in the
 * thread stay unseen, as they were in the app's summary this replaces.
 *
 * Unlike that summary, a picture is sent even when it has alt text: a post that
 * is only a captioned photo otherwise leaves the model nothing it can honestly
 * say, and every answer it wrote about the photo was refused.
 */
const selectImages = (root, subject) => {
	const images = [];
	const labels = new Map();
	const posts = subject && String(subject.id) !== String(root.id) ? [root, subject] : [root];
	for (const post of posts) {
		for (const media of post.media_attachments || []) {
			if (images.length >= CONFIG.maxImages) break;
			const kind = PICTURE_KIND[media.type];
			if (!kind) continue;
			const url = imageAddress(media);
			if (!url) continue;
			const label = `image${images.length + 1}`;
			images.push({
				label,
				url,
				kind,
				owner: post === root ? 'the original post' : 'the pressed reply',
			});
			labels.set(String(post.id), [...(labels.get(String(post.id)) || []), label]);
		}
	}
	return { images, labels };
};

const plain = (post, attachedImages) => {
	const link = linkPreview(post.card);
	return {
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
		...(link ? { link } : {}),
		...(attachedImages?.length ? { attachedImages } : {}),
	};
};

// A post that is only a shared link still has something to discuss.
const hasContent = post => post.text || post.missingContext.length || post.link;

/**
 * The thread as JSON for the model, with restricted replies counted but never
 * quoted, and the whole payload kept inside a character budget.
 */
export const formatConversation = (
	root,
	replies,
	{ subject, readerLanguage } = {},
) => {
	if (!isShareable(root)) throw new CalmError('restricted_conversation', 403);
	const { images, labels } = selectImages(root, subject);
	const original = {
		...plain(root, labels.get(String(root.id))),
		language: root.language || null,
	};
	if (!hasContent(original)) throw new CalmError('empty_conversation', 422);

	const eligible = [];
	let restricted = 0;
	for (const post of replies) {
		if (!isShareable(post)) {
			restricted += 1;
			continue;
		}
		const entry = plain(post, labels.get(String(post.id)));
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
	// A thread of pictures or videos with no words has no language to answer in.
	// The tag Mastodon stored is the poster's app default, not something anyone
	// wrote, so the person who pressed the lotus decides instead.
	const textless =
		!original.text && !conversation.replies.some(reply => reply.text);
	if (textless && readerLanguage) conversation.readerLanguage = readerLanguage;
	return {
		content: JSON.stringify(conversation),
		omittedReplies: conversation.omittedReplies,
		images,
		textless,
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
