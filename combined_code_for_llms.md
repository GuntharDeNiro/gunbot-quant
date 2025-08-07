

## ./gunbot_quant/gunbot_api/__init__.py
```

```


## ./gunbot_quant/gunbot_api/client.py
```
# gunbot_quant/gunbot_api/client.py

import json
import os
import subprocess
from datetime import datetime, timedelta
from typing import Optional, Dict, Any

from gunbot_sdk import ApiClient, GunbotApi

# --- Configuration ---
# Store credentials in the root directory of the project
CRED_FILE = os.path.join(os.path.dirname(__file__), '..', '..', 'gunbot_creds.json')

# --- Global State ---
gunbot_api_instance: Optional[GunbotApi] = None

# --- Credential Management ---
def save_credentials(jwt: str, protocol: str, host: str, port: int) -> None:
    """Saves the Gunbot connection details to a file."""
    creds = {'jwt': jwt, 'protocol': protocol, 'host': host, 'port': port}
    try:
        with open(CRED_FILE, 'w') as f:
            json.dump(creds, f)
    except IOError as e:
        print(f"Error saving credentials: {e}")

def load_credentials() -> Optional[Dict[str, Any]]:
    """Loads Gunbot connection details from a file."""
    if not os.path.exists(CRED_FILE):
        return None
    try:
        with open(CRED_FILE, 'r') as f:
            data = json.load(f)
            # Basic validation
            if all(k in data for k in ['jwt', 'protocol', 'host', 'port']):
                return data
            return None
    except (IOError, json.JSONDecodeError) as e:
        print(f"Error loading credentials: {e}")
        return None

def clear_credentials() -> None:
    """Removes the credentials file."""
    global gunbot_api_instance
    gunbot_api_instance = None
    if os.path.exists(CRED_FILE):
        os.remove(CRED_FILE)

def close_gunbot_api() -> None:
    """Explicitly closes the multiprocessing pool in the SDK's ApiClient."""
    global gunbot_api_instance
    if gunbot_api_instance and hasattr(gunbot_api_instance.api_client, 'pool') and gunbot_api_instance.api_client.pool is not None:
        print("Closing Gunbot API client pool...")
        try:
            pool = gunbot_api_instance.api_client.pool
            pool.close()
            pool.join()
        except Exception as e:
            # This error might be benign if the pool is already terminated during shutdown.
            print(f"Error while closing Gunbot API client pool: {e}")
    
    # Setting the global instance to None indicates that the API has been shut down
    # and prevents further use. The underlying ApiClient object will be garbage-collected
    # by Python later. We no longer set its .pool to None to avoid the AttributeError.
    gunbot_api_instance = None


# --- SDK Client Initialization ---
def _construct_base_path(creds: Optional[Dict[str, Any]]) -> str:
    """Constructs the base_path URL from credentials or returns a default."""
    if creds:
        return f"{creds['protocol']}://{creds['host']}:{creds['port']}/api/v1"
    # Fallback to default if no creds are saved
    return "http://localhost:3000/api/v1"

def initialize_gunbot_api(jwt: str, protocol: str, host: str, port: int) -> GunbotApi:
    """
    Initializes or re-initializes the Gunbot API client with a new token and host.
    Saves the credentials for future use.
    """
    global gunbot_api_instance
    save_credentials(jwt=jwt, protocol=protocol, host=host, port=port)
    
    creds = load_credentials() # Reload to be sure
    base_path = _construct_base_path(creds)
    
    api_client = ApiClient(base_path=base_path, bearer_token=jwt)
    gunbot_api_instance = GunbotApi(api_client)
    return gunbot_api_instance

def get_gunbot_api() -> Optional[GunbotApi]:
    """
    Gets the singleton Gunbot API client instance.
    Initializes it from saved credentials if not already in memory.
    """
    global gunbot_api_instance
    if gunbot_api_instance:
        return gunbot_api_instance

    creds = load_credentials()
    if not creds:
        return None
    
    base_path = _construct_base_path(creds)
    api_client = ApiClient(base_path=base_path, bearer_token=creds['jwt'])
    gunbot_api_instance = GunbotApi(api_client)
    return gunbot_api_instance

# --- Encryption Helper for Login (using OpenSSL via Subprocess) ---
def _encrypt_password(password: str, key: str) -> str:
    """Encrypts a password using AES-128-CBC for Gunbot API login."""
    try:
        if not key:
            raise ValueError("'gunthy_wallet' key cannot be empty.")
        # Truncate key to 16 bytes for AES-128
        key_trunc = key[:16]

        # Convert key and IV to hex. IV is the same as the key.
        key_hex = key_trunc.encode('utf-8').hex()
        iv_hex = key_hex

        # Run openssl command
        res = subprocess.run([
            'openssl', 'enc', '-aes-128-cbc',
            '-K', key_hex,
            '-iv', iv_hex,
            '-nosalt',
            '-base64',
            '-A'  # CRITICAL FIX: Ensures base64 output is a single line
        ], input=password.encode('utf-8'), stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)

        # .strip() is still good practice to remove any final newline
        encrypted_base64 = res.stdout.decode().strip()
        return f"ENC:{encrypted_base64}"
    except (FileNotFoundError, subprocess.CalledProcessError) as e:
        error_message = "OpenSSL command failed. Ensure OpenSSL is installed and in your system's PATH."
        if isinstance(e, subprocess.CalledProcessError):
            error_message += f"\nStderr: {e.stderr.decode()}"
        raise RuntimeError(error_message)


# --- Full Login Flow Function ---
def login_and_initialize_api(protocol: str, host: str, port: int, password: str, gunthy_wallet: str) -> Dict[str, Any]:
    """
    Connects to Gunbot using password, retrieves JWT, and initializes the global API client.
    """
    base_path = f"{protocol}://{host}:{port}/api/v1"
    
    try:
        print(f"Attempting to connect to Gunbot at: {base_path}")
        
        # Step 1: Encrypt the password using the provided key
        encrypted_password = _encrypt_password(password, gunthy_wallet)
        
        # Step 2: Create a temporary unauthenticated client to perform the login
        unauth_client = ApiClient(base_path=base_path, bearer_token='')
        unauth_api = GunbotApi(unauth_client)
        
        # Step 3: Perform the login call
        login_body = {"password": encrypted_password}
        
        print(f"Sending login request to {base_path}/auth/login with body: {login_body}")
        
        login_model = unauth_api.auth_login(body=login_body)
        
        # Step 4: Check login success and extract JWT
        # FIX: The actual Gunbot response uses 'status' and 'token', not 'success' and 'jwt'.
        if not hasattr(login_model, 'status') or login_model.status != 'success' or not hasattr(login_model, 'token'):
            error_msg = login_model.message if hasattr(login_model, 'message') and login_model.message else "Login failed. Gunbot API did not return a success token."
            raise ConnectionRefusedError(error_msg)
        
        jwt = login_model.token # FIX: Use the 'token' field from the response
        
        # Step 5: Initialize the global authenticated client with the new JWT
        initialize_gunbot_api(jwt=jwt, protocol=protocol, host=host, port=port)
        
        # Step 6: Final verification with an authenticated call
        auth_check_result = auth_status()
        if not auth_check_result.get("success"):
            clear_credentials()
            raise ConnectionRefusedError(f"Login succeeded, but subsequent authentication check failed: {auth_check_result.get('error')}")

        return {"success": True, "message": "Successfully connected to Gunbot.", "data": auth_check_result.get("data")}

    except Exception as e:
        clear_credentials()
        print(f"--- DETAILED EXCEPTION DURING LOGIN ---\n{repr(e)}\n------------------------------------")
        
        e_str = str(e).lower()
        if "connection refused" in e_str or "failed to establish a new connection" in e_str:
            error_msg = f"Connection Refused: Could not connect to Gunbot at '{base_path}'. Please ensure Gunbot is running and the host/port settings are correct."
        else:
            error_msg = f"Gunbot login process failed: {str(e)}"
        return {"success": False, "error": error_msg}

# --- Helper for timestamps ---
def ts(*, days: int = 0, hours: int = 0) -> int:
    """Return a UTC Unix timestamp in **milliseconds** with offset."""
    return int((datetime.utcnow() + timedelta(days=days, hours=hours)).timestamp() * 1000)

# --- Wrapper Methods for API Endpoints ---
def gb_api_call(func_name: str, *args, **kwargs) -> Dict[str, Any]:
    """
    A generic wrapper to call Gunbot API methods. It inspects the response
    for success/failure and catches transport-level exceptions.
    """
    gunbot_api = get_gunbot_api()
    if not gunbot_api:
        return {"success": False, "error": "Gunbot client not connected. Please provide a JWT token."}
    
    try:
        method = getattr(gunbot_api, func_name)
        response_model = method(*args, **kwargs)

        if hasattr(response_model, 'success') and not response_model.success:
            error_message = "Unknown API error."
            if hasattr(response_model, 'message') and response_model.message:
                error_message = response_model.message
            elif hasattr(response_model, 'error') and response_model.error:
                error_message = response_model.error
            return {"success": False, "error": error_message}
        
        response_data = response_model.to_dict() if hasattr(response_model, 'to_dict') else response_model
        return {"success": True, "data": response_data}

    except Exception as e:
        return {"success": False, "error": f"A communication error occurred: {str(e)}"}

# --- SYSTEM / AUTH ---
def auth_status() -> Dict[str, Any]:
    return gb_api_call('auth_status')

def auth_login(body: Dict[str, Any]) -> Dict[str, Any]:
    """Wraps the auth_login endpoint. Note: typically used via login_and_initialize_api."""
    return gb_api_call('auth_login', body=body)

# --- CONFIGURATION ---
def config_full() -> Dict[str, Any]:
    return gb_api_call('config_full')

def config_pair_add(body: Dict[str, Any]) -> Dict[str, Any]:
    """
    Adds or updates a trading pair in Gunbot's configuration.
    The body must match the structure expected by the Gunbot API.
    """
    return gb_api_call('config_pair_add', body=body)

def config_pair_remove(pair: str, exchange: str) -> Dict[str, Any]:
    body = {"pair": pair, "exchange": exchange}
    return gb_api_call('config_pair_remove', body=body)

def config_strategy_add(name: str, settings: Dict[str, Any]) -> Dict[str, Any]:
    body = {"name": name, "settings": settings}
    return gb_api_call('config_strategy_add', body=body)

# --- CORE MEMORY ---
def coremem() -> Dict[str, Any]:
    return gb_api_call('coremem')

# --- FILES ---
def files_strategy() -> Dict[str, Any]:
    return gb_api_call('files_strategy')

def files_strategy_write(filename: str, document: str) -> Dict[str, Any]:
    body = {"filename": filename, "document": document}
    return gb_api_call('files_strategy_write', body=body)

def files_strategy_get(filename: str) -> Dict[str, Any]:
    body = {"filename": filename}
    return gb_api_call('files_strategy_get', body=body)

# --- TRADING ---
def trade_sell_market(exch: str, pair: str, price: float, amt: float) -> Dict[str, Any]:
    body = {"exch": exch, "pair": pair, "price": price, "amt": amt}
    return gb_api_call('trade_sell_market', body=body)

def orders(pair_string: str) -> Dict[str, Any]:
    """
    Fetches order history for a specific pair.
    The pair string must be in 'exchange/QUOTE-BASE' format.
    """
    # The SDK's generated method expects the argument to be named 'key'.
    return gb_api_call('orders', key=pair_string)
```


## ./gunbot_quant/gunbot_api/data_processor.py
```
# gunbot_quant/gunbot_api/data_processor.py

from typing import Dict, Any

from . import client as gunbot_client

def process_trading_pairs_from_coremem(coremem_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Processes the raw coremem object from Gunbot to extract information
    about actively trading pairs, their configuration, and their order history.

    Args:
        coremem_data: The full 'data' object from the coremem SDK call.

    Returns:
        A dictionary where keys are the standard pair format (e.g., 'ETHUSDT')
        and values are objects containing the pair's data.
    """
    trading_pairs_info = {}
    config = coremem_data.get("config", {})
    memory = coremem_data.get("memory", {})

    if not config or not isinstance(config, dict):
        return {}

    for exchange, pairs in config.items():
        if not isinstance(pairs, dict):
            continue
            
        for gunbot_pair, pair_config in pairs.items():
            # Skip if the pair is not a dictionary or not enabled
            if not isinstance(pair_config, dict) or not pair_config.get("enabled"):
                continue

            # Convert Gunbot pair format (USDT-ETH) to standard format (ETHUSDT)
            try:
                quote, base = gunbot_pair.split('-')
                standard_pair = f"{base}{quote}"
            except ValueError:
                # Skip malformed pair names
                continue

            # Construct the key to look up the pair in the memory object
            memory_key = f"{exchange}/{gunbot_pair}"
            pair_memory = memory.get(memory_key, {})

            # --- Fetch order history ---
            orders_result = gunbot_client.orders(memory_key)
            pair_orders = []
            if orders_result.get("success"):
                # The response from gb_api_call is {"success": True, "data": response_data}
                # where response_data is the dict from the model, e.g., {"data": [...]}
                pair_orders = orders_result.get("data", {}).get("data", [])
            
            # --- Safely get values for calculation ---
            bid = pair_memory.get("Bid")
            abp = pair_memory.get("ABP")

            # Build the final data object for this pair
            trading_pairs_info[standard_pair] = {
                "standard_pair_format": standard_pair,
                "gunbot_pair_format": gunbot_pair,
                "exchange": exchange,
                "config": {
                    "strategy": pair_config.get("strategy"),
                    "enabled": pair_config.get("enabled"),
                    "override": pair_config.get("override", {}),
                },
                "openOrders": pair_memory.get("openOrders", []),
                "quoteBalance": pair_memory.get("quoteBalance"),
                "baseBalance": pair_memory.get("baseBalance"),
                "bid": bid,
                "unitCost": abp,
                "orders": pair_orders,
                "bagValue": bid * abp if isinstance(bid, (int, float)) and isinstance(abp, (int, float)) else 0.0,
                "candleTimeFrame": pair_memory.get("whatstrat", {}).get("PERIOD") 
            }
            
    return trading_pairs_info
```


## ./gunbot_quant/config/__init__.py
```

```


## ./gunbot_quant/config/scenarios.py
```
# gunbot_quant_tools/config/scenarios.py

import copy
from datetime import datetime, timedelta
# The binance client constant is still used for TIMEFRAME, which is fine.
# The backtester will interpret it correctly.
from binance.client import Client

def get_date_relative_to_now(days: int = 0) -> str:
    """Returns a date string for N days from now in YYYY-MM-DD format."""
    return (datetime.now() - timedelta(days=abs(days))).strftime('%Y-%m-%d')

# --- BASE CONFIGURATION ---
BASE_CONFIG = {
    # --- GENERAL ---
    "EXCHANGE": "binance", # NEW: The exchange to fetch data from
    "INITIAL_CAPITAL": 10_000.0,
    "SEED": 42,
    "TIMEFRAME": Client.KLINE_INTERVAL_1HOUR,
    "BACKTEST_START_DATE": get_date_relative_to_now(days=365),
    "BACKTEST_END_DATE": get_date_relative_to_now(days=0),
    "TECHNICAL_WARMUP_PERIOD": 400,

    # --- SYMBOL SELECTION ---
    "SYMBOL_SELECTION_METHOD": 'TOP_N_VOLUME', # 'TOP_N_VOLUME', 'MOMENTUM_SCREENER', or 'EXPLICIT_LIST'
    "TOP_N_COINS": 20,

    # --- ADVANCED SCREENER SETTINGS ---
    "SCREENER_QUOTE_ASSET": "USDT", # The quote asset to screen against
    "SCREENER_CANDIDATE_COUNT": 200,
    "SCREENER_FINAL_COUNT": 15,
    "SCREENER_RANK_METRIC": "roc_30p", # Metric to sort final symbols by
    "SCREENER_FILTERS": [
        {'metric': 'avg_vol_30d_quote', 'condition': 'greater_than', 'value': 10_000_000},
        {'metric': 'atr_pct_14p', 'condition': 'between', 'value': [2.0, 10.0]},
    ],

    # --- STRATEGY SELECTION ---
    # CLI uses simple string format. The backtest engine will use default params.
    "STRATEGIES": ["Dynamic_Momentum_Optimizer"],
    "STRATEGY_PARAMS": {}, # Kept for potential future use, but deprecated by new system

    # --- LEGACY STRATEGY PARAMETERS ---
    "OPTIMIZATION_LOOKBACK": 500,
    "REOPTIMIZE_EVERY": 168,
    "FAST_MA_PERIODS": list(range(10, 80, 4)),
    "SLOW_MA_PERIODS": list(range(90, 300, 10)),
    "ATR_PERIODS": list(range(10, 60, 5)), # Actually STDDEV in legacy
    "ATR_MULTIPLIERS": [x * 0.5 for x in range(2, 12)],
    "TOP_PARAM_MEMORY": 25,
    "CONFIDENCE_THRESHOLD": 3.0,
    "EXPLORATION_RATE": 0.01,
    "TRAIL_TRIGGER_MULT": 1.0,
}

# --- SCENARIO DEFINITIONS ---
SCENARIOS = [
    {
        "name": "Legacy_Strategy_On_Volume_Last_Year",
        "params": {
            "EXCHANGE": "binance", # Explicitly set for clarity
            "SYMBOL_SELECTION_METHOD": 'TOP_N_VOLUME',
            "STRATEGIES": ["Dynamic_Momentum_Optimizer"],
        }
    },
    {
        "name": "RSI_vs_MACD_On_High_Momentum_Screener",
        "params": {
            "EXCHANGE": "binance", # Explicitly set for clarity
            "TIMEFRAME": Client.KLINE_INTERVAL_4HOUR,
            "BACKTEST_START_DATE": get_date_relative_to_now(days=730),
            "SYMBOL_SELECTION_METHOD": 'MOMENTUM_SCREENER',
            "SCREENER_FINAL_COUNT": 10,
            "SCREENER_FILTERS": [
                {'metric': 'atr_pct_14p', 'condition': 'greater_than', 'value': 1.0},
                {'metric': 'roc_90p', 'condition': 'greater_than', 'value': 25},
                {'metric': 'adx_14p', 'condition': 'greater_than', 'value': 20},
            ],
            # Use new base names for strategies
            "STRATEGIES": ["RSI_Reversion", "MACD_Cross"],
        }
    },
    {
        "name": "Mean_Reversion_Screener_Last_6_Months",
        "params": {
            "EXCHANGE": "binance", # Explicitly set for clarity
            "TIMEFRAME": Client.KLINE_INTERVAL_1HOUR,
            "BACKTEST_START_DATE": get_date_relative_to_now(days=180),
            "SYMBOL_SELECTION_METHOD": 'MOMENTUM_SCREENER',
            "SCREENER_FINAL_COUNT": 20,
            "SCREENER_FILTERS": [
                {'metric': 'avg_vol_30d_quote', 'condition': 'greater_than', 'value': 15_000_000},
                {'metric': 'rsi_14p', 'condition': 'less_than', 'value': 40},
                {'metric': 'stochrsi_k_14_3_3', 'condition': 'less_than', 'value': 20},
                {'metric': 'adx_14p', 'condition': 'less_than', 'value': 25},
                {'metric': 'atr_pct_14p', 'condition': 'between', 'value': [2.5, 12.0]},
            ],
            "STRATEGIES": ["BB_Reversion"],
        }
    },
    # NEW SCENARIO to demonstrate multi-exchange capability
    {
        "name": "Kucoin_Mean_Reversion_Last_6_Months",
        "params": {
            "EXCHANGE": "kucoin",
            "TIMEFRAME": "1h", # Use string for CCXT compatibility
            "BACKTEST_START_DATE": get_date_relative_to_now(days=180),
            "SYMBOL_SELECTION_METHOD": 'MOMENTUM_SCREENER',
            "SCREENER_FINAL_COUNT": 10,
            "SCREENER_FILTERS": [
                {'metric': 'avg_vol_30d_quote', 'condition': 'greater_than', 'value': 5_000_000},
                {'metric': 'rsi_14p', 'condition': 'less_than', 'value': 40},
                {'metric': 'atr_pct_14p', 'condition': 'between', 'value': [2.0, 15.0]},
            ],
            "STRATEGIES": ["BB_Reversion", "RSI_Reversion"],
        }
    },
]

def get_scenario_config(scenario_definition: dict) -> dict:
    config = copy.deepcopy(BASE_CONFIG)
    config.update(scenario_definition["params"])
    config["SCENARIO_NAME"] = scenario_definition["name"]
    return config
```


## ./gunbot_quant/__init__.py
```

```


## ./gunbot_quant/gunbot_strategy_files/bollinger_band_ride.js
```
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
```


## ./gunbot_quant/gunbot_strategy_files/rsi_reversion.js
```
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
```


## ./gunbot_quant/gunbot_strategy_files/heikin_ashi_trend.js
```
/*
 * Gunbot Quant Strategy: Heikin_Ashi_Trend
 *
 * Summary:
 * A trend-following strategy that uses smoothed Heikin Ashi (HA) candles to
 * filter out market noise and identify the underlying trend.
 *
 * Logic:
 * --- Entry ---
 * Triggers a BUY when the HA candles flip from red (downtrend) to green
 * (uptrend), signaling a potential trend reversal to the upside.
 * --- Exit ---
 * Triggers a SELL as soon as a red HA candle appears, indicating the
 * uptrend may be weakening or reversing.
 * --- Stop Loss ---
 * An initial stop loss is placed using the Average True Range (ATR) of the
 * regular candles for risk management.
 *
 * Configurable Parameters:
 * -------------------------------------------------------------------------
 * This is a parameter-free strategy. It uses a fixed ATR(14, 2.5) for its
 * stop loss calculation, but these values are not user-configurable in GQ.
 * -------------------------------------------------------------------------
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
        heikinAshi: function (o, h, l, c) {
            const haClose = new Array(c.length).fill(NaN);
            const haOpen = new Array(c.length).fill(NaN);

            if (c.length > 0) {
                haOpen[0] = o[0];
                haClose[0] = (o[0] + h[0] + l[0] + c[0]) / 4;
            }

            for (let i = 1; i < c.length; i++) {
                haClose[i] = (o[i] + h[i] + l[i] + c[i]) / 4;
                haOpen[i] = (haOpen[i - 1] + haClose[i - 1]) / 2;
            }
            return {
                open: haOpen,
                close: haClose
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

        const STRATEGY_NAME = "Heikin_Ashi_Trend";
        // Fixed parameters for stop loss
        const atrPeriod = 14;
        const atrMultiplier = 2.5;

        const haCandles = indicator_helpers.heikinAshi(candlesOpen, candlesHigh, candlesLow, candlesClose);
        const atrValues = indicator_helpers.atr(candlesHigh, candlesLow, candlesClose, atrPeriod);

        const haOpen = haCandles.open[iLast];
        const haClose = haCandles.close[iLast];
        const prevHaOpen = haCandles.open[iLast - 1];
        const prevHaClose = haCandles.close[iLast - 1];
        const atr = atrValues[iLast];

        const isCurrentGreen = haClose > haOpen;
        const isPrevRed = prevHaClose < prevHaOpen;

        // ─── GUI Enhancement ───
        const isFlipToGreen = isPrevRed && isCurrentGreen;
        const isFlipToRed = store.state === "IN_POSITION" && !isCurrentGreen;
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
            label: 'HA Flip to Green',
            value: isFlipToGreen ? '✔︎' : '✖︎',
            valueColor: isFlipToGreen ? '#22c55e' : '#ef4444',
            tooltip: `Checks if the Heikin Ashi candle has flipped from red to green.\nPrev: ${prevHaClose < prevHaOpen ? 'Red' : 'Green'}, Curr: ${isCurrentGreen ? 'Green' : 'Red'}`
        });

        // Exit Conditions
        sidebar.push({
            label: 'HA Flip to Red',
            value: isFlipToRed ? '✔︎' : '✖︎',
            valueColor: isFlipToRed ? '#22c55e' : '#ef4444',
            tooltip: `Checks if the Heikin Ashi candle has flipped to red, signaling a potential exit.`
        }, {
            label: 'Stop Loss',
            value: isStopLossHit ? '✔︎' : '✖︎',
            valueColor: isStopLossHit ? '#22c55e' : '#ef4444',
            tooltip: `Checks if the price has hit the ATR-based stop loss.\nPrice: ${ask.toFixed(4)}\nStop: ${store.stopPrice.toFixed(4)}`
        });

        // Essential Extras
        sidebar.push({
            label: 'HA Candle Color',
            value: isCurrentGreen ? 'Green' : 'Red',
            valueColor: isCurrentGreen ? '#22c55e' : '#ef4444',
            tooltip: `Current color of the Heikin Ashi candle.\nOpen: ${haOpen.toFixed(4)}, Close: ${haClose.toFixed(4)}`
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

        const configLog = `Config: Parameter-free`;
        const indicatorLog = `Indicators: HA_Open=${haOpen ? haOpen.toFixed(4) : 'N/A'}, HA_Close=${haClose ? haClose.toFixed(4) : 'N/A'}`;

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

            const isFlipToGreen = isPrevRed && isCurrentGreen;
            const wantToEnter = isFlipToGreen;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog];

            if (!wantToEnter) {
                logParts.push(`Trigger: SKIP (HA did not flip to green)`);
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

            logParts.push(`Trigger: BUY (HA flipped to green), Stop Loss will be set near ${store.pendingStopPrice.toFixed(4)}`);
            console.log(logParts.join(' '));
            await buyMarket(costQuote, exchangeName, pairName);
            store.pendingBuy = {
                time: Date.now()
            };
            return;
        }

        if (store.state === "IN_POSITION") {
            // ─── GUI Enhancement ───
            delete gb.data.pairLedger.customSellTarget; // Exit is a red candle, not a fixed price
            if (store.stopPrice > 0) gb.data.pairLedger.customStopTarget = store.stopPrice;
            else delete gb.data.pairLedger.customStopTarget;
            delete gb.data.pairLedger.customDcaTarget;
            // ───────────────────────
            if (!gotBag || !sellEnabled) {
                console.log(`[${STRATEGY_NAME}] SKIP: No bag to sell or sells disabled.`);
                return;
            }

            const isStopLossHit = store.stopPrice > 0 && ask < store.stopPrice;
            const isFlipToRed = !isCurrentGreen; // HA is red
            const wantToExit = isStopLossHit || isFlipToRed;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog, `Position: Entry=${store.entryPrice.toFixed(4)}, Stop=${store.stopPrice.toFixed(4)}`];

            if (!wantToExit) {
                logParts.push(`Trigger: SKIP (HA is still green AND Ask >= Stop)`);
                console.log(logParts.join(' '));
                return;
            }

            let exitReason = isStopLossHit ?
                `STOP LOSS (Ask ${ask.toFixed(4)} < ${store.stopPrice.toFixed(4)})` :
                `EXIT (HA flipped to red)`;

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
```


## ./gunbot_quant/gunbot_strategy_files/trend_filter_rsi_entry.js
```
/*
 * Gunbot Quant Strategy: Trend_Filter_RSI_Entry
 *
 * Summary:
 * A hybrid "buy the dip" strategy. It first confirms a long-term uptrend
 * using a slow moving average, and then looks for short-term pullback
 * opportunities using the RSI.
 *
 * Logic:
 * --- Trend Filter ---
 * Only considers buying if the price is above a slow Simple Moving Average (SMA).
 * --- Entry ---
 * Within an established uptrend, it triggers a BUY on pullbacks when the
 * RSI crosses below a specified entry level (e.g., 40).
 * --- Exit ---
 * Triggers a SELL when RSI indicates potentially overbought conditions by
 * crossing above an exit level (e.g., 70).
 * --- Stop Loss ---
 * An initial stop loss is placed using the Average True Range (ATR).
 *
 * Configurable Parameters:
 * ------------------------------------------------------------------------------------
 * | Key                                       | Default | Description                               |
 * |-------------------------------------------|---------|-------------------------------------------|
 * | GQ_TREND_FILTER_RSI_ENTRY_FILTER_PERIOD   | 200     | The period for the trend filter SMA.      |
 * | GQ_TREND_FILTER_RSI_ENTRY_RSI_PERIOD      | 14      | The period for RSI calculation.           |
 * | GQ_TREND_FILTER_RSI_ENTRY_RSI_ENTRY       | 40      | RSI level to trigger a buy.               |
 * | GQ_TREND_FILTER_RSI_ENTRY_RSI_EXIT        | 70      | RSI level to trigger a sell.              |
 * | GQ_TREND_FILTER_RSI_ENTRY_ATR_PERIOD      | 14      | Period for ATR (stop loss).               |
 * | GQ_TREND_FILTER_RSI_ENTRY_ATR_MULT        | 2.5     | Multiplier for ATR stop loss.             |
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
        rsi: function (source, length) {
            const result = new Array(source.length).fill(NaN);
            if (source.length <= length) return result;
            let avgGain = 0,
                avgLoss = 0;
            for (let i = 1; i <= length; i++) {
                const change = source[i] - source[i - 1];
                if (change > 0) avgGain += change;
                else avgLoss -= change;
            }
            avgGain /= length;
            avgLoss /= length;
            if (avgLoss === 0) result[length] = 100;
            else result[length] = 100 - (100 / (1 + (avgGain / avgLoss)));
            for (let i = length + 1; i < source.length; i++) {
                const change = source[i] - source[i - 1];
                let gain = change > 0 ? change : 0;
                let loss = change < 0 ? -change : 0;
                avgGain = (avgGain * (length - 1) + gain) / length;
                avgLoss = (avgLoss * (length - 1) + loss) / length;
                if (avgLoss === 0) result[i] = 100;
                else result[i] = 100 - (100 / (1 + (avgGain / avgLoss)));
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
            for (let i = 0; i < length; i++) sum_tr += tr[i];
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
            // START OF GUI HELPER SECTION
            gb.data.pairLedger.customSellTarget = undefined;
            gb.data.pairLedger.customStopTarget = undefined;
            // END OF GUI HELPER SECTION
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

        const STRATEGY_NAME = "Trend_Filter_RSI_Entry";
        const filterPeriod = parseFloat((whatstrat && whatstrat.GQ_TREND_FILTER_RSI_ENTRY_FILTER_PERIOD) || 200);
        const rsiPeriod = parseFloat((whatstrat && whatstrat.GQ_TREND_FILTER_RSI_ENTRY_RSI_PERIOD) || 14);
        const rsiEntry = parseFloat((whatstrat && whatstrat.GQ_TREND_FILTER_RSI_ENTRY_RSI_ENTRY) || 40);
        const rsiExit = parseFloat((whatstrat && whatstrat.GQ_TREND_FILTER_RSI_ENTRY_RSI_EXIT) || 70);
        const atrPeriod = parseFloat((whatstrat && whatstrat.GQ_TREND_FILTER_RSI_ENTRY_ATR_PERIOD) || 14);
        const atrMultiplier = parseFloat((whatstrat && whatstrat.GQ_TREND_FILTER_RSI_ENTRY_ATR_MULT) || 2.5);

        const filterSma = indicator_helpers.sma(candlesClose, filterPeriod);
        const rsiValues = indicator_helpers.rsi(candlesClose, rsiPeriod);
        const atrValues = indicator_helpers.atr(candlesHigh, candlesLow, candlesClose, atrPeriod);

        const inUptrend = candlesClose[iLast] > filterSma[iLast];
        const rsi = rsiValues[iLast];
        const prevRsi = rsiValues[iLast - 1];
        const atr = atrValues[iLast];

        // ─── GUI Enhancement ───
        const isDip = rsi < rsiEntry && prevRsi >= rsiEntry;
        const wantToEnter = inUptrend && isDip;
        const isExitSignal = rsi > rsiExit;
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
            label: 'Uptrend',
            value: inUptrend ? '✔︎' : '✖︎',
            valueColor: inUptrend ? '#22c55e' : '#ef4444',
            tooltip: `Is the price above the ${filterPeriod}-period SMA?\nPrice: ${candlesClose[iLast].toFixed(4)}\nSMA: ${filterSma[iLast].toFixed(4)}`
        }, {
            label: `RSI Dip < ${rsiEntry}`,
            value: isDip ? '✔︎' : '✖︎',
            valueColor: isDip ? '#22c55e' : '#ef4444',
            tooltip: `Has the RSI crossed below the entry level, signaling a pullback?\nRSI: ${rsi.toFixed(2)}`
        });

        // Exit Conditions
        sidebar.push({
            label: `RSI Exit > ${rsiExit}`,
            value: isExitSignal ? '✔︎' : '✖︎',
            valueColor: isExitSignal ? '#22c55e' : '#ef4444',
            tooltip: `Has the RSI crossed above the exit level, signaling overbought conditions?\nRSI: ${rsi.toFixed(2)}`
        }, {
            label: 'Stop Loss',
            value: isStopLossHit ? '✔︎' : '✖︎',
            valueColor: isStopLossHit ? '#22c55e' : '#ef4444',
            tooltip: `Has the price hit the ATR-based stop loss?\nPrice: ${ask.toFixed(4)}\nStop: ${store.stopPrice.toFixed(4)}`
        });

        // Essential Extras
        sidebar.push({
            label: 'ATR Stop Price',
            value: store.stopPrice > 0 ? store.stopPrice.toFixed(gb.data.pricePrecision || 4) : 'N/A',
            tooltip: `Calculated stop loss level based on ATR(${atrPeriod}) x ${atrMultiplier}.`
        });

        while (sidebar.length % 3 !== 0) {
            sidebar.push({ label: '', value: '' });
        }
        gb.data.pairLedger.sidebarExtras = sidebar;
        // ───────────────────────

        const configLog = `Config: GQ_TREND_FILTER_RSI_ENTRY_FILTER_PERIOD=${filterPeriod}, GQ_TREND_FILTER_RSI_ENTRY_RSI_PERIOD=${rsiPeriod}, GQ_TREND_FILTER_RSI_ENTRY_RSI_ENTRY=${rsiEntry}, GQ_TREND_FILTER_RSI_ENTRY_RSI_EXIT=${rsiExit}`;
        const indicatorLog = `Indicators: Uptrend=${inUptrend}, RSI=${rsi ? rsi.toFixed(2) : 'N/A'}`;

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

            const isDip = rsi < rsiEntry && prevRsi >= rsiEntry;
            const wantToEnter = inUptrend && isDip;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog];

            if (!wantToEnter) {
                logParts.push(`Trigger: SKIP (Uptrend=${inUptrend}, Dip=${isDip})`);
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

            logParts.push(`Trigger: BUY (Uptrend dip detected), Stop Loss will be set near ${store.pendingStopPrice.toFixed(4)}`);
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
            const isExitSignal = rsi > rsiExit;
            const wantToExit = isStopLossHit || isExitSignal;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog, `Position: Entry=${store.entryPrice.toFixed(4)}, Stop=${store.stopPrice.toFixed(4)}`];

            if (!wantToExit) {
                logParts.push(`Trigger: SKIP (RSI ${rsi.toFixed(2)} <= ${rsiExit} AND Ask >= Stop)`);
                console.log(logParts.join(' '));
                return;
            }

            let exitReason = isStopLossHit ?
                `STOP LOSS (Ask ${ask.toFixed(4)} < ${store.stopPrice.toFixed(4)})` :
                `EXIT (RSI ${rsi.toFixed(2)} > ${rsiExit})`;

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
```


## ./gunbot_quant/gunbot_strategy_files/keltner_squeeze_breakout.js
```
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
```


## ./gunbot_quant/gunbot_strategy_files/supertrend_follower.js
```
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

```


## ./gunbot_quant/gunbot_strategy_files/dynamic_momentum_optimizer.js
```
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
```


## ./gunbot_quant/gunbot_strategy_files/stochastic_reversion.js
```
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

```


## ./gunbot_quant/gunbot_strategy_files/grid.js
```
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
```


## ./gunbot_quant/gunbot_strategy_files/macd_cross.js
```
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

```


## ./gunbot_quant/gunbot_strategy_files/donchian_breakout.js
```
/*
 * Gunbot Quant Strategy: Donchian_Breakout
 *
 * Summary:
 * A classic breakout strategy, famously used by the "Turtle Traders". It aims
 * to capture new trends by buying when the price breaks above its recent
 * trading range.
 *
 * Logic:
 * --- Entry ---
 * Triggers a BUY when the price breaks above the highest high of the last 'N'
 * periods (the upper Donchian Channel).
 * --- Exit ---
 * Triggers a SELL if the price falls back to the middle of the channel
 * (the average of the highest high and lowest low).
 * --- Stop Loss ---
 * An initial stop loss is placed using the Average True Range (ATR).
 *
 * Configurable Parameters:
 * ------------------------------------------------------------------------------------
 * | Key                               | Default | Description                               |
 * |-----------------------------------|---------|-------------------------------------------|
 * | GQ_DONCHIAN_BREAKOUT_PERIOD       | 20      | The Donchian Channel period.              |
 * | GQ_DONCHIAN_BREAKOUT_ATR_PERIOD   | 14      | Period for ATR (stop loss).               |
 * | GQ_DONCHIAN_BREAKOUT_ATR_MULT     | 2.0     | Multiplier for ATR stop loss.             |
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
        donchian: function (high, low, length) {
            const upper = new Array(high.length).fill(NaN);
            const lower = new Array(high.length).fill(NaN);
            const middle = new Array(high.length).fill(NaN);

            for (let i = length - 1; i < high.length; i++) {
                const highSlice = high.slice(i - length + 1, i + 1);
                const lowSlice = low.slice(i - length + 1, i + 1);
                const highestHigh = Math.max.apply(null, highSlice);
                const lowestLow = Math.min.apply(null, lowSlice);
                upper[i] = highestHigh;
                lower[i] = lowestLow;
                middle[i] = (highestHigh + lowestLow) / 2;
            }
            return {
                upper: upper,
                lower: lower,
                middle: middle
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

        const STRATEGY_NAME = "Donchian_Breakout";
        const donchianPeriod = parseFloat((whatstrat && whatstrat.GQ_DONCHIAN_BREAKOUT_PERIOD) || 20);
        const atrPeriod = parseFloat((whatstrat && whatstrat.GQ_DONCHIAN_BREAKOUT_ATR_PERIOD) || 14);
        const atrMultiplier = parseFloat((whatstrat && whatstrat.GQ_DONCHIAN_BREAKOUT_ATR_MULT) || 2.0);

        const donchianData = indicator_helpers.donchian(candlesHigh, candlesLow, donchianPeriod);
        const atrValues = indicator_helpers.atr(candlesHigh, candlesLow, candlesClose, atrPeriod);

        const upperChannel = donchianData.upper[iLast - 1]; // Use previous candle's channel
        const middleChannel = donchianData.middle[iLast];
        const atr = atrValues[iLast];

        // ─── GUI Enhancement ───
        const isBreakout = candlesClose[iLast] > upperChannel;
        const isCrossBelowMiddle = store.state === "IN_POSITION" && ask < middleChannel;
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
            label: 'Price > Upper Chan',
            value: isBreakout ? '✔︎' : '✖︎',
            valueColor: isBreakout ? '#22c55e' : '#ef4444',
            tooltip: `Checks if the current price is above the upper Donchian Channel of the previous bar.\nPrice: ${candlesClose[iLast].toFixed(4)}\nUpper Chan: ${upperChannel.toFixed(4)}`
        });

        // Exit Conditions
        sidebar.push({
            label: 'Price < Mid Chan',
            value: isCrossBelowMiddle ? '✔︎' : '✖︎',
            valueColor: isCrossBelowMiddle ? '#22c55e' : '#ef4444',
            tooltip: `Primary exit: checks if the price has fallen below the middle of the Donchian Channel.\nPrice: ${ask.toFixed(4)}\nMid Chan: ${middleChannel.toFixed(4)}`
        }, {
            label: 'Stop Loss',
            value: isStopLossHit ? '✔︎' : '✖︎',
            valueColor: isStopLossHit ? '#22c55e' : '#ef4444',
            tooltip: `Secondary exit: checks if the price has hit the ATR-based stop loss.\nPrice: ${ask.toFixed(4)}\nStop: ${store.stopPrice.toFixed(4)}`
        });

        // Essential Extras
        sidebar.push({
            label: 'Exit Target',
            value: middleChannel ? middleChannel.toFixed(gb.data.pricePrecision || 4) : 'N/A',
            tooltip: 'The middle of the Donchian Channel, which is the primary take-profit target.'
        }, {
            label: 'ATR Stop Price',
            value: store.stopPrice > 0 ? store.stopPrice.toFixed(gb.data.pricePrecision || 4) : 'N/A',
            tooltip: `Calculated stop loss level based on ATR (${atrPeriod}) x ${atrMultiplier}.`
        });

        while (sidebar.length % 3 !== 0) {
            sidebar.push({ label: '', value: '' });
        }
        gb.data.pairLedger.sidebarExtras = sidebar;
        // ───────────────────────

        const configLog = `Config: GQ_DONCHIAN_BREAKOUT_PERIOD=${donchianPeriod}, GQ_DONCHIAN_BREAKOUT_ATR_PERIOD=${atrPeriod}, GQ_DONCHIAN_BREAKOUT_ATR_MULT=${atrMultiplier}`;
        const indicatorLog = `Indicators: Upper=${upperChannel ? upperChannel.toFixed(4) : 'N/A'}, Middle=${middleChannel ? middleChannel.toFixed(4) : 'N/A'}`;

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

            const isBreakout = candlesClose[iLast] > upperChannel;
            const wantToEnter = isBreakout;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog];

            if (!wantToEnter) {
                logParts.push(`Trigger: SKIP (Price ${candlesClose[iLast].toFixed(4)} <= Upper Channel ${upperChannel ? upperChannel.toFixed(4) : 'N/A'})`);
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

            logParts.push(`Trigger: BUY (Breakout above ${upperChannel.toFixed(4)}), Stop Loss will be set near ${store.pendingStopPrice.toFixed(4)}`);
            console.log(logParts.join(' '));
            await buyMarket(costQuote, exchangeName, pairName);
            store.pendingBuy = {
                time: Date.now()
            };
            return;
        }

        if (store.state === "IN_POSITION") {
            // ─── GUI Enhancement ───
            if (middleChannel) gb.data.pairLedger.customSellTarget = middleChannel;
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
            const isCrossBelowMiddle = ask < middleChannel;
            const wantToExit = isStopLossHit || isCrossBelowMiddle;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog, `Position: Entry=${store.entryPrice.toFixed(4)}, Stop=${store.stopPrice.toFixed(4)}`];

            if (!wantToExit) {
                logParts.push(`Trigger: SKIP (Ask ${ask.toFixed(4)} >= Middle Channel ${middleChannel ? middleChannel.toFixed(4) : 'N/A'} AND Ask >= Stop)`);
                console.log(logParts.join(' '));
                return;
            }

            let exitReason = isStopLossHit ?
                `STOP LOSS (Ask ${ask.toFixed(4)} < ${store.stopPrice.toFixed(4)})` :
                `EXIT (Crossed below Middle Channel ${middleChannel ? middleChannel.toFixed(4) : 'N/A'})`;

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
```


## ./gunbot_quant/gunbot_strategy_files/emacross.js
```
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
```


## ./gunbot_quant/gunbot_strategy_files/rsi_stoch_combo_tp.js
```
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

```


## ./gunbot_quant/gunbot_strategy_files/bb_reversion.js
```
/*
 * Gunbot Quant Strategy: BB_Reversion
 *
 * Summary:
 * A volatility-based mean-reversion strategy. It aims to buy when the
 * price drops below the lower Bollinger Band, anticipating a rebound
 * towards the mean.
 *
 * Logic:
 * --- Entry ---
 * Triggers a BUY when the price crosses down through the lower Bollinger Band.
 * --- Exit ---
 * Triggers a SELL when the price crosses back up above the middle Bollinger
 * Band line (the SMA).
 * --- Stop Loss ---
 * An initial stop loss is placed using the Average True Range (ATR).
 *
 * Configurable Parameters:
 * ---------------------------------------------------------------------------
 * | Key                      | Default | Description                      |
 * |--------------------------|---------|----------------------------------|
 * | GQ_BB_REVERSION_PERIOD   | 20      | Period for BB and SMA.           |
 * | GQ_BB_REVERSION_STD_DEV  | 2.0     | Standard deviation for BB.       |
 * | GQ_BB_REVERSION_ATR_PERIOD | 14      | Period for ATR (stop loss).      |
 * | GQ_BB_REVERSION_ATR_MULT | 2.5     | Multiplier for ATR stop loss.    |
 * ---------------------------------------------------------------------------
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
        sma: function(source, length) {
            const result = new Array(source.length).fill(NaN);
            if (source.length < length) return result;
            let sum = 0;
            for (let i = 0; i < length; i++) {
                sum += source[i];
            }
            result[length - 1] = sum / length;
            for (let i = length; i < source.length; i++) {
                sum = sum - source[i - length] + source[i];
                result[i] = sum / length;
            }
            return result;
        },
        stddev: function(source, length) {
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
        bollingerBands: function(source, length, mult) {
            const basis = this.sma(source, length);
            const dev = this.stddev(source, length);
            const upper = [];
            const lower = [];
            for (let i = 0; i < basis.length; i++) {
                if (isNaN(basis[i]) || isNaN(dev[i])) {
                    upper.push(NaN);
                    lower.push(NaN);
                } else {
                    upper.push(basis[i] + mult * dev[i]);
                    lower.push(basis[i] - mult * dev[i]);
                }
            }
            return {
                upper: upper,
                middle: basis,
                lower: lower
            };
        },
        atr: function(high, low, close, length) {
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
    const buyMarket = async function(amount, exchange, pair) {
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

    const sellMarket = async function(amount, exchange, pair) {
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

        const STRATEGY_NAME = "BB_Reversion";
        const bbPeriod = parseFloat((whatstrat && whatstrat.GQ_BB_REVERSION_PERIOD) || 20);
        const bbStdDev = parseFloat((whatstrat && whatstrat.GQ_BB_REVERSION_STD_DEV) || 2.0);
        const atrPeriod = parseFloat((whatstrat && whatstrat.GQ_BB_REVERSION_ATR_PERIOD) || 14);
        const atrMultiplier = parseFloat((whatstrat && whatstrat.GQ_BB_REVERSION_ATR_MULT) || 2.5);

        const bbands = indicator_helpers.bollingerBands(candlesClose, bbPeriod, bbStdDev);
        const atrValues = indicator_helpers.atr(candlesHigh, candlesLow, candlesClose, atrPeriod);
        const atr = atrValues[iLast];
        const lowerBand = bbands.lower[iLast];
        const middleBand = bbands.middle[iLast];

        // ─── GUI Enhancement ───
        const isCrossingDown = candlesClose[iLast - 1] > bbands.lower[iLast - 1] && candlesClose[iLast] < lowerBand;
        const isExitSignal = store.state === "IN_POSITION" && ask > middleBand;
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
            label: 'Price < Lower BB',
            value: isCrossingDown ? '✔︎' : '✖︎',
            valueColor: isCrossingDown ? '#22c55e' : '#ef4444',
            tooltip: `Checks if the price has crossed below the lower Bollinger Band.\nPrice: ${candlesClose[iLast].toFixed(4)}\nLower BB: ${lowerBand.toFixed(4)}`
        });

        // Exit Conditions
        sidebar.push({
            label: 'Price > Mid BB',
            value: isExitSignal ? '✔︎' : '✖︎',
            valueColor: isExitSignal ? '#22c55e' : '#ef4444',
            tooltip: `Checks if the price has crossed above the middle Bollinger Band (SMA).\nPrice: ${ask.toFixed(4)}\nMid BB: ${middleBand.toFixed(4)}`
        }, {
            label: 'Stop Loss',
            value: isStopLossHit ? '✔︎' : '✖︎',
            valueColor: isStopLossHit ? '#22c55e' : '#ef4444',
            tooltip: `Price drops below the calculated ATR-based stop price.\nPrice: ${ask.toFixed(4)}\nStop: ${store.stopPrice.toFixed(4)}`
        });

        // Essential Extras
        sidebar.push({
            label: 'Exit Target',
            value: middleBand ? middleBand.toFixed(gb.data.pricePrecision || 4) : 'N/A',
            tooltip: `The middle Bollinger Band, which is the target for take-profit.`
        }, {
            label: 'ATR Stop Price',
            value: store.stopPrice > 0 ? store.stopPrice.toFixed(gb.data.pricePrecision || 4) : 'N/A',
            tooltip: `Calculated stop loss level based on ATR (${atrPeriod}) x ${atrMultiplier}.`
        });

        while (sidebar.length % 3 !== 0) {
            sidebar.push({ label: '', value: '' });
        }
        gb.data.pairLedger.sidebarExtras = sidebar;
        // ───────────────────────

        const configLog = `Config: GQ_BB_REVERSION_PERIOD=${bbPeriod}, GQ_BB_REVERSION_STD_DEV=${bbStdDev}, GQ_BB_REVERSION_ATR_PERIOD=${atrPeriod}, GQ_BB_REVERSION_ATR_MULT=${atrMultiplier}`;
        const indicatorLog = `Indicators: LowerBB=${lowerBand ? lowerBand.toFixed(4) : 'N/A'}, MidBB=${middleBand ? middleBand.toFixed(4) : 'N/A'}, ATR=${atr ? atr.toFixed(4) : 'N/A'}`;

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

            const isCrossingDown = candlesClose[iLast - 1] > bbands.lower[iLast - 1] && candlesClose[iLast] < lowerBand;
            const wantToEnter = isCrossingDown;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog];

            if (!wantToEnter) {
                logParts.push(`Trigger: SKIP (Price ${candlesClose[iLast]} did not cross down LowerBB ${lowerBand ? lowerBand.toFixed(4) : 'N/A'})`);
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

            logParts.push(`Trigger: BUY (Price crossed down LowerBB), Stop Loss will be set near ${store.pendingStopPrice.toFixed(4)}`);
            console.log(logParts.join(' '));
            await buyMarket(costQuote, exchangeName, pairName);
            store.pendingBuy = {
                time: Date.now()
            };
            return;
        }

        if (store.state === "IN_POSITION") {
            // ─── GUI Enhancement ───
            if (middleBand) gb.data.pairLedger.customSellTarget = middleBand;
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
            const isExitSignal = ask > middleBand;
            const wantToExit = isStopLossHit || isExitSignal;
            const logParts = [`[${STRATEGY_NAME}]`, configLog, indicatorLog, `Position: Entry=${store.entryPrice.toFixed(4)}, Stop=${store.stopPrice.toFixed(4)}`];

            if (!wantToExit) {
                logParts.push(`Trigger: SKIP (Ask ${ask.toFixed(4)} <= MidBB ${middleBand ? middleBand.toFixed(4) : 'N/A'} AND Ask >= Stop)`);
                console.log(logParts.join(' '));
                return;
            }

            let exitReason = isStopLossHit ?
                `STOP LOSS (Ask ${ask.toFixed(4)} < ${store.stopPrice.toFixed(4)})` :
                `EXIT (Ask ${ask.toFixed(4)} > MidBB ${middleBand ? middleBand.toFixed(4) : 'N/A'})`;

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
```


## ./gunbot_quant/core/__init__.py
```

```


## ./gunbot_quant/core/utils.py
```
# gunbot_quant_tools/core/utils.py

import pandas as pd
import numpy as np
import datetime
import math
import json # NEW: Import json

# --- NEW: Custom Exception for Data-Related Errors ---
class DataValidationError(Exception):
    """Custom exception for errors related to data integrity or availability."""
    pass

# --- NEW: The correct way to handle NumPy types in JSON ---
class NumpyEncoder(json.JSONEncoder):
    """
    A custom JSONEncoder to handle NumPy data types that are not
    natively serializable by the standard json library.
    """
    def default(self, obj):
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            # Handle NaN and Infinity as null or string representations
            if np.isnan(obj):
                return None
            if np.isinf(obj):
                return float('inf') if obj > 0 else float('-inf')
            return float(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist() # Convert arrays to lists
        if isinstance(obj, (datetime.datetime, datetime.date, pd.Timestamp)):
            return obj.isoformat()
        if isinstance(obj, np.bool_):
            return bool(obj)
        # Let the base class default method raise the TypeError
        return super(NumpyEncoder, self).default(obj)

# --- DEPRECATED/SIMPLIFIED: No longer needed for numeric types ---
def stringify_dates(obj):
    """
    Recursively convert any datetime-like objects, special floats (inf, nan), 
    and NumPy numeric types to standard, JSON-serializable Python types.
    """
    if isinstance(obj, (pd.Timestamp, np.datetime64, datetime.date, datetime.datetime)):
        return obj.isoformat()
    if isinstance(obj, (np.integer, np.int64, np.int32)):
        return int(obj)
    
    if isinstance(obj, (float, np.floating, np.float64, np.float32)):
        if math.isnan(obj):
            return None  # Represent NaN as null in JSON
        if math.isinf(obj):
            return "Infinity" if obj > 0 else "-Infinity"
        return float(obj)

    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, dict):
        return {k: stringify_dates(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [stringify_dates(i) for i in obj]
    return obj
```


## ./gunbot_quant/core/indicators.py
```
# gunbot_quant_tools/core/indicators.py

import numpy as np
import pandas as pd
from numba import njit

# --- Centralized ADX Calculation ---
def calculate_adx_components(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int):
    # ... (existing code, no changes)
    plus_dm = np.empty_like(high); minus_dm = np.empty_like(high); tr = np.empty_like(high)
    plus_dm[0], minus_dm[0], tr[0] = np.nan, np.nan, np.nan
    for i in range(1, len(high)):
        move_up = high[i] - high[i-1]; move_down = low[i-1] - low[i]
        plus_dm[i] = move_up if move_up > move_down and move_up > 0 else 0
        minus_dm[i] = move_down if move_down > move_up and move_down > 0 else 0
        tr[i] = max(high[i] - low[i], abs(high[i] - close[i-1]), abs(low[i] - close[i-1]))
    atr = pd.Series(tr).ewm(alpha=1/period, adjust=False, min_periods=period).mean().to_numpy()
    safe_atr = np.where(atr == 0, 1, atr)
    plus_di = 100 * pd.Series(plus_dm).ewm(alpha=1/period, adjust=False, min_periods=period).mean().to_numpy() / safe_atr
    minus_di = 100 * pd.Series(minus_dm).ewm(alpha=1/period, adjust=False, min_periods=period).mean().to_numpy() / safe_atr
    dx_sum = plus_di + minus_di; dx = 100 * np.abs(plus_di - minus_di) / np.where(dx_sum == 0, 1, dx_sum)
    adx = pd.Series(dx).ewm(alpha=1/period, adjust=False, min_periods=period).mean().to_numpy()
    return adx, plus_di, minus_di

# --- Ichimoku Cloud Calculation ---
def calculate_ichimoku_components(high: np.ndarray, low: np.ndarray, close: np.ndarray, tenkan_p: int, kijun_p: int, senkou_p: int):
    # ... (existing code, no changes)
    tenkan = (pd.Series(high).rolling(window=tenkan_p).max() + pd.Series(low).rolling(window=tenkan_p).min()) / 2
    kijun = (pd.Series(high).rolling(window=kijun_p).max() + pd.Series(low).rolling(window=kijun_p).min()) / 2
    senkou_a = ((tenkan + kijun) / 2).shift(kijun_p)
    senkou_b = ((pd.Series(high).rolling(window=senkou_p).max() + pd.Series(low).rolling(window=senkou_p).min()) / 2).shift(kijun_p)
    chikou = pd.Series(close).shift(-kijun_p)
    return tenkan.to_numpy(), kijun.to_numpy(), senkou_a.to_numpy(), senkou_b.to_numpy(), chikou.to_numpy()

# --- Supertrend Calculation ---
@njit
def _supertrend_numba(high, low, close, atr, multiplier):
    # ... (existing code, no changes)
    n = len(close); st = np.full(n, np.nan); st_dir = np.full(n, 1)
    for i in range(1, n):
        upper_band = high[i-1] + multiplier * atr[i-1]; lower_band = low[i-1] - multiplier * atr[i-1]
        if close[i-1] <= st[i-1]: st[i] = min(upper_band, st[i-1])
        else: st[i] = max(lower_band, st[i-1])
        if close[i] > st[i]: st_dir[i] = 1
        else: st_dir[i] = -1
        if st_dir[i] > 0 and st_dir[i-1] < 0: st[i] = max(lower_band, st[i-1])
        elif st_dir[i] < 0 and st_dir[i-1] > 0: st[i] = min(upper_band, st[i-1])
    return st, st_dir

# --- NEW: Heikin Ashi Calculation ---
def calculate_heikin_ashi(o, h, l, c):
    ha_close = (o + h + l + c) / 4
    ha_open = np.empty_like(o)
    ha_open[0] = o[0]
    for i in range(1, len(o)):
        ha_open[i] = (ha_open[i-1] + ha_close[i-1]) / 2
    ha_high = np.maximum.reduce([h, ha_open, ha_close])
    ha_low = np.minimum.reduce([l, ha_open, ha_close])
    return ha_open, ha_high, ha_low, ha_close

# --- Core Technical Indicators ---
# ... (all existing numba functions: _sma_numba, _ema_numba, etc. remain unchanged)
@njit
def _sma_numba(arr, w):
    n = arr.size; out = np.empty(n, dtype=np.float64); out[:w-1] = np.nan; current_sum = np.sum(arr[:w]); out[w-1] = current_sum / w
    for i in range(w, n): current_sum += arr[i] - arr[i-w]; out[i] = current_sum / w
    return out

@njit
def _rolling_slope_numba(arr, w):
    """Calculates the rolling slope (linear regression) of an array."""
    n = arr.size
    out = np.empty(n, dtype=np.float64)
    out[:w-1] = np.nan
    # Denominator of the slope formula, which is constant for a given window size 'w'
    denom = w * (w**2 - 1) / 12.0
    if denom == 0: return out
    
    # Pre-calculate sums for the first window
    sum_y = np.sum(arr[:w])
    # x is just 0, 1, 2, ... w-1
    # sum_xy = sum(y_k * k) for k in 0..w-1
    sum_xy = 0.0
    for k in range(w):
        sum_xy += arr[k] * k
        
    for i in range(w - 1, n):
        if i >= w:
            old_y = arr[i-w]
            new_y = arr[i]
            # Efficiently update sum_y and sum_xy
            sum_xy -= (sum_y - old_y) # Subtract the old sum_y (without old_y)
            sum_xy += new_y * (w - 1) # Add the new value at the end of the window
            sum_y += new_y - old_y # Update sum_y

        mean_y = sum_y / w
        # The x-terms (0 to w-1) are constant, so sum(x) = w*(w-1)/2
        numer = sum_xy - mean_y * (w * (w - 1) / 2.0)
        out[i] = numer / denom
    return out

@njit
def _ema_numba(arr, w):
    n = arr.size; out = np.empty(n, dtype=np.float64); out[:w-1] = np.nan; multiplier = 2.0 / (w + 1.0); out[w-1] = np.mean(arr[:w])
    for i in range(w, n): out[i] = (arr[i] - out[i-1]) * multiplier + out[i-1]
    return out
@njit
def _rsi_numba(arr, w):
    n = arr.size; out = np.empty(n, dtype=np.float64); out[:w] = np.nan; delta = np.diff(arr); gain = np.where(delta > 0, delta, 0); loss = np.where(delta < 0, -delta, 0); avg_gain, avg_loss = np.mean(gain[:w]), np.mean(loss[:w])
    if avg_loss == 0: out[w] = 100.0
    else: out[w] = 100.0 - (100.0 / (1.0 + (avg_gain / avg_loss)))
    for i in range(w, n - 1):
        avg_gain = (avg_gain * (w - 1) + gain[i]) / w; avg_loss = (avg_loss * (w - 1) + loss[i]) / w
        if avg_loss == 0: out[i+1] = 100.0
        else: out[i+1] = 100.0 - (100.0 / (1.0 + (avg_gain / avg_loss)))
    return out
@njit
def _atr_numba(high, low, close, w):
    n = len(close); tr = np.empty(n-1, dtype=np.float64)
    for i in range(n-1): tr[i] = np.max(np.array([high[i+1] - low[i+1], abs(high[i+1] - close[i]), abs(low[i+1] - close[i])]))
    atr = np.empty(n, dtype=np.float64); atr[:w] = np.nan; atr[w] = np.mean(tr[:w])
    for i in range(w + 1, n): atr[i] = (atr[i-1] * (w - 1) + tr[i-1]) / w
    return atr
@njit
def _rolling_std_numba(arr, w):
    n = arr.size; out = np.empty(n, dtype=np.float64); out[:w-1] = np.nan
    for i in range(w-1, n): window = arr[i-w+1:i+1]; out[i] = np.std(window)
    return out
@njit
def _rolling_max_numba(arr, w):
    n = arr.size; out = np.empty(n, dtype=np.float64); out[:w-1] = np.nan
    for i in range(w-1, n): out[i] = np.max(arr[i-w+1:i+1])
    return out
@njit
def _rolling_min_numba(arr, w):
    n = arr.size; out = np.empty(n, dtype=np.float64); out[:w-1] = np.nan
    for i in range(w-1, n): out[i] = np.min(arr[i-w+1:i+1])
    return out

class IndicatorFactory:
    def __init__(self, df: pd.DataFrame):
        self.df = df
        self.open = df['open'].to_numpy(dtype=np.float64)
        self.close = df['close'].to_numpy(dtype=np.float64)
        self.high = df['high'].to_numpy(dtype=np.float64)
        self.low = df['low'].to_numpy(dtype=np.float64)
        self.indicators = {'open': self.open, 'close': self.close, 'high': self.high, 'low': self.low}

    def get_indicators(self, required_indicators: dict) -> dict:
        for ind_name, params in required_indicators.items():
            ind_name = ind_name.lower()
            if ind_name == 'sma':
                for p in params: self.indicators[f'sma_{p}'] = _sma_numba(self.close, p)
            elif ind_name == 'slope':
                for p in params:
                    # Slope is calculated on the SMA, not the raw close price
                    sma_key = f'sma_{p}'
                    if sma_key not in self.indicators:
                         self.indicators[sma_key] = _sma_numba(self.close, p)
                    self.indicators[f'slope_{p}'] = _rolling_slope_numba(self.indicators[sma_key], p)
            elif ind_name == 'ema':
                for p in params: self.indicators[f'ema_{p}'] = _ema_numba(self.close, p)
            # ... (all existing indicator blocks like rsi, atr, bbands, macd, adx, stoch, donchian, ichimoku, supertrend remain the same)
            elif ind_name == 'heikin_ashi':
                # Heikin Ashi is a special case with no params
                ha_o, ha_h, ha_l, ha_c = calculate_heikin_ashi(self.open, self.high, self.low, self.close)
                self.indicators['ha_open'] = ha_o
                self.indicators['ha_high'] = ha_h
                self.indicators['ha_low'] = ha_l
                self.indicators['ha_close'] = ha_c
            elif ind_name == 'keltner_channels':
                for p in params:
                    period, mult = p['period'], p['multiplier']
                    key = f"kc_{period}_{mult}"
                    atr_key = f"atr_{period}"
                    # Keltner depends on EMA and ATR
                    ema = _ema_numba(self.close, period)
                    if atr_key not in self.indicators:
                        self.indicators[atr_key] = _atr_numba(self.high, self.low, self.close, period)
                    atr = self.indicators[atr_key]
                    self.indicators[f'{key}_middle'] = ema
                    self.indicators[f'{key}_upper'] = ema + (atr * mult)
                    self.indicators[f'{key}_lower'] = ema - (atr * mult)
            # ... continue with all other elif blocks ...
            elif ind_name == 'rsi':
                for p in params: self.indicators[f'rsi_{p}'] = _rsi_numba(self.close, p)
            elif ind_name == 'atr':
                for p in params: self.indicators[f'atr_{p}'] = _atr_numba(self.high, self.low, self.close, p)
            elif ind_name == 'std':
                 for p in params: self.indicators[f'std_{p}'] = _rolling_std_numba(self.close, p)
            elif ind_name == 'bbands':
                for p in params:
                    period, std_dev = p['period'], p['std_dev']
                    key = f"bbands_{period}_{std_dev}"
                    middle = _sma_numba(self.close, period)
                    std = _rolling_std_numba(self.close, period)
                    self.indicators[f'{key}_middle'] = middle
                    self.indicators[f'{key}_upper'] = middle + (std * std_dev)
                    self.indicators[f'{key}_lower'] = middle - (std * std_dev)
            elif ind_name == 'macd':
                 for p in params:
                    key = f"macd_{p['fast_period']}_{p['slow_period']}_{p['signal_period']}"
                    ema_fast = _ema_numba(self.close, p['fast_period']); ema_slow = _ema_numba(self.close, p['slow_period'])
                    macd_line = ema_fast - ema_slow; signal_line = _ema_numba(macd_line, p['signal_period'])
                    self.indicators[f'{key}_macd'] = macd_line; self.indicators[f'{key}_signal'] = signal_line
            elif ind_name == 'adx':
                for p in params:
                    key = f"adx_{p}"; adx, plus_di, minus_di = calculate_adx_components(self.high, self.low, self.close, p)
                    self.indicators[f'{key}_adx'] = adx; self.indicators[f'{key}_plus_di'] = plus_di; self.indicators[f'{key}_minus_di'] = minus_di
            elif ind_name == 'stoch':
                for p in params:
                    k, d, s = p['k_period'], p['d_period'], p['slowing']
                    key = f"stoch_{k}_{d}_{s}"; low_k = pd.Series(self.low).rolling(window=k).min(); high_k = pd.Series(self.high).rolling(window=k).max()
                    k_line = 100 * (self.close - low_k) / (high_k - low_k); k_line = k_line.rolling(window=s).mean() # Slowing
                    d_line = k_line.rolling(window=d).mean()
                    self.indicators[f"{key}_k"] = k_line.to_numpy(); self.indicators[f"{key}_d"] = d_line.to_numpy()
            elif ind_name == 'donchian':
                for p in params:
                    key = f"donchian_{p}"; upper = _rolling_max_numba(self.high, p); lower = _rolling_min_numba(self.low, p)
                    self.indicators[f"{key}_upper"] = upper; self.indicators[f"{key}_lower"] = lower; self.indicators[f"{key}_middle"] = (upper + lower) / 2
            elif ind_name == 'ichimoku':
                 for p in params:
                    key = f"ichimoku_{p['tenkan']}_{p['kijun']}_{p['senkou']}"
                    tenkan, kijun, senkou_a, senkou_b, chikou = calculate_ichimoku_components(self.high, self.low, self.close, p['tenkan'], p['kijun'], p['senkou'])
                    self.indicators[f'{key}_tenkan'] = tenkan; self.indicators[f'{key}_kijun'] = kijun; self.indicators[f'{key}_senkou_a'] = senkou_a
                    self.indicators[f'{key}_senkou_b'] = senkou_b; self.indicators[f'{key}_chikou'] = chikou
            elif ind_name == 'supertrend':
                 for p in params:
                    period, mult = p['period'], p['multiplier']; key = f"supertrend_{period}_{mult}"; atr_key = f"atr_{period}"
                    if atr_key not in self.indicators: self.indicators[atr_key] = _atr_numba(self.high, self.low, self.close, period)
                    st_line, st_dir = _supertrend_numba(self.high, self.low, self.close, self.indicators[atr_key], mult)
                    self.indicators[f'{key}_line'] = st_line; self.indicators[f'{key}_dir'] = st_dir
        return self.indicators
```


## ./gunbot_quant/core/screener.py
```
# gunbot_quant_tools/core/screener.py

import pandas as pd
import numpy as np
from binance.client import Client
import ccxt
import os
from tqdm import tqdm
import time
from datetime import datetime, timedelta
import yfinance as yf
import traceback

from .data_manager import DataManager
from .indicators import _rsi_numba, _atr_numba, calculate_adx_components, _sma_numba

class Screener:
    """Analyzes the market to find promising symbols based on dynamic filter criteria."""
    def __init__(self, exchange: str, config: dict):
        self.exchange_id = exchange.lower()
        self.config = config
        
        self.is_yfinance = self.exchange_id == 'yfinance'
        self.is_ccxt = not self.is_yfinance and self.exchange_id != 'binance'

        self.data_manager = DataManager(exchange=self.exchange_id)

        if self.is_ccxt:
            try:
                exchange_class = getattr(ccxt, self.exchange_id)
                self.client = exchange_class()
                self.client.load_markets()
                self.ccxt_to_clean_map = {}
                self.clean_to_ccxt_map = {}
                for m in self.client.markets.values():
                    if not (m.get('base') and m.get('quote')): continue
                    clean_symbol = m['base'] + m['quote']
                    if m.get('spot'):
                        self.ccxt_to_clean_map[m['symbol']] = clean_symbol
                        self.clean_to_ccxt_map[clean_symbol] = m['symbol']
                    elif m.get('swap') and clean_symbol not in self.clean_to_ccxt_map:
                        self.ccxt_to_clean_map[m['symbol']] = clean_symbol
                        self.clean_to_ccxt_map[clean_symbol] = m['symbol']
            except AttributeError:
                raise ValueError(f"Exchange '{self.exchange_id}' not found in CCXT.")
        elif not self.is_yfinance:
            self.client = Client(os.environ.get("BINANCE_API_KEY"), os.environ.get("BINANCE_API_SECRET"))
        
        self.quote_asset = config.get('SCREENER_QUOTE_ASSET', 'USDT')
        self.timeframe = config.get('timeframe', config.get('TIMEFRAME', '1d'))
        self.valid_conditions = ['greater_than', 'less_than', 'between']

    def get_top_symbols(self) -> list:
        print(f"\n--- Starting Advanced Market Screener on {self.exchange_id.capitalize()} ---")
        candidate_symbols = self._get_candidate_symbols()
        if not candidate_symbols:
            print("Screener found no candidate symbols. Aborting.")
            return []
        analysis_df = self._analyze_candidates(candidate_symbols)
        if analysis_df.empty:
            print("Screener analysis yielded no results. Aborting.")
            return []
        top_symbols = self._filter_and_rank(analysis_df)
        print(f"--- Screener Finished: Found {len(top_symbols)} promising symbols ---")
        if top_symbols:
            print(f"Top symbols: {', '.join(top_symbols)}")
        return top_symbols

    def get_top_usdt_symbols(self, n: int = 20) -> list:
        print(f"Fetching top {n} {self.quote_asset} symbols by volume from {self.exchange_id.capitalize()}...")
        symbols = self._get_candidate_symbols(count=n)
        print(f"Found: {', '.join(symbols)}")
        return symbols

    def _get_candidate_symbols(self, count: int = 0) -> list:
        if self.is_yfinance:
            symbols = self.config.get('SYMBOLS', [])
            print(f"Step 1: Using manual list of {len(symbols)} tickers for Yahoo Finance analysis.")
            return symbols

        n = count if count > 0 else self.config.get('SCREENER_CANDIDATE_COUNT', 200)
        print(f"Step 1: Fetching top {n} {self.quote_asset} symbols by volume...")

        if self.is_ccxt:
            tickers = self.client.fetch_tickers()
            df = pd.DataFrame.from_dict(tickers, orient='index')
            df.dropna(subset=['quoteVolume', 'symbol'], inplace=True)
            target_ccxt_symbols = {
                ccxt_sym for ccxt_sym, clean_sym in self.ccxt_to_clean_map.items() 
                if clean_sym.endswith(self.quote_asset)
            }
            if not target_ccxt_symbols:
                 print(f"Warning: No markets found for quote asset {self.quote_asset} on {self.exchange_id}")
                 return []
            quote_pairs = df[df['symbol'].isin(target_ccxt_symbols)].copy()
            quote_pairs['symbol'] = quote_pairs['symbol'].map(self.ccxt_to_clean_map)
        else:
            all_tickers = pd.DataFrame(self.client.get_ticker())
            quote_pairs = all_tickers[all_tickers.symbol.str.endswith(self.quote_asset)]
        
        if quote_pairs.empty:
            print(f"Warning: No symbols found for quote asset {self.quote_asset} on {self.exchange_id}")
            return []
            
        exclude_list = ['UP', 'DOWN', 'BULL', 'BEAR', 'USDC', 'EUR', 'FDUSD', 'TUSD', 'BUSD']
        active_exclude_list = [item for item in exclude_list if item != self.quote_asset]
        for item in active_exclude_list:
            quote_pairs = quote_pairs[~quote_pairs.symbol.str.contains(item, na=False)]
            
        quote_pairs['quoteVolume'] = pd.to_numeric(quote_pairs['quoteVolume'])
        return quote_pairs.sort_values(by='quoteVolume', ascending=False).head(n).symbol.tolist()
    
    def _get_start_str_for_timeframe(self, timeframe: str, candles: int) -> str:
        timeframe_map = {
            '1m': timedelta(minutes=1), '3m': timedelta(minutes=3), '5m': timedelta(minutes=5),
            '15m': timedelta(minutes=15), '30m': timedelta(minutes=30),
            '1h': timedelta(hours=1), '2h': timedelta(hours=2), '4h': timedelta(hours=4),
            '6h': timedelta(hours=6), '8h': timedelta(hours=8), '12h': timedelta(hours=12),
            '1d': timedelta(days=1), '3d': timedelta(days=3), '1w': timedelta(weeks=1),
        }
        delta_per_candle = timeframe_map.get(timeframe)
        if not delta_per_candle:
            days_to_subtract = 90
            print(f"Warning: Non-fixed timeframe '{timeframe}'. Defaulting to {days_to_subtract} days ago.")
            start_date = datetime.utcnow() - timedelta(days=days_to_subtract)
        else:
            total_delta = delta_per_candle * candles
            start_date = datetime.utcnow() - total_delta
        
        return start_date.strftime("%Y-%m-%d")

    def _analyze_candidates(self, symbols: list) -> pd.DataFrame:
        print(f"Step 2: Analyzing {len(symbols)} candidates on the {self.timeframe} timeframe...")
        if not symbols: return pd.DataFrame()
        
        start_str_for_api = self.config.get('BACKTEST_START_DATE')
        end_str_for_api = self.config.get('BACKTEST_END_DATE')

        if not start_str_for_api:
            required_candles = 500
            start_str_for_api = self._get_start_str_for_timeframe(self.timeframe, required_candles)
            print(f"Using auto-generated date range for analysis, starting from: {start_str_for_api}.")
        else:
            print(f"Using explicit date range for analysis: {start_str_for_api} to {end_str_for_api or 'now'}")
            
        daily_start_date = (datetime.utcnow() - timedelta(days=365)).strftime("%Y-%m-%d")
        today_date = datetime.utcnow().strftime("%Y-%m-%d")

        all_metrics = []
        for symbol in tqdm(symbols, desc="Analyzing Symbols"):
            try:
                # --- FIX: Call get_data with strict_start_date=False ---
                daily_df = self.data_manager.get_data(symbol, '1d', daily_start_date, today_date, warmup_candles=0, strict_start_date=False)
                if len(daily_df) < 90: continue
                daily_df['qav'] = daily_df['vol'] * daily_df['close']
                
                df = self.data_manager.get_data(symbol, self.timeframe, start_str_for_api, end_str_for_api or today_date, warmup_candles=0, strict_start_date=False)
                if len(df) < 201: continue
                # --- End of Fix ---
                
                metrics = {'symbol': symbol}
                c, h, l = df['close'].to_numpy(), df['high'].to_numpy(), df['low'].to_numpy()

                if self.is_yfinance:
                    metrics['avg_vol_30d'] = daily_df['vol'].tail(30).mean()
                    metrics['rel_vol_10d'] = daily_df['vol'].iloc[-1] / daily_df['vol'].tail(10).mean() if daily_df['vol'].tail(10).mean() > 0 else np.nan
                else:
                    metrics['avg_vol_30d_quote'] = daily_df['qav'].tail(30).mean()
                    metrics['rel_vol_10d_quote'] = daily_df['qav'].iloc[-1] / daily_df['qav'].tail(10).mean() if daily_df['qav'].tail(10).mean() > 0 else np.nan

                for p in [7, 14, 30, 90, 200]:
                    if len(c) > p: metrics[f'roc_{p}p'] = (c[-1] - c[-1-p]) / c[-1-p] * 100 if c[-1-p] > 0 else np.nan
                metrics['dist_from_ath_lookback_pct'] = (c[-1] - df['high'].max()) / df['high'].max() * 100 if df['high'].max() > 0 else np.nan
                atr14 = _atr_numba(h, l, c, 14); metrics['atr_pct_14p'] = (atr14[-1] / c[-1]) * 100 if c[-1] > 0 else 0
                sma50, sma200 = _sma_numba(c, 50), _sma_numba(c, 200)
                metrics['price_vs_sma50'] = (c[-1] - sma50[-1]) / sma50[-1] * 100 if not np.isnan(sma50[-1]) and sma50[-1] > 0 else np.nan
                metrics['price_vs_sma200'] = (c[-1] - sma200[-1]) / sma200[-1] * 100 if not np.isnan(sma200[-1]) and sma200[-1] > 0 else np.nan
                metrics['sma50_vs_sma200'] = (sma50[-1] - sma200[-1]) / sma200[-1] * 100 if not np.isnan(sma200[-1]) and sma200[-1] > 0 else np.nan
                rsi14 = _rsi_numba(c, 14); metrics['rsi_14p'] = rsi14[-1]
                adx14, _, _ = calculate_adx_components(h, l, c, 14); metrics['adx_14p'] = adx14[-1]
                rsi_series = pd.Series(_rsi_numba(c, 14)); stoch_length = 14
                min_rsi = rsi_series.rolling(window=stoch_length).min(); max_rsi = rsi_series.rolling(window=stoch_length).max()
                range_rsi = max_rsi - min_rsi; raw_stoch_rsi = 100 * (rsi_series - min_rsi) / range_rsi.replace(0, np.nan)
                smooth_k = 3; stoch_k = raw_stoch_rsi.rolling(window=smooth_k).mean()
                smooth_d = 3; stoch_d = stoch_k.rolling(window=smooth_d).mean()
                metrics['stochrsi_k_14_3_3'] = stoch_k.iloc[-1]; metrics['stochrsi_d_14_3_3'] = stoch_d.iloc[-1]
                daily_atr = _atr_numba(daily_df['high'].to_numpy(), daily_df['low'].to_numpy(), daily_df['close'].to_numpy(), 14)
                daily_df['atr_pct'] = (daily_atr / daily_df['close']) * 100
                metrics['volatility_consistency'] = daily_df['atr_pct'].tail(90).std()
                daily_df['day_range_pct'] = ((daily_df['high'] - daily_df['low']) / daily_df['low']) * 100
                metrics['max_daily_spike_pct'] = daily_df['day_range_pct'].tail(90).max()
                total_vol_90d = daily_df['vol'].tail(90).sum()
                top_3_vol_days = daily_df['vol'].tail(90).nlargest(3).sum()
                metrics['volume_concentration_pct'] = (top_3_vol_days / total_vol_90d) * 100 if total_vol_90d > 0 else 100
                all_metrics.append(metrics)
            except Exception as e:
                print(f"An error occurred while analyzing {symbol}: {e}")
                traceback.print_exc(limit=1)
        
        return pd.DataFrame(all_metrics)

    def _filter_and_rank(self, df: pd.DataFrame) -> list:
        print(f"\nStep 3: Dynamically filtering and ranking {len(df)} initial symbols...")
        if self.is_yfinance: # Rename volume metric for yfinance filters
            df.rename(columns={'avg_vol_30d': 'avg_vol_30d_quote'}, inplace=True)

        df.dropna(inplace=True)
        print(f"Found {len(df)} symbols with complete metric data.")
        if df.empty: return []
        filters = self.config.get('SCREENER_FILTERS', [])
        for f in filters:
            metric, condition, value = f.get('metric'), f.get('condition'), f.get('value')
            if not all([metric, condition, value is not None]): continue
            if metric not in df.columns: continue
            if condition not in self.valid_conditions: continue
            if condition == 'greater_than': df = df[df[metric] > value]
            elif condition == 'less_than': df = df[df[metric] < value]
            elif condition == 'between' and isinstance(value, list) and len(value) == 2:
                df = df[df[metric].between(value[0], value[1])]
            print(f"  - After filter '{metric} {condition} {value}', {len(df)} symbols remain.")
        print(f"Filtering complete. {len(df)} symbols passed all filters.")
        
        final_count = self.config.get('SCREENER_FINAL_COUNT', len(df)) if not self.is_yfinance else len(df)
        
        df = df.sort_values(by=self.config.get('SCREENER_RANK_METRIC', 'roc_30p'), ascending=False)
        return df['symbol'].head(final_count).tolist()

    def filter_by_heuristics(self, df: pd.DataFrame) -> list:
        print("\nStep 2b: Applying heuristic quality filters...")
        initial_count = len(df)
        if initial_count == 0: return []
        volatility_threshold = self.config.get('HEURISTIC_VOLATILITY_CONSISTENCY_MAX', 5.0)
        df_filtered = df[df['volatility_consistency'] < volatility_threshold]
        print(f"  - After volatility consistency filter (< {volatility_threshold}), {len(df_filtered)} of {initial_count} symbols remain.")
        spike_threshold = self.config.get('HEURISTIC_MAX_DAILY_SPIKE_PCT_MAX', 40.0)
        df_filtered = df_filtered[df_filtered['max_daily_spike_pct'] < spike_threshold]
        print(f"  - After daily spike filter (< {spike_threshold}%), {len(df_filtered)} symbols remain.")
        concentration_threshold = self.config.get('HEURISTIC_VOLUME_CONCENTRATION_PCT_MAX', 30.0)
        df_filtered = df_filtered[df_filtered['volume_concentration_pct'] < concentration_threshold]
        print(f"  - After volume concentration filter (< {concentration_threshold}%), {len(df_filtered)} symbols remain.")
        print(f"Heuristic filtering complete. {len(df_filtered)} symbols passed quality checks.")
        return df_filtered['symbol'].tolist()
```


## ./gunbot_quant/core/data_manager.py
```
# gunbot_quant_tools/core/data_manager.py

import os
import time
import traceback
import logging
import warnings
from datetime import datetime, timedelta, timezone

import pandas as pd
from tqdm import tqdm
from binance.client import Client
import ccxt
import yfinance as yf
try:
    from yfinance.exceptions import YFPricesMissingError
except Exception:
    class YFPricesMissingError(Exception):
        pass

from ..core.utils import DataValidationError

# ---------------------------------------------------------------------
# Silence noisy logs
# ---------------------------------------------------------------------
logging.getLogger("yfinance").setLevel(logging.CRITICAL)
logging.getLogger("yfinance").propagate = False
warnings.filterwarnings("ignore", category=FutureWarning, message=".*'H' is deprecated.*")

# ---------------------------------------------------------------------
# Yahoo constants and helpers
# ---------------------------------------------------------------------
YF_INTERVAL_MAX_RANGE = {
    '1m':  '7d',
    '2m':  '60d',
    '5m':  '60d',
    '15m': '60d',
    '30m': '60d',
    '60m': '730d',
    '90m': '60d',
    '1d':  'max',
    '5d':  'max',
    '1wk': 'max',
    '1mo': 'max',
    '3mo': 'max',
}

YF_INTERVAL_ALIAS = {
    '1h': '60m', '2h': '60m', '3h': '60m', '4h': '60m',
    '6h': '60m', '8h': '60m', '12h': '60m'
}


def _yf_normalize_interval(interval: str) -> tuple[str, str | None]:
    if interval in YF_INTERVAL_MAX_RANGE:
        return interval, None
    if interval in YF_INTERVAL_ALIAS:
        return YF_INTERVAL_ALIAS[interval], interval
    raise ValueError(f"Unsupported yfinance interval {interval}")


def _flatten_yf(df: pd.DataFrame, symbol: str) -> pd.DataFrame:
    if isinstance(df.columns, pd.MultiIndex):
        try:
            df = df.xs(symbol, axis=1, level=-1)
        except Exception:
            df.columns = ['_'.join([str(x) for x in c if x]) for c in df.columns]
    return df


def _extract_ohlcv(df: pd.DataFrame, ts_col: str) -> pd.DataFrame:
    cols_lower = {c.lower(): c for c in df.columns}
    req = ['open', 'high', 'low', 'close', 'volume']
    if not all(k in cols_lower for k in req):
        raise KeyError(f"Missing OHLCV columns in dataframe: {df.columns}")
    out = pd.DataFrame({
        'ts':    pd.to_datetime(df[ts_col], utc=True),
        'open':  pd.to_numeric(df[cols_lower['open']], errors='coerce'),
        'high':  pd.to_numeric(df[cols_lower['high']], errors='coerce'),
        'low':   pd.to_numeric(df[cols_lower['low']],  errors='coerce'),
        'close': pd.to_numeric(df[cols_lower['close']], errors='coerce'),
        'vol':   pd.to_numeric(df[cols_lower['volume']], errors='coerce')
    })
    out = out.dropna(subset=['ts']).drop_duplicates('ts').sort_values('ts').reset_index(drop=True)
    return out


def _resample_ohlc(df: pd.DataFrame, target: str) -> pd.DataFrame:
    if df.empty:
        return df
    df = df.copy()
    df['ts'] = pd.to_datetime(df['ts'], utc=True)
    rule = target.lower()
    ohlc = {'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last', 'vol': 'sum'}
    out = (df.set_index('ts')
             .resample(rule, label='right', closed='right')
             .agg(ohlc)
             .dropna()
             .reset_index())
    return out


def _yf_fetch_all_intraday(symbol: str, interval: str) -> pd.DataFrame:
    cap = YF_INTERVAL_MAX_RANGE[interval]
    assert cap != 'max'
    chunks = []
    end_cursor = None
    last_first_ts = None

    for _ in range(250):
        try:
            kwargs = dict(
                tickers=symbol,
                interval=interval,
                period=cap,
                end=end_cursor,
                progress=False,
                auto_adjust=True,
                group_by='column',
                threads=False
            )
            df_chunk = yf.download(**kwargs)
        except YFPricesMissingError:
            break
        except Exception as e:
            print(f"  yfinance chunk error for {symbol}: {e}")
            break

        if df_chunk.empty:
            break

        df_chunk = _flatten_yf(df_chunk, symbol).reset_index()
        ts_col = 'Datetime' if 'Datetime' in df_chunk.columns else 'Date'
        df_chunk[ts_col] = pd.to_datetime(df_chunk[ts_col], utc=True)

        first_ts = df_chunk[ts_col].min()
        if last_first_ts is not None and first_ts >= last_first_ts:
            break
        last_first_ts = first_ts

        chunks.append(df_chunk)

        end_cursor = (first_ts - pd.Timedelta(milliseconds=1)).to_pydatetime()

    if not chunks:
        return pd.DataFrame(columns=['ts', 'open', 'high', 'low', 'close', 'vol'])

    chunks.reverse()
    df_all = pd.concat(chunks, ignore_index=True)
    ts_col = 'Datetime' if 'Datetime' in df_all.columns else 'Date'
    return _extract_ohlcv(df_all, ts_col)


# ---------------------------------------------------------------------
# DataManager
# ---------------------------------------------------------------------
class DataManager:
    def __init__(self, exchange: str, data_dir: str = 'data'):
        self.exchange_id = exchange.lower()
        self.data_dir = data_dir

        self.is_yfinance = self.exchange_id == 'yfinance'
        self.is_ccxt = not self.is_yfinance and self.exchange_id != 'binance'
        self.client = None

        if not os.path.exists(self.data_dir):
            os.makedirs(self.data_dir)

        try:
            if self.is_ccxt:
                exchange_class = getattr(ccxt, self.exchange_id)
                self.client = exchange_class()
                self.client.load_markets()
            elif not self.is_yfinance:
                self.client = Client(os.environ.get("BINANCE_API_KEY"), os.environ.get("BINANCE_API_SECRET"))
        except AttributeError:
            raise ValueError(f"Exchange '{self.exchange_id}' not found in CCXT.")
        except Exception as e:
            print(f"Failed to initialize client for {self.exchange_id}: {e}")

    def get_top_usdt_symbols(self, n: int = 20) -> list:
        if self.is_yfinance:
            print("Ranking symbols by volume is not applicable for Yahoo Finance. Returning a default list.")
            return ['SPY', 'QQQ', 'AAPL', 'MSFT', 'GOOGL', 'NVDA', 'TSLA', 'AMZN', 'META', 'JPM']

        if not self.client:
            print(f"Client for {self.exchange_id} is not initialized. Cannot fetch symbols.")
            return []

        print(f"Fetching top {n} USDT symbols by volume from {self.exchange_id.capitalize()}...")
        symbols = []
        try:
            if self.is_ccxt:
                tickers = self.client.fetch_tickers()
                spot_usdt_markets = [
                    mkt['symbol'] for mkt in self.client.markets.values()
                    if mkt.get('spot') and mkt.get('quote', '').upper() == 'USDT'
                ]
                usdt_tickers = [tickers[s] for s in spot_usdt_markets if s in tickers and tickers[s].get('quoteVolume') is not None]
                if not usdt_tickers:
                    print(f"Warning: No USDT spot tickers with volume data found on {self.exchange_id}.")
                    return []
                df = pd.DataFrame.from_records(usdt_tickers)
                df = df[~df['symbol'].str.contains('UP/') & ~df['symbol'].str.contains('DOWN/')]
                df = df[~df['symbol'].str.contains('BULL/') & ~df['symbol'].str.contains('BEAR/')]
                top_symbols_df = df.sort_values(by='quoteVolume', ascending=False).head(n)
                symbols = top_symbols_df.symbol.tolist()
            else:
                all_tickers = pd.DataFrame(self.client.get_ticker())
                usdt_pairs = all_tickers[all_tickers.symbol.str.endswith('USDT')]
                exclude_list = ['UP', 'DOWN', 'USDC', 'EUR', 'FDUSD', 'TUSD', 'BUSD']
                for item in exclude_list:
                    usdt_pairs = usdt_pairs[~usdt_pairs.symbol.str.contains(item)]
                usdt_pairs['quoteVolume'] = pd.to_numeric(usdt_pairs['quoteVolume'])
                top_symbols = usdt_pairs.sort_values(by='quoteVolume', ascending=False).head(n)
                symbols = top_symbols.symbol.tolist()
            print(f"Found: {', '.join(symbols)}")
        except Exception as e:
            print(f"!!! Could not fetch top symbols for {self.exchange_id}: {e}")
            traceback.print_exc(limit=1)
        return symbols

    def _get_filepath(self, symbol: str, timeframe: str) -> str:
        exchange_dir = os.path.join(self.data_dir, self.exchange_id)
        if not os.path.exists(exchange_dir):
            os.makedirs(exchange_dir)
        tf_dir = os.path.join(exchange_dir, timeframe)
        if not os.path.exists(tf_dir):
            os.makedirs(tf_dir)
        sanitized_symbol = symbol.replace('/', '_')
        return os.path.join(tf_dir, f"{sanitized_symbol}.parquet")

    def _get_required_download_start_info(self, timeframe: str, backtest_start_str: str, warmup_candles: int) -> tuple[datetime, str]:
        if self.is_yfinance:
            dt = pd.to_datetime("1970-01-01", utc=True)
            return dt, "1970-01-01"

        try:
            backtest_start_dt = pd.to_datetime(backtest_start_str, utc=True)
            candle_duration_ms = 86400000
            if self.is_ccxt and hasattr(self.client, 'timeframes') and self.client.timeframes and self.client.timeframes.get(timeframe):
                candle_duration_ms = self.client.parse_timeframe(timeframe) * 1000
            else:
                timeframe_map_ms = {
                    '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000,
                    '1h': 3600000, '2h': 7200000, '4h': 14400000, '6h': 21600000, '8h': 28800000,
                    '12h': 43200000, '1d': 86400000, '3d': 259200000, '1w': 604800000
                }
                candle_duration_ms = timeframe_map_ms.get(timeframe.lower(), 86400000)

            warmup_delta = timedelta(milliseconds=candle_duration_ms * (warmup_candles + 5))
            required_start_dt = backtest_start_dt - warmup_delta
            return required_start_dt, required_start_dt.strftime("%Y-%m-%d")
        except (KeyError, TypeError, ValueError):
            print("Warning: Could not precisely calculate download start date. Defaulting to '2017-01-01'.")
            required_start_dt = pd.to_datetime("2017-01-01", utc=True)
            return required_start_dt, "2017-01-01"

    def warm_data_cache(self, symbols: list, timeframe: str, config: dict):
        required_download_start_dt, initial_download_start_str = self._get_required_download_start_info(
            timeframe, config['BACKTEST_START_DATE'], config['TECHNICAL_WARMUP_PERIOD']
        )
        symbols_to_update = []
        for symbol in symbols:
            filepath = self._get_filepath(symbol, timeframe)
            if not os.path.exists(filepath):
                symbols_to_update.append(symbol)
            else:
                try:
                    df = pd.read_parquet(filepath)
                    if df.empty:
                        symbols_to_update.append(symbol)
                        continue

                    cache_start_ts = pd.to_datetime(df['ts'].iloc[0], utc=True)
                    cache_end_ts = pd.to_datetime(df['ts'].iloc[-1], utc=True)

                    is_end_stale = (datetime.now(timezone.utc) - cache_end_ts) > timedelta(days=2)
                    is_start_missing = cache_start_ts.date() > required_download_start_dt.date()

                    if is_end_stale or is_start_missing:
                        if is_start_missing:
                            print(f"Cache for {symbol} is incomplete for the requested period. Forcing full re-download.")
                            try:
                                os.remove(filepath)
                            except OSError as e:
                                print(f"Error removing old cache file: {e}")
                        symbols_to_update.append(symbol)
                except Exception:
                    symbols_to_update.append(symbol)

        if not symbols_to_update:
            print(f"All required data from {self.exchange_id.capitalize()} is already cached and up-to-date.")
            return

        print(f"Updating/downloading historical data for {len(symbols_to_update)} symbols from {self.exchange_id.capitalize()}...")
        for symbol in tqdm(symbols_to_update, desc="Warming Data Cache"):
            filepath = self._get_filepath(symbol, timeframe)
            self._download_and_save_data(symbol, timeframe, filepath, initial_download_start_str=initial_download_start_str)

    def get_data(self, symbol: str, timeframe: str, start_date_str: str, end_date_str: str, warmup_candles: int, strict_start_date: bool = True) -> pd.DataFrame:
        filepath = self._get_filepath(symbol, timeframe)
        required_start_dt, download_start_str = self._get_required_download_start_info(timeframe, start_date_str, warmup_candles)

        if not os.path.exists(filepath) or os.path.getsize(filepath) == 0:
            print(f"Cache miss for {symbol}. Downloading entire required history...")
            self._download_and_save_data(symbol, timeframe, filepath, initial_download_start_str=download_start_str)

        try:
            df = pd.read_parquet(filepath)
        except Exception as e:
            print(f"Could not read cache file {filepath}. Error: {e}")
            return pd.DataFrame()

        if not df.empty and pd.to_datetime(df['ts'].iloc[0], utc=True).date() > required_start_dt.date() and not self.is_yfinance:
            print(f"Cached data for {symbol} is insufficient for the requested start date {start_date_str} with {warmup_candles} warmup candles. Forcing full re-download...")
            self._download_and_save_data(symbol, timeframe, filepath, initial_download_start_str=download_start_str)
            try:
                df = pd.read_parquet(filepath)
            except Exception as e:
                print(f"Could not read cache file after re-download {filepath}. Error: {e}")
                return pd.DataFrame()

        if df.empty:
            return pd.DataFrame()

        df['ts'] = pd.to_datetime(df['ts'], utc=True)
        backtest_start_date = pd.to_datetime(start_date_str, utc=True)
        backtest_end_date = pd.to_datetime(end_date_str, utc=True) + timedelta(days=1)

        start_iloc = df['ts'].searchsorted(backtest_start_date, side='left')
        end_iloc = df['ts'].searchsorted(backtest_end_date, side='right')

        warmup_start_iloc = max(0, start_iloc - warmup_candles)

        if strict_start_date and (start_iloc - warmup_start_iloc) < warmup_candles and not self.is_yfinance:
            actual_start_in_cache = df['ts'].iloc[0]
            error_message = (
                f"Backtest requires {warmup_candles} warmup candles, but only {start_iloc - warmup_start_iloc} are available in the data before the start date {start_date_str}.\n\n"
                f"The earliest data available from the {self.exchange_id.upper()} API is {actual_start_in_cache.strftime('%Y-%m-%d')}.\n\n"
                f"This is common for assets with limited history or due to API limits. Please try a shorter backtest period or a smaller warmup period."
            )
            raise DataValidationError(error_message)

        final_df = df.iloc[warmup_start_iloc:end_iloc].copy()

        if final_df.empty:
            return pd.DataFrame()
        return final_df.reset_index(drop=True)

    def _download_and_save_data(self, symbol: str, timeframe: str, filepath: str, initial_download_start_str: str = "2017-01-01"):
        if self.is_yfinance:
            self._download_yfinance(symbol, timeframe, filepath, initial_download_start_str)
        elif self.is_ccxt:
            self._download_ccxt(symbol, timeframe, filepath, initial_download_start_str)
        else:
            self._download_binance(symbol, timeframe, filepath, initial_download_start_str)

    def _download_yfinance(self, symbol: str, timeframe: str, filepath: str, initial_download_start_str: str):
        try:
            yf_interval, resample_target = _yf_normalize_interval(timeframe)

            existing_df = None
            if os.path.exists(filepath):
                try:
                    existing_df = pd.read_parquet(filepath)
                except Exception as e:
                    print(f"Could not read existing cache for {symbol}: {e}")

            cap = YF_INTERVAL_MAX_RANGE[yf_interval]

            if cap == 'max':
                raw = yf.download(
                    tickers=symbol,
                    interval=yf_interval,
                    period='max',
                    progress=False,
                    auto_adjust=True,
                    group_by='column',
                    threads=False
                )
                if raw.empty:
                    print(f"  -> No data from Yahoo for {symbol} interval={yf_interval}")
                    if existing_df is None:
                        pd.DataFrame(columns=['ts', 'open', 'high', 'low', 'close', 'vol']).to_parquet(filepath, index=False)
                    return
                raw = _flatten_yf(raw, symbol).reset_index()
                ts_col = 'Datetime' if 'Datetime' in raw.columns else 'Date'
                fetched_df = _extract_ohlcv(raw, ts_col)
            else:
                fetched_df = _yf_fetch_all_intraday(symbol, yf_interval)

            if resample_target:
                fetched_df = _resample_ohlc(fetched_df, resample_target)

            if existing_df is not None and not existing_df.empty:
                combined_df = (pd.concat([existing_df, fetched_df], ignore_index=True)
                               .drop_duplicates('ts', keep='last')
                               .sort_values('ts')
                               .reset_index(drop=True))
            else:
                combined_df = fetched_df

            os.makedirs(os.path.dirname(filepath), exist_ok=True)
            combined_df.to_parquet(filepath, index=False)
            print(f"  -> Saved {len(combined_df)} rows for {symbol} ({timeframe})")

        except Exception as e:
            print(f"!!! Could not download Yahoo Finance data for {symbol}: {e}")
            traceback.print_exc(limit=1)
            if not os.path.exists(filepath):
                pd.DataFrame(columns=['ts', 'open', 'high', 'low', 'close', 'vol']).to_parquet(filepath, index=False)

    def _download_ccxt(self, symbol: str, timeframe: str, filepath: str, initial_download_start_str: str):
        try:
            limit = 1000
            existing_df = None
            if os.path.exists(filepath):
                try:
                    existing_df = pd.read_parquet(filepath)
                except Exception:
                    existing_df = None

            ccxt_symbol_to_use = None
            if symbol in self.client.markets:
                ccxt_symbol_to_use = symbol
            else:
                clean_symbol_to_find = symbol.replace('/', '')
                for market_symbol, market_data in self.client.markets.items():
                    if market_data.get('base') and market_data.get('quote'):
                        if (market_data['base'] + market_data['quote']) == clean_symbol_to_find:
                            ccxt_symbol_to_use = market_symbol
                            break

            if not ccxt_symbol_to_use:
                print(f"!!! Symbol {symbol} not found on {self.exchange_id}. Skipping download.")
                pd.DataFrame().to_parquet(filepath)
                return

            all_klines_list = []
            start_dt = pd.to_datetime(initial_download_start_str, utc=True)
            if existing_df is not None and not existing_df.empty:
                last_cached_dt = pd.to_datetime(existing_df['ts'].iloc[-1], utc=True)
                start_dt = last_cached_dt + timedelta(seconds=1)
                all_klines_list = existing_df.values.tolist()

            end_dt = datetime.now(timezone.utc)
            if start_dt >= end_dt:
                return

            since = int(start_dt.timestamp() * 1000)
            while since < int(end_dt.timestamp() * 1000):
                try:
                    klines = self.client.fetch_ohlcv(ccxt_symbol_to_use, timeframe, since, limit)
                    if not klines:
                        break
                    last_ts = klines[-1][0]
                    all_klines_list.extend(klines)
                    since = last_ts + (self.client.parse_timeframe(timeframe) * 1000)
                    if hasattr(self.client, 'rateLimit'):
                        time.sleep(self.client.rateLimit / 1000)
                except ccxt.BadRequest as e:
                    if 'kline not found' in str(e).lower() or 'too long ago' in str(e).lower():
                        break
                    else:
                        raise e
                except Exception as e:
                    print(f"An error occurred during CCXT download for {symbol}: {e}")
                    time.sleep(10)
                    break

            if not all_klines_list:
                if existing_df is None:
                    pd.DataFrame().to_parquet(filepath)
                return

            df = pd.DataFrame(all_klines_list, columns=['ts', 'open', 'high', 'low', 'close', 'vol'])
            df['ts'] = pd.to_datetime(df['ts'], unit='ms', utc=True)
            df.drop_duplicates(subset='ts', keep='last', inplace=True)
            df.sort_values(by='ts', inplace=True)
            for c in ['open', 'high', 'low', 'close', 'vol']:
                df[c] = pd.to_numeric(df[c])
            df.to_parquet(filepath, index=False)
        except Exception as e:
            print(f"!!! Could not download CCXT data for {symbol}: {e}")
            traceback.print_exc(limit=1)

    def _download_binance(self, symbol: str, timeframe: str, filepath: str, initial_download_start_str: str = "2017-01-01"):
        try:
            start_str = initial_download_start_str.replace("-", " ")
            existing_df = None
            if os.path.exists(filepath):
                try:
                    existing_df = pd.read_parquet(filepath)
                    if not existing_df.empty and 'ts' in existing_df.columns:
                        last_ts = pd.to_datetime(existing_df['ts'].iloc[-1], utc=True)
                        start_dt = last_ts + timedelta(seconds=1)
                        start_str = start_dt.strftime("%d %b, %Y %H:%M:%S")
                except Exception as e:
                    print(f"Could not read existing cache file {filepath}, will re-download. Error: {e}")
                    existing_df = None

            end_dt = datetime.now(timezone.utc)
            start_dt_calc = pd.to_datetime(start_str)
            if start_dt_calc.tzinfo is None:
                start_dt_calc = start_dt_calc.tz_localize(timezone.utc)
            if start_dt_calc >= end_dt:
                return

            klines_generator = self.client.get_historical_klines_generator(
                symbol, timeframe, start_str, end_dt.strftime("%d %b, %Y %H:%M:%S")
            )
            all_klines = list(tqdm(klines_generator, desc=f"  Downloading {symbol}", unit=" klines", leave=False))

            if not all_klines:
                if existing_df is None:
                    pd.DataFrame().to_parquet(filepath)
                return

            new_df = pd.DataFrame(all_klines, columns=[
                'ts', 'open', 'high', 'low', 'close', 'vol', 'ct', 'qav',
                'trades', 'tbav', 'tqav', 'ignore'
            ])
            new_df['ts'] = pd.to_datetime(new_df['ts'], unit='ms', utc=True)
            for c in ['open', 'high', 'low', 'close', 'vol']:
                new_df[c] = pd.to_numeric(new_df[c])
            new_df = new_df[['ts', 'open', 'high', 'low', 'close', 'vol']]

            if existing_df is not None and not existing_df.empty:
                df = (pd.concat([existing_df, new_df])
                      .drop_duplicates(subset='ts', keep='last')
                      .sort_values(by='ts')
                      .reset_index(drop=True))
            else:
                df = new_df
            df.to_parquet(filepath, index=False)
        except Exception as e:
            print(f"!!! Could not download Binance data for {symbol}: {e}")
            traceback.print_exc(limit=1)

```


## ./gunbot_quant/core/backtest_engine.py
```
# gunbot_quant_tools/core/backtest_engine.py

import numpy as np
import pandas as pd
from tqdm import tqdm

def calculate_stats(trades_df, equity_curve, initial_capital, start_date, end_date, bh_return):
    if trades_df.empty or equity_curve.empty:
        return { "Start Period": start_date, "End Period": end_date, "Duration (days)": (end_date - start_date).days if start_date and end_date else 0, "Initial Capital": f"${initial_capital:,.2f}", "Final Capital": f"${initial_capital:,.2f}", "Total Return %": 0.0, "Buy & Hold %": round(bh_return, 2) if bh_return is not None else 0.0, "Max Drawdown %": 0.0, "Sharpe Ratio (ann.)": 0.0, "Sortino Ratio (ann.)": 0.0, "Total Trades": 0, "Win Rate %": 0.0, "Profit Factor": 0.0, "Avg Trade PnL %": 0.0, "Avg Win PnL %": 0.0, "Avg Loss PnL %": 0.0, "Exit Reason Counts": {} }
    equity = equity_curve.iloc[-1]
    total_return_pct = (equity - initial_capital) / initial_capital * 100
    wins = trades_df[trades_df['pnl_value'] > 0]
    losses = trades_df[trades_df['pnl_value'] <= 0]
    win_rate = len(wins) / len(trades_df) * 100 if len(trades_df) > 0 else 0
    profit_factor = wins['pnl_value'].sum() / abs(losses['pnl_value'].sum()) if abs(losses['pnl_value'].sum()) > 0 else np.inf
    peak = equity_curve.cummax()
    drawdown = (equity_curve - peak) / peak
    max_drawdown_pct = abs(drawdown.min() * 100)
    returns = equity_curve.pct_change().dropna()
    trading_days_per_year = 365 
    sharpe_ratio = np.sqrt(trading_days_per_year) * returns.mean() / returns.std() if returns.std() != 0 else 0
    negative_returns = returns[returns < 0]
    sortino_ratio = np.sqrt(trading_days_per_year) * returns.mean() / negative_returns.std() if len(negative_returns) > 1 and negative_returns.std() != 0 else 0
    
    # NEW: Calculate distribution of exit reasons
    exit_reason_counts = trades_df['exit_reason'].value_counts().to_dict()

    return {"Start Period": start_date, "End Period": end_date, "Duration (days)": (end_date - start_date).days, "Initial Capital": f"${initial_capital:,.2f}", "Final Capital": f"${equity:,.2f}", "Total Return %": round(total_return_pct, 2), "Buy & Hold %": round(bh_return, 2), "Max Drawdown %": round(max_drawdown_pct, 2), "Sharpe Ratio (ann.)": round(sharpe_ratio, 2), "Sortino Ratio (ann.)": round(sortino_ratio, 2), "Total Trades": len(trades_df), "Win Rate %": round(win_rate, 2), "Profit Factor": round(profit_factor, 2), "Avg Trade PnL %": round(trades_df['pnl_percent'].mean(), 2) if not trades_df.empty else 0, "Avg Win PnL %": round(wins['pnl_percent'].mean(), 2) if not wins.empty else 0, "Avg Loss PnL %": round(losses['pnl_percent'].mean(), 2) if not losses.empty else 0, "Exit Reason Counts": exit_reason_counts}

def _get_start_index(df, config):
    start_ts = pd.to_datetime(config['BACKTEST_START_DATE'], utc=True)
    requested_start_idx = df['ts'].searchsorted(start_ts, side='left')
    technical_warmup = config.get('TECHNICAL_WARMUP_PERIOD', 200)
    start_index = max(technical_warmup, requested_start_idx)
    if start_index >= len(df['close']):
        print(f"Warning: Not enough data for backtest. Required index {start_index} >= data length {len(df['close'])}.")
        return None
    print(f"Backtest will start at index {start_index}, corresponding to date {df['ts'].iloc[start_index].date()}")
    return start_index

def run_legacy_backtest(df, strategy, config: dict, optimizer_arrays: tuple):
    initial_capital = config['INITIAL_CAPITAL']
    reoptimize_every = config['REOPTIMIZE_EVERY']
    close = df['close'].to_numpy(dtype=np.float64)
    ts = df['ts'].to_numpy()
    start_index = _get_start_index(df, config)
    if start_index is None or len(close) <= start_index:
        return {}, pd.DataFrame(), pd.Series(dtype=float), pd.Series(dtype=float)
    
    equity = cash = initial_capital
    position = {'in_pos': False, 'entry': 0.0, 'stop': 0.0, 'qty': 0.0, 'value': 0.0, 'params': None, 'entry_time': None}
    trades = []
    
    # FIX: Initialize the equity curve array with the correct size upfront
    equity_curve = np.full(len(close) - start_index, initial_capital, dtype=np.float64)

    for idx, i in enumerate(tqdm(range(start_index, len(close)), desc=f"Backtesting Legacy {df.name}")):
        if (i - start_index) % reoptimize_every == 0:
            strategy.optimize(i, close, optimizer_arrays)
        price = close[i]
        if position['in_pos']:
            position = strategy.update_trailing_stop(i, price, position)
            exit_reason = strategy.get_exit_signal(i, price, position)
            if exit_reason:
                proceeds = position['qty'] * price; pnl_val = proceeds - position['value']
                trade_log = position.copy(); trade_log.update({'exit_time': ts[i], 'exit_price': price, 'pnl_percent': pnl_val / position['value'] * 100 if position['value'] > 0 else 0, 'pnl_value': pnl_val, 'exit_reason': exit_reason})
                trades.append(trade_log); cash, equity = proceeds, proceeds
                position = {'in_pos': False, 'entry': 0.0, 'stop': 0.0, 'qty': 0.0, 'value': 0.0, 'params': None, 'entry_time': None}
        if not position['in_pos']:
            entry_params = strategy.get_entry_signal(i)
            if entry_params and cash > 0:
                fma, sma, atr_len, mult = entry_params; atr_val = strategy.indicators[f'atr_{atr_len}'][i]
                if not np.isnan(atr_val):
                    stop_p = price - atr_val * mult
                    if stop_p < price: qty = cash / price; position = {'in_pos': True, 'entry': price, 'stop': stop_p, 'qty': qty, 'value': cash, 'params': entry_params, 'entry_time': ts[i]}; cash = 0.0
        
        current_value = position['qty'] * price if position['in_pos'] else cash
        # FIX: Assign value to the pre-sized array
        equity_curve[idx] = current_value
    
    trades_df = pd.DataFrame(trades)
    ts_slice = df['ts'].iloc[start_index:]
    equity_curve_s = pd.Series(equity_curve, index=ts_slice)
    
    start_price, end_price = df['close'].iloc[start_index], df['close'].iloc[-1]
    bh_return = (end_price - start_price) / start_price * 100 if start_price > 0 else 0
    
    if start_price > 0:
        # FIX: Ensure Buy & Hold curve has the exact same index and length as the strategy curve
        bh_values = (df['close'].iloc[start_index:].values / start_price) * initial_capital
        bh_equity_s = pd.Series(bh_values, index=ts_slice)
    else:
        bh_equity_s = pd.Series(initial_capital, index=ts_slice)
    
    start_date, end_date = ts_slice.iloc[0].date(), ts_slice.iloc[-1].date()
    stats = calculate_stats(trades_df, equity_curve_s, initial_capital, start_date, end_date, bh_return)
    
    return stats, trades_df, equity_curve_s, bh_equity_s

def run_generic_backtest(df, strategy, config: dict):
    initial_capital = config['INITIAL_CAPITAL']
    close = df['close'].to_numpy(dtype=np.float64)
    ts = df['ts'].to_numpy()
    start_index = _get_start_index(df, config)
    if start_index is None or len(close) <= start_index:
        return {}, pd.DataFrame(), pd.Series(dtype=float), pd.Series(dtype=float)
    
    equity = cash = initial_capital
    position = {'in_pos': False, 'entry_price': 0.0, 'stop_price': 0.0, 'qty': 0.0, 'value': 0.0, 'entry_time': None}
    trades = []
    
    # FIX: Initialize the equity curve array with the correct size upfront
    equity_curve = np.full(len(close) - start_index, initial_capital, dtype=np.float64)

    for idx, i in enumerate(tqdm(range(start_index, len(close)), desc=f"Backtesting {df.name} ({strategy.name})")):
        price = close[i]
        exit_reason = None
        if position['in_pos']:
            tp_price = strategy.get_take_profit_price(i, position)
            if tp_price and price >= tp_price:
                exit_reason = "Take Profit"
            if not exit_reason:
                position = strategy.update_trailing_stop(i, price, position)
                if price <= position['stop_price']:
                    exit_reason = "Stop Loss"
            if not exit_reason:
                 exit_reason = strategy.get_exit_signal(i, position)

            if exit_reason:
                proceeds = position['qty'] * price
                pnl_val = proceeds - position['value']
                trade_log = position.copy()
                trade_log.update({ 'exit_time': ts[i], 'exit_price': price, 'pnl_percent': pnl_val / position['value'] * 100 if position['value'] > 0 else 0, 'pnl_value': pnl_val, 'exit_reason': exit_reason })
                trades.append(trade_log)
                cash, equity = proceeds, proceeds
                position = {'in_pos': False, 'entry_price': 0.0, 'stop_price': 0.0, 'qty': 0.0, 'value': 0.0, 'entry_time': None}

        if not position['in_pos']:
            if strategy.get_entry_signal(i) and cash > 0:
                stop_price = strategy.get_stop_loss_price(i, price)
                if stop_price < price:
                    qty = cash / price
                    position = {'in_pos': True, 'entry_price': price, 'stop_price': stop_price, 'qty': qty, 'value': cash, 'entry_time': ts[i]}
                    cash = 0.0

        current_value = position['qty'] * price if position['in_pos'] else cash
        # FIX: Assign value to the pre-sized array
        equity_curve[idx] = current_value
    
    trades_df = pd.DataFrame(trades)
    ts_slice = df['ts'].iloc[start_index:]
    equity_curve_s = pd.Series(equity_curve, index=ts_slice)

    start_price, end_price = df['close'].iloc[start_index], df['close'].iloc[-1]
    bh_return = (end_price - start_price) / start_price * 100 if start_price > 0 else 0
    
    if start_price > 0:
        # FIX: Ensure Buy & Hold curve has the exact same index and length as the strategy curve
        bh_values = (df['close'].iloc[start_index:].values / start_price) * initial_capital
        bh_equity_s = pd.Series(bh_values, index=ts_slice)
    else:
        bh_equity_s = pd.Series(initial_capital, index=ts_slice)
        
    start_date, end_date = ts_slice.iloc[0].date(), ts_slice.iloc[-1].date()
    stats = calculate_stats(trades_df, equity_curve_s, initial_capital, start_date, end_date, bh_return)

    return stats, trades_df, equity_curve_s, bh_equity_s

def run_continuous_backtest(df, strategy, config: dict):
    initial_capital = config['INITIAL_CAPITAL']
    start_index = _get_start_index(df, config)
    if start_index is None:
        return {}, pd.DataFrame(), pd.Series(dtype=float), pd.Series(dtype=float)

    strategy.init_continuous_backtest(initial_capital=initial_capital, start_index=start_index, data=df)

    for i in tqdm(range(start_index, len(df)), desc=f"Backtesting {df.name} ({strategy.name})"):
        strategy.process_candle(i)

    trades_df, equity_curve_s = strategy.get_continuous_results()

    # FIX: Ensure B&H curve aligns perfectly with the strategy's results
    ts_slice = df['ts'].iloc[start_index:]
    equity_curve_s = equity_curve_s.reindex(ts_slice, method='ffill')

    start_price = df['close'].iloc[start_index]
    end_price = df['close'].iloc[-1]
    bh_return = (end_price - start_price) / start_price * 100 if start_price > 0 else 0
    
    if start_price > 0:
        bh_values = (df['close'].iloc[start_index:].values / start_price) * initial_capital
        bh_equity_s = pd.Series(bh_values, index=ts_slice)
    else:
        bh_equity_s = pd.Series(initial_capital, index=ts_slice)
    
    start_date = ts_slice.iloc[0].date()
    end_date = ts_slice.iloc[-1].date()
    
    stats = calculate_stats(trades_df, equity_curve_s, initial_capital, start_date, end_date, bh_return)
        
    return stats, trades_df, equity_curve_s, bh_equity_s
```


## ./gunbot_quant/core/engine_runner.py
```
# ./gunbot_quant/core/engine_runner.py

# gunbot_quant_tools/core/engine_runner.py

import pandas as pd
import numpy as np
import random
import json
import os
import time
import gc
from collections import Counter

from .data_manager import DataManager
from .screener import Screener
from ..strategies.dynamic_momentum_optimizer import DynamicMomentumOptimizer
from ..strategies.strategy_library import get_strategy, STRATEGY_MAPPING
from .indicators import IndicatorFactory
from .backtest_engine import run_legacy_backtest, run_generic_backtest, run_continuous_backtest, _get_start_index
from .utils import NumpyEncoder, DataValidationError

def precompute_legacy_indicators(df: pd.DataFrame, config: dict) -> dict:
    factory = IndicatorFactory(df)
    ma_periods = list(set(config['FAST_MA_PERIODS']) | set(config['SLOW_MA_PERIODS']))
    required_inds = {
        'sma': ma_periods,
        'slope': ma_periods,
        'std': list(set(config['ATR_PERIODS']))
    }
    return factory.get_indicators(required_inds)

def build_optimizer_arrays(strategy: DynamicMomentumOptimizer, indicators: dict) -> tuple:
    param_combinations = strategy.grid
    if not param_combinations: return tuple()
    data_len = len(next(iter(indicators.values())))
    fma_a, sma_a, atr_a = (np.empty((len(param_combinations), data_len), dtype=np.float64) for _ in range(3))
    fma_g, sma_g, atr_g, _ = strategy.fma_g, strategy.sma_g, strategy.atr_g, strategy.mult_g
    for i in range(len(fma_g)):
        fma_a[i, :], sma_a[i, :], atr_a[i, :] = indicators[f'sma_{fma_g[i]}'], indicators[f'sma_{sma_g[i]}'], indicators[f'std_{atr_g[i]}']
    return fma_a, sma_a, atr_a

def _process_symbol(symbol: str, config: dict, data_manager: DataManager):
    # print(f"\n{'='*70}\nProcessing Symbol: {symbol} for scenario {config['SCENARIO_NAME']}\n{'='*70}")
    df = None
    results_for_symbol = []
    try:
        df = data_manager.get_data(symbol, config['TIMEFRAME'], config['BACKTEST_START_DATE'], config['BACKTEST_END_DATE'], config['TECHNICAL_WARMUP_PERIOD'])
        if df.empty or len(df) < config['TECHNICAL_WARMUP_PERIOD'] or _get_start_index(df, config) is None:
            print(f"Skipping {symbol}: Not enough data for the given date range and warmup period.")
            return []
        df.name = symbol

        all_strat_configs = config.get("STRATEGIES", [])
        for strat_config_item in all_strat_configs:
            strat_config = {'name': strat_config_item, 'alias': strat_config_item, 'params': {}} if isinstance(strat_config_item, str) else strat_config_item
            base_name, alias = strat_config['name'], strat_config.get('alias', strat_config['name'])
            
            # print(f"\n--- Testing Strategy: {alias} (Base: {base_name}) on {symbol} ---")

            stats, equity_s, bh_equity_s = {}, pd.Series(dtype=float), pd.Series(dtype=float)
            strategy_meta = STRATEGY_MAPPING.get(base_name, {})
            is_legacy, is_continuous = strategy_meta.get("is_legacy", False), strategy_meta.get("is_continuous", False)

            if is_legacy:
                # Legacy strategy only supports Binance due to its specific indicator needs
                if config.get('EXCHANGE', 'binance') != 'binance':
                    # print(f"Skipping legacy strategy '{alias}' on non-Binance exchange.")
                    continue
                strategy = DynamicMomentumOptimizer(config)
                strategy.name = alias
                indicators = precompute_legacy_indicators(df, config)
                strategy.set_indicators(indicators)
                optimizer_arrays = build_optimizer_arrays(strategy, indicators)
                if not optimizer_arrays: continue
                stats, _, equity_s, bh_equity_s = run_legacy_backtest(df, strategy, config, optimizer_arrays)
            else:
                strategy = get_strategy(base_name, strat_config.get("params"))
                if not strategy: continue
                strategy.name = alias
                indicator_factory = IndicatorFactory(df)
                indicators = indicator_factory.get_indicators(strategy.get_required_indicators())
                strategy.set_indicators(indicators)
                
                backtest_runner = run_continuous_backtest if is_continuous else run_generic_backtest
                stats, _, equity_s, bh_equity_s = backtest_runner(df, strategy, config)

            if stats and not equity_s.empty:
                results_for_symbol.append({
                    "symbol": symbol, "strategy_name": alias, "base_strategy_name": base_name, "stats": stats,
                    "strategy_equity_s": equity_s, "bh_equity_s": bh_equity_s,
                    "params": strat_config.get("params", {}),
                    "timeframe": config['TIMEFRAME']
                })
    except DataValidationError:
        raise
    except Exception as e:
        import traceback
        print(f"!!! An unexpected technical error occurred while processing {symbol}: {e}"); traceback.print_exc()
    finally:
        del df; gc.collect()
    return results_for_symbol

# --- THE FIX: Restoring the missing helper functions ---
def _aggregate_curves(series_list: list, initial_capital_per_test: float, total_initial_capital: float) -> pd.Series:
    if not series_list:
        return pd.Series(dtype=float)
    deltas = [s - initial_capital_per_test for s in series_list]
    combined_deltas_df = pd.concat(deltas, axis=1)
    filled_deltas_df = combined_deltas_df.ffill().fillna(0)
    total_delta_series = filled_deltas_df.sum(axis=1)
    portfolio_equity = total_delta_series + total_initial_capital
    return portfolio_equity

def _format_equity_curve(series: pd.Series) -> list[dict]:
    if series.empty: return []
    if len(series) > 800:
        step = len(series) // 800
        series = series[::step]
    resampled = series.resample('D').last().dropna()
    resampled.index = pd.to_datetime(resampled.index, utc=True)
    equity_data = resampled.reset_index()
    equity_data.columns = ['date', 'value']
    return equity_data.to_dict('records')
# --- End of Fix ---

def _aggregate_and_save_report(all_individual_results: list, config: dict) -> str:
    if not all_individual_results:
        print("No backtests were successfully completed for this scenario.")
        return ""

    initial_capital_per_test = config['INITIAL_CAPITAL']
    num_tests = len(all_individual_results)
    total_initial_capital = initial_capital_per_test * num_tests
    
    portfolio_strategy_equity = _aggregate_curves(
        [r['strategy_equity_s'] for r in all_individual_results],
        initial_capital_per_test,
        total_initial_capital
    )
    portfolio_bh_equity = _aggregate_curves(
        [r['bh_equity_s'] for r in all_individual_results],
        initial_capital_per_test,
        total_initial_capital
    )
    
    overall_equity_curve = {
        "strategy": _format_equity_curve(portfolio_strategy_equity),
        "buy_and_hold": _format_equity_curve(portfolio_bh_equity)
    }

    stats_df = pd.DataFrame([r['stats'] for r in all_individual_results])
    final_equity = portfolio_strategy_equity.iloc[-1] if not portfolio_strategy_equity.empty else total_initial_capital
    final_bh_equity = portfolio_bh_equity.iloc[-1] if not portfolio_bh_equity.empty else total_initial_capital

    peak = portfolio_strategy_equity.cummax()
    drawdown = (portfolio_strategy_equity - peak) / peak
    
    total_exit_reasons = Counter()
    for r in all_individual_results:
        total_exit_reasons.update(r['stats'].get('Exit Reason Counts', {}))

    overall_stats = {
        "Total Return %": (final_equity / total_initial_capital - 1) * 100 if total_initial_capital > 0 else 0.0,
        "Buy & Hold %": (final_bh_equity / total_initial_capital - 1) * 100 if total_initial_capital > 0 else 0.0,
        "Sharpe Ratio (ann.)": stats_df["Sharpe Ratio (ann.)"].mean(),
        "Sortino Ratio (ann.)": stats_df["Sortino Ratio (ann.)"].mean(),
        "Max Drawdown %": abs(drawdown.min() * 100) if not drawdown.empty else 0.0,
        "Total Trades": int(stats_df["Total Trades"].sum()),
        "Win Rate %": stats_df["Win Rate %"].mean(),
        "Profit Factor": stats_df["Profit Factor"].replace([np.inf, -np.inf], np.nan).mean(),
        "Avg Win PnL %": stats_df["Avg Win PnL %"].mean(),
        "Avg Loss PnL %": stats_df["Avg Loss PnL %"].mean(),
        "Exit Reason Counts": dict(total_exit_reasons)
    }

    individual_tests = []
    for result in all_individual_results:
        result['stats'].pop('equity_curve', None)

        # --- NEW: Determine quote asset ---
        quote_asset = 'USD' # Default for yfinance
        if config.get("EXCHANGE") != 'yfinance':
            # Priority: screener config, explicit config, then discovery config, then fallback
            quote_asset = config.get('SCREENER_QUOTE_ASSET', config.get('quote_asset', 'USDT'))
        # --- END NEW ---

        individual_tests.append({
            "test_id": f"{result['strategy_name']}_{result['symbol']}_{result.get('timeframe', 'N/A')}",
            "strategy_name": result['strategy_name'],
            "base_strategy_name": result.get('base_strategy_name'),
            "symbol": result['symbol'],
            "timeframe": result.get('timeframe'),
            "is_active_pair": result.get('is_active_pair', False),
            "quote_asset": quote_asset, # <<< ADDED
            "exchange": config.get("EXCHANGE"), # <<< ADDED
            "stats": result['stats'],
            "parameters": result['params'],
            "equity_curve": {
                "strategy": _format_equity_curve(result['strategy_equity_s']),
                "buy_and_hold": _format_equity_curve(result['bh_equity_s'])
            }
        })
    
    report_data = {
        "scenario_name": config.get("SCENARIO_NAME"),
        "config": {k: v for k, v in config.items() if k in {"INITIAL_CAPITAL", "TIMEFRAME", "BACKTEST_START_DATE", "BACKTEST_END_DATE", "EXCHANGE"}},
        "overall_stats": overall_stats,
        "overall_equity_curve": overall_equity_curve,
        "individual_tests": individual_tests
    }
    
    if config.get("gunbot_warning"):
        report_data["config"]["gunbot_warning"] = config.get("gunbot_warning")

    output_dir = os.path.join('results', config['SCENARIO_NAME'])
    os.makedirs(output_dir, exist_ok=True)
    job_id = config.get("JOB_ID", f"cli_run_{int(time.time())}")
    report_path = os.path.join(output_dir, f"report_{job_id}.json")
    
    with open(report_path, 'w') as f:
        json.dump(report_data, f, cls=NumpyEncoder)
    
    print(f"\nFull lightweight report saved to {report_path}")
    return report_path

def run_batch_backtest(config: dict, reference_test_data: dict = None) -> str:
    random.seed(config['SEED']); np.random.seed(config['SEED'])

    exchange = config.get('EXCHANGE', 'binance')
    data_manager = DataManager(exchange=exchange)
    
    # Symbol selection is now always handled by the Screener
    selection_method = config.get('SYMBOL_SELECTION_METHOD', 'TOP_N_VOLUME')
    screener = Screener(exchange=exchange, config=config)
    
    if selection_method == 'MOMENTUM_SCREENER':
        symbols_to_test = screener.get_top_symbols()
    elif selection_method == 'EXPLICIT_LIST':
        symbols_to_test = config.get('SYMBOLS', [])
    else:  # 'TOP_N_VOLUME'
        symbols_to_test = screener.get_top_usdt_symbols(n=config['TOP_N_COINS'])
        
    if not symbols_to_test:
        print("Symbol selection returned no symbols. Aborting backtest.")
        return ""

    data_manager.warm_data_cache(symbols=symbols_to_test, timeframe=config['TIMEFRAME'], config=config)
    
    all_individual_results = []
    if reference_test_data:
        all_individual_results.append(reference_test_data)

    for symbol in symbols_to_test:
        symbol_results = _process_symbol(symbol, config, data_manager)
        if symbol_results:
            all_individual_results.extend(symbol_results)
        gc.collect()

    return _aggregate_and_save_report(all_individual_results, config)
```


## ./gunbot_quant/api/__init__.py
```

```


## ./gunbot_quant/api/models.py
```
# gunbot_quant/api/models.py

from pydantic import BaseModel, Field, model_validator
from typing import List, Dict, Any, Optional
import time

class ScreenerFilter(BaseModel):
    metric: str = Field(..., example="roc_30p", description="The metric to filter on (e.g., 'roc_30p', 'avg_vol_usd_30d').")
    condition: str = Field(..., example="greater_than", description="The filter condition ('greater_than', 'less_than', 'between').")
    value: Any = Field(..., example=20.0, description="The value for the condition. A list of two numbers for 'between'.")

class ScreenerConfig(BaseModel):
    exchange: str = Field('binance', description="The exchange to scan (e.g., 'binance', 'kucoin', 'yfinance').")
    timeframe: str = Field('1d', description="The candle timeframe for analysis (e.g., '15m', '1h', '4h', '1d').")
    quote_asset: Optional[str] = Field('USDT', description="The asset to screen against (e.g., USDT, BTC). Not used for yfinance.")
    candidate_count: Optional[int] = Field(200, gt=0, le=500, description="Number of top volume coins to consider initially. Not used for yfinance.")
    final_count: Optional[int] = Field(15, gt=0, le=50, description="Number of top symbols to return after filtering and ranking. Not used for yfinance.")
    filters: List[ScreenerFilter] = Field(..., description="A list of filter objects to apply.")
    rank_metric: str = Field("roc_30p", description="The metric to use for sorting the final list of symbols.")
    symbols: Optional[List[str]] = Field(None, description="A manual list of tickers, required for yfinance.")

class ScreenerRequest(BaseModel):
    job_name: str = Field(f"ScreenerRun-{int(time.time())}", description="A unique name for this run to save results for later.")
    config: ScreenerConfig

class ScreenerData(BaseModel):
    job_name: str
    exchange: str
    quote_asset: Optional[str] = None # <-- FIX: Make optional
    timeframe: str
    rank_metric: str
    symbols: List[str]
    analysis_df_json: List[Dict[str, Any]]

class ScreenerResponse(BaseModel):
    message: str
    job_id: str
    data: Optional[ScreenerData] = None

class StrategyConfig(BaseModel):
    name: str = Field(..., description="The base name of the strategy from the library, e.g., 'RSI_Reversion'.")
    alias: str = Field(..., description="A unique, user-defined name for this specific configuration, e.g., 'My Aggressive RSI'.")
    params: Dict[str, Any] = Field(..., description="A dictionary of parameter overrides for this instance.")

class BacktestRequest(BaseModel):
    scenario_name: str = Field("API_Backtest_Run", description="A unique name for this backtest run, used as a job ID.")
    exchange: str = Field('binance', description="The exchange to fetch data from (e.g., 'binance', 'kucoin', 'kraken').")
    initial_capital: float = Field(10000.0, gt=0)
    timeframe: str = Field("1h", description="Candle timeframe (e.g., '15m', '1h', '4h', '1d').")
    start_date: str = Field(..., example="2023-01-01", description="Backtest start date in 'YYYY-MM-DD' format.")
    end_date: str = Field(..., example="2023-12-31", description="Backtest end date in 'YYYY-MM-DD' format.")
    strategies: List[StrategyConfig] = Field(..., min_length=1, description="A list of strategy configurations to run.")
    selection_method: str = Field("EXPLICIT_LIST", description="Method for symbol selection: 'EXPLICIT_LIST' or 'FROM_CONFIG'.")
    symbols: Optional[List[str]] = Field(None, min_items=1, example=["BTCUSDT", "ETHUSDT"])
    screener_config_name: Optional[str] = Field(None, description="Name of the saved screener config to use.")

    @model_validator(mode='before')
    def check_selection_method(cls, values: Dict[str, Any]) -> Dict[str, Any]:
        method = values.get('selection_method')
        symbols = values.get('symbols')
        config_name = values.get('screener_config_name')
        if method == 'EXPLICIT_LIST' and not symbols:
            raise ValueError("Symbols must be provided when selection method is 'EXPLICIT_LIST'")
        if method == 'FROM_CONFIG' and not config_name:
            raise ValueError("A screener_config_name must be provided when selection method is 'FROM_CONFIG'")
        return values

class BacktestResponse(BaseModel):
    status: str
    message: str
    job_id: Optional[str] = None
    report: Optional[Dict[str, Any]] = None

class GunbotConnectRequest(BaseModel):
    password: str = Field(..., description="The password for the Gunbot GUI.")
    gunthy_wallet: str = Field(..., description="The 'gunthy_wallet' value from your Gunbot config.js file.")
    protocol: str = Field("http", description="The protocol for the Gunbot instance (http or https).")
    host: str = Field("localhost", description="The hostname or IP address of the Gunbot instance.")
    port: int = Field(3000, gt=0, lt=65536, description="The port number for the Gunbot API.")

class GunbotBenchmarkRequest(BaseModel):
    job_name: str = Field(..., description="A unique name for the benchmark run.")
    initial_capital: float = Field(..., gt=0, description="The initial capital to use for the benchmark equity curve.")
    pair_data: Dict[str, Any] = Field(..., description="The full data object for the pair from the /gunbot/trading-pairs endpoint.")
    timeframes_to_test: List[str] = Field(..., min_length=1, description="A list of timeframe strings (e.g., '1h', '4h') to run the benchmark against.")
    start_date: Optional[str] = Field(None, description="Optional custom start date (YYYY-MM-DD).")
    end_date: Optional[str] = Field(None, description="Optional custom end date (YYYY-MM-DD).")

class GunbotNormalizeRequest(BaseModel):
    pair_data: Dict[str, Any] = Field(..., description="The full data object for a single pair.")

class FindBetterPairRequest(BaseModel):
    job_name: str = Field(..., description="A unique name for the discovery run.")
    initial_capital: float = Field(..., gt=0, description="The initial capital to use for the backtests.")
    pair_data: Dict[str, Any] = Field(..., description="The full data object for the active pair being compared.")
    candidate_count: Optional[int] = Field(200, ge=10, le=500, description="Number of top volume pairs to scan.")
    min_daily_volume: Optional[float] = Field(1_000_000, gt=0, description="Minimum average daily volume in quote asset.")
    start_date: Optional[str] = Field(None, description="Optional custom start date (YYYY-MM-DD).")
    end_date: Optional[str] = Field(None, description="Optional custom end date (YYYY-MM-DD).")
    timeframe: Optional[str] = Field(None, description="Optional custom timeframe for the discovery run.")

# --- Models for Gunbot Pair Management ---
class GunbotAddPairRequest(BaseModel):
    exchange: str = Field(..., description="The exchange name as configured in Gunbot (e.g., 'binance').")
    standard_pair: str = Field(..., description="The pair in standard format (e.g., 'BTCUSDT').")
    strategy_name: str = Field(..., description="The name of the GQ strategy (e.g., 'RSI_Reversion').")
    strategy_params: Dict[str, Any] = Field(..., description="A dictionary of parameters for the strategy.")
    quote_asset: str = Field(..., description="The quote asset of the pair (e.g., 'USDT').")
    timeframe: str = Field(..., description="The timeframe of the strategy (e.g., '1h').")
    
    # New configurable fields with defaults
    buy_enabled: bool = Field(True, description="Enable buying for this pair.")
    sell_enabled: bool = Field(True, description="Enable selling for this pair.")
    stop_after_sell: bool = Field(True, description="Pause trading on this pair after a sell.")
    initial_capital: float = Field(1000.0, description="The initial capital in quote asset to start trading with. Used by GQ strategies for compounding.")
    min_volume_to_sell: float = Field(10, description="The minimum value in quote asset for a sell order to be placed.")
    start_time: int = Field(..., description="The start time for compounding logic, as a Unix timestamp in milliseconds.")

class GunbotRemovePairRequest(BaseModel):
    exchange: str = Field(..., description="The exchange name as configured in Gunbot (e.g., 'binance').")
    gunbot_pair: str = Field(..., description="The pair in Gunbot format (e.g., 'USDT-BTC').")
```


## ./gunbot_quant/api/main.py
```
# gunbot_quant/api/main.py

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from .routes import router as api_router

# --- Add these imports ---
import os
from contextlib import asynccontextmanager
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from ..gunbot_api import client as gunbot_client

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manages application startup and shutdown events."""
    # Code here runs on startup
    print("Gunbot Quant API starting up...")
    yield
    # Code here runs on shutdown
    print("Gunbot Quant API shutting down...")
    gunbot_client.close_gunbot_api()

app = FastAPI(
    title="Gunbot Quant API",
    description="API for running cryptocurrency trading strategy backtests and market screening.",
    version="1.0.0",
    lifespan=lifespan  # Register the lifespan manager
)

# Shared state for background jobs
app.state.job_results = {}

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- API router must be included BEFORE the static file catch-all ---
app.include_router(api_router, prefix="/api/v1")


# --- Serve the static frontend from the 'dist' directory ---

# Correctly navigate from 'gunbot_quant/api' up one level to 'gunbot_quant',
# then into 'frontend/dist'.
frontend_dir = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'dist')

# Check if the frontend build directory exists
if os.path.exists(frontend_dir):
    # Mount the 'assets' directory which contains JS, CSS, etc.
    app.mount(
        "/assets",
        StaticFiles(directory=os.path.join(frontend_dir, "assets")),
        name="assets"
    )

    @app.get("/{full_path:path}", tags=["Frontend"])
    async def serve_frontend(request: Request, full_path: str):
        """
        Catch-all endpoint to serve the frontend's index.html.
        This is necessary for client-side routing to work correctly.
        """
        # Path to the main index.html file
        index_path = os.path.join(frontend_dir, 'index.html')
        
        # Check for static files like favicon.ico or vite.svg
        potential_file_path = os.path.join(frontend_dir, full_path)
        if os.path.isfile(potential_file_path):
             return FileResponse(potential_file_path)

        # For any other path, serve the main index.html
        return FileResponse(index_path)

else:
    # Fallback message if the frontend hasn't been built
    @app.get("/", tags=["Root"])
    async def read_root_dev():
        return {"message": "Welcome - Gunbot Quant API is running. Frontend build not found in `frontend/dist`. Run `npm run build --prefix frontend` to serve the UI."}
```


## ./gunbot_quant/api/routes.py
```
# gunbot_quant/api/routes.py

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Request
from fastapi.responses import JSONResponse
from binance.client import Client
import os
import json
from typing import Dict, Any, List
import traceback
import time
import datetime
import pandas as pd
import numpy as np 
import ccxt
import logging
import re

# --- Import models and core logic ---
from .models import (
    ScreenerConfig, ScreenerRequest, ScreenerData, ScreenerResponse, 
    BacktestRequest, BacktestResponse, GunbotConnectRequest, GunbotBenchmarkRequest,
    FindBetterPairRequest, GunbotNormalizeRequest, GunbotAddPairRequest, GunbotRemovePairRequest
)
from ..gunbot_api import client as gunbot_client
from ..gunbot_api.data_processor import process_trading_pairs_from_coremem
from ..core.data_manager import DataManager
from ..core.screener import Screener
from ..core.engine_runner import run_batch_backtest, _process_symbol, _aggregate_and_save_report
from ..config.scenarios import BASE_CONFIG
from ..core.utils import NumpyEncoder, DataValidationError
from ..strategies.strategy_library import STRATEGY_MAPPING
from ..core.backtest_engine import calculate_stats

# Setup basic logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

router = APIRouter()
RESULTS_DIR = 'results'
SCREENER_RESULTS_DIR = 'screener_results'
SCREENER_CONFIGS_DIR = 'screener_configs'
os.makedirs(RESULTS_DIR, exist_ok=True)
os.makedirs(SCREENER_RESULTS_DIR, exist_ok=True)
os.makedirs(SCREENER_CONFIGS_DIR, exist_ok=True)

# --- NEW: Gunbot Period Matrix & Helper ---
GUNBOT_PERIOD_MATRIX = {
    'bingx': [1, 3, 5, 15, 30, 60, 120, 240, 360, 480, 720, 1440, 4320, 10080, 43200],
    'binance': [1, 3, 5, 15, 30, 60, 120, 240, 360, 720, 1440, 4320, 10080],
    'gateio': [1, 5, 10, 15, 30, 60, 120, 240, 360, 720, 1440, 10080],
    'bybit': [1, 3, 5, 15, 30, 60, 120, 240, 360, 720, 1440, 10080],
    'mex_gunthy': [1, 3, 5, 15, 30, 60, 120, 240, 360, 720, 1440, 4320, 10080],
    'binanceus': [1, 3, 5, 15, 30, 60, 120, 240, 360, 720, 1440],
    'binanceFutures': [1, 3, 5, 15, 30, 60, 120, 240, 360, 720, 1440],
    'dydx': [1, 5, 15, 30, 60, 120, 240, 1440],
    'dydx4': [1, 5, 15, 30, 60, 240, 1440],
    'futures_gunthy': [1, 3, 5, 15, 30, 60, 120, 240, 360, 720, 1440],
    'bitfinex': [1, 5, 15, 30, 60, 180, 360, 720, 1440, 10080, 20160],
    'ftx': [1, 5, 15, 30, 60, 240, 1440],
    'okex5': [1, 3, 5, 15, 30, 60, 120, 240, 360, 480, 720, 1440, 10080],
    'okgunbot': [1, 5, 15, 60, 240],
    'bitmex': [1, 5, 60, 1440],
    'bitmex_testnet': [1, 5, 60, 1440],
    'cex': [5, 15],
    'gdax': [1, 5, 15, 60, 360, 1440],
    'coinbase': [1, 5, 15, 30, 60, 120, 360, 1440],
    'huobi': [1, 5, 15, 30, 60, 240, 1440],
    'kraken': [1, 3, 5, 15, 30, 60, 240, 1440],
    'krakenFutures': [1, 5, 15, 30, 60, 240, 720, 1440, 10080],
    'kucoin': [1, 3, 5, 15, 30, 60, 120, 240, 360, 480, 720],
    'poloniex': [1, 5, 10, 15, 30, 60, 120, 240, 360, 720, 1440, 10080],
    'cryptocom': [1, 5, 15, 30, 60, 120, 240, 360, 720, 1440, 10080],
    'mexc': [1, 5, 15, 30, 60, 240, 480, 1440],
    'bitget': [1, 5, 15, 30, 60, 120, 240, 360, 480, 720, 1440, 10080],
    'alpaca': [1, 3, 5, 15, 30, 60, 120, 240, 360, 480, 720, 1440, 10080, 43200],
    'hyperliquid': [1, 15, 60, 1440],
    'other': [1, 5, 15, 60, 240],
}

DEFAULTSTRATEGYSETTINGS = {
    "ADX_ENABLED": False,
    "ADX_LEVEL": "25",
    "ATRX": 0.5,
    "ATR_PERIOD": 14,
    "BTC_MONEY_FLOW": "25",
    "BF_SINCE": "1748779916495",
    "BF_UNTIL": "1753963916495",
    "DEEP_TESTING": False,
    "BTC_PND_PERIOD": "14",
    "BTC_PND_PROTECTION": False,
    "BUYLVL": 1,
    "BUYLVL1": 0.6,
    "BUYLVL2": 2,
    "BUYLVL3": 70,
    "BUY_ENABLED": True,
    "SINGLE_BUY": False,
    "BUY_LEVEL": 1,
    "BUY_METHOD": "custom",
    "BUY_RANGE": 0.5,
    "CANDLES_LENGTH": "500",
    "COUNT_SELL": 9999,
    "DISPLACEMENT": 26,
    "DI_PERIOD": "14",
    "DOUBLE_CHECK_GAIN": True,
    "DOUBLE_UP": False,
    "DOUBLE_UP_CAP": 1,
    "DU_BUYDOWN": 2,
    "DU_CAP_COUNT": 0,
    "DU_METHOD": "HIGHBB",
    "EMA1": "16",
    "EMA2": "8",
    "EMA3": "150",
    "EMASPREAD": False,
    "EMA_LENGTH": "150",
    "EMAx": "0.5",
    "FAST_SMA": 1,
    "FUNDS_RESERVE": 0,
    "GAIN": 0.5,
    "HIGH_BB": 0,
    "ICHIMOKU_PROTECTION": True,
    "IGNORE_TRADES_BEFORE": "0",
    "LIQUIDITY": False,
    "LIQUIDITY_TAKER": False,
    "LIQUIDITY_GAIN": True,
    "MAX_INVESTMENT": 100000000000000000,
    "IS_MARGIN_STRAT": False,
    "KEEP_QUOTE": 0,
    "KIJUN_BUY": False,
    "KIJUN_CLOSE": False,
    "KIJUN_PERIOD": 26,
    "KIJUN_SELL": False,
    "KIJUN_STOP": False,
    "KUMO_BUY": False,
    "KUMO_CLOSE": False,
    "KUMO_SELL": False,
    "KUMO_SENTIMENTS": True,
    "KUMO_STOP": True,
    "LEVERAGE": 0,
    "LONG_LEVEL": 1,
    "LOW_BB": 0,
    "MACD_LONG": 20,
    "MACD_SHORT": 5,
    "MACD_SIGNAL": 10,
    "MAKER_FEES": False,
    "TAKER_FEES": False,
    "MARKET_BUY": False,
    "MARKET_BUYBACK": False,
    "MARKET_CLOSE": False,
    "MARKET_DU": False,
    "MARKET_FOK": False,
    "MARKET_RTBUY": False,
    "MARKET_RTSELL": False,
    "MARKET_SELL": False,
    "MARKET_STOP": False,
    "MEAN_REVERSION": False,
    "MFI_BUY_LEVEL": "30",
    "MFI_ENABLED": False,
    "MFI_LENGTH": "14",
    "MFI_SELL_LEVEL": "70",
    "MIN_VOLUME_TO_BUY": 0.001,
    "MIN_VOLUME_TO_SELL": 10,
    "NBA": 0,
    "PANIC_SELL": False,
    "PERIOD": "5",
    "PP_BUY": 0,
    "PP_SELL": 99999,
    "PRE_ORDER": False,
    "PRE_ORDER_GAP": 0,
    "RENKO_ATR": False,
    "RENKO_BRICK_SIZE": 0.0001,
    "RENKO_PERIOD": 15,
    "ROE": 1,
    "ROE_CLOSE": False,
    "ROE_LIMIT": 1,
    "ROE_TRAILING": False,
    "ROE_SCALPER": False,
    "ROE_SPREAD": 0,
    "RSI_BUY_ENABLED": False,
    "RSI_BUY_LEVEL": "30",
    "RSI_DU_BUY": 30,
    "RSI_LENGTH": "14",
    "RSI_METHOD": "oscillator",
    "RSI_SELL_ENABLED": False,
    "RSI_SELL_LEVEL": "70",
    "RT_BUY_LEVEL": 2,
    "RT_BUY_UP_LEVEL": 0,
    "RT_ENABLED": False,
    "RT_GAIN": 1.5,
    "RT_MAXBAG_PROTECTION": 10,
    "RT_ONCE": False,
    "RT_ONCE_AND_CONTINUE": False,
    "RT_SELL_UP": 0.3,
    "RT_TREND_ENABLED": False,
    "SELLLVL": 1,
    "SELLLVL1": 0.6,
    "SELLLVL2": 2,
    "SELLLVL3": 70,
    "SELL_ENABLED": True,
    "SELL_METHOD": "custom",
    "SELL_RANGE": 0.5,
    "SENKOUSPAN_PERIOD": 52,
    "SHORT_LEVEL": 1,
    "SLOW_SMA": 2,
    "SLOW_STOCH_K": "3",
    "SL_DISABLE_BUY": False,
    "SL_DISABLE_SELL": False,
    "SMAPERIOD": "50",
    "STDV": "2",
    "STOCHRSI_BUY_LEVEL": "0.2",
    "STOCHRSI_ENABLED": False,
    "STOCHRSI_LENGTH": "14",
    "STOCHRSI_METHOD": "oscillator",
    "STOCHRSI_SELL_LEVEL": "0.8",
    "STOCH_BUY_LEVEL": "30",
    "STOCH_D": "3",
    "STOCH_ENABLED": False,
    "STOCH_K": "14",
    "STOCH_METHOD": "oscillator",
    "STOCH_SELL_LEVEL": "70",
    "STOP_LIMIT": 99999,
    "TAKE_BUY": False,
    "TAKE_PROFIT": False,
    "TBUY_RANGE": 0.5,
    "TENKAN_BUY": True,
    "TENKAN_CLOSE": True,
    "TENKAN_PERIOD": 9,
    "TENKAN_SELL": True,
    "TENKAN_STOP": False,
    "TL_ALLIN": False,
    "TL_PERC": 0,
    "TM_RT_SELL": False,
    "TP_PROFIT_ONLY": True,
    "TP_RANGE": 0.5,
    "TRADES_TIMEOUT": 0,
    "TRADING_LIMIT": 0.002,
    "TRAIL_ME_BUY": False,
    "TRAIL_ME_BUY_RANGE": 0.5,
    "TRAIL_ME_DU": False,
    "TRAIL_ME_RT": False,
    "TRAIL_ME_RT_SELL_RANGE": 0.5,
    "TRAIL_ME_SELL": False,
    "TRAIL_ME_SELL_RANGE": 0.5,
    "TSSL_TARGET_ONLY": True,
    "USE_RENKO": False,
    "XTREND_ENABLED": True,
    "STOP_BUY": 0,
    "STOP_SELL": 0,
    "PND": False,
    "PND_PROTECTION": 1.5,
    "SupportResistance": False,
    "SupRes_ALLOW_DCA": True,
    "SupRes_SPREAD": 0.1,
    "SupRes_LVL_SPREAD": 1,
    "SupRes_MAX": 0,
    "SupRes_TIMER": 300,
    "SupResMinROE": 20,
    "MAX_BUY_COUNT": 20,
    "GRID_MULTIPLIER": 1,
    "STOP_AFTER_SELL": False,
    "AUTO_GAIN": True,
    "TRAILING_MULTIPLIER": 1,
    "START_CONT_TRADING": 3,
    "CT_TL_MULTIPLIER": 0.5,
    "CT_RESTART_MULTIPLIER": 1,
    "TL_MULTIPLIER": 1,
    "MAX_OPEN_CONTRACTS": 1,
    "DCA_METHOD": "NATIVE",
    "DCA_SPREAD": 2,
    "SAFETY_TIMER": 1800,
    "TREND_OPEN": False,
    "TREND_BLOCK_DCA": False,
    "TREND_LOWER_DCA": False,
    "DIRECTION": "LONG",
    "TREND_CT_MULTIPLIER": 2,
    "TREND_GRID_MULTIPLIER": 2,
    "AUTO_STEP_SIZE": True,
    "STEP_SIZE": 500,
    "ENFORCE_STEP": False,
    "STRAT_FILENAME": "grid.js",
    "unit_cost": True,
    "DYNAMIC_EXIT_LOGIC": False,
    "bitRage": False,
    "FIRST_ORDER_EXTRA_DELAY": 30,
    "TREND_TRAILING": True,
    "TREND_TRAILING_MULTIPLIER": 1,
    "TREND_TRAILING_BEARISH_MULTIPLIER": 2,
    "AUTO_TREND_ORDERS": True,
    "GAIN_PARTIAL": 0.5,
    "PARTIAL_SELL_CAP": False,
    "PARTIAL_SELL_CAP_RATIO": 1,
    "SUPPORT_TL_RATIO": 2,
    "TREND_PLUS": True,
    "TREND_PLUS_BUY_MULTIPLIER_SMALL": 1,
    "TREND_PLUS_BUY_MULTIPLIER_MEDIUM": 2,
    "TREND_PLUS_BUY_MULTIPLIER_LARGE": 5,
    "TREND_PLUS_SELL_MULTIPLIER_SMALL": 0.5,
    "TREND_PLUS_SELL_MULTIPLIER_MEDIUM": 2,
    "TREND_PLUS_SELL_MULTIPLIER_LARGE": 5,
    "TREND_SCALPING": True,
    "SCALP_TL_RATIO": 0.625,
    "EXHAUSTION_SENSITIVITY": "SHORT",
    "STRICT_ENTRY": True,
    "PERIOD_MEDIUM": 60,
    "PERIOD_LONG": 240,
    "TRADE_SUPPORTS": True,
    "SUPPORT2_TL_RATIO": 2,
    "TREND_SYNC": True,
    "MULTIPLE_TIMEFRAMES_MODE": False,
    "LOWER_PERIOD_LOW": 5,
    "LOWER_PERIOD_MEDIUM": 15,
    "LOWER_PERIOD_HIGH": 30,
    "MIDDLE_PERIOD_LOW": 15,
    "MIDDLE_PERIOD_MEDIUM": 60,
    "MIDDLE_PERIOD_HIGH": 240,
    "ACCUMULATION_CYCLE": False,
    "MTF_TL_RATIO": 1,
    "PRICE_ACTION_TL_RATIO": 1,
    "PRICE_ACTION_THRESHOLD": 0,
    "ALWAYS_USE_TL_MULTIPLIER": False,
    "PANIC_CLOSE": False,
    "INITIAL_CAPITAL": "1000",
    "MULTI_COMP": False
}

def timeframe_to_minutes(tf_str: str) -> int:
    """Converts a timeframe string (e.g., '1h', '15m') to minutes."""
    if not tf_str or len(tf_str) < 2: return 0
    unit = tf_str[-1].lower()
    try:
        value = int(tf_str[:-1])
        if unit == 'm': return value
        if unit == 'h': return value * 60
        if unit == 'd': return value * 24 * 60
    except ValueError:
        return 0
    return 0
# --- END NEW ---

# --- Gunbot Exchange Normalization Logic ---
GUNBOT_EXCHANGE_SYNONYMS = {
    "mex_gunthy": "binance",
    "futures_gunthy": "binance", # Use spot binance as fallback for futures
    "okex5": "okx",
    "huobi": "htx",
    "gateio": "gate", # CCXT id is 'gate'
    "dydx4": "binance", # DEXs not supported by CCXT OHLCV, fallback
    "hyperliquid": "binance",
    "pancake": "binance",
    "cryptocom": "binance", # Not in verified list, fallback
    "hitbtc": "binance", # Not in verified list, fallback
    "cex": "binance", # Not in verified list, fallback
    "bittrex": "binance", # Defunct, fallback
}

# Supported exchanges in GQ. This is a robust list for mapping.
GQ_SUPPORTED_CRYPTO_EXCHANGES = {
    'binance', 'binanceus', 'bingx', 'bitget', 'bybit',
    'kraken', 'kucoin', 'mexc', 'okx', 'poloniex',
    'gate', 'coinbase', 'htx'
}

def _normalize_gunbot_request_data(pair_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normalizes Gunbot exchange and pair data to GQ-compatible formats.
    Returns a dictionary with normalized data and any relevant warnings.
    """
    gunbot_exchange = pair_data.get('exchange', '')
    gunbot_pair = pair_data.get('gunbot_pair_format', '')
    standard_pair = pair_data.get('standard_pair_format', '')

    result = {
        "gq_exchange": "binance", # Default fallback
        "gq_symbol": standard_pair,
        "warning": None,
        "is_tradfi": False,
        "quote_asset": ""
    }

    # 1. Handle numbered suffixes (e.g., binance#4 -> binance)
    base_exchange = gunbot_exchange.split('#')[0].lower()

    # 2. Handle alpaca (TradFi)
    if base_exchange == "alpaca":
        result['gq_exchange'] = "yfinance"
        result['is_tradfi'] = True
        try:
            quote, base = gunbot_pair.split('-')
            result['gq_symbol'] = base
            result['quote_asset'] = quote
        except (ValueError, AttributeError):
            result['gq_symbol'] = gunbot_pair # Assume it's already a ticker
            result['quote_asset'] = 'USD' # Fallback
        
        result['warning'] = f"Gunbot exchange '{gunbot_exchange}' is mapped to yfinance for stock/ETF data. Pair '{gunbot_pair}' becomes ticker '{result['gq_symbol']}'."
        return result

    # 3. Handle crypto exchanges
    normalized_exchange_name = GUNBOT_EXCHANGE_SYNONYMS.get(base_exchange, base_exchange)
    result['gq_symbol'] = standard_pair

    # Determine quote asset
    try:
        quote, _ = gunbot_pair.split('-')
        result['quote_asset'] = quote
    except (ValueError, AttributeError):
        for quote_candidate in ['USDT', 'USDC', 'TUSD', 'BUSD', 'FDUSD', 'BTC', 'ETH', 'BNB', 'USD']:
            if standard_pair and standard_pair.endswith(quote_candidate):
                result['quote_asset'] = quote_candidate
                break

    # Check if the normalized exchange is supported by GQ
    if normalized_exchange_name in GQ_SUPPORTED_CRYPTO_EXCHANGES:
        result['gq_exchange'] = normalized_exchange_name
        if normalized_exchange_name != base_exchange:
            result['warning'] = f"Gunbot exchange '{gunbot_exchange}' is treated as its synonym '{normalized_exchange_name}' for benchmarking."
    else:
        fallback_exchange = "binance"
        result['gq_exchange'] = fallback_exchange
        result['warning'] = f"Gunbot exchange '{gunbot_exchange}' is not directly supported for backtesting. Falling back to '{fallback_exchange}' for a comparable market benchmark."

    return result
# --- END of Normalization Logic ---


# --- Screener Task (to be run in background) ---
def run_screener_task(config: dict, job_store: Dict[str, Any]):
    job_id = config['JOB_ID']
    try:
        print(f"Starting background screener task for job_id: {job_id}")
        screener = Screener(exchange=config['EXCHANGE'], config=config)
        
        candidate_symbols = screener._get_candidate_symbols()
        analysis_df = screener._analyze_candidates(candidate_symbols)
        
        if analysis_df.empty:
             raise ValueError("Screener analysis yielded no results.")
        
        filtered_symbols = screener._filter_and_rank(analysis_df.copy())
        
        results_df = analysis_df[analysis_df.symbol.isin(filtered_symbols)]
        screener_data = ScreenerData(
            job_name=config.get('JOB_NAME', job_id),
            exchange=config.get('EXCHANGE'),
            quote_asset=config.get('SCREENER_QUOTE_ASSET'),
            timeframe=config.get('timeframe'),
            rank_metric=config.get('SCREENER_RANK_METRIC'),
            symbols=filtered_symbols,
            analysis_df_json=results_df.to_dict(orient='records')
        )

        output_path = os.path.join(SCREENER_RESULTS_DIR, f"{job_id}.json")
        with open(output_path, 'w') as f:
            json.dump(screener_data.model_dump(), f, indent=4, cls=NumpyEncoder)

        job_store[job_id] = {"status": "completed", "report": screener_data.model_dump(), "job_id": job_id}
        print(f"Screener job {job_id} completed successfully. Report saved to {output_path}")

    # --- THE FIX: Catch the specific CCXT error first to provide a better message ---
    except ccxt.BadRequest as e:
        error_title = "Exchange API Limit Exceeded"
        error_details = (
            f"The screener failed because the '{config['EXCHANGE']}' exchange has API limitations on historical data requests. "
            "The error 'date of query is too wide' indicates the screener tried to fetch a larger time range than the exchange allows in a single API call. "
            "This can happen on exchanges like BingX or Gate.io. The backtester handles this, but the screener currently does not. "
            "\n\nWorkaround: Please try the screener on a different exchange (like Binance) for now."
        )
        print(f"Screener job {job_id} failed due to API limits. Error: {e}\n{error_details}")
        job_store[job_id] = {"status": "failed", "report": {"error": error_title, "details": error_details}, "job_id": job_id}

    except Exception as e:
        # This will now catch other errors, including the "NameError" if it occurs for other reasons.
        error_details = traceback.format_exc()
        print(f"Screener job {job_id} failed. Error: {e}\n{error_details}")
        job_store[job_id] = {"status": "failed", "report": {"error": str(e), "details": error_details}, "job_id": job_id}


# --- Backtest Task (to be run in background) ---
def run_backtest_task(config: dict, job_store: Dict[str, Any], reference_test_data: dict = None):
    job_id = config['JOB_ID']
    try:
        print(f"Starting background backtest task for job_id: {job_id}")
        report_path = run_batch_backtest(config, reference_test_data)

        if not report_path or not os.path.exists(report_path):
             raise FileNotFoundError("Backtest completed but report file was not generated.")
        
        with open(report_path, 'r') as f:
            report_data = json.load(f)

        job_store[job_id] = {"status": "completed", "report": report_data, "job_id": job_id}
        print(f"Backtest job {job_id} completed successfully.")
    except DataValidationError as e:
        error_message = str(e)
        print(f"Backtest job {job_id} failed due to data validation. Error: {error_message}")
        job_store[job_id] = {
            "status": "failed",
            "report": {"error": "Insufficient Historical Data", "details": error_message},
            "job_id": job_id
        }
    except Exception as e:
        error_details = traceback.format_exc()
        print(f"Backtest job {job_id} failed. Error: {e}\n{error_details}")
        job_store[job_id] = {"status": "failed", "report": {"error": str(e), "details": error_details}, "job_id": job_id}


# === CONFIGURATION ENDPOINTS ===
VERIFIED_SPOT_EXCHANGES = [
    {'value': 'bequant', 'label': 'Bequant'},
    {'value': 'binanceus', 'label': 'Binance US'},
    {'value': 'bingx', 'label': 'BingX'},
    {'value': 'bitget', 'label': 'Bitget'},
    {'value': 'bithumb', 'label': 'Bithumb'},
    {'value': 'bitmart', 'label': 'BitMart'},
    {'value': 'bitrue', 'label': 'Bitrue'},
    {'value': 'bitstamp', 'label': 'Bitstamp'},
    {'value': 'bitvavo', 'label': 'Bitvavo'},
    {'value': 'btcalpha', 'label': 'BTC-Alpha'},
    {'value': 'coincatch', 'label': 'CoinCatch'},
    {'value': 'coinsph', 'label': 'Coins.ph'},
    {'value': 'digifinex', 'label': 'DigiFinex'},
    {'value': 'exmo', 'label': 'EXMO'},
    {'value': 'fmfwio', 'label': 'FMFW.io'},
    {'value': 'gate', 'label': 'Gate.io'},
    {'value': 'hashkey', 'label': 'HashKey Global'},
    {'value': 'htx', 'label': 'HTX'},
    {'value': 'kraken', 'label': 'Kraken'},
    {'value': 'kucoin', 'label': 'KuCoin'},
    {'value': 'lbank', 'label': 'LBank'},
    {'value': 'mexc', 'label': 'MEXC Global'},
    {'value': 'myokx', 'label': 'MyOKX(EEA)'},
    {'value': 'novadax', 'label': 'NovaDAX'},
    {'value': 'okx', 'label': 'OKX'},
    {'value': 'okxus', 'label': 'OKX(US)'},
    {'value': 'p2b', 'label': 'p2b'},
    {'value': 'poloniex', 'label': 'Poloniex'},
    {'value': 'probit', 'label': 'ProBit'},
    {'value': 'timex', 'label': 'TimeX'},
    {'value': 'upbit', 'label': 'Upbit'},
    {'value': 'vertex', 'label': 'Vertex'},
    {'value': 'wavesexchange', 'label': 'Waves.Exchange'},
    {'value': 'whitebit', 'label': 'WhiteBit'},
    {'value': 'xt', 'label': 'XT'},
]

GUNBOT_SUPPORTED_IDS = {
    'binance', 'binanceus', 'bingx', 'bitget',
    'kraken', 'kucoin', 'mexc', 'okx', 'poloniex',
    'gate',  # 'gate.io' and 'gate' are often aliases
}

@router.get("/exchanges", response_model=List[Dict[str, Any]], tags=["Configuration"])
async def get_exchanges():
    """
    Returns a structured list of exchanges, prioritizing those supported by Gunbot.
    The list is built from a pre-vetted list of functional spot exchanges.
    """
    # --- YFINANCE CHANGE 1 of 2: Add yfinance to the primary group ---
    gunbot_group = [
        {'value': 'binance', 'label': 'Binance'},
        {'value': 'yfinance', 'label': 'Yahoo Finance (Stocks/ETFs)'}
    ]
    other_group = []

    # Create a lookup for verified exchanges
    verified_map = {ex['value']: ex['label'] for ex in VERIFIED_SPOT_EXCHANGES}

    for ex_id, ex_label in sorted(verified_map.items()):
        # Add to the appropriate group
        if ex_id in GUNBOT_SUPPORTED_IDS:
            gunbot_group.append({'value': ex_id, 'label': ex_label})
        else:
            other_group.append({'value': ex_id, 'label': ex_label})
    
    # Combine the groups for the final response, which Mantine Select can render with <Select.Group>
    return [
        {'group': 'Primary Exchanges', 'items': gunbot_group},
        {'group': 'Other CCXT Exchanges', 'items': other_group},
    ]


@router.get("/markets/{exchange_id}", response_model=List[str], tags=["Configuration"])
async def get_markets(exchange_id: str):
    """Returns a list of major quote assets available on the specified exchange."""
    # --- YFINANCE CHANGE 2 of 2: Handle the yfinance case ---
    if exchange_id == 'yfinance':
        return []

    try:
        if not hasattr(ccxt, exchange_id):
            logging.warning(f"Exchange '{exchange_id}' not found in CCXT.")
            return sorted(list({'USDT', 'BTC', 'ETH'}))
            
        exchange_class = getattr(ccxt, exchange_id)
        exchange = exchange_class()
        exchange.load_markets()
        
        major_quotes = {'USDT', 'USD', 'USDC', 'TUSD', 'FDUSD', 'DAI', 'BUSD', 'BTC', 'ETH', 'BNB', 'EUR', 'GBP'}
        
        available_quotes = {market['quote'] for market in exchange.markets.values() if market.get('spot', False)}
        
        if not available_quotes:
            available_quotes = {market['quote'] for market in exchange.markets.values() if market.get('swap', False)}
        
        return sorted(list(available_quotes.intersection(major_quotes)))
    except Exception as e:
        logging.error(f"Could not load markets for {exchange_id}: {e}")
        return sorted(list({'USDT', 'BTC', 'ETH'}))


@router.get("/strategies", response_model=List[Dict[str, Any]], tags=["Configuration"])
async def get_strategies():
    """Returns a list of all available strategies with their details and parameter definitions."""
    try:
        strategy_details = []
        sorted_items = sorted(STRATEGY_MAPPING.items(), key=lambda item: (item[1].get('category', 'Z'), item[0]))
        for name, meta in sorted_items:
             strategy_details.append({
                 "value": name,
                 "label": name.replace("_", " "),
                 "description": meta.get("description", "No description available."),
                 "category": meta.get("category", "General"),
                 "params_def": meta.get("params_def", {}),
                 "is_legacy": meta.get("is_legacy", False)
             })
        return strategy_details
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not load strategy list: {e}")

# === SCREENER ENDPOINTS ===
SCREENER_METRIC_DEFINITIONS = [
    {'value': 'avg_vol_30d_quote', 'label': 'Avg Volume (30-Day)', 'description': 'The average daily trading volume over the last 30 days, measured in the quote asset (e.g., USDT). Useful for ensuring liquidity. Example: > 10000000 for high volume.', 'category': 'Volume'},
    {'value': 'rel_vol_10d_quote', 'label': 'Relative Volume (10-Day)', 'description': 'The ratio of the latest daily volume to the 10-day average volume. A value > 1 indicates above-average volume. Example: > 1.5 for volume spikes.', 'category': 'Volume'},
    {'value': 'roc_7p', 'label': 'Rate of Change (7-period)', 'description': 'Percentage change in price over the last 7 candles of the selected timeframe. Measures short-term momentum. Example: > 10 for strong uptrend.', 'category': 'Momentum'},
    {'value': 'roc_14p', 'label': 'Rate of Change (14-period)', 'description': 'Percentage change in price over the last 14 candles of the selected timeframe. Measures short-term momentum.', 'category': 'Momentum'},
    {'value': 'roc_30p', 'label': 'Rate of Change (30-period)', 'description': 'Percentage change in price over the last 30 candles of the selected timeframe. Measures medium-term momentum.', 'category': 'Momentum'},
    {'value': 'roc_90p', 'label': 'Rate of Change (90-period)', 'description': 'Percentage change in price over the last 90 candles of the selected timeframe. Measures longer-term momentum.', 'category': 'Momentum'},
    {'value': 'roc_200p', 'label': 'Rate of Change (200-period)', 'description': 'Percentage change in price over the last 200 candles of the selected timeframe. Measures long-term trend.', 'category': 'Momentum'},
    {'value': 'dist_from_ath_lookback_pct', 'label': 'Distance from Recent High (%)', 'description': 'Percentage distance from the High within the loaded data (approx 250 candles). A value of -10 means the price is 10% below the recent high.', 'category': 'Trend'},
    {'value': 'price_vs_sma50', 'label': 'Price vs. 50-period SMA', 'description': 'Percentage distance of the current price from its 50-period SMA. Positive means price is above the moving average. Example: > 2 for bullish trend.', 'category': 'Trend'},
    {'value': 'price_vs_sma200', 'label': 'Price vs. 200-period SMA', 'description': 'Percentage distance of the current price from its 200-period SMA. A key indicator for long-term trend direction. Example: > 5 for strong long-term uptrend.', 'category': 'Trend'},
    {'value': 'sma50_vs_sma200', 'label': '50 SMA vs. 200 SMA', 'description': 'Percentage distance of the 50-period SMA from the 200-period SMA. A positive value (Golden Cross) is a strong bullish signal.', 'category': 'Trend'},
    {'value': 'adx_14p', 'label': 'ADX (14-period)', 'description': 'Average Directional Index. Measures trend strength, not direction. A value > 25 typically indicates a strong trend (either up or down).', 'category': 'Trend'},
    {'value': 'atr_pct_14p', 'label': 'ATR (14-period) %', 'description': 'Average True Range as a percentage of the current price. Measures volatility. Example: between 2 and 10 to filter out flat and overly volatile assets.', 'category': 'Volatility'},
    {'value': 'rsi_14p', 'label': 'RSI (14-period)', 'description': 'Relative Strength Index. Measures momentum on a 0-100 scale. < 30 is often considered oversold, > 70 is overbought.', 'category': 'Oscillator'},
    {'value': 'stochrsi_k_14_3_3', 'label': 'StochRSI %K (14,3,3)', 'description': 'The %K line of the Stochastic RSI. A fast-moving oscillator (0-100) that measures RSI momentum. < 20 is oversold.', 'category': 'Oscillator'},
    {'value': 'stochrsi_d_14_3_3', 'label': 'StochRSI %D (14,3,3)', 'description': 'The %D line (slow line) of the Stochastic RSI. A smoothed version of %K. < 20 is oversold.', 'category': 'Oscillator'},
]

@router.get("/screen/metrics", response_model=List[Dict[str, Any]], tags=["Screening"])
async def get_screener_metrics(exchange: str = ''):
    """Returns a list of all available screener metrics with their definitions."""
    
    # Base definitions
    metrics = SCREENER_METRIC_DEFINITIONS
    
    if exchange == 'yfinance':
        for metric in metrics:
            if metric['value'] == 'avg_vol_30d_quote':
                metric['label'] = 'Avg Volume (30-Day, Shares)'
                metric['description'] = 'The average daily trading volume in number of shares over the last 30 days. Useful for ensuring liquidity.'
            if metric['value'] == 'rel_vol_10d_quote':
                metric['value'] = 'rel_vol_10d' # The backend uses this name now
                metric['label'] = 'Relative Volume (10-Day, Shares)'
                metric['description'] = 'The ratio of the latest daily volume in shares to the 10-day average volume.'

    return metrics

@router.post("/screen/configs/{config_name}", status_code=201, tags=["Screening"])
async def save_screener_config(config_name: str, config: ScreenerConfig):
    if not config_name.strip():
        raise HTTPException(status_code=400, detail="Config name cannot be empty.")
    
    file_path = os.path.join(SCREENER_CONFIGS_DIR, f"{config_name}.json")
    try:
        with open(file_path, 'w') as f:
            json.dump(config.model_dump(), f, indent=4)
        return {"message": f"Configuration '{config_name}' saved successfully."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save config: {e}")

@router.get("/screen/configs", response_model=List[str], tags=["Screening"])
async def list_screener_configs():
    try:
        return sorted([f.replace('.json', '') for f in os.listdir(SCREENER_CONFIGS_DIR) if f.endswith('.json')])
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list configs: {e}")

@router.post("/screen", response_model=ScreenerResponse, status_code=202, tags=["Screening"])
async def start_screener(req: ScreenerRequest, request: Request, background_tasks: BackgroundTasks):
    job_id = req.job_name
    job_store = request.app.state.job_results

    if job_id in job_store and job_store[job_id].get('status') == 'running':
         raise HTTPException(status_code=409, detail=f"Job '{job_id}' is already running.")

    # --- UPDATED: Pass the new 'symbols' field for yfinance ---
    screener_config = {
        'JOB_ID': job_id,
        'JOB_NAME': req.job_name,
        'EXCHANGE': req.config.exchange,
        'SCREENER_QUOTE_ASSET': req.config.quote_asset,
        'timeframe': req.config.timeframe,
        'SCREENER_CANDIDATE_COUNT': req.config.candidate_count,
        'SCREENER_FINAL_COUNT': req.config.final_count,
        'SCREENER_FILTERS': [f.model_dump() for f in req.config.filters],
        'SCREENER_RANK_METRIC': req.config.rank_metric,
        'SYMBOLS': req.config.symbols, # <-- NEW
    }

    job_store[job_id] = {"status": "running", "report": None, "job_id": job_id}
    background_tasks.add_task(run_screener_task, screener_config, job_store)
    
    return ScreenerResponse(message=f"Screener job '{job_id}' started.", job_id=job_id)

@router.get("/screen/status/{job_id}", response_model=BacktestResponse, tags=["Screening"])
async def get_screener_status(job_id: str, request: Request):
    job_store = request.app.state.job_results
    job = job_store.get(job_id)

    if not job:
        report_path = os.path.join(SCREENER_RESULTS_DIR, f"{job_id}.json")
        if os.path.exists(report_path):
            with open(report_path, 'r') as f: report_data = json.load(f)
            return BacktestResponse(status="completed", message="Job finished successfully.", report=report_data, job_id=job_id)
        raise HTTPException(status_code=404, detail="Job not found in active queue or on disk.")
    
    if job['status'] == 'completed':
        return BacktestResponse(status="completed", message="Job finished successfully.", report=job['report'], job_id=job_id)
    elif job['status'] == 'failed':
        return BacktestResponse(status="failed", message="Job failed.", report=job['report'], job_id=job_id)
    else:
        return BacktestResponse(status="running", message="Job is in progress.", job_id=job_id)

@router.get("/screen/results", response_model=List[str], tags=["Screening"])
async def list_screener_results():
    if not os.path.exists(SCREENER_RESULTS_DIR): return []
    try:
        return sorted([f.split('.json')[0] for f in os.listdir(SCREENER_RESULTS_DIR) if f.endswith('.json')], reverse=True)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read screener results directory: {e}")

@router.get("/screen/results/{job_id}", response_model=Dict[str, Any], tags=["Screening"])
async def get_screener_result(job_id: str):
    report_path = os.path.join(SCREENER_RESULTS_DIR, f"{job_id}.json")
    if not os.path.exists(report_path):
        raise HTTPException(status_code=404, detail=f"Screener result for job ID '{job_id}' not found.")
    try:
        with open(report_path, 'r') as f: return json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read screener report file: {e}")

# === BACKTESTING ENDPOINTS ===
@router.post("/backtest", response_model=BacktestResponse, status_code=202, tags=["Backtesting"])
async def start_backtest(req: BacktestRequest, request: Request, background_tasks: BackgroundTasks):
    job_id = req.scenario_name
    job_store = request.app.state.job_results

    if job_id in job_store and job_store[job_id].get('status') == 'running':
         raise HTTPException(status_code=409, detail=f"Job '{job_id}' is already running.")

    config = BASE_CONFIG.copy()
    config.update({
        "JOB_ID": job_id, "SCENARIO_NAME": job_id, "INITIAL_CAPITAL": req.initial_capital,
        "EXCHANGE": req.exchange,
        "TIMEFRAME": req.timeframe, "BACKTEST_START_DATE": req.start_date, "BACKTEST_END_DATE": req.end_date,
        "STRATEGIES": [s.model_dump() for s in req.strategies]
    })
    
    if req.selection_method == "FROM_CONFIG":
        config_path = os.path.join(SCREENER_CONFIGS_DIR, f"{req.screener_config_name}.json")
        if not os.path.exists(config_path):
            raise HTTPException(status_code=404, detail=f"Screener config '{req.screener_config_name}' not found.")
        with open(config_path, 'r') as f:
            screener_conf = json.load(f)
        
        config.update({
            "SYMBOL_SELECTION_METHOD": "MOMENTUM_SCREENER",
            "SCREENER_QUOTE_ASSET": screener_conf.get("quote_asset"),
            "SCREENER_CANDIDATE_COUNT": screener_conf.get("candidate_count"),
            "SCREENER_FINAL_COUNT": screener_conf.get("final_count"),
            "SCREENER_FILTERS": screener_conf.get("filters"),
            "SCREENER_RANK_METRIC": screener_conf.get("rank_metric"),
        })
        if 'exchange' in screener_conf:
             config['EXCHANGE'] = screener_conf['exchange']
    else:
        config["SYMBOL_SELECTION_METHOD"] = "EXPLICIT_LIST"
        config["SYMBOLS"] = req.symbols

    job_store[job_id] = {"status": "running", "report": None, "job_id": job_id}
    background_tasks.add_task(run_backtest_task, config, job_store)

    return BacktestResponse(status="running", message=f"Backtest '{job_id}' started.", job_id=job_id)

@router.get("/backtest/status/{job_id}", response_model=BacktestResponse, tags=["Backtesting"])
async def get_backtest_status(job_id: str, request: Request):
    job_store = request.app.state.job_results
    job = job_store.get(job_id)

    if not job:
        report_path = os.path.join(RESULTS_DIR, job_id, f"report_{job_id}.json")
        if os.path.exists(report_path):
             with open(report_path, 'r') as f: report_data = json.load(f)
             return BacktestResponse(status="completed", message="Job finished successfully.", report=report_data, job_id=job_id)
        raise HTTPException(status_code=404, detail="Job not found in active queue or on disk.")
    
    if job['status'] == 'completed':
        return BacktestResponse(status="completed", message="Job finished successfully.", report=job['report'], job_id=job_id)
    elif job['status'] == 'failed':
        return BacktestResponse(status="failed", message="Job failed.", report=job['report'], job_id=job_id)
    else:
        return BacktestResponse(status="running", message="Job is in progress.", job_id=job_id)

@router.get("/backtest/results", response_model=List[str], tags=["Results"])
async def list_results():
    if not os.path.exists(RESULTS_DIR): return []
    try:
        valid_results = []
        for d in os.listdir(RESULTS_DIR):
            if d.startswith(('Benchmark-', 'Discovery-')):
                continue

            dir_path = os.path.join(RESULTS_DIR, d)
            report_path = os.path.join(dir_path, f"report_{d}.json")
            if os.path.isdir(dir_path) and os.path.exists(report_path):
                valid_results.append(d)
        return sorted(valid_results, reverse=True)

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read results directory: {e}")

@router.get("/backtest/results/{job_id}", response_model=Dict[str, Any], tags=["Results"])
async def get_result(job_id: str):
    report_path = os.path.join(RESULTS_DIR, job_id, f"report_{job_id}.json")
    if not os.path.exists(report_path):
        raise HTTPException(status_code=404, detail=f"Result for job ID '{job_id}' not found.")

    try:
        with open(report_path, "r") as fp:
            return json.load(fp)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read or parse report file: {e}")

# === GUNBOT API ENDPOINTS ===
def create_gunbot_pair_report_data(pair_data: dict, initial_capital: float) -> dict:
    """Creates a synthetic backtest result from live Gunbot order data."""
    orders = sorted(pair_data.get('orders', []), key=lambda x: x['time'])
    if not orders:
        return {}

    trade_orders = [o for o in orders if o.get('pnl') is not None]
    if not trade_orders:
        return {}

    trades_df = pd.DataFrame(trade_orders)

    # --- THE FIX: Robustly create pnl_value and pnl_percent columns ---
    trades_df.rename(columns={'pnl': 'pnl_value'}, inplace=True)
    
    if 'pnlPercent' in trades_df.columns:
        trades_df.rename(columns={'pnlPercent': 'pnl_percent'}, inplace=True)
    elif 'cost' in trades_df.columns:
        trades_df['pnl_percent'] = np.where(
            trades_df['cost'] != 0,
            (trades_df['pnl_value'] / trades_df['cost']) * 100,
            0.0
        )
    else:
        trades_df['pnl_percent'] = 0.0
    # --- END OF FIX ---

    trades_df['exit_reason'] = 'Gunbot Trade'
    
    equity_curve = [initial_capital]
    for pnl in trades_df['pnl_value']: equity_curve.append(equity_curve[-1] + pnl)
    
    ts_index = pd.to_datetime([o['time'] for o in orders if o.get('pnl') is not None], unit='ms', utc=True)
    equity_s = pd.Series(equity_curve[1:], index=ts_index) if len(ts_index) == len(equity_curve) - 1 else pd.Series(dtype=float)

    start_date = datetime.datetime.fromtimestamp(orders[0]['time'] / 1000).date()
    end_date = datetime.datetime.fromtimestamp(orders[-1]['time'] / 1000).date()
    
    stats = calculate_stats(trades_df, equity_s, initial_capital, start_date, end_date, bh_return=0.0) # BH is not applicable here
    
    return {
        "symbol": pair_data.get('standard_pair_format'),
        "strategy_name": "ACTIVE PAIR",
        "stats": stats,
        "strategy_equity_s": equity_s,
        "bh_equity_s": pd.Series(dtype=float, index=ts_index), # THE FIX: Ensure even empty series has a DatetimeIndex
        "params": {"strategy": pair_data.get('config', {}).get('strategy')},
        "timeframe": pair_data.get('candleTimeFrame'),
        "is_active_pair": True
    }

def map_gunbot_timeframe(period_in_minutes: int) -> str:
    """Maps Gunbot's period in minutes to a CCXT-compatible timeframe string."""
    if not period_in_minutes: return '1h'
    if period_in_minutes < 60: return f"{period_in_minutes}m"
    if period_in_minutes < 1440: return f"{period_in_minutes // 60}h"
    return f"{period_in_minutes // 1440}d"

def run_gunbot_benchmark_task(config_template: dict, job_store: Dict[str, Any]):
    job_id = config_template['JOB_ID']
    try:
        print(f"Starting Gunbot benchmark task for job_id: {job_id}")
        exchange = config_template.get('EXCHANGE') # Already normalized
        data_manager = DataManager(exchange=exchange)
        reference_data = create_gunbot_pair_report_data(config_template['pair_data'], config_template['INITIAL_CAPITAL'])
        all_individual_results = [reference_data]
        symbol = config_template['symbol'] # Already normalized
        
        for timeframe in config_template['timeframes_to_test']:
            print(f"--- Running benchmark for timeframe: {timeframe} ---")
            tf_config = config_template.copy()
            tf_config['TIMEFRAME'] = timeframe
            data_manager.warm_data_cache(symbols=[symbol], timeframe=timeframe, config=tf_config)
            symbol_results = _process_symbol(symbol, tf_config, data_manager)
            if symbol_results:
                all_individual_results.extend(symbol_results)

        report_path = _aggregate_and_save_report(all_individual_results, config_template)
        if not report_path or not os.path.exists(report_path):
             raise FileNotFoundError("Benchmark completed but report file was not generated.")
        with open(report_path, 'r') as f: report_data = json.load(f)
        job_store[job_id] = {"status": "completed", "report": report_data, "job_id": job_id}
        print(f"Benchmark job {job_id} completed successfully.")
    except DataValidationError as e:
        error_message = str(e)
        print(f"Benchmark job {job_id} failed due to data validation. Error: {error_message}")
        job_store[job_id] = {"status": "failed", "report": {"error": "Insufficient Historical Data", "details": error_message}, "job_id": job_id}
    except Exception as e:
        error_details = traceback.format_exc()
        print(f"Benchmark job {job_id} failed. Error: {e}\n{error_details}")
        job_store[job_id] = {"status": "failed", "report": {"error": str(e), "details": error_details}, "job_id": job_id}

def run_find_better_pair_task(config_template: dict, job_store: Dict[str, Any]):
    job_id = config_template['JOB_ID']
    try:
        print(f"Starting 'Find Better Pair' task for job_id: {job_id}")
        exchange = config_template.get('EXCHANGE') # Already normalized
        data_manager = DataManager(exchange=exchange)
        reference_data = create_gunbot_pair_report_data(config_template['pair_data'], config_template['INITIAL_CAPITAL'])
        all_results_for_report = [reference_data]
        
        original_symbol = config_template['symbol'] # Already normalized
        quote_asset = config_template['quote_asset']

        screener_config = {
            'EXCHANGE': exchange,
            'SCREENER_QUOTE_ASSET': quote_asset,
            'SCREENER_CANDIDATE_COUNT': config_template.get('candidate_count', 200),
            'timeframe': config_template['TIMEFRAME'],
            'BACKTEST_START_DATE': config_template.get('BACKTEST_START_DATE'),
            'BACKTEST_END_DATE': config_template.get('BACKTEST_END_DATE'),
        }
        screener = Screener(exchange=exchange, config=screener_config)
        candidate_symbols = screener._get_candidate_symbols()
        
        analysis_df = screener._analyze_candidates(candidate_symbols)
        if analysis_df.empty:
            raise ValueError("Analysis of candidate symbols yielded no data.")
            
        min_vol = config_template.get('min_daily_volume', 1000000)
        analysis_df = analysis_df[analysis_df['avg_vol_30d_quote'] >= min_vol]
        print(f"  - After minimum volume filter (>= ${min_vol:,.0f}), {len(analysis_df)} symbols remain.")

        quality_symbols = screener.filter_by_heuristics(analysis_df)
        
        symbols_to_benchmark = list(set([original_symbol] + quality_symbols))
        print(f"Found {len(symbols_to_benchmark)} unique, quality-checked symbols to benchmark.")

        data_manager.warm_data_cache(symbols=symbols_to_benchmark, timeframe=config_template['TIMEFRAME'], config=config_template)
        
        for symbol in symbols_to_benchmark:
            all_strategy_results_for_symbol = _process_symbol(symbol, config_template, data_manager)
            
            if not all_strategy_results_for_symbol:
                continue

            best_result = max(
                all_strategy_results_for_symbol, 
                key=lambda r: r['stats'].get('Sharpe Ratio (ann.)', -999)
            )
            all_results_for_report.append(best_result)

        report_path = _aggregate_and_save_report(all_results_for_report, config_template)

        if not report_path or not os.path.exists(report_path):
             raise FileNotFoundError("Discovery run completed but report file was not generated.")
        
        with open(report_path, 'r') as f:
            report_data = json.load(f)

        job_store[job_id] = {"status": "completed", "report": report_data, "job_id": job_id}
        print(f"Discovery job {job_id} completed successfully.")
    except DataValidationError as e:
        error_message = str(e)
        print(f"Discovery job {job_id} failed due to data validation. Error: {error_message}")
        job_store[job_id] = {"status": "failed", "report": {"error": "Insufficient Historical Data", "details": error_message}, "job_id": job_id}
    except Exception as e:
        error_details = traceback.format_exc()
        print(f"Discovery job {job_id} failed. Error: {e}\n{error_details}")
        job_store[job_id] = {"status": "failed", "report": {"error": str(e), "details": error_details}, "job_id": job_id}


@router.post("/gunbot/connect", tags=["Gunbot"])
async def connect_gunbot(req: GunbotConnectRequest):
    # --- ADDED: Verbose logging ---
    print("--- RECEIVED GUNBOT CONNECT REQUEST ---")
    # Print a sanitized version without the password
    sanitized_req = req.model_dump()
    sanitized_req['password'] = '********'
    print(sanitized_req)
    print("------------------------------------")
    try:
        result = gunbot_client.login_and_initialize_api(
            password=req.password,
            protocol=req.protocol,
            host=req.host,
            port=req.port,
            gunthy_wallet=req.gunthy_wallet
        )
        
        if not result.get("success"):
            raise HTTPException(status_code=401, detail=result.get("error", "Login failed."))
        
        return {"status": "success", "message": result.get("message"), "data": result.get("data")}

    except Exception as e:
        gunbot_client.clear_credentials()
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=500, detail=f"An error occurred during connection: {str(e)}")

@router.get("/gunbot/status", tags=["Gunbot"])
async def get_gunbot_status():
    creds = gunbot_client.load_credentials()
    if not creds:
        return {"connected": False, "status": "disconnected", "message": "Not connected. No credentials found."}

    api = gunbot_client.get_gunbot_api()
    if not api:
        return {"connected": False, "status": "disconnected", "message": "Not connected. Credentials exist but API not initialized."}

    auth_result = gunbot_client.auth_status()
    config_data = {"protocol": creds.get('protocol'), "host": creds.get('host'), "port": creds.get('port')}

    if not auth_result.get("success"):
        return {"connected": False, "status": "error", "message": f"Connection failed: {auth_result.get('error')}", "config": config_data}

    # NEW: Check coremem for activity
    coremem_result = gunbot_client.coremem()
    bot_status = "active" # Assume active
    message = "Connected to Gunbot."
    if not coremem_result.get("success"):
        bot_status = "error"
        message = f"Connected but cannot read core memory: {coremem_result.get('error')}"
    else:
        coremem_data = coremem_result.get("data", {})
        if not coremem_data.get("config"):
            bot_status = "starting"
            message = "Connected. Gunbot is online but appears to be starting up (no config loaded in memory)."
        else:
            active_pairs = 0
            for ex, pairs in coremem_data.get("config", {}).items():
                if isinstance(pairs, dict):
                    active_pairs += sum(1 for p_cfg in pairs.values() if isinstance(p_cfg, dict) and p_cfg.get("enabled"))
            
            if active_pairs > 0:
                bot_status = "active"
                message = f"Connected and monitoring {active_pairs} active pair(s)."
            else:
                bot_status = "idle"
                message = "Connected, but no pairs are currently enabled in Gunbot."

    return {
        "connected": True,
        "status": bot_status, # 'active', 'idle', 'starting', 'error', 'disconnected'
        "message": message,
        "data": auth_result.get("data"),
        "config": config_data
    }

@router.get("/gunbot/config", tags=["Gunbot"])
async def get_gunbot_config():
    """
    Returns a list of exchange names from the Gunbot configuration.
    """
    result = gunbot_client.config_full()
    if not result.get("success"):
        raise HTTPException(status_code=503, detail=f"Could not fetch Gunbot config: {result.get('error')}")

    config_data = result.get("data", {})
    config_full = config_data.get("config", {})
    exchanges_obj = config_full.get("exchanges", {})

    # Ensure we have a dictionary before getting keys.
    if not isinstance(exchanges_obj, dict):
        return {"exchanges": []}

    # Explicitly get the list of keys from the dictionary.
    exchange_names = list(exchanges_obj.keys())
    print(exchange_names)

    return {"exchanges": sorted(exchange_names)}

@router.post("/gunbot/pairs/add", tags=["Gunbot"])
async def add_pair_to_gunbot(req: GunbotAddPairRequest):
    """Adds or updates a pair in Gunbot, validates period, and copies the strategy file."""
    try:
        # --- 1. Period Validation ---
        period_minutes = timeframe_to_minutes(req.timeframe)
        if period_minutes == 0:
            raise HTTPException(status_code=400, detail=f"Invalid timeframe format: '{req.timeframe}'.")

        clean_exchange = req.exchange.split('#')[0].lower()
        supported_periods = GUNBOT_PERIOD_MATRIX.get(clean_exchange)
        if not supported_periods:
            raise HTTPException(status_code=400, detail=f"Exchange '{req.exchange}' is not in Gunbot's supported period matrix.")
        
        if period_minutes not in supported_periods:
            raise HTTPException(status_code=400, detail=f"Timeframe '{req.timeframe}' ({period_minutes}m) is not supported for '{req.exchange}' in Gunbot. Supported periods (minutes): {supported_periods}")

        # --- 2. Strategy File Handling & Naming ---
        strategy_meta = STRATEGY_MAPPING.get(req.strategy_name)
        if not strategy_meta or not strategy_meta.get("fileName"):
            raise HTTPException(status_code=404, detail=f"Strategy metadata or filename for '{req.strategy_name}' not found.")
        
        strategy_filename = os.path.basename(strategy_meta["fileName"])
        gunbot_strategy_name = strategy_filename.replace('.js', '')

        strategy_file_path = os.path.join(os.path.dirname(__file__), '..', 'gunbot_strategy_files', strategy_filename)

        if not os.path.exists(strategy_file_path):
             raise HTTPException(status_code=404, detail=f"Strategy file '{strategy_filename}' not found on server at '{strategy_file_path}'.")

        with open(strategy_file_path, 'r') as f:
            strategy_content = f.read()

        file_write_result = gunbot_client.files_strategy_write(filename=strategy_filename, document=strategy_content)
        if not file_write_result.get("success"):
            raise HTTPException(status_code=503, detail=f"Failed to write strategy file to Gunbot: {file_write_result.get('error')}")

        # --- 3. Ensure Strategy exists in Gunbot config.strategies ---
        config_result = gunbot_client.config_full()
        if not config_result.get("success"):
            raise HTTPException(status_code=503, detail=f"Could not read Gunbot config to verify strategy: {config_result.get('error')}")
        
        gunbot_strategies = config_result.get("data", {}).get("config", {}).get("strategies", {})
        if gunbot_strategy_name not in gunbot_strategies:
            print(f"Strategy '{gunbot_strategy_name}' not found in Gunbot config. Adding it now...")
            add_strat_result = gunbot_client.config_strategy_add(name=gunbot_strategy_name, settings=DEFAULTSTRATEGYSETTINGS    )
            if not add_strat_result.get("success"):
                raise HTTPException(status_code=503, detail=f"Failed to add new strategy '{gunbot_strategy_name}' to Gunbot config: {add_strat_result.get('error')}")

        # --- 4. Pair Configuration ---
        base_asset = req.standard_pair.replace(req.quote_asset, '')
        gunbot_pair = f"{req.quote_asset}-{base_asset}"

        overrides = {
            "BUY_METHOD": "custom",
            "SELL_METHOD": "custom",
            "STRAT_FILENAME": strategy_filename,
            "PERIOD": period_minutes,
            "BUY_ENABLED": req.buy_enabled,
            "SELL_ENABLED": req.sell_enabled,
            "STOP_AFTER_SELL": False,
            "INITIAL_CAPITAL": req.initial_capital,
            "MIN_VOLUME_TO_SELL": req.min_volume_to_sell,
            "START_TIME": req.start_time,
        }
        
        overrides.update(req.strategy_params)

        body = {
            "pair": gunbot_pair,
            "exchange": req.exchange,
            "settings": {
                "strategy": gunbot_strategy_name,
                "enabled": True,
                "override": overrides
            }
        }
        
        result = gunbot_client.config_pair_add(body=body)
        
        if not result.get("success"):
            raise HTTPException(status_code=400, detail=result.get("error", "Gunbot API returned an error."))
        
        return {"status": "success", "message": f"Successfully added/updated {gunbot_pair} on {req.exchange} and uploaded strategy file."}

    except HTTPException as e:
        raise e
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/gunbot/pairs/remove", tags=["Gunbot"])
async def remove_pair_from_gunbot(req: GunbotRemovePairRequest):
    """Removes a pair from the connected Gunbot instance."""
    result = gunbot_client.config_pair_remove(pair=req.gunbot_pair, exchange=req.exchange)
    
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "Gunbot API returned an error."))

    return {"status": "success", "message": f"Successfully removed {req.gunbot_pair} from {req.exchange}."}

@router.get("/gunbot/trading-pairs", response_model=Dict[str, Any], tags=["Gunbot"])
async def get_trading_pairs():
    result = gunbot_client.coremem()

    if not result.get("success"):
        raise HTTPException(status_code=500, detail=result.get("error", "Failed to fetch core memory."))
    
    coremem_data_wrapper = result.get("data", {})

    if not coremem_data_wrapper:
         raise HTTPException(status_code=404, detail="Core memory data is empty or missing.")

    return process_trading_pairs_from_coremem(coremem_data_wrapper)

@router.post("/gunbot/normalize-pair", tags=["Gunbot"])
async def normalize_gunbot_pair(req: GunbotNormalizeRequest):
    """Exposes the normalization logic to the frontend."""
    try:
        return _normalize_gunbot_request_data(req.pair_data)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to normalize pair data: {str(e)}")

@router.post("/gunbot/benchmark", response_model=BacktestResponse, status_code=202, tags=["Gunbot"])
async def start_gunbot_benchmark(req: GunbotBenchmarkRequest, request: Request, background_tasks: BackgroundTasks):
    job_id = req.job_name
    job_store = request.app.state.job_results

    if job_id in job_store and job_store[job_id].get('status') == 'running':
         raise HTTPException(status_code=409, detail=f"Job '{job_id}' is already running.")
    
    try:
        pair_data = req.pair_data
        
        # --- NORMALIZATION STEP ---
        norm_data = _normalize_gunbot_request_data(pair_data)
        gq_exchange = norm_data['gq_exchange']
        gq_symbol = norm_data['gq_symbol']
        
        if req.start_date and req.end_date:
            start_date = req.start_date
            end_date = req.end_date
        else:
            orders = sorted(pair_data.get('orders', []), key=lambda x: x['time'])
            if not orders:
                raise ValueError("Pair has no order history, cannot run a benchmark.")
            start_date = datetime.datetime.fromtimestamp(orders[0]['time'] / 1000).strftime('%Y-%m-%d')
            end_date = datetime.datetime.fromtimestamp(orders[-1]['time'] / 1000).strftime('%Y-%m-%d')
        
        all_strategies_config = []
        for name, meta in STRATEGY_MAPPING.items():
            if meta.get("is_legacy"): continue # Don't include legacy optimizer in benchmarks
            default_params = { key: p_def.get('default') for key, p_def in meta.get('params_def', {}).items() }
            all_strategies_config.append({'name': name, 'alias': name.replace("_", " "), 'params': default_params})

        config_template = BASE_CONFIG.copy()
        config_template.update({
            "JOB_ID": job_id, "SCENARIO_NAME": job_id, "INITIAL_CAPITAL": req.initial_capital,
            "EXCHANGE": gq_exchange,
            "BACKTEST_START_DATE": start_date, "BACKTEST_END_DATE": end_date, "STRATEGIES": all_strategies_config,
            "pair_data": pair_data, "symbol": gq_symbol, "timeframes_to_test": req.timeframes_to_test,
            "gunbot_warning": norm_data['warning']
        })

        job_store[job_id] = {"status": "running", "report": None, "job_id": job_id}
        background_tasks.add_task(run_gunbot_benchmark_task, config_template, job_store)

        return BacktestResponse(status="running", message=f"Benchmark '{job_id}' started.", job_id=job_id)

    except Exception as e:
        error_details = traceback.format_exc()
        print(f"Benchmark job {job_id} failed to start. Error: {e}\n{error_details}")
        raise HTTPException(status_code=400, detail=f"Failed to start benchmark: {str(e)}")

@router.post("/gunbot/find-better-pair", response_model=BacktestResponse, status_code=202, tags=["Gunbot"])
async def find_better_pair(req: FindBetterPairRequest, request: Request, background_tasks: BackgroundTasks):
    job_id = req.job_name
    job_store = request.app.state.job_results

    if job_id in job_store and job_store[job_id].get('status') == 'running':
         raise HTTPException(status_code=409, detail=f"Job '{job_id}' is already running.")
    
    try:
        pair_data = req.pair_data

        # --- NORMALIZATION STEP ---
        norm_data = _normalize_gunbot_request_data(pair_data)
        gq_exchange = norm_data['gq_exchange']
        gq_symbol = norm_data['gq_symbol']
        quote_asset = norm_data['quote_asset']
        
        if norm_data['is_tradfi']:
            raise HTTPException(
                status_code=400, 
                detail="The 'Find Better Pair' feature is not supported for TradFi assets (from Alpaca/yfinance) as it relies on market-wide volume scanning."
            )

        if req.start_date and req.end_date:
            start_date = req.start_date
            end_date = req.end_date
        else:
            orders = sorted(pair_data.get('orders', []), key=lambda x: x['time'])
            if not orders:
                raise ValueError("Pair has no order history to define a time range.")
            start_date = datetime.datetime.fromtimestamp(orders[0]['time'] / 1000).strftime('%Y-%m-%d')
            end_date = datetime.datetime.fromtimestamp(orders[-1]['time'] / 1000).strftime('%Y-%m-%d')

        if req.timeframe:
            timeframe = req.timeframe
        else:
            timeframe = map_gunbot_timeframe(pair_data.get('candleTimeFrame'))

        all_strategies_config = []
        for name, meta in STRATEGY_MAPPING.items():
            if meta.get("is_legacy"): continue # Don't include legacy optimizer
            default_params = { key: p_def.get('default') for key, p_def in meta.get('params_def', {}).items() }
            all_strategies_config.append({'name': name, 'alias': name.replace("_", " "), 'params': default_params})

        config_template = BASE_CONFIG.copy()
        config_template.update({
            "JOB_ID": job_id, "SCENARIO_NAME": job_id,
            "EXCHANGE": gq_exchange,
            "INITIAL_CAPITAL": req.initial_capital,
            "BACKTEST_START_DATE": start_date, "BACKTEST_END_DATE": end_date,
            "TIMEFRAME": timeframe, "STRATEGIES": all_strategies_config,
            "pair_data": pair_data, "symbol": gq_symbol,
            "quote_asset": quote_asset,
            "candidate_count": req.candidate_count,
            "min_daily_volume": req.min_daily_volume,
            "gunbot_warning": norm_data['warning']
        })

        job_store[job_id] = {"status": "running", "report": None, "job_id": job_id}
        background_tasks.add_task(run_find_better_pair_task, config_template, job_store)

        return BacktestResponse(status="running", message=f"Discovery job '{job_id}' started.", job_id=job_id)

    except Exception as e:
        error_details = traceback.format_exc()
        print(f"Discovery job {job_id}' failed to start. Error: {e}\n{error_details}")
        raise HTTPException(status_code=400, detail=f"Failed to start discovery run: {str(e)}")


@router.get("/gunbot/discovery/results", response_model=List[str], tags=["Gunbot"])
async def list_discovery_results():
    """Lists all saved discovery and benchmark reports."""
    if not os.path.exists(RESULTS_DIR):
        return []
    try:
        discovery_results = []
        for d in os.listdir(RESULTS_DIR):
            if d.startswith(('Benchmark-', 'Discovery-')):
                dir_path = os.path.join(RESULTS_DIR, d)
                report_path = os.path.join(dir_path, f"report_{d}.json")
                if os.path.isdir(dir_path) and os.path.exists(report_path):
                    discovery_results.append(d)
        return sorted(discovery_results, reverse=True)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read discovery results directory: {e}")


@router.post("/gunbot/disconnect", tags=["Gunbot"])
async def disconnect_gunbot():
    """Clears the stored Gunbot credentials."""
    gunbot_client.clear_credentials()
    return {"status": "success", "message": "Gunbot credentials cleared."}
```


## ./gunbot_quant/cli/__init__.py
```

```


## ./gunbot_quant/cli/main.py
```
# gunbot_quant/cli/main.py

import typer
import os
import json
import re
from typing import List
from ..config.scenarios import SCENARIOS, get_scenario_config
from ..core.engine_runner import run_batch_backtest
from typing_extensions import Annotated
from ..gunbot_api import client as gunbot_client
from ..strategies.strategy_library import STRATEGY_MAPPING

app = typer.Typer(help="Gunbot Quant - A CLI for backtesting and screening crypto trading strategies.")

# --- Gunbot command group ---
gunbot_app = typer.Typer(help="Manage Gunbot Tools.")
app.add_typer(gunbot_app, name="gunbot")

def to_snake_case(name: str) -> str:
    s1 = re.sub('(.)([A-Z][a-z]+)', r'\1_\2', name)
    return re.sub('([a-z0-9])([A-Z])', r'\1_\2', s1).lower()

@gunbot_app.command("add-pair")
def add_pair_to_gunbot(
    exchange: Annotated[str, typer.Argument(help="The exchange name as it is configured in your Gunbot (e.g., 'binance').")],
    strategy_name: Annotated[str, typer.Argument(help="The name of the GQ strategy to use (e.g., 'RSI_Reversion').")],
    pairs: Annotated[List[str], typer.Argument(help="A list of pairs in standard format (e.g., BTCUSDT ETHUSDT).")],
    quote_asset: Annotated[str, typer.Option(help="The quote asset for all pairs (e.g., USDT).")] = "USDT"
):
    """
    Adds one or more pairs to a connected Gunbot instance with a specified strategy.
    """
    print("--- Connecting to Gunbot ---")
    api = gunbot_client.get_gunbot_api()
    if not api:
        print("❌ Error: Gunbot not connected. Please connect via the UI first or ensure gunbot_creds.json exists.")
        raise typer.Exit(code=1)

    status = gunbot_client.auth_status()
    if not status.get("success"):
        print(f"❌ Error: Gunbot connection failed: {status.get('error')}")
        raise typer.Exit(code=1)
    
    print("✅ Successfully connected to Gunbot.")

    if strategy_name not in STRATEGY_MAPPING:
        print(f"❌ Error: Strategy '{strategy_name}' not found in GQ library.")
        raise typer.Exit(code=1)

    strategy_meta = STRATEGY_MAPPING[strategy_name]
    default_params = {
        key: p_def.get('default') 
        for key, p_def in strategy_meta.get('params_def', {}).items()
    }
    
    gunbot_strategy_name = to_snake_case(strategy_name)
    overrides = {
        "BUY_METHOD": "custom",
        "SELL_METHOD": "custom",
        "BUY_ENABLED": True,
        "SELL_ENABLED": True,
        "STOP_AFTER_SELL": True
    }
    for key, value in default_params.items():
        override_key = f"GQ_{gunbot_strategy_name.upper()}_{key.upper()}"
        overrides[override_key] = value

    for pair in pairs:
        print(f"--- Adding {pair} ---")
        base_asset = pair.replace(quote_asset, '')
        gunbot_pair = f"{quote_asset}-{base_asset}"
        
        body = {
            "pair": gunbot_pair,
            "exchange": exchange,
            "settings": {
                "strategy": gunbot_strategy_name,
                "enabled": True,
                "override": overrides
            }
        }
        
        result = gunbot_client.config_pair_add(body=body)
        if result.get("success"):
            print(f"✅ Successfully added/updated {gunbot_pair} on {exchange}.")
        else:
            print(f"❌ Failed to add {gunbot_pair}: {result.get('error')}")

@app.command()
def list_scenarios():
    """Lists all available scenarios defined in scenarios.py."""
    print("📋 Available Scenarios:")
    if not SCENARIOS:
        print("  No scenarios found.")
        return
    for scenario in SCENARIOS:
        print(f"  - {scenario['name']}")

@app.command()
def run(
    scenario_name: Annotated[str, typer.Argument(help="The name of the scenario to run. Use 'list-scenarios' to see options.")]
):
    """Runs a single backtesting scenario."""
    print(f"--- Starting Quant Toolbox: Running Scenario '{scenario_name}' ---")
    
    scenario_def = next((s for s in SCENARIOS if s["name"] == scenario_name), None)
    if not scenario_def:
        print(f"❌ Error: Scenario '{scenario_name}' not found.")
        print("Use 'list-scenarios' to see available options.")
        raise typer.Exit(code=1)

    print(f"\n{'#' * 70}\n### CONFIGURING SCENARIO: {scenario_name}\n{'#' * 70}\n")
    
    config = get_scenario_config(scenario_def)
    run_batch_backtest(config)
    print(f"\n--- ✅ Scenario '{scenario_name}' finished. Results are in 'results/{scenario_name}' ---")

@app.command()
def run_all():
    """Runs all available backtesting scenarios sequentially."""
    print("--- 🚀 Starting Quant Toolbox: Running ALL Scenarios ---")
    
    if not SCENARIOS:
        print("No scenarios found to run.")
        return

    for scenario_def in SCENARIOS:
        scenario_name = scenario_def["name"]
        print(f"\n{'=' * 70}\n### RUNNING SCENARIO: {scenario_name}\n{'=' * 70}\n")
        
        config = get_scenario_config(scenario_def)
        run_batch_backtest(config)
        print(f"\n--- ✅ Scenario '{scenario_name}' finished. ---")

    print("\n\n🎉 All scenarios completed.")
    
if __name__ == "__main__":
    app()
```


## ./gunbot_quant/main_executor.py
```
# gunbot_quant/main_executor.py

# ==============================================================================
# DEPRECATED FILE
# ------------------------------------------------------------------------------
# This file contains outdated logic and has been replaced by the modular
# components in the `core` and `cli` directories.
#
# DO NOT USE OR RUN THIS FILE.
#
# The main entry points for the application are:
# - For command-line interface: `python -m gunbot_quant.cli.main`
# - For API: `uvicorn gunbot_quant.api.main:app`
#
# This file is retained for historical purposes only and will be removed in a
# future version. Running it will result in incorrect, bloated reports and
# will not work with the new user interface.
# ==============================================================================

raise DeprecationWarning(
    "main_executor.py is deprecated and should not be run. "
    "It produces outdated, large report files incompatible with the current UI. "
    "Please use the CLI or API entry points instead."
)
```


## ./gunbot_quant/frontend/src/Backtester.jsx
```
/* eslint react/prop-types: 0 */
import { useState, useEffect, useRef } from 'react';
import {
  Accordion,
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Center,
  Code,
  Collapse,
  Divider,
  Grid,
  Group,
  List,
  NumberInput,
  Paper,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  TagsInput,
  Text,
  TextInput,
  Title,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconAlertCircle,
  IconCheck,
  IconInfoCircle,
  IconList,
  IconPlaystationCircle,
  IconPlus,
  IconReportAnalytics,
  IconTrash,
  IconZoomCode,
  IconBuildingStore,
} from '@tabler/icons-react';
import { randomId } from '@mantine/hooks';
import dayjs from 'dayjs';

import ResultsDisplay from './ResultsDisplay';
import ResultsSkeleton from './ResultsSkeleton';

/* ──────────────────────────────────────────
   STATIC SELECT DATA
   ────────────────────────────────────────── */
const availableTimeframes = [
  { value: '1m', label: '1 Minute' },
  { value: '3m', label: '3 Minutes' },
  { value: '5m', label: '5 Minutes' },
  { value: '15m', label: '15 Minutes' },
  { value: '30m', label: '30 Minutes' },
  { value: '1h', label: '1 Hour' },
  { value: '2h', label: '2 Hours' },
  { value: '4h', label: '4 Hours' },
  { value: '6h', label: '6 Hours' },
  { value: '12h', label: '12 Hours' },
  { value: '1d', label: '1 Day' },
  { value: '3d', label: '3 Days' },
];

const selectionMethods = [
  { value: 'EXPLICIT_LIST', label: 'Manual Symbol List' },
  { value: 'FROM_CONFIG', label: 'From a Saved Screener' },
];

/* helper for strategy params */
function ParamInput({ form, path, paramKey, pDef }) {
  if (pDef.type === 'float') {
    return (
      <NumberInput
        label={pDef.label}
        min={pDef.min}
        max={pDef.max}
        step={pDef.step}
        {...form.getInputProps(`${path}.${paramKey}`)}
      />
    );
  }
  return (
    <NumberInput
      label={pDef.label}
      min={pDef.min}
      max={pDef.max}
      step={1}
      allowDecimal={false}
      {...form.getInputProps(`${path}.${paramKey}`)}
    />
  );
}

/* ──────────────────────────────────────────
   COMPONENT
   ────────────────────────────────────────── */
export default function Backtester({ onAddPair }) {
  const theme = useMantineTheme();

  /* runtime state */
  const [jobStatus, setJobStatus] = useState('idle'); // idle | running | completed | failed
  const [jobError, setJobError] = useState(null);
  const [results, setResults] = useState(null);
  const pollingRef = useRef(null);

  const [strategyMeta, setStrategyMeta] = useState({});
  const [availableStrategies, setAvailableStrategies] = useState([]);
  const [strategiesLoading, setStrategiesLoading] = useState(true);
  const [selectedStrategyToAdd, setSelectedStrategyToAdd] = useState(null);

  // MODIFIED: State for dynamic exchange and market lists
  const [availableExchanges, setAvailableExchanges] = useState([]);
  const [exchangesLoading, setExchangesLoading] = useState(true);


  const [screenerConfigs, setScreenerConfigs] = useState([]);
  const [configsLoading, setConfigsLoading] = useState(true);

  /* UI toggles */
  const [showHelp, setShowHelp] = useState(false);
  const [resultsExpanded, setResultsExpanded] = useState(false);

  /* ─────── form ─────── */
  const form = useForm({
    initialValues: {
      scenario_name: `Run-${dayjs().format('YYYY-MM-DD_HH-mm')}`,
      exchange: 'binance',
      initial_capital: 10000,
      timeframe: '1h',
      dateRange: [dayjs().subtract(1, 'year').toDate(), new Date()],
      strategies: [],
      selection_method: 'EXPLICIT_LIST',
      symbols: ['BTCUSDT', 'ETHUSDT'],
      screener_config_name: null,
    },
    validate: (values) => ({
      scenario_name: values.scenario_name.trim().length > 0 ? null : 'Required',
      initial_capital: values.initial_capital > 0 ? null : 'Must be positive',
      dateRange: values.dateRange[0] && values.dateRange[1] ? null : 'Pick dates',
      strategies: values.strategies.length > 0 ? null : 'Add at least one strategy',
      symbols:
        values.selection_method === 'EXPLICIT_LIST' && values.symbols.length === 0
          ? 'Add symbols'
          : null,
      screener_config_name:
        values.selection_method === 'FROM_CONFIG' && !values.screener_config_name
          ? 'Select config'
          : null,
    }),
  });

  /* ─────── fetch meta ─────── */
  useEffect(() => {
    const fetchExchanges = async () => {
      setExchangesLoading(true);
      try {
        const resp = await fetch('/api/v1/exchanges');
        if (!resp.ok) throw new Error('Could not load exchange list');
        setAvailableExchanges(await resp.json());
      } catch (err) {
        notifications.show({ title: 'Error Loading Exchanges', message: err.message, color: 'red' });
      } finally {
        setExchangesLoading(false);
      }
    };

    const fetchStrategies = async () => {
      setStrategiesLoading(true);
      try {
        const resp = await fetch('/api/v1/strategies');
        if (!resp.ok) throw new Error('Could not load strategy list');
        const data = await resp.json();
        const meta = {};
        const selectData = data.map((s) => {
          meta[s.value] = s;
          return { value: s.value, label: s.label, ...s };
        });
        setStrategyMeta(meta);
        setAvailableStrategies(selectData);
        if (selectData.length > 0) setSelectedStrategyToAdd(selectData[0].value);
      } catch (err) {
        notifications.show({ title: 'Error', message: err.message, color: 'red', icon: <IconAlertCircle /> });
      } finally {
        setStrategiesLoading(false);
      }
    };

    const fetchConfigs = async () => {
      setConfigsLoading(true);
      try {
        const resp = await fetch('/api/v1/screen/configs');
        if (!resp.ok) throw new Error('Could not load screener configs');
        setScreenerConfigs(await resp.json());
      } catch (err) {
        notifications.show({ title: 'Error', message: err.message, color: 'red', icon: <IconAlertCircle /> });
      } finally {
        setConfigsLoading(false);
      }
    };

    fetchExchanges();
    fetchStrategies();
    fetchConfigs();
  }, []);

  /* build default params */
  const createStrategyObject = (meta) => {
    if (!meta) return null;
    const defaultParams = {};
    if (meta.params_def) {
      for (const [key, def] of Object.entries(meta.params_def)) {
        defaultParams[key] = def.default;
      }
    }
    return {
      id: randomId(),
      name: meta.value,
      alias: `${meta.label} #${form.values.strategies.length + 1}`,
      params: defaultParams,
    };
  };

  const handleAddStrategy = () => {
    const meta = strategyMeta[selectedStrategyToAdd];
    const obj = createStrategyObject(meta);
    if (obj) form.insertListItem('strategies', obj);
  };

  const handleAddAllStrategies = () => {
    form.setFieldValue('strategies', []);
    const newStrats = [];
    availableStrategies
      .forEach((meta) => {
        if (meta.is_legacy && form.values.exchange !== 'binance') return; // Don't add legacy for non-binance
        const params = {};
        if (meta.params_def) {
          for (const [key, def] of Object.entries(meta.params_def)) params[key] = def.default;
        }
        newStrats.push({
          id: randomId(),
          name: meta.value,
          alias: meta.label,
          params,
        });
      });
    form.setFieldValue('strategies', newStrats);
    notifications.show({
      title: 'Strategies added',
      message: `Added ${newStrats.length} strategies`,
      color: 'blue',
    });
  };

  /* ─────── polling helpers ─────── */
  const stopPolling = () => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  };
  useEffect(() => () => stopPolling(), []);

  const checkJobStatus = async (jobId) => {
    try {
      const resp = await fetch(`/api/v1/backtest/status/${jobId}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || 'Failed to fetch status');

      if (data.status === 'completed') {
        setJobStatus('completed');
        setResults(data.report);
        setResultsExpanded(true);
        notifications.show({
          title: 'Backtest completed',
          message: `Results for ${jobId} are ready`,
          color: 'green',
          icon: <IconCheck />,
        });
        stopPolling();
      } else if (data.status === 'failed') {
        setJobStatus('failed');
        setJobError(data.report?.details || data.report?.error || 'Job failed');
        notifications.show({
          title: 'Backtest failed',
          message: data.report?.error || 'An unexpected error occurred.',
          color: 'red',
          icon: <IconAlertCircle />,
          autoClose: 10000,
        });
        stopPolling();
      }
    } catch (err) {
      setJobStatus('failed');
      setJobError(err.message);
      stopPolling();
    }
  };

  /* run job */
  const runBacktest = async (values) => {
    setJobStatus('running');
    setResults(null);
    setJobError(null);
    setResultsExpanded(false);

    const body = {
      ...values,
      start_date: dayjs(values.dateRange[0]).format('YYYY-MM-DD'),
      end_date: dayjs(values.dateRange[1]).format('YYYY-MM-DD'),
      strategies: values.strategies.map(({ id, ...rest }) => rest),
    };
    delete body.dateRange;
    if (values.selection_method === 'EXPLICIT_LIST') delete body.screener_config_name;
    else delete body.symbols;

    try {
      const resp = await fetch('/api/v1/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.detail || 'Failed to start job');
      }
      const data = await resp.json();
      notifications.show({
        title: 'Backtest started',
        message: `Job '${values.scenario_name}' running`,
        color: 'blue',
      });
      const checker = () => checkJobStatus(data.job_id);
      if (pollingRef.current) clearInterval(pollingRef.current);
      pollingRef.current = setInterval(checker, 5000);
      setTimeout(checker, 1000);
    } catch (err) {
      setJobStatus('failed');
      setJobError(err.message);
      notifications.show({
        title: 'Error',
        message: err.message,
        color: 'red',
        icon: <IconAlertCircle />,
      });
    }
  };

  /* ─────── render helpers ─────── */
  const renderSelectOption = ({ option }) => {
    const meta = strategyMeta[option.value];
    if (!meta) return <div>{option.label}</div>;
    return (
      <Stack gap={2} p={2}>
        <Text size="sm">{meta.label}</Text>
        {meta.description && (
          <Text size="xs" c="dimmed" lh={1.2}>
            {meta.description}
          </Text>
        )}
      </Stack>
    );
  };

  const strategyForms = form.values.strategies.map((strat, idx) => {
    const meta = strategyMeta[strat.name] || {};
    const paramDefs = meta.params_def || {};
    const hasParams = Object.keys(paramDefs).length > 0;

    return (
      <Accordion.Item value={strat.id} key={strat.id}>
        <Accordion.Control>
          <Group justify="space-between" w="100%">
            <Text fw={500}>{strat.alias}</Text>
            <ActionIcon
              component="div"
              variant="subtle"
              color="red"
              onClick={(e) => {
                e.stopPropagation();
                form.removeListItem('strategies', idx);
              }}
            >
              <IconTrash size="1rem" />
            </ActionIcon>
          </Group>
          <Text size="xs" c="dimmed">
            Base Strategy: {meta.label}
          </Text>
        </Accordion.Control>
        <Accordion.Panel>
          <Stack>
            <TextInput
              label="Test case alias"
              description="Name in the report"
              {...form.getInputProps(`strategies.${idx}.alias`)}
            />
            {hasParams && <Divider label="Parameters" labelPosition="center" my="sm" />}
            <SimpleGrid cols={2} spacing="sm">
              {hasParams ? (
                Object.entries(paramDefs).map(([k, def]) => (
                  <ParamInput
                    key={k}
                    form={form}
                    path={`strategies.${idx}.params`}
                    paramKey={k}
                    pDef={def}
                  />
                ))
              ) : (
                <Text c="dimmed" ta="center" fz="sm" w="100%" mt="md">
                  Self‑optimizing or parameter-free strategy
                </Text>
              )}
            </SimpleGrid>
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    );
  });

  const renderResults = () => {
    if (jobStatus === 'idle') {
      return (
        <Center h={400}>
          <Stack align="center" spacing="md">
            <IconReportAnalytics size={60} stroke={1.5} color={theme.colors.gray[6]} />
            <Title order={3} ta="center">
              Ready to run
            </Title>
            <Text c="dimmed" ta="center">
              Configure settings then press Run Backtest
            </Text>
          </Stack>
        </Center>
      );
    }
    if (jobStatus === 'running') return <ResultsSkeleton />;
    if (jobStatus === 'failed')
      return (
        <Alert
          icon={<IconAlertCircle size="1rem" />}
          title="Job failed"
          color="red"
        >
          <Text>Error details:</Text>
          <Code block mt="sm">
            {jobError}
          </Code>
        </Alert>
      );
    return results ? <ResultsDisplay report={results} onAddPair={onAddPair} /> : null;
  };

  /* responsive spans */
  const configSpan = resultsExpanded ? { base: 12, lg: 4 } : { base: 12, lg: 5 };
  const resultsSpan = resultsExpanded ? { base: 12, lg: 8 } : { base: 12, lg: 7 };

  /* ──────────────────────────────────────────
     JSX
     ────────────────────────────────────────── */
  return (
    <>
      {/* header */}
      <Group justify="space-between" mb="md">
        <Title order={2}>Backtest Lab</Title>
        <Tooltip label="Show guide">
          <ActionIcon variant="subtle" onClick={() => setShowHelp((o) => !o)}>
            <IconInfoCircle size={20} />
          </ActionIcon>
        </Tooltip>
      </Group>

      {/* collapsible help */}
      <Collapse in={showHelp} mb="md">
        <Alert
          icon={<IconInfoCircle size="1rem" />}
          variant="outline"
          color="blue"
          title="How to Use the Backtest Lab"
        >
          <List size="sm" spacing="xs">
            <List.Item>
              <b>Set Environment:</b> Define the exchange, timeframe, date range, and initial capital for your test.
            </List.Item>
            <List.Item>
              <b>Select Symbols:</b> Provide a manual list of symbols or use a saved Market Screener configuration to source them automatically.
            </List.Item>
            <List.Item>
              <b>Configure Strategies:</b> Add one or more strategies to test. You can bulk-add all compatible strategies and tweak their parameters individually.
            </List.Item>
            <List.Item>
              <b>Run & Analyze:</b> A multi-strategy, portfolio-level report will be generated. You can drill down into each individual test.
            </List.Item>
          </List>
        </Alert>
      </Collapse>

      <Grid gutter="xl">
        {/* CONFIG COLUMN */}
        <Grid.Col span={configSpan}>
          <Paper withBorder p="md" radius="md">
            <ScrollArea h="calc(90vh - 160px)">
              <form onSubmit={form.onSubmit(runBacktest)}>
                <Stack gap="sm">
                  {/* GENERAL */}
                  <Title order={4}>General settings</Title>
                  <TextInput
                    label="Run Name"
                    description="A unique name for this backtest run"
                    required
                    {...form.getInputProps('scenario_name')}
                  />
                  <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
                    <Select
                      label="Exchange"
                      data={availableExchanges}
                      searchable
                      disabled={exchangesLoading}
                      placeholder={exchangesLoading ? 'Loading...' : 'Select exchange'}
                      leftSection={<IconBuildingStore size={16} />}
                      {...form.getInputProps('exchange')}
                    />
                    <NumberInput
                      label="Initial capital"
                      prefix="$ "
                      min={100}
                      step={1000}
                      thousandSeparator
                      {...form.getInputProps('initial_capital')}
                    />
                    <Select
                      label="Timeframe"
                      data={availableTimeframes}
                      {...form.getInputProps('timeframe')}
                    />
                    <DatePickerInput
                      type="range"
                      label="Date range"
                      placeholder="Pick dates"
                      {...form.getInputProps('dateRange')}
                    />
                  </SimpleGrid>

                  {/* SYMBOLS */}
                  <Divider label="Symbol Selection" mt="sm" />
                  <Select
                    data={selectionMethods}
                    {...form.getInputProps('selection_method')}
                  />
                  {form.values.selection_method === 'EXPLICIT_LIST' && (
                    <TagsInput
                      label="Symbols"
                      description="Press Enter to add"
                      leftSection={<IconList size="1rem" />}
                      {...form.getInputProps('symbols')}
                    />
                  )}
                  {form.values.selection_method === 'FROM_CONFIG' && (
                    <Select
                      label="Screener config"
                      placeholder={configsLoading ? 'Loading…' : 'Choose config'}
                      data={screenerConfigs}
                      disabled={configsLoading}
                      leftSection={<IconZoomCode size="1rem" />}
                      searchable
                      {...form.getInputProps('screener_config_name')}
                    />
                  )}

                  {/* STRATEGIES */}
                  <Divider label="Strategies" mt="sm" />
                  <Group>
                    <Select
                      style={{ flex: 1 }}
                      data={availableStrategies
                        .filter(s => !(s.is_legacy && form.values.exchange !== 'binance'))
                        .map((s) => ({
                          value: s.value,
                          label: s.label,
                        }))
                      }
                      value={selectedStrategyToAdd}
                      onChange={setSelectedStrategyToAdd}
                      searchable
                      disabled={strategiesLoading}
                      renderOption={renderSelectOption}
                    />
                    <Tooltip label="Add selected">
                      <ActionIcon
                        variant="filled"
                        color="blue"
                        size="lg"
                        onClick={handleAddStrategy}
                        disabled={!selectedStrategyToAdd}
                      >
                        <IconPlus size="1.2rem" />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Add all compatible strategies">
                      <ActionIcon
                        variant="outline"
                        color="blue"
                        size="lg"
                        onClick={handleAddAllStrategies}
                        disabled={strategiesLoading}
                      >
                        <IconPlaystationCircle size="1.2rem" />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                  {form.errors.strategies && (
                    <Text c="red" size="xs">
                      {form.errors.strategies}
                    </Text>
                  )}

                  <Accordion variant="separated" mt="sm">
                    {strategyForms}
                  </Accordion>

                  {/* RUN */}
                  <Button
                    type="submit"
                    mt="md"
                    loading={jobStatus === 'running'}
                    disabled={form.values.strategies.length === 0}
                  >
                    Run Backtest
                  </Button>
                </Stack>
              </form>
            </ScrollArea>
          </Paper>
        </Grid.Col>

        {/* RESULTS COLUMN */}
        <Grid.Col span={resultsSpan}>
          <Card withBorder radius="md" p="md" h="calc(90vh - 120px)" style={{minHeight: '85vh'}}>
            <Title order={4} mb="xs">
              Latest Run Report
            </Title>
            <ScrollArea h="100%">{renderResults()}</ScrollArea>
          </Card>
        </Grid.Col>
      </Grid>
    </>
  );
}
```


## ./gunbot_quant/frontend/src/GunbotConnect.jsx
```
import { useState, useEffect, useMemo, memo, forwardRef, useRef } from 'react';
import {
  Alert, Button, Card, Center, Code, Collapse, Group, Loader, Paper, PasswordInput,
  Stack, Text, Title, useMantineTheme, ActionIcon, Grid, NumberInput, Select, TextInput, ScrollArea,
  SimpleGrid, UnstyledButton, Tooltip as MantineTooltip, ThemeIcon, Box, List, Badge, Table,
  Breadcrumbs, Anchor, MultiSelect, SegmentedControl, Portal, Overlay
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { DatePickerInput } from '@mantine/dates';
import {
  IconCheck, IconCircleX, IconInfoCircle, IconPlugConnected, IconPlugConnectedX,
  IconKey, IconServer, IconChevronDown, IconAlertTriangle, IconGraph, IconX,
  IconRefresh, IconTestPipe, IconZoomCode, IconHistory, IconRobot, IconChartAreaLine,
  IconTrash, IconActivity, IconPlayerPlay, IconPlayerPause, IconClockHour4, IconWallet
} from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { DataTable } from 'mantine-datatable';
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import dayjs from 'dayjs';

// --- Re-usable constants ---
const AVAILABLE_TIMEFRAMES_FOR_ANALYSIS = [
    { value: '5m', label: '5 Minutes' },
    { value: '15m', label: '15 Minutes' },
    { value: '30m', label: '30 Minutes' },
    { value: '1h', label: '1 Hour' },
    { value: '2h', label: '2 Hours' },
    { value: '4h', label: '4 Hours' },
    { value: '6h', label: '6 Hours' },
    { value: '12h', label: '12 Hours' },
    { value: '1d', label: '1 Day' },
];

// --- Re-usable Helpers ---
const formatCurrency = (val, precision = 2) => (typeof val === 'number' ? val.toLocaleString(undefined, { minimumFractionDigits: precision, maximumFractionDigits: precision }) : 'N/A');
const formatCoin = (val) => (typeof val === 'number' ? val.toFixed(6) : 'N/A');
const formatTimeframe = (min) => { const minutes = parseInt(min, 10); if (isNaN(minutes) || minutes <= 0) return '—'; if (minutes < 60) return `${minutes}m`; if (minutes < 1440) return `${(minutes / 60).toFixed(0)}h`; return `${(minutes / 1440).toFixed(0)}d`; };
const downsample = (data, maxPoints = 500) => { if (!Array.isArray(data) || data.length <= maxPoints) return data; const step = Math.ceil(data.length / maxPoints); const result = []; for (let i = 0; i < data.length; i += step) { result.push(data[i]); } return result; };

// --- API Fetchers & Mutations ---
const fetchGunbotStatus = async () => { const res = await fetch('/api/v1/gunbot/status'); if (!res.ok) throw new Error('Network response was not ok'); return res.json(); };
const fetchTradingPairs = async () => { const res = await fetch('/api/v1/gunbot/trading-pairs'); if (!res.ok) { const err = await res.json(); throw new Error(err.detail || 'Could not fetch trading pair data'); } return res.json(); };
const connectToGunbot = async ({ password, gunthy_wallet, protocol, host, port }) => { const res = await fetch('/api/v1/gunbot/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, gunthy_wallet, protocol, host, port }), }); const data = await res.json(); if (!res.ok) throw new Error(data.detail || 'Failed to connect'); return data; };
const disconnectFromGunbot = async () => { const res = await fetch('/api/v1/gunbot/disconnect', { method: 'POST' }); const data = await res.json(); if (!res.ok) throw new Error(data.detail || 'Failed to disconnect'); return data; };
const removePairFromGunbot = async ({ exchange, gunbot_pair }) => { const res = await fetch('/api/v1/gunbot/pairs/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exchange, gunbot_pair }), }); const data = await res.json(); if (!res.ok) throw new Error(data.detail || 'Failed to remove pair'); return data; };

// --- Small UI Components ---
const StatTile = memo(({ label, value, color, suffix = '', size = 'md', tooltip }) => { const content = ( <Paper withBorder p="xs" radius="md" style={{ background: 'transparent' }}> <Text size="xs" c="dimmed" truncate>{label}</Text> <Text size={size} c={color} fw={600}>{value}{suffix}</Text> </Paper> ); if (tooltip) return <MantineTooltip label={tooltip} withArrow withinPortal multiline w={240}>{content}</MantineTooltip>; return content; });
StatTile.displayName = 'StatTile';
const SparklineBase = ({ data, color, height = 20 }, ref) => { if (!data || data.length < 2) return <Box h={height} ref={ref} />; return ( <Box w={100} h={height} ref={ref}><ResponsiveContainer><LineChart data={data}><Line type="monotone" dataKey="value" stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} /></LineChart></ResponsiveContainer></Box> ); };
const Sparkline = memo(forwardRef(SparklineBase));
function FeatureCard({ icon: Icon, title, description, color='blue' }) {
    return (
        <Paper withBorder p="sm" radius="md" bg="dark.7">
            <Group>
                <ThemeIcon variant="light" color={color} size={36} radius="md">
                    <Icon size={20} />
                </ThemeIcon>
                <div>
                    <Text fw={500}>{title}</Text>
                    <Text size="sm" c="dimmed">{description}</Text>
                </div>
            </Group>
        </Paper>
    );
}

// --- Chart Helpers ---
const createEquityChartData = (pairData, initialCapital) => { if (!pairData?.orders?.length) return []; const history = [...pairData.orders].reverse(); const firstTrade = history.find(t => t.rate > 0); if (!firstTrade) return []; const firstTradePrice = firstTrade.rate; const bhCoins = initialCapital / firstTradePrice; let cash = initialCapital; let baseQty = 0; const chartData = [{ time: firstTrade.time - 3600000, strategy: initialCapital, buyAndHold: initialCapital }]; for (const trade of history) { if (trade.type === 'buy') { cash -= trade.cost; baseQty += trade.amount; } else if (trade.type === 'sell') { cash += trade.cost; baseQty -= trade.amount; } const currentStrategyEquity = cash + (baseQty * trade.rate); const bhEquity = bhCoins * trade.rate; chartData.push({ time: trade.time, strategy: currentStrategyEquity, buyAndHold: bhEquity }); } if (chartData.length > 1) { const lastStateEquity = cash + (baseQty * pairData.bid); chartData.push({ time: Date.now(), strategy: lastStateEquity, buyAndHold: bhCoins * pairData.bid }); } return downsample(chartData, 500); };
const CustomEquityTooltip = ({ active, payload, label }) => { if (active && payload && payload.length) { const strategyData = payload.find(p => p.dataKey === 'strategy'); const bhData = payload.find(p => p.dataKey === 'buyAndHold'); return ( <Paper withBorder shadow="md" radius="md" p="sm" style={{ backgroundColor: 'rgba(26, 27, 30, 0.85)' }}><Text size="sm" mb={4}>{dayjs(label).format('MMM D, YYYY')}</Text>{bhData && <Text size="xs" c="white">{`Buy & Hold : $${formatCurrency(bhData.value)}`}</Text>}{strategyData && <Text size="xs" c="green">{`Strategy : $${formatCurrency(strategyData.value)}`}</Text>}</Paper> ); } return null; };
const EquityChart = memo(({ data, theme }) => { if (!data || data.length < 2) { return ( <Center h={250}><Stack align="center" gap="xs"><IconAlertTriangle size={32} color={theme.colors.gray[6]} /><Text c="dimmed" size="sm">Not enough trade history to render chart.</Text></Stack></Center> ); } return ( <> <ResponsiveContainer width="100%" height={250}><AreaChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}><CartesianGrid strokeDasharray="3 3" stroke={theme.colors.dark[4]} /><XAxis dataKey="time" tickFormatter={(d) => dayjs(d).format('MMM DD')} tick={{ fill: theme.colors.gray[5], fontSize: 11 }} stroke={theme.colors.dark[4]} /><YAxis yAxisId="0" tickFormatter={(v) => `$${formatCurrency(v, 0)}`} domain={['dataMin', 'auto']} tick={{ fill: theme.colors.gray[3], fontSize: 11 }} stroke={theme.colors.dark[4]} allowDataOverflow={false} /><Tooltip content={<CustomEquityTooltip />} /><Area yAxisId="0" type="monotone" dataKey="buyAndHold" name="Buy & Hold" stroke={theme.colors.gray[5]} fill={theme.colors.gray[8]} fillOpacity={0.3} strokeWidth={1.5} isAnimationActive={false} connectNulls /><Area yAxisId="0" type="monotone" dataKey="strategy" name="Strategy" stroke={theme.colors.green[4]} fill={theme.colors.green[8]} fillOpacity={0.3} strokeWidth={2} isAnimationActive={false} connectNulls /></AreaChart></ResponsiveContainer><Group justify="center" gap="xl" mt="xs"><Group gap="xs" align="center"><Box w={12} h={2} bg={theme.colors.gray[5]} /><Text size="xs" c="dimmed">Buy & Hold</Text></Group><Group gap="xs" align="center"><Box w={12} h={2} bg={theme.colors.green[4]} /><Text size="xs" c="dimmed">Strategy</Text></Group></Group> </> ); });
EquityChart.displayName = 'EquityChart';

// --- Portal Modal Component ---
const MODAL_Z = 10000;
const PANEL_Z = MODAL_Z + 1;

function SafeModal({ opened, onClose, size = 'md', children }) {
  if (!opened) return null;
  const width =
    size === 'lg' ? 600 : size === 'md' ? 400 : size === 'sm' ? 320 : size;

  return (
    <Portal>
      <Overlay
        opacity={0.55}
        blur={2}
        fixed
        onClick={onClose}
        zIndex={MODAL_Z}
      />
      <Paper
        withBorder
        shadow="lg"
        radius="md"
        p="lg"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width,
          maxHeight: '80vh',
          overflowY: 'auto',
          overflowX: 'visible',
          zIndex: PANEL_Z,
          background: 'var(--mantine-color-body, #1A1B1E)',
        }}
      >
        {children}
      </Paper>
    </Portal>
  );
}


export default function GunbotConnect({ navigateToResult, navigateToDiscoveryResult }) {
  const theme = useMantineTheme();
  const queryClient = useQueryClient();

  const [password, setPassword] = useState('');
  const [gunthyWallet, setGunthyWallet] = useState('');
  const [protocol, setProtocol] = useState('http');
  const [host, setHost] = useState('localhost');
  const [port, setPort] = useState(3000);
  const [showConnectionSettings, setShowConnectionSettings] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [selectedPairKey, setSelectedPairKey] = useState(null);
  const [assumedCapital, setAssumedCapital] = useState(1000);
  const [job, setJob] = useState({ id: null, type: null, status: 'idle' });
  const pollingRef = useRef(null);
  const prevIsConnectedRef = useRef();
  const [confirmation, setConfirmation] = useState(null);
  const [timeframesToTest, setTimeframesToTest] = useState(['1h', '4h']);
  
  const [discoveryCandidateCount, setDiscoveryCandidateCount] = useState(200);
  const [discoveryMinDailyVolume, setDiscoveryMinDailyVolume] = useState(1_000_000);
  const [discoveryDateType, setDiscoveryDateType] = useState('active_pair_time');
  const [discoveryDateRange, setDiscoveryDateRange] = useState([dayjs().subtract(30, 'days').toDate(), new Date()]);
  const [discoveryTimeframe, setDiscoveryTimeframe] = useState('1h');

  const [benchmarkDateType, setBenchmarkDateType] = useState('active_pair_time');
  const [benchmarkDateRange, setBenchmarkDateRange] = useState([dayjs().subtract(30, 'days').toDate(), new Date()]);
  const [normalizationCache, setNormalizationCache] = useState({});
  const [isNormalizing, setIsNormalizing] = useState(false);

  const [pairToRemove, setPairToRemove] = useState(null);
  const [removeModalOpened, { open: openRemoveModal, close: closeRemoveModal }] = useDisclosure(false);

  const { data: statusData, isLoading: isStatusLoading, isError: isStatusError } = useQuery({ queryKey: ['gunbotStatus'], queryFn: fetchGunbotStatus, refetchInterval: 30000 });
  const isConnected = statusData?.connected === true;

  const { data: tradingPairs, isLoading: isDataLoading, error: dataError, isRefetching } = useQuery({
    queryKey: ['gunbotTradingPairs'],
    queryFn: fetchTradingPairs,
    enabled: isConnected,
    refetchInterval: 60000,
  });
  
  const removePairMutation = useMutation({
    mutationFn: removePairFromGunbot,
    onSuccess: (data, variables) => {
      notifications.show({ title: 'Success', message: data.message, color: 'green', icon: <IconCheck /> });
      queryClient.invalidateQueries({ queryKey: ['gunbotTradingPairs'] });
      closeRemoveModal();
      setPairToRemove(null);
      if (selectedPairKey === variables.gunbot_pair.split('-').reverse().join('')) {
          setSelectedPairKey(null);
      }
    },
    onError: (error) => {
      notifications.show({ title: 'Error Removing Pair', message: error.message, color: 'red' });
    },
  });

  const selectedPairData = useMemo(() => (
    tradingPairs && selectedPairKey ? tradingPairs[selectedPairKey] : null
  ), [tradingPairs, selectedPairKey]);
  
  useEffect(() => {
    if (!tradingPairs || Object.keys(tradingPairs).length === 0) {
      setNormalizationCache({});
      return;
    };

    const normalizeAllPairs = async () => {
      setIsNormalizing(true);
      const newCache = { ...normalizationCache }; // Keep old results in case of partial failure
      const pairsToNormalize = Object.values(tradingPairs).filter(p => !newCache[p.standard_pair_format]);

      if (pairsToNormalize.length === 0) {
        setIsNormalizing(false);
        return;
      }

      await Promise.all(pairsToNormalize.map(async (pair) => {
        try {
          const res = await fetch('/api/v1/gunbot/normalize-pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pair_data: pair }),
          });
          if (res.ok) {
            const data = await res.json();
            newCache[pair.standard_pair_format] = data;
          } else {
            newCache[pair.standard_pair_format] = { gq_exchange: 'Error', warning: 'Normalization failed' };
          }
        } catch (e) {
          console.error(`Failed to normalize ${pair.standard_pair_format}`, e);
          newCache[pair.standard_pair_format] = { gq_exchange: 'Error', warning: 'Network error during normalization' };
        }
      }));

      setNormalizationCache(newCache);
      setIsNormalizing(false);
    };

    normalizeAllPairs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradingPairs]);

  useEffect(() => {
    if (statusData?.config) {
      setProtocol(statusData.config.protocol || 'http');
      setHost(statusData.config.host || 'localhost');
      setPort(statusData.config.port || 3000);
    }
    const shouldShowSettings = !statusData?.connected;
    setShowConnectionSettings(shouldShowSettings);
  }, [statusData]);

  // --- NEW EFFECT TO HANDLE RECONNECTION ---
  useEffect(() => {
    const wasConnected = prevIsConnectedRef.current;
    if (wasConnected === false && isConnected === true) {
      notifications.show({
        title: 'Gunbot Reconnected',
        message: 'Connection restored. Data will be refreshed automatically.',
        color: 'green',
        icon: <IconCheck />,
      });
      queryClient.invalidateQueries({ queryKey: ['gunbotConfig'] });
    }
    prevIsConnectedRef.current = isConnected;
  }, [isConnected, queryClient]);

  useEffect(() => {
    if (selectedPairKey) {
      const savedCapital = localStorage.getItem(`gbq_initial_capital_${selectedPairKey}`);
      setAssumedCapital(savedCapital ? parseFloat(savedCapital) : 1000);
      try {
        const pairTf = tradingPairs[selectedPairKey]?.candleTimeFrame;
        const pairTfString = formatTimeframe(pairTf);
        const isValidTf = AVAILABLE_TIMEFRAMES_FOR_ANALYSIS.some(tf => tf.value === pairTfString);
        setDiscoveryTimeframe(isValidTf ? pairTfString : '1h');
      } catch (e) {
        setDiscoveryTimeframe('1h');
      }
    } else {
        setJob({ id: null, type: null, status: 'idle' });
        setConfirmation(null);
        stopPolling();
    }
  }, [selectedPairKey, tradingPairs]);

  const handleCapitalChange = (value) => {
    const numericValue = Number(value) || 1;
    setAssumedCapital(numericValue);
    if (selectedPairKey) {
      localStorage.setItem(`gbq_initial_capital_${selectedPairKey}`, numericValue);
    }
  };

  const stopPolling = () => { if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; } };
  useEffect(() => () => stopPolling(), []);

  const checkJobStatus = async (currentJobId) => { try { const resp = await fetch(`/api/v1/backtest/status/${currentJobId}`); const data = await resp.json(); if (!resp.ok) throw new Error(data.detail || 'Failed to fetch job status'); if (data.status === 'completed') { setJob(prev => ({...prev, status: 'completed' })); notifications.show({ title: 'Job Completed', message: `Report for ${currentJobId} is ready.`, color: 'green', icon: <IconCheck />, autoClose: 10000, }); stopPolling(); } else if (data.status === 'failed') { setJob(prev => ({...prev, status: 'failed' })); notifications.show({ title: 'Job Failed', message: data.report?.error || 'An unexpected error occurred.', color: 'red', }); stopPolling(); } } catch (err) { setJob(prev => ({...prev, status: 'failed' })); notifications.show({ title: 'Polling Error', message: err.message, color: 'red' }); stopPolling(); } };
  
  const startJob = (endpoint, payload, title, type) => {
    setJob({ id: null, type, status: 'running' });
    setConfirmation(null);
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(async res => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `Failed to start ${title}`);
      return data;
    }).then(data => {
      notifications.show({ title: `${title} Started`, message: `Job '${data.job_id}' is running.`, color: 'blue' });
      setJob({ id: data.job_id, type, status: 'running' });
      const checker = () => checkJobStatus(data.job_id);
      if (pollingRef.current) clearInterval(pollingRef.current);
      pollingRef.current = setInterval(checker, 5000);
      setTimeout(checker, 1000);
    }).catch(error => {
      notifications.show({ title: `${title} Failed to Start`, message: error.message, color: 'red' });
      setJob({ id: null, type, status: 'failed' });
    });
  };

  const connectMutation = useMutation({
    mutationFn: connectToGunbot,
    onSuccess: (data) => {
      notifications.show({ title: 'Success', message: data.message, color: 'green', icon: <IconCheck /> });
      queryClient.invalidateQueries({ queryKey: ['gunbotStatus'] });
      queryClient.invalidateQueries({ queryKey: ['gunbotConfig'] });
      setPassword('');
      setGunthyWallet('');
    },
    onError: (error) => {
      notifications.show({ title: 'Connection Failed', message: error.message, color: 'red' });
    },
  });
  const disconnectMutation = useMutation({ mutationFn: disconnectFromGunbot, onSuccess: (data) => { notifications.show({ title: 'Success', message: data.message, color: 'blue' }); queryClient.invalidateQueries({ queryKey: ['gunbotStatus'] }); queryClient.removeQueries({ queryKey: ['gunbotTradingPairs'] }); setSelectedPairKey(null); }, onError: (error) => { notifications.show({ title: 'Disconnection Failed', message: error.message, color: 'red' }); }, });
  
  const handleConnect = () => { if (password.trim() && gunthyWallet.trim() && host.trim() && port > 0) connectMutation.mutate({ password, gunthy_wallet: gunthyWallet, protocol, host, port }); };
  const handleRefresh = () => { queryClient.invalidateQueries({ queryKey: ['gunbotTradingPairs'] }); };
  const handleRemoveClick = (pair) => { setPairToRemove(pair); openRemoveModal(); };
  const handleConfirmRemove = () => { if (pairToRemove) { removePairMutation.mutate({ exchange: pairToRemove.exchange, gunbot_pair: pairToRemove.gunbot_pair_format }); } };


  const handleRunBenchmarkConfirm = () => {
    if (!selectedPairData) return;
    const jobName = `Benchmark-${selectedPairData.standard_pair_format}-${dayjs().format('YYYY-MM-DD_HH-mm')}`;
    const payload = {
      job_name: jobName,
      pair_data: selectedPairData,
      initial_capital: assumedCapital,
      timeframes_to_test: timeframesToTest,
      start_date: null,
      end_date: null,
    };
    if (benchmarkDateType === 'custom_range' && benchmarkDateRange[0] && benchmarkDateRange[1]) {
        payload.start_date = dayjs(benchmarkDateRange[0]).format('YYYY-MM-DD');
        payload.end_date = dayjs(benchmarkDateRange[1]).format('YYYY-MM-DD');
    }
    startJob('/api/v1/gunbot/benchmark', payload, 'Benchmark', 'benchmark');
  };

  const setDiscoveryDatePreset = (days) => {
    setDiscoveryDateType('custom_range');
    setDiscoveryDateRange([dayjs().subtract(days, 'days').toDate(), new Date()]);
  };
   const setBenchmarkDatePreset = (days) => {
    setBenchmarkDateType('custom_range');
    setBenchmarkDateRange([dayjs().subtract(days, 'days').toDate(), new Date()]);
  };


  const handleFindBetterPairConfirm = () => {
    if (!selectedPairData) return;
    const jobName = `Discovery-${selectedPairData.standard_pair_format}-${dayjs().format('YYYY-MM-DD_HH-mm')}`;
    
    const payload = {
      job_name: jobName,
      pair_data: selectedPairData,
      initial_capital: assumedCapital,
      candidate_count: discoveryCandidateCount,
      min_daily_volume: discoveryMinDailyVolume,
      timeframe: discoveryTimeframe,
      start_date: null,
      end_date: null,
    };

    if (discoveryDateType === 'custom_range' && discoveryDateRange[0] && discoveryDateRange[1]) {
        payload.start_date = dayjs(discoveryDateRange[0]).format('YYYY-MM-DD');
        payload.end_date = dayjs(discoveryDateRange[1]).format('YYYY-MM-DD');
    }

    startJob('/api/v1/gunbot/find-better-pair', payload, 'Pair Discovery', 'discovery');
  };

  const handleViewReport = () => {
      if (job.type === 'discovery') {
          navigateToDiscoveryResult(job.id);
      } else {
          navigateToResult(job.id);
      }
  };

  const tableRecords = useMemo(() => { if (!tradingPairs) return []; const totalAbsPnl = Object.values(tradingPairs).reduce((total, d) => total + Math.abs(d.orders.reduce((sum, o) => sum + (o.pnl || 0), 0)), 0); return Object.values(tradingPairs).map(d => { const onSellOrdersValue = d.openOrders.filter(o => o.type === 'sell').reduce((s, o) => s + (o.amount * o.rate), 0); const avgCostCoinValue = d.quoteBalance * d.unitCost; const currentTotalValue = (d.quoteBalance * d.bid) + onSellOrdersValue; const avgCostTotalValue = avgCostCoinValue + onSellOrdersValue; const dd = avgCostTotalValue > 0 ? ((currentTotalValue - avgCostTotalValue) / avgCostTotalValue) * 100 : 0; const realizedPnl = d.orders.reduce((sum, o) => sum + (o.pnl || 0), 0); const pnlHistory = []; let cumulativePnl = 0; const ddHistory = []; const reversedOrders = [...d.orders].reverse(); if (reversedOrders.length > 0) { pnlHistory.push({ value: 0 }); ddHistory.push({ value: 0 }); } for (const trade of reversedOrders) { if (trade.type === 'sell' && typeof trade.pnl === 'number') pnlHistory.push({ value: cumulativePnl += trade.pnl }); if (trade.abp > 0) ddHistory.push({ value: ((trade.rate - trade.abp) / trade.abp) * 100 }); } const pairVolume24h = d.orders.filter(o => o.time >= Date.now() - 86400000).reduce((s, o) => s + o.cost, 0); const pnlShare = totalAbsPnl > 0 ? (Math.abs(realizedPnl) / totalAbsPnl) * 100 : 0; return { ...d, id: d.standard_pair_format, bagSize: avgCostCoinValue, realizedPnl, drawdown: dd, pnlHistory: downsample(pnlHistory, 50), ddHistory: downsample(ddHistory, 50), tradedVolume24h: pairVolume24h, pnlShare, candleTimeFrame: d.candleTimeFrame, }; }); }, [tradingPairs]);
  const equityChartData = useMemo(() => { return selectedPairData ? createEquityChartData(selectedPairData, assumedCapital) : []; }, [selectedPairData, assumedCapital]);
  const detailData = useMemo(() => { if (!selectedPairData) return { balances: {}, totalReturn: 0 }; const { quoteBalance, baseBalance, openOrders, gunbot_pair_format } = selectedPairData; const onBuyOrdersValue = openOrders.filter(o => o.type === 'buy').reduce((s, o) => s + o.cost, 0); const onSellOrdersValue = openOrders.filter(o => o.type === 'sell').reduce((s, o) => s + (o.amount * o.rate), 0); const pairRecord = tableRecords.find(r => r.id === selectedPairKey); const finalEquity = equityChartData.length > 0 ? equityChartData[equityChartData.length - 1].strategy : assumedCapital; const totalReturn = assumedCapital > 0 ? ((finalEquity / assumedCapital) - 1) * 100 : 0; return { balances: { denominatedAsset: gunbot_pair_format.split('-')[0], coinBalance: formatCoin(quoteBalance), bagValue: `$${formatCurrency(pairRecord?.bagSize)}`, denominatedBalance: `$${formatCurrency(baseBalance)}`, onBuyOrdersValue: `$${formatCurrency(onBuyOrdersValue)}`, onSellOrdersValue: `$${formatCurrency(onSellOrdersValue)}`, drawdown: pairRecord?.drawdown || 0, }, totalReturn }; }, [selectedPairData, tableRecords, equityChartData, assumedCapital, selectedPairKey]);

  if (isStatusLoading && !statusData) return <Center h="80vh"><Loader /></Center>;

  const renderRunActions = () => {
    if (confirmation === 'discovery') {
      return (
        <Paper withBorder p="md" radius="md">
            <Stack gap="md">
                <Title order={5}>Configure Pair Discovery</Title>
                <Text size="sm" c="dimmed">This job scans for high-quality alternative pairs by running a universal benchmark. This process can take 10-20 minutes.</Text>
                
                <Select
                  label="Analysis Timeframe"
                  data={AVAILABLE_TIMEFRAMES_FOR_ANALYSIS}
                  value={discoveryTimeframe}
                  onChange={setDiscoveryTimeframe}
                />
                
                <SegmentedControl
                  fullWidth
                  value={discoveryDateType}
                  onChange={setDiscoveryDateType}
                  data={[
                    { label: 'Active Pair Time', value: 'active_pair_time' },
                    { label: 'Custom Range', value: 'custom_range' },
                  ]}
                />
                {discoveryDateType === 'custom_range' && (
                    <Stack gap="xs">
                        <DatePickerInput type="range" label="Select Date Range" value={discoveryDateRange} onChange={setDiscoveryDateRange} />
                        <Group gap="xs">
                            <Button size="xs" variant="light" onClick={() => setDiscoveryDatePreset(7)}>Last 7d</Button>
                            <Button size="xs" variant="light" onClick={() => setDiscoveryDatePreset(30)}>Last 30d</Button>
                            <Button size="xs" variant="light" onClick={() => setDiscoveryDatePreset(90)}>Last 90d</Button>
                        </Group>
                    </Stack>
                )}
                <NumberInput
                  label="Number of Pairs to Scan"
                  description={`Top N by volume on the ${detailData.balances.denominatedAsset} market`}
                  value={discoveryCandidateCount}
                  onChange={setDiscoveryCandidateCount}
                  min={10} max={500} step={10} allowDecimal={false} thousandSeparator
                />
                <NumberInput
                  label="Minimum Daily Volume"
                  description="Filter out pairs below this average daily volume"
                  value={discoveryMinDailyVolume}
                  onChange={setDiscoveryMinDailyVolume}
                  min={1000} step={100000} thousandSeparator prefix="$"
                />
              <Group justify="flex-end" mt="md">
                <Button variant="default" onClick={() => setConfirmation(null)}>Cancel</Button>
                <Button onClick={handleFindBetterPairConfirm} disabled={!discoveryCandidateCount || !discoveryMinDailyVolume}>Confirm & Start</Button>
              </Group>
            </Stack>
        </Paper>
      );
    }

    if (confirmation === 'benchmark') {
       return (
        <Paper withBorder p="md" radius="md">
            <Stack gap="md">
                <Title order={5}>Configure Benchmark</Title>
                <Text size="sm" c="dimmed">Benchmark <strong>{selectedPairData?.standard_pair_format}</strong> against all library strategies to see how it could perform.</Text>
                <MultiSelect
                  data={AVAILABLE_TIMEFRAMES_FOR_ANALYSIS}
                  value={timeframesToTest}
                  onChange={setTimeframesToTest}
                  label="Timeframes to Test"
                  placeholder="Select at least one"
                />
                <SegmentedControl
                  fullWidth
                  value={benchmarkDateType}
                  onChange={setBenchmarkDateType}
                  data={[
                    { label: 'Active Pair Time', value: 'active_pair_time' },
                    { label: 'Custom Range', value: 'custom_range' },
                  ]}
                />
                {benchmarkDateType === 'custom_range' && (
                    <Stack gap="xs">
                        <DatePickerInput type="range" label="Select Date Range" value={benchmarkDateRange} onChange={setBenchmarkDateRange} />
                        <Group gap="xs">
                            <Button size="xs" variant="light" onClick={() => setBenchmarkDatePreset(7)}>Last 7d</Button>
                            <Button size="xs" variant="light" onClick={() => setBenchmarkDatePreset(30)}>Last 30d</Button>
                            <Button size="xs" variant="light" onClick={() => setBenchmarkDatePreset(90)}>Last 90d</Button>
                        </Group>
                    </Stack>
                )}
              <Group justify="flex-end" mt="md">
                <Button variant="default" onClick={() => setConfirmation(null)}>Cancel</Button>
                <Button onClick={handleRunBenchmarkConfirm} disabled={timeframesToTest.length === 0}>Confirm & Start</Button>
              </Group>
            </Stack>
        </Paper>
      );
    }
    
    return (
      <>
        {job.status === 'completed' && job.id && (
          <Button size="xs" variant="gradient" gradient={{from: 'teal', to: 'lime'}} leftSection={<IconHistory size={14} />} onClick={handleViewReport} mb="sm" fullWidth>
              View Last Report
          </Button>
        )}
        <Group grow>
            <MantineTooltip label="Run a backtest on this pair's symbol against all available strategies." withArrow multiline w={280}>
                <Button
                    size="xs" variant="filled"
                    onClick={() => setConfirmation('benchmark')}
                    loading={job.status === 'running' && job.type === 'benchmark'}
                    disabled={job.status === 'running' || !selectedPairData?.orders?.length}
                    leftSection={<IconTestPipe size={14} />}
                >
                    Run Benchmark
                </Button>
            </MantineTooltip>
            <MantineTooltip label="Search the exchange for alternative, potentially more profitable pairs." withArrow multiline w={280}>
                <Button 
                    size="xs" variant="default" 
                    onClick={() => setConfirmation('discovery')}
                    loading={job.status === 'running' && job.type === 'discovery'}
                    disabled={job.status === 'running' || !selectedPairData?.orders?.length}
                    leftSection={<IconZoomCode size={14} />}
                >
                  Find Better Pair
                </Button>
            </MantineTooltip>
        </Group>
      </>
    );
  };
  
  const ConnectionStatus = () => {
    let icon, color, text;
    if (isStatusError || statusData?.status === 'error') {
        icon = <IconCircleX />; color = 'red'; text = statusData?.message || 'Connection error';
    } else if (isStatusLoading && !statusData) {
        icon = <Loader size="xs" />; color = 'gray'; text = 'Connecting...';
    } else if (!isConnected) {
        icon = <IconPlugConnectedX />; color = 'orange'; text = 'Not Connected';
    } else {
        switch (statusData.status) {
            case 'active': icon = <IconPlayerPlay />; color = 'green'; break;
            case 'idle': icon = <IconPlayerPause />; color = 'yellow'; break;
            case 'starting': icon = <IconClockHour4 />; color = 'cyan'; break;
            default: icon = <IconPlugConnected />; color = 'blue';
        }
        text = statusData.message;
    }
    return (
        <Group>
            <MantineTooltip label={text} withArrow>
                <div>
                    <ThemeIcon color={color} size={24} radius="xl">{icon}</ThemeIcon>
                </div>
            </MantineTooltip>
            <div>
                <Text fw={500} tt="capitalize">{statusData?.status || 'Disconnected'}</Text>
                <Text size="xs" c="dimmed">{text}</Text>
            </div>
        </Group>
    );
  };

  return (
    <Stack gap="lg">
      <SafeModal opened={removeModalOpened} onClose={closeRemoveModal} size="md">
        <Group justify="space-between" mb="md">
          <Title order={4}>Confirm Removal</Title>
          <ActionIcon variant="subtle" onClick={closeRemoveModal}>
            <IconX size={18} />
          </ActionIcon>
        </Group>
        <Stack>
            <Text>Are you sure you want to remove the pair <Code>{pairToRemove?.gunbot_pair_format}</Code> from the <Code>{pairToRemove?.exchange}</Code> exchange in Gunbot?</Text>
            <Text c="dimmed" size="sm">This will disable the pair in your Gunbot configuration but will not sell any assets.</Text>
            <Group justify="flex-end" mt="xl">
                <Button variant="default" onClick={closeRemoveModal}>Cancel</Button>
                <Button color="red" onClick={handleConfirmRemove} loading={removePairMutation.isPending}>Remove Pair</Button>
            </Group>
        </Stack>
      </SafeModal>

      <Group justify="space-between"><div><Title order={2}>Gunbot Tools</Title><Text c="dimmed" size="sm">Connect your bot, analyze live performance, and find new opportunities. </Text></div><MantineTooltip label="Show help and usage instructions" withArrow><ActionIcon variant="subtle" onClick={() => setShowHelp(o => !o)}><IconInfoCircle size={20} /></ActionIcon></MantineTooltip></Group>
      <Collapse in={showHelp} transitionDuration={200}><Alert icon={<IconInfoCircle size="1rem" />} title="Quick Guide" color="blue" variant="light" withCloseButton onClose={() => setShowHelp(false)}><List size="sm" spacing="xs"><List.Item>📈 The <strong>Active Pairs Overview</strong> table updates every minute. Click any row to open its detailed analytics.</List.Item><List.Item>💰 The <strong>Performance Chart</strong> shows an equity curve. Set an "Assumed Initial Capital" to see how your pair has performed.</List.Item><List.Item>🚀 <strong>Run Benchmark</strong> backtests the current pair's symbol against a library of trading strategies. <strong>Find Better Pair</strong> searches for more profitable pairs on the same market.</List.Item><List.Item>🟢 <strong>Get Started:</strong> Connect to your <a href="https://www.gunbot.com" target="_blank" rel="noopener" style={{color: theme.colors.blue[4]}}>Gunbot</a> instance using your GUI password and `gunthy_wallet` key to begin streaming data.</List.Item></List></Alert></Collapse>
      
      {!isConnected && (
            <Paper withBorder p="xl" radius="md" bg="dark.6">
                <Grid gutter="xl" align="center">
                    <Grid.Col span={{ base: 12, lg: 5 }}>
                        <Stack align="center" ta="center">
                            <ThemeIcon variant="light" color="blue" size={60} radius="xl">
                                <IconRobot size={36} />
                            </ThemeIcon>
                            <Title order={3}>Unlock Gunbot Analysis Tools</Title>
                            <Text c="dimmed" maw={450}>
                                Connect your <a href="https://www.gunbot.com" target="_blank" rel="noopener" style={{color: theme.colors.blue[4]}}>Gunbot</a> instance to stream live trading data, access powerful analysis tools, and discover new opportunities for your trading bot. Requires a Gunbot Defi license.
                            </Text>
                        </Stack>
                    </Grid.Col>
                    <Grid.Col span={{ base: 12, lg: 7 }}>
                        <Stack>
                            <FeatureCard icon={IconChartAreaLine} title="Analyze Live Performance" description="Visualize the equity curve of your active trading pairs and compare them against a simple Buy & Hold strategy." />
                            <FeatureCard icon={IconTestPipe} color="teal" title="Run Benchmarks" description="How good is your current strategy? Backtest your live pair's symbol against a library of common strategies over the same period." />
                            <FeatureCard icon={IconZoomCode} color="yellow" title="Discover Better Pairs" description="Automatically scan the market for other pairs that might perform better." />
                        </Stack>
                    </Grid.Col>
                </Grid>
            </Paper>
      )}

      <Paper withBorder p="md" radius="md"><Group justify="space-between"><ConnectionStatus /><Button variant="default" size="xs" onClick={() => setShowConnectionSettings(o => !o)}>{showConnectionSettings ? 'Hide Settings' : 'Connection Settings'}</Button></Group>
      <Collapse in={showConnectionSettings || !isConnected } transitionDuration={200}><Stack mt="md"><Grid><Grid.Col span={{ base: 12, sm: 4 }}><MantineTooltip label="Choose the protocol used by your Gunbot web API (usually http unless you configured SSL)" withArrow multiline w={220}><Select label="Protocol" data={['http', 'https']} value={protocol} onChange={setProtocol} disabled={isConnected || connectMutation.isPending} /></MantineTooltip></Grid.Col><Grid.Col span={{ base: 12, sm: 5 }}><MantineTooltip label="Hostname or IP Address" withArrow><TextInput label="Host / IP Address" placeholder="localhost" value={host} onChange={(e) => setHost(e.currentTarget.value)} disabled={isConnected || connectMutation.isPending} /></MantineTooltip></Grid.Col><Grid.Col span={{ base: 12, sm: 3 }}><MantineTooltip label="TCP port configured for the Gunbot web server" withArrow><NumberInput label="Port" placeholder="3000" value={port} onChange={setPort} min={1} max={65535} allowDecimal={false} disabled={isConnected || connectMutation.isPending} /></MantineTooltip></Grid.Col></Grid>
      <TextInput label="Gunthy Wallet Key" description="Found in your Gunbot config.js file (config.bot.gunthy_wallet)" placeholder="Paste key here" leftSection={<IconWallet size={16} />} value={gunthyWallet} onChange={(e) => setGunthyWallet(e.currentTarget.value)} disabled={isConnected || connectMutation.isPending} />
      <PasswordInput label="Gunbot GUI Password" description="The same password you use to log in to the Gunbot GUI." placeholder="Enter password" leftSection={<IconKey size={16} />} value={password} onChange={(e) => setPassword(e.currentTarget.value)} disabled={isConnected || connectMutation.isPending} />
      <Group justify="flex-end">{isConnected && ( <Button color="red" variant="light" onClick={() => disconnectMutation.mutate()} loading={disconnectMutation.isPending} leftSection={<IconPlugConnectedX size={18} />}>Disconnect</Button> )}<Button onClick={handleConnect} loading={connectMutation.isPending} disabled={isConnected || !password.trim() || !gunthyWallet.trim() || !host.trim() || !port} leftSection={<IconServer size={18} />}>Save & Connect</Button></Group></Stack></Collapse></Paper>

      {isConnected && (
        <>
          {selectedPairData && (
            <Paper withBorder p="md" radius="md">
              <Stack gap="md">
                 <Group justify="space-between"><Breadcrumbs><Anchor component="button" type="button" onClick={() => setSelectedPairKey(null)} size="sm">Gunbot Tools</Anchor><Text size="sm" fw={500}>{selectedPairData.standard_pair_format}</Text></Breadcrumbs><MantineTooltip label="Close detail panel" withArrow><ActionIcon variant='subtle' onClick={() => setSelectedPairKey(null)}><IconX size={20} /></ActionIcon></MantineTooltip></Group>
                <Grid gutter="lg">
                  <Grid.Col span={{ base: 12, md: 7 }}><Stack gap="sm"><Group gap="xs"><Title order={4}>Performance Chart</Title><MantineTooltip withArrow label="Equity curve showing performance vs. Buy & Hold, based on the assumed initial capital." multiline w={260}><ThemeIcon variant="subtle" color="gray" radius="xl" size="xs"><IconInfoCircle /></ThemeIcon></MantineTooltip></Group><EquityChart data={equityChartData} theme={theme} /></Stack></Grid.Col>
                  <Grid.Col span={{ base: 12, md: 5 }}>
                    <Stack gap="md">
                      <div><Title order={5} mb="sm">Live Balances & State</Title><SimpleGrid cols={2} spacing="sm"><StatTile label="Coin Balance" value={detailData.balances.coinBalance} color={theme.colors.gray[4]} tooltip="Amount of the quote coin (e.g., ETH) currently in your wallet" /><StatTile label="Bag Value" value={detailData.balances.bagValue} color={theme.colors.gray[4]} tooltip="Value of the coin balance at its average acquisition price (unit cost)" /><StatTile label={`${detailData.balances.denominatedAsset} Balance`} value={detailData.balances.denominatedBalance} color={theme.colors.gray[4]} tooltip={`Amount of ${detailData.balances.denominatedAsset} currently available in account`} /><StatTile label="Unrealised PnL / DD" value={detailData.balances.drawdown.toFixed(2)} suffix="%" color={detailData.balances.drawdown >= 0 ? 'teal' : 'red'} tooltip="Current profit or loss of held coins compared to their average cost" /><StatTile label="On Buy Orders" value={detailData.balances.onBuyOrdersValue} color={theme.colors.cyan[5]} tooltip="Capital reserved in open buy orders" /><StatTile label="On Sell Orders" value={detailData.balances.onSellOrdersValue} color={theme.colors.pink[5]} tooltip="Coin value locked in open sell orders" /><StatTile label="Strategy Return" value={detailData.totalReturn.toFixed(2)} suffix="%" color={detailData.totalReturn >= 0 ? 'green' : 'red'} tooltip="Total return based on assumed capital" /><StatTile label="Candle TF" value={formatTimeframe(selectedPairData.candleTimeFrame)} color={theme.colors.gray[4]} tooltip="Timeframe used for strategy candles (e.g. 15m, 1h, 1d)" /></SimpleGrid></div>
                      <div><UnstyledButton onClick={() => setShowConfig(o => !o)} w="100%"><Group justify="space-between"><Title order={5}>Strategy Configuration</Title><IconChevronDown size={16} style={{ transform: showConfig ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }} /></Group></UnstyledButton><Collapse in={showConfig} transitionDuration={150}><Paper withBorder p="sm" mt="xs" radius="sm"><ScrollArea h={120} type="auto"><Table withRowBorders={false} verticalSpacing="xs" fz="xs"><Table.Tbody>{selectedPairData.config?.override && Object.entries(selectedPairData.config.override).map(([key, value]) => ( <Table.Tr key={key}><Table.Td c="dimmed" p={0}>{key}</Table.Td><Table.Td p={0}><Text fw={500} ta="right">{String(value)}</Text></Table.Td></Table.Tr> ))}</Table.Tbody></Table></ScrollArea></Paper></Collapse></div>
                      <NumberInput label="Assumed Initial Capital" description="For equity curve calculation" value={assumedCapital} onChange={handleCapitalChange} min={1} step={100} thousandSeparator />
                      <Stack gap="sm">
                          <Title order={5}>Run Actions</Title>
                          {renderRunActions()}
                      </Stack>
                    </Stack>
                  </Grid.Col>
                </Grid>
              </Stack>
            </Paper>
          )}

          <Paper withBorder radius="md" p="md">
              <Group justify="space-between" mb="md">
                <div><Title order={4}>Active Pairs Overview</Title><Text size="sm" c="dimmed">Click a row to view details and run benchmarks.</Text></div>
                <MantineTooltip label="Force an immediate data refresh from Gunbot" withArrow><Button onClick={handleRefresh} size="xs" variant="default" leftSection={<IconRefresh size={14} />} loading={isRefetching}>Refresh</Button></MantineTooltip>
              </Group>
              {(isDataLoading && !isRefetching) && <Center p="xl"><Loader /></Center>}
              {dataError && <Alert color="red" title="Error Loading Data" icon={<IconCircleX />}>{dataError.message}</Alert>}
              {tradingPairs && ( 
                <DataTable
                  minHeight={tableRecords.length > 0 ? 300 : 150}
                  withTableBorder borderRadius="sm" striped highlightOnHover
                  verticalBreakpoint="sm"
                  records={tableRecords} idAccessor="id"
                  onRowClick={({ record }) => setSelectedPairKey(record.id === selectedPairKey ? null : record.id)}
                  rowClassName={({ id }) => id === selectedPairKey ? 'mantine-datatable-row-highlight' : ''}
                  columns={[
                     { accessor: 'standard_pair_format', title: <Text fw={600}>Pair</Text>, width: 100, render: ({ standard_pair_format: p, exchange: e }) => ( <Stack gap={0}><Text size="sm" fw={500}>{p}</Text><Text size="xs" c="dimmed">{e}</Text></Stack> ), },
                     { accessor: 'gq_exchange', title: <Text fw={600}>Benchmark On</Text>, width: 150, render: ({ standard_pair_format }) => { const normData = normalizationCache[standard_pair_format]; if ((isNormalizing && !normData) || (isDataLoading && !normData)) return <Loader size="xs" />; if (!normData) return <Text size="xs" c="dimmed">—</Text>; return ( <MantineTooltip label={normData.warning} disabled={!normData.warning} withArrow multiline w={250} position="top-start"><span><Text size="sm" tt="capitalize">{normData.gq_exchange}</Text></span></MantineTooltip> ); }, },
                     { accessor: 'config.strategy', title: <Text fw={600}>Strategy</Text>, width: 130 },
                     { accessor: 'history', title: <Text fw={600}>History</Text>, render: ({ pnlHistory, ddHistory }) => ( <Stack gap={0}><MantineTooltip label="Realised PnL trend" withArrow><span><Sparkline data={pnlHistory} color={theme.colors.teal[4]} /></span></MantineTooltip><MantineTooltip label="Drawdown at trade time" withArrow><span><Sparkline data={ddHistory} color={theme.colors.yellow[6]} /></span></MantineTooltip></Stack> ), },
                     { accessor: 'bagSize', title: <Text fw={600}>Bag Size</Text>, textAlignment: 'right', render: ({ bagSize }) => `$${formatCurrency(bagSize)}`, },
                     { accessor: 'drawdown', title: <Text fw={600}>DD %</Text>, textAlignment: 'right', render: ({ drawdown: dd }) => <Text size="sm" c={dd >= 0 ? 'teal' : 'red'}>{dd.toFixed(2)}%</Text>, },
                     { accessor: 'realizedPnl', title: <Text fw={600}>Realized PnL</Text>, textAlignment: 'right', render: ({ realizedPnl }) => <Text size="sm" fw={500} c={realizedPnl > 0 ? 'teal' : realizedPnl < 0 ? 'red' : 'dimmed'}>${formatCurrency(realizedPnl)}</Text> },
                     { accessor: 'openOrders.length', title: <Text fw={600}>Open</Text>, textAlignment: 'center' },
                     { accessor: 'candleTimeFrame', title: <Text fw={600}>TF</Text>, textAlignment: 'center', width: 80, render: ({ candleTimeFrame }) => ( <Text size="sm" c="dimmed">{formatTimeframe(candleTimeFrame)}</Text> ) },
                     { accessor: 'actions', title: <Text fw={600}>Actions</Text>, textAlignment: 'right', width: 100,
                       render: (pair) => (
                         <Group gap="xs" justify="flex-end" wrap="nowrap">
                           <MantineTooltip label="Remove Pair from Gunbot">
                             <ActionIcon color="red" variant="subtle" onClick={(e) => { e.stopPropagation(); handleRemoveClick(pair); }}>
                               <IconTrash size={16} />
                             </ActionIcon>
                           </MantineTooltip>
                         </Group>
                       ),
                     },
                  ]}
                  noRecordsText="No actively trading pairs found in Gunbot."
                /> 
              )}
          </Paper>
        </>
      )}
    </Stack>
  );
} 
```


## ./gunbot_quant/frontend/src/ResultsDisplay.jsx
```
/* eslint react/prop-types: 0 */
import { memo, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Center,
  Collapse,
  Code,
  Divider,
  Grid,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Title,
  Tooltip as MantineTooltip,
  UnstyledButton,
  useMantineTheme,
} from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import dayjs from 'dayjs';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import {
  IconAlertTriangle,
  IconChevronDown,
  IconChartPie3,
  IconBox,
  IconPlus,
  IconInfoCircle,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';

/* ---------------------------------------------------------------------------
   Color mapping for Exit Reasons Pie Chart
--------------------------------------------------------------------------- */
const REASON_COLORS = {
  'Stop Loss': '#fa5252',
  'Take Profit': '#40c057',
  'Signal Cross': '#228be6',
  'Death Cross (EMA)': '#be4bdb',
  'MACD Cross Down': '#be4bdb',
  'Supertrend flip': '#fd7e14',
  'HA candle flipped red': '#fd7e14',
  'Crossed middle band': '#845ef7',
  'Price fell to middle BB': '#845ef7',
  'RSI Overbought': '#15aabf',
  'RSI exit level': '#15aabf',
  'Stoch Overbought': '#15aabf',
  'Gunbot Trade': '#3498db'
};
const PIE_COLORS = [
  '#3498db',
  '#e74c3c',
  '#9b59b6',
  '#f1c40f',
  '#2ecc71',
  '#1abc9c',
  '#e67e22',
];

/* ---------------------------------------------------------------------------
   Stat Tile
--------------------------------------------------------------------------- */
const StatTile = memo(({ label, value, color, suffix = '', size = 'lg' }) => (
  <Paper
    withBorder
    p="xs"
    radius="md"
    style={{ background: 'transparent', borderColor: '#2a2a2a' }}
  >
    <Text size="xs" c="dimmed">
      {label}
    </Text>
    <Text size={size} c={color} fw={600}>
      {typeof value === 'number' && !Number.isNaN(value)
        ? value.toFixed(2)
        : '--'}
      {suffix}
    </Text>
  </Paper>
));
StatTile.displayName = 'StatTile';

/* ---------------------------------------------------------------------------
   Equity Chart
--------------------------------------------------------------------------- */
const EquityChart = memo(({ data, theme }) => {
  const { strategy, buy_and_hold } = data || {};

  if ((!strategy || strategy.length < 2) && (!buy_and_hold || buy_and_hold.length < 2)) {
    return (
      <Center h={350}>
        <Stack align="center" gap="xs">
          <IconAlertTriangle size={32} color={theme.colors.gray[6]} />
          <Text c="dimmed">Not enough data to render chart.</Text>
        </Stack>
      </Center>
    );
  }

  const combinedData = useMemo(() => {
    if (!strategy && !buy_and_hold) return [];

    const strategyDates = strategy?.map(d => d.date) || [];
    const bhDates = buy_and_hold?.map(d => d.date) || [];
    const allDates = [...new Set([...strategyDates, ...bhDates])].sort();

    const strategyMap = new Map(strategy?.map((d) => [d.date, d.value]) || []);
    const bhMap = new Map(buy_and_hold?.map((d) => [d.date, d.value]) || []);

    return allDates.map(date => ({
      date: date,
      equity_strategy: strategyMap.get(date),
      equity_buy_and_hold: bhMap.get(date),
    }));
  }, [strategy, buy_and_hold]);


  return (
    <ResponsiveContainer width="100%" height={350}>
      <AreaChart
        data={combinedData}
        margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
      >
        <defs>
          <linearGradient id="colorStrategy" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={theme.colors.green[5]} stopOpacity={0.8} />
            <stop offset="95%" stopColor={theme.colors.green[5]} stopOpacity={0.1} />
          </linearGradient>
          <linearGradient id="colorBH" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={theme.colors.gray[6]} stopOpacity={0.4} />
            <stop offset="95%" stopColor={theme.colors.gray[6]} stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={theme.colors.dark[3]} />
        <XAxis
          dataKey="date"
          tickFormatter={(d) => dayjs(d).format('MMM D')}
          tick={{ fill: theme.colors.gray[5], fontSize: 12 }}
          stroke={theme.colors.dark[3]}
        />
        <YAxis
          tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
          domain={['dataMin', 'auto']}
          allowDataOverflow={false}
          tick={{ fill: theme.colors.gray[5], fontSize: 12 }}
          stroke={theme.colors.dark[3]}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: theme.colors.dark[6],
            borderColor: theme.colors.dark[3],
            borderRadius: theme.radius.md,
          }}
          labelFormatter={(l) => dayjs(l).format('dddd, MMMM D, YYYY')}
          formatter={(value, name) => [
            `$${value?.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }) ?? 'N/A'}`,
            name === 'equity_strategy' ? 'Strategy' : 'Buy & Hold',
          ]}
        />
        
        <Area
          type="monotone"
          dataKey="equity_buy_and_hold"
          stroke={theme.colors.gray[5]}
          strokeWidth={1.5}
          fillOpacity={1}
          fill="url(#colorBH)"
          isAnimationActive={false}
          connectNulls
        />

        <Area
          type="monotone"
          dataKey="equity_strategy"
          stroke={theme.colors.green[4]}
          strokeWidth={2}
          fillOpacity={1}
          fill="url(#colorStrategy)"
          isAnimationActive={false}
          connectNulls
        />
      </AreaChart>
    </ResponsiveContainer>
  );
});
EquityChart.displayName = 'EquityChart';

const fetchGunbotStatus = async () => {
    const res = await fetch('/api/v1/gunbot/status');
    if (!res.ok) throw new Error('Network response was not ok');
    return res.json();
};

/* ---------------------------------------------------------------------------
   Main Component
--------------------------------------------------------------------------- */
export default function ResultsDisplay({ report, onAddPair }) {
  const theme = useMantineTheme();
  const [selectedTestId, setSelectedTestId] = useState(null);
  const [analyticsExpanded, setAnalyticsExpanded] = useState(true);
  const [expandedRecordIds, setExpandedRecordIds] = useState([]);
  const [sortStatus, setSortStatus] = useState({
    columnAccessor: 'is_active_pair',
    direction: 'desc',
  });

  const { data: gunbotStatus } = useQuery({ queryKey: ['gunbotStatus'], queryFn: fetchGunbotStatus });
  const isGunbotConnected = gunbotStatus?.connected === true;

  if (!report || !report.overall_stats || !report.individual_tests) {
    return (
      <Alert icon={<IconAlertTriangle />} title="Report Empty" color="blue">
        The selected report does not contain valid backtest data.
      </Alert>
    );
  }

  const { activeData, testName, isOverallView } = useMemo(() => {
    const overall = {
      stats: report.overall_stats,
      equityCurve: report.overall_equity_curve,
      params: null,
    };

    if (selectedTestId === null) {
      return {
        activeData: overall,
        testName: 'Portfolio Overview',
        isOverallView: true,
      };
    }

    const test = report.individual_tests.find((t) => t.test_id === selectedTestId);
    return {
      activeData: test
        ? { stats: test.stats, equityCurve: test.equity_curve, params: test.parameters }
        : overall,
      testName: test
        ? `${test.strategy_name} on ${test.symbol}`
        : 'Portfolio Overview',
      isOverallView: !test,
    };
  }, [report, selectedTestId]);

  const { stats, params } = activeData;
  const hasParams = params && Object.keys(params).length > 0;
  const exitReasons = stats['Exit Reason Counts'] || {};
  const hasExitData = Object.keys(exitReasons).length > 0;

  const pieData = useMemo(
    () =>
      Object.entries(exitReasons).map(([name, value], index) => ({
        name,
        value,
        fill: REASON_COLORS[name] || PIE_COLORS[index % PIE_COLORS.length],
      })),
    [exitReasons],
  );

  const testsForTable = useMemo(() => {
    const data = report.individual_tests.map((t) => ({
      ...t.stats,
      test_id: t.test_id,
      Strategy: t.strategy_name,
      Symbol: t.symbol,
      Timeframe: t.timeframe,
      is_active_pair: t.is_active_pair,
      parameters: t.parameters,
      // Pass full test data for the add function
      full_test_data: t,
    }));

    const { columnAccessor, direction } = sortStatus;
    data.sort((a, b) => {
      let valA = a[columnAccessor];
      let valB = b[columnAccessor];

      if (valA === undefined || valA === null) valA = -Infinity;
      if (valB === undefined || valB === null) valB = -Infinity;
      
      if (valA === Infinity) return direction === 'desc' ? -1 : 1;
      if (valB === Infinity) return direction === 'desc' ? 1 : -1;

      if (typeof valA === 'boolean' && typeof valB === 'boolean') {
        return direction === 'asc' ? (valA === valB ? 0 : valA ? 1 : -1) : (valA === valB ? 0 : valA ? -1 : 1);
      }

      if (typeof valA === 'string') {
        return direction === 'asc'
          ? valA.localeCompare(valB)
          : valB.localeCompare(valA);
      }

      if (valA > valB) return direction === 'asc' ? 1 : -1;
      if (valA < valB) return direction === 'asc' ? -1 : 1;
      return 0;
    });
    return data;
  }, [report.individual_tests, sortStatus]);
  
  const renderStatTile = (label, key, suffix = '', positiveColor = 'green', negativeColor = 'red') => {
    const value = stats?.[key];
    const color =
      value === undefined || value >= 0
        ? theme.colors[positiveColor][4]
        : theme.colors[negativeColor][4];
    return <StatTile label={label} value={value} color={color} suffix={suffix} />;
  };

  const gunbotWarning = report?.config?.gunbot_warning;
  
  return (
    <Stack gap="xl">
      {gunbotWarning && (
        <Alert icon={<IconInfoCircle size="1rem" />} title="Note on Exchange Mapping" color="yellow" variant="light">
            {gunbotWarning}
        </Alert>
      )}

      <Card withBorder radius="md" p="lg" bg="dark.6">
        <Group justify="space-between">
          <Title order={3}>{testName}</Title>
          {!isOverallView && (
            <Button
              size="xs"
              variant="light"
              onClick={() => setSelectedTestId(null)}
            >
              Back to Overview
            </Button>
          )}
        </Group>

        <Divider my="md" />

        <Grid gutter="xl">
          <Grid.Col span={{ base: 12, lg: 8 }}>
            <EquityChart data={activeData.equityCurve} theme={theme} />
          </Grid.Col>

          <Grid.Col span={{ base: 12, lg: 4 }}>
            <Stack>
              <SimpleGrid cols={2} spacing="sm">
                {renderStatTile('Total Return', 'Total Return %', '%')}
                {renderStatTile('Buy & Hold', 'Buy & Hold %', '%', 'gray', 'gray')}
                {renderStatTile('Sharpe', 'Sharpe Ratio (ann.)')}
                {renderStatTile('Max DD', 'Max Drawdown %', '%', 'red', 'red')}
              </SimpleGrid>

              <UnstyledButton
                onClick={() => setAnalyticsExpanded((o) => !o)}
                mt="sm"
              >
                <Group justify="space-between">
                  <Text fw={500} size="sm">
                    Trade Analytics
                  </Text>
                  <IconChevronDown
                    size={16}
                    style={{
                      transform: `rotate(${analyticsExpanded ? 180 : 0}deg)`,
                      transition: 'transform 0.2s',
                    }}
                  />
                </Group>
              </UnstyledButton>

              <Collapse in={analyticsExpanded}>
                <SimpleGrid cols={2} spacing="sm">
                  <StatTile
                    label="Profit Factor"
                    value={stats['Profit Factor']}
                    color={theme.colors.blue[4]}
                    size="sm"
                  />
                  <StatTile
                    label="Win Rate"
                    value={stats['Win Rate %']}
                    color={theme.colors.blue[4]}
                    suffix="%"
                    size="sm"
                  />
                  <StatTile
                    label="Avg Win"
                    value={stats['Avg Win PnL %']}
                    color={theme.colors.teal[4]}
                    suffix="%"
                    size="sm"
                  />
                  <StatTile
                    label="Avg Loss"
                    value={stats['Avg Loss PnL %']}
                    color={theme.colors.red[4]}
                    suffix="%"
                    size="sm"
                  />
                </SimpleGrid>

                {hasParams && (
                  <Card
                    withBorder
                    radius="sm"
                    mt="md"
                    p="xs"
                    style={{ borderColor: '#3a3a3a' }}
                  >
                    <Text size="xs" fw={500} c="dimmed" mb={4}>
                      Parameters
                    </Text>
                    <SimpleGrid cols={2} spacing={4}>
                      {Object.entries(params).map(([key, value]) => (
                        <Group key={key} gap={4} justify="space-between">
                          <MantineTooltip
                            label={key.replace(/_/g, ' ')}
                            withinPortal
                          >
                            <Text
                              size="xs"
                              c="dimmed"
                              tt="capitalize"
                              truncate
                              maw={100}
                            >
                              {key.replace(/_/g, ' ')}
                            </Text>
                          </MantineTooltip>
                          <Text size="sm" fw={500}>
                            {String(value)}
                          </Text>
                        </Group>
                      ))}
                    </SimpleGrid>
                  </Card>
                )}
              </Collapse>
            </Stack>
          </Grid.Col>
        </Grid>

        {!isOverallView && hasExitData && (
          <>
            <Divider
              my="lg"
              labelPosition="center"
              label={
                <Group gap={4}>
                  <IconChartPie3 size={14} />
                  <Text size="xs">Exit Reason Distribution</Text>
                </Group>
              }
            />
            <Center>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={60}
                    label={false}
                  >
                    {pieData.map((entry) => (
                      <Cell
                        key={`cell-${entry.name}`}
                        fill={entry.fill}
                      />
                    ))}
                  </Pie>
                  <Legend />
                  <Tooltip formatter={(value, name) => [`${value} trades`, name]} />
                </PieChart>
              </ResponsiveContainer>
            </Center>
          </>
        )}
      </Card>

      {testsForTable.length > 0 && (
        <Card withBorder radius="md" p="lg" bg="dark.6">
          <Title order={4} mb="md">
            Individual Test Runs
          </Title>
          <DataTable
            height={380}
            minHeight={380}
            withTableBorder
            borderRadius="sm"
            striped
            highlightOnHover
            virtualized
            sortStatus={sortStatus}
            onSortStatusChange={setSortStatus}
            records={testsForTable}
            idAccessor="test_id"
            rowClassName={({ test_id }) =>
              test_id === selectedTestId
                ? 'mantine-datatable-row-highlight'
                : ''
            }
            onRowClick={({ record }) =>
              setSelectedTestId(
                record.test_id === selectedTestId ? null : record.test_id,
              )
            }
            expandedRecordIds={expandedRecordIds}
            onExpandedRecordIdsChange={setExpandedRecordIds}
            rowExpansion={{
              content: ({ record }) => {
                const { parameters } = record;
                const hasParams = parameters && Object.keys(parameters).length > 0;
                
                if (record.Strategy === 'ACTIVE PAIR') {
                  return (
                    <Paper bg="dark.5" p="md" m="md" withBorder radius="sm">
                      <Group gap="xs">
                        <IconBox size={18} />
                        <Text size="sm">Live Gunbot Strategy:</Text>
                        <Code>{parameters.strategy || 'N/A'}</Code>
                      </Group>
                    </Paper>
                  );
                }

                if (!hasParams) {
                  return (
                    <Paper bg="dark.5" p="md" m="md" withBorder radius="sm">
                       <Group gap="xs">
                        <IconBox size={18} />
                        <Text c="dimmed" size="sm">This strategy has no configurable parameters.</Text>
                      </Group>
                    </Paper>
                  );
                }

                return (
                  <Paper bg="dark.5" p="md" m="md" withBorder radius="sm">
                    <Title order={6} mb="sm">Strategy Parameters</Title>
                    <SimpleGrid cols={{ base: 2, sm: 3, md: 4}} spacing="xs" verticalSpacing="xs">
                      {Object.entries(parameters).map(([key, value]) => (
                        <div key={key}>
                          <Text size="xs" c="dimmed" tt="capitalize" truncate>{key.replace(/_/g, ' ')}</Text>
                          <Text size="sm" fw={500}>{String(value)}</Text>
                        </div>
                      ))}
                    </SimpleGrid>
                  </Paper>
                );
              },
            }}
            columns={[
              { accessor: 'Strategy', width: 220, sortable: true },
              { accessor: 'Symbol', width: 120, sortable: true },
              { accessor: 'Timeframe', width: 100, sortable: true },
              { accessor: 'Total Return %', title: 'Return %', sortable: true, textAlignment: 'right', render: ({ 'Total Return %': val }) => renderNumeric(val, 'teal', 'red', '%'), },
              { accessor: 'Profit Factor', title: 'P/F', sortable: true, textAlignment: 'right', render: ({ 'Profit Factor': val }) => renderNumeric(val), customCellAttributes: ({ 'Profit Factor': val }) => ({ title: val === Infinity ? '∞' : val?.toFixed(2) ?? 'N/A', }), },
              { accessor: 'Sharpe Ratio (ann.)', title: 'Sharpe', sortable: true, textAlignment: 'right', render: ({ 'Sharpe Ratio (ann.)': val }) => renderNumeric(val), },
              { accessor: 'Max Drawdown %', title: 'Max DD %', sortable: true, textAlignment: 'right', render: ({ 'Max Drawdown %': val }) => renderNumeric(val, 'red', 'red', '%'), },
              { accessor: 'Total Trades', title: 'Trades', sortable: true, textAlignment: 'right' },
              {
                accessor: 'actions', title: 'Actions', textAlignment: 'right', width: 100,
                render: (test) => {
                  const tooltipLabel = isGunbotConnected ? `Deploy ${test.Symbol} to Gunbot` : "Connect to Gunbot to add pairs";
                  const isAddable = !test.is_active_pair && test.Strategy !== "ACTIVE PAIR";
                  if (!isAddable) return null;
                  return (
                    <MantineTooltip label={tooltipLabel} withArrow>
                      <ActionIcon disabled={!isGunbotConnected} onClick={(e) => { e.stopPropagation(); if (onAddPair) onAddPair(test.full_test_data); }}>
                        <IconPlus size={16} />
                      </ActionIcon>
                    </MantineTooltip>
                  );
                },
              },
            ]}
          />
        </Card>
      )}
    </Stack>
  );
}

const renderNumeric = (
  value,
  colorPositive = 'teal',
  colorNegative = 'red',
  suffix = '',
) => {
  if (value === Infinity)
    return (
      <Text c="green" size="sm" ta="right">
        ∞
      </Text>
    );
  const num = value ?? 0;
  return (
    <Text
      c={num >= 0 ? colorPositive : colorNegative}
      size="sm"
      ta="right"
    >
      {num.toFixed(2)}
      {suffix}
    </Text>
  );
};
```


## ./gunbot_quant/frontend/src/ScreenerResultsDisplay.jsx
```
/* eslint react/prop-types: 0 */
import { memo, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Center,
  Divider,
  Grid,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Title,
  Tooltip as MantineTooltip,
  useMantineTheme,
} from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import {
  IconInfoCircle,
  IconArrowBackUp,
  IconPlus,
  IconSearch,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';

/* ---------------------------------------------------------------------------
   Stat Tile & Group Components
--------------------------------------------------------------------------- */
const StatTile = memo(({ label, value, color, suffix = '', size = 'sm', tooltip }) => {
  const content = (
      <Paper
        withBorder
        p="xs"
        radius="md"
        style={{ background: 'transparent', borderColor: '#2a2a2a' }}
      >
        <Text size="xs" c="dimmed" truncate>
          {label}
        </Text>
        <Text size={size} c={color} fw={600}>
          {typeof value === 'number' && !Number.isNaN(value)
            ? value.toFixed(2)
            : (value === 'N/A' ? 'N/A' : (value ?? '--'))}
          {value !== 'N/A' && value !== '--' && suffix}
        </Text>
      </Paper>
  );

  if (tooltip) {
      return <MantineTooltip label={tooltip} withArrow withinPortal>{content}</MantineTooltip>;
  }
  return content;
});
StatTile.displayName = 'StatTile';

const StatGroup = ({ title, children }) => (
    <Paper withBorder p="md" radius="md" bg="dark.7">
        <Title order={5} mb="md">{title}</Title>
        <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="md">
            {children}
        </SimpleGrid>
    </Paper>
);

// Helper to format large numbers
const formatNumber = (num, decimals = 2) => {
    if (typeof num !== 'number' || Number.isNaN(num)) return 'N/A';

    const format = (value) => {
        const fixed = value.toFixed(decimals);
        return fixed.endsWith(`.${'0'.repeat(decimals)}`) ? 
            parseInt(fixed, 10).toString() : 
            fixed;
    };

    if (num >= 1e9) return `${format(num / 1e9)}B`;
    if (num >= 1e6) return `${format(num / 1e6)}M`;
    if (num >= 1e3) return `${format(num / 1e3)}k`;
    
    return format(num);
};

const fetchGunbotStatus = async () => {
    const res = await fetch('/api/v1/gunbot/status');
    if (!res.ok) throw new Error('Network response was not ok');
    return res.json();
};

/* ---------------------------------------------------------------------------
   Main Component
--------------------------------------------------------------------------- */
export default function ScreenerResultsDisplay({ report, onAddPair }) {
  const theme = useMantineTheme();
  const [selectedSymbolId, setSelectedSymbolId] = useState(null);
  const [sortStatus, setSortStatus] = useState({
    columnAccessor: report?.rank_metric || 'symbol',
    direction: 'desc',
  });

  const { data: gunbotStatus } = useQuery({ queryKey: ['gunbotStatus'], queryFn: fetchGunbotStatus });
  const isGunbotConnected = gunbotStatus?.connected === true;

  if (!report || !report.analysis_df_json) {
    return (
      <Alert icon={<IconInfoCircle />} title="Report Empty" color="blue">
        The selected screener run does not contain valid data. This can happen if there was an issue fetching data or if the report file is corrupted.
      </Alert>
    );
  }

  if (report.symbols.length === 0) {
    return (
      <Center h={400}>
        <Stack align="center">
          <IconSearch size={46} color={theme.colors.gray[6]} />
          <Title order={3}>No Symbols Found</Title>
          <Text c="dimmed" size="sm" ta="center">
            The screener ran successfully but did not find any symbols that matched your criteria.
            <br />
            Try using broader filters or a different market.
          </Text>
        </Stack>
      </Center>
    );
  }

  const { activeData, viewName, isOverview } = useMemo(() => {
    const records = report.analysis_df_json;
    if (!selectedSymbolId) {
      return {
        activeData: {
            'Market': report.exchange === 'yfinance' ? 'US Stocks/ETFs' : `${report.exchange.toUpperCase()}/${report.quote_asset}`,
            'Timeframe': report.timeframe,
            'Ranked By': report.rank_metric.replace(/_/g, ' '),
            'Symbols Found': records.length,
        },
        viewName: 'Screener Run Overview',
        isOverview: true,
      };
    }

    const symbolData = records.find((r) => r.symbol === selectedSymbolId);
    return {
      activeData: symbolData || null,
      viewName: `Details for ${selectedSymbolId}`,
      isOverview: false,
    };
  }, [report, selectedSymbolId]);


  const recordsForTable = useMemo(() => {
    const data = [...report.analysis_df_json];
    const { columnAccessor, direction } = sortStatus;
    data.sort((a, b) => {
      const valA = a[columnAccessor] ?? -Infinity;
      const valB = b[columnAccessor] ?? -Infinity;
      if (typeof valA === 'string') return direction === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      if (valA > valB) return direction === 'asc' ? 1 : -1;
      if (valA < valB) return direction === 'asc' ? -1 : 1;
      return 0;
    });
    return data;
  }, [report.analysis_df_json, sortStatus]);

  const renderNumeric = (val, color = 'gray', suffix = '') => (
    <Text c={color} size="sm" ta="right" fw={500}>
        {typeof val === 'number' ? `${val.toFixed(2)}${suffix}` : '--'}
    </Text>
  );

  const getMetricColor = (metric, value) => {
    if (typeof value !== 'number' || Number.isNaN(value)) return theme.colors.gray[5];
    if (metric.includes('roc_')) return value > 0 ? theme.colors.teal[4] : theme.colors.red[4];
    if (metric.includes('price_vs_')) return value > 0 ? theme.colors.teal[4] : theme.colors.red[4];
    if (metric.includes('sma50_vs_sma200')) return value > 0 ? theme.colors.green[5] : theme.colors.red[5];
    if (metric.includes('rsi_')) return value > 70 ? theme.colors.orange[4] : value < 30 ? theme.colors.cyan[4] : theme.colors.gray[5];
    if (metric.includes('stochrsi_')) return value > 80 ? theme.colors.orange[4] : value < 20 ? theme.colors.cyan[4] : theme.colors.gray[5];
    if (metric.includes('adx_')) return value > 25 ? theme.colors.yellow[6] : theme.colors.gray[5];
    return theme.colors.blue[4];
  };

  return (
    <Stack gap="xl">
      <Card withBorder radius="md" p="lg" bg="dark.6">
        <Group justify="space-between" align="flex-start">
            <Stack gap={0}>
                <Title order={3}>{viewName}</Title>
                {!isOverview && <Text c="dimmed" size="sm" tt="capitalize">All metrics calculated on the {report.timeframe} timeframe</Text>}
            </Stack>
          {!isOverview && (
            <Button
              size="xs"
              variant="light"
              leftSection={<IconArrowBackUp size={14} />}
              onClick={() => setSelectedSymbolId(null)}
            >
              Back to Overview
            </Button>
          )}
        </Group>
        <Divider my="md" />

        {isOverview && (
             <Center p="xl">
                <SimpleGrid cols={{base: 2, sm: 4}} spacing="xl">
                    <StatTile label="Market" value={activeData['Market']} color={theme.colors.gray[4]} size="md" />
                    <StatTile label="Timeframe" value={activeData['Timeframe']} color={theme.colors.gray[4]} size="md" />
                    <StatTile label="Ranked By" value={activeData['Ranked By']} color={theme.colors.gray[4]} size="md" tt="capitalize" />
                    <StatTile label="Symbols Found" value={activeData['Symbols Found']} color={theme.colors.gray[4]} size="md" />
                </SimpleGrid>
             </Center>
        )}
        
        {!isOverview && activeData && (
          <Stack gap="lg">
            <StatGroup title="Momentum & Trend">
                <StatTile label="ROC 30p" value={activeData.roc_30p} color={getMetricColor('roc_', activeData.roc_30p)} suffix="%" />
                <StatTile label="ROC 90p" value={activeData.roc_90p} color={getMetricColor('roc_', activeData.roc_90p)} suffix="%" />
                <StatTile label="Price vs 50 SMA" value={activeData.price_vs_sma50} color={getMetricColor('price_vs_', activeData.price_vs_sma50)} suffix="%" />
                <StatTile label="50 vs 200 SMA" value={activeData.sma50_vs_sma200} color={getMetricColor('sma50_vs_sma200', activeData.sma50_vs_sma200)} suffix="%" />
                <StatTile label="ADX 14p" value={activeData.adx_14p} color={getMetricColor('adx_', activeData.adx_14p)} />
                <StatTile label="Dist from Recent High" value={activeData.dist_from_ath_lookback_pct} color={theme.colors.red[4]} suffix="%" tooltip="From recent high in loaded data" />
            </StatGroup>
            
             <StatGroup title="Volume & Volatility">
                <StatTile label="ATR 14p %" value={activeData.atr_pct_14p} color={getMetricColor('atr_', activeData.atr_pct_14p)} suffix="%" />
                <StatTile label="30d Avg Volume" value={formatNumber(activeData.avg_vol_30d_quote, 2)} color={theme.colors.blue[4]} tooltip="In quote asset (or shares for stocks)" />
                <StatTile label="Relative Volume" value={activeData.rel_vol_10d_quote || activeData.rel_vol_10d} color={(activeData.rel_vol_10d_quote || activeData.rel_vol_10d) > 1 ? theme.colors.yellow[5] : theme.colors.gray[5]} tooltip="Latest Day vs 10d Avg"/>
            </StatGroup>

             <StatGroup title="Oscillators">
                <StatTile label="RSI 14p" value={activeData.rsi_14p} color={getMetricColor('rsi_', activeData.rsi_14p)} />
                <StatTile label="StochRSI K" value={activeData.stochrsi_k_14_3_3} color={getMetricColor('stochrsi_', activeData.stochrsi_k_14_3_3)} />
                <StatTile label="StochRSI D" value={activeData.stochrsi_d_14_3_3} color={getMetricColor('stochrsi_', activeData.stochrsi_d_14_3_3)} />
            </StatGroup>

            <StatGroup title="Tradability Heuristics">
                <StatTile label="Volatility Consistency" value={activeData.volatility_consistency} color={theme.colors.grape[4]} tooltip="StdDev of daily ATR % over 90 days. Lower is better." />
                <StatTile label="Max Daily Spike" value={activeData.max_daily_spike_pct} color={theme.colors.orange[5]} suffix="%" tooltip="Largest single-day price range over 90 days." />
                <StatTile label="Volume Concentration" value={activeData.volume_concentration_pct} color={theme.colors.pink[5]} suffix="%" tooltip="Percentage of 90-day volume that occurred on the top 3 volume days." />
            </StatGroup>
          </Stack>
        )}

      </Card>
      
      <Card withBorder radius="md" p="lg" bg="dark.6">
        <Title order={4} mb="md">Filtered Symbols</Title>
        <DataTable
            withTableBorder
            borderRadius="sm"
            striped
            highlightOnHover
            sortStatus={sortStatus}
            onSortStatusChange={setSortStatus}
            records={recordsForTable}
            idAccessor="symbol"
            rowClassName={({ symbol }) => symbol === selectedSymbolId ? 'mantine-datatable-row-highlight' : ''}
            onRowClick={({ record }) => setSelectedSymbolId(record.symbol === selectedSymbolId ? null : record.symbol)}
            noRecordsText="Screener did not find any symbols matching your criteria."
            columns={[
              { accessor: 'symbol', title: 'Symbol', width: 120, sortable: true, frozen: true },
              { accessor: report.rank_metric, title: `Rank: ${report.rank_metric.replace(/_/g, ' ')}`, width: 150, textAlignment: 'right', sortable: true, render: (r) => renderNumeric(r[report.rank_metric], theme.colors.yellow[6]), tt: 'capitalize' },
              { accessor: 'roc_30p', title: 'ROC 30p %', textAlignment: 'right', sortable: true, render: (r) => renderNumeric(r.roc_30p, getMetricColor('roc_', r.roc_30p), '%') },
              { accessor: 'atr_pct_14p', title: 'ATR 14p %', textAlignment: 'right', sortable: true, render: (r) => renderNumeric(r.atr_pct_14p, getMetricColor('atr_', r.atr_pct_14p), '%') },
              { accessor: 'rsi_14p', title: 'RSI 14p', textAlignment: 'right', sortable: true, render: (r) => renderNumeric(r.rsi_14p, getMetricColor('rsi_', r.rsi_14p)) },
              { accessor: 'adx_14p', title: 'ADX 14p', textAlignment: 'right', sortable: true, render: (r) => renderNumeric(r.adx_14p, getMetricColor('adx_', r.adx_14p)) },
              { accessor: 'avg_vol_30d_quote', title: 'Vol 30d', textAlignment: 'right', sortable: true, render: (r) => <Text size="sm" ta="right">{formatNumber(r.avg_vol_30d_quote)}</Text> },
              {
                accessor: 'actions', title: 'Actions', textAlignment: 'right', width: 100,
                render: (screenerResult) => {
                  if (report.exchange === 'yfinance') return null;
                  const tooltipLabel = isGunbotConnected ? `Deploy ${screenerResult.symbol} to Gunbot` : "Connect to Gunbot to add pairs";
                  return (
                    <MantineTooltip label={tooltipLabel} withArrow>
                      <ActionIcon disabled={!isGunbotConnected} onClick={(e) => { e.stopPropagation(); if (onAddPair) onAddPair({ ...screenerResult, quote_asset: report.quote_asset, exchange: report.exchange, timeframe: report.timeframe }); }}>
                        <IconPlus size={16} />
                      </ActionIcon>
                    </MantineTooltip>
                  );
                },
              },
            ]}
        />
      </Card>
    </Stack>
  );
}
```


## ./gunbot_quant/frontend/src/ResultsSkeleton.jsx
```
import { Skeleton, Paper, Stack, Grid } from '@mantine/core';

export default function ResultsSkeleton() {
  return (
    <Stack>
      {/* Top Card Skeleton */}
      <Paper withBorder p="lg" radius="md">
        <Grid>
          {/* Chart Area */}
          <Grid.Col span={{ base: 12, md: 8, lg: 9 }}>
            <Skeleton height={350} radius="sm" />
          </Grid.Col>
          {/* Stats Panel */}
          <Grid.Col span={{ base: 12, md: 4, lg: 3 }}>
            <Stack>
              <Skeleton height={60} radius="sm" />
              <Skeleton height={60} radius="sm" />
              <Skeleton height={40} radius="sm" mt="md" />
              <Skeleton height={80} radius="sm" />
            </Stack>
          </Grid.Col>
        </Grid>
      </Paper>

      {/* Table Skeleton */}
      <Stack mt="xl">
        <Skeleton height={20} width="30%" radius="sm" />
        <Skeleton height={380} radius="sm" />
      </Stack>
    </Stack>
  );
}
```


## ./gunbot_quant/frontend/src/Screener.jsx
```
/* eslint react/prop-types: 0 */
import { useState, useEffect, useRef } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Collapse,
  Divider,
  Grid,
  Group,
  List,
  NumberInput,
  Paper,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  TagsInput,
  Text,
  TextInput,
  Title,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconCheck,
  IconDeviceFloppy,
  IconFileSearch,
  IconInfoCircle,
  IconPlus,
  IconSearch,
  IconTrash,
  IconX,
  IconBuildingStore,
} from '@tabler/icons-react';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import dayjs from 'dayjs';
import ScreenerResultsDisplay from './ScreenerResultsDisplay';
import ScreenerResultsSkeleton from './ScreenerResultsSkeleton';

/* ──────────────────────────────────────────
   STATIC SELECT DATA
   ────────────────────────────────────────── */
const availableConditions = [
  { value: 'greater_than', label: '>' },
  { value: 'less_than', label: '<' },
  { value: 'between', label: 'between' },
];

const screenerTimeframes = [
  { value: '1m', label: '1 Minute' },
  { value: '3m', label: '3 Minutes' },
  { value: '5m', label: '5 Minutes' },
  { value: '15m', label: '15 Minutes' },
  { value: '30m', label: '30 Minutes' },
  { value: '1h', label: '1 Hour' },
  { value: '2h', label: '2 Hours' },
  { value: '4h', label: '4 Hours' },
  { value: '6h', label: '6 Hours' },
  { value: '12h', label: '12 Hours' },
  { value: '1d', label: '1 Day' },
  { value: '3d', label: '3 Days' },
];

/* ──────────────────────────────────────────
   COMPONENT
   ────────────────────────────────────────── */
export default function Screener({ onAddPair }) {
  const theme = useMantineTheme();

  /* ─────── runtime state ─────── */
  const [jobStatus, setJobStatus] = useState('idle');   // idle | running | completed | failed
  const [jobError, setJobError] = useState(null);
  const [results, setResults] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const pollingRef = useRef(null);

  /* dynamic select data */
  const [availableMarkets, setAvailableMarkets] = useState([]);
  const [marketsLoading, setMarketsLoading] = useState(true);
  const [availableMetrics, setAvailableMetrics] = useState([]);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [availableExchanges, setAvailableExchanges] = useState([]);
  const [exchangesLoading, setExchangesLoading] = useState(true);


  /* UI toggles */
  const [showHelp, setShowHelp] = useState(false);

  /* ─────── helpers ─────── */
  const metricMeta = Object.fromEntries(availableMetrics.map((m) => [m.value, m]));
  const metricSelectData = availableMetrics.map((m) => ({ value: m.value, label: m.label }));

  /* ─────── form ─────── */
  const form = useForm({
    initialValues: {
      job_name: `Screen-${dayjs().format('YYYY-MM-DD_HH-mm-ss')}`,
      exchange: 'binance',
      quote_asset: 'USDT',
      timeframe: '1d',
      candidate_count: 200,
      final_count: 20,
      rank_metric: 'roc_30p',
      filters: [
        { metric: 'avg_vol_30d_quote', condition: 'greater_than', value: '10000000' },
        { metric: 'atr_pct_14p', condition: 'between', value: '2, 10' },
        { metric: 'stochrsi_k_14_3_3', condition: 'less_than', value: '20' },
      ],
      symbols: ['SPY', 'QQQ', 'TSLA', 'AAPL', 'MSFT'], // For yfinance
    },
    validate: (values) => {
        const errors = {};
        if (!values.job_name.trim()) errors.job_name = 'Required';
        
        if (values.exchange !== 'yfinance') {
            if (!values.quote_asset) errors.quote_asset = 'Required';
            if (!(values.candidate_count > 0 && values.candidate_count <= 500)) errors.candidate_count = '1-500';
            if (!(values.final_count > 0 && values.final_count <= 50)) errors.final_count = '1-50';
        } else {
            if (!values.symbols || values.symbols.length === 0) errors.symbols = 'At least one ticker is required for Yahoo Finance';
        }
        return errors;
    },
  });

  /* ─────── async fetches ─────── */
  useEffect(() => {
     const fetchExchanges = async () => {
      setExchangesLoading(true);
      try {
        const resp = await fetch('/api/v1/exchanges');
        if (!resp.ok) throw new Error('Could not load exchange list');
        setAvailableExchanges(await resp.json());
      } catch (err) {
        notifications.show({ title: 'Error Loading Exchanges', message: err.message, color: 'red' });
      } finally {
        setExchangesLoading(false);
      }
    };

    const fetchMetrics = async () => {
      setMetricsLoading(true);
      try {
        const resp = await fetch(`/api/v1/screen/metrics?exchange=${form.values.exchange}`);
        if (!resp.ok) throw new Error('Could not load metrics');
        setAvailableMetrics(await resp.json());
      } catch (err) {
        notifications.show({
          title: 'Error',
          message: err.message,
          color: 'red',
          icon: <IconAlertCircle />,
        });
      } finally {
        setMetricsLoading(false);
      }
    };

    fetchExchanges();
    fetchMetrics();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.values.exchange]);

  useEffect(() => {
    const selectedExchange = form.values.exchange;
    if (!selectedExchange || selectedExchange === 'yfinance') {
        setAvailableMarkets([]);
        setMarketsLoading(false);
        return;
    };

    const fetchMarkets = async () => {
      setMarketsLoading(true);
      try {
        const resp = await fetch(`/api/v1/markets/${selectedExchange}`);
        if (!resp.ok) throw new Error(`Could not load markets for ${selectedExchange}`);
        const markets = await resp.json();
        setAvailableMarkets(markets);
        if (!markets.includes(form.values.quote_asset)) {
          form.setFieldValue('quote_asset', markets.find(m => m === 'USDT') || markets[0] || '');
        }
      } catch (err) {
        notifications.show({ title: 'Error Loading Markets', message: err.message, color: 'red' });
        setAvailableMarkets(['USDT', 'BTC']); // Fallback
      } finally {
        setMarketsLoading(false);
      }
    };

    fetchMarkets();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.values.exchange]);

  /* ─────── job helpers ─────── */
  const stopPolling = () => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  };

  useEffect(() => () => stopPolling(), []);

  const checkJobStatus = async (jobId) => {
    try {
      const response = await fetch(`/api/v1/screen/status/${jobId}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Failed to fetch status');

      if (data.status === 'completed') {
        setJobStatus('completed');
        setResults(data.report);
        notifications.show({
          title: 'Screener completed',
          message: `Results for ${jobId} are ready`,
          color: 'green',
          icon: <IconCheck />,
        });
        stopPolling();
      } else if (data.status === 'failed') {
        setJobStatus('failed');
        setJobError(data.report?.details || data.report?.error || 'Job failed');
        notifications.show({
          title: 'Screener failed',
          message: data.report?.error || 'Error while screening',
          color: 'red',
          icon: <IconAlertCircle />,
          autoClose: 10000
        });
        stopPolling();
      }
    } catch (err) {
      setJobStatus('failed');
      setJobError(err.message);
      stopPolling();
    }
  };

  /* util to clean form values */
  const getSanitizedConfig = (values) => {
    const formattedFilters = values.filters
      .map((f) => {
        if (!f.metric || !f.condition || !f.value) return null;
        let parsedValue;
        if (f.condition === 'between') {
          parsedValue = f.value
            .split(',')
            .map((v) => parseFloat(v.trim()))
            .filter((v) => !Number.isNaN(v));
          if (parsedValue.length !== 2) return null;
        } else {
          parsedValue = parseFloat(f.value);
          if (Number.isNaN(parsedValue)) return null;
        }
        return { ...f, value: parsedValue };
      })
      .filter(Boolean);
    
    const config = {
        exchange: values.exchange,
        timeframe: values.timeframe,
        rank_metric: values.rank_metric,
        filters: formattedFilters,
    };

    if (values.exchange === 'yfinance') {
        config.symbols = values.symbols;
        config.quote_asset = 'USD'; // Implied for stocks
    } else {
        config.quote_asset = values.quote_asset;
        config.candidate_count = values.candidate_count;
        config.final_count = values.final_count;
    }
    return config;
  };

  /* run screener */
  const runScreener = (values) => {
    setJobStatus('running');
    setResults(null);
    setJobError(null);

    const body = { job_name: values.job_name, config: getSanitizedConfig(values) };

    fetch('/api/v1/screen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.detail || 'Failed to start job');
        }
        return res.json();
      })
      .then((data) => {
        notifications.show({
          title: 'Screener started',
          message: `Job '${values.job_name}' is running`,
          color: 'blue',
        });
        const checker = () => checkJobStatus(data.job_id);
        if (pollingRef.current) clearInterval(pollingRef.current);
        pollingRef.current = setInterval(checker, 5000);
        setTimeout(checker, 1000);
      })
      .catch((err) => {
        setJobStatus('failed');
        setJobError(err.message);
        notifications.show({
          title: 'Error',
          message: err.message,
          color: 'red',
          icon: <IconX />,
        });
      });
  };

  /* save config */
  const saveConfig = (values) => {
    setIsSaving(true);
    const cfgName = values.job_name;
    const cfgBody = getSanitizedConfig(values);

    fetch(`/api/v1/screen/configs/${cfgName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfgBody),
    })
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.detail || 'Failed to save');
        }
        return res.json();
      })
      .then(() => {
        notifications.show({
          title: 'Saved',
          message: `Config '${cfgName}' stored`,
          color: 'green',
          icon: <IconCheck />,
        });
      })
      .catch((err) => {
        notifications.show({
          title: 'Error',
          message: err.message,
          color: 'red',
          icon: <IconX />,
        });
      })
      .finally(() => setIsSaving(false));
  };

  /* ─────── custom render helpers ─────── */
  const renderMetricOption = ({ option }) => {
    const meta = metricMeta[option.value];
    return (
      <Stack gap={2} p={2}>
        <Text size="sm">{option.label}</Text>
        {meta?.description && (
          <Text size="xs" c="dimmed" lh={1.2}>
            {meta.description}
          </Text>
        )}
      </Stack>
    );
  };

  const filterRows = form.values.filters.map((item, idx) => {
    const meta = metricMeta[item.metric];
    return (
      <Paper key={idx} withBorder radius="sm" p="sm">
        <Grid gutter="xs" align="flex-end">
          <Grid.Col span={4}>
            <Select
              label={idx === 0 ? 'Metric' : null}
              placeholder={metricsLoading ? 'Loading…' : 'Metric'}
              data={metricSelectData}
              searchable
              disabled={metricsLoading}
              renderOption={renderMetricOption}
              {...form.getInputProps(`filters.${idx}.metric`)}
            />
          </Grid.Col>
          <Grid.Col span={3}>
            <Select
              label={idx === 0 ? 'Cond' : null}
              data={availableConditions}
              {...form.getInputProps(`filters.${idx}.condition`)}
            />
          </Grid.Col>
          <Grid.Col span={4}>
            <TextInput
              label={idx === 0 ? 'Value' : null}
              placeholder={item.condition === 'between' ? '10, 50' : '25'}
              {...form.getInputProps(`filters.${idx}.value`)}
            />
          </Grid.Col>
          <Grid.Col span={1}>
            <ActionIcon
              color="red"
              mt={idx === 0 ? '1.5625rem' : 0}
              onClick={() => form.removeListItem('filters', idx)}
            >
              <IconTrash size="1rem" />
            </ActionIcon>
          </Grid.Col>
        </Grid>
        {meta?.description && (
          <Text size="xs" c="dimmed" mt={4}>
            {meta.description}
          </Text>
        )}
      </Paper>
    );
  });

  const renderResults = () => {
    if (jobStatus === 'idle') {
      return (
        <Center h={400}>
          <Stack align="center">
            <IconFileSearch size={46} color={theme.colors.gray[6]} />
            <Title order={3}>Ready to screen</Title>
            <Text c="dimmed" size="sm">
              Results will appear here.
            </Text>
          </Stack>
        </Center>
      );
    }
    if (jobStatus === 'running') return <ScreenerResultsSkeleton />;
    if (jobStatus === 'failed') {
      return (
        <Alert color="red" title="Error" icon={<IconAlertCircle />}>
          {jobError}
        </Alert>
      );
    }
    if (jobStatus === 'completed' && results) {
        return <ScreenerResultsDisplay report={results} onAddPair={onAddPair} />;
    }
    return null;
  };

  /* ──────────────────────────────────────────
     JSX
     ────────────────────────────────────────── */
  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={2}>Market Screener</Title>
        <Tooltip label="Show guide">
          <ActionIcon variant="subtle" onClick={() => setShowHelp((o) => !o)}>
            <IconInfoCircle size={20} />
          </ActionIcon>
        </Tooltip>
      </Group>

      <Collapse in={showHelp} mb="md">
        <Alert
          icon={<IconInfoCircle size="1rem" />}
          variant="outline"
          color="blue"
          title="How to Use the Market Screener"
        >
          <List size="sm" spacing="xs">
            <List.Item>
              <b>Scan Crypto Markets:</b> Choose an exchange, timeframe, and asset. The screener fetches top symbols by volume to analyze.
            </List.Item>
            <List.Item>
              <b>Analyze Stocks & ETFs:</b> Select "Yahoo Finance" and provide a manual list of tickers (e.g., SPY, AAPL) to run the same analysis.
            </List.Item>
            <List.Item>
              <b>Define Filters:</b> Build a set of rules using technical indicators to narrow down the candidates to only the most promising assets.
            </List.Item>
            <List.Item>
              <b>Save for Backtesting:</b> You can save any screener setup and use it as an automatic symbol source in the Backtest Lab.
            </List.Item>
          </List>
        </Alert>

      </Collapse>

      <Grid gutter="xl">
        {/* ───── CONFIG COLUMN ───── */}
        <Grid.Col span={{ base: 12, lg: 5 }}>
          <Paper withBorder p="md" radius="md">
            <ScrollArea h="calc(90vh - 160px)">
              <form>
                <Stack gap="sm">
                  <Title order={4}>Run configuration</Title>
                  <TextInput
                    label="Run label"
                    required
                    {...form.getInputProps('job_name')}
                  />
                  <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
                    <Select
                      label="Data Source"
                      data={availableExchanges}
                      searchable
                      disabled={exchangesLoading}
                      placeholder={exchangesLoading ? 'Loading...' : 'Select exchange'}
                      leftSection={<IconBuildingStore size={16} />}
                      {...form.getInputProps('exchange')}
                    />

                    {form.values.exchange !== 'yfinance' ? (
                      <Select
                        label="Denominated in"
                        data={availableMarkets}
                        disabled={marketsLoading || form.values.exchange === 'yfinance'}
                        placeholder={marketsLoading ? 'Loading...' : 'e.g. USDT'}
                        searchable
                        {...form.getInputProps('quote_asset')}
                      />
                    ) : (
                      <Box /> // Empty box to maintain grid layout
                    )}

                    <Select
                      label="Timeframe"
                      description="Candle size"
                      data={screenerTimeframes}
                      {...form.getInputProps('timeframe')}
                    />

                    {form.values.exchange !== 'yfinance' && (
                        <NumberInput
                          label="Candidates"
                          description="Top N by volume"
                          {...form.getInputProps('candidate_count')}
                        />
                    )}
                    
                    {form.values.exchange !== 'yfinance' && (
                        <NumberInput
                          label="Final count"
                          description="Top N ranked"
                          {...form.getInputProps('final_count')}
                        />
                    )}

                    <Select
                      label="Rank metric"
                      description="Criterium to rank results"
                      searchable
                      disabled={metricsLoading}
                      data={metricSelectData}
                      renderOption={renderMetricOption}
                      {...form.getInputProps('rank_metric')}
                    />
                  </SimpleGrid>

                  {form.values.exchange === 'yfinance' && (
                    <TagsInput
                        mt="xs"
                        label="Tickers to Analyze"
                        description="Enter stock/ETF tickers (e.g., SPY, AAPL)"
                        placeholder="Press Enter to add"
                        {...form.getInputProps('symbols')}
                    />
                  )}

                  <Divider label="Filters" mt="sm" />
                  {filterRows}
                  <Group justify="flex-end" mt="xs">
                    <Button
                      variant="default"
                      size="xs"
                      leftSection={<IconPlus size={14} />}
                      onClick={() =>
                        form.insertListItem('filters', {
                          metric: '',
                          condition: 'greater_than',
                          value: '',
                        })
                      }
                    >
                      Filter
                    </Button>
                  </Group>

                  <Divider mt="sm" />

                  <Group grow>
                    <Button
                      variant="outline"
                      loading={isSaving}
                      leftSection={<IconDeviceFloppy size={18} />}
                      onClick={() => form.onSubmit(saveConfig)()}
                    >
                      Save
                    </Button>
                    <Button
                      loading={jobStatus === 'running'}
                      leftSection={<IconSearch size={18} />}
                      onClick={() => form.onSubmit(runScreener)()}
                    >
                      Run
                    </Button>
                  </Group>
                </Stack>
              </form>
            </ScrollArea>
          </Paper>
        </Grid.Col>

        {/* ───── RESULTS COLUMN ───── */}
        <Grid.Col span={{ base: 12, lg: 7 }}>
          <Card withBorder radius="md" p="md" h="calc(90vh - 120px)" style={{minHeight: '85vh', display: 'flex', flexDirection: 'column'}}>
            <ScrollArea h="100%">
                {renderResults()}
            </ScrollArea>
          </Card>
        </Grid.Col>
      </Grid>
    </>
  );
}
```


## ./gunbot_quant/frontend/src/ScreenerResultsSkeleton.jsx
```
import { Skeleton, Paper, Stack, Grid, SimpleGrid } from '@mantine/core';

export default function ScreenerResultsSkeleton() {
  return (
    <Stack gap="xl">
      {/* Top Card Skeleton */}
      <Paper withBorder p="lg" radius="md" bg="dark.6">
        <Skeleton height={20} width="40%" radius="sm" mb="md" />
        <Grid>
          {/* Main Stats Panel */}
          <Grid.Col span={{ base: 12, lg: 8 }}>
            <SimpleGrid cols={2} spacing="sm">
              <Skeleton height={60} radius="sm" />
              <Skeleton height={60} radius="sm" />
              <Skeleton height={60} radius="sm" />
              <Skeleton height={60} radius="sm" />
            </SimpleGrid>
            <Skeleton height={150} radius="sm" mt="xl" />
          </Grid.Col>
          {/* Side Info */}
          <Grid.Col span={{ base: 12, lg: 4 }}>
             <Stack>
                <Skeleton height={20} radius="sm" />
                <Skeleton height={80} radius="sm" />
             </Stack>
          </Grid.Col>
        </Grid>
      </Paper>

      {/* Table Skeleton */}
      <Paper withBorder p="lg" radius="md" bg="dark.6">
        <Skeleton height={20} width="30%" radius="sm" mb="md" />
        <Skeleton height={380} radius="sm" />
      </Paper>
    </Stack>
  );
}
```


## ./gunbot_quant/frontend/src/ResultsViewer.jsx
```
import { useState, useEffect } from 'react';
import { Select, Title, Paper, Alert, Center, Text, Grid, Stack as CmpStack, useMantineTheme, Group } from '@mantine/core';
import { IconAlertCircle, IconReportAnalytics } from '@tabler/icons-react';
import ResultsDisplay from './ResultsDisplay';
import ResultsSkeleton from './ResultsSkeleton';

export default function ResultsViewer({ initialJobId, onAddPair }) {
  const theme = useMantineTheme();
  const [jobList, setJobList] = useState([]);
  const [selectedJobId, setSelectedJobId] = useState(initialJobId || null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingReport, setLoadingReport] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchJobList = async () => {
      setLoadingList(true);
      try {
        const response = await fetch('/api/v1/backtest/results');
        if (!response.ok) throw new Error('Failed to fetch result list');
        const data = await response.json();
        setJobList(data); // API now returns sorted list
      } catch (err) {
        setError(err.message);
      } finally {
        setLoadingList(false);
      }
    };
    fetchJobList();
  }, []);

  useEffect(() => {
    if (initialJobId) {
      setSelectedJobId(initialJobId);
    }
  }, [initialJobId]);


  useEffect(() => {
    if (selectedJobId) {
      const fetchReport = async () => {
        setLoadingReport(true);
        setReport(null);
        setError(null);
        try {
          const response = await fetch(`/api/v1/backtest/results/${selectedJobId}`);
          if (!response.ok) throw new Error(`Failed to fetch report for ${selectedJobId}`);
          const data = await response.json();
          setReport(data);
        } catch (err) {
          setError(err.message);
        } finally {
          setLoadingReport(false);
        }
      };
      fetchReport();
    }
  }, [selectedJobId]);

  return (
    <>
      <Title order={2} mb="md">Backtest History</Title>
       <Text c="dimmed" mb="xl">Browse and review detailed reports from all previously completed backtest runs.</Text>
      
      <Grid>
        <Grid.Col span={12}>
           <Paper withBorder p="md" radius="md">
              <Group>
                <Select
                    label="Select a Saved Backtest Report"
                    placeholder={loadingList ? "Loading results..." : "Choose a run"}
                    icon={<IconReportAnalytics size="1rem" />}
                    data={jobList}
                    value={selectedJobId}
                    onChange={setSelectedJobId}
                    disabled={loadingList}
                    searchable
                    style={{ flex: 1 }}
                />
              </Group>
          </Paper>
        </Grid.Col>
        <Grid.Col span={12}>
          <Paper withBorder p="xl" radius="md" miw="100%" mih={600}>
              {loadingReport && <ResultsSkeleton />}
              {error && <Alert title="Error" color="red" icon={<IconAlertCircle />}>{error}</Alert>}
              
              {!selectedJobId && !loadingReport && !error && (
                  <Center h={400}>
                      <CmpStack align="center" spacing="md">
                          <IconReportAnalytics size={60} stroke={1.5} color={theme.colors.gray[6]} />
                          <Title order={3} ta="center">Select a Report</Title>
                          <Text c="dimmed" ta="center">Please choose a backtest run from the dropdown menu above to view its detailed results.</Text>
                      </CmpStack>
                  </Center>
              )}

              {report && !loadingReport && <ResultsDisplay report={report} onAddPair={onAddPair} />}
          </Paper>
        </Grid.Col>
      </Grid>
    </>
  );
}
```


## ./gunbot_quant/frontend/src/ScreenerHistory.jsx
```
import { useState, useEffect } from 'react';
import {
  Select, Title, Paper, Alert, Center, Text, Grid, Stack, useMantineTheme, Group
} from '@mantine/core';
import { IconFileSearch, IconAlertCircle } from '@tabler/icons-react';
import ScreenerResultsDisplay from './ScreenerResultsDisplay';
import ScreenerResultsSkeleton from './ScreenerResultsSkeleton';

export default function ScreenerHistory({ initialJobId, onAddPair }) {
  const theme = useMantineTheme();
  const [jobList, setJobList] = useState([]);
  const [selectedJobId, setSelectedJobId] = useState(initialJobId || null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingReport, setLoadingReport] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchJobList = async () => {
      setLoadingList(true);
      try {
        const response = await fetch('/api/v1/screen/results');
        if (!response.ok) throw new Error('Failed to fetch screener result list');
        const data = await response.json();
        setJobList(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoadingList(false);
      }
    };
    fetchJobList();
  }, []);

  useEffect(() => {
    if (initialJobId) {
      setSelectedJobId(initialJobId);
    }
  }, [initialJobId]);


  useEffect(() => {
    if (selectedJobId) {
      const fetchReport = async () => {
        setLoadingReport(true);
        setReport(null); // Clear previous report
        setError(null);
        try {
          const response = await fetch(`/api/v1/screen/results/${selectedJobId}`);
          if (!response.ok) throw new Error(`Failed to fetch report for ${selectedJobId}`);
          const data = await response.json();
          setReport(data);
        } catch (err)
 {
          setError(err.message);
        } finally {
          setLoadingReport(false);
        }
      };
      fetchReport();
    }
  }, [selectedJobId]);

  const renderContent = () => {
    if (loadingReport) {
        return <ScreenerResultsSkeleton />;
    }
    
    if (error) {
      return <Alert title="Error" color="red" icon={<IconAlertCircle />}>{error}</Alert>;
    }
    
    if (!selectedJobId) {
      return (
        <Center h={400}>
          <Stack align="center" spacing="md">
            <IconFileSearch size={60} stroke={1.5} color={theme.colors.gray[6]} />
            <Title order={3} ta="center">Select a Screener Report</Title>
            <Text c="dimmed" ta="center">Please choose a run from the dropdown menu above to view its results.</Text>
          </Stack>
        </Center>
      );
    }
    
    if (report) {
      return <ScreenerResultsDisplay report={report} onAddPair={onAddPair} />;
    }

    return null;
  };

  return (
    <>
      <Title order={2} mb="md">Screener History</Title>
      <Text c="dimmed" mb="xl">Browse and review results from all previously completed screener runs.</Text>
      
      <Grid>
        <Grid.Col span={12}>
          <Paper withBorder p="md" radius="md">
            <Group>
                <Select
                    label="Select a Saved Screener Run"
                    placeholder={loadingList ? "Loading results..." : "Choose a run"}
                    icon={<IconFileSearch size="1rem" />}
                    data={jobList}
                    value={selectedJobId}
                    onChange={setSelectedJobId}
                    disabled={loadingList}
                    searchable
                    style={{ flex: 1 }}
                />
            </Group>
          </Paper>
        </Grid.Col>
        <Grid.Col span={12}>
          <Paper withBorder p="xl" radius="md" miw="100%" mih={600}>
            {renderContent()}
          </Paper>
        </Grid.Col>
      </Grid>
    </>
  );
}
```


## ./gunbot_quant/frontend/src/Dashboard.jsx
```
import { Card, Grid, SimpleGrid, Text, Title, useMantineTheme, Table, Paper, ActionIcon, Tooltip as MantineTooltip, Alert, Stack, Loader, Center, List, ThemeIcon, Button, Group } from '@mantine/core';
import { IconTrendingUp, IconReceipt2, IconZoomCode, IconTestPipe, IconEye, IconInfoCircle, IconArrowRight, IconTrophy, IconFileAnalytics, IconHistory, IconBox, IconListDetails, IconRobot } from '@tabler/icons-react';
import { useState, useEffect } from 'react';

function StatCard({ title, description, icon: Icon, onClick, theme }) {
    return (
        <Paper
            withBorder
            p="md"
            radius="md"
            style={{
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                '&:hover': {
                    transform: 'translateY(-2px)',
                    boxShadow: theme.shadows.md
                }
            }}
            onClick={onClick}
        >
            <Group justify="space-between" gap="sm">
                <div style={{ flex: 1 }}>
                    <Text size="md" fw={600} mb={4}>{title}</Text>
                    <Text size="sm" c="dimmed">{description}</Text>
                </div>
                <ThemeIcon variant="light" size={40} radius="md">
                    <Icon size={20} />
                </ThemeIcon>
            </Group>
        </Paper>
    );
}

const renderNumeric = (value, colorPositive = 'teal', colorNegative = 'red', suffix = '') => {
    const num = value ?? 0;
    return <Text c={num >= 0 ? colorPositive : colorNegative} size="sm" fw={500}>{(num).toFixed(2)}{suffix}</Text>;
};

export default function Dashboard({ navigateToResult, navigateToScreenerResult, navigateToView }) {
    const theme = useMantineTheme();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [data, setData] = useState({
        topPerformers: [],
        recentBacktests: [],
        recentScreeners: [],
        screenerConfigs: [],
    });
    const [showWelcome, setShowWelcome] = useState(true);

    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            setError(null);
            try {
                const [backtestRes, screenerRes, configsRes] = await Promise.all([
                    fetch('/api/v1/backtest/results'),
                    fetch('/api/v1/screen/results'),
                    fetch('/api/v1/screen/configs'),
                ]);

                if (!backtestRes.ok || !screenerRes.ok || !configsRes.ok) {
                    throw new Error('Failed to fetch initial dashboard data.');
                }

                const backtestJobs = await backtestRes.json();
                const screenerJobs = await screenerRes.json();
                const screenerConfigs = await configsRes.json();

                const recentReportsToFetch = backtestJobs.slice(0, 5);

                let allStats = [];
                if (recentReportsToFetch.length > 0) {
                    // Fetch reports one by one to avoid overwhelming server
                    const reports = [];
                    for (const id of recentReportsToFetch) {
                        const res = await fetch(`/api/v1/backtest/results/${id}`);
                        if (res.ok) {
                            reports.push(await res.json());
                        }
                    }

                    allStats = reports.flatMap(report =>
                        (report.individual_tests || []).map(test => ({ ...test.stats, Strategy: test.strategy_name, Symbol: test.symbol, jobId: report.scenario_name }))
                    );
                }

                const topPerformers = allStats
                    .sort((a, b) => (b['Sharpe Ratio (ann.)'] ?? 0) - (a['Sharpe Ratio (ann.)'] ?? 0))
                    .slice(0, 5);

                setData({
                    topPerformers,
                    recentBacktests: backtestJobs.slice(0, 5),
                    recentScreeners: screenerJobs.slice(0, 5),
                    screenerConfigs: screenerConfigs.slice(0, 5),
                });

            } catch (err) {
                setError(err.message);
                console.error("Dashboard fetch error:", err);
            } finally {
                setLoading(false);
            }
        };

        fetchData();
    }, []);

    const topPerformerRows = data.topPerformers.map((stat, index) => (
        <Table.Tr key={`${stat.jobId}-${stat.Strategy}-${stat.Symbol}-${index}`} style={{ cursor: 'pointer' }} onClick={() => navigateToResult(stat.jobId)}>
            <Table.Td><Text fw={500} size="sm">{stat.Strategy}</Text></Table.Td>
            <Table.Td><Text c="dimmed" size="sm">{stat.Symbol}</Text></Table.Td>
            <Table.Td>{renderNumeric(stat['Sharpe Ratio (ann.)'])}</Table.Td>
            <Table.Td>{renderNumeric(stat['Total Return %'], 'teal', 'red', '%')}</Table.Td>
            <Table.Td><Text c="dimmed" size="sm">{stat['Total Trades']}</Text></Table.Td>
            <Table.Td>
                <MantineTooltip label="View Full Report">
                    <ActionIcon variant="subtle" size="sm" onClick={(e) => { e.stopPropagation(); navigateToResult(stat.jobId); }}>
                        <IconEye size={14} />
                    </ActionIcon>
                </MantineTooltip>
            </Table.Td>
        </Table.Tr>
    ));

    const renderList = (items, onNavigate, emptyText) => {
        if (items.length === 0) {
            return <Text c="dimmed" size="sm" ta="center" mt="md" py="lg">{emptyText}</Text>;
        }
        return (
            <List spacing="sm" size="sm">
                {items.map(item => (
                    <List.Item
                        key={item}
                        icon={<ThemeIcon size={18} radius="xl" variant="light"><IconArrowRight size={12} /></ThemeIcon>}
                        onClick={() => onNavigate(item)}
                        style={{
                            cursor: 'pointer',
                            padding: '4px 8px',
                            borderRadius: theme.radius.sm,
                            transition: 'background-color 0.2s ease',
                            '&:hover': {
                                backgroundColor: theme.colors.dark[8]
                            }
                        }}
                    >
                        <Text size="sm" fw={500}>{item}</Text>
                    </List.Item>
                ))}
            </List>
        )
    };

    if (loading) {
        return <Center><Loader /></Center>;
    }

    if (error) {
        return <Alert color="red" title="Error Loading Dashboard" icon={<IconInfoCircle />}>{error}</Alert>;
    }

    return (
        <Stack gap="md">
            <Group justify="space-between" align="center" mb="lg">
                <div>
                    <Title order={2} mb={2}>Dashboard</Title>
                    <Text size="sm" c="dimmed">Welcome to your quantitative analysis hub</Text>
                </div>
                <Button variant="light" size="sm" onClick={() => setShowWelcome(true)}>
                    Show Guide
                </Button>
            </Group>

            {showWelcome && (
                <Alert
                    icon={<IconInfoCircle size="1rem" />}
                    title="Welcome to Gunbot Quant!"
                    color="blue"
                    variant="light"
                    withCloseButton
                    onClose={() => setShowWelcome(false)}
                >
                    <Text>
                        This is your workspace for quantitative trading analysis. Here’s what you can do:
                    </Text>
                    <List spacing="xs" mt="sm" size="sm">
                        <List.Item icon={<ThemeIcon color="cyan" size={20} radius="xl"><IconZoomCode size={12} /></ThemeIcon>}>
                            <b>Find Opportunities:</b> Use the <strong>Market Screener</strong> to filter crypto or stock markets for assets that match your specific technical criteria.
                        </List.Item>
                        <List.Item icon={<ThemeIcon color="lime" size={20} radius="xl"><IconTestPipe size={12} /></ThemeIcon>}>
                            <b>Validate Strategies:</b> Take your screened assets (or any list of symbols) into the <strong>Backtest Lab</strong>. Test them against a library of pre-built, configurable strategies to see how they would have performed.
                        </List.Item>
                        <List.Item icon={<ThemeIcon color="grape" size={20} radius="xl"><IconRobot size={12} /></ThemeIcon>}>
                            <b>Deploy & Analyze:</b> Any strategy you backtest can be added to a connected <a href="https://www.gunbot.com" target="_blank" rel="noopener" style={{ color: theme.colors.blue[4] }}>Gunbot</a> instance with one click, using the exact parameters you tested. Use the <strong>Gunbot Tools</strong> to analyze live performance and discover even better pairs.
                        </List.Item>
                    </List>
                    <Text mt="md" size="sm">
                        Use the navigation menu on the left to get started.
                    </Text>
                </Alert>
            )}

            <Paper withBorder p="md" radius="md" shadow="xs">
                <Group justify="space-between" mb="sm">
                    <Title order={4}>Quick Start</Title>
                </Group>
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                    <StatCard title="Market Screener" description="Find promising assets by applying technical filters." icon={IconZoomCode} onClick={() => navigateToView('screener')} theme={theme} />
                    <StatCard title="Backtest Lab" description="Test your strategies against historical market data." icon={IconTestPipe} onClick={() => navigateToView('backtester')} theme={theme} />
                </SimpleGrid>
            </Paper>

            <Paper withBorder p="md" radius="md" shadow="xs">
                <Group justify="space-between" mb="sm">
                    <div>
                        <Title order={4}>Top Performing Strategies</Title>
                        <Text size="xs" c="dimmed">
                            Based on Sharpe Ratio from the 5 most recent backtest runs. Click a row to view the full report.
                        </Text>
                    </div>
                    <IconTrophy size={20} color={theme.colors.yellow[6]} />
                </Group>
                <Table.ScrollContainer minWidth={600}>
                    <Table verticalSpacing="sm" striped highlightOnHover withTableBorder>
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>Strategy</Table.Th>
                                <Table.Th>Symbol</Table.Th>
                                <Table.Th>Sharpe Ratio</Table.Th>
                                <Table.Th>Return %</Table.Th>
                                <Table.Th>Trades</Table.Th>
                                <Table.Th>Actions</Table.Th>
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>{topPerformerRows.length > 0 ? topPerformerRows : <Table.Tr><Table.Td colSpan={6} align="center"><Text c="dimmed">No backtest data found.</Text></Table.Td></Table.Tr>}</Table.Tbody>
                    </Table>
                </Table.ScrollContainer>
            </Paper>

            <Grid>
                <Grid.Col span={{ base: 12, md: 4 }}>
                    <Paper withBorder p="md" radius="md" h="100%" shadow="xs">
                        <Group justify="space-between" mb="sm">
                            <Title order={5}>Recent Backtests</Title>
                            <IconHistory size={18} color={theme.colors.gray[5]} />
                        </Group>
                        {renderList(data.recentBacktests, navigateToResult, "No recent backtests found.")}
                    </Paper>
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 4 }}>
                    <Paper withBorder p="md" radius="md" h="100%" shadow="xs">
                        <Group justify="space-between" mb="sm">
                            <Title order={5}>Recent Screeners</Title>
                            <IconFileAnalytics size={18} color={theme.colors.gray[5]} />
                        </Group>
                        {renderList(data.recentScreeners, navigateToScreenerResult, "No recent screeners found.")}
                    </Paper>
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 4 }}>
                    <Paper withBorder p="md" radius="md" h="100%" shadow="xs">
                        <Group justify="space-between" mb="sm">
                            <Title order={5}>Saved Screener Configs</Title>
                            <IconListDetails size={18} color={theme.colors.gray[5]} />
                        </Group>
                        {renderList(data.screenerConfigs, (configName) => navigateToView('screener'), "No saved configs found.")}
                    </Paper>
                </Grid.Col>
            </Grid>
        </Stack>
    );
}
```


## ./gunbot_quant/frontend/src/main.jsx
```
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MantineProvider, createTheme } from '@mantine/core';
import { Notifications } from '@mantine/notifications';

import App from './App.jsx';

import './index.css';
import '@mantine/core/styles.css';
import '@mantine/dates/styles.css';
import 'mantine-datatable/styles.css';
import '@mantine/notifications/styles.css';


const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const theme = createTheme({
  fontFamily: 'Inter, sans-serif',
  headings: { fontFamily: 'Inter, sans-serif' },
});


createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MantineProvider theme={theme} defaultColorScheme="dark">
        <Notifications position="top-right" />
        <App />
      </MantineProvider>
    </QueryClientProvider>
  </StrictMode>,
);
```


## ./gunbot_quant/frontend/src/App.jsx
```
// App.jsx
import { useState, useEffect, useMemo } from 'react';
import {
  AppShell,
  Group,
  Title,
  ActionIcon,
  MantineProvider,
  createTheme,
  Stack,
  Code,
  UnstyledButton,
  Text,
  Overlay,
  Paper,
  Portal,
  Select,
  SimpleGrid,
  NumberInput,
  Button,
  Divider,
  Alert,
  Center,
  Loader,
  Switch,
  Tooltip as MantineTooltip,
  ThemeIcon,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useDisclosure } from '@mantine/hooks';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import {
  IconGauge,
  IconZoomCode,
  IconTestPipe,
  IconHexagonLetterG,
  IconReportAnalytics,
  IconFileSearch,
  IconRobot,
  IconTrophy,
  IconAlertCircle,
  IconCheck,
  IconX,
  IconPlugConnected,
  IconPlugConnectedX,
  IconInfoCircle
} from '@tabler/icons-react';

import Dashboard from './Dashboard';
import Screener from './Screener';
import Backtester from './Backtester';
import ResultsViewer from './ResultsViewer';
import ScreenerHistory from './ScreenerHistory';
import GunbotConnect from './GunbotConnect';
import DiscoveryResults from './DiscoveryResults';

const theme = createTheme({
  fontFamily: 'Inter, sans-serif',
  headings: { fontFamily: 'Inter, sans-serif' },
});

// z-index values for modal, panel and dropdown
const MODAL_Z = 10000;
const PANEL_Z = MODAL_Z + 1;
const DROPDOWN_Z = PANEL_Z + 1;

function GunbotStatus() {
    const { data: statusData, isLoading } = useQuery({
        queryKey: ['gunbotStatus'],
        queryFn: async () => {
            const res = await fetch('/api/v1/gunbot/status');
            if (!res.ok) return { connected: false };
            return res.json();
        },
        refetchInterval: 30000,
        staleTime: 25000,
        retry: false,
    });

    if (isLoading) {
        return <Loader size="xs" />;
    }

    if (!statusData?.connected) {
        return (
            <MantineTooltip label="Not connected. Go to the Gunbot Tools page to connect." withArrow>
                <Group gap="xs">
                    <ThemeIcon color="gray" size={24} radius="xl">
                        <IconPlugConnectedX size={14} />
                    </ThemeIcon>
                    <Text size="xs" c="dimmed">Disconnected</Text>
                </Group>
            </MantineTooltip>
        );
    }

    const { protocol, host, port } = statusData.config || {};

    return (
        <MantineTooltip label={`Connected to Gunbot at ${protocol}://${host}:${port}`} withArrow>
            <Group gap="xs">
                <ThemeIcon color="green" size={24} radius="xl">
                    <IconPlugConnected size={14} />
                </ThemeIcon>
                <Stack gap={0}>
                    <Text size="xs" fw={500} c="green.4">Connected</Text>
                    <Text size="xs" c="dimmed" lh={1.1}>{host}:${port}</Text>
                </Stack>
            </Group>
        </MantineTooltip>
    );
}

function SafeModal({ opened, onClose, size = 'lg', children }) {
  if (!opened) return null;
  const width =
    size === 'lg' ? 600 : size === 'md' ? 400 : size === 'sm' ? 320 : size;

  return (
    <Portal>
      <Overlay
        opacity={0.55}
        blur={2}
        fixed
        onClick={onClose}
        zIndex={MODAL_Z}
      />
      <Paper
        withBorder
        shadow="lg"
        radius="md"
        p="lg"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width,
          maxHeight: '80vh',
          overflowY: 'auto',
          overflowX: 'visible',
          zIndex: PANEL_Z,
          background: 'var(--mantine-color-body, #1A1B1E)',
        }}
      >
        {children}
      </Paper>
    </Portal>
  );
}

const fetchStrategies = async () => {
  const r = await fetch('/api/v1/strategies');
  if (!r.ok) throw new Error('Could not load strategies');
  return r.json();
};

const fetchGunbotConfig = async () => {
  const r = await fetch('/api/v1/gunbot/config');
  if (!r.ok) {
    const data = await r.json().catch(() => ({ detail: 'Bad JSON' }));
    throw new Error(data.detail || 'Could not load Gunbot config');
  }
  return r.json();
};

const addPairToGunbot = async (body) => {
  const r = await fetch('/api/v1/gunbot/pairs/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.detail || 'Failed to add pair');
  return data;
};

function AddPairModal({ opened, onClose, pairData, strategies, stratLoading, gbConfig, gbLoading, gbError }) {
  const qc = useQueryClient();

  const form = useForm({
    initialValues: {
      exchange: '',
      strategy_name: '',
      strategy_params: {},
      buy_enabled: true,
      sell_enabled: true,
      initial_capital: 1000,
      min_volume_to_sell: 10,
      start_time: new Date(),
    },
  });

  useEffect(() => {
    // This effect should ONLY run when the modal is opened.
    // It initializes the form state and then does nothing else, preserving user input.
    if (opened && pairData && strategies && gbConfig) {
      const targetStratKey = pairData.strategy_key || '';
      const meta = strategies.find((s) => s.value === targetStratKey);

      // Build a clean parameter object from the strategy definition (source of truth)
      const cleanParams = {};
      if (meta?.params_def) {
        // Iterate over the DEFINED params, not the incoming ones
        for (const key in meta.params_def) {
          // Check if the backtest result provided a value for this specific (correct) key
          if (pairData.parameters && pairData.parameters[key] !== undefined) {
            cleanParams[key] = pairData.parameters[key];
          } else {
            // Otherwise, use the default from the metadata
            cleanParams[key] = meta.params_def[key].default;
          }
        }
      }

      form.setValues({
        exchange: pairData.exchange || gbConfig.exchanges?.[0] || '',
        strategy_name: targetStratKey,
        strategy_params: cleanParams, // Use the new, clean object
        buy_enabled: true,
        sell_enabled: true,
        initial_capital: 1000,
        min_volume_to_sell: 10,
        start_time: new Date(),
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, pairData?.symbol]); // Depend on stable values, not the object reference.

  const stratMeta = useMemo(
    () => strategies?.find((s) => s.value === form.values.strategy_name),
    [strategies, form.values.strategy_name]
  );
  
  const gunbotPair = useMemo(() => {
    // More defensive calculation to prevent "N/A"
    if (!pairData?.symbol || !pairData?.quote_asset) return pairData?.symbol || 'N/A';
    const base = pairData.symbol.replace(pairData.quote_asset, '');
    return `${pairData.quote_asset}-${base}`;
  }, [pairData]);

  const onStratChange = (v) => {
    form.setFieldValue('strategy_name', v);
    const meta = strategies.find((s) => s.value === v);
    const params = {};
    if (meta?.params_def) {
      Object.entries(meta.params_def).forEach(([k, def]) => {
        params[k] = def.default;
      });
    }
    form.setFieldValue('strategy_params', params);
  };

  const mut = useMutation({
    mutationFn: addPairToGunbot,
    onSuccess: (d) => {
      notifications.show({
        title: 'Success',
        message: d.message,
        color: 'green',
        icon: <IconCheck />,
      });
      qc.invalidateQueries({ queryKey: ['gunbotTradingPairs'] });
      onClose();
    },
    onError: (e) =>
      notifications.show({
        title: 'Error Adding Pair',
        message: e.message,
        color: 'red',
      }),
  });

  const onSubmit = (v) => {
    if (!pairData.quote_asset || !pairData.symbol || !pairData.timeframe) {
      notifications.show({
        title: 'Error',
        message: 'Essential pair data (symbol, quote, timeframe) is missing.',
        color: 'red',
      });
      return;
    }
    mut.mutate({
      exchange: v.exchange,
      standard_pair: pairData.symbol,
      quote_asset: pairData.quote_asset,
      timeframe: pairData.timeframe, // Pass timeframe
      strategy_name: v.strategy_name,
      strategy_params: v.strategy_params, // Pass fully populated params
      buy_enabled: v.buy_enabled,
      sell_enabled: v.sell_enabled,
      stop_after_sell: v.stop_after_sell,
      initial_capital: v.initial_capital,
      min_volume_to_sell: v.min_volume_to_sell,
      start_time: v.start_time.getTime(),
    });
  };

  const body = (() => {
    if (stratLoading || (opened && gbLoading))
      return (
        <Center p="xl">
          <Loader />
        </Center>
      );

    if (gbError)
      return (
        <Alert
          color="red"
          icon={<IconAlertCircle />}
          title="Could not load Gunbot config"
        >
          {gbError.message}
        </Alert>
      );

    if (!strategies?.length)
      return (
        <Alert color="red" icon={<IconAlertCircle />}>
          Strategy list empty
        </Alert>
      );

    if (!gbConfig?.exchanges?.length)
      return (
        <Alert
          color="red"
          icon={<IconAlertCircle />}
          title="Invalid Gunbot configuration"
        >
          No exchanges found
        </Alert>
      );

    return (
      <form onSubmit={form.onSubmit(onSubmit)}>
        <Stack>
          <Alert variant="light" color="blue">
            This will add the pair as <Code>{gunbotPair}</Code> in Gunbot using the <Code>{pairData?.timeframe}</Code> timeframe.
          </Alert>
          <SimpleGrid cols={2}>
            <Select
              label="Gunbot Exchange"
              data={gbConfig.exchanges}
              searchable
              withinPortal
              portalProps={{ zIndex: DROPDOWN_Z }}
              popperProps={{ strategy: 'fixed' }}
              styles={{ dropdown: { zIndex: DROPDOWN_Z } }}
              {...form.getInputProps('exchange')}
            />
            <Select
              label="Strategy"
              data={strategies
                .filter((s) => !s.is_legacy || s.value === 'Dynamic_Momentum_Optimizer')
                .map((s) => ({ value: s.value, label: s.label }))}
              searchable
              withinPortal
              portalProps={{ zIndex: DROPDOWN_Z }}
              popperProps={{ strategy: 'fixed' }}
              styles={{ dropdown: { zIndex: DROPDOWN_Z } }}
              onChange={onStratChange}
              value={form.values.strategy_name}
            />
          </SimpleGrid>
          
          {stratMeta?.description && (
            <Alert variant="outline" color="gray" title="Strategy Logic" icon={<IconInfoCircle />}>
              <Text size="sm">{stratMeta.description}</Text>
            </Alert>
          )}

          <Divider my="sm" label="General Pair Settings" labelPosition="center" />
          <SimpleGrid cols={2} spacing="sm">
             <Switch label="Buy Enabled" {...form.getInputProps('buy_enabled', { type: 'checkbox' })} />
             <Switch label="Sell Enabled" {...form.getInputProps('sell_enabled', { type: 'checkbox' })} />
          </SimpleGrid>
          <SimpleGrid cols={2}>
              <NumberInput label="Initial Capital" {...form.getInputProps('initial_capital')} />
              <NumberInput label="Min Volume to Sell" {...form.getInputProps('min_volume_to_sell')} />
          </SimpleGrid>

          {stratMeta?.params_def && Object.keys(stratMeta.params_def).length > 0 && (
            <>
              <Divider my="sm" label="Strategy Parameters" labelPosition="center" />
              <SimpleGrid cols={2}>
                {Object.entries(stratMeta.params_def).map(([key, def]) => {
                  const descriptionParts = [];
                  if (def.description) {
                    descriptionParts.push(def.description);
                  }
                  
                  const rangeParts = [];
                  if (typeof def.min === 'number') {
                    rangeParts.push(`Min: ${def.min}`);
                  }
                  if (typeof def.max === 'number') {
                    rangeParts.push(`Max: ${def.max}`);
                  }
                  
                  if (rangeParts.length > 0) {
                    descriptionParts.push(`(${rangeParts.join(', ')})`);
                  }

                  return (
                    <NumberInput
                      key={key}
                      label={def.label}
                      description={descriptionParts.join(' ')}
                      min={def.min}
                      max={def.max}
                      step={def.step || 1}
                      allowDecimal={def.type === 'float'}
                      {...form.getInputProps(`strategy_params.${key}`)}
                    />
                  );
                })}
              </SimpleGrid>
            </>
          )}

          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={mut.isPending}
              disabled={!form.values.exchange || !form.values.strategy_name}
            >
              Add to Gunbot
            </Button>
          </Group>
        </Stack>
      </form>
    );
  })();

  return (
    <SafeModal opened={opened} onClose={onClose} size="lg">
      <Group justify="space-between" mb="md">
        <Title order={4}>Add {pairData?.symbol} to Gunbot</Title>
        <ActionIcon variant="subtle" onClick={onClose}>
          <IconX size={18} />
        </ActionIcon>
      </Group>
      {body}
    </SafeModal>
  );
}

const navLinks = [
  { icon: IconGauge, label: 'Dashboard', view: 'dashboard' },
  { icon: IconZoomCode, label: 'Market Screener', view: 'screener' },
  { icon: IconTestPipe, label: 'Backtest Lab', view: 'backtester' },
  { icon: IconRobot, label: 'Gunbot Tools', view: 'gunbot_connect' },
  { icon: IconReportAnalytics, label: 'Backtest History', view: 'history' },
  { icon: IconFileSearch, label: 'Screener History', view: 'screener_history' },
  { icon: IconTrophy, label: 'Discovery Results', view: 'discovery_result' },
];

function NavLink({ icon: Icon, label, active, onClick }) {
  return (
    <UnstyledButton
      onClick={onClick}
      data-active={active || undefined}
      style={(t) => ({
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        padding: t.spacing.xs,
        borderRadius: t.radius.sm,
        color: active ? t.colors.blue[6] : t.white,
        backgroundColor: active ? t.colors.dark[5] : 'transparent',
        '&:hover': { backgroundColor: t.colors.dark[6] },
      })}
    >
      <Icon style={{ width: 22, height: 22 }} stroke={1.5} />
      <Text size="sm" fw={500} style={{ marginLeft: 12 }}>
        {label}
      </Text>
    </UnstyledButton>
  );
}

function App() {
  const [view, setView] = useState('dashboard');
  const [resultId, setResultId] = useState(null);
  const [screenerId, setScreenerId] = useState(null);
  const [discId, setDiscId] = useState(null);

  const [modalOpen, { open: openModal, close: closeModal }] = useDisclosure(false);
  const [pair, setPair] = useState(null);

  // --- Data fetching hooks ---
  const { data: statusData } = useQuery({
    queryKey: ['gunbotStatus'],
    queryFn: async () => {
        const res = await fetch('/api/v1/gunbot/status');
        if (!res.ok) return { connected: false };
        return res.json();
    },
    refetchInterval: 30000,
  });
  const isConnected = statusData?.connected === true;

  const { data: strategies, isLoading: stratLoading } = useQuery({
    queryKey: ['strategies'],
    queryFn: fetchStrategies,
  });
  
  const { data: gbConfig, isLoading: gbLoading, error: gbError } = useQuery({
    queryKey: ['gunbotConfig'],
    queryFn: fetchGunbotConfig,
    retry: false,
    enabled: isConnected,
  });

  const handleAddPair = (dataFromReport) => {
    console.log("Data received by onAddPair:", JSON.stringify(dataFromReport, null, 2));

    const strategyKey = dataFromReport.base_strategy_name;
    const meta = strategies?.find(s => s.value === strategyKey);
    
    if (meta?.is_legacy && meta.value !== 'Dynamic_Momentum_Optimizer') {
      notifications.show({
        title: 'Strategy Not Addable',
        message: `${meta.label} is a legacy strategy and cannot be added directly.`,
        color: 'yellow',
        icon: <IconAlertCircle />,
      });
      return;
    }

    const cleanPairData = {
      symbol: dataFromReport.symbol,
      strategy_key: strategyKey,
      parameters: dataFromReport.parameters || {},
      quote_asset: dataFromReport.quote_asset,
      exchange: dataFromReport.exchange,
      timeframe: dataFromReport.timeframe,
    };
    setPair(cleanPairData);
    openModal();
  };

  const mainView = (() => {
    switch (view) {
      case 'dashboard':
        return (
          <Dashboard
            navigateToResult={(id) => {
              setResultId(id);
              setView('history');
            }}
            navigateToScreenerResult={(id) => {
              setScreenerId(id);
              setView('screener_history');
            }}
            navigateToView={setView}
          />
        );
      case 'screener':
        return <Screener onAddPair={handleAddPair} />;
      case 'backtester':
        return <Backtester onAddPair={handleAddPair} />;
      case 'history':
        return <ResultsViewer initialJobId={resultId} onAddPair={handleAddPair} />;
      case 'screener_history':
        return <ScreenerHistory initialJobId={screenerId} onAddPair={handleAddPair} />;
      case 'gunbot_connect':
        return (
          <GunbotConnect
            navigateToResult={(id) => {
              setResultId(id);
              setView('history');
            }}
            navigateToDiscoveryResult={(id) => {
              setDiscId(id);
              setView('discovery_result');
            }}
          />
        );
      case 'discovery_result':
        return (
          <DiscoveryResults
            initialJobId={discId}
            navigateToGunbotConnect={() => setView('gunbot_connect')}
            onAddPair={handleAddPair}
          />
        );
      default:
        return null;
    }
  })();

  const links = navLinks.map((link) => (
    <NavLink
      {...link}
      key={link.label}
      active={view === link.view}
      onClick={() => {
        if (link.view === 'discovery_result') setDiscId(null);
        setView(link.view);
      }}
    />
  ));

  return (
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <AddPairModal
        opened={modalOpen}
        onClose={closeModal}
        pairData={pair}
        strategies={strategies}
        stratLoading={stratLoading}
        gbConfig={gbConfig}
        gbLoading={gbLoading}
        gbError={gbError}
      />
      <AppShell
        navbar={{ width: 280, breakpoint: 'sm', collapsed: { mobile: false } }}
        padding="md"
        layout="alt"
      >
        <AppShell.Navbar p="md">
          <Stack justify="space-between" style={{ height: '100%' }}>
            <Stack>
              <Group>
                <IconHexagonLetterG type="mark" size={30} />
                <Title order={4}>Gunbot Quant</Title>
                <Code fw={700}>v1.2</Code>
              </Group>
              <Stack gap="sm" mt="xl">
                {links}
              </Stack>
            </Stack>
            <Paper withBorder p="xs" radius="md" bg="dark.8">
              <GunbotStatus />
            </Paper>
          </Stack>
        </AppShell.Navbar>
        <AppShell.Main style={{ minWidth: '100vw' }}>{mainView}</AppShell.Main>
      </AppShell>
    </MantineProvider>
  );
}

export default App;
```


## ./gunbot_quant/frontend/src/DiscoveryResults.jsx
```
/* eslint react/prop-types: 0 */
import { useState, useEffect, useMemo } from 'react';
import {
  Title, Paper, Alert, Center, Text, Grid, Stack, useMantineTheme, Group,
  Card, SimpleGrid, Code, Divider, Button, Select, ActionIcon, Tooltip as MantineTooltip,
  ThemeIcon,
} from '@mantine/core';
import { IconAlertTriangle, IconTrophy, IconInfoCircle, IconChartAreaLine, IconPlus } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { DataTable } from 'mantine-datatable';
import ResultsSkeleton from './ResultsSkeleton';
import dayjs from 'dayjs';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

// --- Re-usable components copied from ResultsDisplay for consistency ---
const StatTile = ({ label, value, color, suffix = '' }) => (
    <Paper withBorder p="xs" radius="md" style={{ background: 'transparent', borderColor: '#2a2a2a' }}>
        <Text size="xs" c="dimmed">{label}</Text>
        <Text size="lg" c={color} fw={600}>
            {typeof value === 'number' && !Number.isNaN(value) ? value.toFixed(2) : (value ?? '--')}
            {suffix}
        </Text>
    </Paper>
);

const CustomEquityTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    const strategyData = payload.find(p => p.dataKey === 'equity_strategy');
    const bhData = payload.find(p => p.dataKey === 'equity_buy_and_hold');
    return (
      <Paper withBorder shadow="md" radius="md" p="sm" style={{ backgroundColor: 'rgba(26, 27, 30, 0.85)' }}>
        <Text size="sm" mb={4}>{dayjs(label).format('MMM D, YYYY')}</Text>
        {bhData && <Text size="xs" c="white">{`Buy & Hold : $${(bhData.value).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`}</Text>}
        {strategyData && <Text size="xs" c="green">{`Strategy : $${(strategyData.value).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`}</Text>}
      </Paper>
    );
  }
  return null;
};

const EquityChart = ({ data, theme }) => {
  const { strategy, buy_and_hold } = data || {};
  if (!strategy || strategy.length < 2) {
    return <Center h={300}><Text c="dimmed">Not enough data to render chart.</Text></Center>;
  }

  const combinedData = useMemo(() => {
    const strategyMap = new Map(strategy.map(d => [d.date, d.value]));
    const bhMap = new Map((buy_and_hold || []).map(d => [d.date, d.value]));
    const allDates = [...new Set([...strategy.map(d => d.date), ...(buy_and_hold || []).map(d => d.date)])].sort();
    return allDates.map(date => ({
      date,
      equity_strategy: strategyMap.get(date),
      equity_buy_and_hold: bhMap.get(date),
    }));
  }, [strategy, buy_and_hold]);

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={combinedData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <defs>
          <linearGradient id="colorStrategy" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={theme.colors.green[5]} stopOpacity={0.8} /><stop offset="95%" stopColor={theme.colors.green[5]} stopOpacity={0.1} /></linearGradient>
          <linearGradient id="colorBH" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={theme.colors.gray[6]} stopOpacity={0.4} /><stop offset="95%" stopColor={theme.colors.gray[6]} stopOpacity={0.05} /></linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={theme.colors.dark[3]} />
        <XAxis dataKey="date" tickFormatter={(d) => dayjs(d).format('MMM D')} tick={{ fill: theme.colors.gray[5], fontSize: 12 }} stroke={theme.colors.dark[3]} />
        <YAxis tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} domain={['dataMin', 'auto']} allowDataOverflow={false} tick={{ fill: theme.colors.gray[5], fontSize: 12 }} stroke={theme.colors.dark[3]} />
        <Tooltip content={<CustomEquityTooltip />} />
        <Area type="monotone" dataKey="equity_buy_and_hold" stroke={theme.colors.gray[5]} strokeWidth={1.5} fillOpacity={1} fill="url(#colorBH)" isAnimationActive={false} connectNulls />
        <Area type="monotone" dataKey="equity_strategy" stroke={theme.colors.green[4]} strokeWidth={2} fillOpacity={1} fill="url(#colorStrategy)" isAnimationActive={false} connectNulls />
      </AreaChart>
    </ResponsiveContainer>
  );
};

const renderNumeric = (value, colorPositive = 'teal', colorNegative = 'red', suffix = '') => {
  if (value === Infinity) return <Text c="green" size="sm" ta="right">∞</Text>;
  const num = value ?? 0;
  return <Text c={num >= 0 ? colorPositive : colorNegative} size="sm" ta="right" fw={500}>{num.toFixed(2)}{suffix}</Text>;
};

const fetchGunbotStatus = async () => {
    const res = await fetch('/api/v1/gunbot/status');
    if (!res.ok) throw new Error('Network response was not ok');
    return res.json();
};

export default function DiscoveryResults({ initialJobId, navigateToGunbotConnect, onAddPair }) {
    const theme = useMantineTheme();
    const [jobList, setJobList] = useState([]);
    const [selectedJobId, setSelectedJobId] = useState(initialJobId || null);
    const [loadingList, setLoadingList] = useState(true);
    const [loadingReport, setLoadingReport] = useState(false);
    const [report, setReport] = useState(null);
    const [error, setError] = useState(null);
    const [selectedTestId, setSelectedTestId] = useState(null);
    const [sortStatus, setSortStatus] = useState({ columnAccessor: 'rank', direction: 'asc' });
    
    const { data: gunbotStatus } = useQuery({ queryKey: ['gunbotStatus'], queryFn: fetchGunbotStatus });
    const isGunbotConnected = gunbotStatus?.connected === true;

    useEffect(() => {
        const fetchJobList = async () => {
          setLoadingList(true);
          try {
            const response = await fetch('/api/v1/gunbot/discovery/results');
            if (!response.ok) throw new Error('Failed to fetch discovery result list');
            setJobList(await response.json());
          } catch (err) {
            setError(err.message);
          } finally {
            setLoadingList(false);
          }
        };
        fetchJobList();
      }, []);

    useEffect(() => {
        if (initialJobId) {
            setSelectedJobId(initialJobId);
        }
    }, [initialJobId]);


    useEffect(() => {
        if (selectedJobId) {
            const fetchReport = async () => {
                setLoadingReport(true); 
                setReport(null); 
                setError(null);
                try {
                    const response = await fetch(`/api/v1/backtest/results/${selectedJobId}`);
                    if (!response.ok) throw new Error(`Failed to fetch report for ${selectedJobId}`);
                    setReport(await response.json());
                } catch (err) { setError(err.message); } finally { setLoadingReport(false); }
            };
            fetchReport();
        }
    }, [selectedJobId]);

    const { activePairTest, sortedCandidates } = useMemo(() => {
        if (!report?.individual_tests) return { activePairTest: null, sortedCandidates: [] };

        const activePairTest = report.individual_tests.find(t => t.is_active_pair);
        
        // --- THIS IS THE FIX ---
        // The candidate list IS the list of full test data objects. No more mapping/flattening.
        const candidates = report.individual_tests.filter(t => !t.is_active_pair);

        // First sort by Sharpe to assign rank
        const ranked = [...candidates].sort((a, b) => (b.stats['Sharpe Ratio (ann.)'] ?? -Infinity) - (a.stats['Sharpe Ratio (ann.)'] ?? -Infinity))
            .map((c, i) => ({ ...c, rank: i + 1 }));

        // Then apply the user's interactive sorting
        const { columnAccessor, direction } = sortStatus;
        ranked.sort((a, b) => {
            let valA, valB;
            // Check if sorting by a top-level property or a nested stat
            if (['symbol', 'strategy_name', 'rank'].includes(columnAccessor)) {
                valA = a[columnAccessor];
                valB = b[columnAccessor];
            } else {
                valA = a.stats[columnAccessor];
                valB = b.stats[columnAccessor];
            }
            valA = valA ?? -Infinity;
            valB = valB ?? -Infinity;

            if (typeof valA === 'string') return direction === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
            return direction === 'asc' ? valA - valB : valB - valA;
        });

        return { activePairTest, sortedCandidates: ranked };
    }, [report, sortStatus]);
    
    const selectedCandidate = useMemo(() => {
        return sortedCandidates.find(c => c.test_id === selectedTestId);
    }, [sortedCandidates, selectedTestId]);

    if (loadingReport) return <ResultsSkeleton />;
    if (error) return <Alert title="Error" color="red" icon={<IconAlertTriangle />}>{error}</Alert>;
    
    const analysisPeriod = report ? `from ${report.config.BACKTEST_START_DATE} to ${report.config.BACKTEST_END_DATE}` : '';
    const gunbotWarning = report?.config?.gunbot_warning;

    return (
        <Stack gap="xl">
            <Title order={2}>Discovery Results</Title>
            
            <Paper withBorder p="md" radius="md">
                <Select
                    label="Select a Saved Discovery or Benchmark Report"
                    placeholder={loadingList ? "Loading reports..." : "Choose a run"}
                    data={jobList}
                    value={selectedJobId}
                    onChange={(val) => {
                        setSelectedJobId(val);
                        setSelectedTestId(null); // Reset detail view when changing report
                    }}
                    disabled={loadingList}
                    searchable
                />
            </Paper>

            {!selectedJobId && (
                 <Center h={400}>
                    <Stack align="center" spacing="md">
                        <IconTrophy size={60} stroke={1.5} color={theme.colors.gray[6]} />
                        <Title order={3} ta="center">Select a Report</Title>
                        <Text c="dimmed" ta="center">
                            Choose a previous "Find Better Pair" or "Benchmark" run from the dropdown.
                            <br />
                            If the list is empty, you can start a new run from the Gunbot Tools page.
                        </Text>
                        {jobList.length === 0 && !loadingList && (
                             <Button mt="md" onClick={navigateToGunbotConnect} variant="light">Go to Gunbot Tools</Button>
                        )}
                    </Stack>
                </Center>
            )}

            {report && activePairTest && (
                <>
                {gunbotWarning && (
                    <Alert icon={<IconInfoCircle size="1rem" />} title="Note on Exchange Mapping" color="yellow" variant="light" radius="md">
                        {gunbotWarning}
                    </Alert>
                )}
                
                <Paper withBorder p="md" radius="md" bg="dark.7">
                    <Group>
                        <ThemeIcon variant="light" color="blue" size={36} radius="md">
                            <IconInfoCircle size={20} />
                        </ThemeIcon>
                        <div>
                            <Text fw={500}>Historical Analysis for {activePairTest?.symbol}</Text>
                            <Text size="sm" c="dimmed">
                                This report benchmarks your active pair against alternatives from {analysisPeriod}, using a collection of trading strategies.
                            </Text>
                        </div>
                    </Group>
                </Paper>
                
                <Grid gutter="xl">
                    <Grid.Col span={{ base: 12, lg: 5 }}>
                        <Card withBorder p="lg" radius="md" h="100%">
                            <Title order={4} mb="md">Baseline: Active Pair (Live Performance)</Title>
                            <SimpleGrid cols={2}>
                                <StatTile label="Total Return" value={activePairTest.stats['Total Return %']} suffix="%" color={activePairTest.stats['Total Return %'] > 0 ? 'green' : 'red'} />
                                <StatTile label="Sharpe Ratio" value={activePairTest.stats['Sharpe Ratio (ann.)']} color="cyan" />
                                <StatTile label="Max Drawdown" value={activePairTest.stats['Max Drawdown %']} suffix="%" color="orange" />
                                <StatTile label="Profit Factor" value={activePairTest.stats['Profit Factor']} color="grape" />
                            </SimpleGrid>
                            <Divider my="md" label="Strategy & Duration" labelPosition="center" />
                            <Group justify="space-between">
                                <Text size="sm" c="dimmed">Name</Text><Code>{activePairTest.parameters.strategy}</Code>
                            </Group>
                            <Group justify="space-between" mt="xs">
                                <Text size="sm" c="dimmed">Live Duration</Text><Text fw={500}>{activePairTest.stats['Duration (days)']} days</Text>
                            </Group>
                            <Group justify="space-between" mt="xs">
                                <Text size="sm" c="dimmed">Total Trades</Text><Text fw={500}>{activePairTest.stats['Total Trades']}</Text>
                            </Group>
                        </Card>
                    </Grid.Col>
                    <Grid.Col span={{ base: 12, lg: 7 }}>
                        {selectedCandidate ? (
                            <Card withBorder p="lg" radius="md" h="100%">
                                <Title order={4} mb="md">Potential Performance: {selectedCandidate.symbol} with {selectedCandidate.strategy_name}</Title>
                                <EquityChart data={selectedCandidate.equity_curve} theme={theme} />
                            </Card>
                        ) : (
                            <Card withBorder p="lg" radius="md" h="100%">
                            <Center h="100%">
                                    <Stack align="center">
                                        <IconChartAreaLine size={48} stroke={1.5} color={theme.colors.gray[6]} />
                                        <Title order={4} c="dimmed">Select a Pair</Title>
                                        <Text c="dimmed">Click a row in the table below to see its performance chart.</Text>
                                    </Stack>
                                </Center>
                            </Card>
                        )}
                    </Grid.Col>
                </Grid>

                <Paper withBorder p="lg" radius="md">
                    <Group mb="md">
                        <IconTrophy size={24} color={theme.colors.yellow[6]} />
                        <Title order={4}>Top Discovered Alternatives</Title>
                    </Group>
                    <DataTable
                        minHeight={400}
                        withTableBorder borderRadius="sm" striped highlightOnHover
                        records={sortedCandidates} idAccessor="test_id"
                        rowClassName={({ test_id }) => test_id === selectedTestId ? 'mantine-datatable-row-highlight' : ''}
                        onRowClick={({ record }) => setSelectedTestId(record.test_id === selectedTestId ? null : record.test_id)}
                        sortStatus={sortStatus} onSortStatusChange={setSortStatus}
                        columns={[
                            { accessor: 'rank', title: 'Rank', textAlignment: 'center', width: 70, sortable: true },
                            { accessor: 'symbol', title: 'Symbol', width: 120, sortable: true },
                            { accessor: 'strategy_name', title: 'Best Strategy Found', render: ({ strategy_name }) => <Code>{strategy_name}</Code>, sortable: true },
                            { accessor: 'stats.Sharpe Ratio (ann.)', title: 'Sharpe', textAlignment: 'right', sortable: true, render: (r) => renderNumeric(r.stats['Sharpe Ratio (ann.)'], 'cyan') },
                            { accessor: 'stats.Total Return %', title: 'Return %', textAlignment: 'right', sortable: true, render: (r) => renderNumeric(r.stats['Total Return %'], 'teal', 'red', '%') },
                            { accessor: 'stats.Max Drawdown %', title: 'Max DD %', textAlignment: 'right', sortable: true, render: (r) => renderNumeric(r.stats['Max Drawdown %'], 'orange', 'orange', '%') },
                            { accessor: 'stats.Win Rate %', title: 'Win Rate %', textAlignment: 'right', sortable: true, render: (r) => renderNumeric(r.stats['Win Rate %'], 'blue', 'red', '%') },
                            { accessor: 'stats.Total Trades', title: 'Trades', textAlignment: 'right', sortable: true, render: (r) => r.stats['Total Trades']},
                            {
                                accessor: 'actions', title: 'Actions', textAlignment: 'right', width: 100,
                                render: (candidate) => {
                                    const tooltipLabel = isGunbotConnected ? `Deploy ${candidate.symbol} to Gunbot` : "Connect to Gunbot to add pairs";
                                    return (
                                        <MantineTooltip label={tooltipLabel} withArrow>
                                            <ActionIcon disabled={!isGunbotConnected} onClick={(e) => { e.stopPropagation(); if (onAddPair) onAddPair(candidate); }}>
                                                <IconPlus size={16} />
                                            </ActionIcon>
                                        </MantineTooltip>
                                    );
                                },
                            },
                        ]}
                        noRecordsText="No alternative pairs could be benchmarked."
                    />
                </Paper>
                </>
            )}
        </Stack>
    );
}
```


## ./gunbot_quant/frontend/index.html
```
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/gq-logo.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Gunbot Quant: Market Screener & Backtester</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```


## ./gunbot_quant/frontend/vite.config.js
```
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    include: [
      '@mantine/core',
      '@mantine/hooks',
      '@mantine/dates',
      'mantine-datatable',
      '@mantine/notifications',
      '@tabler/icons-react',
      'recharts',
      'dayjs',
      'axios',
      '@tanstack/react-query'
    ],
  },
});
```


## ./gunbot_quant/strategies/__init__.py
```

```


## ./gunbot_quant/strategies/dynamic_momentum_optimizer.py
```
# gunbot_quant_tools/strategies/dynamic_momentum_optimizer.py

import numpy as np
import itertools
import random
from numba import njit, prange

@njit(parallel=True)
def _score_params_numba(fma_g, sma_g, atr_g, mult_g,
                           fma_a, sma_a, atr_a, close, start, end, trail_trigger_mult):
    scores = np.zeros(len(fma_g))
    for k in prange(len(fma_g)):
        fma, sma, atr = fma_a[k], sma_a[k], atr_a[k]
        gp, gl, in_pos, entry, stop = 0.0, 0.0, False, 0.0, 0.0
        for i in range(start + 1, end):
            if (np.isnan(fma[i]) or np.isnan(sma[i]) or np.isnan(fma[i-1])
                    or np.isnan(sma[i-1]) or np.isnan(atr[i])):
                continue
            
            gold, death = fma[i-1] < sma[i-1] and fma[i] > sma[i], fma[i-1] > sma[i-1] and fma[i] < sma[i]
            
            price = close[i]
            if not in_pos and gold:
                in_pos, entry = True, price
                stop = entry - atr[i] * mult_g[k]
            elif in_pos:
                if price - entry > atr[i] * mult_g[k] * trail_trigger_mult:
                    new_stop = price - atr[i] * mult_g[k]
                    if new_stop > stop: stop = new_stop
                if price < stop or death:
                    pnl = (price - entry) / entry
                    if pnl > 0: gp += pnl
                    else: gl -= pnl
                    in_pos = False
        scores[k] = gp / gl if gl > 0 else (gp * 1_000 if gp > 0 else 0.0)
    return scores

class DynamicMomentumOptimizer:
    """
    This is a complex, stateful strategy with its own
    optimization loop, which doesn't fit the generic BaseStrategy interface.
    It periodically re-optimizes its parameters based on recent performance.
    """
    def __init__(self, config: dict):
        self.config = config
        # The key used in the backtest engine must match this name
        self.name = "Dynamic_Momentum_Optimizer"
        self.indicators = {} 
        self.best_params_memory = []

        # Build the parameter grid from config
        self.grid = [p for p in itertools.product(
            config['FAST_MA_PERIODS'], config['SLOW_MA_PERIODS'],
            config['ATR_PERIODS'], config['ATR_MULTIPLIERS']) if p[0] < p[1]]

        if self.grid:
            self.fma_g, self.sma_g, self.atr_g, self.mult_g = (np.array(t) for t in zip(*self.grid))
        else:
            self.fma_g, self.sma_g, self.atr_g, self.mult_g = ([], [], [], [])
        
    def set_indicators(self, indicators: dict):
        self.indicators = indicators
        # Re-map legacy STD to ATR for consistency in backtest engine
        for p in self.config['ATR_PERIODS']:
            if f'std_{p}' in self.indicators:
                self.indicators[f'atr_{p}'] = self.indicators[f'std_{p}']

    def optimize(self, i: int, close: np.ndarray, optimizer_arrays: tuple):
        cfg = self.config
        fma_a, sma_a, atr_a = optimizer_arrays

        scores = _score_params_numba(
            self.fma_g, self.sma_g, self.atr_g, self.mult_g,
            fma_a, sma_a, atr_a, close,
            i - cfg['OPTIMIZATION_LOOKBACK'], i, cfg['TRAIL_TRIGGER_MULT']
        )
        ordered_indices = np.argsort(scores)[::-1]

        self.best_params_memory = [
            (self.fma_g[j], self.sma_g[j], self.atr_g[j], self.mult_g[j], scores[j])
            for j in ordered_indices if scores[j] >= cfg['CONFIDENCE_THRESHOLD']
        ][:cfg['TOP_PARAM_MEMORY']]

        # Fallback if no params meet the confidence threshold
        if not self.best_params_memory and len(ordered_indices) > 0:
            j = ordered_indices[0]
            self.best_params_memory = [(self.fma_g[j], self.sma_g[j], self.atr_g[j], self.mult_g[j], scores[j])]

    def get_entry_signal(self, i: int):
        chosen_params = None
        # Try to find a valid entry from the best learned parameters
        if self.best_params_memory:
            for fma, sma, atr_len, mult, _ in self.best_params_memory:
                # Original logic used slope of SMA
                fcol, scol = self.indicators[f'slope_{fma}'], self.indicators[f'slope_{sma}']
                if np.isnan(fcol[i]) or np.isnan(scol[i]) or np.isnan(fcol[i-1]) or np.isnan(scol[i-1]):
                    continue
                if fcol[i-1] < scol[i-1] and fcol[i] > scol[i]:
                    chosen_params = (fma, sma, atr_len, mult)
                    break

        # Exploration: occasionally try a random parameter set
        if chosen_params is None and random.random() < self.config.get('EXPLORATION_RATE', 0.01):
            chosen_params = random.choice(self.grid) if self.grid else None

        return chosen_params

    def get_exit_signal(self, i: int, price: float, position: dict):
        params = position.get('params')
        if not params: return "Error" # Should not happen
        
        fma, sma, _, _ = params
        # Original logic used slope of SMA
        fcol, scol = self.indicators[f'slope_{fma}'], self.indicators[f'slope_{sma}']

        # --- THE FIX ---
        # Check for the primary, strategy-based exit signal FIRST.
        if fcol[i-1] > scol[i-1] and fcol[i] < scol[i]:
            return "Signal Cross"
        
        # If no primary signal, then check for the protective stop loss.
        if price < position.get('stop', price + 1):
            return "Stop Loss"
            
        return None

    def update_trailing_stop(self, i: int, price: float, position: dict):
        cfg = self.config
        params = position.get('params')
        if not params: return position
        
        _, _, atr_len, mult = params

        # The "ATR" for the legacy strategy is actually standard deviation
        atr_array = self.indicators.get(f'atr_{atr_len}')
        
        if atr_array is not None and i < len(atr_array):
            atr_val = atr_array[i]
            if not np.isnan(atr_val):
                if price - position['entry'] > atr_val * mult * cfg['TRAIL_TRIGGER_MULT']:
                    new_stop = price - atr_val * mult
                    if new_stop > position.get('stop', 0):
                        position['stop'] = new_stop
        return position
```


## ./gunbot_quant/strategies/strategy_library.py
```
# gunbot_quant_tools/strategies/strategy_library.py

import numpy as np
import pandas as pd
from .base_strategy import BaseStrategy

# --- HELPER FUNCTIONS ---
def _atr_stop(indicators: dict, i: int, entry_price: float, atr_period: int, atr_mult: float) -> float:
    atr_key = f"atr_{atr_period}"
    if atr_key in indicators and not np.isnan(indicators[atr_key][i]):
        return entry_price - (indicators[atr_key][i] * atr_mult)
    return entry_price * 0.95

# ==============================================================================
# --- DYNAMIC GRID STRATEGY ---
# ==============================================================================
class GridStrategy(BaseStrategy):
    """A market-neutral floating grid strategy that profits from volatility."""

    def get_required_indicators(self) -> dict:
        return {} # Price action only

    def init_continuous_backtest(self, initial_capital: float, start_index: int, data: pd.DataFrame):
        start_price = data['close'].iloc[start_index - 1]

        # --- State Initialization ---
        self.base_asset_qty = (initial_capital / 2) / start_price
        self.cash = initial_capital / 2
        self.equity_curve = []
        self.trades = []
        
        # --- Data & Params ---
        self.data = data
        self.ts = data['ts'].to_numpy()
        self.high = data['high'].to_numpy(dtype=np.float64)
        self.low = data['low'].to_numpy(dtype=np.float64)
        self.close = data['close'].to_numpy(dtype=np.float64)
        
        p = self.params
        self.grid_spacing_factor = 1 + (p['GQ_GRID_GRID_SPACING_PCT'] / 100.0)
        # Backtest logic: use initial capital to determine step size
        self.quote_qty_per_grid = p['INITIAL_CAPITAL'] / p['GQ_GRID_MAX_GRIDS']
        self.max_grids = p['GQ_GRID_MAX_GRIDS']

        # --- Grid Setup ---
        self.buy_orders = {}  # {price_level: True}
        self.sell_orders = {} # {price_level: True}
        
        num_buy_side_grids = self.max_grids // 2
        num_sell_side_grids = self.max_grids - num_buy_side_grids
        
        # Set initial buy orders below start price
        current_price = start_price / self.grid_spacing_factor
        for _ in range(num_buy_side_grids):
            self.buy_orders[current_price] = True
            current_price /= self.grid_spacing_factor
        
        # Set initial sell orders above start price
        current_price = start_price * self.grid_spacing_factor
        for _ in range(num_sell_side_grids):
            self.sell_orders[current_price] = True
            current_price *= self.grid_spacing_factor

        initial_equity = self.cash + (self.base_asset_qty * start_price)
        self.equity_curve.append({'ts': self.ts[start_index - 1], 'equity': initial_equity})

    def process_candle(self, i: int):
        candle_low, candle_high = self.low[i], self.high[i]
        
        # --- Process Buys ---
        filled_buys = {level for level in self.buy_orders if candle_low <= level}
        for level in sorted(list(filled_buys), reverse=True): # Higher prices first
            if self.cash < self.quote_qty_per_grid: continue

            base_qty_to_buy = self.quote_qty_per_grid / level
            self.cash -= self.quote_qty_per_grid
            self.base_asset_qty += base_qty_to_buy
            
            del self.buy_orders[level]
            self.sell_orders[level * self.grid_spacing_factor] = True
            
            if self.buy_orders:
                lowest_buy = min(self.buy_orders.keys())
                self.buy_orders[lowest_buy / self.grid_spacing_factor] = True

        # --- Process Sells ---
        filled_sells = {level for level in self.sell_orders if candle_high >= level}
        for level in sorted(list(filled_sells)): # Lower prices first
            buy_price = level / self.grid_spacing_factor
            base_qty_to_sell = self.quote_qty_per_grid / buy_price
            
            if self.base_asset_qty < base_qty_to_sell: continue
                
            self.cash += level * base_qty_to_sell
            self.base_asset_qty -= base_qty_to_sell
            
            pnl_value = (level - buy_price) * base_qty_to_sell
            pnl_pct = (pnl_value / (self.quote_qty_per_grid)) * 100

            self.trades.append({
                'exit_time': self.ts[i], 'entry_time': 'N/A',
                'exit_price': level, 'entry_price': buy_price,
                'pnl_value': pnl_value, 'pnl_percent': pnl_pct, 'exit_reason': 'Grid Pair Closed',
            })
            
            del self.sell_orders[level]
            self.buy_orders[level / self.grid_spacing_factor] = True
            
            if self.sell_orders:
                highest_sell = max(self.sell_orders.keys())
                self.sell_orders[highest_sell * self.grid_spacing_factor] = True

        current_equity = self.cash + (self.base_asset_qty * self.close[i])
        self.equity_curve.append({'ts': self.ts[i], 'equity': current_equity})

    def get_continuous_results(self) -> tuple[pd.DataFrame, pd.Series]:
        trades_df = pd.DataFrame(self.trades)
        if not self.equity_curve: return trades_df, pd.Series(dtype=float)

        equity_df = pd.DataFrame(self.equity_curve).drop_duplicates(subset='ts').set_index('ts')
        return trades_df, equity_df['equity']

# ==============================================================================
# --- STRATEGY IMPLEMENTATIONS ---
# ==============================================================================
class RsiReversion(BaseStrategy):
    def get_required_indicators(self) -> dict: return {'rsi': [self.params['GQ_RSI_REVERSION_PERIOD']], 'atr': [self.params['GQ_RSI_REVERSION_ATR_PERIOD']]}
    def get_entry_signal(self, i: int) -> bool: return self.indicators[f"rsi_{self.params['GQ_RSI_REVERSION_PERIOD']}"][i] < self.params['GQ_RSI_REVERSION_OVERSOLD']
    def get_exit_signal(self, i: int, position: dict) -> str | None: return "RSI Overbought" if self.indicators[f"rsi_{self.params['GQ_RSI_REVERSION_PERIOD']}"][i] > self.params['GQ_RSI_REVERSION_OVERBOUGHT'] else None
    def get_stop_loss_price(self, i: int, entry_price: float) -> float: return _atr_stop(self.indicators, i, entry_price, self.params['GQ_RSI_REVERSION_ATR_PERIOD'], self.params['GQ_RSI_REVERSION_ATR_MULT'])

class BbReversion(BaseStrategy):
    def get_required_indicators(self) -> dict: p = self.params; return {'bbands': [{'period': p['GQ_BB_REVERSION_PERIOD'], 'std_dev': p['GQ_BB_REVERSION_STD_DEV']}], 'atr': [p['GQ_BB_REVERSION_ATR_PERIOD']]}
    def get_entry_signal(self, i: int) -> bool: key = f"bbands_{self.params['GQ_BB_REVERSION_PERIOD']}_{self.params['GQ_BB_REVERSION_STD_DEV']}"; lower_band = self.indicators[f"{key}_lower"]; close = self.indicators['close']; return close[i-1] > lower_band[i-1] and close[i] < lower_band[i]
    def get_exit_signal(self, i: int, position: dict) -> str | None: key = f"bbands_{self.params['GQ_BB_REVERSION_PERIOD']}_{self.params['GQ_BB_REVERSION_STD_DEV']}"; middle_band = self.indicators[f"{key}_middle"]; return "Crossed middle band" if self.indicators['close'][i] > middle_band[i] else None
    def get_stop_loss_price(self, i: int, entry_price: float) -> float: return _atr_stop(self.indicators, i, entry_price, self.params['GQ_BB_REVERSION_ATR_PERIOD'], self.params['GQ_BB_REVERSION_ATR_MULT'])

class StochasticReversion(BaseStrategy):
    def get_required_indicators(self) -> dict: p = self.params; return {'stoch': [{'k_period': p['GQ_STOCHASTIC_REVERSION_K'], 'd_period': p['GQ_STOCHASTIC_REVERSION_D'], 'slowing': p['GQ_STOCHASTIC_REVERSION_SLOWING']}], 'atr': [p['GQ_STOCHASTIC_REVERSION_ATR_PERIOD']]}
    def get_entry_signal(self, i: int) -> bool: key = f"stoch_{self.params['GQ_STOCHASTIC_REVERSION_K']}_{self.params['GQ_STOCHASTIC_REVERSION_D']}_{self.params['GQ_STOCHASTIC_REVERSION_SLOWING']}"; k_line = self.indicators[f"{key}_k"]; return k_line[i] < self.params['GQ_STOCHASTIC_REVERSION_OVERSOLD'] and k_line[i-1] >= self.params['GQ_STOCHASTIC_REVERSION_OVERSOLD']
    def get_exit_signal(self, i: int, position: dict) -> str | None: key = f"stoch_{self.params['GQ_STOCHASTIC_REVERSION_K']}_{self.params['GQ_STOCHASTIC_REVERSION_D']}_{self.params['GQ_STOCHASTIC_REVERSION_SLOWING']}"; k_line = self.indicators[f"{key}_k"]; return "Stoch Overbought" if k_line[i] > self.params['GQ_STOCHASTIC_REVERSION_OVERBOUGHT'] else None
    def get_stop_loss_price(self, i: int, entry_price: float) -> float: return _atr_stop(self.indicators, i, entry_price, self.params['GQ_STOCHASTIC_REVERSION_ATR_PERIOD'], self.params['GQ_STOCHASTIC_REVERSION_ATR_MULT'])

class MacdCross(BaseStrategy):
    def get_required_indicators(self) -> dict: p = self.params; return {'macd': [{'fast_period': p['GQ_MACD_CROSS_FAST'], 'slow_period': p['GQ_MACD_CROSS_SLOW'], 'signal_period': p['GQ_MACD_CROSS_SIGNAL']}], 'atr': [p['GQ_MACD_CROSS_ATR_PERIOD']]}
    def get_entry_signal(self, i: int) -> bool: key = f"macd_{self.params['GQ_MACD_CROSS_FAST']}_{self.params['GQ_MACD_CROSS_SLOW']}_{self.params['GQ_MACD_CROSS_SIGNAL']}"; macd, signal = self.indicators[f'{key}_macd'], self.indicators[f'{key}_signal']; return macd[i-1] < signal[i-1] and macd[i] > signal[i]
    def get_exit_signal(self, i: int, position: dict) -> str | None: key = f"macd_{self.params['GQ_MACD_CROSS_FAST']}_{self.params['GQ_MACD_CROSS_SLOW']}_{self.params['GQ_MACD_CROSS_SIGNAL']}"; macd, signal = self.indicators[f'{key}_macd'], self.indicators[f'{key}_signal']; return "MACD Cross Down" if macd[i] < signal[i] else None
    def get_stop_loss_price(self, i: int, entry_price: float) -> float: return _atr_stop(self.indicators, i, entry_price, self.params['GQ_MACD_CROSS_ATR_PERIOD'], self.params['GQ_MACD_CROSS_ATR_MULT'])

class EMACross(BaseStrategy):
    def get_required_indicators(self) -> dict: p = self.params; return {'ema': [p['GQ_EMACROSS_FAST'], p['GQ_EMACROSS_SLOW']], 'atr': [p['GQ_EMACROSS_ATR_PERIOD']]}
    def get_entry_signal(self, i: int) -> bool: fast_ma = self.indicators[f"ema_{self.params['GQ_EMACROSS_FAST']}"]; slow_ma = self.indicators[f"ema_{self.params['GQ_EMACROSS_SLOW']}"]; return fast_ma[i-1] < slow_ma[i-1] and fast_ma[i] > slow_ma[i]
    def get_exit_signal(self, i: int, position: dict) -> str | None: fast_ma = self.indicators[f"ema_{self.params['GQ_EMACROSS_FAST']}"]; slow_ma = self.indicators[f"ema_{self.params['GQ_EMACROSS_SLOW']}"]; return "Death Cross (EMA)" if fast_ma[i] < slow_ma[i] else None
    def get_stop_loss_price(self, i: int, entry_price: float) -> float: return _atr_stop(self.indicators, i, entry_price, self.params['GQ_EMACROSS_ATR_PERIOD'], self.params['GQ_EMACROSS_ATR_MULT'])

class SupertrendFollower(BaseStrategy):
    def get_required_indicators(self) -> dict: p = self.params; return {'supertrend': [{'period': p['GQ_SUPERTREND_FOLLOWER_PERIOD'], 'multiplier': p['GQ_SUPERTREND_FOLLOWER_MULTIPLIER']}]}
    def get_entry_signal(self, i: int) -> bool: key = f"supertrend_{self.params['GQ_SUPERTREND_FOLLOWER_PERIOD']}_{self.params['GQ_SUPERTREND_FOLLOWER_MULTIPLIER']}"; st_dir = self.indicators[f'{key}_dir']; return st_dir[i-1] < 0 and st_dir[i] > 0
    def get_exit_signal(self, i: int, position: dict) -> str | None: key = f"supertrend_{self.params['GQ_SUPERTREND_FOLLOWER_PERIOD']}_{self.params['GQ_SUPERTREND_FOLLOWER_MULTIPLIER']}"; return "Supertrend flip" if self.indicators[f'{key}_dir'][i] < 0 else None
    def get_stop_loss_price(self, i: int, entry_price: float) -> float: key = f"supertrend_{self.params['GQ_SUPERTREND_FOLLOWER_PERIOD']}_{self.params['GQ_SUPERTREND_FOLLOWER_MULTIPLIER']}"; return self.indicators[f'{key}_line'][i]
    def update_trailing_stop(self, i: int, current_price: float, position: dict) -> dict: key = f"supertrend_{self.params['GQ_SUPERTREND_FOLLOWER_PERIOD']}_{self.params['GQ_SUPERTREND_FOLLOWER_MULTIPLIER']}"; new_stop = self.indicators[f'{key}_line'][i]; position['stop_price'] = max(position['stop_price'], new_stop); return position

class HeikinAshiTrend(BaseStrategy):
    def get_required_indicators(self) -> dict: return {'heikin_ashi': [True], 'atr': [14]}
    def get_entry_signal(self, i: int) -> bool: ha_open, ha_close = self.indicators['ha_open'], self.indicators['ha_close']; prev_candle_is_red = ha_close[i-1] < ha_open[i-1]; current_candle_is_green = ha_close[i] > ha_open[i]; return prev_candle_is_red and current_candle_is_green
    def get_exit_signal(self, i: int, position: dict) -> str | None: ha_open, ha_close = self.indicators['ha_open'], self.indicators['ha_close']; return "HA candle flipped red" if ha_close[i] < ha_open[i] else None
    def get_stop_loss_price(self, i: int, entry_price: float) -> float: return _atr_stop(self.indicators, i, entry_price, 14, 2.5)

class DonchianBreakout(BaseStrategy):
    def get_required_indicators(self) -> dict: return {'donchian': [self.params['GQ_DONCHIAN_BREAKOUT_PERIOD']], 'atr': [self.params['GQ_DONCHIAN_BREAKOUT_ATR_PERIOD']]}
    def get_entry_signal(self, i: int) -> bool: upper_band = self.indicators[f"donchian_{self.params['GQ_DONCHIAN_BREAKOUT_PERIOD']}_upper"]; return self.indicators['close'][i] > upper_band[i-1]
    def get_exit_signal(self, i: int, position: dict) -> str | None: middle_band = self.indicators[f"donchian_{self.params['GQ_DONCHIAN_BREAKOUT_PERIOD']}_middle"]; return "Crossed middle band" if self.indicators['close'][i] < middle_band[i] else None
    def get_stop_loss_price(self, i: int, entry_price: float) -> float: return _atr_stop(self.indicators, i, entry_price, self.params['GQ_DONCHIAN_BREAKOUT_ATR_PERIOD'], self.params['GQ_DONCHIAN_BREAKOUT_ATR_MULT'])

class KeltnerSqueezeBreakout(BaseStrategy):
    def get_required_indicators(self) -> dict: p = self.params; return {'bbands': [{'period': p['GQ_KELTNER_SQUEEZE_BREAKOUT_PERIOD'], 'std_dev': p['GQ_KELTNER_SQUEEZE_BREAKOUT_BB_STD']}], 'keltner_channels': [{'period': p['GQ_KELTNER_SQUEEZE_BREAKOUT_PERIOD'], 'multiplier': p['GQ_KELTNER_SQUEEZE_BREAKOUT_KC_MULT']}]}
    def get_entry_signal(self, i: int) -> bool: bb_key = f"bbands_{self.params['GQ_KELTNER_SQUEEZE_BREAKOUT_PERIOD']}_{self.params['GQ_KELTNER_SQUEEZE_BREAKOUT_BB_STD']}"; kc_key = f"kc_{self.params['GQ_KELTNER_SQUEEZE_BREAKOUT_PERIOD']}_{self.params['GQ_KELTNER_SQUEEZE_BREAKOUT_KC_MULT']}"; bb_lower, bb_upper = self.indicators[f'{bb_key}_lower'], self.indicators[f'{bb_key}_upper']; kc_lower, kc_upper = self.indicators[f'{kc_key}_lower'], self.indicators[f'{kc_key}_upper']; in_squeeze = bb_lower[i-1] > kc_lower[i-1] and bb_upper[i-1] < kc_upper[i-1]; breakout = self.indicators['close'][i] > bb_upper[i-1]; return in_squeeze and breakout
    def get_exit_signal(self, i: int, position: dict) -> str | None: bb_key = f"bbands_{self.params['GQ_KELTNER_SQUEEZE_BREAKOUT_PERIOD']}_{self.params['GQ_KELTNER_SQUEEZE_BREAKOUT_BB_STD']}"; middle_band = self.indicators[f"{bb_key}_middle"]; return "Price fell to middle BB" if self.indicators['close'][i] < middle_band[i] else None
    def get_stop_loss_price(self, i: int, entry_price: float) -> float: bb_key = f"bbands_{self.params['GQ_KELTNER_SQUEEZE_BREAKOUT_PERIOD']}_{self.params['GQ_KELTNER_SQUEEZE_BREAKOUT_BB_STD']}"; return self.indicators[f'{bb_key}_lower'][i]

class TrendFilterRSIEntry(BaseStrategy):
    def get_required_indicators(self) -> dict: p = self.params; return {'sma': [p['GQ_TREND_FILTER_RSI_ENTRY_FILTER_PERIOD']], 'rsi': [p['GQ_TREND_FILTER_RSI_ENTRY_RSI_PERIOD']], 'atr': [p['GQ_TREND_FILTER_RSI_ENTRY_ATR_PERIOD']]}
    def get_entry_signal(self, i: int) -> bool: close = self.indicators['close']; long_ma = self.indicators[f"sma_{self.params['GQ_TREND_FILTER_RSI_ENTRY_FILTER_PERIOD']}"]; rsi = self.indicators[f"rsi_{self.params['GQ_TREND_FILTER_RSI_ENTRY_RSI_PERIOD']}"]; in_uptrend = close[i] > long_ma[i]; is_dip = rsi[i] < self.params['GQ_TREND_FILTER_RSI_ENTRY_RSI_ENTRY'] and rsi[i-1] >= self.params['GQ_TREND_FILTER_RSI_ENTRY_RSI_ENTRY']; return in_uptrend and is_dip
    def get_exit_signal(self, i: int, position: dict) -> str | None: rsi = self.indicators[f"rsi_{self.params['GQ_TREND_FILTER_RSI_ENTRY_RSI_PERIOD']}"]; return "RSI exit level" if rsi[i] > self.params['GQ_TREND_FILTER_RSI_ENTRY_RSI_EXIT'] else None
    def get_stop_loss_price(self, i: int, entry_price: float) -> float: return _atr_stop(self.indicators, i, entry_price, self.params['GQ_TREND_FILTER_RSI_ENTRY_ATR_PERIOD'], self.params['GQ_TREND_FILTER_RSI_ENTRY_ATR_MULT'])

class RSIStochComboTP(BaseStrategy):
    def get_required_indicators(self) -> dict: p = self.params; return {'rsi': [p['GQ_RSI_STOCH_COMBO_TP_RSI_PERIOD']], 'stoch': [{'k_period': p['GQ_RSI_STOCH_COMBO_TP_K'], 'd_period': p['GQ_RSI_STOCH_COMBO_TP_D'], 'slowing': p['GQ_RSI_STOCH_COMBO_TP_SLOWING']}], 'atr': [p['GQ_RSI_STOCH_COMBO_TP_ATR_PERIOD']]}
    def get_entry_signal(self, i: int) -> bool: rsi = self.indicators[f"rsi_{self.params['GQ_RSI_STOCH_COMBO_TP_RSI_PERIOD']}"][i]; stoch_key = f"stoch_{self.params['GQ_RSI_STOCH_COMBO_TP_K']}_{self.params['GQ_RSI_STOCH_COMBO_TP_D']}_{self.params['GQ_RSI_STOCH_COMBO_TP_SLOWING']}"; k_line = self.indicators[f"{stoch_key}_k"][i]; return rsi < self.params['GQ_RSI_STOCH_COMBO_TP_RSI_LEVEL'] and k_line < self.params['GQ_RSI_STOCH_COMBO_TP_STOCH_LEVEL']
    def get_exit_signal(self, i: int, position: dict) -> str | None: return None
    def get_stop_loss_price(self, i: int, entry_price: float) -> float: return _atr_stop(self.indicators, i, entry_price, self.params['GQ_RSI_STOCH_COMBO_TP_ATR_PERIOD'], self.params['GQ_RSI_STOCH_COMBO_TP_ATR_MULT'])
    def get_take_profit_price(self, i: int, position: dict) -> float | None: atr = self.indicators[f"atr_{self.params['GQ_RSI_STOCH_COMBO_TP_ATR_PERIOD']}"][i]; return position['entry_price'] + (atr * self.params['GQ_RSI_STOCH_COMBO_TP_TP_MULT']) if not np.isnan(atr) else None

class BollingerBandRide(BaseStrategy):
    def get_required_indicators(self) -> dict: p = self.params; return {'bbands': [{'period': p['GQ_BOLLINGER_BAND_RIDE_PERIOD'], 'std_dev': p['GQ_BOLLINGER_BAND_RIDE_STD_DEV']}]}
    def get_entry_signal(self, i: int) -> bool: key = f"bbands_{self.params['GQ_BOLLINGER_BAND_RIDE_PERIOD']}_{self.params['GQ_BOLLINGER_BAND_RIDE_STD_DEV']}"; upper = self.indicators[f'{key}_upper']; return self.indicators['close'][i-1] < upper[i-1] and self.indicators['close'][i] > upper[i]
    def get_exit_signal(self, i: int, position: dict) -> str | None: return None
    def get_stop_loss_price(self, i: int, entry_price: float) -> float: key = f"bbands_{self.params['GQ_BOLLINGER_BAND_RIDE_PERIOD']}_{self.params['GQ_BOLLINGER_BAND_RIDE_STD_DEV']}"; middle = self.indicators[f'{key}_middle'][i]; return min(entry_price * 0.95, middle)
    def update_trailing_stop(self, i: int, current_price: float, position: dict) -> dict: key = f"bbands_{self.params['GQ_BOLLINGER_BAND_RIDE_PERIOD']}_{self.params['GQ_BOLLINGER_BAND_RIDE_STD_DEV']}"; middle = self.indicators[f'{key}_middle'][i]; position['stop_price'] = max(position['stop_price'], middle); return position

# ==============================================================================
# --- STRATEGY FACTORY & METADATA (Source of Truth) ---
# ==============================================================================

STRATEGY_MAPPING = {
    "Bollinger_Band_Ride": {
        "class": BollingerBandRide, "category": "Trend Following", "fileName": "bollinger_band_ride.js",
        "description": "An aggressive trend-riding strategy. It enters when price breaks out of the upper Bollinger Band, signaling strong upward momentum, and holds the position as long as the price remains above the middle band.",
        "params_def": {
            'GQ_BOLLINGER_BAND_RIDE_PERIOD': {'label': 'Period', 'type': 'int', 'default': 20, 'min': 10, 'max': 100, 'description': "Period for BB and SMA."},
            'GQ_BOLLINGER_BAND_RIDE_STD_DEV': {'label': 'Standard Deviation', 'type': 'float', 'default': 2.0, 'min': 1.0, 'max': 3.0, 'step': 0.1, 'description': "Standard deviation for BB."},
        }
    },
    "RSI_Reversion": {
        "class": RsiReversion, "category": "Mean Reversion", "fileName": "rsi_reversion.js",
        "description": "A classic mean-reversion strategy. It buys when an asset is considered oversold and sells when it is considered overbought, based on the Relative Strength Index (RSI) indicator.",
        "params_def": {
            'GQ_RSI_REVERSION_PERIOD': {'label': 'RSI Period', 'type': 'int', 'default': 14, 'min': 2, 'max': 50, 'description': "The period for RSI calculation."},
            'GQ_RSI_REVERSION_OVERSOLD': {'label': 'Oversold Level', 'type': 'int', 'default': 30, 'min': 10, 'max': 40, 'description': "RSI level to trigger a buy."},
            'GQ_RSI_REVERSION_OVERBOUGHT': {'label': 'Overbought Level', 'type': 'int', 'default': 70, 'min': 60, 'max': 90, 'description': "RSI level to trigger a sell."},
            'GQ_RSI_REVERSION_ATR_PERIOD': {'label': 'ATR Period (SL)', 'type': 'int', 'default': 14, 'min': 5, 'max': 50, 'description': "The period for ATR (stop loss)."},
            'GQ_RSI_REVERSION_ATR_MULT': {'label': 'ATR Multiplier (SL)', 'type': 'float', 'default': 2.0, 'min': 1.0, 'max': 5.0, 'step': 0.1, 'description': "Multiplier for ATR stop loss."},
        }
    },
    "Heikin_Ashi_Trend": {
        "class": HeikinAshiTrend, "category": "Trend Following", "fileName": "heikin_ashi_trend.js",
        "description": "A trend-following strategy that uses smoothed Heikin Ashi (HA) candles to filter out market noise and identify the underlying trend.",
        "params_def": {}
    },
    "Trend_Filter_RSI_Entry": {
        "class": TrendFilterRSIEntry, "category": "Advanced & Hybrids", "fileName": "trend_filter_rsi_entry.js",
        "description": "A hybrid \"buy the dip\" strategy. It first confirms a long-term uptrend using a slow moving average, and then looks for short-term pullback opportunities using the RSI.",
        "params_def": {
            'GQ_TREND_FILTER_RSI_ENTRY_FILTER_PERIOD': {'label': 'Trend Filter SMA', 'type': 'int', 'default': 200, 'min': 50, 'max': 300, 'description': "The period for the trend filter SMA."},
            'GQ_TREND_FILTER_RSI_ENTRY_RSI_PERIOD': {'label': 'RSI Period', 'type': 'int', 'default': 14, 'min': 2, 'max': 50, 'description': "The period for RSI calculation."},
            'GQ_TREND_FILTER_RSI_ENTRY_RSI_ENTRY': {'label': 'RSI Entry Level', 'type': 'int', 'default': 40, 'min': 10, 'max': 50, 'description': "RSI level to trigger a buy."},
            'GQ_TREND_FILTER_RSI_ENTRY_RSI_EXIT': {'label': 'RSI Exit Level', 'type': 'int', 'default': 70, 'min': 60, 'max': 90, 'description': "RSI level to trigger a sell."},
            'GQ_TREND_FILTER_RSI_ENTRY_ATR_PERIOD': {'label': 'ATR Period (SL)', 'type': 'int', 'default': 14, 'min': 5, 'max': 50, 'description': "Period for ATR (stop loss)."},
            'GQ_TREND_FILTER_RSI_ENTRY_ATR_MULT': {'label': 'ATR Multiplier (SL)', 'type': 'float', 'default': 2.5, 'min': 1.0, 'max': 5.0, 'step': 0.1, 'description': "Multiplier for ATR stop loss."},
        }
    },
    "Keltner_Squeeze_Breakout": {
        "class": KeltnerSqueezeBreakout, "category": "Volatility / Breakout", "fileName": "keltner_squeeze_breakout.js",
        "description": "A volatility breakout strategy that identifies periods of low volatility (a 'squeeze') and buys when the price breaks out with momentum.",
        "params_def": {
            'GQ_KELTNER_SQUEEZE_BREAKOUT_PERIOD': {'label': 'Indicator Period', 'type': 'int', 'default': 20, 'min': 10, 'max': 50, 'description': "Period for BB and KC."},
            'GQ_KELTNER_SQUEEZE_BREAKOUT_BB_STD': {'label': 'BB StdDev', 'type': 'float', 'default': 2.0, 'min': 1.0, 'max': 3.0, 'step': 0.1, 'description': "Standard deviation for BB."},
            'GQ_KELTNER_SQUEEZE_BREAKOUT_KC_MULT': {'label': 'Keltner Multiplier', 'type': 'float', 'default': 1.5, 'min': 1.0, 'max': 3.0, 'step': 0.1, 'description': "ATR Multiplier for Keltner Channel."},
        }
    },
    "Supertrend_Follower": {
        "class": SupertrendFollower, "category": "Trend Following", "fileName": "supertrend_follower.js",
        "description": "A popular trend-following strategy that uses the Supertrend indicator to determine the current market trend and provide a dynamic stop loss.",
        "params_def": {
            'GQ_SUPERTREND_FOLLOWER_PERIOD': {'label': 'ATR Period', 'type': 'int', 'default': 10, 'min': 5, 'max': 30, 'description': "The ATR period for Supertrend."},
            'GQ_SUPERTREND_FOLLOWER_MULTIPLIER': {'label': 'ATR Multiplier', 'type': 'float', 'default': 3.0, 'min': 1.0, 'max': 5.0, 'step': 0.5, 'description': "The ATR multiplier for Supertrend."},
        }
    },
    "Dynamic_Momentum_Optimizer": {
        "is_legacy": True, "category": "Self-Optimizing", "fileName": "dynamic_momentum_optimizer.js",
        "description": "An advanced, self-optimizing strategy that does not use fixed parameters. It periodically re-optimizes its parameters based on recent market performance to adapt to changing conditions.",
        "params_def": {}
    },
    "Stochastic_Reversion": {
        "class": StochasticReversion, "category": "Mean Reversion", "fileName": "stochastic_reversion.js",
        "description": "A momentum-based mean-reversion strategy using the Stochastic Oscillator. It buys when momentum is considered oversold and sells when it is overbought.",
        "params_def": {
            'GQ_STOCHASTIC_REVERSION_K': {'label': 'Stoch %K', 'type': 'int', 'default': 14, 'min': 5, 'max': 50, 'description': "The period for the %K line."},
            'GQ_STOCHASTIC_REVERSION_D': {'label': 'Stoch %D', 'type': 'int', 'default': 3, 'min': 1, 'max': 20, 'description': "The period for the %D line."},
            'GQ_STOCHASTIC_REVERSION_SLOWING': {'label': 'Stoch Slowing', 'type': 'int', 'default': 3, 'min': 1, 'max': 20, 'description': "The slowing period for %K."},
            'GQ_STOCHASTIC_REVERSION_OVERSOLD': {'label': 'Oversold Level', 'type': 'int', 'default': 20, 'min': 10, 'max': 40, 'description': "Stochastic level to trigger a buy."},
            'GQ_STOCHASTIC_REVERSION_OVERBOUGHT': {'label': 'Overbought Level', 'type': 'int', 'default': 80, 'min': 60, 'max': 90, 'description': "Stochastic level to trigger a sell."},
            'GQ_STOCHASTIC_REVERSION_ATR_PERIOD': {'label': 'ATR Period (SL)', 'type': 'int', 'default': 14, 'min': 5, 'max': 50, 'description': "Period for ATR (stop loss)."},
            'GQ_STOCHASTIC_REVERSION_ATR_MULT': {'label': 'ATR Multiplier (SL)', 'type': 'float', 'default': 2.0, 'min': 1.0, 'max': 5.0, 'step': 0.1, 'description': "Multiplier for ATR stop loss."},
        }
    },
    "Grid_Strategy": {
        "class": GridStrategy, "is_continuous": True, "category": "Market Neutral", "fileName": "grid.js",
        "description": "A market-neutral floating grid strategy designed for multi-pair use with independent, per-pair compounding. It places a series of buy and sell limit orders to profit from volatility.",
        "params_def": {
            'INITIAL_CAPITAL': {'label': 'Initial Capital', 'type': 'float', 'default': 1000, 'min': 10, 'max': 100000, 'step': 100, 'description': "Capital allocated to this pair's grid."},
            'GQ_GRID_MAX_GRIDS': {'label': 'Max Active Grids', 'type': 'int', 'default': 20, 'min': 2, 'max': 100, 'description': "Total number of active buy/sell limit orders."},
            'GQ_GRID_GRID_SPACING_PCT': {'label': 'Grid Spacing (%)', 'type': 'float', 'default': 1.0, 'min': 0.1, 'max': 10, 'step': 0.1, 'description': "Spacing between grid levels as a percentage."},
        }
    },
    "MACD_Cross": {
        "class": MacdCross, "category": "Trend Following", "fileName": "macd_cross.js",
        "description": "A classic trend-following strategy that uses the Moving Average Convergence Divergence (MACD) indicator to identify changes in trend momentum.",
        "params_def": {
            'GQ_MACD_CROSS_FAST': {'label': 'Fast EMA', 'type': 'int', 'default': 12, 'min': 5, 'max': 50, 'description': "The fast EMA period for MACD."},
            'GQ_MACD_CROSS_SLOW': {'label': 'Slow EMA', 'type': 'int', 'default': 26, 'min': 20, 'max': 100, 'description': "The slow EMA period for MACD."},
            'GQ_MACD_CROSS_SIGNAL': {'label': 'Signal Line', 'type': 'int', 'default': 9, 'min': 3, 'max': 20, 'description': "The signal line EMA period."},
            'GQ_MACD_CROSS_ATR_PERIOD': {'label': 'ATR Period (SL)', 'type': 'int', 'default': 14, 'min': 5, 'max': 50, 'description': "Period for ATR (stop loss)."},
            'GQ_MACD_CROSS_ATR_MULT': {'label': 'ATR Multiplier (SL)', 'type': 'float', 'default': 3.0, 'min': 1.0, 'max': 6.0, 'step': 0.25, 'description': "Multiplier for ATR stop loss."},
        }
    },
    "Donchian_Breakout": {
        "class": DonchianBreakout, "category": "Volatility / Breakout", "fileName": "donchian_breakout.js",
        "description": "A classic breakout strategy, famously used by the 'Turtle Traders'. It aims to capture new trends by buying when the price breaks above its recent trading range.",
        "params_def": {
            'GQ_DONCHIAN_BREAKOUT_PERIOD': {'label': 'Channel Period', 'type': 'int', 'default': 20, 'min': 10, 'max': 100, 'description': "The Donchian Channel period."},
            'GQ_DONCHIAN_BREAKOUT_ATR_PERIOD': {'label': 'ATR Period (SL)', 'type': 'int', 'default': 14, 'min': 5, 'max': 50, 'description': "Period for ATR (stop loss)."},
            'GQ_DONCHIAN_BREAKOUT_ATR_MULT': {'label': 'ATR Multiplier (SL)', 'type': 'float', 'default': 2.0, 'min': 1.0, 'max': 5.0, 'step': 0.1, 'description': "Multiplier for ATR stop loss."},
        }
    },
    "EMACross": {
        "class": EMACross, "category": "Trend Following", "fileName": "emacross.js",
        "description": "A classic trend-following strategy using Exponential Moving Averages (EMAs). It identifies potential trend changes when a short-term EMA crosses a long-term EMA.",
        "params_def": {
            'GQ_EMACROSS_FAST': {'label': 'Fast EMA', 'type': 'int', 'default': 21, 'min': 5, 'max': 50, 'description': "The fast EMA period."},
            'GQ_EMACROSS_SLOW': {'label': 'Slow EMA', 'type': 'int', 'default': 55, 'min': 20, 'max': 200, 'description': "The slow EMA period."},
            'GQ_EMACROSS_ATR_PERIOD': {'label': 'ATR Period (SL)', 'type': 'int', 'default': 14, 'min': 5, 'max': 50, 'description': "Period for ATR (stop loss)."},
            'GQ_EMACROSS_ATR_MULT': {'label': 'ATR Multiplier (SL)', 'type': 'float', 'default': 3.0, 'min': 1.0, 'max': 6.0, 'step': 0.25, 'description': "Multiplier for ATR stop loss."},
        }
    },
    "RSI_Stoch_Combo_TP": {
        "class": RSIStochComboTP, "category": "Mean Reversion", "fileName": "rsi_stoch_combo_tp.js",
        "description": "A confirmation-based mean-reversion strategy. It requires both the RSI and Stochastic oscillators to signal oversold conditions simultaneously before entering a trade.",
        "params_def": {
            'GQ_RSI_STOCH_COMBO_TP_RSI_PERIOD': {'label': 'RSI Period', 'type': 'int', 'default': 14, 'min': 2, 'max': 50, 'description': "The period for the RSI."},
            'GQ_RSI_STOCH_COMBO_TP_K': {'label': 'Stoch %K', 'type': 'int', 'default': 14, 'min': 5, 'max': 50, 'description': "The period for the Stoch %K line."},
            'GQ_RSI_STOCH_COMBO_TP_D': {'label': 'Stoch %D', 'type': 'int', 'default': 3, 'min': 1, 'max': 20, 'description': "The period for the Stoch %D line."},
            'GQ_RSI_STOCH_COMBO_TP_SLOWING': {'label': 'Stoch Slowing', 'type': 'int', 'default': 3, 'min': 1, 'max': 20, 'description': "The slowing period for Stoch %K."},
            'GQ_RSI_STOCH_COMBO_TP_RSI_LEVEL': {'label': 'RSI Entry Level', 'type': 'int', 'default': 35, 'min': 10, 'max': 50, 'description': "RSI entry level."},
            'GQ_RSI_STOCH_COMBO_TP_STOCH_LEVEL': {'label': 'Stoch Entry Level', 'type': 'int', 'default': 25, 'min': 10, 'max': 50, 'description': "Stochastic entry level."},
            'GQ_RSI_STOCH_COMBO_TP_ATR_PERIOD': {'label': 'ATR Period (SL/TP)', 'type': 'int', 'default': 14, 'min': 5, 'max': 50, 'description': "Period for ATR (SL/TP)."},
            'GQ_RSI_STOCH_COMBO_TP_ATR_MULT': {'label': 'ATR SL Multiplier', 'type': 'float', 'default': 2.0, 'min': 1.0, 'max': 5.0, 'step': 0.1, 'description': "Multiplier for ATR stop loss."},
            'GQ_RSI_STOCH_COMBO_TP_TP_MULT': {'label': 'ATR TP Multiplier', 'type': 'float', 'default': 4.0, 'min': 1.0, 'max': 10.0, 'step': 0.25, 'description': "Multiplier for ATR take profit."},
        }
    },
    "BB_Reversion": {
        "class": BbReversion, "category": "Mean Reversion", "fileName": "bb_reversion.js",
        "description": "A volatility-based mean-reversion strategy. It aims to buy when the price drops below the lower Bollinger Band, anticipating a rebound towards the mean.",
        "params_def": {
            'GQ_BB_REVERSION_PERIOD': {'label': 'BB Period', 'type': 'int', 'default': 20, 'min': 10, 'max': 100, 'description': "Period for BB and SMA."},
            'GQ_BB_REVERSION_STD_DEV': {'label': 'BB StdDev', 'type': 'float', 'default': 2.0, 'min': 1.0, 'max': 3.0, 'step': 0.1, 'description': "Standard deviation for BB."},
            'GQ_BB_REVERSION_ATR_PERIOD': {'label': 'ATR Period (SL)', 'type': 'int', 'default': 14, 'min': 5, 'max': 50, 'description': "Period for ATR (stop loss)."},
            'GQ_BB_REVERSION_ATR_MULT': {'label': 'ATR Multiplier (SL)', 'type': 'float', 'default': 2.5, 'min': 1.0, 'max': 5.0, 'step': 0.1, 'description': "Multiplier for ATR stop loss."},
        }
    },
}

def get_strategy(name: str, params: dict = None):
    if name not in STRATEGY_MAPPING:
        print(f"Error: Strategy '{name}' not found.")
        return None
    
    strategy_meta = STRATEGY_MAPPING[name]
    if strategy_meta.get("is_legacy"):
        return None

    default_params = {
        key: p_def['default'] 
        for key, p_def in strategy_meta.get('params_def', {}).items()
    }
    
    strategy_class = strategy_meta['class']
    final_params = default_params.copy()
    if params:
        final_params.update(params)
    
    strategy_instance = strategy_class(name, final_params)
    return strategy_instance
```


## ./gunbot_quant/strategies/base_strategy.py
```
# gunbot_quant_tools/strategies/base_strategy.py

from abc import ABC, abstractmethod
import pandas as pd
import numpy as np

class BaseStrategy(ABC):
    """Abstract base class for all generic trading strategies."""
    def __init__(self, name: str, params: dict = None):
        self.name = name
        self.params = params or {}
        self.indicators = {}

    def set_indicators(self, indicators: dict):
        """Injects the pre-computed indicators into the strategy."""
        self.indicators = indicators

    # --- Methods for Directional (In/Out) Strategies ---

    def get_required_indicators(self) -> dict:
        """Returns a dictionary of indicators required by the strategy."""
        return {}

    def get_entry_signal(self, i: int) -> bool:
        """Determines if an entry signal is generated at index i."""
        return False
    
    def get_exit_signal(self, i: int, position: dict) -> str | None:
        """Determines if an exit signal is generated at index i for a non-stop-loss reason."""
        return None

    def get_stop_loss_price(self, i: int, entry_price: float) -> float:
        """Calculates the initial stop loss price for a new position."""
        return entry_price * 0.9 # Default fallback SL

    def get_take_profit_price(self, i: int, position: dict) -> float | None:
        """
        Calculates a take profit price. Default is None (no TP).
        Strategies should override this if they use a fixed TP.
        """
        return None

    def update_trailing_stop(self, i: int, current_price: float, position: dict) -> dict:
        """
        Updates the trailing stop loss (e.g., for trailing, breakeven).
        Default implementation is no-op.
        """
        return position

    # --- Methods for Continuous (e.g., Grid) Strategies ---

    def init_continuous_backtest(self, initial_capital: float, start_index: int, data: pd.DataFrame):
        """Initializes the state for a continuous backtest."""
        pass

    def process_candle(self, i: int):
        """Processes a single candle for a continuous strategy."""
        pass

    def get_continuous_results(self) -> tuple[pd.DataFrame, pd.Series]:
        """Returns the final trades and equity curve from a continuous strategy."""
        return pd.DataFrame(), pd.Series(dtype=float)
```
