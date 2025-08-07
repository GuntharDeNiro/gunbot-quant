# gunbot_quant/gunbot_api/client.py

import json
import os
import subprocess
from datetime import datetime, timedelta
from typing import Optional, Dict, Any

from gunbot_sdk import ApiClient, GunbotApi

# --- Configuration ---
# Store credentials in the root directory of the project
CRED_FILE = os.path.join(os.path.dirname(__file__), '..', '..', 'gunbot_creds.json')

# --- Global State ---
gunbot_api_instance: Optional[GunbotApi] = None

# --- Credential Management ---
def save_credentials(jwt: str, protocol: str, host: str, port: int) -> None:
    """Saves the Gunbot connection details to a file."""
    creds = {'jwt': jwt, 'protocol': protocol, 'host': host, 'port': port}
    try:
        with open(CRED_FILE, 'w') as f:
            json.dump(creds, f)
    except IOError as e:
        print(f"Error saving credentials: {e}")

def load_credentials() -> Optional[Dict[str, Any]]:
    """Loads Gunbot connection details from a file."""
    if not os.path.exists(CRED_FILE):
        return None
    try:
        with open(CRED_FILE, 'r') as f:
            data = json.load(f)
            # Basic validation
            if all(k in data for k in ['jwt', 'protocol', 'host', 'port']):
                return data
            return None
    except (IOError, json.JSONDecodeError) as e:
        print(f"Error loading credentials: {e}")
        return None

def clear_credentials() -> None:
    """Removes the credentials file."""
    global gunbot_api_instance
    gunbot_api_instance = None
    if os.path.exists(CRED_FILE):
        os.remove(CRED_FILE)

def close_gunbot_api() -> None:
    """Explicitly closes the multiprocessing pool in the SDK's ApiClient."""
    global gunbot_api_instance
    if gunbot_api_instance and hasattr(gunbot_api_instance.api_client, 'pool') and gunbot_api_instance.api_client.pool is not None:
        print("Closing Gunbot API client pool...")
        try:
            pool = gunbot_api_instance.api_client.pool
            pool.close()
            pool.join()
        except Exception as e:
            # This error might be benign if the pool is already terminated during shutdown.
            print(f"Error while closing Gunbot API client pool: {e}")
    
    # Setting the global instance to None indicates that the API has been shut down
    # and prevents further use. The underlying ApiClient object will be garbage-collected
    # by Python later. We no longer set its .pool to None to avoid the AttributeError.
    gunbot_api_instance = None


# --- SDK Client Initialization ---
def _construct_base_path(creds: Optional[Dict[str, Any]]) -> str:
    """Constructs the base_path URL from credentials or returns a default."""
    if creds:
        return f"{creds['protocol']}://{creds['host']}:{creds['port']}/api/v1"
    # Fallback to default if no creds are saved
    return "http://localhost:3000/api/v1"

def initialize_gunbot_api(jwt: str, protocol: str, host: str, port: int) -> GunbotApi:
    """
    Initializes or re-initializes the Gunbot API client with a new token and host.
    Saves the credentials for future use.
    """
    global gunbot_api_instance
    save_credentials(jwt=jwt, protocol=protocol, host=host, port=port)
    
    creds = load_credentials() # Reload to be sure
    base_path = _construct_base_path(creds)
    
    api_client = ApiClient(base_path=base_path, bearer_token=jwt)
    gunbot_api_instance = GunbotApi(api_client)
    return gunbot_api_instance

def get_gunbot_api() -> Optional[GunbotApi]:
    """
    Gets the singleton Gunbot API client instance.
    Initializes it from saved credentials if not already in memory.
    """
    global gunbot_api_instance
    if gunbot_api_instance:
        return gunbot_api_instance

    creds = load_credentials()
    if not creds:
        return None
    
    base_path = _construct_base_path(creds)
    api_client = ApiClient(base_path=base_path, bearer_token=creds['jwt'])
    gunbot_api_instance = GunbotApi(api_client)
    return gunbot_api_instance

# --- Encryption Helper for Login (using OpenSSL via Subprocess) ---
def _encrypt_password(password: str, key: str) -> str:
    """Encrypts a password using AES-128-CBC for Gunbot API login."""
    try:
        if not key:
            raise ValueError("'gunthy_wallet' key cannot be empty.")
        # Truncate key to 16 bytes for AES-128
        key_trunc = key[:16]

        # Convert key and IV to hex. IV is the same as the key.
        key_hex = key_trunc.encode('utf-8').hex()
        iv_hex = key_hex

        # Run openssl command
        res = subprocess.run([
            'openssl', 'enc', '-aes-128-cbc',
            '-K', key_hex,
            '-iv', iv_hex,
            '-nosalt',
            '-base64',
            '-A'  # CRITICAL FIX: Ensures base64 output is a single line
        ], input=password.encode('utf-8'), stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)

        # .strip() is still good practice to remove any final newline
        encrypted_base64 = res.stdout.decode().strip()
        return f"ENC:{encrypted_base64}"
    except (FileNotFoundError, subprocess.CalledProcessError) as e:
        error_message = "OpenSSL command failed. Ensure OpenSSL is installed and in your system's PATH."
        if isinstance(e, subprocess.CalledProcessError):
            error_message += f"\nStderr: {e.stderr.decode()}"
        raise RuntimeError(error_message)


# --- Full Login Flow Function ---
def login_and_initialize_api(protocol: str, host: str, port: int, password: str, gunthy_wallet: str) -> Dict[str, Any]:
    """
    Connects to Gunbot using password, retrieves JWT, and initializes the global API client.
    """
    base_path = f"{protocol}://{host}:{port}/api/v1"
    
    try:
        print(f"Attempting to connect to Gunbot at: {base_path}")
        
        # Step 1: Encrypt the password using the provided key
        encrypted_password = _encrypt_password(password, gunthy_wallet)
        
        # Step 2: Create a temporary unauthenticated client to perform the login
        unauth_client = ApiClient(base_path=base_path, bearer_token='')
        unauth_api = GunbotApi(unauth_client)
        
        # Step 3: Perform the login call
        login_body = {"password": encrypted_password}
        
        print(f"Sending login request to {base_path}/auth/login with body: {login_body}")
        
        login_model = unauth_api.auth_login(body=login_body)
        
        # Step 4: Check login success and extract JWT
        # FIX: The actual Gunbot response uses 'status' and 'token', not 'success' and 'jwt'.
        if not hasattr(login_model, 'status') or login_model.status != 'success' or not hasattr(login_model, 'token'):
            error_msg = login_model.message if hasattr(login_model, 'message') and login_model.message else "Login failed. Gunbot API did not return a success token."
            raise ConnectionRefusedError(error_msg)
        
        jwt = login_model.token # FIX: Use the 'token' field from the response
        
        # Step 5: Initialize the global authenticated client with the new JWT
        initialize_gunbot_api(jwt=jwt, protocol=protocol, host=host, port=port)
        
        # Step 6: Final verification with an authenticated call
        auth_check_result = auth_status()
        if not auth_check_result.get("success"):
            clear_credentials()
            raise ConnectionRefusedError(f"Login succeeded, but subsequent authentication check failed: {auth_check_result.get('error')}")

        return {"success": True, "message": "Successfully connected to Gunbot.", "data": auth_check_result.get("data")}

    except Exception as e:
        clear_credentials()
        print(f"--- DETAILED EXCEPTION DURING LOGIN ---\n{repr(e)}\n------------------------------------")
        
        e_str = str(e).lower()
        if "connection refused" in e_str or "failed to establish a new connection" in e_str:
            error_msg = f"Connection Refused: Could not connect to Gunbot at '{base_path}'. Please ensure Gunbot is running and the host/port settings are correct."
        else:
            error_msg = f"Gunbot login process failed: {str(e)}"
        return {"success": False, "error": error_msg}

# --- Helper for timestamps ---
def ts(*, days: int = 0, hours: int = 0) -> int:
    """Return a UTC Unix timestamp in **milliseconds** with offset."""
    return int((datetime.utcnow() + timedelta(days=days, hours=hours)).timestamp() * 1000)

# --- Wrapper Methods for API Endpoints ---
def gb_api_call(func_name: str, *args, **kwargs) -> Dict[str, Any]:
    """
    A generic wrapper to call Gunbot API methods. It inspects the response
    for success/failure and catches transport-level exceptions.
    """
    gunbot_api = get_gunbot_api()
    if not gunbot_api:
        return {"success": False, "error": "Gunbot client not connected. Please provide a JWT token."}
    
    try:
        method = getattr(gunbot_api, func_name)
        response_model = method(*args, **kwargs)

        if hasattr(response_model, 'success') and not response_model.success:
            error_message = "Unknown API error."
            if hasattr(response_model, 'message') and response_model.message:
                error_message = response_model.message
            elif hasattr(response_model, 'error') and response_model.error:
                error_message = response_model.error
            return {"success": False, "error": error_message}
        
        response_data = response_model.to_dict() if hasattr(response_model, 'to_dict') else response_model
        return {"success": True, "data": response_data}

    except Exception as e:
        return {"success": False, "error": f"A communication error occurred: {str(e)}"}

# --- SYSTEM / AUTH ---
def auth_status() -> Dict[str, Any]:
    return gb_api_call('auth_status')

def auth_login(body: Dict[str, Any]) -> Dict[str, Any]:
    """Wraps the auth_login endpoint. Note: typically used via login_and_initialize_api."""
    return gb_api_call('auth_login', body=body)

# --- CONFIGURATION ---
def config_full() -> Dict[str, Any]:
    return gb_api_call('config_full')

def config_pair_add(body: Dict[str, Any]) -> Dict[str, Any]:
    """
    Adds or updates a trading pair in Gunbot's configuration.
    The body must match the structure expected by the Gunbot API.
    """
    return gb_api_call('config_pair_add', body=body)

def config_pair_remove(pair: str, exchange: str) -> Dict[str, Any]:
    body = {"pair": pair, "exchange": exchange}
    return gb_api_call('config_pair_remove', body=body)

def config_strategy_add(name: str, settings: Dict[str, Any]) -> Dict[str, Any]:
    body = {"name": name, "settings": settings}
    return gb_api_call('config_strategy_add', body=body)

# --- CORE MEMORY ---
def coremem() -> Dict[str, Any]:
    return gb_api_call('coremem')

# --- FILES ---
def files_strategy() -> Dict[str, Any]:
    return gb_api_call('files_strategy')

def files_strategy_write(filename: str, document: str) -> Dict[str, Any]:
    body = {"filename": filename, "document": document}
    return gb_api_call('files_strategy_write', body=body)

def files_strategy_get(filename: str) -> Dict[str, Any]:
    body = {"filename": filename}
    return gb_api_call('files_strategy_get', body=body)

# --- TRADING ---
def trade_sell_market(exch: str, pair: str, price: float, amt: float) -> Dict[str, Any]:
    body = {"exch": exch, "pair": pair, "price": price, "amt": amt}
    return gb_api_call('trade_sell_market', body=body)

def orders(pair_string: str) -> Dict[str, Any]:
    """
    Fetches order history for a specific pair.
    The pair string must be in 'exchange/QUOTE-BASE' format.
    """
    # The SDK's generated method expects the argument to be named 'key'.
    return gb_api_call('orders', key=pair_string)