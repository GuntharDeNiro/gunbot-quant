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