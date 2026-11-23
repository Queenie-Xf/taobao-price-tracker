#!/usr/bin/env python3
# 从用户源表生成 tasks.json
#
# 源表约定（Sheet1，第 1 行表头）：
#   A 列 = 分组    B 列 = 落表列字母    C 列 = 品牌    D 列 = 商品链接
#
# 用法：
#   python init_tasks.py "C:\path\源表.xlsx" tasks.json [--sheet Sheet1] [--start-row 2]
#
# 处理：
#   1. click.simba.taobao.com 直通车广告链接 -> 尽量还原 detail.tmall.com/item.htm?id=xxx
#      （明文带 &id= 的能还原；无法还原的单独列到 pending.json，需要人工打开后复制地址栏 URL）
#   2. 某行没填列字母时，从最后一列往后顺延（并记进 pending.json 供确认）
import json, os, re, sys, argparse, urllib.parse
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter, column_index_from_string


def clean_simba(u):
    """把 simba 广告链还原成商品直链；失败返回 None"""
    if 'click.simba.taobao.com' not in u and 'click.tanx.com' not in u and 'simba.taobao' not in u:
        return u.strip()
    dec = urllib.parse.unquote(u)
    m = re.search(r'[?&]id=(\d+)', u) or re.search(r'[?&]id=(\d+)', dec)
    if m:
        return f"https://detail.tmall.com/item.htm?id={m.group(1)}"
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('out', nargs='?', default='tasks.json')
    ap.add_argument('--sheet', default=None)
    ap.add_argument('--start-row', type=int, default=2)
    ap.add_argument('--col-brand', default='C')
    ap.add_argument('--col-url', default='D')
    ap.add_argument('--col-letter', default='B')
    ap.add_argument('--col-group', default='A')
    a = ap.parse_args()

    wb = load_workbook(a.src, data_only=True)
    ws = wb[a.sheet] if a.sheet else wb.worksheets[0]

    ib = column_index_from_string(a.col_brand)
    iu = column_index_from_string(a.col_url)
    il = column_index_from_string(a.col_letter)
    ig = column_index_from_string(a.col_group)

    tasks, pending = [], []
    max_ci = 2  # 从 C 列开始放产品
    for r in range(a.start_row, ws.max_row + 1):
        url = ws.cell(r, iu).value
        if not url:
            continue
        url = str(url).strip()
        brand = (ws.cell(r, ib).value or '').strip() if ws.cell(r, ib).value else ''
        letter = (ws.cell(r, il).value or '').strip().upper() if ws.cell(r, il).value else ''
        group = (ws.cell(r, ig).value or '').strip() if ws.cell(r, ig).value else ''

        fixed = clean_simba(url)
        if fixed is None:
            pending.append({'row': r, 'brand': brand or '(未填)', 'col': letter or '(未填)',
                            'reason': 'simba 广告链无商品 id，无法还原', 'url': url[:120]})
            continue

        if not letter:
            max_ci += 1
            letter = get_column_letter(max_ci)
            pending.append({'row': r, 'brand': brand or '(未填)', 'col': letter,
                            'reason': '源表未填列字母，已自动顺延', 'url': fixed[:120]})
        max_ci = max(max_ci, column_index_from_string(letter))

        tasks.append({'section': 1, 'col': letter, 'brand': brand or f'品牌{letter}',
                      'group': group, 'items': [{'url': fixed}]})

    json.dump(tasks, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f"WROTE {a.out}  tasks={len(tasks)}")
    if pending:
        p = os.path.join(os.path.dirname(os.path.abspath(a.out)), 'pending.json')
        json.dump(pending, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print(f"PENDING {len(pending)} -> {p}")
        for x in pending:
            print('  ', x['row'], x['col'], x['brand'], x['reason'])
    cols = sorted({t['col'] for t in tasks}, key=lambda c: (len(c), c))
    print('COLS:', ','.join(cols))


if __name__ == '__main__':
    main()
