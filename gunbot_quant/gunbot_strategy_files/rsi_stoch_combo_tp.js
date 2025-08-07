/*
 * Gunbot Quant Strategy: RSI_Stoch_Combo_TP
 *
 * Summary:
 * A confirmation-based mean-reversion strategy. It requires both the RSI and
 * Stochastic oscillators to signal oversold conditions simultaneously before
 * entering a trade.
 *
 * Logic:
 * --- Entry ---
 * Triggers a BUY only when both the RSI and the Stochastic %K line are
 * below their respective 'oversold' levels.
 * --- Exit ---
 * This strategy does not use an indicator-based exit signal. Instead, it
 * relies on a fixed Take Profit target and a Stop Loss.
 * --- Stop Loss ---
 * An initial stop loss is placed using the Average True Range (ATR).
 * --- Take Profit ---
 * A take profit target is calculated using a multiplier of the ATR.
 *
 * Configurable Parameters:
 * ------------------------------------------------------------------------------------
 * | Key                                 | Default | Description                               |
 * |-------------------------------------|---------|-------------------------------------------|
 * | GQ_RSI_STOCH_COMBO_TP_RSI_PERIOD    | 14      | The period for the RSI.                   |
 * | GQ_RSI_STOCH_COMBO_TP_K             | 14      | The period for the Stoch %K line.         |
 * | GQ_RSI_STOCH_COMBO_TP_D             | 3       | The period for the Stoch %D line.         |
 * | GQ_RSI_STOCH_COMBO_TP_SLOWING       | 3       | The slowing period for Stoch %K.          |
 * | GQ_RSI_STOCH_COMBO_TP_RSI_LEVEL     | 35      | RSI entry level.                          |
 * | GQ_RSI_STOCH_COMBO_TP_STOCH_LEVEL   | 25      | Stochastic entry level.                   |
 * | GQ_RSI_STOCH_COMBO_TP_ATR_PERIOD    | 14      | Period for ATR (SL/TP).                   |
 * | GQ_RSI_STOCH_COMBO_TP_ATR_MULT      | 2.0     | Multiplier for ATR stop loss.             |
 * | GQ_RSI_STOCH_COMBO_TP_TP_MULT       | 4.0     | Multiplier for ATR take profit.           |
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
if (typeof store.takeProfitPrice !== "number") store.takeProfitPrice = 0;
if (typeof store.pendingStopPrice !== "number") store.pendingStopPrice = 0;
if (typeof store.pendingTakeProfitPrice !== "number") store.pendingTakeProfitPrice = 0;


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
            if (length <= 0 || source.length < length) return result;

            for (let i = length - 1; i < source.length; i++) {
                let sum = 0;
                let hasNaN = false;
                for (let j = i - length + 1; j <= i; j++) {
                    const v = source[j];
                    if (isNaN(v)) {
                        hasNaN = true;
                        break;
                    }
                    sum += v;
                }
                if (!hasNaN) result[i] = sum / length;
            }
            return result;
        },
        rsi: function (source, length) {
            const result = new Array(source.length).fill(NaN);
            if (source.length <= length) return result;

            let gain = 0,
                loss = 0;
            for (let i = 1; i <= length; i++) {
                const diff = source[i] - source[i - 1];
                if (diff >= 0) gain += diff;
                else loss -= diff;
            }
            let avgGain = gain / length;
            let avgLoss = loss / length;
            result[length] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));

            for (let i = length + 1; i < source.length; i++) {
                const diff = source[i] - source[i - 1];
                const up = diff > 0 ? diff : 0;
                const dn = diff < 0 ? -diff : 0;
                avgGain = ((avgGain * (length - 1)) + up) / length;
                avgLoss = ((avgLoss * (length - 1)) + dn) / length;

                result[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
            }
            return result;
        },
        stochastic: function (high, low, close, k, d, slowing) {
            const fastK = new Array(close.length).fill(NaN);

            for (let i = k - 1; i < close.length; i++) {
                let hh = -Infinity,
                    ll = Infinity;
                for (let j = i - k + 1; j <= i; j++) {
                    if (high[j] > hh) hh = high[j];
                    if (low[j] < ll) ll = low[j];
                }
                const range = hh - ll;
                fastK[i] = range === 0 ? 0 : ((close[i] - ll) / range) * 100;
            }

            const slowK = this.sma(fastK, slowing);
            const slowD = this.sma(slowK, d);
            return {
                k: slowK,
                d: slowD
            };
        },
        atr: function (high, low, close, length) {
            const result = new Array(close.length).fill(NaN);
            if (high.length <= length) return result;

            const tr = [];
            for (let i = 0; i < high.length; i++) {
                if (i === 0) {
                    tr.push(high[i] - low[i]);
                    continue;
                }
                tr.push(Math.max(
                    high[i] - low[i],
                    Math.abs(high[i] - close[i - 1]),
                    Math.abs(low[i] - close[i - 1])
                ));
            }

            let sumTR = 0;
            for (let i = 0; i < length; i++) sumTR += tr[i];
            let atr = sumTR / length;
            result[length] = atr;

            for (let i = length + 1; i < tr.length; i++) {
                atr = ((atr * (length - 1)) + tr[i]) / length;
                result[i] = atr;
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
            if (store.pendingTakeProfitPrice > 0) {
                store.takeProfitPrice = store.pendingTakeProfitPrice;
                store.pendingTakeProfitPrice = 0;
            }
        }

        if (!holdingBag && !hasOpenBuy && !awaitingBuy) {
            store.state = "IDLE";
            store.entryPrice = 0;
            store.stopPrice = 0;
            store.takeProfitPrice = 0;
        }

        if (awaitingBuy) {
            const grace = 3 * 60 * 1000;
            if (store.pendingBuy !== null && Date.now() - store.pendingBuy.time > grace && !holdingBag && !hasOpenBuy) {
                console.log("Pending buy expired → reset");
                store.pendingBuy = null;
                store.pendingStopPrice = 0;
                store.pendingTakeProfitPrice = 0;
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

        const STRATEGY_NAME = "RSI_Stoch_Combo_TP";
        const rsiPeriod = parseFloat((whatstrat && whatstrat.GQ_RSI_STOCH_COMBO_TP_RSI_PERIOD) || 14);
        const kPeriod = parseFloat((whatstrat && whatstrat.GQ_RSI_STOCH_COMBO_TP_K) || 14);
        const dPeriod = parseFloat((whatstrat && whatstrat.GQ_RSI_STOCH_COMBO_TP_D) || 3);
        const slowing = parseFloat((whatstrat && whatstrat.GQ_RSI_STOCH_COMBO_TP_SLOWING) || 3);
        const rsiLevel = parseFloat((whatstrat && whatstrat.GQ_RSI_STOCH_COMBO_TP_RSI_LEVEL) || 35);
        const stochLevel = parseFloat((whatstrat && whatstrat.GQ_RSI_STOCH_COMBO_TP_STOCH_LEVEL) || 25);
        const atrPeriod = parseFloat((whatstrat && whatstrat.GQ_RSI_STOCH_COMBO_TP_ATR_PERIOD) || 14);
        const atrMult = parseFloat((whatstrat && whatstrat.GQ_RSI_STOCH_COMBO_TP_ATR_MULT) || 2.0);
        const tpMult = parseFloat((whatstrat && whatstrat.GQ_RSI_STOCH_COMBO_TP_TP_MULT) || 4.0);

        const rsiValues = indicator_helpers.rsi(candlesClose, rsiPeriod);
        const stochData = indicator_helpers.stochastic(candlesHigh, candlesLow, candlesClose, kPeriod, dPeriod, slowing);
        const atrValues = indicator_helpers.atr(candlesHigh, candlesLow, candlesClose, atrPeriod);

        const rsi = rsiValues[iLast];
        const stochK = stochData.k[iLast];
        const atr = atrValues[iLast];

        // ─── GUI Enhancement ───
        const isRsiLow = rsi < rsiLevel;
        const isStochLow = stochK < stochLevel;
        const isTakeProfitHit = store.state === "IN_POSITION" && store.takeProfitPrice > 0 && ask > store.takeProfitPrice;
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
            label: `RSI < ${rsiLevel}`,
            value: isRsiLow ? '✔︎' : '✖︎',
            valueColor: isRsiLow ? '#22c55e' : '#ef4444',
            tooltip: `Checks if RSI is below the oversold level.\nRSI: ${rsi.toFixed(2)}`
        }, {
            label: `StochK < ${stochLevel}`,
            value: isStochLow ? '✔︎' : '✖︎',
            valueColor: isStochLow ? '#22c55e' : '#ef4444',
            tooltip: `Checks if Stochastic %K is below the oversold level.\n%K: ${stochK.toFixed(2)}`
        });

        // Exit Conditions
        sidebar.push({
            label: 'Take Profit',
            value: isTakeProfitHit ? '✔︎' : '✖︎',
            valueColor: isTakeProfitHit ? '#22c55e' : '#ef4444',
            tooltip: `Checks if the price has hit the ATR-based take profit target.\nPrice: ${ask.toFixed(4)}\nTP: ${store.takeProfitPrice.toFixed(4)}`
        }, {
            label: 'Stop Loss',
            value: isStopLossHit ? '✔︎' : '✖︎',
            valueColor: isStopLossHit ? '#22c55e' : '#ef4444',
            tooltip: `Checks if the price has hit the ATR-based stop loss.\nPrice: ${ask.toFixed(4)}\nStop: ${store.stopPrice.toFixed(4)}`
        });

        // Essential Extras
        sidebar.push({
            label: 'TP / SL Price',
            value: `${store.takeProfitPrice > 0 ? store.takeProfitPrice.toFixed(4) : 'N/A'} / ${store.stopPrice > 0 ? store.stopPrice.toFixed(4) : 'N/A'}`,
            tooltip: `The calculated Take Profit and Stop Loss levels for the current position.`
        });

        while (sidebar.length % 3 !== 0) {
            sidebar.push({ label: '', value: '' });
        }
        gb.data.pairLedger.sidebarExtras = sidebar;
        // ───────────────────────

        const configLog = `Config: GQ_RSI_STOCH_COMBO_TP_RSI_LEVEL=${rsiLevel}, GQ_RSI_STOCH_COMBO_TP_STOCH_LEVEL=${stochLevel}, GQ_RSI_STOCH_COMBO_TP_ATR_MULT=${atrMult}, GQ_RSI_STOCH_COMBO_TP_TP_MULT=${tpMult}`;
        const indicatorLog = `Indicators: RSI=${isNaN(rsi) ? 'N/A' : rsi.toFixed(2)}, StochK=${isNaN(stochK) ? 'N/A' : stochK.toFixed(2)}`;

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

            const wantToEnter = rsi < rsiLevel && stochK < stochLevel;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog];

            if (!wantToEnter) {
                logParts.push(`Trigger: SKIP (RSI ${rsi.toFixed(2)}>=${rsiLevel} or StochK ${stochK.toFixed(2)}>=${stochLevel})`);
                console.log(logParts.join(' '));
                return;
            }

            const costQuote = tradingLimit;
            if (baseBalance < costQuote || costQuote <= 0) {
                logParts.push(`Trigger: SKIP (Insufficient funds)`);
                console.log(logParts.join(' '));
                return;
            }

            if (!isNaN(atr)) {
                store.pendingStopPrice = ask - (atr * atrMult);
                store.pendingTakeProfitPrice = ask + (atr * tpMult);
            }

            logParts.push(`Trigger: BUY (RSI & Stoch oversold), SL=${store.pendingStopPrice.toFixed(4)}, TP=${store.pendingTakeProfitPrice.toFixed(4)}`);
            console.log(logParts.join(' '));
            await buyMarket(costQuote, exchangeName, pairName);
            store.pendingBuy = {
                time: Date.now()
            };
            return;
        }

        if (store.state === "IN_POSITION") {
            // ─── GUI Enhancement ───
            if (store.takeProfitPrice > 0) gb.data.pairLedger.customSellTarget = store.takeProfitPrice;
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
            const isTakeProfitHit = store.takeProfitPrice > 0 && ask > store.takeProfitPrice;
            const wantToExit = isStopLossHit || isTakeProfitHit;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog, `Position: Entry=${store.entryPrice.toFixed(4)}, SL=${store.stopPrice.toFixed(4)}, TP=${store.takeProfitPrice.toFixed(4)}`];

            if (!wantToExit) {
                logParts.push(`Trigger: SKIP (Price between SL and TP)`);
                console.log(logParts.join(' '));
                return;
            }

            let exitReason = isStopLossHit ? `STOP LOSS (Ask ${ask.toFixed(4)} < ${store.stopPrice.toFixed(4)})` : `TAKE PROFIT (Ask ${ask.toFixed(4)} > ${store.takeProfitPrice.toFixed(4)})`;

            logParts.push(`Trigger: SELL (${exitReason})`);
            console.log(logParts.join(' '));

            await sellMarket(quoteBalance, exchangeName, pairName);
            store.state = "IDLE";
            store.entryPrice = 0;
            store.stopPrice = 0;
            store.takeProfitPrice = 0;
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
