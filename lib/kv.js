// The Redis client lives behind one accessor so the handlers can be exercised
// against an in-memory store in tests, and so swapping Upstash for another
// store later touches this file only.

let client = null;

/** Tests (and any future store) provide their own client through this. */
export const setKvClient = next => {
	client = next;
};

export const getKv = async () => {
	if (client) return client;
	// Imported lazily: loading it at module scope would require the connection
	// environment to exist even in tests that never touch the store.
	const { kv } = await import('@vercel/kv');
	client = kv;
	return client;
};
