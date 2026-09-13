var NodeHelper = require("node_helper");
module.exports = NodeHelper.create({
	start: function () { console.log("[MMM-BTCAud] Node helper started"); },
	socketNotificationReceived: function (notification, payload) {
		if (notification === "BTC_GET_DATA") this.fetchData(payload);
	},
	fetchData: async function (config) {
		try {
			var priceRes = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + config.coin + "&vs_currencies=" + config.currency + "&include_24hr_change=true");
			if (!priceRes.ok) throw new Error("price returned " + priceRes.status);
			var priceData = await priceRes.json();
			/* ~8000 calls over a month-long trip, so a rate limit or an error
			 * body is a matter of when. Indexing straight into the response
			 * threw on the missing key, which took the whole poll down. */
			var quote = priceData && priceData[config.coin];
			var price = quote ? Number(quote[config.currency]) : NaN;
			if (!Number.isFinite(price)) throw new Error("no usable price in response");
			var change24h = quote && Number.isFinite(Number(quote[config.currency + "_24h_change"]))
				? Number(quote[config.currency + "_24h_change"])
				: null;
			var chartRes = await fetch("https://api.coingecko.com/api/v3/coins/" + config.coin + "/market_chart?vs_currency=" + config.currency + "&days=" + config.days);
			var chartData = await chartRes.json();
			var change7d = null;
			if (chartData.prices && chartData.prices.length > 1) {
				change7d = ((chartData.prices[chartData.prices.length - 1][1] - chartData.prices[0][1]) / chartData.prices[0][1]) * 100;
			}
			this.sendSocketNotification("BTC_DATA", {
				price: price, change24h: change24h, change7d: change7d, chartData: chartData.prices || [],
			});
		} catch (error) { console.error("[MMM-BTCAud] Error:", error.message); }
	},
});
