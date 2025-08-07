/*
 * Gunbot Quant Strategy: MACD_Cross
 *
 * Summary:
 * A classic trend-following strategy that uses the Moving Average Convergence
 * Divergence (MACD) indicator to identify changes in trend momentum.
 *
 * Logic:
 * --- Entry ---
 * Triggers a BUY when the MACD Line crosses above its Signal Line,
 * suggesting a potential start of an uptrend.
 * --- Exit ---
 * Triggers a SELL when the MACD Line crosses back below the Signal Line,
 * suggesting the uptrend may be ending.
 * --- Stop Loss ---
 * An initial stop loss is placed using the Average True Range (ATR).
 *
 * Configurable Parameters:
 * ------------------------------------------------------------------------------------
 * | Key                       | Default | Description                               |
 * |---------------------------|---------|-------------------------------------------|
 * | GQ_MACD_CROSS_FAST        | 12      | The fast EMA period for MACD.             |
 * | GQ_MACD_CROSS_SLOW        | 26      | The slow EMA period for MACD.             |
 * | GQ_MACD_CROSS_SIGNAL      | 9       | The signal line EMA period.               |
 * | GQ_MACD_CROSS_ATR_PERIOD  | 14      | Period for ATR (stop loss).               |
 * | GQ_MACD_CROSS_ATR_MULT    | 3.0     | Multiplier for ATR stop loss.             |
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
            if (length <= 0) return result;

            const multiplier = 2 / (length + 1);
            let sum = 0;
            let count = 0;
            let emaPrev = null;

            for (let i = 0; i < source.length; i++) {
                const v = source[i];

                if (!Number.isFinite(v)) continue;

                count += 1;
                sum += v;

                if (count < length) {
                    continue;
                }

                if (emaPrev === null) {
                    emaPrev = sum / length;
                } else {
                    emaPrev = (v - emaPrev) * multiplier + emaPrev;
                }

                result[i] = emaPrev;
            }

            return result;
        },
        macd: function (source, fastLen, slowLen, sigLen) {
            const fastEma = this.ema(source, fastLen);
            const slowEma = this.ema(source, slowLen);

            const macdLine = new Array(source.length).fill(NaN);
            for (let i = 0; i < source.length; i++) {
                if (Number.isFinite(fastEma[i]) && Number.isFinite(slowEma[i])) {
                    macdLine[i] = fastEma[i] - slowEma[i];
                }
            }

            const signalLine = this.ema(macdLine, sigLen);
            return {
                macd: macdLine,
                signal: signalLine
            };
        },
        atr: function (high, low, close, length) {
            const result = new Array(high.length).fill(NaN);
            if (high.length < length + 1) return result;

            const tr = [];
            for (let i = 1; i < high.length; i++) {
                const trueRange = Math.max(
                    high[i] - low[i],
                    Math.abs(high[i] - close[i - 1]),
                    Math.abs(low[i] - close[i - 1]),
                );
                tr.push(trueRange);
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
        },
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

        const STRATEGY_NAME = "MACD_Cross";
        const fastPeriod = parseFloat((whatstrat && whatstrat.GQ_MACD_CROSS_FAST) || 12);
        const slowPeriod = parseFloat((whatstrat && whatstrat.GQ_MACD_CROSS_SLOW) || 26);
        const signalPeriod = parseFloat((whatstrat && whatstrat.GQ_MACD_CROSS_SIGNAL) || 9);
        const atrPeriod = parseFloat((whatstrat && whatstrat.GQ_MACD_CROSS_ATR_PERIOD) || 14);
        const atrMultiplier = parseFloat((whatstrat && whatstrat.GQ_MACD_CROSS_ATR_MULT) || 3.0);

        const macdData = indicator_helpers.macd(candlesClose, fastPeriod, slowPeriod, signalPeriod);
        const atrValues = indicator_helpers.atr(candlesHigh, candlesLow, candlesClose, atrPeriod);
        const atr = atrValues[iLast];
        const macdLine = macdData.macd[iLast];
        const signalLine = macdData.signal[iLast];
        const prevMacdLine = macdData.macd[iLast - 1];
        const prevSignalLine = macdData.signal[iLast - 1];

        // ─── GUI Enhancement ───
        const isBullishCross = Number.isFinite(prevMacdLine) && Number.isFinite(prevSignalLine) &&
            Number.isFinite(macdLine) && Number.isFinite(signalLine) &&
            prevMacdLine < prevSignalLine && macdLine > signalLine;
        const isBearishCross = Number.isFinite(macdLine) && Number.isFinite(signalLine) && macdLine < signalLine;
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
            label: 'Bullish Cross',
            value: isBullishCross ? '✔︎' : '✖︎',
            valueColor: isBullishCross ? '#22c55e' : '#ef4444',
            tooltip: `Checks if the MACD line has crossed above the Signal line.\nMACD: ${macdLine.toFixed(4)}\nSignal: ${signalLine.toFixed(4)}`
        });

        // Exit Conditions
        sidebar.push({
            label: 'Bearish Cross',
            value: isBearishCross ? '✔︎' : '✖︎',
            valueColor: isBearishCross ? '#22c55e' : '#ef4444',
            tooltip: `Checks if the MACD line has crossed below the Signal line.\nMACD: ${macdLine.toFixed(4)}\nSignal: ${signalLine.toFixed(4)}`
        }, {
            label: 'Stop Loss',
            value: isStopLossHit ? '✔︎' : '✖︎',
            valueColor: isStopLossHit ? '#22c55e' : '#ef4444',
            tooltip: `Checks if the price has hit the ATR-based stop loss.\nPrice: ${ask.toFixed(4)}\nStop: ${store.stopPrice.toFixed(4)}`
        });

        // Essential Extras
        sidebar.push({
            label: 'MACD / Signal',
            value: `${macdLine.toFixed(4)} / ${signalLine.toFixed(4)}`,
            tooltip: `The current values for the MACD line and Signal line.`
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

        const configLog = `Config: GQ_MACD_CROSS_FAST=${fastPeriod}, GQ_MACD_CROSS_SLOW=${slowPeriod}, GQ_MACD_CROSS_SIGNAL=${signalPeriod}, GQ_MACD_CROSS_ATR_PERIOD=${atrPeriod}, GQ_MACD_CROSS_ATR_MULT=${atrMultiplier}`;
        const indicatorLog = `Indicators: MACD=${Number.isFinite(macdLine) ? macdLine.toFixed(4) : 'N/A'}, Signal=${Number.isFinite(signalLine) ? signalLine.toFixed(4) : 'N/A'}`;

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

            const isBullishCross = Number.isFinite(prevMacdLine) && Number.isFinite(prevSignalLine) &&
                Number.isFinite(macdLine) && Number.isFinite(signalLine) &&
                prevMacdLine < prevSignalLine && macdLine > signalLine;

            const wantToEnter = isBullishCross;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog];

            if (!wantToEnter) {
                logParts.push(`Trigger: SKIP (No bullish MACD cross)`);
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
            store.pendingStopPrice = (Number.isFinite(atr) && stopLossPrice > 0) ? stopLossPrice : ask * 0.95;

            logParts.push(`Trigger: BUY (Bullish MACD Cross), Stop Loss will be set near ${store.pendingStopPrice.toFixed(4)}`);
            console.log(logParts.join(' '));
            await buyMarket(costQuote, exchangeName, pairName);
            store.pendingBuy = {
                time: Date.now()
            };
            return;
        }

        if (store.state === "IN_POSITION") {
            // ─── GUI Enhancement ───
            delete gb.data.pairLedger.customSellTarget;
            if (store.stopPrice > 0) gb.data.pairLedger.customStopTarget = store.stopPrice;
            else delete gb.data.pairLedger.customStopTarget;
            delete gb.data.pairLedger.customDcaTarget;
            // ───────────────────────
            if (!gotBag || !sellEnabled) {
                console.log(`[${STRATEGY_NAME}] SKIP: No bag to sell or sells disabled.`);
                return;
            }

            const isStopLossHit = store.stopPrice > 0 && ask < store.stopPrice;
            const isBearishCross = Number.isFinite(macdLine) && Number.isFinite(signalLine) && macdLine < signalLine;
            const wantToExit = isStopLossHit || isBearishCross;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog, `Position: Entry=${store.entryPrice.toFixed(4)}, Stop=${store.stopPrice.toFixed(4)}`];

            if (!wantToExit) {
                logParts.push(`Trigger: SKIP (No bearish MACD cross AND Ask >= Stop)`);
                console.log(logParts.join(' '));
                return;
            }

            let exitReason = isStopLossHit ?
                `STOP LOSS (Ask ${ask.toFixed(4)} < ${store.stopPrice.toFixed(4)})` :
                `EXIT (Bearish MACD Cross)`;

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
