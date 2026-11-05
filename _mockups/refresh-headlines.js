/* Regenerates _mockups/headlines.json for newswire-harness.html.
 *
 *   node _mockups/refresh-headlines.js
 *
 * Runs the real MMM-Newswire node_helper against the feeds configured in
 * config/config-guest.js, so the harness always exercises the same parser,
 * the same defaults and the same feed list the mirror actually runs - there
 * is no second copy of any of it to drift.
 *
 * Both of MagicMirror's globals are stubbed rather than reimplemented:
 * node_helper, which only has to hand the object back, and Module.register,
 * which is how the front end's defaults are read. The front end touches the
 * DOM only inside its methods, so requiring it outside a browser is safe.
 */
const path = require("node:path");
const fs = require("node:fs");
const Mod = require("node:module");

const REPO = path.join(__dirname, "..");

const origLoad = Mod._load;
Mod._load = function (request) {
	if (request === "node_helper") return { create: (o) => o };
	return origLoad.apply(this, arguments);
};

let defaults = {};
global.Module = { register: (name, def) => { defaults = def.defaults || {}; } };
require(path.join(REPO, "modules", "MMM-Newswire", "MMM-Newswire.js"));

const mirrorConfig = require(path.join(REPO, "config", "config-guest.js"));
const entry = (mirrorConfig.modules || []).find((m) => m.module === "MMM-Newswire");
if (!entry) {
	console.error("MMM-Newswire is not in config/config-guest.js - nothing to fetch.");
	process.exit(1);
}

// Fetch everything at once; the stagger only exists to be kind to the mirror
// on a restart, and it just makes this script slow.
const config = Object.assign({}, defaults, entry.config, { staggerMs: 0, jitterMs: 0 });

const helper = require(path.join(REPO, "modules", "MMM-Newswire", "node_helper.js"));
let payload = null;
helper.sendSocketNotification = (notification, p) => { if (notification === "NEWSWIRE_ITEMS") payload = p; };
helper.start();

(async () => {
	helper.config = config;
	await helper.loadState();

	for (const feed of config.feeds) {
		try {
			console.log("  " + feed.title.padEnd(14) + " " + await helper.fetchFeed(feed));
		} catch (e) {
			console.log("  " + feed.title.padEnd(14) + " FAILED: " + e.message);
		}
	}
	// Persist, exactly as the mirror does. Without this every local run starts
	// cold, re-downloads every feed in full, and never exercises the 304 path.
	await helper.saveState();
	helper.broadcast();

	if (!payload || !payload.items.length) {
		console.error("No headlines fetched - leaving the existing fixture alone.");
		process.exit(1);
	}

	const out = path.join(__dirname, "headlines.json");
	fs.writeFileSync(out, JSON.stringify(payload, null, 1) + "\n");
	console.log("\nwrote " + payload.items.length + " headlines from " +
		payload.feedsWithItems + "/" + payload.feedsConfigured + " feeds to " + out);
})();
