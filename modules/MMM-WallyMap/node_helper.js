var NodeHelper = require("node_helper");

/* Decodes the world atlas and the travel feed for MMM-WallyMap.
 *
 * The atlas is TopoJSON, which the browser cannot draw directly, so the arcs are
 * decoded here and sent over as plain lng/lat rings. Keeps the front end free of
 * topojson-client and d3-geo, which would otherwise have to be installed on the
 * mirror by hand — the module is deployed with cp, not npm. */

/** Delta-decode one quantized TopoJSON arc into [lng, lat] pairs. */
function decodeArc(arc, transform) {
	var sx = transform.scale[0], sy = transform.scale[1];
	var tx = transform.translate[0], ty = transform.translate[1];
	var x = 0, y = 0, out = [];
	for (var i = 0; i < arc.length; i++) {
		x += arc[i][0];
		y += arc[i][1];
		out.push([x * sx + tx, y * sy + ty]);
	}
	return out;
}

/** A ring is a list of arc indices; a negative index means that arc reversed. */
function ringToCoords(ring, arcs) {
	var coords = [];
	for (var i = 0; i < ring.length; i++) {
		var idx = ring[i];
		var arc = idx < 0 ? arcs[~idx].slice().reverse() : arcs[idx];
		// Consecutive arcs share an endpoint — drop the duplicate.
		coords = coords.concat(i === 0 ? arc : arc.slice(1));
	}
	return coords;
}

function topoToRings(topo) {
	if (!topo || !topo.transform || !topo.arcs) return [];
	var arcs = topo.arcs.map(function (a) { return decodeArc(a, topo.transform); });
	var rings = [];
	Object.keys(topo.objects || {}).forEach(function (key) {
		var geometries = topo.objects[key].geometries || [topo.objects[key]];
		geometries.forEach(function (g) {
			if (g.type === "Polygon") {
				g.arcs.forEach(function (r) { rings.push(ringToCoords(r, arcs)); });
			} else if (g.type === "MultiPolygon") {
				g.arcs.forEach(function (poly) {
					poly.forEach(function (r) { rings.push(ringToCoords(r, arcs)); });
				});
			}
		});
	});
	return rings;
}

var DEFAULT_INVITE = "I'm off wandering. Fancy seeing where I've got to?";

/* Canned trips for config.testMode, so both behaviours can be checked on the
 * mirror without waiting for a real trip to be published. They are built here
 * rather than in the browser so test mode takes the identical payload path as
 * live data — only the source of the stops differs.
 *
 * Coordinates are approximate city centres, which is far more precision than a
 * 400px map needs; they are not from the site's geocoder. */
var daysAgo = function (n) { return new Date(Date.now() - n * 86400000).toISOString(); };

var PLACES = {
	perth:    { locationName: "Perth, Western Australia, Australia", lat: -31.95, lng: 115.86 },
	dubai:    { locationName: "Dubai, United Arab Emirates",         lat: 25.20,  lng: 55.27  },
	munich:   { locationName: "Munich, Bavaria, Germany",            lat: 48.14,  lng: 11.58  },
	salzburg: { locationName: "Salzburg, Austria",                   lat: 47.81,  lng: 13.05  },
};

function leg(mode, from, to) {
	return {
		mode: mode,
		fromLat: PLACES[from].lat, fromLng: PLACES[from].lng,
		toLat: PLACES[to].lat, toLng: PLACES[to].lng,
	};
}

function stop(key, title, days) {
	return Object.assign({ title: title, arrivedAt: daysAgo(days) }, PLACES[key]);
}

var FIXTURES = {
	// Ground hop: one view, framed to both ends.
	local: {
		tripTitle: "Test: Munich to Salzburg",
		invite: DEFAULT_INVITE,
		stops: [stop("munich", "Munich", 3), stop("salzburg", "Salzburg", 0)],
		legs: [leg("train", "munich", "salzburg")],
	},
	// Long haul: wide view of the whole journey, alternating with the close one.
	flight: {
		tripTitle: "Test: Perth to Munich",
		invite: DEFAULT_INVITE,
		stops: [stop("perth", "Home", 5), stop("dubai", "Dubai", 4), stop("munich", "Munich", 0)],
		legs: [leg("plane", "perth", "dubai"), leg("plane", "dubai", "munich")],
	},
};

module.exports = NodeHelper.create({
	start: function () {
		this.rings = null;
		console.log("[MMM-WallyMap] Node helper started");
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "WALLY_GET_DATA") this.fetchData(payload);
	},

	/** The atlas never changes, so it is fetched once per process. */
	getRings: async function (atlasUrl) {
		if (this.rings) return this.rings;
		var res = await fetch(atlasUrl, { signal: AbortSignal.timeout(15000) });
		if (!res.ok) throw new Error("atlas returned " + res.status);
		this.rings = topoToRings(await res.json());
		console.log("[MMM-WallyMap] Atlas decoded: " + this.rings.length + " rings");
		return this.rings;
	},

	/** Published stops and legs from the site's travel feed. */
	fetchLive: async function (config) {
		var postsRes = await fetch(config.postsUrl, { signal: AbortSignal.timeout(15000) });
		if (!postsRes.ok) throw new Error("posts returned " + postsRes.status);
		var posts = await postsRes.json();
		if (!Array.isArray(posts)) posts = [];

		// Newest last, so the final entry is where he is now.
		posts.sort(function (a, b) { return new Date(a.arrivedAt) - new Date(b.arrivedAt); });

		var stops = posts
			.filter(function (p) { return Number.isFinite(p.lat) && Number.isFinite(p.lng); })
			.map(function (p) {
				return {
					title: p.title,
					locationName: p.locationName,
					lat: p.lat,
					lng: p.lng,
					arrivedAt: p.arrivedAt,
				};
			});

		var legs = [];
		posts.forEach(function (p) {
			(p.legs || [])
				.slice()
				.sort(function (a, b) { return a.sortOrder - b.sortOrder; })
				.forEach(function (l) {
					if ([l.fromLat, l.fromLng, l.toLat, l.toLng].every(Number.isFinite)) {
						legs.push({
							mode: l.mode,
							fromLat: l.fromLat, fromLng: l.fromLng,
							toLat: l.toLat, toLng: l.toLng,
						});
					}
				});
		});

		// Trip title and invite copy are niceties; a failure here must not blank
		// the map. The copy is whatever he has set for the site's own popup, so
		// the mirror and the website stay in step.
		var tripTitle = null, invite = null;
		try {
			var curRes = await fetch(config.currentUrl, { signal: AbortSignal.timeout(10000) });
			if (curRes.ok) {
				var cur = await curRes.json();
				tripTitle = cur.tripTitle || null;
				invite = cur.body || null;
			}
		} catch (e) { /* leave them null */ }

		return { tripTitle: tripTitle, invite: invite, stops: stops, legs: legs };
	},

	/**
	 * Wally's wall clock and current temperature, in one keyless call.
	 *
	 * timezone=auto makes open-meteo resolve the zone for the coordinates and
	 * return its real UTC offset, which is why the clock is correct through DST
	 * and across countries that do not follow their longitude — deriving the
	 * offset from longitude alone puts Spain an hour out, among others.
	 */
	fetchLocal: async function (lat, lng) {
		var url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat +
			"&longitude=" + lng + "&current=temperature_2m&timezone=auto";
		var res = await fetch(url, { signal: AbortSignal.timeout(10000) });
		if (!res.ok) throw new Error("open-meteo returned " + res.status);
		var d = await res.json();
		return {
			timezone: d.timezone || null,
			offsetSeconds: Number.isFinite(d.utc_offset_seconds) ? d.utc_offset_seconds : null,
			tempC: d.current && Number.isFinite(d.current.temperature_2m) ? d.current.temperature_2m : null,
		};
	},

	fetchData: async function (config) {
		try {
			var trip = config.testMode && FIXTURES[config.testMode]
				? FIXTURES[config.testMode]
				: await this.fetchLive(config);

			var here = trip.stops[trip.stops.length - 1];

			// Weather and timezone are decoration; losing them must not cost the map.
			var local = null;
			if (here) {
				try { local = await this.fetchLocal(here.lat, here.lng); }
				catch (e) { console.error("[MMM-WallyMap] Local conditions:", e.message); }
			}

			var rings = trip.stops.length ? await this.getRings(config.atlasUrl) : [];

			this.sendSocketNotification("WALLY_DATA", {
				travelling: trip.stops.length > 0,
				tripTitle: trip.tripTitle,
				invite: trip.invite,
				stops: trip.stops,
				legs: trip.legs,
				local: local,
				rings: rings,
			});
		} catch (error) {
			console.error("[MMM-WallyMap] Error:", error.message);
			this.sendSocketNotification("WALLY_ERROR", { message: error.message });
		}
	},
});
