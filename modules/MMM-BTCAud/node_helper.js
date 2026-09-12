var NodeHelper = require("node_helper");
module.exports = NodeHelper.create({
	start: function () { console.log("[MMM-BTCAud] Node helper started"); },
	socketNotificationReceived: function (notification, payload) {
		if (notification === "BTC_GET_DATA") this.fetchData(payload);
	},
	fetchData: async function (config) {
		try {
			var priceRes = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=" + config.coin + "&vs_currencies=" + config.currency + "&include_24hr_change=true");
			var priceData = await priceRes.json();
			var price = priceData[config.coin][config.currency];
			var change24h = priceData[config.coin][config.currency + "_24h_change"];
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
