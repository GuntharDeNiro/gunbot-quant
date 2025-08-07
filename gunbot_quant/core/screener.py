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