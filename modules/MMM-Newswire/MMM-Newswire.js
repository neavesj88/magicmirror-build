/* MMM-Newswire - the mirror's own news ticker.
 *
 * Replaces the stock newsfeed module for two reasons. The data bill: the stock
 * module polls every five minutes and sends no cache validator, so it
 * re-downloads every feed in full 288 times a day. And the motion: a plain
 * cross-fade does not read across a two-way mirror, where anything static just
 * sinks into the glass.
 *
 * Four animations, picked with the "animation" option:
 *
 *   roll    - headline lifts out, the next rises in. The default: one clear
 *             movement per change, like a departures board.
 *   fade    - cross-fade, the stock behaviour, for when the mirror should be
 *             as calm as possible.
 *   marquee - a continuous crawl at a fixed pixels-per-second, so the speed
 *             does not change with the length of the headline.
 *   wipe    - the headline writes on left to right, holds, cuts.
 *
 * All four are transform/opacity only, so the GPU (Intel HD 500, confirmed
 * present) composites them without repainting text every frame. That matters
 * here: the whole page is rotated 90 degrees for the portrait panel, and
 * anything that forces a repaint has to re-rasterise through that rotation.
 *
 * Deliberately ASCII-only source: the separator and ellipsis are \u escapes so
 * nothing can mangle them if the page is ever served as other than UTF-8.
 */
Module.register("MMM-Newswire", {
	defaults: {
		/* Each feed: { title, url, maxItems?, reloadInterval? }
		 * Set in config.js - there is no sensible default news diet. */
		feeds: [],

		animation: "roll",

		// Time one headline holds still, for roll/fade/wipe. The transition
		// runs on top of this rather than adding to it.
		holdMs: 9000,
		transitionMs: 700,

		/* Marquee speed in pixels per second. The mockup ran at 446 px/s and he
		 * asked for half that. Expressed as a speed rather than a duration so
		 * a long headline crawls for longer instead of crawling faster. */
		marqueeSpeed: 223,
		/* Headlines per marquee pass. Caps the width of the strip, which is one
		 * composited layer: ten headlines at this font is around 7,000px, well
		 * inside the 16,384px texture limit on this GPU. Past that Chromium
		 * tiles the layer and the crawl starts to stutter. */
		marqueeItems: 10,

		// Headlines in rotation, and per feed before the interleave. Nine feeds
		// at six each is about nine minutes of ticker per cycle.
		maxItems: 60,
		maxItemsPerFeed: 6,

		/* Four hours. The stock module's five minutes bought nothing: these
		 * feeds publish a few times an hour at most, and a bathroom mirror is
		 * not a trading desk. */
		reloadInterval: 4 * 60 * 60 * 1000,
		// A failed feed retries sooner than the full interval, stepping back
		// towards it as failures accumulate.
		retryMs: 10 * 60 * 1000,
		staggerMs: 4000,
		jitterMs: 60 * 1000,
		timeoutMs: 20000,

		showSource: true,
		showAge: false,
		// Past this with no successful fetch, the ticker says so rather than
		// presenting yesterday's news as current.
		staleAfterHours: 12,

		heightPx: 74,
		fontSizePx: 26,
		sourceFontSizePx: 15,
	},

	getStyles: function () { return ["MMM-Newswire.css"]; },

	start: function () {
		this.items = [];
		this.index = 0;
		this.loaded = false;
		this.status = { feedsConfigured: (this.config.feeds || []).length, feedsWithItems: 0, lastFetchAt: null };
		this.stage = null;
		this.current = null;
		this.holdTimer = null;
		this.readyTimer = null;
		this.marqueeAnim = null;
		this.cleanupTimers = [];
		this.sendSocketNotification("NEWSWIRE_CONFIG", this.config);
		console.log("[MMM-Newswire] started, animation: " + this.config.animation);
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification !== "NEWSWIRE_ITEMS") return;
		this.items = payload.items || [];
		this.status = payload;

		if (!this.loaded) {
			this.loaded = true;
			this.updateDom(1000);
			return;
		}

		/* this.stage is set only while the ticker itself is rendered - the
		 * placeholder and offline paths leave it null. So a mismatch between
		 * "we have headlines" and "the ticker is on screen" means the DOM is
		 * showing the wrong thing and has to be rebuilt.
		 *
		 * This is what stranded the first deployment on "Fetching headlines":
		 * the helper's opening broadcast is empty (it fires before any network
		 * happens), that renders the placeholder and nulls the stage, and the
		 * real headlines a few seconds later then had nothing to attach to. */
		if (!this.items.length !== !this.stage) {
			this.updateDom(1000);
			return;
		}

		/* Otherwise leave the DOM alone. The running cycle reads this.items on
		 * every advance, so new headlines appear at the next change without
		 * interrupting the one on screen. Calling updateDom here would restart
		 * the animation mid-headline four times an hour for no reason. */
		if (this.items.length && !this.isCycling()) this.startCycleWhenReady();
	},

	isCycling: function () {
		return !!(this.holdTimer || this.marqueeAnim || this.readyTimer);
	},

	suspend: function () { this.stopCycle(); },
	resume: function () { if (this.stage) this.startCycleWhenReady(); },

	stopCycle: function () {
		if (this.holdTimer) { clearTimeout(this.holdTimer); this.holdTimer = null; }
		if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
		if (this.marqueeAnim) { this.marqueeAnim.onfinish = null; this.marqueeAnim.cancel(); this.marqueeAnim = null; }
		this.cleanupTimers.forEach(clearTimeout);
		this.cleanupTimers = [];
		this.current = null;
	},

	/** True once no successful fetch has landed for staleAfterHours. */
	isStale: function () {
		if (!this.status.lastFetchAt) return false;
		return (Date.now() - this.status.lastFetchAt) > this.config.staleAfterHours * 3600000;
	},

	relativeAge: function (ts) {
		var mins = Math.round((Date.now() - ts) / 60000);
		if (mins < 1) return "now";
		if (mins < 60) return mins + "m";
		var hours = Math.round(mins / 60);
		if (hours < 24) return hours + "h";
		return Math.round(hours / 24) + "d";
	},

	/** One headline, as a row of spans. */
	renderItem: function (item) {
		var el = document.createElement("div");
		el.className = "newswire-item";

		if (this.config.showSource && item.source) {
			var src = document.createElement("span");
			src.className = "newswire-source";
			src.textContent = item.source;
			el.appendChild(src);
		}

		var title = document.createElement("span");
		title.className = "newswire-title";
		title.textContent = item.title;
		el.appendChild(title);

		if (this.config.showAge && item.ts) {
			var age = document.createElement("span");
			age.className = "newswire-age";
			age.textContent = this.relativeAge(item.ts);
			el.appendChild(age);
		}
		return el;
	},

	getDom: function () {
		// getDom can be called again at any time - by show/hide, by a profile
		// change, by Remote Control. Tear the cycle down first so two of them
		// never run against two different stages.
		this.stopCycle();
		this.stage = null;

		var wrapper = document.createElement("div");
		wrapper.className = "newswire newswire-anim-" + this.config.animation;
		wrapper.style.setProperty("--nw-height", this.config.heightPx + "px");
		wrapper.style.setProperty("--nw-font", this.config.fontSizePx + "px");
		wrapper.style.setProperty("--nw-source-font", this.config.sourceFontSizePx + "px");
		wrapper.style.setProperty("--nw-trans", this.config.transitionMs + "ms");

		if (!this.items.length) {
			var msg = document.createElement("div");
			msg.className = "newswire-offline";
			if (!this.status.lastFetchAt) {
				msg.textContent = this.status.feedsConfigured
					? "Fetching headlines…"
					: "No feeds configured";
			} else {
				// Fetches have run and produced nothing: no connection, or every
				// feed is refusing. It retries on its own, so say so plainly
				// rather than leaving an empty bar that looks like a crash.
				msg.textContent = "Headlines unavailable – retrying";
			}
			wrapper.appendChild(msg);
			return wrapper;
		}

		var stage = document.createElement("div");
		stage.className = "newswire-stage";
		wrapper.appendChild(stage);
		this.stage = stage;

		if (this.isStale()) {
			var stale = document.createElement("div");
			stale.className = "newswire-stale";
			stale.textContent = "offline";
			wrapper.appendChild(stale);
		}

		this.startCycleWhenReady();
		return wrapper;
	},

	/**
	 * Wait until the stage is in the document and has a width.
	 *
	 * getDom returns a detached node, and MagicMirror inserts it afterwards -
	 * so measuring here directly gives zero, and the marquee would compute a
	 * nonsense duration from it.
	 */
	startCycleWhenReady: function (attempt) {
		attempt = attempt || 0;
		if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
		if (!this.stage) return;

		var wide = this.stage.isConnected && this.stage.getBoundingClientRect().width > 0;
		// Roll, fade and wipe do not need a measurement, so they only wait for
		// attachment; the marquee needs a real width.
		if (wide || (attempt > 20 && this.config.animation !== "marquee")) {
			this.startCycle();
			return;
		}
		if (attempt > 50) {
			console.error("[MMM-Newswire] stage never got a width, ticker not started");
			return;
		}
		var self = this;
		this.readyTimer = setTimeout(function () {
			self.readyTimer = null;
			self.startCycleWhenReady(attempt + 1);
		}, 100);
	},

	startCycle: function () {
		if (!this.stage || !this.items.length) return;
		if (this.config.animation === "marquee") this.runMarquee();
		else this.showNext();
	},

	/** Advance one headline, for roll/fade/wipe. */
	showNext: function () {
		if (!this.stage || !this.items.length) return;

		var item = this.items[this.index % this.items.length];
		var el = this.renderItem(item);
		// Enter state first, painted once, then released - without the forced
		// reflow Chromium coalesces both states and the transition never runs.
		el.classList.add("nw-enter");
		this.stage.appendChild(el);
		void el.offsetWidth;
		el.classList.remove("nw-enter");

		var outgoing = this.current;
		this.current = el;
		if (outgoing) {
			outgoing.classList.add("nw-exit");
			var self = this;
			this.cleanupTimers.push(setTimeout(function () {
				if (outgoing.parentNode) outgoing.parentNode.removeChild(outgoing);
				self.cleanupTimers.shift();
			}, this.config.transitionMs + 100));
		}

		this.index = (this.index + 1) % this.items.length;
		this.holdTimer = setTimeout(this.showNext.bind(this), Math.max(1000, this.config.holdMs));
	},

	/**
	 * One marquee pass, then rebuild with the next slice.
	 *
	 * Driven by the Web Animations API rather than a CSS keyframe so the exact
	 * pixel distance and duration can be computed from the measured strip:
	 * that is what makes the speed constant regardless of how much text is in
	 * the pass. Transform-only, so it composites.
	 */
	runMarquee: function () {
		if (!this.stage || !this.items.length) return;

		var count = Math.min(Math.max(1, this.config.marqueeItems), this.items.length);
		var strip = document.createElement("div");
		strip.className = "newswire-strip";
		for (var i = 0; i < count; i++) {
			if (i > 0) {
				var sep = document.createElement("span");
				sep.className = "newswire-sep";
				sep.textContent = "•";
				strip.appendChild(sep);
			}
			strip.appendChild(this.renderItem(this.items[(this.index + i) % this.items.length]));
		}

		this.stage.textContent = "";
		this.stage.appendChild(strip);

		var stageW = this.stage.getBoundingClientRect().width || window.innerWidth;
		var stripW = strip.scrollWidth;
		var duration = ((stageW + stripW) / Math.max(10, this.config.marqueeSpeed)) * 1000;

		var anim = strip.animate([
			{ transform: "translate3d(" + stageW + "px, 0, 0)" },
			{ transform: "translate3d(" + (-stripW) + "px, 0, 0)" },
		], { duration: duration, easing: "linear", fill: "forwards" });

		this.marqueeAnim = anim;
		var self = this;
		anim.onfinish = function () {
			self.marqueeAnim = null;
			// Advance past the headlines just shown, so the next pass carries
			// on through the rotation rather than repeating the same ten.
			self.index = (self.index + count) % self.items.length;
			self.runMarquee();
		};
	},
});
