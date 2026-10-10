"""Run the backend: python -m backend  (binds 127.0.0.1 by default)."""
import uvicorn

from . import config
from .app import create_app

if __name__ == "__main__":
    uvicorn.run(create_app(), host=config.HOST, port=config.PORT, log_level="info")
