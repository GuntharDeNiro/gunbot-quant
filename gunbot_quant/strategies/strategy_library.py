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