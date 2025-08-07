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