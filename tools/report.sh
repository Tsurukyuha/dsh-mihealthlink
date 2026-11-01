#!/usr/bin/env bash
# 出日报。直接读本地 SQLite，不联网。
#   ./report.sh          人类可读
#   ./report.sh --json   给程序/大模型用
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VPY="${MI_VENV_PY:-$ROOT/.venv/bin/python}"
DB="${MI_FITNESS_DB_PATH:-$ROOT/data/mi_fitness.db}"
exec "$VPY" "$ROOT/daily_report.py" --db "$DB" "$@"
