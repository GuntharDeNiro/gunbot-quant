/*
 * Gunbot Quant Strategy: Supertrend_Follower
 *
 * Summary:
 * A popular trend-following strategy that uses the Supertrend indicator to
 * determine the current market trend and provide a dynamic stop loss.
 *
 * Logic:
 * --- Entry ---
 * Triggers a BUY when the Supertrend indicator flips from a downtrend
 * (typically shown as red) to an uptrend (green).
 * --- Exit ---
 * The Supertrend line itself acts as a dynamic TRAILING STOP LOSS. The
 * position is exited if the price closes below this trailing stop or if
 * the indicator flips back to a downtrend.
 *
 * Configurable Parameters:
 * ------------------------------------------------------------------------------------
 * | Key                                | Default | Description                               |
 * |------------------------------------|---------|-------------------------------------------|
 * | GQ_SUPERTREND_FOLLOWER_PERIOD      | 10      | The ATR period for Supertrend.            |
 * | GQ_SUPERTREND_FOLLOWER_MULTIPLIER  | 3.0     | The ATR multiplier for Supertrend         |
 * ------------------------------------------------------------------------------------
 *
 * Note on State Management:
 * This strategy uses the 'customStratStore' to manage its state. The 'stopPrice'
 * field is continuously updated with the new Supertrend value, creating a
 * trailing stop loss effect.
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
        atr: function (high, low, close, length) {
            const n = close.length;
            const atr = new Array(n).fill(NaN);
            if (n === 0 || length <= 0) return atr;

            const tr = new Array(n);
            tr[0] = high[0] - low[0];
            for (let i = 1; i < n; i++) {
                const h_l = high[i] - low[i];
                const h_pc = Math.abs(high[i] - close[i - 1]);
                const l_pc = Math.abs(low[i] - close[i - 1]);
                tr[i] = Math.max(h_l, h_pc, l_pc);
            }

            let running = 0;
            for (let i = 0; i < n; i++) {
                running += tr[i];
                if (i === length - 1) {
                    atr[i] = running / length;
                } else if (i > length - 1) {
                    atr[i] = (atr[i - 1] * (length - 1) + tr[i]) / length;
                }
            }
            return atr;
        },
        supertrend: function (high, low, close, period, multiplier) {
            const n = close.length;
            const atr = this.atr(high, low, close, period);

            const fub = new Array(n).fill(NaN);
            const flb = new Array(n).fill(NaN);
            const st = new Array(n).fill(NaN);
            const dir = new Array(n).fill(0);

            for (let i = 0; i < n; i++) {
                if (isNaN(atr[i])) continue;

                const mid = (high[i] + low[i]) / 2;
                const bub = mid + multiplier * atr[i];
                const blb = mid - multiplier * atr[i];

                if (i === 0 || isNaN(fub[i - 1])) {
                    fub[i] = bub;
                } else {
                    fub[i] = (bub < fub[i - 1] || close[i - 1] > fub[i - 1]) ? bub : fub[i - 1];
                }

                if (i === 0 || isNaN(flb[i - 1])) {
                    flb[i] = blb;
                } else {
                    flb[i] = (blb > flb[i - 1] || close[i - 1] < flb[i - 1]) ? blb : flb[i - 1];
                }

                if (i === 0 || isNaN(st[i - 1])) {
                    st[i] = flb[i];
                    dir[i] = close[i] > flb[i] ? 1 : -1;
                } else if (st[i - 1] === fub[i - 1]) {
                    if (close[i] <= fub[i]) {
                        st[i] = fub[i];
                        dir[i] = -1;
                    } else {
                        st[i] = flb[i];
                        dir[i] = 1;
                    }
                } else {
                    if (close[i] >= flb[i]) {
                        st[i] = flb[i];
                        dir[i] = 1;
                    } else {
                        st[i] = fub[i];
                        dir[i] = -1;
                    }
                }
            }
            return {
                trend: st,
                direction: dir
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

        const STRATEGY_NAME = "Supertrend_Follower";
        const stPeriod = parseFloat((whatstrat && whatstrat.GQ_SUPERTREND_FOLLOWER_PERIOD) || 10);
        const stMultiplier = parseFloat((whatstrat && whatstrat.GQ_SUPERTREND_FOLLOWER_MULTIPLIER) || 3.0);

        const stData = indicator_helpers.supertrend(candlesHigh, candlesLow, candlesClose, stPeriod, stMultiplier);

        const stTrend = stData.trend[iLast];
        const stDirection = stData.direction[iLast];
        const prevStDirection = stData.direction[iLast - 1];

        // ─── GUI Enhancement ───
        const isFlipUp = prevStDirection < 0 && stDirection > 0;
        const isFlipDown = stDirection < 0;
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
            label: 'Supertrend Flip Up',
            value: isFlipUp ? '✔︎' : '✖︎',
            valueColor: isFlipUp ? '#22c55e' : '#ef4444',
            tooltip: `Checks if the Supertrend indicator has flipped from bearish to bullish.`
        });

        // Exit Conditions
        sidebar.push({
            label: 'Supertrend Flip Dn',
            value: isFlipDown ? '✔︎' : '✖︎',
            valueColor: isFlipDown ? '#22c55e' : '#ef4444',
            tooltip: `Checks if the Supertrend indicator has flipped from bullish to bearish.`
        }, {
            label: 'Trailing Stop',
            value: isStopLossHit ? '✔︎' : '✖︎',
            valueColor: isStopLossHit ? '#22c55e' : '#ef4444',
            tooltip: `Checks if the price has hit the trailing stop, which is the Supertrend line itself.\nPrice: ${ask.toFixed(4)}\nStop: ${store.stopPrice.toFixed(4)}`
        });

        // Essential Extras
        sidebar.push({
            label: 'ST Direction',
            value: stDirection > 0 ? 'Up' : 'Down',
            valueColor: stDirection > 0 ? '#22c55e' : '#ef4444',
            tooltip: `The current direction of the Supertrend indicator.`
        }, {
            label: 'ST Stop Price',
            value: stTrend ? stTrend.toFixed(gb.data.pricePrecision || 4) : 'N/A',
            tooltip: `The current value of the Supertrend line, which acts as the trailing stop.`
        });

        while (sidebar.length % 3 !== 0) {
            sidebar.push({ label: '', value: '' });
        }
        gb.data.pairLedger.sidebarExtras = sidebar;
        // ───────────────────────

        const configLog = `Config: GQ_SUPERTREND_FOLLOWER_PERIOD=${stPeriod}, GQ_SUPERTREND_FOLLOWER_MULTIPLIER=${stMultiplier}`;
        const indicatorLog = `Indicators: ST_Trend=${isFinite(stTrend) ? stTrend.toFixed(4) : 'N/A'}, ST_Dir=${stDirection}`;

        const tradingLimit = lastSellOrderValue > 0 ? Math.max(lastSellOrderValue, minVolumeToSell * 1.005) : initialCapital

        if (!isFinite(stTrend)) {
            console.log(`[${STRATEGY_NAME}] ${configLog} ${indicatorLog} Waiting for indicator to warm up`);
            return;
        }

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

            const isFlipUp = prevStDirection < 0 && stDirection > 0;
            const wantToEnter = isFlipUp;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog];

            if (!wantToEnter) {
                logParts.push(`Trigger: SKIP (Supertrend did not flip up)`);
                console.log(logParts.join(' '));
                return;
            }

            const costQuote = tradingLimit;
            if (baseBalance < costQuote || costQuote <= 0) {
                logParts.push(`Trigger: SKIP (Insufficient funds: ${baseBalance} < ${costQuote})`);
                console.log(logParts.join(' '));
                return;
            }

            store.pendingStopPrice = stTrend;

            logParts.push(`Trigger: BUY (Supertrend flipped to UP), Trailing Stop set to ${stTrend.toFixed(4)}`);
            console.log(logParts.join(' '));
            await buyMarket(costQuote, exchangeName, pairName);
            store.pendingBuy = {
                time: Date.now()
            };
            return;
        }

        if (store.state === "IN_POSITION") {
            if (stTrend > store.stopPrice) store.stopPrice = stTrend;

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

            const isStopLossHit = ask < store.stopPrice;
            const isFlipDown = stDirection < 0;
            const wantToExit = isStopLossHit || isFlipDown;

            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog,
            `Position: Entry=${store.entryPrice.toFixed(4)}, Stop=${store.stopPrice.toFixed(4)}`
            ];

            if (!wantToExit) {
                logParts.push(`Trigger: SKIP (ST_Dir is UP AND Ask >= Stop)`);
                console.log(logParts.join(' '));
                return;
            }

            const exitReason = isStopLossHit ?
                `TRAILING STOP (Ask ${ask.toFixed(4)} < ${store.stopPrice.toFixed(4)})` :
                `EXIT (Supertrend flipped to DOWN)`;

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
