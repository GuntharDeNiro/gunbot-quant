/*
 * Gunbot Quant Strategy: RSI_Reversion
 *
 * Summary:
 * A classic mean-reversion strategy. It buys when an asset is considered
 * oversold and sells when it is considered overbought, based on the
 * Relative Strength Index (RSI) indicator.
 *
 * Logic:
 * --- Entry ---
 * Triggers a BUY when the RSI crosses below the 'oversold' level.
 * --- Exit ---
 * Triggers a SELL when the RSI crosses above the 'overbought' level.
 * --- Stop Loss ---
 * A stop loss is placed at a distance from the entry price, calculated
 * using the Average True Range (ATR) indicator.
 *
 * Configurable Parameters:
 * ------------------------------------------------------------------------------------
 * | Key                             | Default | Description                               |
 * |---------------------------------|---------|-------------------------------------------|
 * | GQ_RSI_REVERSION_PERIOD         | 14      | The period for RSI calculation.           |
 * | GQ_RSI_REVERSION_OVERSOLD       | 30      | RSI level to trigger a buy.               |
 * | GQ_RSI_REVERSION_OVERBOUGHT     | 70      | RSI level to trigger a sell.              |
 * | GQ_RSI_REVERSION_ATR_PERIOD     | 14      | The period for ATR (stop loss).           |
 * | GQ_RSI_REVERSION_ATR_MULT       | 2.0     | Multiplier for ATR stop loss.             |
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
                // Handle circular reference
                return "[Circular]";
            }
            seenObjects.add(obj);

            // Sanitize each entry in the object
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
    const whatstrat = gb.data.pairLedger.whatstrat; // object with all relevant strategy settings
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
        rsi: function (source, length) {
            const result = new Array(source.length).fill(NaN);
            if (source.length <= length) return result;

            let avgGain = 0;
            let avgLoss = 0;

            for (let i = 1; i <= length; i++) {
                const change = source[i] - source[i - 1];
                if (change > 0) {
                    avgGain += change;
                } else {
                    avgLoss -= change;
                }
            }
            avgGain /= length;
            avgLoss /= length;

            if (avgLoss === 0) {
                result[length] = 100;
            } else {
                const rs = avgGain / avgLoss;
                result[length] = 100 - (100 / (1 + rs));
            }

            for (let i = length + 1; i < source.length; i++) {
                const change = source[i] - source[i - 1];
                let gain = 0;
                let loss = 0;
                if (change > 0) {
                    gain = change;
                } else {
                    loss = -change;
                }

                avgGain = (avgGain * (length - 1) + gain) / length;
                avgLoss = (avgLoss * (length - 1) + loss) / length;

                if (avgLoss === 0) {
                    result[i] = 100;
                } else {
                    const rs = avgGain / avgLoss;
                    result[i] = 100 - (100 / (1 + rs));
                }
            }
            return result;
        },

        atr: function (high, low, close, length) {
            const result = new Array(high.length).fill(NaN);
            if (high.length <= length) return result;

            const tr = [];
            for (let i = 1; i < high.length; i++) {
                const h = high[i];
                const l = low[i];
                const c1 = close[i - 1];
                tr.push(Math.max(h - l, Math.abs(h - c1), Math.abs(l - c1)));
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
            console.log("Buy not fired because watch mode or buy enabled does not allow it");
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
        const orderQty = amount;
        if (watchMode || !sellEnabled) {
            console.log("Sell not fired because watch mode or sell enabled does not allow it");
            return;
        }
        try {
            const sellResults = await gb.method.sellMarket(orderQty, pair, exchange);
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
     *  CANDLE-EDGE DETECTOR
     * ------------------------------------------------------------------------- */
    const candleOpenTime = candlesTimestamp[iLast]; // ms
    const isNewCandleTick = candleOpenTime !== store.lastCandleOpen;
    if (isNewCandleTick) store.lastCandleOpen = candleOpenTime;

    /* -------------------------------------------------------------------------
     *  RECONCILE STORAGE WITH REALITY
     * ------------------------------------------------------------------------- */
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
     *  ONE-PASS TRADING DECISION
     * ------------------------------------------------------------------------- */
    async function decideTrade() {
        reconcileState();

        // Strategy Parameters
        const STRATEGY_NAME = "RSI_Reversion";
        const rsiPeriod = parseFloat((whatstrat && whatstrat.GQ_RSI_REVERSION_PERIOD) || 14);
        const rsiOversold = parseFloat((whatstrat && whatstrat.GQ_RSI_REVERSION_OVERSOLD) || 30);
        const rsiOverbought = parseFloat((whatstrat && whatstrat.GQ_RSI_REVERSION_OVERBOUGHT) || 70);
        const atrPeriod = parseFloat((whatstrat && whatstrat.GQ_RSI_REVERSION_ATR_PERIOD) || 14);
        const atrMultiplier = parseFloat((whatstrat && whatstrat.GQ_RSI_REVERSION_ATR_MULT) || 2.0);

        // Indicator Calculations
        const rsiValues = indicator_helpers.rsi(candlesClose, rsiPeriod);
        const atrValues = indicator_helpers.atr(candlesHigh, candlesLow, candlesClose, atrPeriod);
        const rsi = rsiValues[iLast];
        const atr = atrValues[iLast];

        // ─── GUI Enhancement ───
        const isOversold = rsi < rsiOversold;
        const isOverbought = rsi > rsiOverbought;
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
            label: `RSI < ${rsiOversold}`,
            value: isOversold ? '✔︎' : '✖︎',
            valueColor: isOversold ? '#22c55e' : '#ef4444',
            tooltip: `Checks if the RSI is in the 'oversold' zone.\nRSI: ${rsi.toFixed(2)}`
        });

        // Exit Conditions
        sidebar.push({
            label: `RSI > ${rsiOverbought}`,
            value: isOverbought ? '✔︎' : '✖︎',
            valueColor: isOverbought ? '#22c55e' : '#ef4444',
            tooltip: `Checks if the RSI is in the 'overbought' zone.\nRSI: ${rsi.toFixed(2)}`
        }, {
            label: 'Stop Loss',
            value: isStopLossHit ? '✔︎' : '✖︎',
            valueColor: isStopLossHit ? '#22c55e' : '#ef4444',
            tooltip: `Checks if the price has hit the ATR-based stop loss.\nPrice: ${ask.toFixed(4)}\nStop: ${store.stopPrice.toFixed(4)}`
        });

        // Essential Extras
        sidebar.push({
            label: 'RSI Value',
            value: rsi ? rsi.toFixed(2) : 'N/A',
            tooltip: `The current Relative Strength Index (RSI) value.`
        }, {
            label: 'ATR Stop Price',
            value: store.stopPrice > 0 ? store.stopPrice.toFixed(gb.data.pricePrecision || 4) : 'N/A',
            tooltip: `Calculated stop loss level based on ATR(${atrPeriod}) x ${atrMultiplier}.`
        });

        while (sidebar.length % 3 !== 0) {
            sidebar.push({ label: '', value: '' });
        }
        gb.data.pairLedger.sidebarExtras = sidebar;
        // ───────────────────────

        const configLog = `Config: GQ_RSI_REVERSION_PERIOD=${rsiPeriod}, GQ_RSI_REVERSION_OVERSOLD=${rsiOversold}, GQ_RSI_REVERSION_OVERBOUGHT=${rsiOverbought}, GQ_RSI_REVERSION_ATR_PERIOD=${atrPeriod}, GQ_RSI_REVERSION_ATR_MULT=${atrMultiplier}`;
        const indicatorLog = `Indicators: RSI=${rsi ? rsi.toFixed(2) : 'N/A'}, ATR=${atr ? atr.toFixed(4) : 'N/A'}`;

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

            const wantToEnter = rsi < rsiOversold;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog];

            if (!wantToEnter) {
                logParts.push(`Trigger: SKIP (RSI ${rsi ? rsi.toFixed(2) : 'N/A'} >= ${rsiOversold})`);
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
            if (atr && stopLossPrice > 0) {
                store.pendingStopPrice = stopLossPrice;
            } else {
                store.pendingStopPrice = ask * 0.95; // Fallback
            }

            logParts.push(`Trigger: BUY (RSI ${rsi.toFixed(2)} < ${rsiOversold}), Stop Loss will be set near ${store.pendingStopPrice.toFixed(4)}`);
            console.log(logParts.join(' '));
            await buyMarket(costQuote, exchangeName, pairName);
            store.pendingBuy = {
                time: Date.now()
            };
            return;
        }

        if (store.state === "IN_POSITION") {
            // ─── GUI Enhancement ───
            delete gb.data.pairLedger.customSellTarget; // Exit is RSI based, not a fixed price target
            if (store.stopPrice > 0) gb.data.pairLedger.customStopTarget = store.stopPrice;
            else delete gb.data.pairLedger.customStopTarget;
            delete gb.data.pairLedger.customDcaTarget;
            // ───────────────────────
            if (!gotBag || !sellEnabled) {
                console.log(`[${STRATEGY_NAME}] SKIP: No bag to sell or sells disabled.`);
                return;
            }

            const isStopLossHit = store.stopPrice > 0 && ask < store.stopPrice;
            const isRsiExit = rsi > rsiOverbought;
            const wantToExit = isStopLossHit || isRsiExit;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog, `Position: Entry=${store.entryPrice.toFixed(4)}, Stop=${store.stopPrice.toFixed(4)}`];

            if (!wantToExit) {
                logParts.push(`Trigger: SKIP (RSI ${rsi ? rsi.toFixed(2) : 'N/A'} <= ${rsiOverbought} AND Ask ${ask.toFixed(4)} >= Stop ${store.stopPrice.toFixed(4)})`);
                console.log(logParts.join(' '));
                return;
            }

            let exitReason = isStopLossHit ?
                `STOP LOSS (Ask ${ask.toFixed(4)} < ${store.stopPrice.toFixed(4)})` :
                `RSI EXIT (RSI ${rsi.toFixed(2)} > ${rsiOverbought})`;

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
     *  DRIVER (only ONE async call per tick)
     * ------------------------------------------------------------------------- */
    await decideTrade();

    return "reached end of strategy code";
} catch (error) {
    !isSanityCheckError && console.log(error);
    return "error while running strategy code";
}