#!/usr/bin/env python3
"""小米运动健康 · 本地日报

从 mi_fitness_data_bridge 的 SQLite 里读数据，输出人类可读的摘要（或 JSON）。

用法：
    python daily_report.py --db /mnt/e/AI/data/mi-fitness/mi_fitness.db
    python daily_report.py --db ... --json
    python daily_report.py --db ... --days 7
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import date, datetime, timedelta


def q(cur, sql, params=()):
    try:
        return cur.execute(sql, params).fetchall()
    except sqlite3.Error:
        return []


def collect(db: str, days: int) -> dict:
    c = sqlite3.connect(db)
    cur = c.cursor()
    today = date.today()
    since = (today - timedelta(days=days - 1)).isoformat()

    out: dict = {"date": today.isoformat(), "since": since}

    # 今日活动（daily_activity 按 date 存）
    row = q(cur, "select steps, distance_m, active_kcal, active_minutes from daily_activity where date=?",
            (today.isoformat(),))
    if row:
        s, d, k, m = row[0]
        out["today_activity"] = {
            "steps": s, "distance_km": round((d or 0) / 1000, 2),
            "active_kcal": round(k or 0, 1), "active_minutes": m,
        }
    else:
        out["today_activity"] = None

    # 最近一次主睡眠（非小睡）
    # ⚠️ 同一次睡眠会被多次同步反复「更新」（同 start_at、时长递增），
    #    只按 start_at 排序会随机取到早期的短版本（实测取到 305 分钟，
    #    而真实的整觉是 614 分钟）——所以再按 duration 降序取最长的那条。
    row = q(cur, """select substr(start_at,1,10), substr(start_at,12,5), substr(end_at,12,5),
                           duration_minutes, time_asleep_minutes, sleep_score
                    from sleep_sessions where coalesce(is_nap,0)=0
                    order by start_at desc, duration_minutes desc limit 1""")
    if row:
        d, s, e, dur, asleep, score = row[0]
        out["last_sleep"] = {
            "wake_date": d, "start": s, "end": e,
            "duration_minutes": dur, "asleep_minutes": asleep,
            "score": score,
        }
    else:
        out["last_sleep"] = None

    # 近 N 天步数
    rows = q(cur, "select date, steps from daily_activity where date>=? order by date", (since,))
    out["steps_by_day"] = {d: s for d, s in rows}

    # 近 N 天睡眠时长
    rows = q(cur, """select substr(start_at,1,10), duration_minutes, sleep_score
                     from sleep_sessions where coalesce(is_nap,0)=0 and substr(start_at,1,10)>=?
                     order by start_at""", (since,))
    out["sleep_by_day"] = [
        {"date": d, "minutes": m, "score": s} for d, m, s in rows
    ]

    # 最近一天心率分布
    rows = q(cur, """select substr(timestamp,1,10) as d, min(bpm), avg(bpm), max(bpm), count(*)
                     from heart_rate_samples group by d order by d desc limit 3""")
    out["heart_rate"] = [
        {"date": d, "min": mn, "avg": round(av or 0, 1), "max": mx, "samples": n}
        for d, mn, av, mx, n in rows
    ]

    c.close()
    return out


def render(d: dict) -> str:
    L = []
    L.append(f"小米运动健康 · {d['date']}")
    L.append("=" * 30)

    a = d.get("today_activity")
    if a:
        L.append(f"今日活动：{a['steps']} 步 · {a['distance_km']} km · 活动 {a['active_minutes'] if a['active_minutes'] is not None else '—'} 分钟 · 消耗 {a['active_kcal']} kcal")
    else:
        L.append("今日活动：暂无数据（手环还没同步，或今天还没过完）")

    s = d.get("last_sleep")
    if s:
        h, m = divmod(s["duration_minutes"] or 0, 60)
        score = f"，评分 {s['score']}" if s.get("score") is not None else "，上游无评分"
        L.append(f"最近一觉：{s['wake_date']} 醒来 · {s['start']}→{s['end']} · {h} 小时 {m} 分{score}")
    else:
        L.append("最近一觉：暂无数据")

    hr = d.get("heart_rate") or []
    if hr:
        latest = hr[0]
        L.append(f"心率（{latest['date']}）：{latest['min']}–{latest['max']} bpm，均值 {latest['avg']}，{latest['samples']} 个采样")

    steps = d.get("steps_by_day") or {}
    if steps:
        L.append("")
        L.append("近几天步数：")
        for k, v in sorted(steps.items())[-7:]:
            L.append(f"  {k}  {v:>6} 步")

    sleeps = d.get("sleep_by_day") or []
    if sleeps:
        L.append("")
        L.append("近几次睡眠：")
        for s in sleeps[-7:]:
            if s["minutes"]:
                h, m = divmod(s["minutes"], 60)
                sc = f" 评分 {s['score']}" if s.get("score") is not None else ""
                L.append(f"  {s['date']}  {h}h{m:02d}m{sc}")

    return "\n".join(L)


def render_brief(d: dict) -> str:
    """一句话总结：给聊天用，省 token，不做诊断。"""
    bits = []
    a = d.get("today_activity") or {}
    steps = a.get("steps") or 0
    # 早上步数还很少时不值得说"今天走了 107 步"，改用昨天的
    if steps >= 500:
        bits.append(f"今天 {steps} 步")
        if a.get("distance_km"):
            bits.append(f"{a['distance_km']} 公里")
    else:
        yesterday = sorted((d.get("steps_by_day") or {}).items())
        if len(yesterday) >= 2:
            prev = yesterday[-2]
            if prev[1]:
                bits.append(f"昨天 {prev[1]} 步")

    s = d.get("last_sleep")
    if s and s.get("duration_minutes"):
        h, m = divmod(s["duration_minutes"], 60)
        dur = (f"{h} 小时 {m} 分" if h else f"{m} 分钟")
        line = f"昨晚睡了 {dur}"
        if s.get("score") is not None:
            line += f"（评分 {s['score']}）"
        bits.append(line)

    hr = (d.get("heart_rate") or [])[:1]
    if hr and hr[0].get("samples"):
        bits.append(f"心率均值 {hr[0]['avg']} bpm")

    if not bits:
        return "本地还没有可用的健康数据：先跑一次同步（mi_health_sync），或确认手环已经和手机同步过。"

    return "，".join(bits) + "。"


def main() -> int:
    ap = argparse.ArgumentParser(description="小米运动健康本地日报")
    ap.add_argument("--db", default="./data/mi_fitness.db")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--brief", action="store_true", help="只输出一句话总结")
    args = ap.parse_args()

    try:
        data = collect(args.db, args.days)
    except sqlite3.OperationalError as e:
        print(f"读不到数据库：{e}", file=sys.stderr)
        return 1

    if args.brief:
        print(render_brief(data))
    elif args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(render(data))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
