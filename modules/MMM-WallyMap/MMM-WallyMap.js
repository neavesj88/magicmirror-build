/* MMM-WallyMap - plots the current trip from the "Where's Wally" travel feed
 * on neaves.au. Country outlines, the route so far, and where he is now.
 *
 * Hides itself when there is no published trip, so the slot goes back to
 * whatever sits below it for the ~50 weeks a year he is at home.
 *
 * A trip with a flight spans far more than the city he is in, so it draws two
 * views and fades between them: the whole journey, then a close view. A trip
 * with no flight gets one view, auto-scaled tight to the ground actually
 * covered. Each view is drawn once into its own canvas and faded via opacity -
 * the mirror is a Celeron N3350 compositing a 90-degree-rotated page, where an
 * animated zoom would re-project 15,000 coastline points every frame.
 *
 * Deliberately ASCII-only source: the degree sign and separator are \u escapes
 * so nothing can mangle them if the page is ever served as other than UTF-8.
 */
Module.register("MMM-WallyMap", {
	defaults: {
		updateInterval: 15 * 60 * 1000,
		postsUrl: "https://neaves.au/api/travel/posts",
		currentUrl: "https://neaves.au/api/travel/current",
		tripUrl: "https://neaves.au/api/travel/trip",
		atlasUrl: "https://neaves.au/geo/countries-110m.json",
		/* The panel is 1080 wide in portrait. Height is deliberately less than
		 * width: at 1040 square the box ran up into the calendar and left a gap
		 * above the news ticker, because the band between them is only about
		 * 980px once the label and invite are allowed for. routeFill is high so
		 * the map uses the box rather than padding it out with empty space. */
		width: 1040,
		height: 620,
		// Hidden while a trip is showing, and shown again once he is home, so
		// the slot is never both at once and nothing has to be reconfigured
		// when the trip ends.
		hideWhileTravelling: ["MMM-BTCAud"],
		/* middle_center is centre-anchored: main.css gives it top:50% with
		 * translateY(-50%), so its MIDDLE sits at half the screen height. A top
		 * margin therefore does not move it down - it makes the block taller and
		 * the re-centring pushes the top edge UP into the calendar. This shifts
		 * the whole thing instead, without changing its height. Bigger moves the
		 * map down. The free band here runs from under the forecast to the news
		 * ticker, whose centre is well below the screen's. */
		offsetTopPx: 300,
		// Floor for a trip that includes a flight, where the wide view is the
		// whole journey and wants room around it.
		minSpanDeg: 8,
		// Floor for a ground-only trip. Small, so a short hop scales to the
		// distance actually travelled rather than being forced out to a
		// continent. routeFill then adds the margin around it.
		groundSpanDeg: 1.2,
		/* Floor for the close view. This is fitted to the frame's short side and
		 * then routeFill pads it, so 4 here renders about 10 degrees across -
		 * under detailBelowDeg, which is what earns the close view its cities
		 * and rivers. At the old 11 it rendered 28 degrees across: neither local
		 * nor the whole journey, and too wide to qualify for any detail. */
		closeSpanDeg: 4,
		// Fraction of the frame the route fills. Below 1 leaves surrounding
		// country around it, which is what makes the wireframe read as a map
		// rather than a few abstract lines.
		routeFill: 0.86,
		// Country outlines alone leave a local frame nearly empty, so below this
		// span the view also gets rivers and nearby cities.
		detailBelowDeg: 12,
		// Degrees of map the detail layers are clipped to, centred on where he
		// is. Comfortably wider than the close view so panning within it needs
		// no refetch.
		detailBoxDeg: 16,
		minPlacePopulation: 50000,
		maxPlaceLabels: 6,
		// Name the first and last stop on the map itself.
		showEndpointLabels: true,
		// A zoomed view loses all sense of where in the world it is, so once the
		// main view is tighter than this it gets a continent-scale inset.
		minimapBelowDeg: 25,
		// Fitted to the inset's short side, so this is the vertical reach: 28
		// centred on central Europe runs roughly Mediterranean to Scandinavia,
		// about 50 degrees wide. Wider than this and it starts showing Africa,
		// which costs the recognisable shape without adding anything.
		minimapSpanDeg: 28,
		minimapWidth: 260,
		minimapHeight: 210,
		minimapMargin: 16,
		// How long each view sits before it swaps, and the fade either side.
		// Both have floors (see holdDuration/fadeDuration) - anything quicker
		// on a bathroom mirror reads as a flicker rather than a transition.
		viewHoldMs: 20000,
		fadeMs: 4000,
		showTrail: true,
		// How long the feed must be unreachable before the held position is
		// labelled stale. Three missed polls, so a single blip says nothing.
		staleAfterMins: 45,
		// Wally's wall clock and the temperature where he is.
		showLocalClock: true,
		// Nudge whoever is brushing their teeth towards the travel blog. The
		// wording comes from the site's own popup copy; this is just the URL to
		// print under it.
		showInvite: true,
		siteUrl: "neaves.au/wally",
		// "local"  = Munich to Salzburg by train, one auto-scaled view.
		// "flight" = Perth to Dubai to Munich, the alternating pair.
		// false    = the real travel feed.
		testMode: false,
		animationSpeed: 1000,
	},

	getStyles: function () { return ["MMM-WallyMap.css"]; },

	start: function () {
		this.travelling = false;
		this.tripTitle = null;
		this.invite = null;
		this.local = null;
		this.stops = [];
		this.legs = [];
		this.chapters = [];
		this.rings = [];
		this.coast = [];
		this.detail = null;
		this.loaded = false;
		this.error = null;
		// When the feed last answered, and whether it is answering now, so a
		// held position can be labelled as stale rather than passing for current.
		this.lastGoodAt = null;
		this.offline = false;
		this.viewTimer = null;
		this.fadeTimer = null;
		this.clockTimer = null;
		this.clockEl = null;
		this.canvases = [];
		this.viewIndex = 0;
		this.getData();
		setInterval(() => this.getData(), this.config.updateInterval);
	},

	getData: function () {
		this.sendSocketNotification("WALLY_GET_DATA", {
			postsUrl: this.config.postsUrl,
			currentUrl: this.config.currentUrl,
			tripUrl: this.config.tripUrl,
			atlasUrl: this.config.atlasUrl,
			testMode: this.config.testMode,
			detailBoxDeg: this.config.detailBoxDeg,
			minPlacePopulation: this.config.minPlacePopulation,
			// Already have the outlines, so they need not be sent again.
			hasAtlas: this.rings.length > 0,
		});
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "WALLY_DATA") {
			this.travelling = payload.travelling;
			this.tripTitle = payload.tripTitle;
			this.invite = payload.invite;
			this.local = payload.local;
			this.stops = payload.stops || [];
			this.legs = payload.legs || [];
			this.chapters = payload.chapters || [];
			// null means unchanged, so keep the outlines already held.
			if (payload.rings) this.rings = payload.rings;
			if (payload.coast) this.coast = payload.coast;
			this.detail = payload.detail || null;
			this.error = null;
			this.loaded = true;
			this.offline = false;
			if (payload.travelling) this.lastGoodAt = Date.now();
			// Nothing published means he is home - give the space back.
			if (this.travelling) { this.show(this.config.animationSpeed); }
			else { this.hide(this.config.animationSpeed); }
			this.setNeighbours(this.travelling);
			this.updateDom(this.config.animationSpeed);
		} else if (notification === "WALLY_ERROR") {
			/* A failed poll must not wipe a working map. The mirror runs
			 * unattended for weeks at a time, and neaves.au being briefly
			 * unreachable should leave the last known position on screen rather
			 * than replace it with an error until the next poll succeeds. Only
			 * say something when there has never been anything to show. */
			if (this.stops.length) {
				console.warn("[MMM-WallyMap] keeping last known position: " + payload.message);
				this.offline = true;
				this.updateDom(this.config.animationSpeed);
				return;
			}
			this.error = payload.message;
			this.loaded = true;
			this.updateDom(this.config.animationSpeed);
		}
	},

	/**
	 * Takes the slot over while a trip is on. The Bitcoin price sits at the same
	 * position, so without this both are on screen at once; with it, the price
	 * steps aside for the map and comes back on its own when the trip ends -
	 * no config edit needed from the road or after landing.
	 *
	 * The lock string means only this module can reverse what it did.
	 */
	setNeighbours: function (travelling) {
		var names = this.config.hideWhileTravelling || [];
		if (!names.length || typeof MM === "undefined") return;
		var opts = { lockString: this.identifier };
		var speed = this.config.animationSpeed;
		MM.getModules().enumerate(function (m) {
			if (names.indexOf(m.name) === -1) return;
			if (travelling) m.hide(speed, opts);
			else m.show(speed, opts);
		});
	},

	/** MagicMirror calls these when the module is hidden or shown again. */
	suspend: function () { this.stopCycle(); this.stopClock(); },
	resume: function () {
		if (this.canvases.length > 1) this.startCycle();
		if (this.clockEl) this.startClock();
	},

	/* Floors, applied in one place so the CSS transition and the swap timer
	 * can never disagree about how long a fade takes. */
	fadeDuration: function () { return Math.max(4000, this.config.fadeMs); },
	holdDuration: function () { return Math.max(15000, this.config.viewHoldMs); },

	getHeader: function () {
		if (this.travelling && this.tripTitle) return this.tripTitle;
		return this.data.header;
	},

	/** "Munich, Bavaria, Germany" -> "Munich" */
	shortName: function (name) {
		return String(name || "").split(",")[0].trim();
	},

	getGlobalColor: function () {
		var el = document.querySelector(".module.MMM-WallyMap .module-content");
		if (el) return window.getComputedStyle(el).color;
		return "rgba(255,255,255,0.7)";
	},

	/** Every point the wide view has to contain. */
	routePoints: function () {
		var pts = this.stops.map(function (s) { return { lat: s.lat, lng: s.lng }; });
		this.legs.forEach(function (l) {
			pts.push({ lat: l.fromLat, lng: l.fromLng });
			pts.push({ lat: l.toLat, lng: l.toLng });
		});
		return pts;
	},

	/**
	 * A flight makes the journey span far more than the current city, so the two
	 * zooms show genuinely different things and are worth alternating. Without
	 * one the wide view is already local and a second view would just repeat it.
	 */
	hasFlight: function () {
		return this.legs.some(function (l) { return l.mode === "plane"; });
	},

	wantsTwoViews: function () {
		return this.stops.length > 1 && this.hasFlight();
	},

	getDom: function () {
		/* A poll rebuilds this every 15 minutes. Carry the rotation across
		 * the rebuild, otherwise it snapped back to the wide view each time
		 * and that view got systematically more screen time. */
		var prevIndex = this.viewIndex, prevCount = this.canvases.length;
		this.stopCycle();
		this.stopClock();
		this.canvases = [];
		this.clockEl = null;

		var wrapper = document.createElement("div");
		wrapper.className = "wallymap-wrapper";
		wrapper.style.position = "relative";
		wrapper.style.top = this.config.offsetTopPx + "px";

		if (!this.loaded) {
			wrapper.innerHTML = '<div class="wallymap-status">Finding Wally...</div>';
			return wrapper;
		}
		/* Never managed to reach the feed. Say so plainly and without alarm -
		 * it retries on its own, and a mirror on a wall is not the place for a
		 * stack trace. The reason stays in the log. */
		if (this.error) {
			wrapper.innerHTML =
				'<div class="wallymap-status">Wally is off the map</div>' +
				'<div class="wallymap-substatus">no answer from neaves.au, still trying</div>';
			return wrapper;
		}
		if (!this.travelling) {
			wrapper.innerHTML = "";
			return wrapper;
		}

		var here = this.stops[this.stops.length - 1];

		/* A single stop has no extent to scale to, so it falls back to the close
		 * span. Otherwise a flight keeps the roomy floor while a ground trip gets
		 * the tight one and scales to the distance actually covered. */
		var wideFloor;
		if (this.stops.length < 2) wideFloor = this.config.closeSpanDeg;
		else if (this.hasFlight()) wideFloor = this.config.minSpanDeg;
		else wideFloor = this.config.groundSpanDeg;

		var views = [{ points: this.routePoints(), minSpan: wideFloor }];
		if (this.wantsTwoViews() && here) {
			views.push({ points: [{ lat: here.lat, lng: here.lng }], minSpan: this.config.closeSpanDeg });
		}

		/* Top of the block reads trip, then chapter, then today: the trip
		 * title is the module header, the chapter names the leg of the journey,
		 * and the post title says what today was. Each is skipped when absent,
		 * and the post title is skipped when it merely repeats the place name
		 * already shown under the map. */
		var chapter = this.chapterTitle();
		if (chapter) {
			var chapterEl = document.createElement("div");
			chapterEl.className = "wallymap-chapter";
			chapterEl.textContent = chapter;
			wrapper.appendChild(chapterEl);
		}
		if (here && here.title) {
			var t = String(here.title).trim();
			if (t && t.toLowerCase() !== this.shortName(here.locationName).toLowerCase()) {
				var postTitle = document.createElement("div");
				postTitle.className = "wallymap-posttitle";
				postTitle.textContent = t;
				wrapper.appendChild(postTitle);
			}
		}

		var startIndex = (prevCount === views.length && prevIndex < views.length) ? prevIndex : 0;

		var stage = document.createElement("div");
		stage.className = "wallymap-stage";
		stage.style.width = this.config.width + "px";
		stage.style.height = this.config.height + "px";

		var self = this;
		views.forEach(function (view, i) {
			var canvas = document.createElement("canvas");
			canvas.width = self.config.width;
			canvas.height = self.config.height;
			canvas.className = "wallymap-canvas";
			canvas.style.transition = "opacity " + self.fadeDuration() + "ms ease-in-out";
			canvas.style.opacity = i === startIndex ? "1" : "0";
			stage.appendChild(canvas);
			self.canvases.push({ el: canvas, view: view });
		});
		wrapper.appendChild(stage);

		if (here) {
			var label = document.createElement("div");
			label.className = "wallymap-here";

			var place = document.createElement("span");
			place.className = "wallymap-place";
			place.textContent = this.shortName(here.locationName);
			label.appendChild(place);

			if (this.config.showLocalClock && this.local && this.local.offsetSeconds !== null) {
				this.clockEl = document.createElement("span");
				this.clockEl.className = "wallymap-clock";
				this.clockEl.textContent = this.clockText();
				label.appendChild(this.clockEl);
			}

			var when = document.createElement("span");
			when.className = "wallymap-when";
			when.textContent = this.sinceText(here.arrivedAt);
			label.appendChild(when);

			/* Holding a position while the feed is unreachable is the right
			 * behaviour, but showing it as though it were current is not: a
			 * stale map and a stationary Wally look identical otherwise. */
			var stale = this.staleText();
			if (stale) {
				var offline = document.createElement("span");
				offline.className = "wallymap-offline";
				offline.textContent = stale;
				label.appendChild(offline);
			}

			wrapper.appendChild(label);
		}

		if (this.config.showInvite) {
			var invite = document.createElement("div");
			invite.className = "wallymap-invite";

			/* The journey that got him here, in place names, in place of the
			 * generic "off wandering" line. Uses the leg's own fromName/toName
			 * rather than the stop list, so it says how he actually travelled. */
			var route = this.legRouteText();
			if (route) {
				var journey = document.createElement("span");
				journey.className = "wallymap-journey";
				journey.textContent = route;
				invite.appendChild(journey);
			}

			var url = document.createElement("span");
			url.className = "wallymap-url";
			url.textContent = this.config.siteUrl;
			invite.appendChild(url);
			wrapper.appendChild(invite);
		}

		// Canvases have no size until they are in the document.
		setTimeout(function () {
			self.viewIndex = startIndex;
			self.canvases.forEach(function (c) { self.drawView(c.el, c.view); });
			if (self.canvases.length > 1) self.startCycle();
			if (self.clockEl) self.startClock();
		}, 100);

		return wrapper;
	},

	startCycle: function () {
		this.stopCycle();
		var self = this;
		// Hold, then fade out, then fade the next one in - never both at once.
		this.viewTimer = setInterval(function () {
			if (self.canvases.length < 2) return;
			var stack = self.canvases;
			var current = stack[self.viewIndex];
			var next = (self.viewIndex + 1) % stack.length;
			current.el.style.opacity = "0";
			/* Tracked, because a poll can rebuild the DOM inside this fade. An
			 * untracked timeout still fired afterwards, moving viewIndex while the
			 * other canvas was the visible one; the next tick then faded out
			 * something already invisible and faded in something already shown,
			 * costing a whole silent cycle and making the two views unequal. */
			self.fadeTimer = setTimeout(function () {
				self.fadeTimer = null;
				if (self.canvases !== stack) return;
				self.viewIndex = next;
				stack[next].el.style.opacity = "1";
			}, self.fadeDuration());
		}, this.holdDuration() + this.fadeDuration() * 2);
	},

	stopCycle: function () {
		if (this.viewTimer) { clearInterval(this.viewTimer); this.viewTimer = null; }
		if (this.fadeTimer) { clearTimeout(this.fadeTimer); this.fadeTimer = null; }
	},

	/**
	 * Wally's wall clock, from the offset open-meteo resolved for his
	 * coordinates. Shifting UTC by that offset and then reading the UTC fields
	 * gives his local time without depending on the mirror's own timezone.
	 */
	clockText: function () {
		if (!this.local || this.local.offsetSeconds === null) return "";
		var t = new Date(Date.now() + this.local.offsetSeconds * 1000);
		var hh = String(t.getUTCHours()).padStart(2, "0");
		var mm = String(t.getUTCMinutes()).padStart(2, "0");
		var out = hh + ":" + mm;
		if (this.local.tempC !== null && this.local.tempC !== undefined) {
			out += "  \u00b7  " + Math.round(this.local.tempC) + "\u00b0";
		}
		return out;
	},

	startClock: function () {
		this.stopClock();
		var self = this;
		// Only minutes are shown, so this is about keeping the displayed minute
		// honest, not about ticking.
		this.clockTimer = setInterval(function () {
			if (self.clockEl) self.clockEl.textContent = self.clockText();
		}, 10000);
	},

	stopClock: function () {
		if (this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = null; }
	},

	/**
	 * Says how old the shown position is, but only once it is old enough to
	 * matter. A single missed poll is noise; an hour of silence is worth saying.
	 */
	staleText: function () {
		if (!this.offline || !this.lastGoodAt) return "";
		var mins = Math.floor((Date.now() - this.lastGoodAt) / 60000);
		if (mins < this.config.staleAfterMins) return "";
		if (mins < 120) return "offline \u00b7 " + mins + " min old";
		var hours = Math.round(mins / 60);
		if (hours < 48) return "offline \u00b7 " + hours + "h old";
		return "offline \u00b7 " + Math.round(hours / 24) + "d old";
	},

	/**
	 * "Dubai \u2192 Munich" for the most recent leg. Falls back to the first and
	 * last stop when the legs carry no names, and to nothing at all on the first
	 * stop of a trip, where there is no journey to describe yet.
	 */
	/**
	 * The name of the section of the journey he is in - "Bavaria & the Alps".
	 * Chapters are optional in the data, so this is empty far more often than
	 * not and the caller simply draws nothing.
	 */
	chapterTitle: function () {
		var here = this.stops[this.stops.length - 1];
		if (!here || here.chapterId === null || here.chapterId === undefined) return "";
		var match = this.chapters.filter(function (c) { return c.id === here.chapterId; })[0];
		return match && match.title ? String(match.title).trim() : "";
	},

	legRouteText: function () {
		var last = this.legs.length ? this.legs[this.legs.length - 1] : null;
		var from = last && last.fromName ? this.shortName(last.fromName) : null;
		var to = last && last.toName ? this.shortName(last.toName) : null;

		if (!from || !to) {
			if (this.stops.length < 2) return "";
			from = this.shortName(this.stops[0].locationName);
			to = this.shortName(this.stops[this.stops.length - 1].locationName);
		}
		if (!from || !to || from === to) return "";
		return from + " \u2192 " + to;
	},

	sinceText: function (arrivedAt) {
		var t = new Date(arrivedAt).getTime();
		if (!isFinite(t)) return "";
		var days = Math.floor((Date.now() - t) / 86400000);
		if (days <= 0) return "arrived today";
		if (days === 1) return "1 day here";
		return days + " days here";
	},

	/** Equirectangular, x compressed by cos(mid latitude) so shapes stay sane. */
	buildProjection: function (w, h, points, minSpan) {
		var pad = 14;
		var lats = points.map(function (p) { return p.lat; });
		var lngs = points.map(function (p) { return p.lng; });

		var latMin = Math.min.apply(null, lats), latMax = Math.max.apply(null, lats);
		var lngMin = Math.min.apply(null, lngs), lngMax = Math.max.apply(null, lngs);
		var midLat = (latMin + latMax) / 2;
		var kx = Math.max(0.15, Math.cos(midLat * Math.PI / 180));

		var toX = function (lng) { return lng * kx; };
		var toY = function (lat) { return -lat; };

		var x0 = toX(lngMin), x1 = toX(lngMax);
		var y0 = toY(latMax), y1 = toY(latMin);
		var spanX = Math.max(x1 - x0, minSpan * kx);
		var spanY = Math.max(y1 - y0, minSpan);
		var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;

		var scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY) * this.config.routeFill;

		var project = function (lng, lat) {
			return [
				w / 2 + (toX(lng) - cx) * scale,
				h / 2 + (toY(lat) - cy) * scale,
			];
		};
		// Degrees visible across the canvas, so the caller can decide whether the
		// view is tight enough to need the inset.
		project.spanDeg = w / (scale * kx);
		return project;
	},

	/**
	 * Country outlines. A ring that crosses the antimeridian comes back with a
	 * 360-degree jump in longitude; drawn naively that streaks a line across the
	 * whole map, so the path is broken wherever a segment jumps implausibly far.
	 */
	strokeRings: function (ctx, project, rings) {
		(rings || this.rings).forEach(function (ring) {
			if (ring.length < 2) return;
			ctx.beginPath();
			var pen = false;
			for (var i = 0; i < ring.length; i++) {
				var wrapped = i > 0 && Math.abs(ring[i][0] - ring[i - 1][0]) > 180;
				var p = project(ring[i][0], ring[i][1]);
				if (!pen || wrapped) { ctx.moveTo(p[0], p[1]); pen = true; }
				else ctx.lineTo(p[0], p[1]);
			}
			ctx.stroke();
		});
	},

	/**
	 * Continent-scale inset with a pointer on the current location, for when the
	 * main view is zoomed too far in to say where in the world it is.
	 */
	drawMinimap: function (ctx, w, h, col) {
		var here = this.stops[this.stops.length - 1];
		if (!here) return;

		var mw = this.config.minimapWidth, mh = this.config.minimapHeight;
		var m = this.config.minimapMargin;
		var x0 = w - mw - m, y0 = m;

		var span = this.config.minimapSpanDeg;
		var kx = Math.max(0.15, Math.cos(here.lat * Math.PI / 180));
		var scale = Math.min(mw / (span * kx), mh / span);
		/* Unwrap the longitude difference across the antimeridian. Taken raw,
		 * a coast 2 degrees east of a stop at 178E computes as 358 degrees west
		 * and lands far outside the clipped inset, leaving the pointer floating
		 * in blank sea. Harmless in Europe, wrong in Fiji. */
		var project = function (lng, lat) {
			var dlng = lng - here.lng;
			if (dlng > 180) dlng -= 360;
			else if (dlng < -180) dlng += 360;
			return [
				x0 + mw / 2 + dlng * kx * scale,
				y0 + mh / 2 + (here.lat - lat) * scale,
			];
		};

		ctx.save();
		ctx.beginPath();
		ctx.rect(x0, y0, mw, mh);
		ctx.clip();
		// Opaque backdrop, otherwise the main map shows through the inset.
		ctx.fillStyle = "rgba(0,0,0,0.85)";
		ctx.fillRect(x0, y0, mw, mh);
		/* Coastlines only. Drawing every country outline here made the inset an
		 * unreadable thicket of borders; the land/sea edge alone is enough to
		 * recognise Europe at a glance and put the ping in context. */
		ctx.lineWidth = 2.2;
		ctx.strokeStyle = col(0.7);
		this.strokeRings(ctx, project, this.coast && this.coast.length ? this.coast : this.rings);
		ctx.restore();

		// Frame and pointer outside the clip so they stay crisp.
		ctx.lineWidth = 2;
		ctx.strokeStyle = col(0.55);
		ctx.strokeRect(x0, y0, mw, mh);

		var p = project(here.lng, here.lat);
		ctx.beginPath();
		ctx.arc(p[0], p[1], 6, 0, Math.PI * 2);
		ctx.fillStyle = col(1);
		ctx.fill();
		ctx.beginPath();
		ctx.arc(p[0], p[1], 11, 0, Math.PI * 2);
		ctx.lineWidth = 2.5;
		ctx.strokeStyle = col(1);
		ctx.stroke();
	},

	/**
	 * Rivers and nearby cities, for a view zoomed in far enough that borders
	 * alone leave it empty. Rivers first so city dots sit on top of them.
	 */
	drawDetail: function (ctx, project, col) {
		if (!this.detail) return;

		var stroke = function (lines, alpha) {
			ctx.strokeStyle = col(alpha);
			(lines || []).forEach(function (line) {
				if (line.length < 2) return;
				ctx.beginPath();
				for (var i = 0; i < line.length; i++) {
					var p = project(line[i][0], line[i][1]);
					if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
				}
				ctx.stroke();
			});
		};

		ctx.lineWidth = 2.6;
		stroke(this.detail.borders, 0.7);
		stroke(this.detail.rivers, 0.6);

		// Skip any city that is a stop on the trip - those get their own,
		// brighter tag and would otherwise be labelled twice.
		var self = this;
		var onRoute = this.stops.map(function (s) { return self.shortName(s.locationName).toLowerCase(); });
		var places = (this.detail.places || [])
			.filter(function (p) { return onRoute.indexOf(String(p.name).toLowerCase()) === -1; })
			.slice(0, this.config.maxPlaceLabels);

		ctx.font = "23px sans-serif";
		ctx.textAlign = "left";
		ctx.textBaseline = "middle";
		places.forEach(function (p) {
			var xy = project(p.lng, p.lat);
			ctx.beginPath();
			ctx.arc(xy[0], xy[1], 4, 0, Math.PI * 2);
			ctx.fillStyle = col(0.8);
			ctx.fill();
			ctx.fillStyle = col(0.75);
			ctx.fillText(p.name, xy[0] + 11, xy[1]);
		});
	},

	/**
	 * Names the first and last stop on the map. The feed already carries
	 * locationName, so this needs no extra data, and it is what actually tells
	 * you what you are looking at when the outlines are sparse.
	 */
	drawEndpointLabels: function (ctx, project, col, w) {
		if (this.stops.length < 2) return;
		var self = this;
		var ends = [this.stops[0], this.stops[this.stops.length - 1]];

		ctx.font = "34px sans-serif";
		ctx.textBaseline = "middle";
		ends.forEach(function (s) {
			var xy = project(s.lng, s.lat);
			var name = self.shortName(s.locationName);
			// Flip the label inboard when the stop sits near the right edge.
			var right = xy[0] > w * 0.62;
			ctx.textAlign = right ? "right" : "left";
			var x = xy[0] + (right ? -28 : 28);
			ctx.fillStyle = col(0.95);
			ctx.fillText(name, x, xy[1]);
		});
	},

	drawView: function (canvas, view) {
		var ctx = canvas.getContext("2d");
		var w = canvas.width, h = canvas.height;
		ctx.clearRect(0, 0, w, h);
		if (!this.stops.length || !view.points.length) return;

		var rgb = this.getGlobalColor().match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
		var r = rgb ? parseInt(rgb[1]) : 255;
		var g = rgb ? parseInt(rgb[2]) : 255;
		var b = rgb ? parseInt(rgb[3]) : 255;
		var col = function (a) { return "rgba(" + r + "," + g + "," + b + "," + a + ")"; };

		var project = this.buildProjection(w, h, view.points, view.minSpan);

		/* Outlines, kept faint so the route reads on top of them. Once the fine
		 * borders are available the coarse country rings are dropped: their
		 * internal borders are the chords that cut across a zoomed frame. The
		 * land rings stay, since they are the only coastline either way. */
		var detailed = project.spanDeg < this.config.detailBelowDeg &&
			this.detail && this.detail.borders && this.detail.borders.length > 0;
		ctx.lineWidth = 3;
		ctx.strokeStyle = col(0.65);
		this.strokeRings(ctx, project, detailed ? this.coast : this.rings);

		if (project.spanDeg < this.config.detailBelowDeg) {
			this.drawDetail(ctx, project, col);
		}

		// Route. Flights bow and dash; everything on the ground runs straight.
		if (this.config.showTrail) {
			ctx.lineWidth = 5;
			this.legs.forEach(function (leg) {
				var a = project(leg.fromLng, leg.fromLat);
				var z = project(leg.toLng, leg.toLat);
				var flying = leg.mode === "plane";
				ctx.strokeStyle = col(flying ? 0.85 : 1);
				ctx.setLineDash(flying ? [10, 9] : []);
				ctx.beginPath();
				ctx.moveTo(a[0], a[1]);
				if (flying) {
					var mx = (a[0] + z[0]) / 2, my = (a[1] + z[1]) / 2;
					var dx = z[0] - a[0], dy = z[1] - a[1];
					var len = Math.sqrt(dx * dx + dy * dy) || 1;
					// Bow perpendicular to the leg, proportional to its length.
					var bow = Math.min(len * 0.18, 40);
					ctx.quadraticCurveTo(mx - (dy / len) * bow, my + (dx / len) * bow, z[0], z[1]);
				} else {
					ctx.lineTo(z[0], z[1]);
				}
				ctx.stroke();
			});
			ctx.setLineDash([]);
		}

		// Stops already visited.
		for (var i = 0; i < this.stops.length - 1; i++) {
			var p = project(this.stops[i].lng, this.stops[i].lat);
			ctx.beginPath();
			ctx.arc(p[0], p[1], 2.5, 0, Math.PI * 2);
			ctx.fillStyle = col(0.85);
			ctx.fill();
		}

		// Where he is now: filled dot inside a ring so it reads at a glance.
		var last = this.stops[this.stops.length - 1];
		var c = project(last.lng, last.lat);
		ctx.beginPath();
		ctx.arc(c[0], c[1], 11, 0, Math.PI * 2);
		ctx.fillStyle = col(1);
		ctx.fill();
		ctx.beginPath();
		ctx.arc(c[0], c[1], 22, 0, Math.PI * 2);
		ctx.lineWidth = 4;
		ctx.strokeStyle = col(1);
		ctx.stroke();

		if (this.config.showEndpointLabels) {
			this.drawEndpointLabels(ctx, project, col, w);
		}

		if (project.spanDeg < this.config.minimapBelowDeg) {
			this.drawMinimap(ctx, w, h, col);
		}
	},
});
