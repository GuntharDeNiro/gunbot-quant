/*
 * Gunbot Quant Strategy: Dynamic_Momentum_Optimizer
 *
 * Summary:
 * An advanced, self-optimizing strategy that does not use fixed parameters.
 * It periodically re-optimizes its parameters based on recent market
 * performance to adapt to changing conditions.
 *
 * Logic:
 * --- Optimization ---
 * Every 'REOPTIMIZE_EVERY' candles, the strategy runs a fast internal
 * backtest on the last 'OPTIMIZATION_LOOKBACK' candles. It tests a grid of
 * MA Cross / ATR Stop Loss parameters to find the best-performing sets.
 * --- State Management ---
 * The top-performing parameter sets that meet a 'CONFIDENCE_THRESHOLD' are
 * stored in memory (`store.bestParamsMemory`).
 * --- Entry ---
 * The strategy watches for a bullish MA cross ('Golden Cross') using any of
 * the parameter sets currently in its `bestParamsMemory`.
 * --- Exit ---
 * The exit is triggered by a bearish MA cross ('Death Cross') using the
 * same parameters that triggered the entry.
 * --- Stop Loss ---
 * A stop loss is placed based on the ATR (actually StdDev in this legacy
 * version) and multiplier from the parameter set that triggered the entry.
 * It also includes a trailing stop mechanism.
 *
 * Configurable Parameters (besides INITIAL_CAPITAL and START_TIME, these are NOT configurable in GQ, only listed for advanced users):
 * --------------------------------------------------------------------------------------
 * | Key                                                | Default | Description                                  |
 * |----------------------------------------------------|---------|----------------------------------------------|
 * | INITIAL_CAPITAL                                    | 1000    | Capital for the first trade of this pair.    |
 * | START_TIME                                         | 0       | Unixtime ms to start compounding logic from. |
 * | GQ_DYNAMIC_MOMENTUM_OPTIMIZER_OPTIMIZATION_LOOKBACK  | 500     | How many past candles to use for optimization.|
 * | GQ_DYNAMIC_MOMENTUM_OPTIMIZER_REOPTIMIZE_EVERY     | 168     | How often (in candles) to re-run optimization.|
 * | GQ_DYNAMIC_MOMENTUM_OPTIMIZER_FAST_MA_PERIODS      | [10-76] | Array of fast MA periods to test.            |
 * | GQ_DYNAMIC_MOMENTUM_OPTIMIZER_SLOW_MA_PERIODS      | [90-290]| Array of slow MA periods to test.            |
 * | GQ_DYNAMIC_MOMENTUM_OPTIMIZER_ATR_PERIODS          | [10-55] | Array of ATR/StdDev periods to test.         |
 * | GQ_DYNAMIC_MOMENTUM_OPTIMIZER_ATR_MULTIPLIERS      | [1-5.5] | Array of ATR/StdDev multipliers to test.     |
 * | GQ_DYNAMIC_MOMENTUM_OPTIMIZER_TOP_PARAM_MEMORY     | 25      | How many top-performing parameter sets to keep.|
 * | GQ_DYNAMIC_MOMENTUM_OPTIMIZER_CONFIDENCE_THRESHOLD | 3.0     | Minimum score (profit factor) to be considered.|
 * | GQ_DYNAMIC_MOMENTUM_OPTIMIZER_TRAIL_TRIGGER_MULT   | 1.0     | How many ATRs in profit to start trailing.   |
 * --------------------------------------------------------------------------------------
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

// State specific to this strategy
if (typeof store.lastOptimizationIndex !== "number") store.lastOptimizationIndex = 0;
if (!Array.isArray(store.bestParamsMemory)) store.bestParamsMemory = [];
if (typeof store.entryParams !== "object") store.entryParams = null; // Stores the params used for the current position


// helper to cope with oddball exchange responses like bigints
function sanitizeExchangeResponse(res) {
    const seenObjects = new WeakSet();

    function sanitize(obj) {
        if (typeof obj === "bigint") return obj.toString();
        if (Array.isArray(obj)) return obj.map(sanitize);
        if (obj !== null && typeof obj === "object") {
            if (seenObjects.has(obj)) return "[Circular]";
            seenObjects.add(obj);
            return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, sanitize(v)]));
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
        candlesTimestamp,
        orders,
        openOrders,
    } = gb.data;

    const iLast = candlesClose.length - 1;

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
        }

        if (!holdingBag && !hasOpenBuy && !awaitingBuy) {
            store.state = "IDLE";
            store.entryPrice = 0;
            store.stopPrice = 0;
            store.entryParams = null;
        }

        if (awaitingBuy) {
            const grace = 3 * 60 * 1000;
            if (Date.now() - store.pendingBuy.time > grace && !holdingBag && !hasOpenBuy) {
                console.log("Pending buy expired → reset");
                store.pendingBuy = null;
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

        const STRATEGY_NAME = "Dynamic_Momentum_Optimizer";

        // Optimizer Parameters
        const optimizationLookback = parseInt((whatstrat && whatstrat.GQ_DYNAMIC_MOMENTUM_OPTIMIZER_OPTIMIZATION_LOOKBACK) || 500);
        const reoptimizeEvery = parseInt((whatstrat && whatstrat.GQ_DYNAMIC_MOMENTUM_OPTIMIZER_REOPTIMIZE_EVERY) || 168);
        const fastMaPeriods = ((whatstrat && whatstrat.GQ_DYNAMIC_MOMENTUM_OPTIMIZER_FAST_MA_PERIODS) || "10,14,18,22,26,30,34,38,42,46,50,54,58,62,66,70,74,78").split(',').map(Number);
        const slowMaPeriods = ((whatstrat && whatstrat.GQ_DYNAMIC_MOMENTUM_OPTIMIZER_SLOW_MA_PERIODS) || "90,100,110,120,130,140,150,160,170,180,190,200,210,220,230,240,250,260,270,280,290").split(',').map(Number);
        const atrPeriods = ((whatstrat && whatstrat.GQ_DYNAMIC_MOMENTUM_OPTIMIZER_ATR_PERIODS) || "10,15,20,25,30,35,40,45,50,55").split(',').map(Number);
        const atrMultipliers = ((whatstrat && whatstrat.GQ_DYNAMIC_MOMENTUM_OPTIMIZER_ATR_MULTIPLIERS) || "1.0,1.5,2.0,2.5,3.0,3.5,4.0,4.5,5.0,5.5").split(',').map(Number);
        const topParamMemory = parseInt((whatstrat && whatstrat.GQ_DYNAMIC_MOMENTUM_OPTIMIZER_TOP_PARAM_MEMORY) || 25);
        const confidenceThreshold = parseFloat((whatstrat && whatstrat.GQ_DYNAMIC_MOMENTUM_OPTIMIZER_CONFIDENCE_THRESHOLD) || 3.0);
        const trailTriggerMult = parseFloat((whatstrat && whatstrat.GQ_DYNAMIC_MOMENTUM_OPTIMIZER_TRAIL_TRIGGER_MULT) || 1.0);

        // ─── GUI Enhancement ───
        const sidebar = [];
        const state = store.state === "IDLE" ? "Evaluating" : "In Position";
        const status = gb.data.pairLedger.tradedThisBar ? "Waiting next bar" : state;
        const nextOpt = Math.max(0, reoptimizeEvery - (iLast - store.lastOptimizationIndex));

        sidebar.push({
            label: 'Status',
            value: status,
            valueColor: store.state === "IDLE" ? '#fbbf24' : '#34d399',
            tooltip: 'Reflects the strategy’s current operational state.'
        });

        const activeParams = store.entryParams;
        if (activeParams) {
            const fastMA = indicator_helpers.sma(candlesClose, activeParams.fast);
            const slowMA = indicator_helpers.sma(candlesClose, activeParams.slow);
            const isDeathCross = fastMA[iLast - 1] > slowMA[iLast - 1] && fastMA[iLast] < slowMA[iLast];
            sidebar.push({
                label: `Death Cross (${activeParams.fast}/${activeParams.slow})`,
                value: isDeathCross ? '✔︎' : '✖︎',
                valueColor: isDeathCross ? '#22c55e' : '#ef4444',
                tooltip: `Checks for a bearish cross using the parameters that initiated the current trade.\nFast MA: ${fastMA[iLast].toFixed(4)}\nSlow MA: ${slowMA[iLast].toFixed(4)}`
            });
        } else {
            sidebar.push({
                label: 'Entry Signal',
                value: '✖︎',
                tooltip: 'No entry signal found among the optimized parameter sets.'
            });
        }

        const isStopLossHit = store.state === "IN_POSITION" && store.stopPrice > 0 && ask < store.stopPrice;
        sidebar.push({
            label: 'Stop Loss',
            value: isStopLossHit ? '✔︎' : '✖︎',
            valueColor: isStopLossHit ? '#22c55e' : '#ef4444',
            tooltip: `Checks if price has hit the trailing stop loss.\nPrice: ${ask.toFixed(4)}\nStop: ${store.stopPrice > 0 ? store.stopPrice.toFixed(4) : 'N/A'}`
        });

        sidebar.push({
            label: 'Optimized Sets',
            value: `${store.bestParamsMemory.length} / ${topParamMemory}`,
            tooltip: 'Number of high-confidence parameter sets currently in memory.'
        }, {
            label: 'Next Opt. In',
            value: `${nextOpt} bars`,
            tooltip: `Candles until the next parameter optimization cycle.\nRe-optimizes every ${reoptimizeEvery} bars.`
        }, {
            label: 'Active Stop',
            value: store.stopPrice > 0 ? store.stopPrice.toFixed(gb.data.pricePrecision || 4) : 'N/A',
            tooltip: 'The current trailing stop price for the active position.'
        });

        while (sidebar.length % 3 !== 0) {
            sidebar.push({ label: '', value: '' });
        }
        gb.data.pairLedger.sidebarExtras = sidebar;
        // ───────────────────────

        // --- OPTIMIZATION LOGIC ---
        if (isNewCandleTick && (iLast - store.lastOptimizationIndex >= reoptimizeEvery)) {
            console.log(`[${STRATEGY_NAME}] Re-optimizing parameters...`);

            const paramGrid = [];
            for (const fast of fastMaPeriods) {
                for (const slow of slowMaPeriods) {
                    if (fast >= slow) continue;
                    for (const atrP of atrPeriods) {
                        for (const atrM of atrMultipliers) {
                            paramGrid.push({
                                fast,
                                slow,
                                atrP,
                                atrM
                            });
                        }
                    }
                }
            }

            const indicators = {};
            const allPeriods = [...new Set([...fastMaPeriods, ...slowMaPeriods, ...atrPeriods])];
            for (const p of allPeriods) {
                indicators[`sma_${p}`] = indicator_helpers.sma(candlesClose, p);
                indicators[`stddev_${p}`] = indicator_helpers.stddev(candlesClose, p);
            }

            const start = Math.max(0, iLast - optimizationLookback);
            const scores = [];

            for (const params of paramGrid) {
                const fastMA = indicators[`sma_${params.fast}`];
                const slowMA = indicators[`sma_${params.slow}`];
                const atr = indicators[`stddev_${params.atrP}`];

                let gp = 0,
                    gl = 0,
                    inPos = false,
                    entry = 0;
                for (let i = start + 1; i < iLast; i++) {
                    if (isNaN(fastMA[i]) || isNaN(slowMA[i]) || isNaN(atr[i])) continue;

                    const gold = fastMA[i - 1] < slowMA[i - 1] && fastMA[i] > slowMA[i];
                    const death = fastMA[i - 1] > slowMA[i - 1] && fastMA[i] < slowMA[i];

                    if (!inPos && gold) {
                        inPos = true;
                        entry = candlesClose[i];
                    } else if (inPos && death) {
                        const pnl = (candlesClose[i] - entry) / entry;
                        if (pnl > 0) gp += pnl;
                        else gl -= pnl;
                        inPos = false;
                    }
                }
                const score = gl > 0 ? gp / gl : (gp > 0 ? gp * 1000 : 0);
                if (score > 0) scores.push({
                    params,
                    score
                });
            }

            scores.sort((a, b) => b.score - a.score);
            store.bestParamsMemory = scores.filter(s => s.score >= confidenceThreshold).slice(0, topParamMemory);

            if (store.bestParamsMemory.length === 0 && scores.length > 0) {
                store.bestParamsMemory.push(scores[0]);
            }

            console.log(`[${STRATEGY_NAME}] Optimization complete. Found ${store.bestParamsMemory.length} valid parameter sets.`);
            store.lastOptimizationIndex = iLast;
        }

        const tradingLimit = lastSellOrderValue > 0 ? Math.max(lastSellOrderValue, minVolumeToSell * 1.005) : initialCapital;

        // --- TRADE DECISION LOGIC ---
        if (store.state === "IDLE") {
            // ─── GUI Enhancement ───
            delete gb.data.pairLedger.customSellTarget;
            delete gb.data.pairLedger.customStopTarget;
            delete gb.data.pairLedger.customDcaTarget;
            // ───────────────────────
            if (!isNewCandleTick || store.pendingBuy || !buyEnabled) return;

            let entryParams = null;
            if (store.bestParamsMemory.length > 0) {
                for (const item of store.bestParamsMemory) {
                    const params = item.params;
                    const fastMA = indicator_helpers.sma(candlesClose, params.fast);
                    const slowMA = indicator_helpers.sma(candlesClose, params.slow);
                    if (fastMA[iLast - 1] < slowMA[iLast - 1] && fastMA[iLast] > slowMA[iLast]) {
                        entryParams = params;
                        break;
                    }
                }
            }

            if (stopAfterNextSell && !gotBag) {
                console.log(`[${STRATEGY_NAME}] SKIP: Stop after next sell is active, no further buy orders are allowed.`);
                return;
            }

            if (!entryParams) {
                console.log(`[${STRATEGY_NAME}] SKIP: No valid entry signal from optimized parameters.`);
                return;
            }

            const costQuote = tradingLimit;
            if (baseBalance < costQuote || costQuote <= 0) {
                console.log(`[${STRATEGY_NAME}] SKIP (Insufficient funds: ${baseBalance} < ${costQuote})`);
                return;
            }

            console.log(`[${STRATEGY_NAME}] Trigger: BUY (Golden Cross with params F:${entryParams.fast}/S:${entryParams.slow})`);
            store.entryParams = entryParams; // Save params for this trade
            await buyMarket(costQuote, exchangeName, pairName);
            store.pendingBuy = {
                time: Date.now()
            };
            return;
        }

        if (store.state === "IN_POSITION") {
            if (!gotBag || !sellEnabled || !store.entryParams) return;

            const params = store.entryParams;
            const atr = indicator_helpers.stddev(candlesClose, params.atrP)[iLast];

            // Update trailing stop
            if (atr && (ask - store.entryPrice > atr * params.atrM * trailTriggerMult)) {
                const newStop = ask - (atr * params.atrM);
                if (newStop > store.stopPrice) {
                    store.stopPrice = newStop;
                }
            }

            // ─── GUI Enhancement ───
            delete gb.data.pairLedger.customSellTarget;
            if (store.stopPrice > 0) gb.data.pairLedger.customStopTarget = store.stopPrice;
            else delete gb.data.pairLedger.customStopTarget;
            delete gb.data.pairLedger.customDcaTarget;
            // ───────────────────────

            // Check for exit conditions
            const fastMA = indicator_helpers.sma(candlesClose, params.fast);
            const slowMA = indicator_helpers.sma(candlesClose, params.slow);
            const isDeathCross = fastMA[iLast - 1] > slowMA[iLast - 1] && fastMA[iLast] < slowMA[iLast];
            const isStopLossHit = store.stopPrice > 0 && ask < store.stopPrice;

            const logParts = [`[${STRATEGY_NAME}] Position: Entry=${store.entryPrice.toFixed(4)}, Stop=${store.stopPrice.toFixed(4)}, Params: F:${params.fast}/S:${params.slow}`];

            if (isDeathCross) {
                logParts.push(`Trigger: SELL (Death Cross)`);
                console.log(logParts.join(' '));
                await sellMarket(quoteBalance, exchangeName, pairName);
                return;
            }

            if (isStopLossHit) {
                logParts.push(`Trigger: SELL (STOP LOSS hit at ${store.stopPrice.toFixed(4)})`);
                console.log(logParts.join(' '));
                await sellMarket(quoteBalance, exchangeName, pairName);
                return;
            }

            logParts.push(`Trigger: SKIP (No exit signal)`);
            console.log(logParts.join(' '));
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