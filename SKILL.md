---
name: taobao-tmall-price-tracker
description: 使用本机独立 Chrome 浏览器，采集已授权的淘宝/天猫商品详情页显示的优惠后价与优惠前价，生成 Excel 和价格历史 CSV。遇到验证或访问限制时停止并请求人工处理。
---

# 淘宝 / 天猫竞品价格追踪

此 Skill 负责执行**本地价格快照**，不提供远程云端代抓服务。使用 Windows PowerShell、Node.js 22+、Python 3.9+。

## 文件

- `scripts/ensure_chrome.ps1`：启动**独立 Chrome 配置**和本地 CDP 端口，不关闭日常浏览器
- `scripts/init_tasks.py`：源 Excel → `tasks.json`；广告链接无法解析时输出 `pending.json`
- `scripts/fetch_prices.mjs`：读取已登录页面的价格信息，输出 `competitor_images/results.json`
- `scripts/build_report.py`：输出每日 `.xlsx`、更新 `price_history.csv`
- `references/使用手册.md`：详细说明；`references/anti-risk.md`：安全与访问限制策略

## 前置检查

1. 用户已明确授权本机监控目标商品。
2. 检查 Windows + Chrome + Node.js 22+ + Python 3.9+；运行 `python -m pip install -r requirements.txt`。
3. 仅使用独立 Chrome 配置目录；**不读取日常 Chrome Profile / 不上传 Cookie / 不暴露本地调试端口到公网**。
4. 首次运行须用户自行登录淘宝、天猫。遇验证码和访问限制时，不得尝试绕过。
5. 任务清单 `tasks.json` 必须存在、商品链接已人工确认。

## 执行流程（从仓库根目录）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\ensure_chrome.ps1
python .\scripts\init_tasks.py "C:\path\products.xlsx" tasks.json
$env:TASKS="tasks.json"; $env:PORT="9224"; $env:IMG_DIR="competitor_images"; $env:RESUME="0"
node .\scripts\fetch_prices.mjs
python .\scripts\build_report.py .\competitor_images\results.json .\price_report_20261123.xlsx --tasks .\tasks.json --period 2026-11-23
```

日期需替换为本次运行日期。已有 `tasks.json` 时跳过初始化。首次采集新的一天必须 `RESUME=0`；同一天补抓失败列改为 `RESUME=1`。只补指定列可设 `ONLY=C,D`。

## 判定与汇报

- **优惠后价**优先匹配页面原文中的「优惠后 / 加补后 / 券后 / 到手价」，再使用结构化价格候选。
- **优惠前价**优先匹配「优惠前」，否则尝试预售价、原价或划线价。
- **缺失优惠价**：留空，不可将优惠前价冒充优惠后价。可有限重试一次；如果频繁发生，则停止并报告。
- **商品下架**：报告需要更换链接，不重复访问已经确认下架的页面。
- **出现访问限制/验证码**：不自动拖滑块、不用代理/打码平台；停止并由用户判断如何处理。
- **变化比较**：每日优惠后价保存在 `price_history.csv`，涨跌≥20%由报告脚本在控制台打印。
- **价格范围**：`build_report.py` 当前硬编码 20–5000 元，是原研究品类的校验假设，换品类要先检查。

## 数据隐私

`tasks.json`、`pending.json`、`competitor_images/`、`price_history.csv`、每日 Excel 均不应上传到公共 GitHub 仓库。具体配置参见 `.gitignore`。不把任何 Chrome 登录数据提交给 Git。

## 质量要求

每次交付需说明采集日期、成功商品数量、缺失价格数量、下架/异常页面、是否出现访问限制、涨跌≥20%的商品。必须明确价格为页面快照，不等同最终结算价。
