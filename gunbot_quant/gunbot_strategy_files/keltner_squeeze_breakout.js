/*
 * Gunbot Quant Strategy: Keltner_Squeeze_Breakout
 *
 * Summary:
 * A volatility breakout strategy that identifies periods of low volatility
 * (a "squeeze") and buys when the price breaks out with momentum.
 *
 * Logic:
 * A "squeeze" is identified when Bollinger Bands are inside Keltner Channels.
 * --- Entry ---
 * Triggers a BUY if a squeeze was active on the previous candle and the
 * current price breaks out above the upper Bollinger Band.
 * --- Exit ---
 * Triggers a SELL if the price falls back to the middle Bollinger Band (SMA).
 * --- Stop Loss ---
 * The initial stop loss is placed at the lower Bollinger Band at the time
 * of entry.
 *
 * Configurable Parameters:
 * ------------------------------------------------------------------------------------
 * | Key                                 | Default | Description                               |
 * |-------------------------------------|---------|-------------------------------------------|
 * | GQ_KELTNER_SQUEEZE_BREAKOUT_PERIOD  | 20      | Period for BB and KC.                     |
 * | GQ_KELTNER_SQUEEZE_BREAKOUT_BB_STD  | 2.0     | Standard deviation for BB.                |
 * | GQ_KELTNER_SQUEEZE_BREAKOUT_KC_MULT | 1.5     | ATR Multiplier for Keltner Channel.       |
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
        ema: function (source, length) {
            const result = new Array(source.length).fill(NaN);
            if (source.length < length) return result;
            const multiplier = 2 / (length + 1);
            let sum = 0;
            for (let i = 0; i < length; i++) sum += source[i];
            result[length - 1] = sum / length; // SMA for initial value
            for (let i = length; i < source.length; i++) {
                result[i] = (source[i] - result[i - 1]) * multiplier + result[i - 1];
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
        },
        atr: function (high, low, close, length) {
            const result = new Array(high.length).fill(NaN);
            if (high.length <= length) return result;
            const tr = [];
            for (let i = 1; i < high.length; i++) {
                tr.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
            }
            let sum_tr = 0;
            for (let i = 0; i < length; i++) sum_tr += tr[i];
            let atr_val = sum_tr / length;
            result[length] = atr_val;
            for (let i = length; i < tr.length; i++) {
                atr_val = (atr_val * (length - 1) + tr[i]) / length;
                result[i + 1] = atr_val;
            }
            return result;
        },
        keltnerChannels: function (high, low, close, period, mult) {
            const basis = this.ema(close, period);
            const atr = this.atr(high, low, close, period);
            const upper = [],
                lower = [];
            for (let i = 0; i < basis.length; i++) {
                upper.push(basis[i] + (atr[i] * mult));
                lower.push(basis[i] - (atr[i] * mult));
            }
            return {
                upper: upper,
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

        const STRATEGY_NAME = "Keltner_Squeeze_Breakout";
        const period = parseFloat((whatstrat && whatstrat.GQ_KELTNER_SQUEEZE_BREAKOUT_PERIOD) || 20);
        const bbStdDev = parseFloat((whatstrat && whatstrat.GQ_KELTNER_SQUEEZE_BREAKOUT_BB_STD) || 2.0);
        const kcMultiplier = parseFloat((whatstrat && whatstrat.GQ_KELTNER_SQUEEZE_BREAKOUT_KC_MULT) || 1.5);

        const bbands = indicator_helpers.bollingerBands(candlesClose, period, bbStdDev);
        const kcs = indicator_helpers.keltnerChannels(candlesHigh, candlesLow, candlesClose, period, kcMultiplier);

        const inSqueeze = bbands.lower[iLast - 1] > kcs.lower[iLast - 1] && bbands.upper[iLast - 1] < kcs.upper[iLast - 1];
        const breakout = candlesClose[iLast] > bbands.upper[iLast - 1];

        // ─── GUI Enhancement ───
        const wantToEnter = inSqueeze && breakout;
        const isExitSignal = store.state === "IN_POSITION" && ask < bbands.middle[iLast];
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
            label: 'Squeeze Breakout',
            value: wantToEnter ? '✔︎' : '✖︎',
            valueColor: wantToEnter ? '#22c55e' : '#ef4444',
            tooltip: `Checks for a breakout above the upper BB while in a BB/KC squeeze.\nSqueeze: ${inSqueeze}\nBreakout: ${breakout}`
        });

        // Exit Conditions
        sidebar.push({
            label: 'Price < Mid BB',
            value: isExitSignal ? '✔︎' : '✖︎',
            valueColor: isExitSignal ? '#22c55e' : '#ef4444',
            tooltip: `Checks if price has fallen to the middle Bollinger Band.\nPrice: ${ask.toFixed(4)}\nMid BB: ${bbands.middle[iLast].toFixed(4)}`
        }, {
            label: 'Stop Loss',
            value: isStopLossHit ? '✔︎' : '✖︎',
            valueColor: isStopLossHit ? '#22c55e' : '#ef4444',
            tooltip: `Checks if price has hit the initial stop loss (lower BB at entry).\nPrice: ${ask.toFixed(4)}\nStop: ${store.stopPrice.toFixed(4)}`
        });

        // Essential Extras
        sidebar.push({
            label: 'Squeeze Active',
            value: inSqueeze ? '✔︎' : '✖︎',
            valueColor: inSqueeze ? '#22c55e' : '#ef4444',
            tooltip: `Are the Bollinger Bands currently inside the Keltner Channels?`
        }, {
            label: 'Exit Target',
            value: bbands.middle[iLast] ? bbands.middle[iLast].toFixed(gb.data.pricePrecision || 4) : 'N/A',
            tooltip: `The middle Bollinger Band, the primary take-profit target.`
        });

        while (sidebar.length % 3 !== 0) {
            sidebar.push({ label: '', value: '' });
        }
        gb.data.pairLedger.sidebarExtras = sidebar;
        // ───────────────────────

        const configLog = `Config: GQ_KELTNER_SQUEEZE_BREAKOUT_PERIOD=${period}, GQ_KELTNER_SQUEEZE_BREAKOUT_BB_STD=${bbStdDev}, GQ_KELTNER_SQUEEZE_BREAKOUT_KC_MULT=${kcMultiplier}`;
        const indicatorLog = `Indicators: Squeeze=${inSqueeze}, Breakout=${breakout}`;

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

            const wantToEnter = inSqueeze && breakout;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog];

            if (!wantToEnter) {
                logParts.push(`Trigger: SKIP (Squeeze=${inSqueeze}, Breakout=${breakout})`);
                console.log(logParts.join(' '));
                return;
            }

            const costQuote = tradingLimit;
            if (baseBalance < costQuote || costQuote <= 0) {
                logParts.push(`Trigger: SKIP (Insufficient funds: ${baseBalance} < ${costQuote})`);
                console.log(logParts.join(' '));
                return;
            }

            store.pendingStopPrice = bbands.lower[iLast];

            logParts.push(`Trigger: BUY (Squeeze Breakout), Stop Loss will be set near ${store.pendingStopPrice.toFixed(4)}`);
            console.log(logParts.join(' '));
            await buyMarket(costQuote, exchangeName, pairName);
            store.pendingBuy = {
                time: Date.now()
            };
            return;
        }

        if (store.state === "IN_POSITION") {
            // ─── GUI Enhancement ───
            if (bbands.middle[iLast]) gb.data.pairLedger.customSellTarget = bbands.middle[iLast];
            else delete gb.data.pairLedger.customSellTarget;
            if (store.stopPrice > 0) gb.data.pairLedger.customStopTarget = store.stopPrice;
            else delete gb.data.pairLedger.customStopTarget;
            delete gb.data.pairLedger.customDcaTarget;
            // ───────────────────────
            if (!gotBag || !sellEnabled) {
                console.log(`[${STRATEGY_NAME}] SKIP: No bag to sell or sells disabled.`);
                return;
            }

            const isStopLossHit = store.stopPrice > 0 && ask < store.stopPrice;
            const isExitSignal = ask < bbands.middle[iLast];
            const wantToExit = isStopLossHit || isExitSignal;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog, `Position: Entry=${store.entryPrice.toFixed(4)}, Stop=${store.stopPrice.toFixed(4)}`];

            if (!wantToExit) {
                logParts.push(`Trigger: SKIP (Ask ${ask.toFixed(4)} >= MiddleBB ${bbands.middle[iLast].toFixed(4)} AND Ask >= Stop)`);
                console.log(logParts.join(' '));
                return;
            }

            let exitReason = isStopLossHit ?
                `STOP LOSS (Ask ${ask.toFixed(4)} < ${store.stopPrice.toFixed(4)})` :
                `EXIT (Ask fell to MiddleBB ${bbands.middle[iLast].toFixed(4)})`;

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