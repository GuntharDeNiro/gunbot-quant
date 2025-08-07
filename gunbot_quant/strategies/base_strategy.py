# gunbot_quant_tools/strategies/base_strategy.py

from abc import ABC, abstractmethod
import pandas as pd
import numpy as np

class BaseStrategy(ABC):
    """Abstract base class for all generic trading strategies."""
    def __init__(self, name: str, params: dict = None):
        self.name = name
        self.params = params or {}
        self.indicators = {}

    def set_indicators(self, indicators: dict):
        """Injects the pre-computed indicators into the strategy."""
        self.indicators = indicators

    # --- Methods for Directional (In/Out) Strategies ---

    def get_required_indicators(self) -> dict:
        """Returns a dictionary of indicators required by the strategy."""
        return {}

    def get_entry_signal(self, i: int) -> bool:
        """Determines if an entry signal is generated at index i."""
        return False
    
    def get_exit_signal(self, i: int, position: dict) -> str | None:
        """Determines if an exit signal is generated at index i for a non-stop-loss reason."""
        return None

    def get_stop_loss_price(self, i: int, entry_price: float) -> float:
        """Calculates the initial stop loss price for a new position."""
        return entry_price * 0.9 # Default fallback SL

    def get_take_profit_price(self, i: int, position: dict) -> float | None:
        """
        Calculates a take profit price. Default is None (no TP).
        Strategies should override this if they use a fixed TP.
        """
        return None

    def update_trailing_stop(self, i: int, current_price: float, position: dict) -> dict:
        """
        Updates the trailing stop loss (e.g., for trailing, breakeven).
        Default implementation is no-op.
        """
        return position

    # --- Methods for Continuous (e.g., Grid) Strategies ---

    def init_continuous_backtest(self, initial_capital: float, start_index: int, data: pd.DataFrame):
        """Initializes the state for a continuous backtest."""
        pass

    def process_candle(self, i: int):
        """Processes a single candle for a continuous strategy."""
        pass

    def get_continuous_results(self) -> tuple[pd.DataFrame, pd.Series]:
        """Returns the final trades and equity curve from a continuous strategy."""
        return pd.DataFrame(), pd.Series(dtype=float)