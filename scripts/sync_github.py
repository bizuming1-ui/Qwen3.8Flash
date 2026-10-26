#!/usr/bin/env python3
"""CLI helper to commit and push all real project files to GitHub on the active branch."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from studio.git_manager import GitSyncManager  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Commit and push project files to GitHub")
    parser.add_argument(
        "-m",
        "--message",
        default="feat: sync Kaggle voice cloning project files",
        help="Git commit message",
    )
    parser.add_argument("--no-push", action="store_true", help="Commit locally without git push")
    args = parser.parse_args()

    mgr = GitSyncManager(repo_root=PROJECT_ROOT)
    res = mgr.commit_and_push(message=args.message, push=not args.no_push)
    print(json.dumps(res, indent=2, ensure_ascii=False))
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
