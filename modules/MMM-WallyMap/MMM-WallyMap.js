/* MMM-WallyMap — plots the current trip from the "Where's Wally" travel feed
 * on neaves.au. Country outlines, the route so far, and where he is now.
 *
 * Hides itself when there is no published trip, so the slot goes back to
 * whatever sits below it for the ~50 weeks a year he is at home.
 *
 * When the trip includes a flight the route is too big to read at one zoom, so
 * it alternates between the whole journey and a close view of where he is.
 * Each view is drawn once into its own canvas and the two are faded between —
 * one fully out before the next comes in, so they are never both on screen.
 * The mirror is a Celeron N3350 compositing a 90-degree-rotated page, where an
 * animated zoom would mean re-projecting 15,000 coastline points every frame;
 * fading pre-drawn canvases costs nothing per frame by comparison. */
Module.register("MMM-WallyMap", {
	defaults: {
		updateInterval: 15 * 60 * 1000,
		postsUrl: "https://neaves.au/api/travel/posts",
		currentUrl: "https://neaves.au/api/travel/current",
		atlasUrl: "https://neaves.au/geo/countries-110m.json",
		width: 400,
		height: 420,
		// Smallest view in degrees, so one stop does not zoom to street level.
		minSpanDeg: 8,
		// Degrees across the close view of the current location.
		closeSpanDeg: 11,
		// Fraction of the frame the route fills. Below 1 leaves surrounding
		// country around it, which is what makes the wireframe read as a map
		// rather than a few abstract lines.
		routeFill: 0.6,
		// How long each view sits before it swaps, and the fade either side.
		// Held to a 10s floor in startCycle — faster than that on a bathroom
		// mirror reads as flicker rather than a transition.
		viewHoldMs: 12000,
		fadeMs: 900,
		showTrail: true,
		// Nudge whoever is brushing their teeth towards the travel blog. The
		// wording comes from the site's own popup copy; this is just the URL to
		// print under it.
		showInvite: true,
		siteUrl: "neaves.au/wally",
		animationSpeed: 1000,
	},

	getStyles: function () { return ["MMM-WallyMap.css"]; },

	start: function () {
		this.travelling = false;
		this.tripTitle = null;
		this.invite = null;
		this.stops = [];
		this.legs = [];
		this.rings = [];
		this.loaded = false;
		this.error = null;
		this.viewTimer = null;
		this.canvases = [];
		this.viewIndex = 0;
		this.getData();
		setInterval(() => this.getData(), this.config.updateInterval);
	},

	getData: function () {
		this.sendSocketNotification("WALLY_GET_DATA", {
			postsUrl: this.config.postsUrl,
			currentUrl: this.config.currentUrl,
			atlasUrl: this.config.atlasUrl,
		});
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "WALLY_DATA") {
			this.travelling = payload.travelling;
			this.tripTitle = payload.tripTitle;
			this.invite = payload.invite;
			this.stops = payload.stops || [];
			this.legs = payload.legs || [];
			this.rings = payload.rings || [];
			this.error = null;
			this.loaded = true;
			// Nothing published means he is home — give the space back.
			if (this.travelling) { this.show(this.config.animationSpeed); }
			else { this.hide(this.config.animationSpeed); }
			this.updateDom(this.config.animationSpeed);
		} else if (notification === "WALLY_ERROR") {
			this.error = payload.message;
			this.loaded = true;
			this.updateDom(this.config.animationSpeed);
		}
	},

	/** MagicMirror calls these when the module is hidden or shown again. */
	suspend: function () { this.stopCycle(); },
	resume: function () { if (this.canvases.length > 1) this.startCycle(); },

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
	wantsTwoViews: function () {
		return this.stops.length > 1 && this.legs.some(function (l) { return l.mode === "plane"; });
	},

	getDom: function () {
		this.stopCycle();
		this.canvases = [];

		var wrapper = document.createElement("div");
		wrapper.className = "wallymap-wrapper";

		if (!this.loaded) {
			wrapper.innerHTML = '<div class="wallymap-status">Finding Wally...</div>';
			return wrapper;
		}
		if (this.error) {
			wrapper.innerHTML = '<div class="wallymap-status">Wally is off the map</div>';
			return wrapper;
		}
		if (!this.travelling) {
			wrapper.innerHTML = "";
			return wrapper;
		}

		var here = this.stops[this.stops.length - 1];

		// One canvas per view, stacked; only ever one of them is opaque.
		var views = [{ points: this.routePoints(), minSpan: this.config.minSpanDeg }];
		if (this.wantsTwoViews() && here) {
			views.push({ points: [{ lat: here.lat, lng: here.lng }], minSpan: this.config.closeSpanDeg });
		}

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
			canvas.style.transition = "opacity " + self.config.fadeMs + "ms ease-in-out";
			canvas.style.opacity = i === 0 ? "1" : "0";
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

			var when = document.createElement("span");
			when.className = "wallymap-when";
			when.textContent = this.sinceText(here.arrivedAt);
			label.appendChild(when);

			wrapper.appendChild(label);
		}

		if (this.config.showInvite) {
			var invite = document.createElement("div");
			invite.className = "wallymap-invite";
			if (this.invite) {
				var teaser = document.createElement("span");
				teaser.className = "wallymap-teaser";
				teaser.textContent = this.invite;
				invite.appendChild(teaser);
			}
			var url = document.createElement("span");
			url.className = "wallymap-url";
			url.textContent = this.config.siteUrl;
			invite.appendChild(url);
			wrapper.appendChild(invite);
		}

		// Canvases have no size until they are in the document.
		setTimeout(function () {
			self.viewIndex = 0;
			self.canvases.forEach(function (c) { self.drawView(c.el, c.view); });
			if (self.canvases.length > 1) self.startCycle();
		}, 100);

		return wrapper;
	},

	startCycle: function () {
		this.stopCycle();
		var self = this;
		// Hold, then fade out, then fade the next one in — never both at once.
		this.viewTimer = setInterval(function () {
			if (self.canvases.length < 2) return;
			var current = self.canvases[self.viewIndex];
			var next = (self.viewIndex + 1) % self.canvases.length;
			current.el.style.opacity = "0";
			setTimeout(function () {
				self.viewIndex = next;
				self.canvases[next].el.style.opacity = "1";
			}, self.config.fadeMs);
		}, Math.max(10000, this.config.viewHoldMs) + this.config.fadeMs * 2);
	},

	stopCycle: function () {
		if (this.viewTimer) { clearInterval(this.viewTimer); this.viewTimer = null; }
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

		return function (lng, lat) {
			return [
				w / 2 + (toX(lng) - cx) * scale,
				h / 2 + (toY(lat) - cy) * scale,
			];
		};
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

		// Coastlines and borders, kept faint so the route reads on top of them.
		// A ring that crosses the antimeridian comes back with a 360-degree jump
		// in longitude; drawn naively that streaks a line across the whole map,
		// so the path is broken wherever a segment jumps implausibly far.
		ctx.lineWidth = 1;
		ctx.strokeStyle = col(0.22);
		this.rings.forEach(function (ring) {
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

		// Route. Flights bow and dash; everything on the ground runs straight.
		if (this.config.showTrail) {
			ctx.lineWidth = 1.5;
			this.legs.forEach(function (leg) {
				var a = project(leg.fromLng, leg.fromLat);
				var z = project(leg.toLng, leg.toLat);
				var flying = leg.mode === "plane";
				ctx.strokeStyle = col(flying ? 0.55 : 0.75);
				ctx.setLineDash(flying ? [4, 4] : []);
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
			ctx.fillStyle = col(0.6);
			ctx.fill();
		}

		// Where he is now: filled dot inside a ring so it reads at a glance.
		var last = this.stops[this.stops.length - 1];
		var c = project(last.lng, last.lat);
		ctx.beginPath();
		ctx.arc(c[0], c[1], 4.5, 0, Math.PI * 2);
		ctx.fillStyle = col(1);
		ctx.fill();
		ctx.beginPath();
		ctx.arc(c[0], c[1], 9, 0, Math.PI * 2);
		ctx.lineWidth = 1.5;
		ctx.strokeStyle = col(0.7);
		ctx.stroke();
	},
});
