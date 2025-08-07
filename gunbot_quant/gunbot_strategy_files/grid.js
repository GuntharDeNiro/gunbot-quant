/*
 * Gunbot Quant Strategy: Grid_Strategy (Multi-Pair Compounding Final Version)
 *
 * Summary:
 * A market-neutral floating grid strategy designed for multi-pair use with
 * independent, per-pair compounding. It places a series of buy and sell limit
 * orders to profit from volatility.
 *
 * --- Initialization ---
 * On its first run, the strategy establishes the current price as its "anchor".
 * It records its `INITIAL_CAPITAL` in its private store. It then places an
 * initial grid of ONLY BUY limit orders below the anchor price.
 *
 * --- Compounding Mechanism (Multi-Pair Safe) ---
 * The strategy tracks its own "virtual capital" within its persistent store.
 * This virtual capital starts at `INITIAL_CAPITAL`. Each time a sell order
 * (a profitable grid step) is filled, the realized profit is added to this
 * virtual capital. The size of all new grid orders (`gridStepValue`) is
 * calculated based on this isolated, per-pair virtual capital (`store.virtualCapital / maxGrids`).
 * This ensures each pair's trading size compounds based on its own performance,
 * without being affected by the shared global base balance or other pairs.
 *
 * --- Order Management ---
 * - When a BUY order fills: It places a new SELL limit order one grid level above.
 * - When a SELL order fills: It places a new BUY limit order one grid level below.
 * - The grid "floats" by adding a new order at the edge of the grid range
 *   whenever a pair of buy/sell orders is completed.
 *
 * Configurable Parameters:
 * --------------------------------------------------------------------------------------
 * | Key                         | Default | Description                                  |
 * |-----------------------------|---------|----------------------------------------------|
 * | INITIAL_CAPITAL             | 1000    | Capital allocated to this pair's grid.       |
 * | GQ_GRID_MAX_GRIDS           | 20      | Total number of active buy/sell limit orders.|
 * | GQ_GRID_GRID_SPACING_PCT    | 1.0     | Spacing between grid levels as a percentage. |
 * --------------------------------------------------------------------------------------
 */


// initialize customStratStore within pairLedger object
gb.data.pairLedger.customStratStore = gb.data.pairLedger.customStratStore || {};

/* -------------------------------------------------------------------------
 *  STATE INITIALISATION
 * ------------------------------------------------------------------------- */
const store = gb.data.pairLedger.customStratStore;

if (typeof store.isInitialized !== "boolean") store.isInitialized = false;
if (typeof store.lastOrderCheckTime !== "number") store.lastOrderCheckTime = 0;
// Virtual capital for isolated, per-pair compounding
if (typeof store.virtualCapital !== "number") store.virtualCapital = 0;
// Intended grid state (source of truth)
if (typeof store.gridBuyOrders !== "object" || store.gridBuyOrders === null) store.gridBuyOrders = {};
if (typeof store.gridSellOrders !== "object" || store.gridSellOrders === null) store.gridSellOrders = {};


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
    const initialCapital = parseFloat(whatstrat.INITIAL_CAPITAL);
    const maxGrids = parseInt((whatstrat && whatstrat.GQ_GRID_MAX_GRIDS) || 20);
    const gridSpacingPct = parseFloat((whatstrat && whatstrat.GQ_GRID_GRID_SPACING_PCT) || 1.0);
    const gridSpacingFactor = 1 + (gridSpacingPct / 100);
    const minVolumeToSell = parseFloat(whatstrat.MIN_VOLUME_TO_SELL);
    const stopAfterNextSell = whatstrat.STOP_AFTER_SELL;


    // gunbot core data
    const {
        ask,
        bid,
        pairName,
        exchangeName,
        quoteBalance,
        baseBalance,
        gotBag,
        orders,
        openOrders,
        candlesTimestamp
    } = gb.data;

    /* -------------------------------------------------------------------------
     *  ORDER PLACEMENT HELPERS
     * ------------------------------------------------------------------------- */
    const buyLimit = async function (amount, rate, exchange, pair) {
        if (watchMode || !buyEnabled) return;
        try {
            const orderQty = amount / rate;
            const buyResults = await gb.method.buyLimit(orderQty, rate, pair, exchange);
            console.log(sanitizeExchangeResponse(buyResults));
        } catch (e) {
            console.log(`Error placing buy limit at ${rate}:`, e);
        }
    };

    const sellLimit = async function (amount, rate, exchange, pair) {
        if (watchMode || !sellEnabled) return;
        try {
            const sellResults = await gb.method.sellLimit(amount, rate, pair, exchange);
            console.log(sanitizeExchangeResponse(sellResults));
        } catch (e) {
            console.log(`Error placing sell limit at ${rate}:`, e);
        }
    };

    const cancelOrder = function (orderId, pair, exchange) {
        gb.method.cancelOrder(orderId, pair, exchange)
    };

    /* -------------------------------------------------------------------------
     *  CORE STRATEGY LOGIC
     * ------------------------------------------------------------------------- */
    async function decideTrade() {
        const STRATEGY_NAME = "Grid_Strategy";

        // ─── GUI Enhancement ───
        const sidebar = [];
        const buyOrderCount = Object.keys(store.gridBuyOrders).length;
        const sellOrderCount = Object.keys(store.gridSellOrders).length;
        const status = store.isInitialized ? `Active (${buyOrderCount + sellOrderCount} orders)` : "Initializing";

        sidebar.push({
            label: 'Status',
            value: status,
            valueColor: store.isInitialized ? '#34d399' : '#fbbf24',
            tooltip: 'Grid status. "Active" means it is placing and managing orders.'
        });

        const lastFill = orders.length > 0 ? `${orders[0].type.toUpperCase()} @ ${parseFloat(orders[0].rate).toFixed(gb.data.pricePrecision || 4)}` : 'None';
        sidebar.push({
            label: 'Last Fill',
            value: lastFill,
            tooltip: 'The most recently filled grid order.'
        });

        sidebar.push({
            label: 'Virtual Capital',
            value: `§${(store.virtualCapital || initialCapital).toFixed(2)}`,
            tooltip: `The compounding capital base for this pair.\nInitial: ${initialCapital.toFixed(2)}`
        });

        const buyLevels = Object.keys(store.gridBuyOrders).map(Number).sort((a, b) => b - a);
        const sellLevels = Object.keys(store.gridSellOrders).map(Number).sort((a, b) => a - b);

        sidebar.push({
            label: 'Buy Orders',
            value: `${buyOrderCount} / ${maxGrids}`,
            tooltip: `Number of active buy limit orders.\nTop Buy: ${buyLevels.length > 0 ? buyLevels[0].toFixed(4) : 'N/A'}`
        }, {
            label: 'Sell Orders',
            value: `${sellOrderCount} / ${maxGrids}`,
            tooltip: `Number of active sell limit orders.\nBottom Sell: ${sellLevels.length > 0 ? sellLevels[0].toFixed(4) : 'N/A'}`
        }, {
            label: 'Grid Spacing',
            value: `${gridSpacingPct}%`,
            tooltip: 'The percentage difference between each grid level.'
        });

        while (sidebar.length % 3 !== 0) {
            sidebar.push({ label: '', value: '' });
        }
        gb.data.pairLedger.sidebarExtras = sidebar;
        // ───────────────────────

        // --- DYNAMIC COMPOUNDING (Multi-Pair Safe) ---
        const gridStepValue = store.virtualCapital > 0 ? store.virtualCapital / maxGrids : initialCapital / maxGrids;

        const configLog = `Config: GQ_GRID_MAX_GRIDS=${maxGrids}, GQ_GRID_GRID_SPACING_PCT=${gridSpacingPct}%`;
        const stateLog = `State: VirtualCapital=${(store.virtualCapital || 0).toFixed(2)}, GridStepValue=${gridStepValue.toFixed(2)}`;

        // --- ONE-TIME INITIALIZATION ---
        if (!store.isInitialized) {
            if (!buyEnabled) {
                console.log(`[${STRATEGY_NAME}] Waiting for buys to be enabled for initialization.`);
                return;
            }
            if (baseBalance < initialCapital * 0.95) {
                console.log(`[${STRATEGY_NAME}] Insufficient base balance. Have ${baseBalance}, need ~${initialCapital}.`);
                return;
            }
            if (gotBag) {
                console.log(`[${STRATEGY_NAME}] ERROR: Cannot initialize grid, bot is already holding a bag. Please sell manually.`);
                return;
            }

            console.log(`[${STRATEGY_NAME}] First run. Initializing grid... ${configLog}`);

            store.virtualCapital = initialCapital;

            const anchorPrice = bid;
            const numBuySide = maxGrids;

            let buyPrice = anchorPrice;
            for (let i = 0; i < numBuySide; i++) {
                buyPrice /= gridSpacingFactor;
                store.gridBuyOrders[buyPrice.toPrecision(6)] = true;
            }

            store.gridSellOrders = {};
            store.isInitialized = true;
            store.lastOrderCheckTime = Date.now() - 5000;
            console.log(`[${STRATEGY_NAME}] Initialization complete. ${numBuySide} buy levels stored. Placing initial orders...`);
            return;
        }

        // --- PROCESS FILLED ORDERS ---
        const newFilledOrders = orders.filter(o => o.time >= store.lastOrderCheckTime);
        let gridChanged = false;

        for (const filled of newFilledOrders) {
            const filledPrice = parseFloat(filled.rate);
            const filledPriceKey = filledPrice.toPrecision(6);

            if (filled.type === 'buy' && store.gridBuyOrders[filledPriceKey]) {
                gridChanged = true;
                console.log(`[${STRATEGY_NAME}] Detected filled BUY at ${filled.rate}.`);
                delete store.gridBuyOrders[filledPriceKey];

                const newSellPriceKey = (filledPrice * gridSpacingFactor).toPrecision(6);
                store.gridSellOrders[newSellPriceKey] = true;

                const totalOrders = Object.keys(store.gridBuyOrders).length + Object.keys(store.gridSellOrders).length;
                if (totalOrders > maxGrids) {
                    const sellLevels = Object.keys(store.gridSellOrders).map(Number);
                    if (sellLevels.length > 0) {
                        const lowestSellKey = Math.min.apply(null, sellLevels).toPrecision(6);
                        delete store.gridSellOrders[lowestSellKey];
                        console.log(`[${STRATEGY_NAME}] Grid trimmed: Removed lowest SELL @ ${lowestSellKey}`);
                    }
                }
            }

            if (filled.type === 'sell' && store.gridSellOrders[filledPriceKey]) {
                gridChanged = true;
                console.log(`[${STRATEGY_NAME}] Detected filled SELL at ${filled.rate}.`);
                delete store.gridSellOrders[filledPriceKey];

                const correspondingBuyPrice = filledPrice / gridSpacingFactor;
                const profit = (filled.amount * filledPrice) - (filled.amount * correspondingBuyPrice);
                store.virtualCapital += profit;
                console.log(`[${STRATEGY_NAME}] Realized profit: ${profit.toFixed(4)}. New Virtual Capital: ${store.virtualCapital.toFixed(2)}.`);

                const newBuyPriceKey = correspondingBuyPrice.toPrecision(6);
                store.gridBuyOrders[newBuyPriceKey] = true;

                const totalOrders = Object.keys(store.gridBuyOrders).length + Object.keys(store.gridSellOrders).length;
                if (totalOrders > maxGrids) {
                    const buyLevels = Object.keys(store.gridBuyOrders).map(Number);
                    if (buyLevels.length > 0) {
                        const highestBuyKey = Math.max.apply(null, buyLevels).toPrecision(6);
                        delete store.gridBuyOrders[highestBuyKey];
                        console.log(`[${STRATEGY_NAME}] Grid trimmed: Removed highest BUY @ ${highestBuyKey}`);
                    }
                }
            }
        }
        store.lastOrderCheckTime = Date.now();

        // --- RECONCILE & PLACE/CANCEL ORDERS ---
        if (stopAfterNextSell && !gotBag) {
            console.log(`[${STRATEGY_NAME}] SKIP: Stop after next sell is active, no further buy orders are allowed.`);
            return;
        }

        const openBuyRates = {};
        const openSellRates = {};
        openOrders.forEach(o => {
            const rateKey = parseFloat(o.rate).toPrecision(6);
            if (o.type === 'buy') openBuyRates[rateKey] = o;
            else if (o.type === 'sell') openSellRates[rateKey] = o;
        });

        for (const rateStr in openBuyRates) {
            if (!store.gridBuyOrders[rateStr]) {
                console.log(`[${STRATEGY_NAME}] Cancelling stale BUY limit at ${rateStr}`);
                cancelOrder(openBuyRates[rateStr].id, pairName, exchangeName);
            }
        }
        for (const rateStr in openSellRates) {
            if (!store.gridSellOrders[rateStr]) {
                console.log(`[${STRATEGY_NAME}] Cancelling stale SELL limit at ${rateStr}`);
                cancelOrder(openSellRates[rateStr].id, pairName, exchangeName);
            }
        }

        if (buyEnabled) {
            for (const rateStr in store.gridBuyOrders) {
                if (!openBuyRates[rateStr]) {
                    const rate = parseFloat(rateStr);
                    await buyLimit(gridStepValue, rate, exchangeName, pairName);
                }
            }
        }

        if (sellEnabled && quoteBalance * bid > minVolumeToSell) {
            for (const rateStr in store.gridSellOrders) {
                if (!openSellRates[rateStr]) {
                    const rate = parseFloat(rateStr);
                    const correspondingBuyPrice = rate / gridSpacingFactor;
                    const quoteAmountToSell = Math.min(quoteBalance, gridStepValue / correspondingBuyPrice);
                    await sellLimit(quoteAmountToSell, rate, exchangeName, pairName);
                }
            }
        }

        if (!gridChanged) {
            console.log(`[${STRATEGY_NAME}] Run complete. No fills. Grid unchanged. ${stateLog}`);
        } else {
            console.log(`[${STRATEGY_NAME}] Run complete. Grid updated. ${stateLog}`);
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