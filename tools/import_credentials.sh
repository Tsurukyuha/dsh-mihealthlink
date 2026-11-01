#!/usr/bin/env bash
# 从 credentials.txt 导入小米凭证到本地 keyring，导入成功后**立即删除**该文件
#
# credentials.txt 格式（两行）：
#   user_id=你的userId
#   passToken=你的passToken
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VPY="${MI_VENV_PY:-$ROOT/.venv/bin/python}"
CRED="${CRED_FILE:-$ROOT/credentials.txt}"
VPY="$VPY"

if [ ! -f "$CRED" ]; then
  echo "❌ 没找到 $CRED"
  echo "   请按 README 创建，两行：user_id=... 和 passToken=..."
  exit 1
fi
if [ ! -x "$VPY" ]; then
  echo "❌ 还没装依赖，先跑 ./install.sh"; exit 1
fi

"$VPY" - "$CRED" <<'PY'
import sys, pathlib
from mi_fitness_mcp.auth import save_mi_fitness_token
from mi_fitness_mcp.config import Config, save_config

p = pathlib.Path(sys.argv[1])
data = {}
for line in p.read_text(encoding='utf-8-sig', errors='replace').splitlines():
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    k, v = line.split('=', 1)
    data[k.strip().lower().replace('-', '_')] = v.strip()

uid = data.get('user_id') or data.get('userid') or ''
tok = data.get('pass_token') or data.get('passtoken') or ''
region = data.get('region') or 'cn'

if not uid or not tok:
    raise SystemExit('❌ credentials.txt 里缺 user_id 或 passToken')

save_mi_fitness_token(uid, tok)
save_config(Config(mode='mi_fitness_cloud', region=region))
print(f'✅ 凭证已写入 keyring（user_id {len(uid)} 字符，passToken {len(tok)} 字符，区域 {region}）')
p.unlink()
print('🧹 已删除 credentials.txt')
PY

echo
echo "== 体检 =="
"${MI_VENV_BIN:-$ROOT/.venv/bin}/mi-fitness-bridge" doctor --db "${MI_FITNESS_DB_PATH:-$ROOT/data/mi_fitness.db}"
