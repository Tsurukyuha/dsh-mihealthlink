#!/usr/bin/env bash
# 同步最近 N 天（默认 7）的小米运动健康数据到本地 SQLite
#   ./sync.sh        → 最近 7 天
#   ./sync.sh 30     → 最近 30 天
#   ./sync.sh 2026-10-01 2026-11-01   → 指定区间
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VPY="${MI_VENV_PY:-$ROOT/.venv/bin/python}"
DB="${MI_FITNESS_DB_PATH:-$ROOT/data/mi_fitness.db}"
mkdir -p "$(dirname "$DB")"

if [ $# -ge 2 ]; then
  START="$1"; END="$2"
else
  DAYS="${1:-7}"
  START="$("$VPY" -c "import datetime;print((datetime.date.today()-datetime.timedelta(days=$DAYS-1)).isoformat())")"
  END="$("$VPY" -c "import datetime;print(datetime.date.today().isoformat())")"
fi

echo "同步 $START → $END  →  $DB"
exec "${MI_VENV_BIN:-$ROOT/.venv/bin}/mi-fitness-bridge" sync --start-date "$START" --end-date "$END" --db "$DB"
