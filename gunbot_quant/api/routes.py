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
    {'value': 'coinbase', 'label': 'Coinbase'},
]

GUNBOT_SUPPORTED_IDS = {
    'binance', 'binanceus', 'bingx', 'bitget',
    'kraken', 'kucoin', 'mexc', 'okx', 'poloniex',
    'gate', 'coinbase' # 'gate.io' and 'gate' are often aliases
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