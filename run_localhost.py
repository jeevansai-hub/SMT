"""Unified Runner for SMT Engineering Workspace.

Starts the combined local host server hosting:
1. Pathway LMS Frontend Dashboard (at / and /lms)
2. LMS Multi-tab UI Viewer (at /lms/lms_ui_viewer.html)
3. Crucible Proctored Sandbox Engine (at /lobby/1, /exam, /result, /path)
4. Sandbox Backend API & Runner (at /api/*)

Usage:
    python run_localhost.py
"""
import sys
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def main():
    print("=" * 65)
    print("STARTING UNIFIED LOCALHOST (LMS + SANDBOX COMBINED)")
    print("=" * 65)
    print("  * LMS Frontend Path:      http://127.0.0.1:8000/")
    print("  * LMS Multi-Tab Viewer:   http://127.0.0.1:8000/lms/lms_ui_viewer.html")
    print("  * Sandbox Exam Engine:    http://127.0.0.1:8000/sandbox")
    print("  * Sandbox API & Health:   http://127.0.0.1:8000/api/health")
    print("=" * 65)
    print("Starting server on http://127.0.0.1:8000 ...")
    sys.stdout.flush()

    web_dir = ROOT / "product" / "entrypoints" / "web"
    web_dist_index = web_dir / "dist" / "index.html"
    if not web_dist_index.exists():
        print("Sandbox web distribution not found. Building frontend bundle (npm run build)...")
        sys.stdout.flush()
        npm_cmd = "npm.cmd" if sys.platform == "win32" else "npm"
        try:
            subprocess.run([npm_cmd, "run", "build"], cwd=str(web_dir), check=True)
            print("Web frontend build complete.")
        except Exception as e:
            print(f"Note: automatic build skipped ({e}). Proceeding...")

    serve_py = ROOT / "product" / "entrypoints" / "http-api" / "serve.py"
    subprocess.run([sys.executable, str(serve_py)], check=True)

if __name__ == "__main__":
    main()
