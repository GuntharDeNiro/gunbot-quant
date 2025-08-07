# ./run.py

import uvicorn
import os

def main():
    """
    The main entry point for running the Gunbot Quant application.
    This script starts the Uvicorn server which serves both the FastAPI backend
    and the static frontend files.
    """
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", 8000))
    
    print("==========================================================")
    print("🚀 Starting Gunbot Quant: FastAPI + React UI")
    print(f"✅ Frontend build found and will be served.")
    print(f"🔗 Access the application at: http://localhost:{port}")
    print(f"   Or on your local network at: http://{host}:{port}")
    print("==========================================================")

    # Note: We do not use --reload here as this is for production/end-user execution.
    # The import string "gunbot_quant.api.main:app" points to your FastAPI app instance.
    uvicorn.run(
        "gunbot_quant.api.main:app",
        host=host,
        port=port,
        log_level="info"
    )

if __name__ == "__main__":
    main()