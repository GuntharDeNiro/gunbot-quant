# gunbot_quant/api/main.py

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from .routes import router as api_router

# --- Add these imports ---
import os
import mimetypes 
from contextlib import asynccontextmanager
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from ..gunbot_api import client as gunbot_client

# Explicitly set MIME types to prevent Windows-specific issues 
# This ensures that JS and CSS files are served with the correct headers,
# even if the user's Windows Registry is misconfigured.
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("text/css", ".css")
# --------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manages application startup and shutdown events."""
    # Code here runs on startup
    print("Gunbot Quant API starting up...")
    yield
    # Code here runs on shutdown
    print("Gunbot Quant API shutting down...")
    gunbot_client.close_gunbot_api()

app = FastAPI(
    title="Gunbot Quant API",
    description="API for running cryptocurrency trading strategy backtests and market screening.",
    version="1.0.0",
    lifespan=lifespan  # Register the lifespan manager
)

# Shared state for background jobs
app.state.job_results = {}

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- API router must be included BEFORE the static file catch-all ---
app.include_router(api_router, prefix="/api/v1")


# --- Serve the static frontend from the 'dist' directory ---

# Correctly navigate from 'gunbot_quant/api' up one level to 'gunbot_quant',
# then into 'frontend/dist'.
frontend_dir = os.path.join(os.path.dirname(__file__), '..', 'frontend', 'dist')

# Check if the frontend build directory exists
if os.path.exists(frontend_dir):
    # Mount the 'assets' directory which contains JS, CSS, etc.
    app.mount(
        "/assets",
        StaticFiles(directory=os.path.join(frontend_dir, "assets")),
        name="assets"
    )

    @app.get("/{full_path:path}", tags=["Frontend"])
    async def serve_frontend(request: Request, full_path: str):
        """
        Catch-all endpoint to serve the frontend's index.html.
        This is necessary for client-side routing to work correctly.
        """
        # Path to the main index.html file
        index_path = os.path.join(frontend_dir, 'index.html')
        
        # Check for static files like favicon.ico or vite.svg
        potential_file_path = os.path.join(frontend_dir, full_path)
        if os.path.isfile(potential_file_path):
             return FileResponse(potential_file_path)

        # For any other path, serve the main index.html
        return FileResponse(index_path)

else:
    # Fallback message if the frontend hasn't been built
    @app.get("/", tags=["Root"])
    async def read_root_dev():
        return {"message": "Welcome - Gunbot Quant API is running. Frontend build not found in `frontend/dist`. Run `npm run build --prefix frontend` to serve the UI."}