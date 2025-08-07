/*
 * Gunbot Quant Strategy: Bollinger_Band_Ride
 *
 * Summary:
 * An aggressive trend-riding strategy. It enters when price breaks out of the
 * upper Bollinger Band, signaling strong upward momentum, and holds the
 * position as long as the price remains above the middle band.
 *
 * Logic:
 * --- Entry ---
 * Triggers a BUY when the price crosses above the upper Bollinger Band.
 * --- Exit ---
 * This strategy has no explicit profit-taking signal. It relies entirely on its
 * trailing stop loss for exits.
 * --- Stop Loss ---
 * The initial stop loss is the middle Bollinger Band. This stop is then
 * trailed upwards as the middle band rises, protecting profits.
 *
 * Configurable Parameters:
 * ------------------------------------------------------------------------------------
 * | Key                              | Default | Description                               |
 * |----------------------------------|---------|-------------------------------------------|
 * | GQ_BOLLINGER_BAND_RIDE_PERIOD    | 20      | Period for BB and SMA.                    |
 * | GQ_BOLLINGER_BAND_RIDE_STD_DEV   | 2.0     | Standard deviation for BB.                |
 * ------------------------------------------------------------------------------------
 */


// initialize customStratStore within pairLedger object
gb.data.pairLedger.customStratStore = gb.data.pairLedger.customStratStore || {};

/* -------------------------------------------------------------------------
 *  STATE INITIALISATION
 * ------------------------------------------------------------------------- */
const store = gb.data.pairLedger.customStratStore;

if (typeof store.state !== "string") store.state = "IDLE"; // "IDLE" | "IN_POSITION"
if (typeof store.lastCandleOpen !== "number") store.lastCandleOpen = 0;
if (typeof store.pendingBuy !== "object") store.pendingBuy = null;
if (typeof store.entryPrice !== "number") store.entryPrice = 0;
if (typeof store.stopPrice !== "number") store.stopPrice = 0;
if (typeof store.pendingStopPrice !== "number") store.pendingStopPrice = 0;


// helper to cope with oddball exchange responses like bigints
function sanitizeExchangeResponse(res) {
    const seenObjects = new WeakSet(); // Track already-visited objects

    function sanitize(obj) {
        if (typeof obj === "bigint") {
            return obj.toString();
        } else if (Array.isArray(obj)) {
            return obj.map(sanitize);
        } else if (obj !== null && typeof obj === "object") {
            if (seenObjects.has(obj)) {
                return "[Circular]";
            }
            seenObjects.add(obj);

            return Object.fromEntries(
                Object.entries(obj).map(([key, value]) => [key, sanitize(value)]),
            );
        }
        return obj;
    }

    return sanitize(res);
}

let isSanityCheckError = false;
try {
    // early exits in case data does not look sane
    if (!gb.data.pairLedger || !Array.isArray(gb.data.pairLedger.orders)) {
        console.log("Waiting for order history to populate");
        isSanityCheckError = true;
        throw new Error("error while running strategy code");
    }
    if (!Array.isArray(gb.data.pairLedger.openOrders)) {
        console.log("Waiting for open orders to populate");
        isSanityCheckError = true;
        throw new Error("error while running strategy code");
    }

    // global settings
    const tradingFees = parseFloat(
        (gb.data.config.exchanges[gb.data.exchangeName] && gb.data.config.exchanges[gb.data.exchangeName].TRADING_FEES) || 0.1,
    );
    const watchMode = gb.data.config.WATCH_MODE;

    // strategy settings
    const whatstrat = gb.data.pairLedger.whatstrat;
    const buyEnabled = whatstrat && whatstrat.BUY_ENABLED;
    const sellEnabled = whatstrat && whatstrat.SELL_ENABLED;
    const minVolumeToSell = parseFloat(whatstrat.MIN_VOLUME_TO_SELL);
    const initialCapital = parseFloat(whatstrat.INITIAL_CAPITAL);
    const startTime = parseFloat(whatstrat.START_TIME);
    const stopAfterNextSell = whatstrat.STOP_AFTER_SELL;

    // gunbot core data
    const {
        bid,
        ask,
        pairName,
        exchangeName,
        quoteBalance,
        baseBalance,
        gotBag,
        breakEven,
        candlesOpen,
        candlesHigh,
        candlesLow,
        candlesClose,
        candlesVolume,
        candlesTimestamp,
        orders,
        openOrders,
    } = gb.data;

    const iLast = candlesOpen.length - 1;

    /* -------------------------------------------------------------------------
     *  INDICATOR IMPLEMENTATIONS 
     * ------------------------------------------------------------------------- */
    const indicator_helpers = {
        sma: function (source, length) {
            const result = new Array(source.length).fill(NaN);
            if (source.length < length) return result;
            let sum = 0;
            for (let i = 0; i < length; i++) sum += source[i];
            result[length - 1] = sum / length;
            for (let i = length; i < source.length; i++) {
                sum = sum - source[i - length] + source[i];
                result[i] = sum / length;
            }
            return result;
        },
        stddev: function (source, length) {
            const result = new Array(source.length).fill(NaN);
            if (source.length < length) return result;
            for (let i = length - 1; i < source.length; i++) {
                const slice = source.slice(i - length + 1, i + 1);
                const mean = slice.reduce((a, b) => a + b, 0) / length;
                const variance = slice.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / length;
                result[i] = Math.sqrt(variance);
            }
            return result;
        },
        bollingerBands: function (source, length, mult) {
            const basis = this.sma(source, length);
            const dev = this.stddev(source, length);
            const upper = [],
                lower = [];
            for (let i = 0; i < basis.length; i++) {
                upper.push(basis[i] + mult * dev[i]);
                lower.push(basis[i] - mult * dev[i]);
            }
            return {
                upper: upper,
                middle: basis,
                lower: lower
            };
        }
    };

    // handlers for order placement
    const buyMarket = async function (amount, exchange, pair) {
        const orderQty = amount / gb.data.pairLedger.Ask;
        if (watchMode || !buyEnabled) {
            console.log("Buy not fired: watch mode or buy enabled off");
            return;
        }
        try {
            const buyResults = await gb.method.buyMarket(orderQty, pair, exchange);
            console.log(sanitizeExchangeResponse(buyResults));
        } catch (e) {
            console.log("\r\n", e);
        }
    };

    const sellMarket = async function (amount, exchange, pair) {
        if (watchMode || !sellEnabled) {
            console.log("Sell not fired: watch mode or sell enabled off");
            return;
        }
        try {
            const sellResults = await gb.method.sellMarket(amount, pair, exchange);
            console.log(sanitizeExchangeResponse(sellResults));
            // ─── GUI Enhancement ───
            delete gb.data.pairLedger.customSellTarget;
            delete gb.data.pairLedger.customStopTarget;
            delete gb.data.pairLedger.customDcaTarget;
            // ───────────────────────
        } catch (e) {
            console.log("\r\n", e);
        }
    };

    /* -------------------------------------------------------------------------
     *  CANDLE-EDGE DETECTOR & STATE RECONCILIATION
     * ------------------------------------------------------------------------- */
    const candleOpenTime = candlesTimestamp[iLast];
    const isNewCandleTick = candleOpenTime !== store.lastCandleOpen;
    if (isNewCandleTick) store.lastCandleOpen = candleOpenTime;

    function reconcileState() {
        const hasOpenBuy = openOrders.some(o => o.type === "buy");
        const holdingBag = gotBag;
        const awaitingBuy = store.pendingBuy !== null;

        if (holdingBag) {
            store.state = "IN_POSITION";
            store.pendingBuy = null;
            if (!store.entryPrice) store.entryPrice = breakEven || ask;
            if (store.pendingStopPrice > 0) {
                store.stopPrice = store.pendingStopPrice;
                store.pendingStopPrice = 0;
            }
        }

        if (!holdingBag && !hasOpenBuy && !awaitingBuy) {
            store.state = "IDLE";
            store.entryPrice = 0;
            store.stopPrice = 0;
            store.pendingStopPrice = 0;
        }

        if (awaitingBuy) {
            const grace = 3 * 60 * 1000;
            if (store.pendingBuy !== null && Date.now() - store.pendingBuy.time > grace && !holdingBag && !hasOpenBuy) {
                console.log("Pending buy expired → reset");
                store.pendingBuy = null;
                store.pendingStopPrice = 0;
            }
        }
    }

    /* -------------------------------------------------------------------------
     *  COMPOUNDING
     * ------------------------------------------------------------------------- */
    const lastOrder = orders?.[0];
    const lastOrderTime = lastOrder && lastOrder.time != null ? lastOrder.time : 0;
    const lastOrderType = lastOrder && lastOrder.type != null ? lastOrder.type : 'none'; // either 'buy' or 'sell' when there a lastOrders
    let lastSellOrderValue = 0

    if (lastOrderType === 'sell' && lastOrderTime > startTime) {
        lastSellOrderValue = orders
            .filter(o => o.type === 'sell' && o.time === lastOrderTime)
            .reduce((total, o) => total + o.rate * o.amount, 0)
    }


    /* -------------------------------------------------------------------------
     *  TRADING DECISION
     * ------------------------------------------------------------------------- */
    async function decideTrade() {
        reconcileState();

        const STRATEGY_NAME = "Bollinger_Band_Ride";
        const period = parseFloat((whatstrat && whatstrat.GQ_BOLLINGER_BAND_RIDE_PERIOD) || 20);
        const stdDev = parseFloat((whatstrat && whatstrat.GQ_BOLLINGER_BAND_RIDE_STD_DEV) || 2.0);

        const bbands = indicator_helpers.bollingerBands(candlesClose, period, stdDev);
        const upperBand = bbands.upper[iLast];
        const prevUpperBand = bbands.upper[iLast - 1];
        const middleBand = bbands.middle[iLast];

        // ─── GUI Enhancement ───
        const isBreakout = candlesClose[iLast - 1] < prevUpperBand && candlesClose[iLast] > upperBand;
        const isStopLossHit = store.state === "IN_POSITION" && ask < store.stopPrice;

        const sidebar = [];
        const state = store.state === "IDLE" ? "Evaluating" : "In Position";
        const status = gb.data.pairLedger.tradedThisBar ? "Waiting next bar" : state;
        sidebar.push({
            label: 'Status',
            value: status,
            valueColor: store.state === "IDLE" ? '#fbbf24' : '#34d399',
            tooltip: 'Reflects the strategy’s current operational state.'
        });

        // Entry Conditions
        sidebar.push({
            label: 'Price > Upper BB',
            value: isBreakout ? '✔︎' : '✖︎',
            valueColor: isBreakout ? '#22c55e' : '#ef4444',
            tooltip: `Checks if the price has broken out above the upper Bollinger Band.\nPrice: ${candlesClose[iLast].toFixed(4)}\nUpper BB: ${upperBand.toFixed(4)}`
        });

        // Exit Conditions
        sidebar.push({
            label: 'Trailing Stop',
            value: isStopLossHit ? '✔︎' : '✖︎',
            valueColor: isStopLossHit ? '#22c55e' : '#ef4444',
            tooltip: `Price drops below the trailing stop loss (the middle BB).\nPrice: ${ask.toFixed(4)}\nStop: ${store.stopPrice.toFixed(4)}`
        });

        // Essential Extras
        sidebar.push({
            label: 'Breakout Level',
            value: upperBand ? upperBand.toFixed(gb.data.pricePrecision || 4) : 'N/A',
            tooltip: `The upper Bollinger Band, which price must cross to trigger an entry.`
        }, {
            label: 'Stop Price',
            value: store.stopPrice > 0 ? store.stopPrice.toFixed(gb.data.pricePrecision || 4) : 'N/A',
            tooltip: `The current trailing stop loss price, which is the middle Bollinger Band.`
        });

        while (sidebar.length % 3 !== 0) {
            sidebar.push({ label: '', value: '' });
        }
        gb.data.pairLedger.sidebarExtras = sidebar;
        // ───────────────────────

        const configLog = `Config: GQ_BOLLINGER_BAND_RIDE_PERIOD=${period}, GQ_BOLLINGER_BAND_RIDE_STD_DEV=${stdDev}`;
        const indicatorLog = `Indicators: UpperBB=${upperBand ? upperBand.toFixed(4) : 'N/A'}, MidBB=${middleBand ? middleBand.toFixed(4) : 'N/A'}`;

        const tradingLimit = lastSellOrderValue > 0 ? Math.max(lastSellOrderValue, minVolumeToSell * 1.005) : initialCapital

        if (store.state === "IDLE") {
            // ─── GUI Enhancement ───
            delete gb.data.pairLedger.customSellTarget;
            delete gb.data.pairLedger.customStopTarget;
            delete gb.data.pairLedger.customDcaTarget;
            // ───────────────────────
            if (!isNewCandleTick || store.pendingBuy || !buyEnabled) {
                console.log(`[${STRATEGY_NAME}] SKIP: Not a new candle, pending buy, or buys disabled.`);
                return;
            }
            if (stopAfterNextSell && !gotBag) {
                console.log(`[${STRATEGY_NAME}] SKIP: Stop after next sell is active, no further buy orders are allowed.`);
                return;
            }

            const isBreakout = candlesClose[iLast - 1] < prevUpperBand && candlesClose[iLast] > upperBand;
            const wantToEnter = isBreakout;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog];

            if (!wantToEnter) {
                logParts.push(`Trigger: SKIP (Price did not break out above UpperBB)`);
                console.log(logParts.join(' '));
                return;
            }

            const costQuote = tradingLimit;
            if (baseBalance < costQuote || costQuote <= 0) {
                logParts.push(`Trigger: SKIP (Insufficient funds)`);
                console.log(logParts.join(' '));
                return;
            }

            // Stop loss is the middle band.
            store.pendingStopPrice = middleBand;

            logParts.push(`Trigger: BUY (Breakout above UpperBB), Trailing Stop will be set to ${store.pendingStopPrice.toFixed(4)}`);
            console.log(logParts.join(' '));
            await buyMarket(costQuote, exchangeName, pairName);
            store.pendingBuy = {
                time: Date.now()
            };
            return;
        }

        if (store.state === "IN_POSITION") {
            // Trailing stop logic: The middle band is the new stop.
            const newTrailStop = middleBand;
            if (newTrailStop > store.stopPrice) {
                store.stopPrice = newTrailStop;
            }

            // ─── GUI Enhancement ───
            delete gb.data.pairLedger.customSellTarget; // No explicit sell target
            if (store.stopPrice > 0) gb.data.pairLedger.customStopTarget = store.stopPrice;
            else delete gb.data.pairLedger.customStopTarget;
            delete gb.data.pairLedger.customDcaTarget;
            // ───────────────────────

            if (!gotBag || !sellEnabled) {
                console.log(`[${STRATEGY_NAME}] SKIP: No bag to sell or sells disabled.`);
                return;
            }

            const isStopLossHit = ask < store.stopPrice;
            const wantToExit = isStopLossHit;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog, `Position: Entry=${store.entryPrice.toFixed(4)}, Stop=${store.stopPrice.toFixed(4)}`];

            if (!wantToExit) {
                logParts.push(`Trigger: SKIP (Ask ${ask.toFixed(4)} >= Trailing Stop ${store.stopPrice.toFixed(4)})`);
                console.log(logParts.join(' '));
                return;
            }

            let exitReason = `TRAILING STOP (Ask ${ask.toFixed(4)} < MiddleBB ${store.stopPrice.toFixed(4)})`;

            logParts.push(`Trigger: SELL (${exitReason})`);
            console.log(logParts.join(' '));

            await sellMarket(quoteBalance, exchangeName, pairName);
            store.state = "IDLE";
            store.entryPrice = 0;
            store.stopPrice = 0;
            return;
        }
    }

    /* -------------------------------------------------------------------------
     *  DRIVER
     * ------------------------------------------------------------------------- */
    await decideTrade();

    return "reached end of strategy code";
} catch (error) {
    !isSanityCheckError && console.log(error);
    return "error while running strategy code";
}