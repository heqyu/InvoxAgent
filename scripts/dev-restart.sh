#!/usr/bin/env bash
# Kill any running invox node process so Zed re-spawns it on the next prompt.
# After saving source changes, run:  ./scripts/dev-restart.sh
#
# Why: Zed launches invox via `node --import tsx src/cli.ts`, which reads
# source on each spawn (no build step). So killing the process IS the
# restart — Zed re-launches automatically when it next sends a request.
#
# On Windows we look for node.exe processes whose command line includes
# 'invox' or our cli.ts path. We deliberately do NOT use plain `taskkill /IM
# node.exe /F` because that would also kill any unrelated node processes.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    # Windows under Git Bash. Use PowerShell to filter by command line.
    # Match very narrowly: only node processes that are running invox's
    # cli.ts AND have --import tsx (i.e. were launched the way Zed launches
    # us). The earlier broader filter accidentally matched VS Code's
    # tsserver because it lives under the project's node_modules and so
    # had 'InvoxAgent' in its command line.
    powershell.exe -NoProfile -Command "
      Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |
        Where-Object { \$_.CommandLine -match '--import\s+tsx' -and \$_.CommandLine -match 'src[\\\\/]cli\.ts' } |
        ForEach-Object {
          Write-Host \"killing invox pid=\$(\$_.ProcessId)\"
          Stop-Process -Id \$_.ProcessId -Force
        }
    "
    ;;
  *)
    # POSIX: pkill by command line match.
    if command -v pkill >/dev/null 2>&1; then
      pkill -f "tsx.*src/cli\.ts" || echo "(no matching process; nothing to kill)"
    else
      echo "pkill not available; please install procps or kill manually"
      exit 1
    fi
    ;;
esac

echo "✓ invox process killed. Send any prompt in Zed and it will re-spawn with your latest changes."
