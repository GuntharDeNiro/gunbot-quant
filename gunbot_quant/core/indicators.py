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