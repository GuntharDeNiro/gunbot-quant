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