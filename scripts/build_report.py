#!/usr/bin/env python3
# 竞品价格日报生成器
#
# 用法：
#   python build_report.py competitor_images/results.json 竞品监控_鱼油_20261030.xlsx \
#       --imgdir competitor_images --tasks tasks.json --period 2026-10-30
#
# 表结构（列 = 品牌/产品，行 = 指标），行号固定不变：
#   第2行 B2     周期标签
#   第3行        品牌
#   第4行        网址链接
#   第5行        产品名称
#   第6行        优惠后价（页面「优惠后/加补后/券后/到手价」）
#   第7行        优惠前价（页面「优惠前」/划线价）
#
# 列顺序由 tasks.json 决定，并强制按列字母排序（C,D,...,Z,AA,AB...），
# 保证每天生成的表格列序完全一致；某天某列抓取失败也保留空位，不会错位。
#
# 价格口径：
#   优惠后：page.raw 原文「优惠后/加补后/补贴后/券后/到手价」> page.daoshou > page.main
#   优惠前：page.raw 原文「优惠前」> page.origin（划线价）
#
# 每次运行往 price_history.csv 追加一行（列=品牌列字母，行=日期），
# CSV 里记录的是优惠后价；涨跌只在控制台汇报，不占用表格行。
import json, os, csv, argparse, re
from openpyxl import Workbook
from openpyxl.utils import column_index_from_string
from openpyxl.styles import Alignment, Font

SHEET = '竞品监控'
LABEL_COL = 2

ROW_PERIOD = 2
ROW_BRAND = 3
ROW_URL = 4
ROW_TITLE = 5
ROW_AFTER = 6
ROW_BEFORE = 7

ROW_LABELS = [
    (ROW_BRAND, '品牌'),
    (ROW_URL, '网址链接'),
    (ROW_TITLE, '产品名称'),
    (ROW_AFTER, '优惠后价'),
    (ROW_BEFORE, '优惠前价'),
]

# 从价格区原文里直接读语义："平台加补后￥358优惠前￥539" -> 358 / 539
AFTER_PAT = re.compile(r'(?:优惠后|加补后|补贴后|券后价|券后|到手价|到手|折后价|折后|平台价)\s*[¥￥]?\s*(\d[\d,]*(?:\.\d{1,2})?)')
BEFORE_PAT = re.compile(r'优惠前\s*[¥￥]?\s*(\d[\d,]*(?:\.\d{1,2})?)')
# 严格版：整段就是「标签+价格」，后面没有任何别的字
# 预售页的价格区会把时间和价格粘在一起（"优惠后￥378" + "11.20点付定金" → "优惠后￥37811.920点付"），
# 只有严格匹配才能拆开，所以优先用它。
AFTER_EXACT = re.compile(r'^(?:优惠后|加补后|补贴后|券后价|券后|到手价|到手|折后价|折后|平台价)\s*[¥￥]?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*[起元]?$')
BEFORE_EXACT = re.compile(r'^优惠前\s*[¥￥]?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*[起元]?$')
# 预售期页面不写「优惠前」，只写「预售价」（= 到手价之前的原价），当成优惠前价
PRE_PAT = re.compile(r'(?:预售价|日常价|原价)\s*[¥￥]?\s*(\d[\d,]*(?:\.\d{1,2})?)')
PRE_EXACT = re.compile(r'^(?:预售价|日常价|原价)\s*[¥￥]?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*[起元]?$')
# 下限 20 元：鱼油类目不存在更低的价，低于此的一律是误抓
# （典型误抓：页面写「11月6日24点结束」，把 6 当成价格）
MIN_VALID = 20.0
# 上限 5000 元：本品类最贵的礼盒也不过千元，超过一定是把时间/规格粘进了价格
MAX_VALID = 5000.0

# 下架/失效：商品本身没了，换链接才有用，不要当成「抓取失败」反复重试
DOWN_PAT = re.compile(r'已下架|下架了|商品不存在|宝贝不存在|找不到该宝贝|商品已删除|商品过期|已失效|此商品无法购买|该宝贝已转移|页面不存在')
# 页面异常但商品可能还在：多半是反爬降级页或临时故障
BROKEN_PAT = re.compile(r'无法访问|找不到|出错|访问异常|访问存在异常|稍后再试')


def col_key(c):
    return (len(str(c)), str(c).upper())


def col_idx(l):
    return column_index_from_string(str(l).upper())


def _f(s):
    try:
        return float(str(s).replace(',', '').replace('¥', '').replace('￥', ''))
    except (TypeError, ValueError):
        return None


def ok(v):
    return v is not None and MIN_VALID <= v <= MAX_VALID


def from_raw(raws, pat, exact=None):
    """价格区原文优先：语义最明确，不会被页面上其它数字干扰。

    两轮：
      1. exact（整段＝标签+价格）—— 命中即返回，能避开预售页「价格+时间」粘连；
      2. 普通正则 —— 只接受落在 [MIN_VALID, MAX_VALID] 内的值，粘住的超大数字会被剔除。
    """
    raws = [str(t) for t in (raws or [])]
    if exact is not None:
        for t in raws:
            m = exact.match(t.strip())
            if m:
                v = _f(m.group(1))
                if ok(v):
                    return v
    for t in raws:
        for m in pat.finditer(t):
            v = _f(m.group(1))
            if ok(v):
                return v
    return None


def first_valid(arr):
    for v in (arr or []):
        f = _f(v)
        if ok(f):
            return f
    return None


def pick_after(r):
    """优惠后价：raw 原文「优惠后/加补后/券后/到手价」> daoshou > main > 旧版 pageprice"""
    page = r.get('page') or {}
    v = from_raw(page.get('raw'), AFTER_PAT, AFTER_EXACT)
    if v is not None:
        return v
    for key in ('daoshou', 'main'):
        f = first_valid(page.get(key))
        if f is not None:
            return f
    pp = r.get('pageprice')  # 兼容旧版 results.json
    if pp:
        f = _f(str(pp).split('|')[0])
        if ok(f):
            return f
    f = _f(r.get('price'))  # 最后兜底：AI 读头图价
    if ok(f):
        return f
    return None


def pick_before(r):
    """优惠前价：raw 原文「优惠前」>「预售价/原价」> page.origin（划线价）"""
    page = r.get('page') or {}
    v = from_raw(page.get('raw'), BEFORE_PAT, BEFORE_EXACT)
    if v is not None:
        return v
    v = from_raw(page.get('raw'), PRE_PAT, PRE_EXACT)
    if v is not None:
        return v
    return first_valid(page.get('origin'))


def load_prev_history(csv_path):
    prev = {}
    if not os.path.exists(csv_path):
        return prev
    try:
        with open(csv_path, encoding='utf-8-sig') as f:
            rows = list(csv.DictReader(f))
        if rows:
            for k, v in rows[-1].items():
                if str(k).lower() == 'date':
                    continue
                try:
                    prev[k] = float(v)
                except (TypeError, ValueError):
                    pass
    except Exception:
        pass
    return prev


def append_history(csv_path, period, prices):
    if not prices:
        return
    cols = sorted(prices.keys(), key=col_key)
    rows = []
    if os.path.exists(csv_path):
        try:
            with open(csv_path, encoding='utf-8-sig') as f:
                rows = [r for r in csv.DictReader(f)]
        except Exception:
            rows = []
    rows = [r for r in rows if r.get('date') != period]
    rows.append({'date': period, **{c: ('' if prices.get(c) is None else prices[c]) for c in cols}})
    allcols = ['date'] + sorted({k for r in rows for k in r.keys() if str(k).lower() != 'date'}, key=col_key)
    with open(csv_path, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=allcols)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, '') for k in allcols})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('results')
    ap.add_argument('out')
    ap.add_argument('--imgdir', default=os.environ.get('IMG_DIR', 'competitor_images'))
    ap.add_argument('--tasks', default=None)
    ap.add_argument('--period', default=os.environ.get('PERIOD', ''))
    ap.add_argument('--history', default=None, help='price_history.csv 路径，默认与 out 同目录')
    a = ap.parse_args()

    results = json.load(open(a.results, encoding='utf-8'))
    rmap = {r['col']: r for r in results}

    # 列顺序：优先按 tasks.json，并强制列字母排序，保证每天完全一致
    if a.tasks and os.path.exists(a.tasks):
        order = [t['col'] for t in json.load(open(a.tasks, encoding='utf-8'))]
    else:
        order = list(rmap.keys())
    order = sorted(set(order), key=col_key)

    period = a.period or os.path.basename(a.out).replace('.xlsx', '')
    hist = a.history or os.path.join(os.path.dirname(os.path.abspath(a.out)), 'price_history.csv')
    prev = load_prev_history(hist)

    prices, befores, titles, downs = {}, {}, {}, {}
    for c in order:
        r = rmap.get(c, {})
        prices[c] = pick_after(r)
        befores[c] = pick_before(r)
        t = r.get('title') or ''
        is_down = bool(r.get('down')) or bool(DOWN_PAT.search(t))
        if is_down:
            t = '已下架，需更换链接'
        elif BROKEN_PAT.search(t) or t.lower() in ('error', 'about:blank'):
            t = '链接失效，请检查'
        downs[c] = is_down
        titles[c] = t

    wb = Workbook()
    ws = wb.active
    ws.title = SHEET
    ws.cell(ROW_PERIOD, LABEL_COL, period)
    for row, lab in ROW_LABELS:
        ws.cell(row, LABEL_COL, lab)

    ws.column_dimensions['B'].width = 14
    for c in order:
        ws.column_dimensions[str(c).upper()].width = 18

    for c in order:
        ci = col_idx(c)
        r = rmap.get(c, {})
        ws.cell(ROW_BRAND, ci, r.get('brand', ''))
        items = r.get('items') or []
        if r.get('url'):
            ws.cell(ROW_URL, ci, r['url'])
        elif items:
            ws.cell(ROW_URL, ci, "\n".join(i.get('url', '') for i in items))
        ws.cell(ROW_TITLE, ci, titles.get(c, ''))
        ws.cell(ROW_AFTER, ci, prices[c] if prices[c] is not None else '')
        ws.cell(ROW_BEFORE, ci, befores[c] if befores[c] is not None else '')

    for rr in (ROW_BRAND, ROW_URL, ROW_TITLE, ROW_AFTER, ROW_BEFORE):
        for c in range(1, 60):
            cell = ws.cell(rr, c)
            if cell.value not in (None, ''):
                cell.alignment = Alignment(horizontal='left', vertical='top', wrap_text=True)
                cell.font = Font(size=9)
    ws.row_dimensions[ROW_BRAND].height = 24
    ws.row_dimensions[ROW_URL].height = 60
    ws.row_dimensions[ROW_TITLE].height = 45
    ws.row_dimensions[ROW_AFTER].height = 24
    ws.row_dimensions[ROW_BEFORE].height = 24

    wb.save(a.out)
    append_history(hist, period, prices)

    missing = [f"{c}({rmap.get(c, {}).get('brand', '?')})" for c in order if prices.get(c) is None]
    no_before = [f"{c}({rmap.get(c, {}).get('brand', '?')})" for c in order if befores.get(c) is None]
    blocked = [f"{c}({rmap.get(c, {}).get('brand', '?')})" for c in order if rmap.get(c, {}).get('blocked')]
    down_list = [f"{c}({rmap.get(c, {}).get('brand', '?')})" for c in order if downs.get(c)]
    dead = [f"{c}({rmap.get(c, {}).get('brand', '?')})" for c in order if titles.get(c) == '链接失效，请检查']
    changes = []
    for c in order:
        v, pv = prices.get(c), prev.get(c)
        if v is not None and pv and abs(v - pv) / pv >= 0.2:
            changes.append(f"{c} {rmap.get(c, {}).get('brand', '?')}: {pv} -> {v} ({(v - pv) / pv * 100:+.0f}%)")

    print("SAVED ->", a.out)
    print("HISTORY ->", hist)
    print("列数=%d 优惠后价=%d 优惠前价=%d" % (
        len(order),
        sum(1 for c in order if prices.get(c) is not None),
        sum(1 for c in order if befores.get(c) is not None)))
    if missing:
        print("PRICE_MISSING:", ", ".join(missing))
    if no_before:
        print("BEFORE_MISSING:", ", ".join(no_before))
    if blocked:
        print("BLOCKED:", ", ".join(blocked))
    if down_list:
        print("DOWN(已下架):", ", ".join(down_list))
    if dead:
        print("LINK_DEAD:", ", ".join(dead))
    if changes:
        print("BIG_CHANGE(>20%):", "; ".join(changes))


if __name__ == '__main__':
    main()
