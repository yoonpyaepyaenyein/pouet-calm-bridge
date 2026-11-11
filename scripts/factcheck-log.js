#!/usr/bin/env node
/**
 * Prints the fact-check results recorded in log mode, newest first, so they can
 * be reviewed before FACTCHECK_MODE is turned on. Reads the same Redis store as
 * the bridge; nothing is changed.
 *
 *   node --env-file=.env.local scripts/factcheck-log.js        # last 20
 *   node --env-file=.env.local scripts/factcheck-log.js 50
 *
 * Needs KV_REST_API_URL and KV_REST_API_TOKEN in the environment (for example
 * from `vercel env pull .env.local`). No key or token is printed.
 */
import { readFactCheckLog } from '../lib/factcheck.js';

const count = Math.max(1, Math.min(200, Number(process.argv[2]) || 20));

const run = async () => {
	if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
		console.error('KV_REST_API_URL and KV_REST_API_TOKEN are not set in this shell.');
		process.exit(1);
	}
	const entries = await readFactCheckLog(count);
	if (!entries.length) {
		console.log('No fact-check results recorded yet.');
		return;
	}
	for (const entry of entries) {
		console.log(`── ${entry.at}  thread ${entry.rootId}  (${entry.mode}, ${entry.ms} ms)`);
		if (entry.error) console.log(`   skipped: ${entry.error}`);
		if (!entry.checkable) {
			console.log('   no checkable claim\n');
			continue;
		}
		console.log(`   claim: ${entry.claim}`);
		console.log(`   query: ${entry.query}`);
		if (!entry.evidence.length) console.log('   no trusted source found');
		console.log(`   reply cited: ${entry.citedUrl || 'none'}`);
		for (const item of entry.evidence) {
			console.log(`   - ${item.site}${item.date ? ` (${item.date})` : ''}: ${item.title}`);
			console.log(`     ${item.snippet}`);
			console.log(`     ${item.url}`);
		}
		console.log('');
	}
};

run().catch(error => {
	console.error(error.message);
	process.exit(1);
});
