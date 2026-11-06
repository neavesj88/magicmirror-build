let config = {
	address: "0.0.0.0",
	port: 8080,
	basePath: "/",
	ipWhitelist: [],
	useHttps: false,
	language: "en",
	locale: "en-AU",
	logLevel: ["INFO", "LOG", "WARN", "ERROR"],
	timeFormat: 24,
	units: "metric",
	modules: [
		{ module: "alert" },
		{
			module: "MMM-Remote-Control",
			config: {
				showModuleApiMenu: true,
				secureEndpoints: false,
			}
		},
		{ module: "updatenotification", position: "top_bar" },
		{ module: "clock", position: "top_left" },
		{
			module: "calendar",
			header: "WA Public Holidays",
			position: "top_left",
			config: {
				maximumEntries: 10,
				calendars: [
					{
						fetchInterval: 7 * 24 * 60 * 60 * 1000,
						symbol: "calendar-check",
						url: "https://www.officeholidays.com/ics-all/australia/western-australia"
					},
					// Google Calendar: uncomment and paste your secret iCal URL
					// { symbol: "calendar", url: "YOUR_GOOGLE_CALENDAR_ICAL_URL" },
				]
			}
		},
		{
			module: "weather",
			position: "top_right",
			header: "Perth",
			config: {
				weatherProvider: "openmeteo",
				type: "current",
				lat: -31.9985,
				lon: 115.7654,
				showWindDirection: true,
				showHumidity: "wind",
				showFeelsLike: true,
			}
		},
		{
			module: "weather",
			position: "top_right",
			header: "Forecast",
			config: {
				weatherProvider: "openmeteo",
				type: "forecast",
				lat: -31.9985,
				lon: 115.7654,
				maxNumberOfDays: 5,
				colored: true,
			}
		},
		{
			// Hides itself when there is no published trip, so this slot falls
			// through to the Bitcoin price below whenever he is home.
			module: "MMM-WallyMap",
			position: "middle_center",
			config: {
				updateInterval: 15 * 60 * 1000,
				// Preview is off. The map now follows the real feed: it stays
				// hidden until a trip is made current and a stop is published,
				// and the Bitcoin price holds the slot until then.
				testMode: false,
			}
		},
		{
			module: "MMM-BTCAud",
			position: "middle_center",
			config: {
				updateInterval: 5 * 60 * 1000,
				chartWidth: 400,
				chartHeight: 150,
			}
		},
		{
			/* Our own ticker, in place of the stock newsfeed module.
			 *
			 * The stock one polls every five minutes and sends no cache
			 * validator, so it re-downloaded every feed in full 288 times a
			 * day - about 33MB, most of it the Guardian's 114-item feed. This
			 * fetches four-hourly and revalidates, which comes to about
			 * 0.25MB a day across more sources than the old list had.
			 *
			 * animation: "roll" | "fade" | "marquee" | "wipe". Roll is the
			 * departures-board lift; marquee is the continuous crawl, whose
			 * speed is set in pixels per second by marqueeSpeed (223).
			 *
			 * Feed order sets the interleave, and decides which source is
			 * credited when two carry the same story - ABC News and ABC
			 * Business share their lead most days.
			 *
			 * weight is slots in the rotation. The wire is weighted far above
			 * everything else, and freshWeight lifts it further for the first
			 * freshHours after a new report lands, so the day's brief takes
			 * over the bar and then settles back. */
			module: "MMM-Newswire",
			position: "bottom_bar",
			config: {
				animation: "roll",
				feeds: [
					/* S2 Underground's The Wire. type: "s2bluf" is what makes
					 * this worth having: the feed itself carries only dated
					 * video titles, so the module follows each report's link
					 * and lifts the //BLUF: ... // block off the page. See the
					 * module README - it is the one feed here that depends on
					 * someone else's page layout. */
					{
						title: "S2 Wire",
						url: "https://s2underground.com/feed",
						type: "s2bluf",
						maxReports: 3,
						maxItems: 9,
						weight: 4,
						freshWeight: 7,
						freshHours: 30,
						/* Longer than the 48h default on purpose: The Wire is a
						 * daily series, and three reports span three days, so
						 * the default would quietly drop the oldest one. For
						 * today's brief only, set maxReports to 1 rather than
						 * cutting this. */
						maxItemAgeHours: 96,
					},
					{ title: "ABC News", url: "https://www.abc.net.au/news/feed/51120/rss.xml", maxItems: 6 },
					{ title: "SBS News", url: "https://www.sbs.com.au/news/feed", maxItems: 6 },
					{ title: "ABC Business", url: "https://www.abc.net.au/news/feed/51892/rss.xml", maxItems: 5 },
					{ title: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", maxItems: 5 },
					{ title: "Investing.com", url: "https://www.investing.com/rss/news_285.rss", maxItems: 4 },
					{ title: "RBA", url: "https://www.rba.gov.au/rss/rss-cb-media-releases.xml", maxItems: 2 },
					{ title: "Hacker News", url: "https://news.ycombinator.com/rss", maxItems: 6 },
					// Neither neaves.au feed belongs here. The travel posts are the
					// map's job - MMM-WallyMap already shows the trip, chapter, post
					// title and both endpoints - and the blog has its own place on
					// the site. This bar is news only.
					//
					// Measured and working, left off only to keep the rotation
					// short - uncomment to add them:
					// { title: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index", maxItems: 4 },
					// { title: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", maxItems: 3 },
					//
					// Avoid: theregister.com is 318KB a fetch, and hnrss.org
					// answers 502 often enough not to rely on it. The feed
					// above is Hacker News' own and stays up.
				],
			}
		},
	]
};
if (typeof module !== "undefined") { module.exports = config; }
