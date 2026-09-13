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

/**
 * Drop points closer together than the drawing can show.
 *
 * The close view renders about 10 degrees across a 400px canvas, so one pixel
 * is roughly 0.025 degrees; anything finer than that cannot be seen. Natural
 * Earth's 10m geometry is far denser than that, and every extra vertex is paid
 * for twice - once serialising the payload each poll, once stroking it - on a
 * Celeron that has better things to do.
 */
function thin(line, tolerance) {
	if (line.length < 3) return line;
	var out = [line[0]];
	var last = line[0];
	for (var i = 1; i < line.length - 1; i++) {
		if (Math.abs(line[i][0] - last[0]) >= tolerance ||
			Math.abs(line[i][1] - last[1]) >= tolerance) {
			out.push(line[i]);
			last = line[i];
		}
	}
	out.push(line[line.length - 1]);
	return out;
}
var THIN_DEG = 0.02;

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
		fromName: PLACES[from].locationName,
		toName: PLACES[to].locationName,
		fromLat: PLACES[from].lat, fromLng: PLACES[from].lng,
		toLat: PLACES[to].lat, toLng: PLACES[to].lng,
	};
}

function stop(key, title, days, chapterId) {
	return Object.assign({
		title: title,
		arrivedAt: daysAgo(days),
		chapterId: chapterId === undefined ? null : String(chapterId),
	}, PLACES[key]);
}

/* Built per request, not once at load. The node helper runs for weeks between
 * restarts, so timestamps frozen at startup would drift: the canned trip would
 * slowly claim "12 days here" the longer the process had been up. */
function buildFixture(name) {
	if (name === "local") {
		// Ground hop: one view, auto-scaled to the ground covered.
		return {
			tripTitle: "Test: Munich to Salzburg",
			invite: DEFAULT_INVITE,
			stops: [stop("munich", "Munich", 3, 1), stop("salzburg", "Salzburg", 0, 1)],
			legs: [leg("train", "munich", "salzburg")],
			chapters: [{ id: "1", title: "Bavaria & the Alps", subtitle: null }],
		};
	}
	if (name === "flight") {
		// Long haul: wide view of the whole journey, alternating with the close one.
		return {
			tripTitle: "Test: Perth to Munich",
			invite: DEFAULT_INVITE,
			stops: [stop("perth", "Home", 5, 1), stop("dubai", "Dubai", 4, 1), stop("munich", "Landed in Munich", 0, 2)],
			legs: [leg("plane", "perth", "dubai"), leg("plane", "dubai", "munich")],
			chapters: [
				{ id: "1", title: "The Long Way Over", subtitle: null },
				{ id: "2", title: "Bavaria & the Alps", subtitle: null },
			],
		};
	}
	return null;
}

var FIXTURES = { local: true, flight: true };

module.exports = NodeHelper.create({
	start: function () {
		this.rings = null;
		this.coast = null;
		this.detailCache = null;
		// Latches once the real feed has produced a stop, so canned preview data
		// can never stand in for a live trip after that point.
		/* Persisted, because the updater restarts MagicMirror nightly: an
		 * in-memory latch would reset every night of the trip, after which one
		 * malformed response could put the fixture back on screen as real. */
		this.liveSeen = false;
		this.liveSeenFile = path.join(CACHE_DIR, "live-seen");
		var self = this;
		fs.readFile(this.liveSeenFile, "utf8")
			.then(function () { self.liveSeen = true; console.log("[MMM-WallyMap] a real trip has been seen before"); })
			.catch(function () { /* never gone live on this machine */ });
		console.log("[MMM-WallyMap] Node helper started");
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "WALLY_GET_DATA") this.fetchData(payload);
	},

	/** Remember across restarts that a real trip has been seen. */
	markLiveSeen: function () {
		if (this.liveSeen) return;
		this.liveSeen = true;
		var file = this.liveSeenFile;
		fs.mkdir(CACHE_DIR, { recursive: true })
			.then(function () { return fs.writeFile(file, new Date().toISOString()); })
			.catch(function (e) { console.error("[MMM-WallyMap] could not persist liveSeen: " + e.message); });
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
		var file = DETAIL_LAYERS[key];
		var cached = path.join(CACHE_DIR, file);
		try {
			return JSON.parse(await fs.readFile(cached, "utf8"));
		} catch (e) {
			// Absent, unreadable, or truncated by a power cut mid-write - either
			// way the fix is the same, fetch it again and overwrite.
		}

		var res = await fetch(NE_BASE + file, { signal: AbortSignal.timeout(60000) });
		if (!res.ok) throw new Error(key + " returned " + res.status);
		var text = await res.text();
		var parsed = JSON.parse(text);
		try {
			await fs.mkdir(CACHE_DIR, { recursive: true });
			await fs.writeFile(cached, text);
			console.log("[MMM-WallyMap] " + key + ": downloaded and cached (" +
				Math.round(text.length / 1048576) + "MB)");
		} catch (e) {
			console.error("[MMM-WallyMap] could not cache " + key + ": " + e.message);
		}
		return parsed;
	},

	/**
	 * Cities, rivers and borders inside the box, thinned to what is worth
	 * drawing.
	 *
	 * Result is cached against the box, and the full layers are deliberately not
	 * retained: parsed, those three files are a few hundred megabytes of object
	 * graph, which is not something to hold for weeks inside the MagicMirror
	 * process on a 4GB box. The box only changes when he reaches a new stop, so
	 * the parse happens about once a day rather than every poll.
	 */
	getDetail: async function (box, minPopulation) {
		var key = [box.w, box.s, box.e, box.n].map(function (v) { return v.toFixed(2); }).join(",") +
			"@" + minPopulation;
		if (this.detailCache && this.detailCache.key === key) return this.detailCache.detail;

		var places = [], rivers = [], borders = [];
		// A layer that failed must not be cached as "no features here" - that
		// would freeze an empty map for this stop until he moved on, with no
		// retry even once the CDN came back.
		var ok = { places: false, rivers: false, borders: false };

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
			ok.places = true;
		} catch (e) {
			console.error("[MMM-WallyMap] places layer:", e.message);
		}

		try {
			var r = await this.loadLayer("rivers");
			(r.features || []).forEach(function (f) {
				if (!f.geometry || !geometryInBox(f.geometry, box)) return;
				linesOf(f.geometry).forEach(function (line) { rivers.push(thin(line, THIN_DEG)); });
			});
			ok.rivers = true;
		} catch (e) {
			console.error("[MMM-WallyMap] rivers layer:", e.message);
		}

		try {
			var b = await this.loadLayer("borders");
			(b.features || []).forEach(function (f) {
				if (!f.geometry || !geometryInBox(f.geometry, box)) return;
				linesOf(f.geometry).forEach(function (line) { borders.push(thin(line, THIN_DEG)); });
			});
			ok.borders = true;
		} catch (e) {
			console.error("[MMM-WallyMap] borders layer:", e.message);
		}

		// The renderer labels only a handful; sending hundreds would be payload
		// for nothing. Biggest first, since the box scales with the view - close
		// in they are the local towns, further out the ones worth naming.
		places = places.slice(0, 40);

		var detail = { places: places, rivers: rivers, borders: borders };
		// Only remember a complete result. A partial one is served this once and
		// retried next poll, so a CDN outage costs detail for 15 minutes rather
		// than for as long as he stays in that city.
		if (ok.places && ok.rivers && ok.borders) {
			this.detailCache = { key: key, detail: detail };
		} else {
			console.error("[MMM-WallyMap] detail incomplete, not caching: " +
				JSON.stringify(ok));
		}
		return detail;
	},

	/** Published stops and legs from the site's travel feed. */
	fetchLive: async function (config) {
		var postsRes = await fetch(config.postsUrl, { signal: AbortSignal.timeout(15000) });
		if (!postsRes.ok) throw new Error("posts returned " + postsRes.status);
		var posts = await postsRes.json();
		/* A non-array body means something answered that was not the feed - a
		 * Cloudflare interstitial or an error object. Treating it as an empty trip
		 * would let test mode conclude there is no trip and put canned data back on
		 * screen over a real one, so it is an error. */
		if (!Array.isArray(posts)) throw new Error("posts response was not a list");

		/* Coordinates are float8 in Postgres and should arrive as numbers, but a
		 * serialiser that hands back "48.14" would otherwise fail Number.isFinite
		 * and silently drop the entire trip. Coerce, then validate. */
		var usable = posts.filter(function (p) {
			if (!p) return false;
			p.lat = Number(p.lat);
			p.lng = Number(p.lng);
			return Number.isFinite(p.lat) && Number.isFinite(p.lng);
		});

		/* Newest last, so the final entry is where he is now - which makes this
		 * sort load-bearing rather than cosmetic. An unparseable arrivedAt makes
		 * the comparator return NaN, which is neither < nor > 0, so the engine
		 * leaves that post wherever the API happened to put it: the wrong stop
		 * then becomes "here", and the map centres, labels and fetches weather
		 * for somewhere he is not. Posts without a usable date are pushed to the
		 * front instead, so they can never masquerade as the latest. */
		var when = function (p) {
			var t = new Date(p.arrivedAt).getTime();
			return Number.isFinite(t) ? t : -Infinity;
		};
		usable.sort(function (a, b) { return when(a) - when(b); });

		var stops = usable.map(function (p) {
			return {
				title: p.title,
				locationName: p.locationName,
				lat: p.lat,
				lng: p.lng,
				arrivedAt: p.arrivedAt,
				// Stringified here and on the chapters below: these are two independently
				// serialised endpoints, and a number-vs-numeric-string mismatch would make
				// the chapter silently never resolve for the whole trip.
				chapterId: (p.chapterId === undefined || p.chapterId === null) ? null : String(p.chapterId),
			};
		});

		// Legs come only from posts that survived validation, otherwise the map
		// draws route lines to stops it refused to plot.
		var legs = [];
		usable.forEach(function (p) {
			(p.legs || [])
				.slice()
				.sort(function (a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0); })
				.forEach(function (l) {
					var c = [Number(l.fromLat), Number(l.fromLng), Number(l.toLat), Number(l.toLng)];
					if (c.every(Number.isFinite)) {
						legs.push({
							mode: l.mode,
							fromName: l.fromName || null,
							toName: l.toName || null,
							fromLat: c[0], fromLng: c[1],
							toLat: c[2], toLng: c[3],
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

		/* Chapters name the sections of a journey ("Bavaria & the Alps"). Like
		 * the trip title they are decoration, so this is its own try and yields
		 * an empty list on any problem rather than costing the map. The trip
		 * endpoint is also the authoritative title; the teaser is the fallback. */
		var chapters = null;   // null = fetch failed; [] = genuinely none
		try {
			var tripRes = await fetch(config.tripUrl, { signal: AbortSignal.timeout(10000) });
			if (tripRes.ok) {
				var tripData = await tripRes.json();
				chapters = [];
				if (Array.isArray(tripData.chapters)) {
					chapters = tripData.chapters.map(function (c) {
						return { id: String(c.id), title: c.title, subtitle: c.subtitle || null };
					});
				}
				if (tripData.trip && tripData.trip.title) tripTitle = tripData.trip.title;
			}
		} catch (e) { /* leave chapters empty */ }

		return { tripTitle: tripTitle, invite: invite, stops: stops, legs: legs, chapters: chapters };
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
			/* Test mode is a preview, not an override. The real feed wins the
			 * moment it has a published stop, so leaving testMode on cannot
			 * strand the mirror showing canned data for a whole trip - nobody
			 * has to remember to turn it off, and it cannot be turned off from
			 * the road anyway. */
			var trip;
			if (config.testMode && FIXTURES[config.testMode] && !this.liveSeen) {
				/* Preview only until the real trip exists. Crucially, a failure
				 * here must NOT quietly substitute canned data: once he is
				 * travelling, a Cloudflare blip would otherwise replace his real
				 * position with a fabricated one, sent as an ordinary successful
				 * update - no error, no stale marker, indistinguishable from the
				 * truth, and flipping back and forth poll by poll. So the fixture
				 * is only ever used while the feed has genuinely never produced a
				 * stop; after that, errors propagate and the front end holds the
				 * last known position instead. */
				var live = await this.fetchLive(config);
				if (live.stops.length) {
					this.markLiveSeen();
					trip = live;
				} else {
					trip = buildFixture(config.testMode);
				}
			} else {
				trip = await this.fetchLive(config);
				if (trip.stops.length) this.markLiveSeen();
			}

			var here = trip.stops[trip.stops.length - 1];

			// Weather and timezone are decoration; losing them must not cost the map.
			var local = null;
			if (here) {
				try { local = await this.fetchLocal(here.lat, here.lng); }
				catch (e) { console.error("[MMM-WallyMap] Local conditions:", e.message); }
			}

			/* An atlas blip must not cost the whole poll. Unguarded, a Cloudflare
			 * hiccup on neaves.au threw away stops, legs and weather that had
			 * already been fetched successfully and turned the update into an
			 * error. Outlines are the decoration; the position is the point. */
			if (trip.stops.length) {
				try { await this.getAtlas(config.atlasUrl); }
				catch (e) { console.error("[MMM-WallyMap] atlas:", e.message); }
			}

			/* Detail is for the close view, which is always around where he is
			 * now, so the box follows the current stop rather than the whole
			 * route. Keyed off the route it vanished as the trip grew: once
			 * stops spanned more than detailBelowDeg - which any multi-country
			 * trip does - no view got detail at all. */
			var detail = null;
			if (here) {
				var m = config.detailBoxDeg / 2;
				detail = await this.getDetail({
					w: here.lng - m,
					e: here.lng + m,
					s: here.lat - m,
					n: here.lat + m,
				}, config.minPlacePopulation);
			}

			this.sendSocketNotification("WALLY_DATA", {
				travelling: trip.stops.length > 0,
				tripTitle: trip.tripTitle,
				invite: trip.invite,
				stops: trip.stops,
				legs: trip.legs,
				chapters: trip.chapters,
				local: local,
				detail: detail,
				/* The atlas is static, so it is sent once and then omitted -
				 * null means "keep what you have". Re-serialising 15,000 points
				 * every poll for weeks is work nobody benefits from. The client
				 * asks for it again after a reload, when it has none. */
				rings: (trip.stops.length && !config.hasAtlas) ? this.rings : null,
				coast: (trip.stops.length && !config.hasAtlas) ? this.coast : null,
			});
		} catch (error) {
			console.error("[MMM-WallyMap] Error:", error.message);
			this.sendSocketNotification("WALLY_ERROR", { message: error.message });
		}
	},
});
