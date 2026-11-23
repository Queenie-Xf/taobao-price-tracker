# Taobao / Tmall Price Tracker

**基于 Chrome DevTools Protocol (CDP) 的淘宝 / 天猫商品价格监控 Skill**，用于研究商品详情页的价格提取、竞品监控和历史价格分析。

> 非淘宝 / 天猫官方工具，未使用官方定价 API。页面结构、账户状态、促销规则和区域差异均可能影响结果。请遵守平台规则，仅在获授权的场景下使用；不保证每天都能采集成功。

## Features / 功能

- **价格语义提取**：识别优惠后价、券后价、平台补贴后价和优惠前价等页面文案；同时提供 DOM 与新版页面结构化字段的回退提取。
- **每日价格快照**：将品牌、商品名、商品链接、优惠后价、优惠前价导出为 Excel。
- **历史趋势**：记录优惠后价到 `price_history.csv`，控制台报告相对上一次记录涨跌达到 20% 的商品。
- **异常处理**：区分下架、访问异常和疑似缺失优惠价的页面；发生验证码或限制时停止并交由用户处理，而不是自动破解。
- **断点续跑**：支持按 Excel 列字母选取商品重跑，保留已经成功采集的数据。
- **AI Skill**：`SKILL.md` 可供支持该格式的 Agent 阅读并编排任务。所有脚本也可以独立使用。

## Workflow / 数据流

```text
商品清单 Excel ── init_tasks.py ──> tasks.json
                                        │
已登录的独立 Chrome ── CDP ── fetch_prices.mjs
                                        │
                             competitor_images/results.json
                                        │
                                build_report.py
                                   /       \
                        每日 Excel      price_history.csv
```

## Prerequisites / 环境

- Windows 10/11 + Google Chrome（提供的 PowerShell 启动器仅支持 Windows）
- **Node.js 22+**（用内置 `WebSocket`；不需要 npm 依赖）
- Python 3.9+、`openpyxl`
- 可手动登录淘宝 / 天猫的浏览器会话

**安全提示**：启动器使用独立 Chrome 配置目录 `%LOCALAPPDATA%\TaobaoPriceTracker\ChromeProfile`，不会关闭你日常 Chrome 或读取默认配置。CDP 只监听 `127.0.0.1:9224`。调试端口允许本机进程控制该浏览器，因此不要暴露到公网、不要在这个独立配置中登录无关网站。首次需要手动登录淘宝。若本机已有程序占用 9224，请确认其来源或更换端口。

## Quick start / 快速开始（PowerShell）

```powershell
# 1. Clone and install Python dependencies
 git clone https://github.com/<YOUR_USERNAME>/taobao-price-tracker.git
 cd taobao-price-tracker
 python -m venv .venv
 .\.venv\Scripts\python.exe -m pip install -r requirements.txt

# 2. Launch a separate Chrome (first time: log in to Taobao manually)
 powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\ensure_chrome.ps1

# 3A. Create tasks from your Excel (columns A group, B output col, C brand, D URL)
 .\.venv\Scripts\python.exe .\scripts\init_tasks.py "C:\path\products.xlsx" tasks.json

# Or 3B. Manually create tasks.json using examples/tasks.example.json as a template

# 4. Collect today's prices (RESUME=0 is important for a new day)
 $env:TASKS="tasks.json"
 $env:PORT="9224"
 $env:IMG_DIR="competitor_images"
 $env:RESUME="0"
 node .\scripts\fetch_prices.mjs

# 5. Build report; use the same date for file name and --period
 .\.venv\Scripts\python.exe .\scripts\build_report.py `
    .\competitor_images\results.json .\price_report_20261123.xlsx `
    --tasks .\tasks.json --period 2026-11-23
```

日期 `2026-11-23` 只是示例；实际运行请换成当天日期。`tasks.json` 中的商品 ID 也需要替换成真实商品链接。

**第二次补抓**：将 `$env:RESUME="1"`，自动跳过已有成功记录。下一天首次运行务必恢复 `RESUME=0`，否则可能错把昨天的结果当作当天数据。

## Input and output / 输入输出

Excel 源表从第 2 行开始：

| A | B | C | D |
|---|---|---|---|
| 分组 | 输出列字母 | 品牌 | 商品详情页 URL |
| 示例品类 | C | 示例品牌A | `https://detail.tmall.com/item.htm?id=...` |

若原始 URL 属于广告跳转链且无法解析，`init_tasks.py` 会生成 `pending.json`，需人工填充商品直链。

生成的监控表固定为**每列一个商品、每行一个指标**：

| 行 | 指标 |
|---|---|
| 2 | 日期（B2） |
| 3 | 品牌 |
| 4 | 商品 URL |
| 5 | 商品标题 |
| 6 | 优惠后价 |
| 7 | 优惠前价 |

`price_history.csv`：一行一个日期、一列一个商品，保存该次运行的优惠后价。所有运行产物均被 `.gitignore` 忽略。**注意：缺失价不意味着价格为零；不同规格、领券资格或账号可能显示不同到手价。**

## Configuration / 主要参数

| 参数 | 默认值 | 用途 |
|---|---|---|
| `TASKS` | `./tasks.json` | 任务列表路径 |
| `PORT` | `9224` | 抓取器连接的本地 CDP 端口 |
| `CDP_PORT` | `9224` | Chrome 启动器监听的本地 CDP 端口 |
| `IMG_DIR` | `competitor_images` | 存放 `results.json` 和可选商品图片 |
| `RESUME` | `1` | `0` 强制重采；`1` 跳过已成功的列 |
| `ONLY` | 空 | 只采集指定列，如 `C,D` |
| `NO_IMAGE` | `1` | 不下载商品图片；`0` 开启可选下载 |
| `MIN_GAP` / `MAX_GAP` | `12000` / `25000` | 商品间等待（毫秒） |
| `MAX_BLOCKED` | `3` | 最多容忍的访问限制事件数量 |
| `TRACKER_CHROME_PROFILE` | 独立目录 | 指定专用 Chrome 用户配置目录 |

商品价格范围校验在 `scripts/build_report.py` 中配置（当前 `MIN_VALID=20`，`MAX_VALID=5000`，基于原鱼油竞品研究）。**监控其他价格区间的品类时必须调整这两个参数**，否则真实价格可能被排除。

## Repo structure / 项目结构

```text
taobao-price-tracker/
├── README.md
├── SKILL.md                       # Agent 使用说明
├── requirements.txt
├── .gitignore
├── scripts/
│   ├── ensure_chrome.ps1         # 启动独立的 CDP Chrome
│   ├── init_tasks.py             # Excel → tasks.json
│   ├── fetch_prices.mjs          # Chrome 页面采集
│   └── build_report.py           # JSON → Excel + 历史 CSV
├── examples/
│   ├── tasks.example.json
│   └── README.md
├── tests/
│   └── test_price_parsing.py
└── references/
    ├── 使用手册.md
    └── anti-risk.md
```

## Notes / 限制与伦理

- 页面价格是采集时点的快照，不保证等于结算页最终实付款；优惠券、会员折扣、地区、SKU 和促销期均可能影响数据。
- 价格抽取依赖页面内容，天猫 / 淘宝改版后可能需要调整解析规则。
- 脚本不自动处理验证码或突破平台访问限制。出现限制应停止操作并按照平台要求人工处理。
- 本仓库不包含任何真实用户 Cookie、企业商品名单、账号、价格采集结果或 Chrome 配置。
- 每日调度需要你自己配置 Windows Task Scheduler 或兼容的 Agent 调度器，仓库不会自动帮你创建系统任务。

## Documentation

详细运行说明见 [`references/使用手册.md`](references/使用手册.md)；Agent 工作流见 [`SKILL.md`](SKILL.md)。

## License

暂未指定开源许可证。若计划允许他人复制、修改或分发，请自行选择许可证（例如 MIT），并确认代码的使用授权。
