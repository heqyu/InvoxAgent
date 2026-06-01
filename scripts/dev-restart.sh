#!/usr/bin/env bash
# Kill any running invox node process so Zed re-spawns it on the next prompt.
# After saving source changes, run:  ./scripts/dev-restart.sh
#
# Why: Zed launches invox via `node --import tsx src/cli.ts`, which reads
# source on each spawn (no build step). So killing the process IS the
# restart — Zed re-launches automatically when it next sends a request.
#
# IMPORTANT: we use `taskkill /T` (graceful) rather than Stop-Process -Force
# (SIGKILL). Earlier attempts with -Force caused Zed to mark the agent as
# broken and refuse to re-spawn until Zed itself was restarted. The /T flag
# also kills child processes, in case node has spawned anything (unlikely
# for invox, but free insurance).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    # Windows under Git Bash. Find the invox PID via PowerShell, then close
    # it with taskkill (graceful first, then forced if it didn't die).
    pids="$(
      powershell.exe -NoProfile -Command "
        Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |
          Where-Object { \$_.CommandLine -match '--import\s+tsx' -and \$_.CommandLine -match 'src[\\\\/]cli\.ts' } |
          ForEach-Object { \$_.ProcessId }
      " | tr -d '\r'
    )"
    if [ -z "$pids" ]; then
      echo "(no invox process running)"
      exit 0
    fi
    for pid in $pids; do
      echo "killing invox pid=$pid"
      # /T kills the process tree. Try graceful first; if it's still alive
      # after a brief sleep, escalate to /F.
      taskkill //PID "$pid" //T >/dev/null 2>&1 || true
      sleep 0.4
      if powershell.exe -NoProfile -Command "Get-Process -Id $pid -ErrorAction SilentlyContinue" 2>/dev/null | grep -q "$pid"; then
        echo "  still alive; forcing"
        taskkill //PID "$pid" //T //F >/dev/null 2>&1 || true
      fi
    done
    ;;
  *)
    # POSIX: SIGTERM first, then SIGKILL only if needed.
    if command -v pkill >/dev/null 2>&1; then
      pkill -f "tsx.*src/cli\.ts" 2>/dev/null || { echo "(no matching process)"; exit 0; }
      sleep 0.4
      pkill -9 -f "tsx.*src/cli\.ts" 2>/dev/null || true
    else
      echo "pkill not available; please install procps or kill manually"
      exit 1
    fi
    ;;
esac

echo "✓ invox killed gracefully. Send any prompt in Zed and it will re-spawn with your latest changes."

