/** The app's own origins are the only callers, so no CORS headers are sent. */
export const readJsonBody = req => {
	const body = req.body;
	if (!body) return {};
	if (typeof body === 'string') {
		try {
			return JSON.parse(body);
		} catch {
			return null;
		}
	}
	return typeof body === 'object' ? body : null;
};

/** The user's token, taken from the Authorization header, never from the body. */
export const readBearerToken = req => {
	const header = req.headers?.authorization || req.headers?.Authorization || '';
	const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
	return match ? match[1].trim() : '';
};

export const sendJson = (res, status, payload) =>
	res.status(status).json(payload);

/**
 * Error codes reach the app; the message and stack never do. The app has a
 * translation for each code, and anything unrecognised becomes a generic one.
 */
export const sendError = (res, error) => {
	const status = Number.isInteger(error?.status) ? error.status : 500;
	const code = typeof error?.code === 'string' ? error.code : 'server';
	// Vercel keeps function logs private; they are where a real cause belongs.
	if (status >= 500) console.error(`[calm] ${code}`, error?.message || error);
	return sendJson(res, status, { error: code });
};
