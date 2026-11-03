var NodeHelper = require("node_helper");
var fs = require("fs/promises");
var path = require("path");
var os = require("os");

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

		this.broadcast();
		await this.saveState();

		// A little jitter so the feeds drift apart instead of converging on one
		// clock edge and hitting every server together.
		var jitter = Math.round(Math.random() * (this.config.jitterMs || 60000));
		var self = this;
		this.timers[feed.url] = setTimeout(function () { self.runFeed(feed); }, delay + jitter);
	},

	fetchFeed: async function (feed) {
		var st = this.state[feed.url] || (this.state[feed.url] = { items: [] });
		var headers = {
			"User-Agent": UA,
			"Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
			/* Node's fetch sends "Cache-Control: no-cache" and "Pragma: no-cache"
			 * of its own accord, and Express's freshness check treats a request
			 * saying no-cache as a refusal to be given a 304 - so a conditional
			 * request gets the whole body back anyway. Overriding both is what
			 * actually buys the 304s. max-age=0 still means "revalidate", which
			 * is exactly what is wanted.
			 *
			 * Measured over the configured feeds: without this, only the CDN-
			 * hosted ones revalidate; with it, five of eight answer 304 with no
			 * body. It is also why the stock newsfeed module never gets one -
			 * it sets no-cache, no-store, must-revalidate explicitly. */
			"Cache-Control": "max-age=0",
			"Pragma": "",
		};
		// Only send a validator when there is something cached to validate
		// against: a 304 with no stored items would leave the ticker empty.
		if (st.items && st.items.length) {
			if (st.etag) headers["If-None-Match"] = st.etag;
			if (st.lastModified) headers["If-Modified-Since"] = st.lastModified;
		}

		var res = await fetch(feed.url, {
			headers: headers,
			redirect: "follow",
			signal: AbortSignal.timeout(this.config.timeoutMs || 20000),
		});

		if (res.status === 304) {
			st.fetchedAt = Date.now();
			return "304 not modified, " + st.items.length + " headlines held";
		}
		if (!res.ok) throw new Error("HTTP " + res.status);

		var body = await res.text();
		var items = parseFeed(body, feed.title, feed.maxItems || this.config.maxItemsPerFeed);
		/* Nothing parsed means a redirect to an HTML page, a block page, or a
		 * feed that changed shape. Treat it as a failure so the previous
		 * headlines stay up, and do NOT store the validator - otherwise the
		 * next poll gets a 304 for the junk and the feed is stuck on it. */
		if (!items.length) throw new Error("no items parsed from " + body.length + " bytes");

		st.etag = res.headers.get("etag") || null;
		st.lastModified = res.headers.get("last-modified") || null;
		st.items = items;
		st.fetchedAt = Date.now();
		return items.length + " headlines, " + body.length + " bytes decoded" +
			(st.etag || st.lastModified ? " (revalidatable)" : " (no validator offered)");
	},

	/**
	 * Interleave the feeds so sources alternate.
	 *
	 * Concatenating would give six ABC headlines in a row and then six from
	 * Hacker News, which on a ticker reads as the mirror being stuck.
	 */
	merged: function () {
		var lists = (this.config.feeds || []).map(function (f) {
			var st = this.state[f.url];
			return (st && st.items) ? st.items : [];
		}, this);

		var out = [];
		var cap = this.config.maxItems || 60;
		/* Across feeds as well as within one. ABC News and ABC Business carry
		 * the same lead story, and the round-robin puts them two apart - which
		 * on the ticker reads as the mirror having frozen and repeated itself.
		 * First occurrence wins, so config order decides which source is
		 * credited. */
		var seen = Object.create(null);
		for (var round = 0; out.length < cap; round++) {
			var added = false;
			for (var i = 0; i < lists.length && out.length < cap; i++) {
				var item = lists[i][round];
				if (!item) continue;
				added = true;
				var key = item.title.toLowerCase();
				if (seen[key]) continue;
				seen[key] = true;
				out.push(item);
			}
			if (!added) break;
		}
		return out;
	},

	broadcast: function () {
		if (!this.config) return;
		var feeds = this.config.feeds || [];
		var ok = 0, newest = 0;
		feeds.forEach(function (f) {
			var st = this.state[f.url];
			if (st && st.items && st.items.length) ok++;
			if (st && st.fetchedAt > newest) newest = st.fetchedAt;
		}, this);

		this.sendSocketNotification("NEWSWIRE_ITEMS", {
			items: this.merged(),
			feedsConfigured: feeds.length,
			feedsWithItems: ok,
			lastFetchAt: newest || null,
		});
	},
});
