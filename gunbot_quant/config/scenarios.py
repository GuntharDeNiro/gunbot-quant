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