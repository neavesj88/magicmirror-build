Module.register("MMM-BTCAud", {
	defaults: {
		updateInterval: 5 * 60 * 1000,
		currency: "aud",
		coin: "bitcoin",
		chartDays: 7,
		chartWidth: 400,
		chartHeight: 150,
		showChange: true,
		animationSpeed: 1000,
	},
	getStyles: function () { return ["MMM-BTCAud.css"]; },
	start: function () {
		this.price = null; this.change24h = null; this.change7d = null;
		this.chartData = []; this.loaded = false;
		this.getData();
		setInterval(() => this.getData(), this.config.updateInterval);
	},
	getData: function () {
		this.sendSocketNotification("BTC_GET_DATA", {
			coin: this.config.coin, currency: this.config.currency, days: this.config.chartDays,
		});
	},
	socketNotificationReceived: function (notification, payload) {
		if (notification === "BTC_DATA") {
			this.price = payload.price; this.change24h = payload.change24h;
			this.change7d = payload.change7d; this.chartData = payload.chartData;
			this.loaded = true; this.updateDom(this.config.animationSpeed);
		}
	},
	formatPrice: function (price) {
		return new Intl.NumberFormat("en-AU", {
			style: "currency", currency: "AUD", minimumFractionDigits: 0, maximumFractionDigits: 0,
		}).format(price);
	},
	getGlobalColor: function () {
		var el = document.querySelector(".module.MMM-BTCAud .module-content");
		if (el) return window.getComputedStyle(el).color;
		return "rgba(255,255,255,0.7)";
	},
	getDom: function () {
		var wrapper = document.createElement("div");
		wrapper.className = "btcaud-wrapper";
		if (!this.loaded) {
			wrapper.innerHTML = '<div class="btcaud-loading">Loading BTC...</div>';
			return wrapper;
		}
		var priceDiv = document.createElement("div");
		priceDiv.className = "btcaud-price";
		var icon = document.createElement("span");
		icon.className = "btcaud-icon"; icon.innerHTML = "₿";
		priceDiv.appendChild(icon);
		var amount = document.createElement("span");
		amount.className = "btcaud-amount";
		amount.textContent = this.formatPrice(this.price);
		priceDiv.appendChild(amount);
		wrapper.appendChild(priceDiv);
		if (this.config.showChange) {
			var changeDiv = document.createElement("div");
			changeDiv.className = "btcaud-changes";
			if (typeof this.change24h === "number" && isFinite(this.change24h)) {
				var c24 = document.createElement("span");
				c24.className = "btcaud-change";
				c24.textContent = "24h: " + (this.change24h >= 0 ? "▲" : "▼") + " " + Math.abs(this.change24h).toFixed(1) + "%";
				changeDiv.appendChild(c24);
			}
			if (typeof this.change7d === "number" && isFinite(this.change7d)) {
				var c7 = document.createElement("span");
				c7.className = "btcaud-change";
				c7.textContent = "7d: " + (this.change7d >= 0 ? "▲" : "▼") + " " + Math.abs(this.change7d).toFixed(1) + "%";
				changeDiv.appendChild(c7);
			}
			wrapper.appendChild(changeDiv);
		}
		if (this.chartData.length > 0) {
			var canvas = document.createElement("canvas");
			canvas.width = this.config.chartWidth;
			canvas.height = this.config.chartHeight;
			canvas.className = "btcaud-chart";
			wrapper.appendChild(canvas);
			var self = this;
			setTimeout(function () { self.drawChart(canvas); }, 100);
		}
		return wrapper;
	},
	drawChart: function (canvas) {
		var ctx = canvas.getContext("2d");
		var data = this.chartData;
		var w = canvas.width, h = canvas.height;
		var padding = { top: 10, right: 10, bottom: 25, left: 10 };
		var chartW = w - padding.left - padding.right;
		var chartH = h - padding.top - padding.bottom;
		ctx.clearRect(0, 0, w, h);
		if (data.length < 2) return;
		var globalColor = this.getGlobalColor();
		var rgbMatch = globalColor.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
		var r = 255, g = 255, b = 255;
		if (rgbMatch) { r = parseInt(rgbMatch[1]); g = parseInt(rgbMatch[2]); b = parseInt(rgbMatch[3]); }
		var prices = data.map(function (d) { return d[1]; });
		var times = data.map(function (d) { return d[0]; });
		var minP = Math.min.apply(null, prices);
		var maxP = Math.max.apply(null, prices);
		var range = maxP - minP || 1;
		var getX = function (i) { return padding.left + (i / (data.length - 1)) * chartW; };
		var getY = function (p) { return padding.top + chartH - ((p - minP) / range) * chartH; };
		ctx.beginPath();
		ctx.moveTo(getX(0), getY(prices[0]));
		for (var i = 1; i < data.length; i++) ctx.lineTo(getX(i), getY(prices[i]));
		ctx.lineTo(getX(data.length - 1), padding.top + chartH);
		ctx.lineTo(getX(0), padding.top + chartH);
		ctx.closePath();
		var gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH);
		gradient.addColorStop(0, "rgba(" + r + "," + g + "," + b + ",0.2)");
		gradient.addColorStop(1, "rgba(" + r + "," + g + "," + b + ",0)");
		ctx.fillStyle = gradient; ctx.fill();
		ctx.beginPath();
		ctx.moveTo(getX(0), getY(prices[0]));
		for (var i = 1; i < data.length; i++) ctx.lineTo(getX(i), getY(prices[i]));
		ctx.strokeStyle = "rgb(" + r + "," + g + "," + b + ")";
		ctx.lineWidth = 2; ctx.stroke();
		var lastX = getX(data.length - 1), lastY = getY(prices[prices.length - 1]);
		ctx.beginPath(); ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
		ctx.fillStyle = "rgb(" + r + "," + g + "," + b + ")"; ctx.fill();
		ctx.fillStyle = "rgba(" + r + "," + g + "," + b + ",0.5)";
		ctx.font = "10px sans-serif"; ctx.textAlign = "center";
		var dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
		var step = Math.floor(data.length / 7);
		for (var i = 0; i < 7; i++) {
			var idx = Math.min(i * step, data.length - 1);
			ctx.fillText(dayLabels[new Date(times[idx]).getDay()], getX(idx), h - 5);
		}
	},
});
