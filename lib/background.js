import { waitUntil } from '@vercel/functions';

/**
 * Keeps the function alive for work that goes on after the response is sent.
 *
 * On Vercel a function may be frozen as soon as it has answered, so a promise
 * left running would be cut off. `waitUntil` tells the platform to wait for it,
 * up to the function's `maxDuration`. Tests swap it for one that records the
 * promise, so they can wait for the background work themselves.
 */
let keepAliveImpl = promise => waitUntil(promise);

export const keepAlive = promise => keepAliveImpl(promise);

/** Test helper: replace how background work is kept alive. */
export const setKeepAlive = impl => {
	keepAliveImpl = impl;
};
