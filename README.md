# dsh-mihealthlink

**让 DSH 里的 AI 伴侣读懂你的小米手环**：步数、睡眠、心率、血氧、压力同步到本地 SQLite，
一句话就能问「我昨晚睡得怎么样」。

不需要 root、不上传数据、不依赖手机端 App——只要手环的数据已经同步到小米云端。

> 抓数据依赖 [`shkyyy18/mi_fitness_data_bridge`](https://github.com/shkyyy18/mi_fitness_data_bridge)。
> 本项目是它的一层壳：**DSH 插件（四个工具）+ 一组命令行脚本**。

## 前置条件

| # | 条件 | 为什么 | 怎么确认 |
| --- | --- | --- | --- |
| 1 | **Windows + WSL2**，或 **Linux / macOS** | Windows 下插件通过 `wsl.exe` 调 WSL 里的 Python；其他平台直接调本地 Python | `wsl -l -v`（Windows） |
| 2 | **Python 3.11+** | 上游 `mi_fitness_data_bridge` 要求 | `python3 -V` |
| 3 | **DSH 桌面版**（插件形态） | 工具要注册进宿主 | 能正常对话 |
| 4 | 小米账号在 **cn 区**，手环数据**已上云** | 数据从云端拉，不是蓝牙读 | 打开 Mi Fitness App 看得到今天的步数 |
| 5 | 能拿到 `userId` / `passToken` | 云端鉴权 | 见「取凭证」 |
| 6 | 会改 profile 的 `package.json` | 插件要进 `dsh.profile.bundles` | 见「接进 DSH」 |

### 一键自检

装完依赖后在终端跑：

```bash
tools/check_env.sh
```

逐项检查 Python 版本、bridge、keyring、凭证、数据目录，**最后打印一段可直接存成
`config.local.json` 的 JSON**（路径是你这台机器的真实值）。退出码 0 = 全部满足。

### 平台差异

| 平台 | 插件形态 | 命令行 |
| --- | --- | --- |
| Windows + WSL2 | ✅ 走 `wsl.exe` | 在 WSL 里跑 `tools/*.sh` |
| Linux / macOS | ✅ 直接 spawn 本地 Python | ✅ |

Windows 下四个路径必须是 **WSL 内部路径**（`/home/...`、`/mnt/c/...`），
不能写 `C:\...`——那个路径 WSL 里不存在。

## 插件提供的工具

| 工具 | 作用 | 典型用法 |
| --- | --- | --- |
| `mi_health_status` | 体检：配置、凭证、连通性、可用数据类型（只读） | 「健康数据接上了吗」 |
| `mi_health_sync(days)` | 同步最近 N 天到本地库（默认 7，幂等） | 「更新一下我的数据」 |
| `mi_health_report(json?, days?)` | 完整日报：活动、睡眠、心率、趋势 | 「给我看看这周的情况」 |
| `mi_health_brief(days?)` | **一句话总结**，省 token | 「我昨晚睡得怎么样」 |
| `mi_health_nudge(dryRun?, force?)` | **主动关心**：按阈值检查后往 QQ 投一句提醒 | 「她会不会主动关心我」 |

`mi_health_brief` 的输出长这样：

```
昨天 2859 步，昨晚睡了 7 小时 50 分，心率均值 70.9 bpm。
```

后台还会**每 3 小时自动同步一次**（`autoSyncHours`，设 0 关闭）。

## 健康主动关心（可选）

默认**关闭**。开启后插件每 30 分钟检查一次本地库，够格就通过 SurfCore 的控制台接口
往指定 QQ 会话投一句「后台提醒」，让 AI 自己决定要不要开口、怎么开口。

### 什么时候会提醒

| 话题 | 触发条件 |
|---|---|
| `short-sleep` | 昨晚（今晨醒来）睡眠 < 6 小时 |
| `low-steps` | 连续两天步数 < 500，且已过 15:00 |
| `high-hr` | 最近一段心率均值 ≥ 95 bpm |

### 三道闸（防止变成骚扰机器人）

```
每天最多 1 条          nudgeMaxPerDay
只在 08:00~23:00 发    nudgeQuietStart / nudgeQuietEnd
同一话题 3 天内不重复   nudgeDedupeDays
```

### 配置

写在本机 `config.local.json`（**不要提交**）：

```json
{
  "nudgeEnabled": true,
  "nudgeKey": "private:你的QQ号",
  "nudgeUrl": "http://127.0.0.1:3100/api/console/notify-ai",
  "nudgeToken": "SurfCore 的 consoleToken",
  "nudgeScript": "/home/你/dsh-mihealthlink/tools/health_watch.py",
  "nudgeState": "/home/你/dsh-mihealthlink/data/health-watch.json"
}
```

闸门状态（今天发了几条、哪些话题说过）存在 `nudgeState` 指向的 JSON 里。

### 为什么投递在 Node 侧做

SurfCore 的桥接只听 `127.0.0.1:3100`，而 WSL 里的 `127.0.0.1` 是 WSL 自己，
**从 WSL 里请求会 Connection refused**。所以拆成三步：

```
WSL python  → 判断该不该发、发什么（--emit 输出 JSON）
Node 侧     → fetch 投递（Windows 上 127.0.0.1 才是对的）
WSL python  → --record-topic 记账
```

### 手动试

```
mi_health_nudge                 # 预演：只显示会说什么，不发
mi_health_nudge force=true      # 立刻真发一条（绕过时段和去重）
```
## 安装

### 1. Python 依赖

```bash
cd dsh-mihealthlink/tools
./install.sh
```

会建 `tools/.venv` → 装 `mi-fitness-data-bridge`（PyPI → 本地源码 → GitHub → 镜像逐级回退）
→ 没钥匙串时自动装 `keyrings.alt`。

> 中国大陆网络：这个包没发到 PyPI，最后会回退到 GitHub 克隆。如果直连很慢或超时，
> 先给终端设代理再跑，例如 `export https_proxy=http://127.0.0.1:7890`。

### 2. 配置你自己的路径

仓库里的 `cordis.patch.yml` 只有**占位符**（`/home/YOUR_USER/...`）。
**不要改那个文件**（升级会覆盖），改成在插件目录建 `config.local.json`：

```json
{
  "pythonPath": "/home/alice/mi-fitness/.venv/bin/python",
  "bridgePath": "/home/alice/mi-fitness/.venv/bin/mi-fitness-bridge",
  "reportScript": "/home/alice/dsh-mihealthlink/tools/daily_report.py",
  "dbPath": "/home/alice/dsh-mihealthlink/data/mi_fitness.db"
}
```

它在 `.gitignore` 里，优先级高于 `cordis.patch.yml`。用 `tools/check_env.sh` 直接生成。

> **为什么必须写绝对路径**：`~` 和 `$HOME` 不会展开——参数直接交给 `wsl.exe`，中间没有 shell。
>
> **配错的症状**：工具返回 `No such file or directory` 或 `code=-2`。

### 3. 接进 DSH

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
New-Item -ItemType Junction -Path "$prof\node_modules\dsh-mihealthlink" `
  -Target "E:\AI\projects\dsh-mihealthlink"
```

profile 的 `package.json` 里：

- `dependencies` 加 `"dsh-mihealthlink": "link:E:/AI/projects/dsh-mihealthlink"`
- `dsh.profile.bundles` 追加 `"dsh-mihealthlink"`

重启 DSH，工具就出现了。

## 取凭证（90% 的 issue 出在这一步）

### 1. 打开小米账号并登录

浏览器打开 <https://account.xiaomi.com>，用**跑手环的那个账号**登录。

### 2. 打开开发者工具

| 浏览器 | 快捷键 | 面板 |
| --- | --- | --- |
| Chrome / Edge | `F12` 或 `Ctrl+Shift+I` | **Application**（Chrome）/ **应用程序**（Edge） |
| Firefox | `F12` | **存储**（Storage） |

### 3. 找 Cookie

左侧展开 **Cookies** → 点 `https://account.xiaomi.com`，在右侧列表里找两行：

| 名字 | 形态 |
| --- | --- |
| `userId` | 纯数字，10 位左右 |
| `passToken` | 很长的一串（300+ 字符），可能含 `%` 和字母 |

### 4. 找不到怎么办

- 顶部搜索框直接搜 `passToken`，比翻列表快
- 如果只有 `serviceToken`，说明登录的不是小米账号体系——确认登的是 `account.xiaomi.com` 而不是某个米家子站
- 值太长复制不全，双击单元格全选再复制

### 5. 写进文件

在 `tools/` 下建 `credentials.txt`（**用记事本/编辑器写，别用命令行传参**）：

```
user_id=你的userId
passToken=你的passToken
```

然后：

```bash
tools/import_credentials.sh
```

它会写进系统 keyring、**立刻删除该文件**、再跑一次体检。
看到 `连接状态： ✅` 就成功了。

> ⚠️ `passToken` 等同于账号登录凭证。不要贴到聊天、issue、截图里。
> 泄露了就退出小米账号重新登录，旧 token 会失效。

## 命令行用法

```bash
tools/check_env.sh            # 自检 + 生成配置
tools/sync.sh                 # 最近 7 天
tools/sync.sh 30              # 最近 30 天
tools/sync.sh 2026-10-01 2026-11-01
tools/report.sh               # 日报
tools/report.sh --json        # 结构化
tools/report.sh --brief       # 一句话
```

数据库默认 `data/mi_fitness.db`，可用 `MI_FITNESS_DB_PATH` 覆盖。

## 已验证环境

- Windows 11 + WSL2 (Ubuntu 24.04) + Python 3.12
- 设备：小米手环，账号地区 `cn`
- 实测：8 天活动、985 条心率采样、9 段睡眠

其他平台按代码逻辑应当可用（直接 spawn 本地 Python），但**没有实机验证过**，
issue 里欢迎反馈。

## 数据都有什么

| 表 | 内容 |
| --- | --- |
| `daily_activity` | 步数、距离、活动卡路里、活动分钟（按天） |
| `sleep_sessions` | 睡眠会话、时长、分期、评分 |
| `heart_rate_samples` | 心率采样（含静息心率） |
| `spo2_samples` / `stress_samples` | 血氧、压力 |
| `workouts` / `workout_detail_samples` | 运动记录与明细曲线 |
| `body_measurements` | 体重 / 身体成分 |

**不是每种数据都有**：取决于设备、固件、账号地区。同步成功但 0 条，通常就是设备不上报这类数据。

## 常见问题

**同步回来 0 条**

- 手环没和手机同步过 → 先在 Mi Fitness App 里同步一次
- 账号地区不是 cn → `credentials.txt` 里加一行 `region=cn`

**`passToken` 粘贴不进终端**

`getpass` 的隐藏输入在某些终端（尤其经 `wsl.exe` 转发）收不到剪贴板。
本项目走文件导入就是为了绕开它。

**keyring 报不安全 / 不可用**

无桌面的 Linux 没有系统钥匙串。`install.sh` 会装 `keyrings.alt`（**明文存储**），
请确认目录权限，或改用 gnome-keyring / kwallet。

**睡眠没有评分**

上游不一定给评分。本项目不估算，缺就显示「上游无评分」。

**工具报 `code=-2` 或 `No such file`**

`config.local.json` 里的路径不对。跑 `tools/check_env.sh` 重新生成。

## 隐私边界

- 只读写你自己账号的数据，只落本地 SQLite
- 不提供上传、分享、云同步
- `.gitignore` 已排除数据库、导出物、凭证文件、`config.local.json`

## 免责声明

- **非官方项目**：与小米公司无关，未获授权或背书。使用的是**非公开接口**，随时可能失效。
- **账号风险**：自动拉取属于账号非常规访问，理论上存在被限制或封禁的可能。
  作者不承担由此产生的任何后果，请自行评估后使用。
- **健康数据不是医疗建议**：本项目只做数据搬运与展示，不提供诊断、治疗或用药建议。
  身体不适请就医。
- **数据安全由你负责**：`passToken` 与数据库都在你本机，泄露风险的防护是你的责任
  （磁盘加密、目录权限、不要把库文件传给第三方）。
- **上游许可**：`mi_fitness_data_bridge` 为 AGPL-3.0，本项目通过命令行调用，不修改其源码。

## 许可

本封装代码 MIT。
