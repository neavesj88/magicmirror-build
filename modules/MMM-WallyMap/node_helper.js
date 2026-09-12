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

	fetchData: async function (config) {
		try {
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

			// Trip title and the invite copy are niceties; a failure here must
			// not blank the map. The copy is whatever he has set for the site's
			// own popup, so the mirror and the website stay in step.
			var tripTitle = null, invite = null;
			try {
				var curRes = await fetch(config.currentUrl, { signal: AbortSignal.timeout(10000) });
				if (curRes.ok) {
					var cur = await curRes.json();
					tripTitle = cur.tripTitle || null;
					invite = cur.body || null;
				}
			} catch (e) { /* leave them null */ }

			var rings = stops.length ? await this.getRings(config.atlasUrl) : [];

			this.sendSocketNotification("WALLY_DATA", {
				travelling: stops.length > 0,
				tripTitle: tripTitle,
				invite: invite,
				stops: stops,
				legs: legs,
				rings: rings,
			});
		} catch (error) {
			console.error("[MMM-WallyMap] Error:", error.message);
			this.sendSocketNotification("WALLY_ERROR", { message: error.message });
		}
	},
});
