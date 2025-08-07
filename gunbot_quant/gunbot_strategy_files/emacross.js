/*
 * Gunbot Quant Strategy: EMACross
 *
 * Summary:
 * A classic trend-following strategy using Exponential Moving Averages (EMAs).
 * It identifies potential trend changes when a short-term EMA crosses a
 * long-term EMA.
 *
 * Logic:
 * --- Entry ---
 * Triggers a BUY when the fast EMA crosses above the slow EMA ('Golden Cross'),
 * indicating potential upward momentum.
 * --- Exit ---
 * Triggers a SELL when the fast EMA crosses back below the slow EMA
 * ('Death Cross'), indicating a potential reversal to a downtrend.
 * --- Stop Loss ---
 * An initial stop loss is placed using the Average True Range (ATR).
 *
 * Configurable Parameters:
 * ------------------------------------------------------------------------------------
 * | Key                       | Default | Description                               |
 * |---------------------------|---------|-------------------------------------------|
 * | GQ_EMACROSS_FAST          | 21      | The fast EMA period.                      |
 * | GQ_EMACROSS_SLOW          | 55      | The slow EMA period.                      |
 * | GQ_EMACROSS_ATR_PERIOD    | 14      | Period for ATR (stop loss).               |
 * | GQ_EMACROSS_ATR_MULT      | 3.0     | Multiplier for ATR stop loss.             |
 * ------------------------------------------------------------------------------------
 *
 * Note on State Management:
 * This strategy uses the 'customStratStore' to manage its state, including
 * the current position status ('IDLE' or 'IN_POSITION') and the calculated
 * stop loss price for the active position.
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
        ema: function (source, length) {
            const result = new Array(source.length).fill(NaN);
            if (source.length < length) return result;
            const multiplier = 2 / (length + 1);
            let sum = 0;
            for (let i = 0; i < length; i++) {
                sum += source[i];
            }
            result[length - 1] = sum / length;
            for (let i = length; i < source.length; i++) {
                result[i] = (source[i] - result[i - 1]) * multiplier + result[i - 1];
            }
            return result;
        },
        atr: function (high, low, close, length) {
            const result = new Array(high.length).fill(NaN);
            if (high.length <= length) return result;
            const tr = [];
            for (let i = 1; i < high.length; i++) {
                tr.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
            }
            let sum_tr = 0;
            for (let i = 0; i < length; i++) {
                sum_tr += tr[i];
            }
            let atr_val = sum_tr / length;
            result[length] = atr_val;
            for (let i = length; i < tr.length; i++) {
                atr_val = (atr_val * (length - 1) + tr[i]) / length;
                result[i + 1] = atr_val;
            }
            return result;
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

        const STRATEGY_NAME = "EMACross";
        const fastPeriod = parseFloat((whatstrat && whatstrat.GQ_EMACROSS_FAST) || 21);
        const slowPeriod = parseFloat((whatstrat && whatstrat.GQ_EMACROSS_SLOW) || 55);
        const atrPeriod = parseFloat((whatstrat && whatstrat.GQ_EMACROSS_ATR_PERIOD) || 14);
        const atrMultiplier = parseFloat((whatstrat && whatstrat.GQ_EMACROSS_ATR_MULT) || 3.0);

        const fastEma = indicator_helpers.ema(candlesClose, fastPeriod);
        const slowEma = indicator_helpers.ema(candlesClose, slowPeriod);
        const atrValues = indicator_helpers.atr(candlesHigh, candlesLow, candlesClose, atrPeriod);

        const currentFast = fastEma[iLast];
        const prevFast = fastEma[iLast - 1];
        const currentSlow = slowEma[iLast];
        const prevSlow = slowEma[iLast - 1];
        const atr = atrValues[iLast];

        // ─── GUI Enhancement ───
        const isGoldenCross = prevFast < prevSlow && currentFast > currentSlow;
        const isDeathCross = currentFast < currentSlow;
        const isStopLossHit = store.state === "IN_POSITION" && store.stopPrice > 0 && ask < store.stopPrice;

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
            label: 'Golden Cross',
            value: isGoldenCross ? '✔︎' : '✖︎',
            valueColor: isGoldenCross ? '#22c55e' : '#ef4444',
            tooltip: `Fast EMA (${fastPeriod}) crosses above Slow EMA (${slowPeriod}).\nFast: ${currentFast.toFixed(4)}\nSlow: ${currentSlow.toFixed(4)}`
        });

        // Exit Conditions
        sidebar.push({
            label: 'Death Cross',
            value: isDeathCross ? '✔︎' : '✖︎',
            valueColor: isDeathCross ? '#22c55e' : '#ef4444',
            tooltip: `Fast EMA (${fastPeriod}) crosses below Slow EMA (${slowPeriod}).\nFast: ${currentFast.toFixed(4)}\nSlow: ${currentSlow.toFixed(4)}`
        }, {
            label: 'Stop Loss',
            value: isStopLossHit ? '✔︎' : '✖︎',
            valueColor: isStopLossHit ? '#22c55e' : '#ef4444',
            tooltip: `Price drops below the calculated ATR-based stop price.\nPrice: ${ask.toFixed(4)}\nStop: ${store.stopPrice.toFixed(4)}`
        });

        // Essential Extras
        sidebar.push({
            label: 'ATR Stop Price',
            value: store.stopPrice > 0 ? store.stopPrice.toFixed(gb.data.pricePrecision || 4) : 'N/A',
            tooltip: `Calculated stop loss level based on ATR (${atrPeriod}) x ${atrMultiplier}.`
        }, {
            label: 'Fast/Slow EMA',
            value: `${currentFast.toFixed(4)} / ${currentSlow.toFixed(4)}`,
            tooltip: `Values of the Fast (${fastPeriod}) and Slow (${slowPeriod}) EMAs.`
        });

        while (sidebar.length % 3 !== 0) {
            sidebar.push({ label: '', value: '' });
        }
        gb.data.pairLedger.sidebarExtras = sidebar;
        // ───────────────────────

        const configLog = `Config: GQ_EMACROSS_FAST=${fastPeriod}, GQ_EMACROSS_SLOW=${slowPeriod}, GQ_EMACROSS_ATR_PERIOD=${atrPeriod}, GQ_EMACROSS_ATR_MULT=${atrMultiplier}`;
        const indicatorLog = `Indicators: FastEMA=${currentFast ? currentFast.toFixed(4) : 'N/A'}, SlowEMA=${currentSlow ? currentSlow.toFixed(4) : 'N/A'}`;

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

            const isGoldenCross = prevFast < prevSlow && currentFast > currentSlow;
            const wantToEnter = isGoldenCross;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog];

            if (!wantToEnter) {
                logParts.push(`Trigger: SKIP (No Golden Cross)`);
                console.log(logParts.join(' '));
                return;
            }

            const costQuote = tradingLimit;
            if (baseBalance < costQuote || costQuote <= 0) {
                logParts.push(`Trigger: SKIP (Insufficient funds: ${baseBalance} < ${costQuote})`);
                console.log(logParts.join(' '));
                return;
            }

            const stopLossPrice = ask - (atr * atrMultiplier);
            store.pendingStopPrice = (atr && stopLossPrice > 0) ? stopLossPrice : ask * 0.95;

            logParts.push(`Trigger: BUY (Golden Cross), Stop Loss will be set near ${store.pendingStopPrice.toFixed(4)}`);
            console.log(logParts.join(' '));
            await buyMarket(costQuote, exchangeName, pairName);
            store.pendingBuy = {
                time: Date.now()
            };
            return;
        }

        if (store.state === "IN_POSITION") {
            // ─── GUI Enhancement ───
            delete gb.data.pairLedger.customSellTarget; // Exit is a dynamic cross, not a fixed price target
            if (store.stopPrice > 0) gb.data.pairLedger.customStopTarget = store.stopPrice;
            else delete gb.data.pairLedger.customStopTarget;
            delete gb.data.pairLedger.customDcaTarget;
            // ───────────────────────
            if (!gotBag || !sellEnabled) {
                console.log(`[${STRATEGY_NAME}] SKIP: No bag to sell or sells disabled.`);
                return;
            }

            const isStopLossHit = store.stopPrice > 0 && ask < store.stopPrice;
            const isDeathCross = currentFast < currentSlow;
            const wantToExit = isStopLossHit || isDeathCross;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog, `Position: Entry=${store.entryPrice.toFixed(4)}, Stop=${store.stopPrice.toFixed(4)}`];

            if (!wantToExit) {
                logParts.push(`Trigger: SKIP (No Death Cross AND Ask >= Stop)`);
                console.log(logParts.join(' '));
                return;
            }

            let exitReason = isStopLossHit ?
                `STOP LOSS (Ask ${ask.toFixed(4)} < ${store.stopPrice.toFixed(4)})` :
                `EXIT (Death Cross)`;

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