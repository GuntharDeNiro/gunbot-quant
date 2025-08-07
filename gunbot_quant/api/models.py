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