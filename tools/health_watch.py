#!/usr/bin/env python3
"""健康主动关心 · 判断 + 闸门 + 投递

读取本地库，挑一个值得说的点，用「后台提醒」的形式投给她的 QQ。
所有闸门（时段/每日条数/去重）都在这里，插件只负责定时调用。

用法：
    # 只看会说什么，不发送
    python health_watch.py --db ... --state ... --dry-run

    # 真的发
    python health_watch.py --db ... --state ... \
        --notify-url http://127.0.0.1:3100/api/console/notify-ai \
        --token XXX --key private:201236582
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from daily_report import collect  # noqa: E402


# ---------------------------------------------------------------- 阈值与文案 --

# 演示用的事实（只有 --demo 时才用，消息里会带【演示】标记，避免被当成真实数据）
DEMO_FACTS = {
    "short-sleep": ("昨晚只睡了 4 小时 52 分", "顺口提一句，别像闹钟。"),
    "low-steps": ("连着两天没怎么动，今天到现在 312 步", "关心一句，别劝运动劝得太生硬。"),
    "high-hr": ("最近一段静息心率偏高（98 bpm）", "关心一下状态，别下诊断。"),
}

def candidates(data: dict, days_steps: dict, sec_cfg: dict) -> list[dict]:
    """所有够格的关心点，按优先级排序（短睡 > 久坐 > 心率）。"""
    sleep_min = sec_cfg.get("sleepMinHours", 6) * 60
    steps_min = sec_cfg.get("stepsMinPerDay", 500)
    h = datetime.now().hour
    out: list[dict] = []

    s = data.get("last_sleep")
    if s and s.get("duration_minutes"):
        dur = s["duration_minutes"]
        # 只对「今天凌晨醒来」的睡眠说，别把前天的翻出来
        if s.get("wake_date") == date.today().isoformat() and dur < sleep_min:
            hh, mm = divmod(int(dur), 60)
            out.append({
                "topic": "short-sleep",
                "facts": f"昨晚只睡了 {hh} 小时 {mm} 分",
                "hint": "顺口提一句，别像闹钟，也别复述数据，语气自然些。",
            })

    # 连续两天步数都很低
    low = [d for d, v in sorted(days_steps.items())[-2:] if v is not None and v < steps_min]
    if len(low) >= 2 and h >= 15:
        latest = sorted(days_steps.items())[-1][1]
        out.append({
            "topic": "low-steps",
            "facts": f"连着两天没怎么动，今天到现在 {latest} 步",
            "hint": "可以关心一句，别劝运动劝得太生硬。",
        })

    hr = (data.get("heart_rate") or [])[:1]
    if hr and hr[0].get("avg") and hr[0]["avg"] >= sec_cfg.get("hrAlarm", 95):
        out.append({
            "topic": "high-hr",
            "facts": f"最近一段心率均值偏高（{hr[0]['avg']} bpm）",
            "hint": "关心一下状态，别下诊断。",
        })
    return out


def pick_issue(data: dict, days_steps: dict, sec_cfg: dict, only: str | None = None) -> dict | None:
    """按优先级挑一个；only 指定话题时只返回那个（不够格就 None）。"""
    found = candidates(data, days_steps, sec_cfg)
    if only:
        return next((c for c in found if c["topic"] == only), None)
    return found[0] if found else None


def build_message(issue: dict) -> str:
    return (
        "【健康手环】{facts}。\n"
        "{hint}\n"
        "（这条来自本地手环数据的自动检查，不是群友发言。如果你觉得这时间点不合适，"
        "可以直接收尾，不要发出去。）"
    ).format(**issue)


# -------------------------------------------------------------------- 闸门 --

def load_state(path: str) -> dict:
    try:
        return json.loads(open(path, encoding="utf-8").read())
    except Exception:
        return {}


def save_state(path: str, st: dict) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def gate(st: dict, issue: dict, cfg: dict) -> str | None:
    """返回 None 表示可以发；否则返回拒绝原因。"""
    now = datetime.now()
    if not (cfg.get("quietStart", 8) <= now.hour < cfg.get("quietEnd", 23)):
        return f"不在允许时段（{cfg.get('quietStart', 8)}:00~{cfg.get('quietEnd', 23)}:00）"

    today = now.date().isoformat()
    if st.get("last_date") == today and st.get("count_today", 0) >= cfg.get("maxPerDay", 1):
        return f"今天已经发过 {st.get('count_today')} 条"

    seen = (st.get("topics") or {}).get(issue["topic"])
    if seen:
        age = (now.date() - date.fromisoformat(seen)).days
        if age < cfg.get("dedupeDays", 3):
            return f"这个话题 {age} 天前刚提过（去重 {cfg.get('dedupeDays', 3)} 天）"
    return None


# -------------------------------------------------------------------- 投递 --

def post(url: str, token: str, key: str, message: str, timeout: float = 30.0) -> dict:
    body = json.dumps({"key": key, "message": message}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json", "x-console-token": token},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "ignore"))


def days_steps(db: str, n: int = 3) -> dict:
    import sqlite3
    c = sqlite3.connect(db)
    since = (date.today() - timedelta(days=n - 1)).isoformat()
    try:
        rows = c.execute(
            "select date, steps from daily_activity where date>=? order by date", (since,)
        ).fetchall()
    except Exception:
        rows = []
    return {d: s for d, s in rows}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--notify-url")
    ap.add_argument("--token")
    ap.add_argument("--key", default="private:201236582")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--sleep-min-hours", type=float, default=6)
    ap.add_argument("--steps-min", type=int, default=500)
    ap.add_argument("--max-per-day", type=int, default=1)
    ap.add_argument("--dedupe-days", type=int, default=3)
    ap.add_argument("--quiet-start", type=int, default=8)
    ap.add_argument("--quiet-end", type=int, default=23)
    ap.add_argument("--force", action="store_true", help="忽略时段与去重，只用于测试")
    # 插件用这两个：emit 只输出决定（JSON），record 在真正发出去之后记账
    ap.add_argument("--emit", action="store_true", help="输出 JSON 决定，不发送")
    ap.add_argument("--record-topic", help="记账：把某个话题标记为今天已发")
    ap.add_argument("--topic", help="只针对某个话题（short-sleep / low-steps / high-hr）")
    ap.add_argument("--demo", action="store_true", help="演示模式：用示例事实，消息里会标明【演示】")
    a = ap.parse_args()

    if a.record_topic:
        st = load_state(a.state)
        today = date.today().isoformat()
        st["last_date"] = today
        st["count_today"] = (st.get("count_today", 0) + 1) if st.get("last_date") == today else 1
        st.setdefault("topics", {})[a.record_topic] = today
        st["last_sent_at"] = int(time.time())
        save_state(a.state, st)
        print("RECORDED")
        return 0

    cfg = {
        "sleepMinHours": a.sleep_min_hours, "stepsMinPerDay": a.steps_min,
        "maxPerDay": a.max_per_day, "dedupeDays": a.dedupe_days,
        "quietStart": a.quiet_start, "quietEnd": a.quiet_end,
    }

    data = collect(a.db, 3)
    if a.demo:
        facts, hint = DEMO_FACTS.get(a.topic, ("示例数据", "随便说一句。"))
        issue = {"topic": a.topic or "demo", "facts": "【演示】" + facts, "hint": hint}
    else:
        issue = pick_issue(data, days_steps(a.db), cfg, only=a.topic)
    if not issue:
        if a.emit:
            print(json.dumps({"action": "none"}, ensure_ascii=False))
        else:
            print("NO_ISSUE")
        return 0

    st = load_state(a.state)
    why = None if a.force else gate(st, issue, cfg)
    msg = build_message(issue)

    if a.emit:
        print(json.dumps({
            "action": "send" if not why else "skip",
            "topic": issue["topic"],
            "message": msg,
            "reason": why,
            "key": a.key,
        }, ensure_ascii=False))
        return 0

    if why:
        print(f"SKIP: {why}")
        print("--- 本来会发 ---")
        print(msg)
        return 0

    if a.dry_run or not (a.notify_url and a.token):
        print("DRY_RUN")
        print(msg)
        return 0

    try:
        res = post(a.notify_url, a.token, a.key, msg)
    except Exception as e:
        print(f"ERROR: {e}")
        return 2

    if not res.get("ok"):
        print(f"ERROR: {json.dumps(res, ensure_ascii=False)}")
        return 3

    today = date.today().isoformat()
    st["last_date"] = today
    st["count_today"] = (st.get("count_today", 0) + 1) if st.get("last_date") == today else 1
    st.setdefault("topics", {})[issue["topic"]] = today
    st["last_sent_at"] = int(time.time())
    st["history"] = (st.get("history") or [])[-20:] + [
        {"ts": int(time.time()), "topic": issue["topic"], "text": msg[:200]}
    ]
    save_state(a.state, st)
    print(f"SENT: {issue['topic']}")
    print(msg)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
