import { CONFIG, getInstance } from '../lib/config.js';
import { CalmError } from '../lib/conversation.js';
import { readBearerToken, readJsonBody, sendError, sendJson } from '../lib/http.js';
import { verifySession } from '../lib/session.js';
import { readThreadStates } from '../lib/store.js';

/**
 * POST /api/states  { instance, statusIds: [] }  Authorization: Bearer <token>
 *
 * The lotus state for everything on one screen, in a single round trip. The app
 * does not know which post starts a thread, so it sends every id it is showing
 * and gets back only the ones the bridge knows about.
 *
 * This is what makes the state shared: the person who pressed the lotus and
 * everyone else reading the thread see the same spinner and the same red lotus,
 * on any device, because it is stored here and not on a phone.
 */
export default async function handler(req, res) {
	if (req.method !== 'POST') {
		return sendJson(res, 405, { error: 'method_not_allowed' });
	}
	try {
		const body = readJsonBody(req);
		if (!body) throw new CalmError('invalid_request', 400);
		const token = readBearerToken(req);
		if (!token) throw new CalmError('unauthorized', 401);

		const instance = getInstance(body.instance);
		if (!instance) throw new CalmError('unknown_instance', 400);

		// Only a real account on this server may read states, so the endpoint
		// cannot be used to probe which conversations were calmed.
		await verifySession(instance, token);

		const ids = Array.isArray(body.statusIds) ? body.statusIds : [];
		const statusIds = [
			...new Set(
				ids
					.map(id => String(id || '').trim())
					.filter(id => /^[A-Za-z0-9_-]{1,64}$/.test(id)),
			),
		].slice(0, CONFIG.maxStateIds);
		if (!statusIds.length) return sendJson(res, 200, { states: {} });

		return sendJson(res, 200, {
			states: await readThreadStates({ instanceId: instance.id, ids: statusIds }),
		});
	} catch (error) {
		return sendError(res, error);
	}
}
