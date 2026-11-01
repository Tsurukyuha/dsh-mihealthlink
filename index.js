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
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
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
  /** 自动同步拉多少天 */
  autoSyncDays: 2,
  /** 单次同步超时 */
  syncTimeoutMs: 600000,
  /** 事件日志（相对路径则落在当前工作目录） */
  logFile: 'mihealthlink.log',
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
      const days = Number(args.days) > 0 ? Math.floor(Number(args.days)) : 7
      const { start, end } = rangeForDays(days)
      log(cfg, '同步 ' + start + ' → ' + end)
      const r = await runCommand(
        cfg,
        [cfg.bridgePath, 'sync', '--start-date', start, '--end-date', end, '--db', cfg.dbPath],
        { timeoutMs: cfg.syncTimeoutMs, env: { MI_FITNESS_DB_PATH: cfg.dbPath } },
      )
      log(cfg, '同步结束 code=' + r.code)
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
    return JSON.parse(readFileSync(url, 'utf8'))
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

  const tick = makeAutoSync(cfg)
  if (cfg.autoSyncHours > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        void tick()
      }, cfg.autoSyncHours * 3600 * 1000)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }, 'dsh-mihealthlink: auto sync')
  }
}
