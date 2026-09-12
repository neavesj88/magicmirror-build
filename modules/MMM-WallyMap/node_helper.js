var NodeHelper = require("node_helper");
var fs = require("fs/promises");
var path = require("path");
var os = require("os");

/* Decodes the world atlas and the travel feed for MMM-WallyMap.
 *
 * The atlas is TopoJSON, which the browser cannot draw directly, so the arcs are
 * decoded here and sent over as plain lng/lat rings. Keeps the front end free of
 * topojson-client and d3-geo, which would otherwise have to be installed on the
 * mirror by hand - the module is deployed with cp, not npm. */

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

/**
 * Hand every polygon ring (a list of arc indices) of one named object to the
 * callback.
 *
 * The object name matters: this atlas holds both "countries" and "land", which
 * cover the same ground. Iterating every object drew each coastline twice.
 */
function forEachRing(topo, objectName, fn) {
	var obj = (topo.objects || {})[objectName];
	if (!obj) return;
	var geometries = obj.geometries || [obj];
	geometries.forEach(function (g) {
		if (g.type === "Polygon") {
			g.arcs.forEach(fn);
		} else if (g.type === "MultiPolygon") {
			g.arcs.forEach(function (poly) { poly.forEach(fn); });
		}
	});
}

/** A ring is a list of arc indices; a negative index means that arc reversed. */
function ringToCoords(ring, arcs) {
	var coords = [];
	for (var i = 0; i < ring.length; i++) {
		var idx = ring[i];
		var arc = idx < 0 ? arcs[~idx].slice().reverse() : arcs[idx];
		// Consecutive arcs share an endpoint - drop the duplicate.
		coords = coords.concat(i === 0 ? arc : arc.slice(1));
	}
	return coords;
}

function decodeAllArcs(topo) {
	return topo.arcs.map(function (a) { return decodeArc(a, topo.transform); });
}

/**
 * Rings of one object. "countries" gives outlines with internal borders, which
 * suit the main map; "land" gives the landmass edge alone, which is what keeps
 * the continent inset readable rather than a thicket of borders.
 */
function topoToRings(topo, objectName) {
	if (!topo || !topo.transform || !topo.arcs) return [];
	var arcs = decodeAllArcs(topo);
	var rings = [];
	forEachRing(topo, objectName, function (ring) { rings.push(ringToCoords(ring, arcs)); });
	return rings;
}

var DEFAULT_INVITE = "I'm off wandering. Fancy seeing where I've got to?";

/* Extra layers for a local view, where country outlines alone leave the frame
 * almost empty - between Munich and Salzburg the atlas has nothing to draw.
 * Cities and rivers are what make that zoom legible.
 *
 * ne_10m_lakes is deliberately not here: it carries only major world lakes and
 * returns nothing for that area, so it would cost 4.8MB for an empty layer.
 * The 10m rivers are used rather than the 50m because the 50m set drops the
 * Inn, which is the river that actually anchors that region. */
var NE_BASE = "https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/";
var DETAIL_LAYERS = {
	places: "ne_10m_populated_places_simple.geojson",
	rivers: "ne_10m_rivers_lake_centerlines.geojson",
	// The 110m country outlines put only a handful of vertices along a border,
	// so zoomed in they become long straight chords cutting across the frame.
	// These are the same borders with real geometry - 1,182 vertices around
	// Munich and Salzburg where the atlas has a few.
	borders: "ne_10m_admin_0_boundary_lines_land.geojson",
};
var CACHE_DIR = path.join(os.homedir(), ".cache", "mmm-wallymap");

/** True when any coordinate of the geometry falls inside the box. */
function geometryInBox(geom, box) {
	var stack = [geom.coordinates];
	while (stack.length) {
		var c = stack.pop();
		if (!Array.isArray(c)) continue;
		if (typeof c[0] === "number") {
			if (c[0] >= box.w && c[0] <= box.e && c[1] >= box.s && c[1] <= box.n) return true;
		} else {
			for (var i = 0; i < c.length; i++) stack.push(c[i]);
		}
	}
	return false;
}

/** Flatten a LineString or MultiLineString into a list of lng/lat paths. */
function linesOf(geom) {
	if (geom.type === "LineString") return [geom.coordinates];
	if (geom.type === "MultiLineString") return geom.coordinates;
	return [];
}

/* Canned trips for config.testMode, so both behaviours can be checked on the
 * mirror without waiting for a real trip to be published. They are built here
 * rather than in the browser so test mode takes the identical payload path as
 * live data - only the source of the stops differs.
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
	// Ground hop: one view, auto-scaled to the ground covered.
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
		this.coast = null;
		this.layers = {};
		console.log("[MMM-WallyMap] Node helper started");
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "WALLY_GET_DATA") this.fetchData(payload);
	},

	/** The atlas never changes, so it is fetched and decoded once per process. */
	getAtlas: async function (atlasUrl) {
		if (this.rings) return;
		var res = await fetch(atlasUrl, { signal: AbortSignal.timeout(15000) });
		if (!res.ok) throw new Error("atlas returned " + res.status);
		var topo = await res.json();
		this.rings = topoToRings(topo, "countries");
		this.coast = topoToRings(topo, "land");
		console.log("[MMM-WallyMap] Atlas decoded: " + this.rings.length +
			" country rings, " + this.coast.length + " land rings");
	},

	/**
	 * One Natural Earth layer, cached on disk so the download happens once on
	 * this machine rather than on every restart - MagicMirror restarts nightly
	 * after the update cron, and these are megabytes.
	 */
	loadLayer: async function (key) {
		if (this.layers[key]) return this.layers[key];

		var file = DETAIL_LAYERS[key];
		var cached = path.join(CACHE_DIR, file);
		try {
			this.layers[key] = JSON.parse(await fs.readFile(cached, "utf8"));
			console.log("[MMM-WallyMap] " + key + ": from cache");
			return this.layers[key];
		} catch (e) { /* not cached yet */ }

		var res = await fetch(NE_BASE + file, { signal: AbortSignal.timeout(60000) });
		if (!res.ok) throw new Error(key + " returned " + res.status);
		var text = await res.text();
		this.layers[key] = JSON.parse(text);
		try {
			await fs.mkdir(CACHE_DIR, { recursive: true });
			await fs.writeFile(cached, text);
			console.log("[MMM-WallyMap] " + key + ": downloaded and cached (" +
				Math.round(text.length / 1048576) + "MB)");
		} catch (e) {
			console.error("[MMM-WallyMap] could not cache " + key + ": " + e.message);
		}
		return this.layers[key];
	},

	/** Cities and rivers inside the box, thinned to what is worth drawing. */
	getDetail: async function (box, minPopulation) {
		var places = [], rivers = [], borders = [];

		try {
			var p = await this.loadLayer("places");
			(p.features || []).forEach(function (f) {
				var pr = f.properties || {};
				var g = f.geometry;
				if (!g || g.type !== "Point") return;
				var lng = g.coordinates[0], lat = g.coordinates[1];
				if (lng < box.w || lng > box.e || lat < box.s || lat > box.n) return;
				if ((pr.pop_max || 0) < minPopulation) return;
				places.push({ name: pr.name, pop: pr.pop_max || 0, lat: lat, lng: lng });
			});
			// Biggest first, so the renderer can cap the count and keep the
			// places that actually orient someone.
			places.sort(function (a, b) { return b.pop - a.pop; });
		} catch (e) {
			console.error("[MMM-WallyMap] places layer:", e.message);
		}

		try {
			var r = await this.loadLayer("rivers");
			(r.features || []).forEach(function (f) {
				if (!f.geometry || !geometryInBox(f.geometry, box)) return;
				linesOf(f.geometry).forEach(function (line) { rivers.push(line); });
			});
		} catch (e) {
			console.error("[MMM-WallyMap] rivers layer:", e.message);
		}

		try {
			var b = await this.loadLayer("borders");
			(b.features || []).forEach(function (f) {
				if (!f.geometry || !geometryInBox(f.geometry, box)) return;
				linesOf(f.geometry).forEach(function (line) { borders.push(line); });
			});
		} catch (e) {
			console.error("[MMM-WallyMap] borders layer:", e.message);
		}

		return { places: places, rivers: rivers, borders: borders };
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
	 * and across countries that do not follow their longitude - deriving the
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

			if (trip.stops.length) await this.getAtlas(config.atlasUrl);

			/* Detail layers are megabytes, so they are only loaded when the view
			 * will actually be local enough to need them - a world view of a
			 * long-haul flight never pays for them. */
			var detail = null;
			var lats = [], lngs = [];
			trip.stops.forEach(function (s) { lats.push(s.lat); lngs.push(s.lng); });
			trip.legs.forEach(function (l) {
				lats.push(l.fromLat, l.toLat);
				lngs.push(l.fromLng, l.toLng);
			});
			if (lats.length) {
				var span = Math.max(
					Math.max.apply(null, lats) - Math.min.apply(null, lats),
					Math.max.apply(null, lngs) - Math.min.apply(null, lngs)
				);
				if (span <= config.detailBelowDeg) {
					var m = Math.max(1, span);
					detail = await this.getDetail({
						w: Math.min.apply(null, lngs) - m,
						e: Math.max.apply(null, lngs) + m,
						s: Math.min.apply(null, lats) - m,
						n: Math.max.apply(null, lats) + m,
					}, config.minPlacePopulation);
				}
			}

			this.sendSocketNotification("WALLY_DATA", {
				travelling: trip.stops.length > 0,
				tripTitle: trip.tripTitle,
				invite: trip.invite,
				stops: trip.stops,
				legs: trip.legs,
				local: local,
				detail: detail,
				rings: trip.stops.length ? this.rings : [],
				coast: trip.stops.length ? this.coast : [],
			});
		} catch (error) {
			console.error("[MMM-WallyMap] Error:", error.message);
			this.sendSocketNotification("WALLY_ERROR", { message: error.message });
		}
	},
});
