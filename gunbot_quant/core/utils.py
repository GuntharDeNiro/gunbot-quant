# gunbot_quant_tools/core/utils.py

import pandas as pd
import numpy as np
import datetime
import math
import json # NEW: Import json

# --- NEW: Custom Exception for Data-Related Errors ---
class DataValidationError(Exception):
    """Custom exception for errors related to data integrity or availability."""
    pass

# --- NEW: The correct way to handle NumPy types in JSON ---
class NumpyEncoder(json.JSONEncoder):
    """
    A custom JSONEncoder to handle NumPy data types that are not
    natively serializable by the standard json library.
    """
    def default(self, obj):
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            # Handle NaN and Infinity as null or string representations
            if np.isnan(obj):
                return None
            if np.isinf(obj):
                return float('inf') if obj > 0 else float('-inf')
            return float(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist() # Convert arrays to lists
        if isinstance(obj, (datetime.datetime, datetime.date, pd.Timestamp)):
            return obj.isoformat()
        if isinstance(obj, np.bool_):
            return bool(obj)
        # Let the base class default method raise the TypeError
        return super(NumpyEncoder, self).default(obj)

# --- DEPRECATED/SIMPLIFIED: No longer needed for numeric types ---
def stringify_dates(obj):
    """
    Recursively convert any datetime-like objects, special floats (inf, nan), 
    and NumPy numeric types to standard, JSON-serializable Python types.
    """
    if isinstance(obj, (pd.Timestamp, np.datetime64, datetime.date, datetime.datetime)):
        return obj.isoformat()
    if isinstance(obj, (np.integer, np.int64, np.int32)):
        return int(obj)
    
    if isinstance(obj, (float, np.floating, np.float64, np.float32)):
        if math.isnan(obj):
            return None  # Represent NaN as null in JSON
        if math.isinf(obj):
            return "Infinity" if obj > 0 else "-Infinity"
        return float(obj)

    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, dict):
        return {k: stringify_dates(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [stringify_dates(i) for i in obj]
    return obj