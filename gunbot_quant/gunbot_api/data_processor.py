# gunbot_quant/gunbot_api/data_processor.py

from typing import Dict, Any

from . import client as gunbot_client

def process_trading_pairs_from_coremem(coremem_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Processes the raw coremem object from Gunbot to extract information
    about actively trading pairs, their configuration, and their order history.

    Args:
        coremem_data: The full 'data' object from the coremem SDK call.

    Returns:
        A dictionary where keys are the standard pair format (e.g., 'ETHUSDT')
        and values are objects containing the pair's data.
    """
    trading_pairs_info = {}
    config = coremem_data.get("config", {})
    memory = coremem_data.get("memory", {})

    if not config or not isinstance(config, dict):
        return {}

    for exchange, pairs in config.items():
        if not isinstance(pairs, dict):
            continue
            
        for gunbot_pair, pair_config in pairs.items():
            # Skip if the pair is not a dictionary or not enabled
            if not isinstance(pair_config, dict) or not pair_config.get("enabled"):
                continue

            # Convert Gunbot pair format (USDT-ETH) to standard format (ETHUSDT)
            try:
                quote, base = gunbot_pair.split('-')
                standard_pair = f"{base}{quote}"
            except ValueError:
                # Skip malformed pair names
                continue

            # Construct the key to look up the pair in the memory object
            memory_key = f"{exchange}/{gunbot_pair}"
            pair_memory = memory.get(memory_key, {})

            # --- Fetch order history ---
            orders_result = gunbot_client.orders(memory_key)
            pair_orders = []
            if orders_result.get("success"):
                # The response from gb_api_call is {"success": True, "data": response_data}
                # where response_data is the dict from the model, e.g., {"data": [...]}
                pair_orders = orders_result.get("data", {}).get("data", [])
            
            # --- Safely get values for calculation ---
            bid = pair_memory.get("Bid")
            abp = pair_memory.get("ABP")

            # Build the final data object for this pair
            trading_pairs_info[standard_pair] = {
                "standard_pair_format": standard_pair,
                "gunbot_pair_format": gunbot_pair,
                "exchange": exchange,
                "config": {
                    "strategy": pair_config.get("strategy"),
                    "enabled": pair_config.get("enabled"),
                    "override": pair_config.get("override", {}),
                },
                "openOrders": pair_memory.get("openOrders", []),
                "quoteBalance": pair_memory.get("quoteBalance"),
                "baseBalance": pair_memory.get("baseBalance"),
                "bid": bid,
                "unitCost": abp,
                "orders": pair_orders,
                "bagValue": bid * abp if isinstance(bid, (int, float)) and isinstance(abp, (int, float)) else 0.0,
                "candleTimeFrame": pair_memory.get("whatstrat", {}).get("PERIOD") 
            }
            
    return trading_pairs_info