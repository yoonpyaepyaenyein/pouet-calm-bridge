// Mastodon returns post bodies as HTML. The model should read what a person
// reads, so tags go away and entities come back as characters.
//
// Ported from packages/feature-ai-summary/src/util/cleanText.ts in the mobile
// app, with the `he` entity decoder replaced by a small local table: the app's
// version runs in a bundle where `he` is already a dependency, and the bridge
// should stay dependency free apart from the Redis client.

const NAMED_ENTITIES = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	hellip: '…',
	mdash: '—',
	ndash: '–',
	laquo: '«',
	raquo: '»',
	lsquo: '‘',
	rsquo: '’',
	ldquo: '“',
	rdquo: '”',
	eacute: 'é',
	egrave: 'è',
	ecirc: 'ê',
	agrave: 'à',
	acirc: 'â',
	ccedil: 'ç',
	ugrave: 'ù',
	ucirc: 'û',
	icirc: 'î',
	ocirc: 'ô',
	euml: 'ë',
	iuml: 'ï',
	ouml: 'ö',
	uuml: 'ü',
	auml: 'ä',
	deg: '°',
	euro: '€',
};

const decodeEntities = value =>
	value.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, entity) => {
		if (entity[0] === '#') {
			const codePoint =
				entity[1] === 'x' || entity[1] === 'X'
					? Number.parseInt(entity.slice(2), 16)
					: Number.parseInt(entity.slice(1), 10);
			// Surrogates and out-of-range values would throw or corrupt the text.
			if (
				!Number.isInteger(codePoint) ||
				codePoint <= 0 ||
				codePoint > 0x10ffff ||
				(codePoint >= 0xd800 && codePoint <= 0xdfff)
			) {
				return match;
			}
			return String.fromCodePoint(codePoint);
		}
		const named = NAMED_ENTITIES[entity.toLowerCase()];
		return named === undefined ? match : named;
	});

export const cleanText = (htmlString, { preserveParagraphs } = {}) => {
	if (!htmlString) return '';
	const withNewlines = String(htmlString)
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<p>/gi, preserveParagraphs ? '' : ' ')
		.replace(/<\/p>/gi, preserveParagraphs ? '\n\n' : ' ');
	const withoutTags = withNewlines.replace(/<\/?[^>]+(>|$)/g, '');
	const decoded = decodeEntities(withoutTags);
	return preserveParagraphs
		? decoded.replace(/\n{3,}/g, '\n\n').trim()
		: decoded.trim();
};
