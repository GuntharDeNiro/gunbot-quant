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
