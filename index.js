/**
 * dsh-mihealthlink —— 把小米运动健康（Mi Fitness）接进 DSH
 *
 * 四个工具：
 *   mi_health_status()                配置/连通性体检（只读，不抓数）
 *   mi_health_sync(days?)             从云端同步最近 N 天到本地 SQLite
 *   mi_health_report(json?, days?)    读本地库出日报（文本 / JSON）
 *   mi_health_brief(days?)            一句话总结（省 token，直接能说出口）
 *
 * 后台：每 autoSyncHours 小时自动同步一次（默认 3 小时，0 关闭）。
 *
 * 跨平台：Windows 下通过 wsl.exe 调 WSL 里的 Python；Linux / macOS 直接调本地 Python。
 * 抓数据那层是上游的 mi-fitness-bridge（Python），本插件只做封装与措辞。
 */

import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'dsh-mihealthlink'
export const inject = ['tools']

const IS_WIN = process.platform === 'win32'

export const DEFAULTS = {
  /** Windows 下用哪个 WSL 发行版。非 Windows 忽略此项。 */
  wslDistro: 'Ubuntu-24.04',
  /**
   * 下面四个都是占位符：`~` / `$HOME` 不会展开（参数直接交给 wsl.exe，没有 shell），
   * 必须写绝对路径。推荐在插件目录建 config.local.json（已被 .gitignore 排除）。
   */
  pythonPath: '/home/YOUR_USER/mi-fitness/.venv/bin/python',
  bridgePath: '/home/YOUR_USER/mi-fitness/.venv/bin/mi-fitness-bridge',
  reportScript: '/home/YOUR_USER/dsh-mihealthlink/tools/daily_report.py',
  dbPath: '/home/YOUR_USER/dsh-mihealthlink/data/mi_fitness.db',
  /** 自动同步间隔（小时），0 = 关闭 */
  autoSyncHours: 3,
  /**
   * 启动后先补一次同步（true = 开）。
   * 为什么必须有：定时器是「进程启动后 N 小时」才会第一次触发，而 DSH 的
   * 重启频率远高于 3 小时 —— 只有 setInterval 的话，自动同步可能永远不执行，
   * 库里的数据会一直停在最后一次手动同步。这里启动后先跑一次，之后才按间隔走。
   */
  autoSyncOnStart: true,
  /** 启动后多久跑第一次（毫秒）；留一点余量，避免和 DSH 启动阶段抢资源 */
  autoSyncInitialDelayMs: 120000,
  /** 自动同步拉多少天 */
  autoSyncDays: 2,
  /** 单次同步超时 */
  syncTimeoutMs: 600000,
  /** 事件日志（相对路径则落在当前工作目录） */
  logFile: 'mihealthlink.log',

  /* ------------------------------------------------------------ 主动关心 -- */
  /**
   * 健康主动关心：定时读本地库，够格就把一句话投给她的 QQ。
   * 默认关闭 —— 需要本机在 config.local.json 里打开并填 nudgeToken。
   */
  nudgeEnabled: false,
  /** 判断脚本（占位符，同上面的路径规则） */
  nudgeScript: '/home/YOUR_USER/dsh-mihealthlink/tools/health_watch.py',
  /** 闸门状态文件（记录今天发了几条、哪些话题说过） */
  nudgeState: 'health-watch.json',
  /** SurfCore 的后台提醒接口 */
  nudgeUrl: 'http://127.0.0.1:3100/api/console/notify-ai',
  /** 投给谁（group:群号 或 private:QQ号） */
  nudgeKey: 'private:201236582',
  /** 控制台令牌，放 config.local.json，不要提交 */
  nudgeToken: '',
  /** 检查间隔（分钟） */
  nudgeIntervalMinutes: 30,
  /** 睡眠少于这个小时数就提 */
  sleepMinHours: 6,
  /** 单日步数低于这个值算「没怎么动」 */
  stepsMinPerDay: 500,
  /** 每天最多发几条 */
  nudgeMaxPerDay: 1,
  /** 同一话题多少天内不重复 */
  nudgeDedupeDays: 3,
  /** 允许发送的时段（小时，左闭右开） */
  nudgeQuietStart: 8,
  nudgeQuietEnd: 23,
  /**
   * 手动/工具触发的同步最小间隔（毫秒）。默认 4 小时（2026-11-01 用户定）。
   * 为什么要有：mi_health_sync 是唯一真的会打小米云端的工具，放行给 QQ 会话后
   * 她可能连着问几次；小米那边会限流，撞上之后一整天都同步不了。
   * 自动同步不受这道闸限制（它自己就是 3 小时一次）。
   */
  minSyncIntervalMs: 4 * 3600 * 1000,
  /** 上次同步时间记在哪（相对路径则落在当前工作目录） */
  syncStateFile: 'mihealthlink-sync.json',
}

/* ----------------------------------------------------------------- 基础设施 -- */

function log(cfg, line) {
  try {
    mkdirSync(dirname(cfg.logFile), { recursive: true })
    appendFileSync(cfg.logFile, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {
    /* 日志写不了不影响主流程 */
  }
}

/** 把 CLI 的报错翻译成「用户该怎么办」。返回 null 表示没识别出来。 */
function friendlyHint(text) {
  const t = String(text || '')
  if (/频繁|rate.?limit|429|too many/i.test(t)) {
    return '小米接口在限流，等几分钟再试；不要连续重试。'
  }
  if (/token|Token|401|403|auth|过期|expired/i.test(t) && /❌|error|失败/i.test(t)) {
    return '凭证可能过期了。重新从浏览器取 passToken，再跑一次 tools/import_credentials.sh。'
  }
  if (/未找到配置|not_configured|请运行 .*setup|未找到 Mi Fitness 凭据/i.test(t)) {
    return '还没配置凭证。看 README「取凭证」：建 tools/credentials.txt 后跑 tools/import_credentials.sh。'
  }
  if (/ENOENT|No such file|命令没有输出|not found/i.test(t)) {
    return '路径不对：检查 config.local.json 里的 pythonPath / bridgePath / reportScript 是否为绝对路径、文件是否存在。'
  }
  if (/keyring|钥匙串/i.test(t)) {
    return '钥匙串不可用：在 tools/.venv 里装 keyrings.alt（明文存储），或改用 gnome-keyring / kwallet。'
  }
  return null
}

/**
 * 跑一条命令。
 * Windows → wsl.exe -d <distro> -- ...（参数用数组，不拼字符串：
 *   shell 会把带空格的命令重新切词，表现为「没执行但退出码是 0」）
 * 其他平台 → 直接 spawn。
 */
function runCommand(cfg, argv, { timeoutMs = 60000, env = {} } = {}) {
  return new Promise((resolve) => {
    let file
    let args
    let spawnOpts = { windowsHide: true }

    if (IS_WIN) {
      const envArgs = Object.entries(env).flatMap(([k, v]) => [`${k}=${v}`])
      file = 'wsl.exe'
      args = ['-d', cfg.wslDistro, '--']
      if (envArgs.length > 0) args.push('env', ...envArgs)
      args.push(...argv)
    } else {
      file = argv[0]
      args = argv.slice(1)
      spawnOpts = { windowsHide: true, env: { ...process.env, ...env } }
    }

    const child = spawn(file, args, spawnOpts)
    let out = ''
    let err = ''
    let done = false
    const finish = (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, stdout: out.trim(), stderr: err.trim() })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish(-1)
    }, timeoutMs)

    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', (e) => {
      err += String(e?.message ?? e)
      finish(-2)
    })
    child.on('close', (code) => finish(code ?? 0))
  })
}

/** 统一收尾：输出 + 该怎么做，拼成一条对模型友好的消息 */
function shape(r) {
  const text = (r.stdout || r.stderr || '').trim()
  if (!text) {
    return {
      ok: false,
      message: '命令没有输出（退出码 ' + r.code + '）。检查 config.local.json 里的路径是否指向真实文件。',
    }
  }
  // 只有真的失败（非零退出码，或输出里有 ❌）才翻译报错。
  // 否则 doctor 里的 ⚠️ 警告（比如"keyring 是明文存储"）会被误判成失败。
  const looksBad = r.code !== 0 || /❌/.test(text)
  const hint = looksBad ? friendlyHint(text) : null
  return { ok: !looksBad, message: hint ? text + '\n\n👉 ' + hint : text }
}

function isoDate(d) {
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/* ------------------------------------------------------- 同步节流（状态文件） -- */

function readSyncState(cfg) {
  try {
    const data = JSON.parse(readFileSync(cfg.syncStateFile, 'utf8'))
    return { lastAt: Number(data?.lastAt) || 0, lastKind: String(data?.lastKind ?? '') }
  } catch {
    return { lastAt: 0, lastKind: '' }
  }
}

function writeSyncState(cfg, kind) {
  try {
    mkdirSync(dirname(cfg.syncStateFile), { recursive: true })
    writeFileSync(
      cfg.syncStateFile,
      JSON.stringify({ lastAt: Date.now(), lastKind: kind, at: new Date().toISOString() }, null, 2),
      'utf8',
    )
  } catch {
    /* 状态写不了不影响同步本身 */
  }
}

/** 距上次同步还有多久（毫秒）；0 = 现在就可以。 */
function syncCooldownLeft(cfg) {
  const min = Number(cfg.minSyncIntervalMs)
  if (!(min > 0)) return 0
  const { lastAt } = readSyncState(cfg)
  if (!lastAt) return 0
  return Math.max(0, lastAt + min - Date.now())
}

function humanWait(ms) {
  const minutes = Math.ceil(ms / 60000)
  if (minutes < 60) return minutes + ' 分钟'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return hours + ' 小时' + (rest ? ' ' + rest + ' 分钟' : '')
}

function rangeForDays(days) {
  const end = new Date()
  const start = new Date(end.getTime() - (Math.max(1, days) - 1) * 86400000)
  return { start: isoDate(start), end: isoDate(end) }
}

/* --------------------------------------------------------------------- 工具 -- */

export function statusTool(cfg) {
  return {
    name: 'mi_health_status',
    description:
      '检查小米运动健康数据的本地接入是否正常：配置是否加载、凭证是否在、云端能不能连、'
      + '数据库在哪、支持哪些数据类型。只读，不会拉数据。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
        required: ['ok', 'message'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    async execute() {
      const r = await runCommand(cfg, [cfg.bridgePath, 'doctor', '--db', cfg.dbPath], { timeoutMs: 60000 })
      const shaped = shape(r)
      return { ok: shaped.ok && /连接状态：\s*✅/.test(shaped.message), message: shaped.message }
    },
  }
}

export function syncTool(cfg) {
  return {
    name: 'mi_health_sync',
    description:
      '把小米运动健康的步数、睡眠、心率等同步到本地 SQLite。默认拉最近 7 天；'
      + '同一日期范围重复同步是幂等的，不会产生重复记录。要分析最近状态或出日报前，先跑它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { days: { type: 'number', description: '拉最近多少天，默认 7' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
        required: ['ok', 'message'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    async execute(args = {}) {
      // 节流：这道闸只挡「工具触发的同步」，自动同步走 makeAutoSync 的 tick，不经过这里。
      const left = syncCooldownLeft(cfg)
      if (left > 0) {
        const last = readSyncState(cfg)
        return {
          ok: false,
          message:
            '刚同步过（' + new Date(last.lastAt).toLocaleString('zh-CN') + '），'
            + '为了不撞小米云端限流，' + humanWait(left) + '后才可以再同步。\n'
            + '库里的数据是新的，直接看就行：mi_health_brief / mi_health_report。',
        }
      }
      const days = Number(args.days) > 0 ? Math.floor(Number(args.days)) : 7
      const { start, end } = rangeForDays(days)
      log(cfg, '同步 ' + start + ' → ' + end)
      const r = await runCommand(
        cfg,
        [cfg.bridgePath, 'sync', '--start-date', start, '--end-date', end, '--db', cfg.dbPath],
        { timeoutMs: cfg.syncTimeoutMs, env: { MI_FITNESS_DB_PATH: cfg.dbPath } },
      )
      log(cfg, '同步结束 code=' + r.code)
      if (r.code === 0) writeSyncState(cfg, 'tool')
      return shape(r)
    },
  }
}

export function reportTool(cfg) {
  return {
    name: 'mi_health_report',
    description:
      '读本地数据库，生成小米运动健康的日报：今日步数/距离、最近一觉的时长与评分、'
      + '心率区间、最近几天趋势。不联网。要结构化数据传给别的程序时用 json=true。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        json: { type: 'boolean', description: 'true 返回原始 JSON（给程序用），默认人类可读文本' },
        days: { type: 'number', description: '趋势回看多少天，默认 7' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
        required: ['ok', 'message'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    async execute(args = {}) {
      const days = Number(args.days) > 0 ? Math.floor(Number(args.days)) : 7
      const argv = [cfg.pythonPath, cfg.reportScript, '--db', cfg.dbPath, '--days', String(days)]
      if (args.json) argv.push('--json')
      return shape(await runCommand(cfg, argv, { timeoutMs: 60000 }))
    },
  }
}

export function briefTool(cfg) {
  return {
    name: 'mi_health_brief',
    description:
      '用一句话总结最近的身体状态（步数、睡眠、心率），直接可以说出口。'
      + '比 mi_health_report 省 token，适合日常关心、聊天里顺口提一句。数据不足时会明确说缺什么。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { days: { type: 'number', description: '回看多少天，默认 2（昨天+今天）' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
        required: ['ok', 'message'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    async execute(args = {}) {
      const days = Number(args.days) > 0 ? Math.floor(Number(args.days)) : 2
      const argv = [cfg.pythonPath, cfg.reportScript, '--db', cfg.dbPath, '--days', String(days), '--brief']
      return shape(await runCommand(cfg, argv, { timeoutMs: 60000 }))
    },
  }
}

/* ------------------------------------------------------------------- 巡检 -- */

/** 跑一次健康检查，拿脚本给出的「决定」（不发送） */
async function decideNudge(cfg, { force = false } = {}) {
  const argv = [
    cfg.pythonPath, cfg.nudgeScript,
    '--db', cfg.dbPath,
    '--state', cfg.nudgeState,
    '--key', cfg.nudgeKey,
    '--sleep-min-hours', String(cfg.sleepMinHours),
    '--steps-min', String(cfg.stepsMinPerDay),
    '--max-per-day', String(cfg.nudgeMaxPerDay),
    '--dedupe-days', String(cfg.nudgeDedupeDays),
    '--quiet-start', String(cfg.nudgeQuietStart),
    '--quiet-end', String(cfg.nudgeQuietEnd),
    '--emit',
  ]
  if (force) argv.push('--force')
  const r = await runCommand(cfg, argv, { timeoutMs: 90000 })
  const text = (r.stdout || '').trim()
  const line = text.split('\n').find((l) => l.trim().startsWith('{'))
  if (!line) return { action: 'error', reason: text || (r.stderr || '').trim() || `退出码 ${r.code}` }
  try {
    return JSON.parse(line)
  } catch (error) {
    return { action: 'error', reason: '解析脚本输出失败：' + (error?.message ?? error) }
  }
}

/** 记账：告诉脚本「这条已经发出去了」 */
async function recordNudge(cfg, topic) {
  await runCommand(
    cfg,
    [cfg.pythonPath, cfg.nudgeScript, '--db', cfg.dbPath, '--state', cfg.nudgeState, '--record-topic', topic],
    { timeoutMs: 60000 },
  )
}

/**
 * 投递。
 * ⚠️ 这一步必须在 Node 侧（Windows）做：桥接只听 127.0.0.1:3100，
 * 而 WSL 里的 127.0.0.1 是 WSL 自己，连不上（实测 Connection refused）。
 */
async function postNudge(cfg, message) {
  const res = await fetch(cfg.nudgeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-console-token': cfg.nudgeToken },
    body: JSON.stringify({ key: cfg.nudgeKey, message }),
  })
  const body = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(body)
  } catch {
    /* 非 JSON 就当失败 */
  }
  if (!res.ok || !parsed?.ok) throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`)
  return parsed
}

/** 完整动作：判断 → 发送 → 记账 */
async function runNudge(cfg, { dryRun = false, force = false } = {}) {
  if (!dryRun && !force && !cfg.nudgeEnabled) {
    return { ok: false, message: '主动关心是关着的（nudgeEnabled=false）' }
  }
  const d = await decideNudge(cfg, { force })
  if (d.action === 'none') return { ok: true, message: '数据不够，没有值得提醒的事。' }
  if (d.action === 'error') return { ok: false, message: '判断脚本出错：' + d.reason }
  if (d.action === 'skip') return { ok: true, message: `这次不发（${d.reason}）。\n\n本来会说：\n${d.message}` }
  if (dryRun) return { ok: true, message: `[预演] 会发给 ${d.key}：\n\n${d.message}` }

  if (!cfg.nudgeToken) {
    return { ok: false, message: '缺少 nudgeToken（在 config.local.json 里填 SurfCore 的 consoleToken）' }
  }
  try {
    await postNudge(cfg, d.message)
  } catch (error) {
    return { ok: false, message: '投递失败：' + (error?.message ?? error) }
  }
  await recordNudge(cfg, d.topic)
  return { ok: true, message: `已发送（${d.topic}）：\n\n${d.message}` }
}

export function nudgeTool(cfg) {
  return {
    name: 'mi_health_nudge',
    description:
      '健康和主动关心：按阈值检查睡眠/步数/心率，够格就通过 SurfCore 投一句话到她的 QQ 私聊。'
      + '默认只预演（dryRun=true，不打扰人）；force=true 才忽略时段和去重直接发。'
      + '内置闸门：每天最多 N 条、只在工作时段发、同一话题几天内不重复。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dryRun: { type: 'boolean', description: 'true（默认）= 只显示会发什么，不真的发' },
        force: { type: 'boolean', description: 'true = 忽略时段/去重/开关（测试用，会真的发出去）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
        required: ['ok', 'message'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    async execute(args = {}) {
      const dryRun = args.dryRun === undefined ? true : Boolean(args.dryRun)
      return runNudge(cfg, { dryRun, force: Boolean(args.force) })
    },
  }
}

function makeNudgeLoop(cfg) {
  let busy = false
  return async function tick() {
    if (busy || !cfg.nudgeEnabled || !cfg.nudgeToken) return
    busy = true
    try {
      const r = await runNudge(cfg)
      log(cfg, '主动关心：' + (r.message || '').slice(0, 200).replace(/\n+/g, ' '))
    } catch (error) {
      log(cfg, '主动关心异常：' + (error?.message ?? error))
    } finally {
      busy = false
    }
  }
}

function makeAutoSync(cfg) {
  let busy = false
  return async function tick() {
    if (busy) return
    const hours = Number(cfg.autoSyncHours)
    if (!(hours > 0)) return
    busy = true
    try {
      const { start, end } = rangeForDays(Number(cfg.autoSyncDays) || 2)
      const r = await runCommand(
        cfg,
        [cfg.bridgePath, 'sync', '--start-date', start, '--end-date', end, '--db', cfg.dbPath],
        { timeoutMs: cfg.syncTimeoutMs, env: { MI_FITNESS_DB_PATH: cfg.dbPath } },
      )
      const summary = (r.stdout || '').split('\n').filter((l) => l.includes('✅')).join(' / ')
      if (r.code === 0) writeSyncState(cfg, 'auto')
      log(cfg, '自动同步 ' + start + '→' + end + ' code=' + r.code + ' ' + summary)
    } catch (error) {
      log(cfg, '自动同步异常：' + (error?.message ?? error))
    } finally {
      busy = false
    }
  }
}

/* ------------------------------------------------------------------ apply -- */

/** 本机覆盖：仓库里是占位符，真实路径写在 config.local.json（已被 .gitignore 排除） */
function loadLocalConfig() {
  try {
    const url = new URL('./config.local.json', import.meta.url)
    // 去掉 BOM：Windows 记事本/PowerShell 存 UTF-8 时经常带 BOM，JSON.parse 会直接抛。
    return JSON.parse(readFileSync(url, 'utf8').replace(/^\\uFEFF/, ''))
  } catch {
    return {}
  }
}

export function apply(ctx, rawConfig = {}) {
  // 优先级：DEFAULTS ← cordis 配置 ← config.local.json（本机覆盖）
  const cfg = { ...DEFAULTS, ...rawConfig, ...loadLocalConfig() }
  cfg.autoSyncHours = Number(cfg.autoSyncHours)
  if (!Number.isFinite(cfg.autoSyncHours)) cfg.autoSyncHours = DEFAULTS.autoSyncHours

  log(cfg, '插件已加载（平台=' + process.platform + '，自动同步每 ' + (cfg.autoSyncHours || '关闭') + ' 小时）')

  ctx.effect(() => ctx.tools.register(statusTool(cfg)), 'dsh-mihealthlink: status')
  ctx.effect(() => ctx.tools.register(syncTool(cfg)), 'dsh-mihealthlink: sync')
  ctx.effect(() => ctx.tools.register(reportTool(cfg)), 'dsh-mihealthlink: report')
  ctx.effect(() => ctx.tools.register(briefTool(cfg)), 'dsh-mihealthlink: brief')
  ctx.effect(() => ctx.tools.register(nudgeTool(cfg)), 'dsh-mihealthlink: nudge')

  // 主动关心：每 nudgeIntervalMinutes 检查一次（脚本内部还有时段/条数/去重三道闸）
  const nudge = makeNudgeLoop(cfg)
  const nudgeMinutes = Number(cfg.nudgeIntervalMinutes)
  if (cfg.nudgeEnabled && nudgeMinutes > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        void nudge()
      }, nudgeMinutes * 60 * 1000)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }, 'dsh-mihealthlink: nudge loop')
    log(cfg, `主动关心已开启（每 ${nudgeMinutes} 分钟检查一次，投给 ${cfg.nudgeKey}）`)
  }

  const tick = makeAutoSync(cfg)
  if (cfg.autoSyncHours > 0) {
    ctx.effect(() => {
      let timer = null
      let first = null
      const everyMs = cfg.autoSyncHours * 3600 * 1000
      const startInterval = () => {
        timer = setInterval(() => {
          void tick()
        }, everyMs)
        if (typeof timer.unref === 'function') timer.unref()
      }
      if (cfg.autoSyncOnStart) {
        const delay = Number(cfg.autoSyncInitialDelayMs)
        first = setTimeout(() => {
          log(cfg, '启动补同步（距上次手动同步可能已经很久）')
          void tick().finally(startInterval)
        }, Number.isFinite(delay) && delay >= 0 ? delay : DEFAULTS.autoSyncInitialDelayMs)
        if (typeof first.unref === 'function') first.unref()
      } else {
        startInterval()
      }
      return () => {
        if (first) clearTimeout(first)
        if (timer) clearInterval(timer)
      }
    }, 'dsh-mihealthlink: auto sync')
  }
}
