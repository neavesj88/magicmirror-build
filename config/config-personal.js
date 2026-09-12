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
				// Previewing the long-haul behaviour on canned Perth/Dubai/Munich
				// data. Set to false once the real trip has a published stop.
				testMode: "flight",
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
			module: "newsfeed",
			position: "bottom_bar",
			config: {
				feeds: [
					{ title: "ABC News", url: "https://www.abc.net.au/news/feed/51120/rss.xml" },
					{ title: "SBS News", url: "https://www.sbs.com.au/news/feed" },
					{ title: "The Guardian AU", url: "https://www.theguardian.com/au/rss" },
					{ title: "9News", url: "https://www.9news.com.au/rss" },
				],
				showSourceTitle: true,
				showPublishDate: true,
				broadcastNewsFeeds: true,
				broadcastNewsUpdates: true,
				updateInterval: 30000,
				reloadInterval: 300000,
			}
		},
	]
};
if (typeof module !== "undefined") { module.exports = config; }
