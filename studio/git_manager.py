"""
Real Git & GitHub Synchronization Manager for Qwen3.8Flash.

Commits real project files (`src/`, `notebooks/`, `simulators/`, `experiments/`, etc.)
and pushes directly to `origin <current_branch>` on GitHub.
Never switches, creates, or renames branches.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from simulators.kaggle_sim.runtime import PROJECT_ROOT


MAX_GIT_FILE_BYTES = 25 * 1024 * 1024  # 25 MB safety guard against accidental binary checkpoints


class GitSyncManager:
    def __init__(self, repo_root: Path = PROJECT_ROOT) -> None:
        self.repo_root = repo_root

    def _run_git(self, args: List[str], timeout: int = 60) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", *args],
            cwd=str(self.repo_root),
            capture_output=True,
            text=True,
            timeout=timeout,
        )

    def current_branch(self) -> str:
        res = self._run_git(["rev-parse", "--abbrev-ref", "HEAD"])
        return res.stdout.strip() if res.returncode == 0 else "unknown"

    def remote_url(self) -> str:
        res = self._run_git(["remote", "get-url", "origin"])
        url = res.stdout.strip() if res.returncode == 0 else ""
        if url.endswith(".git"):
            return url[:-4]
        return url

    def get_status(self) -> Dict[str, Any]:
        branch = self.current_branch()
        repo_web_url = self.remote_url()

        porcelain = self._run_git(["status", "--porcelain"])
        changed_files: List[Dict[str, str]] = []
        for ln in porcelain.stdout.splitlines():
            if len(ln) >= 4:
                changed_files.append({"code": ln[:2].strip() or "M", "path": ln[3:].strip()})

        # Ahead / behind check relative to origin/<branch>
        ahead = 0
        behind = 0
        ab = self._run_git(["rev-list", "--left-right", "--count", f"HEAD...origin/{branch}"])
        if ab.returncode == 0:
            parts = ab.stdout.strip().split()
            if len(parts) == 2:
                ahead, behind = int(parts[0]), int(parts[1])
        else:
            # Remote branch may not exist yet before first push
            cnt = self._run_git(["rev-list", "--count", "HEAD"])
            ahead = int(cnt.stdout.strip()) if cnt.returncode == 0 and cnt.stdout.strip().isdigit() else 1

        log_res = self._run_git(["log", "-n", "8", "--pretty=format:%h|%H|%s|%cr|%an"])
        commits: List[Dict[str, str]] = []
        if log_res.returncode == 0 and log_res.stdout.strip():
            for ln in log_res.stdout.splitlines():
                segs = ln.split("|", 4)
                if len(segs) == 5:
                    commits.append(
                        {
                            "short_sha": segs[0],
                            "sha": segs[1],
                            "message": segs[2],
                            "relative_time": segs[3],
                            "author": segs[4],
                            "url": f"{repo_web_url}/commit/{segs[1]}" if repo_web_url else "",
                        }
                    )

        return {
            "branch": branch,
            "repo_url": repo_web_url,
            "branch_url": f"{repo_web_url}/tree/{branch}" if repo_web_url else "",
            "is_clean": len(changed_files) == 0,
            "changed_count": len(changed_files),
            "changed_files": changed_files,
            "ahead": ahead,
            "behind": behind,
            "synced_with_github": len(changed_files) == 0 and ahead == 0,
            "recent_commits": commits,
        }

    def _find_oversized_unignored_files(self) -> List[str]:
        oversized: List[str] = []
        status_res = self._run_git(["status", "--porcelain", "-uall"])
        for ln in status_res.stdout.splitlines():
            if len(ln) < 4:
                continue
            rel = ln[3:].strip().strip('"')
            fp = self.repo_root / rel
            if fp.is_file() and fp.stat().st_size > MAX_GIT_FILE_BYTES:
                oversized.append(rel)
        return oversized

    def commit_and_push(
        self,
        message: Optional[str] = None,
        push: bool = True,
        specific_paths: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        branch = self.current_branch()
        repo_web_url = self.remote_url()
        oversized = self._find_oversized_unignored_files()

        if specific_paths:
            safe_paths = [p for p in specific_paths if p not in oversized]
            if safe_paths:
                add_res = self._run_git(["add", "--", *safe_paths])
            else:
                add_res = subprocess.CompletedProcess(["git", "add"], 0, "", "")
        else:
            add_res = self._run_git(["add", "-A"])
            for big_rel in oversized:
                self._run_git(["reset", "HEAD", "--", big_rel])

        if add_res.returncode != 0:
            return {
                "ok": False,
                "stage": "git_add",
                "error": add_res.stderr or add_res.stdout,
                "status": self.get_status(),
            }

        # Check if anything is staged
        diff_cached = self._run_git(["diff", "--cached", "--quiet"])
        committed = False
        commit_output = ""
        commit_msg = (message or "").strip() or "chore: sync Kaggle voice cloning project files"

        if diff_cached.returncode != 0:
            c_res = self._run_git(["commit", "-m", commit_msg])
            commit_output = (c_res.stdout + "\n" + c_res.stderr).strip()
            if c_res.returncode != 0:
                return {
                    "ok": False,
                    "stage": "git_commit",
                    "error": commit_output,
                    "status": self.get_status(),
                }
            committed = True
        else:
            commit_output = "工作区无新增文件差异（已是最新提交状态）。"

        pushed = False
        push_output = ""
        if push:
            p_res = self._run_git(["push", "-u", "origin", branch], timeout=90)
            push_output = (p_res.stdout + "\n" + p_res.stderr).strip()
            if p_res.returncode != 0:
                return {
                    "ok": False,
                    "stage": "git_push",
                    "committed": committed,
                    "commit_output": commit_output,
                    "error": push_output,
                    "status": self.get_status(),
                }
            pushed = True

        head_sha_res = self._run_git(["rev-parse", "HEAD"])
        head_sha = head_sha_res.stdout.strip() if head_sha_res.returncode == 0 else ""

        return {
            "ok": True,
            "branch": branch,
            "committed": committed,
            "pushed": pushed,
            "head_sha": head_sha,
            "commit_url": f"{repo_web_url}/commit/{head_sha}" if (repo_web_url and head_sha) else "",
            "branch_url": f"{repo_web_url}/tree/{branch}" if repo_web_url else "",
            "commit_output": commit_output,
            "push_output": push_output,
            "skipped_oversized_files": oversized,
            "status": self.get_status(),
        }
