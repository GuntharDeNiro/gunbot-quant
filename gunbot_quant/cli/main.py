# gunbot_quant/cli/main.py

import typer
import os
import json
import re
from typing import List
from ..config.scenarios import SCENARIOS, get_scenario_config
from ..core.engine_runner import run_batch_backtest
from typing_extensions import Annotated
from ..gunbot_api import client as gunbot_client
from ..strategies.strategy_library import STRATEGY_MAPPING

app = typer.Typer(help="Gunbot Quant - A CLI for backtesting and screening crypto trading strategies.")

# --- Gunbot command group ---
gunbot_app = typer.Typer(help="Manage Gunbot Tools.")
app.add_typer(gunbot_app, name="gunbot")

def to_snake_case(name: str) -> str:
    s1 = re.sub('(.)([A-Z][a-z]+)', r'\1_\2', name)
    return re.sub('([a-z0-9])([A-Z])', r'\1_\2', s1).lower()

@gunbot_app.command("add-pair")
def add_pair_to_gunbot(
    exchange: Annotated[str, typer.Argument(help="The exchange name as it is configured in your Gunbot (e.g., 'binance').")],
    strategy_name: Annotated[str, typer.Argument(help="The name of the GQ strategy to use (e.g., 'RSI_Reversion').")],
    pairs: Annotated[List[str], typer.Argument(help="A list of pairs in standard format (e.g., BTCUSDT ETHUSDT).")],
    quote_asset: Annotated[str, typer.Option(help="The quote asset for all pairs (e.g., USDT).")] = "USDT"
):
    """
    Adds one or more pairs to a connected Gunbot instance with a specified strategy.
    """
    print("--- Connecting to Gunbot ---")
    api = gunbot_client.get_gunbot_api()
    if not api:
        print("❌ Error: Gunbot not connected. Please connect via the UI first or ensure gunbot_creds.json exists.")
        raise typer.Exit(code=1)

    status = gunbot_client.auth_status()
    if not status.get("success"):
        print(f"❌ Error: Gunbot connection failed: {status.get('error')}")
        raise typer.Exit(code=1)
    
    print("✅ Successfully connected to Gunbot.")

    if strategy_name not in STRATEGY_MAPPING:
        print(f"❌ Error: Strategy '{strategy_name}' not found in GQ library.")
        raise typer.Exit(code=1)

    strategy_meta = STRATEGY_MAPPING[strategy_name]
    default_params = {
        key: p_def.get('default') 
        for key, p_def in strategy_meta.get('params_def', {}).items()
    }
    
    gunbot_strategy_name = to_snake_case(strategy_name)
    overrides = {
        "BUY_METHOD": "custom",
        "SELL_METHOD": "custom",
        "BUY_ENABLED": True,
        "SELL_ENABLED": True,
        "STOP_AFTER_SELL": True
    }
    for key, value in default_params.items():
        override_key = f"GQ_{gunbot_strategy_name.upper()}_{key.upper()}"
        overrides[override_key] = value

    for pair in pairs:
        print(f"--- Adding {pair} ---")
        base_asset = pair.replace(quote_asset, '')
        gunbot_pair = f"{quote_asset}-{base_asset}"
        
        body = {
            "pair": gunbot_pair,
            "exchange": exchange,
            "settings": {
                "strategy": gunbot_strategy_name,
                "enabled": True,
                "override": overrides
            }
        }
        
        result = gunbot_client.config_pair_add(body=body)
        if result.get("success"):
            print(f"✅ Successfully added/updated {gunbot_pair} on {exchange}.")
        else:
            print(f"❌ Failed to add {gunbot_pair}: {result.get('error')}")

@app.command()
def list_scenarios():
    """Lists all available scenarios defined in scenarios.py."""
    print("📋 Available Scenarios:")
    if not SCENARIOS:
        print("  No scenarios found.")
        return
    for scenario in SCENARIOS:
        print(f"  - {scenario['name']}")

@app.command()
def run(
    scenario_name: Annotated[str, typer.Argument(help="The name of the scenario to run. Use 'list-scenarios' to see options.")]
):
    """Runs a single backtesting scenario."""
    print(f"--- Starting Quant Toolbox: Running Scenario '{scenario_name}' ---")
    
    scenario_def = next((s for s in SCENARIOS if s["name"] == scenario_name), None)
    if not scenario_def:
        print(f"❌ Error: Scenario '{scenario_name}' not found.")
        print("Use 'list-scenarios' to see available options.")
        raise typer.Exit(code=1)

    print(f"\n{'#' * 70}\n### CONFIGURING SCENARIO: {scenario_name}\n{'#' * 70}\n")
    
    config = get_scenario_config(scenario_def)
    run_batch_backtest(config)
    print(f"\n--- ✅ Scenario '{scenario_name}' finished. Results are in 'results/{scenario_name}' ---")

@app.command()
def run_all():
    """Runs all available backtesting scenarios sequentially."""
    print("--- 🚀 Starting Quant Toolbox: Running ALL Scenarios ---")
    
    if not SCENARIOS:
        print("No scenarios found to run.")
        return

    for scenario_def in SCENARIOS:
        scenario_name = scenario_def["name"]
        print(f"\n{'=' * 70}\n### RUNNING SCENARIO: {scenario_name}\n{'=' * 70}\n")
        
        config = get_scenario_config(scenario_def)
        run_batch_backtest(config)
        print(f"\n--- ✅ Scenario '{scenario_name}' finished. ---")

    print("\n\n🎉 All scenarios completed.")
    
if __name__ == "__main__":
    app()