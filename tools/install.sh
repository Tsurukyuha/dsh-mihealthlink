#!/usr/bin/env bash
# 安装 mi_fitness_data_bridge 到本项目自己的 venv
#
# 网络不太好的话（国内直连 GitHub 常常断），按这个顺序尝试：
#   1) PyPI
#   2) 已有的本地源码（环境变量 MI_FITNESS_SRC 指向它）
#   3) GitHub 浅克隆（带重试）
#   4) GitHub 镜像克隆（gh-proxy）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

INDEX="${PIP_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"
REPO="https://github.com/shkyyy18/mi_fitness_data_bridge.git"
MIRROR="https://gh-proxy.com/https://github.com/shkyyy18/mi_fitness_data_bridge.git"
SRC_DIR="$ROOT/.deps/mi_fitness_data_bridge"

echo "== 检查 Python =="
PY="$(command -v python3.11 || command -v python3 || true)"
[ -n "$PY" ] || { echo "❌ 找不到 python（需要 3.11+）"; exit 1; }
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)' || {
  echo "❌ 需要 Python 3.11 以上，当前 $("$PY" -V 2>&1)"; exit 1; }
echo "✓ $("$PY" -V 2>&1)"

echo "== 建 venv =="
[ -d .venv ] || "$PY" -m venv .venv
VPY="$ROOT/.venv/bin/python"

pip_install() {
  if [ -x .venv/bin/pip ]; then
    .venv/bin/pip install -q "$@" --index-url "$INDEX"
  else
    uv pip install --python "$VPY" --index-url "$INDEX" "$@"
  fi
}

# 有 pip 就升级一下，没有就用 uv
if [ -x .venv/bin/pip ]; then
  .venv/bin/pip install -q --upgrade pip --index-url "$INDEX" || true
fi

echo "== 装 mi_fitness_data_bridge =="
ok=0
if pip_install "mi-fitness-data-bridge"; then
  echo "✓ 从 PyPI 安装成功"; ok=1
fi

if [ "$ok" -eq 0 ] && [ -n "${MI_FITNESS_SRC:-}" ] && [ -d "$MI_FITNESS_SRC" ]; then
  echo "→ 用本地源码：$MI_FITNESS_SRC"
  pip_install -e "$MI_FITNESS_SRC" && ok=1
fi

if [ "$ok" -eq 0 ]; then
  mkdir -p "$ROOT/.deps"
  if [ ! -d "$SRC_DIR/.git" ]; then
    for url in "$REPO" "$MIRROR"; do
      echo "→ 克隆 $url"
      if git clone --depth 1 "$url" "$SRC_DIR" 2>/dev/null; then break; fi
      rm -rf "$SRC_DIR"
    done
  fi
  if [ -d "$SRC_DIR" ]; then
    echo "→ 从源码安装"
    pip_install -e "$SRC_DIR" && ok=1
  fi
fi

if [ "$ok" -eq 0 ]; then
  echo "❌ 安装失败。可选办法："
  echo "   1) 手动 git clone 到本地后：MI_FITNESS_SRC=/path/to/repo ./install.sh"
  echo "   2) 换个能访问 GitHub 的网络重试"
  exit 1
fi

echo "== 检查 keyring 后端 =="
backend="$("$VPY" -c 'import keyring;b=keyring.get_keyring();print(type(b).__module__+"."+type(b).__name__)' 2>/dev/null || echo none)"
echo "  后端: $backend"
case "$backend" in
  *fail*|none)
    echo "  → 没有可用的钥匙串，自动装 keyrings.alt（明文存储在本地文件里）"
    pip_install keyrings.alt || true
    backend="$("$VPY" -c 'import keyring;b=keyring.get_keyring();print(type(b).__module__+"."+type(b).__name__)' 2>/dev/null || echo none)"
    echo "  现在: $backend"
    ;;
esac
case "$backend" in
  *Plaintext*)
    echo "  ⚠️  明文存储：passToken 会以文件形式落盘，请确保项目目录只有你可读"
    ;;
  *fail*|none)
    echo "  ❌ 仍然没有可用后端，凭证存不住；可在桌面环境用 gnome-keyring / kwallet 重试"
    ;;
esac

echo
echo "✓ 安装完成。下一步："
echo "   1) 按 README 取 userId / passToken，写进 credentials.txt"
echo "   2) ./import_credentials.sh"
echo "   3) ./sync.sh 7  &&  ./report.sh"
