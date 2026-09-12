/* MMM-WallyMap — plots the current trip from the "Where's Wally" travel feed
 * on neaves.au. Country outlines, the route so far, and where he is now.
 *
 * Hides itself when there is no published trip, so the slot goes back to
 * whatever sits below it for the ~50 weeks a year he is at home. */
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
		// Fraction of the frame the route fills. Below 1 leaves surrounding
		// country around it, which is what makes the wireframe read as a map
		// rather than a few abstract lines.
		routeFill: 0.6,
		showTrail: true,
		animationSpeed: 1000,
	},

	getStyles: function () { return ["MMM-WallyMap.css"]; },

	start: function () {
		this.travelling = false;
		this.tripTitle = null;
		this.stops = [];
		this.legs = [];
		this.rings = [];
		this.loaded = false;
		this.error = null;
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

	getDom: function () {
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
			// Hidden anyway; return something harmless rather than nothing.
			wrapper.innerHTML = "";
			return wrapper;
		}

		var canvas = document.createElement("canvas");
		canvas.width = this.config.width;
		canvas.height = this.config.height;
		canvas.className = "wallymap-canvas";
		wrapper.appendChild(canvas);

		var here = this.stops[this.stops.length - 1];
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

		var self = this;
		setTimeout(function () { self.drawMap(canvas); }, 100);
		return wrapper;
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
	buildProjection: function (w, h) {
		var pad = 14;
		var lats = this.stops.map(function (s) { return s.lat; });
		var lngs = this.stops.map(function (s) { return s.lng; });
		this.legs.forEach(function (l) {
			lats.push(l.fromLat, l.toLat);
			lngs.push(l.fromLng, l.toLng);
		});

		var latMin = Math.min.apply(null, lats), latMax = Math.max.apply(null, lats);
		var lngMin = Math.min.apply(null, lngs), lngMax = Math.max.apply(null, lngs);
		var midLat = (latMin + latMax) / 2;
		var kx = Math.max(0.15, Math.cos(midLat * Math.PI / 180));

		var toX = function (lng) { return lng * kx; };
		var toY = function (lat) { return -lat; };

		var x0 = toX(lngMin), x1 = toX(lngMax);
		var y0 = toY(latMax), y1 = toY(latMin);
		var spanX = Math.max(x1 - x0, this.config.minSpanDeg * kx);
		var spanY = Math.max(y1 - y0, this.config.minSpanDeg);
		var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;

		var scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY) * this.config.routeFill;

		return function (lng, lat) {
			return [
				w / 2 + (toX(lng) - cx) * scale,
				h / 2 + (toY(lat) - cy) * scale,
			];
		};
	},

	drawMap: function (canvas) {
		var ctx = canvas.getContext("2d");
		var w = canvas.width, h = canvas.height;
		ctx.clearRect(0, 0, w, h);
		if (!this.stops.length) return;

		var rgb = this.getGlobalColor().match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
		var r = rgb ? parseInt(rgb[1]) : 255;
		var g = rgb ? parseInt(rgb[2]) : 255;
		var b = rgb ? parseInt(rgb[3]) : 255;
		var col = function (a) { return "rgba(" + r + "," + g + "," + b + "," + a + ")"; };

		var project = this.buildProjection(w, h);

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
