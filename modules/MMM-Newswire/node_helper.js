var NodeHelper = require("node_helper");
var fs = require("fs/promises");
var path = require("path");
var os = require("os");
var net = require("node:net");

/* Fetches and parses the ticker feeds for MMM-Newswire.
 *
 * Everything happens here so the browser only ever receives a list of
 * headlines: the mirror is a Celeron N3350 compositing a rotated page, and it
 * has no business parsing a quarter of a megabyte of XML in the render process.
 *
 * Three things keep the data bill down, which was the point of writing this
 * rather than configuring the stock newsfeed module:
 *
 *   - Conditional requests. The stock module sends "Cache-Control: no-cache"
 *     and no validator, so every poll downloads the whole body even when
 *     nothing changed. This stores the ETag and Last-Modified per feed and
 *     sends them back, so an unchanged feed costs a 304 with no body.
 *   - A real interval. Hours, not the stock five minutes.
 *   - Per-feed item caps, applied before anything crosses the socket.
 *
 * gzip is NOT one of them - Node's fetch negotiates that on its own, and the
 * stock module already got it. Measured on these feeds it is the difference
 * between 85KB and 10KB, which is why the raw sizes are not what to budget by.
 *
 * No npm dependencies, deliberately: custom modules reach the mirror by cp
 * from the repo, never npm install, so anything requiring a package would fail
 * there and work here. Hence the hand-rolled feed parser below.
 */

var CACHE_DIR = path.join(os.homedir(), ".cache", "mmm-newswire");
var STATE_FILE = path.join(CACHE_DIR, "state.json");
var UA = "MMM-Newswire/1.0 (MagicMirror smart mirror)";

/* How long to let one address family's connection attempt run before falling
 * back to the other. Node's default is 250ms, which is too short here.
 *
 * This LAN publishes AAAA records but has no working IPv6 route, so every
 * dual-stack host fails over to IPv4 - and Hacker News is served from its own
 * machines in the US, about 1.3s away from Perth. The IPv4 attempt was being
 * abandoned at 250ms and the whole fetch reported ETIMEDOUT, while curl pulled
 * the same URL down in 1.2s. Every other feed here sits on a CDN with an
 * Australian edge and answers well inside 250ms, which is why Hacker News was
 * the only one that ever failed.
 *
 * Process-global, so it applies to other modules' requests too. That is
 * acceptable: it only comes into play once an address family has already
 * failed, and there waiting three seconds beats giving up in a quarter of one. */
var CONNECT_ATTEMPT_TIMEOUT_MS = 3000;

var NAMED_ENTITIES = {
	amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
	hellip: "…", mdash: "—", ndash: "–",
	lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
	laquo: "«", raquo: "»", deg: "°", pound: "£",
	euro: "€", trade: "™", copy: "©", reg: "®",
};

/**
 * Decode XML/HTML entities in one pass.
 *
 * One pass matters: decoding the ampersand entity first and then the named
 * ones turns a legal title containing an escaped entity into mojibake, and a
 * doubly-escaped less-than would come back out as a broken tag.
 */
function decodeEntities(s) {
	return s.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z][a-zA-Z0-9]*));/g,
		function (whole, hex, dec, name) {
			var code;
			if (hex) code = parseInt(hex, 16);
			else if (dec) code = parseInt(dec, 10);
			if (code !== undefined) {
				// Out-of-range values and lone surrogates would throw.
				if (!isFinite(code) || code < 1 || code > 0x10ffff) return whole;
				try { return String.fromCodePoint(code); } catch (e) { return whole; }
			}
			return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)
				? NAMED_ENTITIES[name] : whole;
		});
}

/** Feed text reduced to one line of plain text fit for a ticker. */
function clean(s) {
	if (!s) return "";
	return decodeEntities(
		String(s)
			.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
			// Titles carry markup more often than you would hope - emphasis
			// tags, and in one case an entire anchor.
			.replace(/<[^>]*>/g, " ")
	).replace(/\s+/g, " ").trim();
}

/**
 * Text of the first present child tag, by preference order.
 *
 * Namespaced names are passed in literally ("dc:date"), and the pattern allows
 * attributes on the opening tag because Atom titles carry a type attribute.
 */
function tagText(xml, names) {
	for (var i = 0; i < names.length; i++) {
		var name = names[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		var m = xml.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + name + ">", "i"));
		if (m) {
			var text = clean(m[1]);
			if (text) return text;
		}
	}
	return "";
}

/** The item's own link: RSS puts it in the element, Atom in an href. */
function itemLink(xml) {
	var rss = xml.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i);
	if (rss && clean(rss[1])) return clean(rss[1]);
	// Prefer rel="alternate"; a bare href is the common Atom case, and a
	// rel="replies" or "enclosure" link must not win.
	var alt = xml.match(/<link[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["']/i)
		|| xml.match(/<link[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']alternate["']/i)
		|| xml.match(/<link(?![^>]*\brel=)[^>]*\bhref=["']([^"']+)["']/i);
	return alt ? decodeEntities(alt[1]).trim() : "";
}

/** Each item (RSS/RDF) or entry (Atom) body, in document order. */
function itemBlocks(xml) {
	var out = [];
	var re = /<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi;
	var m;
	while ((m = re.exec(xml)) !== null) out.push(m[2]);
	return out;
}

/** Milliseconds, or null when the feed gave no usable date. */
function itemTime(xml) {
	var raw = tagText(xml, ["pubDate", "published", "updated", "dc:date", "date"]);
	if (!raw) return null;
	var t = Date.parse(raw);
	return isFinite(t) ? t : null;
}

/**
 * Parse one feed body into ticker items, newest first, capped.
 *
 * Returns an empty list rather than throwing on junk; the caller treats that
 * as a failed fetch and keeps the previous headlines, which is the behaviour
 * that matters on a mirror nobody is watching.
 */
function parseFeed(body, source, maxItems) {
	var items = [];
	itemBlocks(body).forEach(function (block) {
		var title = tagText(block, ["title"]);
		if (!title) return;
		// Guards against a feed that pads with empty placeholder entries.
		if (title.length < 3) return;
		items.push({
			source: source,
			title: title,
			ts: itemTime(block),
			link: itemLink(block),
		});
	});

	// Only trust a date sort when every item has one. Mixed, it would shuffle
	// the dateless items to the end instead of leaving them in the order the
	// publisher chose, which is already newest-first.
	if (items.length && items.every(function (i) { return i.ts !== null; })) {
		items.sort(function (a, b) { return b.ts - a.ts; });
	}

	// Drop headlines repeated within a feed - ABC reruns a story under a new
	// guid, which would otherwise show twice in a row after the interleave.
	var seen = Object.create(null);
	items = items.filter(function (i) {
		var key = i.title.toLowerCase();
		if (seen[key]) return false;
		seen[key] = true;
		return true;
	});

	return items.slice(0, maxItems);
}

/**
 * Pull the BLUF sentences out of an S2 Underground report page.
 *
 * Their house format opens the report with the bottom line between a pair of
 * double slashes:
 *
 *   //BLUF: AMERICAN MIDTERM ELECTIONS RESULT IN MAJOR VICTORIES FOR
 *   DEMOCRATS. CYBERATTACKS CONTINUE AROUND EUROPE, GROWING IN SCALE AND
 *   IMPACT.//
 *
 * which splits into two or three sentences of 50-70 characters - already the
 * right length for a ticker. The bound on the match keeps a page that happens
 * to contain "//" somewhere from swallowing the whole document.
 *
 * Returns [] rather than throwing if the page is not in that shape; the
 * caller treats that as a failed fetch and keeps the previous lines.
 */
function extractBluf(html) {
	var m = html.match(/\/\/\s*BLUF\s*:([\s\S]{0,4000}?)\/\//i);
	if (!m) return [];

	var text = clean(m[1])
		// Place names in the BLUF are wrapped in links, and stripping the tags
		// leaves a space before the punctuation that followed them.
		.replace(/\s+([,.;:])/g, "$1")
		.trim();
	if (!text) return [];

	return text.split(/(?<=[.!?])\s+/)
		.map(function (s) { return s.trim(); })
		// Drop fragments left by an abbreviation mid-sentence, and refuse a
		// run-on that would only be ellipsised on the bar anyway.
		.filter(function (s) { return s.length >= 12 && s.length <= 300; });
}

module.exports = NodeHelper.create({
	start: function () {
		this.config = null;
		this.timers = {};
		/* Per feed: etag, lastModified, items, fetchedAt, failures.
		 *
		 * Persisted, because the updater restarts MagicMirror at 03:00 every
		 * night. In memory alone, every restart would throw away the validators
		 * (so the first poll of the day refetches every feed in full) and the
		 * headlines (so the ticker would sit empty until the fetches land). */
		this.state = Object.create(null);

		// Guarded: added in Node 20.6, and the mirror tracks upstream.
		if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === "function") {
			net.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_TIMEOUT_MS);
		}
		console.log("[MMM-Newswire] Node helper started");
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "NEWSWIRE_CONFIG") this.configure(payload);
	},

	/** Accept the config once, then start the per-feed schedules. */
	configure: async function (config) {
		if (this.config) {
			// A browser reload re-sends the config. Answer from cache rather
			// than tearing down every timer and refetching the lot.
			this.broadcast();
			return;
		}
		this.config = config;

		await this.loadState();
		// Something to show immediately, before any network happens.
		this.broadcast();

		var self = this;
		(config.feeds || []).forEach(function (feed, i) {
			// Staggered, so every feed does not leave at once on a restart.
			self.timers[feed.url] = setTimeout(function () {
				self.runFeed(feed);
			}, i * (config.staggerMs || 4000));
		});
	},

	loadState: async function () {
		try {
			var parsed = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
			if (parsed && typeof parsed === "object") {
				Object.keys(parsed).forEach(function (url) {
					var s = parsed[url];
					if (s && Array.isArray(s.items)) this.state[url] = s;
				}, this);
			}
			console.log("[MMM-Newswire] restored " + Object.keys(this.state).length +
				" feeds from cache");
		} catch (e) {
			// Absent on first run, or truncated by a power cut mid-write. Either
			// way start clean; the next fetch rebuilds it.
		}
	},

	saveState: async function () {
		try {
			await fs.mkdir(CACHE_DIR, { recursive: true });
			// Write then rename, so a power cut cannot leave a half-written file
			// that the next start would discard along with every headline.
			var tmp = STATE_FILE + ".tmp";
			await fs.writeFile(tmp, JSON.stringify(this.state));
			await fs.rename(tmp, STATE_FILE);
		} catch (e) {
			console.error("[MMM-Newswire] could not cache state: " + e.message);
		}
	},

	/** Fetch one feed, then reschedule itself. */
	runFeed: async function (feed) {
		var interval = feed.reloadInterval || this.config.reloadInterval;
		var delay;
		try {
			var outcome = await this.fetchFeed(feed);
			this.state[feed.url].failures = 0;
			console.log("[MMM-Newswire] " + feed.title + ": " + outcome);
			delay = interval;
		} catch (e) {
			var s = this.state[feed.url] || (this.state[feed.url] = { items: [] });
			s.failures = (s.failures || 0) + 1;
			console.error("[MMM-Newswire] " + feed.title + " failed (" + s.failures +
				"): " + e.message);
			// Back off, but never past the normal interval - a feed that is down
			// for a week should still be retried as often as a healthy one, not
			// exponentially forgotten.
			delay = Math.min((this.config.retryMs || 600000) * s.failures, interval);
		}

		// Recorded whether it worked or not, so the browser can tell "nothing
		// has been tried yet" from "everything tried and failed".
		(this.state[feed.url] || (this.state[feed.url] = { items: [] })).attemptedAt = Date.now();

		this.broadcast();
		await this.saveState();

		// A little jitter so the feeds drift apart instead of converging on one
		// clock edge and hitting every server together.
		var jitter = Math.round(Math.random() * (this.config.jitterMs || 60000));
		var self = this;
		this.timers[feed.url] = setTimeout(function () { self.runFeed(feed); }, delay + jitter);
	},

	/**
	 * One conditional GET.
	 *
	 * `store` both supplies the validators and receives the new ones, so the
	 * same routine serves a feed and an individual article page. Pass
	 * hasContent=false to suppress the validators: a 304 is only useful when
	 * there is something cached to fall back on.
	 */
	conditionalGet: async function (url, store, hasContent) {
		var headers = {
			"User-Agent": UA,
			"Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*",
			/* Node's fetch sends "Cache-Control: no-cache" and "Pragma: no-cache"
			 * of its own accord, and Express's freshness check treats a request
			 * saying no-cache as a refusal to be given a 304 - so a conditional
			 * request gets the whole body back anyway. Overriding both is what
			 * actually buys the 304s. max-age=0 still means "revalidate", which
			 * is exactly what is wanted.
			 *
			 * Measured over the configured feeds: without this, only the CDN-
			 * hosted ones revalidate; with it, most answer 304 with no body. It
			 * is also why the stock newsfeed module never gets one - it sets
			 * no-cache, no-store, must-revalidate explicitly. */
			"Cache-Control": "max-age=0",
			"Pragma": "",
		};
		if (hasContent) {
			if (store.etag) headers["If-None-Match"] = store.etag;
			if (store.lastModified) headers["If-Modified-Since"] = store.lastModified;
		}

		var res = await fetch(url, {
			headers: headers,
			redirect: "follow",
			signal: AbortSignal.timeout(this.config.timeoutMs || 20000),
		});

		if (res.status === 304) return { notModified: true, body: null };
		if (!res.ok) throw new Error("HTTP " + res.status);
		return { notModified: false, body: await res.text(), res: res };
	},

	fetchFeed: async function (feed) {
		if (feed.type === "s2bluf") return this.fetchS2Bluf(feed);

		var st = this.state[feed.url] || (this.state[feed.url] = { items: [] });
		var got = await this.conditionalGet(feed.url, st, !!(st.items && st.items.length));

		if (got.notModified) {
			st.fetchedAt = Date.now();
			return "304 not modified, " + st.items.length + " headlines held";
		}

		var items = parseFeed(got.body, feed.title, feed.maxItems || this.config.maxItemsPerFeed);
		/* Nothing parsed means a redirect to an HTML page, a block page, or a
		 * feed that changed shape. Treat it as a failure so the previous
		 * headlines stay up, and do NOT store the validator - otherwise the
		 * next poll gets a 304 for the junk and the feed is stuck on it. */
		if (!items.length) throw new Error("no items parsed from " + got.body.length + " bytes");

		st.etag = got.res.headers.get("etag") || null;
		st.lastModified = got.res.headers.get("last-modified") || null;
		st.items = items;
		st.fetchedAt = Date.now();
		return items.length + " headlines, " + got.body.length + " bytes decoded" +
			(st.etag || st.lastModified ? " (revalidatable)" : " (no validator offered)");
	},

	/**
	 * S2 Underground's The Wire, which needs following one link further.
	 *
	 * Its feed is an index of videos: every title is just a date ("The Wire -
	 * November 4, 2026") and the description is boilerplate, so putting the
	 * feed itself on a ticker would show a date stamp and nothing else. The
	 * actual brief lives on each report's own page, opening with S2's house
	 * BLUF block - two or three sentences that are already exactly the length
	 * and tone of a ticker headline.
	 *
	 * So: read the index, then fetch the few most recent report pages and lift
	 * the BLUF out of each. Both steps revalidate, and the report pages are
	 * cached by URL, so a day with no new report costs two 304s and nothing
	 * else. Measured: index 1.4KB on the wire, a report page 16.6KB, both 304
	 * thereafter.
	 *
	 * This reads someone else's HTML, so it is the most breakable thing here.
	 * Every failure path keeps the previous headlines rather than falling back
	 * to the bare dated titles, which would be worse than showing nothing.
	 */
	fetchS2Bluf: async function (feed) {
		var st = this.state[feed.url] || (this.state[feed.url] = { items: [] });
		if (!st.docs) st.docs = {};

		var hasContent = !!(st.items && st.items.length);
		var index = await this.conditionalGet(feed.url, st, hasContent);
		if (index.notModified) {
			st.fetchedAt = Date.now();
			return "304 not modified, " + st.items.length + " wire lines held";
		}

		var reports = parseFeed(index.body, feed.title, feed.maxReports || 3)
			.filter(function (r) { return r.link; });
		if (!reports.length) throw new Error("no reports in the index (" + index.body.length + " bytes)");

		var items = [];
		var fetched = 0, reused = 0;
		for (var i = 0; i < reports.length; i++) {
			var report = reports[i];
			var doc = st.docs[report.link] || (st.docs[report.link] = {});
			try {
				var page = await this.conditionalGet(report.link, doc,
					!!(doc.lines && doc.lines.length));
				if (page.notModified) {
					reused++;
				} else {
					var lines = extractBluf(page.body);
					if (!lines.length) throw new Error("no BLUF block found");
					doc.lines = lines;
					doc.etag = page.res.headers.get("etag") || null;
					doc.lastModified = page.res.headers.get("last-modified") || null;
					fetched++;
				}
			} catch (e) {
				// One unreachable or reshaped report must not cost the others.
				console.error("[MMM-Newswire] " + feed.title + " report " +
					report.link + ": " + e.message);
			}
			(doc.lines || []).forEach(function (line) {
				items.push({ source: feed.title, title: line, ts: report.ts, link: report.link });
			});
		}

		if (!items.length) throw new Error("no BLUF text extracted from " + reports.length + " reports");

		// Drop cached pages for reports that have dropped off the index, so
		// this cannot grow for the life of the machine.
		var live = Object.create(null);
		reports.forEach(function (r) { live[r.link] = true; });
		Object.keys(st.docs).forEach(function (url) { if (!live[url]) delete st.docs[url]; });

		st.etag = index.res.headers.get("etag") || null;
		st.lastModified = index.res.headers.get("last-modified") || null;
		st.items = items.slice(0, feed.maxItems || this.config.maxItemsPerFeed);
		st.fetchedAt = Date.now();
		return st.items.length + " wire lines from " + reports.length + " reports (" +
			fetched + " fetched, " + reused + " revalidated)";
	},

	/**
	 * Interleave the feeds so sources alternate.
	 *
	 * Concatenating would give six ABC headlines in a row and then six from
	 * Hacker News, which on a ticker reads as the mirror being stuck.
	 */
	/**
	 * Interleave the feeds into the rotation, by weight.
	 *
	 * Concatenating would give six ABC headlines in a row and then six from
	 * Hacker News, which on a ticker reads as the mirror being stuck. Plain
	 * round-robin fixes that but gives every source equal airtime, and the
	 * wire is meant to dominate.
	 *
	 * So: smooth weighted round-robin, the scheduler nginx uses. Each pass
	 * every live feed accrues its weight, the feed most "owed" a turn takes
	 * the slot and pays back the total. A feed of weight 4 among seven of
	 * weight 1 therefore gets four slots in eleven, spread through the
	 * rotation rather than clumped into a block of four.
	 *
	 * freshWeight/freshHours is the "especially if new" part: while a feed's
	 * newest item is inside freshHours, the whole feed is promoted to the
	 * higher weight, so the day a new wire report lands it takes over the bar
	 * and then settles back.
	 */
	merged: function () {
		var self = this;
		var now = Date.now();

		var queues = (this.config.feeds || []).map(function (f) {
			var st = self.state[f.url];
			var items = (st && st.items) ? st.items : [];

			/* Nothing stale may keep cycling.
			 *
			 * Two separate ways a headline goes stale, and both have to be
			 * caught. The item can simply be old - the RBA publishes a rate
			 * decision every six weeks, and without this its last one would
			 * roll round the bar for a month and a half as though it were
			 * news. And the feed itself can go quiet: if the mirror loses its
			 * network, the cached headlines are still here and would otherwise
			 * cycle indefinitely behind a small "offline" marker.
			 *
			 * fetchedAt is set on a 304 as well as a 200, because a
			 * revalidation is a successful refresh - it is proof the feed is
			 * reachable and unchanged, not evidence of staleness. */
			var dropMs = (Number(f.dropAfterHours) || Number(self.config.dropAfterHours) || 12) * 3600000;
			if (st && st.fetchedAt && (now - st.fetchedAt) > dropMs) {
				items = [];
			} else {
				var ageMs = (Number(f.maxItemAgeHours) || Number(self.config.maxItemAgeHours) || 48) * 3600000;
				items = items.filter(function (i) {
					// A dateless item cannot be aged on its own, so it rides on
					// the feed's freshness check above instead.
					return !i.ts || (now - i.ts) <= ageMs;
				});
			}

			var weight = Math.max(1, Number(f.weight) || 1);
			if (f.freshWeight && f.freshHours && items.length && items[0].ts &&
				(now - items[0].ts) <= f.freshHours * 3600000) {
				weight = Math.max(weight, Number(f.freshWeight) || 0);
			}
			return { items: items, weight: weight, credit: 0, pos: 0 };
		}).filter(function (q) { return q.items.length > 0; });

		var out = [];
		var cap = this.config.maxItems || 60;
		/* Deduped across feeds as well as within one. ABC News and ABC Business
		 * carry the same lead story, and the interleave can put them two apart,
		 * which reads as the mirror having frozen and repeated itself. First
		 * occurrence wins, so config order decides which source is credited. */
		var seen = Object.create(null);

		while (out.length < cap) {
			var live = queues.filter(function (q) { return q.pos < q.items.length; });
			if (!live.length) break;

			var total = 0, best = null;
			for (var i = 0; i < live.length; i++) {
				live[i].credit += live[i].weight;
				total += live[i].weight;
				if (!best || live[i].credit > best.credit) best = live[i];
			}
			best.credit -= total;

			var item = best.items[best.pos++];
			var key = item.title.toLowerCase();
			if (seen[key]) continue;
			seen[key] = true;
			out.push(item);
		}
		return out;
	},

	broadcast: function () {
		if (!this.config) return;
		var feeds = this.config.feeds || [];
		var items = this.merged();

		/* Which sources are actually on the bar right now. merged() has
		 * already dropped feeds that are too stale to show, so this is the
		 * set whose freshness the browser should be judging. */
		var showing = Object.create(null);
		items.forEach(function (i) { showing[i.source] = true; });

		var ok = 0, newest = 0, oldest = 0, attempted = 0;
		feeds.forEach(function (f) {
			var st = this.state[f.url];
			if (!st) return;
			if (st.items && st.items.length) ok++;
			if (st.attemptedAt > attempted) attempted = st.attemptedAt;
			if (st.fetchedAt > newest) newest = st.fetchedAt;
			/* Oldest among the feeds still contributing, NOT across all of
			 * them. Reporting only the newest let one healthy feed hold the
			 * staleness clock open while every other source on the bar was
			 * hours or days behind. */
			if (showing[f.title] && st.fetchedAt && (!oldest || st.fetchedAt < oldest)) {
				oldest = st.fetchedAt;
			}
		}, this);

		this.sendSocketNotification("NEWSWIRE_ITEMS", {
			items: items,
			feedsConfigured: feeds.length,
			feedsWithItems: ok,
			lastFetchAt: newest || null,
			// Staleness is judged on this one.
			oldestFetchAt: oldest || null,
			/* Distinct from lastFetchAt, which only moves on success. Without
			 * it a cold boot with no network stayed on "Fetching headlines"
			 * for ever, because nothing had ever succeeded. */
			lastAttemptAt: attempted || null,
		});
	},
});
