#!/usr/bin/env bash
# 前置条件自检：在 WSL 里跑，最后打印一段可以直接粘进 cordis.patch.yml 的配置
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail=0
ok()   { printf '  ✔ %s\n' "$1"; }
bad()  { printf '  ✘ %s\n' "$1"; fail=$((fail+1)); }
warn() { printf '  ! %s\n' "$1"; }

echo "== 1. Python =="
PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  bad "没有 python3"
else
  v="$("$PY" -c 'import sys;print("%d.%d"%sys.version_info[:2])')"
  if "$PY" -c 'import sys;sys.exit(0 if sys.version_info>=(3,11) else 1)'; then
    ok "python3 $v"
  else
    bad "python3 $v（需要 3.11+）"
  fi
fi

echo "== 2. mi-fitness-bridge =="
BRIDGE=""
for cand in "$ROOT/.venv/bin/mi-fitness-bridge" "$HOME/mi-fitness/.venv/bin/mi-fitness-bridge"; do
  [ -x "$cand" ] && BRIDGE="$cand" && break
done
if [ -z "$BRIDGE" ]; then
  bad "没找到 mi-fitness-bridge（先跑 tools/install.sh）"
else
  ok "$BRIDGE"
fi

PYBIN=""
[ -n "$BRIDGE" ] && PYBIN="$(dirname "$BRIDGE")/python"
if [ -x "$PYBIN" ]; then ok "python: $PYBIN"; else bad "同一个 venv 里没有 python"; fi

echo "== 3. keyring 后端 =="
if [ -x "$PYBIN" ]; then
  backend="$("$PYBIN" -c 'import keyring;b=keyring.get_keyring();print(type(b).__module__+"."+type(b).__name__)' 2>/dev/null || echo none)"
  case "$backend" in
    *fail*|none) bad "没有可用钥匙串（装 keyrings.alt 或配 gnome-keyring/kwallet）" ;;
    *Plaintext*) warn "明文存储（keyrings.alt）：确认目录权限" ;;
    *) ok "$backend" ;;
  esac
fi

echo "== 4. 凭证是否已配置 =="
if [ -x "$BRIDGE" ]; then
  if "$BRIDGE" doctor --db "${MI_FITNESS_DB_PATH:-$ROOT/data/mi_fitness.db}" 2>&1 | grep -q '已找到 Mi Fitness 凭据'; then
    ok "已找到凭据"
  else
    warn "还没配凭证：建 credentials.txt 后跑 tools/import_credentials.sh"
  fi
fi

echo "== 5. 报告脚本 / 数据目录 =="
[ -f "$ROOT/tools/daily_report.py" ] && ok "tools/daily_report.py" || bad "缺 tools/daily_report.py"
DB="${MI_FITNESS_DB_PATH:-$ROOT/data/mi_fitness.db}"
mkdir -p "$(dirname "$DB")" 2>/dev/null && ok "数据库目录可写：$(dirname "$DB")" || bad "数据库目录不可写"

echo
echo "== 把这段存成插件目录下的 config.local.json =="
echo "（路径是你这台机器的实际值；它已在 .gitignore 里，不会提交）"
cat <<EOF
{
  "wslDistro": "${WSL_DISTRO_NAME:-Ubuntu-24.04}",
  "pythonPath": "${PYBIN:-/path/to/.venv/bin/python}",
  "bridgePath": "${BRIDGE:-/path/to/.venv/bin/mi-fitness-bridge}",
  "reportScript": "${ROOT}/tools/daily_report.py",
  "dbPath": "${DB}",
  "autoSyncHours": 3,
  "autoSyncDays": 2,
  "syncTimeoutMs": 600000,
  "logFile": "E:\\\\AI\\\\state\\\\mihealthlink.log"
}
EOF

echo
if [ "$fail" -eq 0 ]; then
  echo "✓ 前置条件都满足"
else
  echo "✘ 有 $fail 项没满足，先按上面的提示处理"
fi
exit "$fail"
