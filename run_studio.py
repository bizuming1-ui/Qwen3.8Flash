#!/usr/bin/env python3
"""
Main Launcher for Qwen3.8Flash Kaggle & Voice Cloning Browser Simulator Studio.

Binds 0.0.0.0:8000 so Arena's Live Preview opens directly in the user's browser.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent


def ensure_os_kaggle_bridge() -> None:
    """Sets up `/kaggle -> <project>/kaggle_workspace` symlink when permitted."""
    kw = PROJECT_ROOT / "kaggle_workspace"
    for sub in ("input", "working", "tmp"):
        (kw / sub).mkdir(parents=True, exist_ok=True)

    kaggle_path = Path("/kaggle")
    if kaggle_path.is_symlink() or kaggle_path.exists():
        return
    try:
        subprocess.run(["sudo", "-n", "ln", "-sfn", str(kw), "/kaggle"], check=False, capture_output=True)
    except Exception:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Launch Qwen3.8Flash Kaggle & Voice Cloning Studio")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()

    sys.path.insert(0, str(PROJECT_ROOT))
    ensure_os_kaggle_bridge()

    import uvicorn

    uvicorn.run(
        "studio.app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        proxy_headers=True,
        forwarded_allow_ips="*",
    )


if __name__ == "__main__":
    main()
