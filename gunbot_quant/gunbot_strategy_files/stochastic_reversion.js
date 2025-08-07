/*
 * Gunbot Quant Strategy: Stochastic_Reversion
 *
 * Summary:
 * A momentum-based mean-reversion strategy using the Stochastic Oscillator.
 * It buys when momentum is considered oversold and sells when it is
 * overbought.
 *
 * Logic:
 * --- Entry ---
 * Triggers a BUY when the Stochastic Oscillator's %K line crosses down
 * into the 'oversold' zone.
 * --- Exit ---
 * Triggers a SELL when the %K line moves into the 'overbought' zone.
 * --- Stop Loss ---
 * An initial stop loss is placed using the Average True Range (ATR).
 *
 * Configurable Parameters:
 * ------------------------------------------------------------------------------------
 * | Key                                   | Default | Description                               |
 * |---------------------------------------|---------|-------------------------------------------|
 * | GQ_STOCHASTIC_REVERSION_K             | 14      | The period for the %K line.               |
 * | GQ_STOCHASTIC_REVERSION_D             | 3       | The period for the %D line.               |
 * | GQ_STOCHASTIC_REVERSION_SLOWING       | 3       | The slowing period for %K.                |
 * | GQ_STOCHASTIC_REVERSION_OVERSOLD      | 20      | Stochastic level to trigger a buy.        |
 * | GQ_STOCHASTIC_REVERSION_OVERBOUGHT    | 80      | Stochastic level to trigger a sell.       |
 * | GQ_STOCHASTIC_REVERSION_ATR_PERIOD    | 14      | Period for ATR (stop loss).               |
 * | GQ_STOCHASTIC_REVERSION_ATR_MULT      | 2.0     | Multiplier for ATR stop loss.             |
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
            const out = new Array(source.length).fill(NaN);
            if (!Number.isFinite(length) || length <= 0) return out;

            let sum = 0;
            let valid = 0;

            for (let i = 0; i < source.length; i++) {
                const addVal = source[i];
                if (!isNaN(addVal)) {
                    sum += addVal;
                    valid++;
                }
                if (i >= length) {
                    const remVal = source[i - length];
                    if (!isNaN(remVal)) {
                        sum -= remVal;
                        valid--;
                    }
                }
                if (valid === length) {
                    out[i] = sum / length;
                }
            }
            return out;
        },
        stochastic: function (high, low, close, k, d, slowing) {
            const rawK = new Array(close.length).fill(NaN);

            for (let i = k - 1; i < close.length; i++) {
                let highest = -Infinity;
                let lowest = Infinity;
                let bad = false;

                for (let j = i - k + 1; j <= i; j++) {
                    const h = high[j],
                        l = low[j],
                        c = close[j];
                    if (isNaN(h) || isNaN(l) || isNaN(c)) {
                        bad = true;
                        break;
                    }
                    if (h > highest) highest = h;
                    if (l < lowest) lowest = l;
                }
                if (bad) continue;

                const range = highest - lowest;
                rawK[i] = range === 0 ? 0 : 100 * ((close[i] - lowest) / range);
            }

            const smoothedK = this.sma(rawK, slowing);
            const smoothedD = this.sma(smoothedK, d);
            return {
                k: smoothedK,
                d: smoothedD
            };
        },
        atr: function (high, low, close, length) {
            const out = new Array(high.length).fill(NaN);
            if (high.length < length + 1) return out;

            const tr = new Array(high.length).fill(NaN);
            tr[0] = high[0] - low[0];

            for (let i = 1; i < high.length; i++) {
                tr[i] = Math.max(
                    high[i] - low[i],
                    Math.abs(high[i] - close[i - 1]),
                    Math.abs(low[i] - close[i - 1]),
                );
            }

            let sumTR = 0;
            for (let i = 1; i <= length; i++) sumTR += tr[i];
            let atrVal = sumTR / length;
            out[length] = atrVal;

            for (let i = length + 1; i < high.length; i++) {
                atrVal = (atrVal * (length - 1) + tr[i]) / length;
                out[i] = atrVal;
            }
            return out;
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

        const STRATEGY_NAME = "Stochastic_Reversion";
        const kPeriod = parseFloat((whatstrat && whatstrat.GQ_STOCHASTIC_REVERSION_K) || 14);
        const dPeriod = parseFloat((whatstrat && whatstrat.GQ_STOCHASTIC_REVERSION_D) || 3);
        const slowing = parseFloat((whatstrat && whatstrat.GQ_STOCHASTIC_REVERSION_SLOWING) || 3);
        const stochOversold = parseFloat((whatstrat && whatstrat.GQ_STOCHASTIC_REVERSION_OVERSOLD) || 20);
        const stochOverbought = parseFloat((whatstrat && whatstrat.GQ_STOCHASTIC_REVERSION_OVERBOUGHT) || 80);
        const atrPeriod = parseFloat((whatstrat && whatstrat.GQ_STOCHASTIC_REVERSION_ATR_PERIOD) || 14);
        const atrMultiplier = parseFloat((whatstrat && whatstrat.GQ_STOCHASTIC_REVERSION_ATR_MULT) || 2.0);

        const stochData = indicator_helpers.stochastic(candlesHigh, candlesLow, candlesClose, kPeriod, dPeriod, slowing);
        const atrValues = indicator_helpers.atr(candlesHigh, candlesLow, candlesClose, atrPeriod);

        const stochK = stochData.k[iLast];
        const prevStochK = stochData.k[iLast - 1];
        const atr = atrValues[iLast];

        // ─── GUI Enhancement ───
        const isCrossingDown = prevStochK >= stochOversold && stochK < stochOversold;
        const isOverbought = stochK > stochOverbought;
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
            label: `StochK < ${stochOversold}`,
            value: isCrossingDown ? '✔︎' : '✖︎',
            valueColor: isCrossingDown ? '#22c55e' : '#ef4444',
            tooltip: `Checks if the Stochastic %K has crossed down into the 'oversold' zone.\n%K: ${stochK.toFixed(2)}`
        });

        // Exit Conditions
        sidebar.push({
            label: `StochK > ${stochOverbought}`,
            value: isOverbought ? '✔︎' : '✖︎',
            valueColor: isOverbought ? '#22c55e' : '#ef4444',
            tooltip: `Checks if the Stochastic %K has moved into the 'overbought' zone.\n%K: ${stochK.toFixed(2)}`
        }, {
            label: 'Stop Loss',
            value: isStopLossHit ? '✔︎' : '✖︎',
            valueColor: isStopLossHit ? '#22c55e' : '#ef4444',
            tooltip: `Checks if the price has hit the ATR-based stop loss.\nPrice: ${ask.toFixed(4)}\nStop: ${store.stopPrice.toFixed(4)}`
        });

        // Essential Extras
        sidebar.push({
            label: 'Stoch %K Value',
            value: stochK ? stochK.toFixed(2) : 'N/A',
            tooltip: `The current value of the Stochastic %K line.`
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

        const configLog = `Config: GQ_STOCHASTIC_REVERSION_K=${kPeriod}, GQ_STOCHASTIC_REVERSION_D=${dPeriod}, GQ_STOCHASTIC_REVERSION_SLOWING=${slowing}, GQ_STOCHASTIC_REVERSION_OVERSOLD=${stochOversold}, GQ_STOCHASTIC_REVERSION_OVERBOUGHT=${stochOverbought}`;
        const indicatorLog = `Indicators: StochK=${stochK ? stochK.toFixed(2) : 'N/A'}, ATR=${atr ? atr.toFixed(4) : 'N/A'}`;

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

            const isCrossingDown = prevStochK >= stochOversold && stochK < stochOversold;
            const wantToEnter = isCrossingDown;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog];

            if (!wantToEnter) {
                logParts.push(`Trigger: SKIP (StochK ${stochK ? stochK.toFixed(2) : 'N/A'} did not cross down ${stochOversold})`);
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

            logParts.push(`Trigger: BUY (StochK crossed down ${stochOversold}), Stop Loss will be set near ${store.pendingStopPrice.toFixed(4)}`);
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
            const isOverbought = stochK > stochOverbought;
            const wantToExit = isStopLossHit || isOverbought;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog,
            `Position: Entry=${store.entryPrice.toFixed(4)}, Stop=${store.stopPrice.toFixed(4)}`
            ];

            if (!wantToExit) {
                logParts.push(`Trigger: SKIP (StochK ${stochK ? stochK.toFixed(2) : 'N/A'} <= ${stochOverbought} AND Ask >= Stop)`);
                console.log(logParts.join(' '));
                return;
            }

            const exitReason = isStopLossHit ?
                `STOP LOSS (Ask ${ask.toFixed(4)} < ${store.stopPrice.toFixed(4)})` :
                `EXIT (StochK ${stochK ? stochK.toFixed(2) : 'N/A'} > ${stochOverbought})`;

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
