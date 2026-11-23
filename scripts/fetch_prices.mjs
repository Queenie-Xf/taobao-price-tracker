#!/usr/bin/env node
// 淘宝/天猫商品价格采集器 —— 防风控优先
//
// 设计原则：宁可慢，不可被拦。被拦一次的代价（人工过滑块 + 当天数据缺口）
// 远大于多花 10 分钟。
//
// 用法：
//   node fetch_prices.mjs
//   TASKS=tasks.json PORT=9224 IMG_DIR=competitor_images node fetch_prices.mjs
//   ONLY=C,D,E node fetch_prices.mjs          # 只跑指定列
//   NO_IMAGE=0 node fetch_prices.mjs          # 恢复下载头图（默认不抓图，只要价格）
//   RESUME=0 node fetch_prices.mjs            # 忽略已有结果，全部重跑
//
// 可调参数（环境变量）：
//   MIN_GAP / MAX_GAP  每个商品之间的随机间隔毫秒，默认 12000 / 25000
//   LONG_REST_EVERY    每 N 个商品长休一次，默认 5
//   LONG_REST_MS       长休时长毫秒，默认 70000
//   MAX_BLOCKED        连续/累计被拦多少次后整体停手，默认 3
//   COOLDOWN_MIN       被拦后冷却分钟数，默认 6
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';

const PORT = process.env.PORT || 9224;
const OUT = process.env.IMG_DIR || 'competitor_images';
const TASKS = process.env.TASKS || path.join(process.cwd(), 'tasks.json');
const ONLY = (process.env.ONLY || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const RESUME = process.env.RESUME !== '0';
const NO_IMAGE = process.env.NO_IMAGE !== '0'; // 默认不抓头图（只要价格）；NO_IMAGE=0 可恢复抓图
const MIN_GAP = +(process.env.MIN_GAP || 12000);
const MAX_GAP = +(process.env.MAX_GAP || 25000);
const LONG_REST_EVERY = +(process.env.LONG_REST_EVERY || 5);
const LONG_REST_MS = +(process.env.LONG_REST_MS || 70000);
const MAX_BLOCKED = +(process.env.MAX_BLOCKED || 3);
const COOLDOWN_MIN = +(process.env.COOLDOWN_MIN || 6);

fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const log = (...a) => console.log(...a);
const httpGet = u => new Promise((res, rej) => {
  http.get(u, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)); }).on('error', rej);
});

// ---------- CDP ----------
class CDP {
  constructor(ws) { this.ws = new WebSocket(ws); this.id = 0; this.pending = new Map(); this.sid = null; }
  open() {
    return new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = e => rej(e);
      this.ws.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id != null && this.pending.has(m.id)) { const fn = this.pending.get(m.id); this.pending.delete(m.id); fn(m); }
      };
    });
  }
  send(method, params = {}, sid = null, timeout = 45000) {
    const id = ++this.id; const msg = { id, method, params }; if (sid) msg.sessionId = sid;
    return new Promise((res, rej) => {
      this.pending.set(id, res);
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, timeout);
    });
  }
  async eval(js) {
    const r = await this.send('Runtime.evaluate', { expression: js, returnByValue: true, awaitPromise: true }, this.sid);
    if (r.result && r.result.exceptionDetails) throw new Error('EVAL ' + JSON.stringify((r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description) || r.result.exceptionDetails.text));
    return r.result && r.result.result && r.result.result.value;
  }
  // 导航单独放宽到 75s：双 11 期间促销页很重，45s 会假超时
  async nav(url) { await this.send('Page.navigate', { url }, this.sid, 75000); }
}

// ---------- 页面提取脚本 ----------
// 价格多策略提取：
//   1) 新版详情页（ice-container）结构化数据 __ICE_APP_CONTEXT__ —— 类名已被哈希化，
//      只有这里的价格字段是稳定的（2025-11 起天猫全量切新版，class*="price" 已失效）
//   2) 旧版页面：到手价/券后关键词 > 主价格区 > 划线价旁
const PRICE_JS = `(() => {
  const out = { daoshou: [], main: [], origin: [], raw: [] };
  // 取数字，跳过日期/时间/折扣上下文（"11月6日24点结束"里的 6、24 不能当价格）
  const num = (t) => {
    const s = String(t == null ? '' : t).replace(/[\\s,，]/g, '');
    const re = /(\\d{1,6}(?:\\.\\d{1,2})?)/g;
    let m;
    while ((m = re.exec(s))) {
      const tail = s.slice(m.index + m[0].length, m.index + m[0].length + 2);
      const head = s.slice(Math.max(0, m.index - 1), m.index);
      if (/^[月日点年时折%期天]/.test(tail)) continue;
      if (/[月日点年时折%期天号]/.test(head)) continue;
      return m[1];
    }
    return null;
  };
  const push = (arr, v) => { v = String(v == null ? '' : v); if (v && !arr.includes(v)) arr.push(v); };

  // ---- 1) 页面价格区原文（口径优先）----
  // 促销引擎跑完后正文会写清「平台加补后￥369起 优惠前￥539」，与历史口径一致；
  // 新版页面类名虽被哈希化，正文文本依然可靠，所以放在最前面。
  const body = document.body ? (document.body.innerText || '') : '';
  // 到手价语义词：命中的数字优先级最高（"店铺优惠后/平台加补后/券后/到手价…"）
  ['到手价','到手','券后价','券后','折后价','折后','优惠后','加补后','补贴后','预估到手','预估','促销价','限时价','秒杀价','活动价','狂欢价'].forEach(k => {
    let i = -1, guard = 0;
    while ((i = body.indexOf(k, i + 1)) >= 0 && guard++ < 6) {
      const seg = body.slice(i, i + 40).replace(/\\n/g, ' ');
      const v = num(seg.replace(k, ''));
      if (v) push(out.daoshou, v, k);
    }
  });
  document.querySelectorAll('[class*="rice"],[class*="Price"],[class*="price"],[data-price]').forEach(e => {
    const t = (e.textContent || '').trim();
    if (!t || t.length > 40) return;
    const v = num(t);
    if (!v) return;
    const cls = String(e.className || '').slice(0, 50);
    const dp = e.getAttribute && e.getAttribute('data-price');
    if (dp) push(out.main, num(dp), 'data-price');
    if (/highlight|main|now|current|real|promo|discount/i.test(cls)) push(out.main, v, cls);
    else if (/origin|old|line|del|market/i.test(cls)) push(out.origin, v, cls);
    else push(out.main, v, cls);
    push(out.raw, t.replace(/\\s+/g, '').slice(0, 20), cls);
  });
  // 划线/原价语义词
  const body2 = document.body ? (document.body.innerText || '') : '';
  ['优惠前','原价','专柜价','市场价','日常价'].forEach(k => {
    let i = -1, guard = 0;
    while ((i = body2.indexOf(k, i + 1)) >= 0 && guard++ < 4) {
      const v = num(body2.slice(i, i + 30).replace(k, ''));
      if (v) push(out.origin, v, k);
    }
  });
  document.querySelectorAll('del,s,[class*="origin"],[class*="OldPrice"],[class*="marketPrice"]').forEach(e => {
    const v = num(e.textContent || ''); if (v) push(out.origin, v, 'del');
  });

  // ---- 2) 新版结构化数据（ICE）兜底 ----
  // 促销价被降级（页面只显示「优惠前」+「登录查看更多优惠」）时，正文里没有优惠后价，
  // 只能从页面 JSON 里取；多规格商品会有多个「优惠前」价，只取第一个，避免口径被带偏。
  try {
    const ctx = window.__ICE_APP_CONTEXT__ || {};
    const home = (ctx.loaderData && ctx.loaderData.home) || {};
    const res = (home.data && home.data.res) || {};
    let gotAfter = (out.daoshou || []).length > 0, gotBefore = (out.origin || []).length > 0;
    const addPrice = (t, v) => {
      const n = num(v);
      if (!n || parseFloat(n) <= 0) return;
      const isAfter = /优惠后|加补后|补贴后|券后|到手|折后|活动价|促销价/.test(t || '');
      const isBefore = /优惠前|原价|专柜价|市场价|日常价/.test(t || '');
      if (isAfter && gotAfter) return;
      if (isBefore && gotBefore) return;
      push(out.raw, (t ? t : '') + '￥' + n);
      if (isAfter) { push(out.daoshou, n); gotAfter = true; }
      else if (isBefore) { push(out.origin, n); gotBefore = true; }
      else push(out.main, n);
    };
    // 2a) 固定路径（priceVO 是主价格区）
    const pv = (res.componentsVO && res.componentsVO.priceVO) || {};
    if (pv.price) addPrice(pv.price.priceTitle, pv.price.priceText || pv.price.priceMoney);
    if (pv.promotionPrice) addPrice(pv.promotionPrice.priceTitle, pv.promotionPrice.priceText || pv.promotionPrice.priceMoney);
    if (pv.originPrice) addPrice(pv.originPrice.priceTitle || '原价', pv.originPrice.priceText || pv.originPrice.priceMoney);
    // 2b) 全量遍历兜底：任何带 priceTitle + priceText 的对象都算（结构变动也能扛住）
    if (!gotAfter || !gotBefore) {
      const hits = [];
      const collect = (o, d) => {
        if (!o || typeof o !== 'object' || d > 14 || hits.length >= 40) return;
        if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) collect(o[i], d + 1); return; }
        if (typeof o.priceTitle === 'string' && (o.priceText != null || o.priceMoney != null)) hits.push(o);
        for (const k in o) { const v = o[k]; if (v && typeof v === 'object') collect(v, d + 1); }
      };
      collect(ctx, 0);
      for (let i = 0; i < hits.length && (!gotAfter || !gotBefore); i++) {
        const h = hits[i];
        addPrice(h.priceTitle, h.priceText != null ? h.priceText : h.priceMoney);
      }
    }
    // 2c) 划线价/下单价只做核对，不参与语义匹配（写进 raw 供人工核对）
    const pb = (res.pcTrade && res.pcTrade.pcBuyParams) || {};
    if (pb.current_price) push(out.raw, '划线价￥' + num(pb.current_price));
    if (pb.buy_now) push(out.raw, '下单价￥' + num(pb.buy_now));
  } catch (e) { }

  out.daoshou = out.daoshou.slice(0, 4);
  out.main = out.main.slice(0, 6);
  out.origin = out.origin.slice(0, 4);
  out.raw = out.raw.slice(0, 8);
  return out;
})()`;

const TITLE_JS = `(() => {
  const t = document.title || '';
  const m = document.querySelector('meta[property="og:title"]');
  const h = document.querySelector('h1,[class*="mainTitle"],[class*="itemTitle"],[class*="title--"]');
  return { docTitle: t, og: m ? m.content : '', h1: h ? (h.textContent || '').trim().slice(0, 120) : '' };
})()`;

// 风控特征：标题/正文/URL 命中即视为被拦
const BLOCK_JS = `(() => {
  const t = document.title || '';
  const u = location.href || '';
  const body = document.body ? (document.body.innerText || '').slice(0, 1200) : '';
  const hit = /验证码|captcha|滑动验证|sec\\.taobao|punish|sufei|_sq_|访问受限|人机验证/i.test(t + ' ' + u + ' ' + body);
  return { blocked: hit, title: t.slice(0, 80), url: u.slice(0, 200) };
})()`;

// 软风控：不算滑块拦截，但促销价会被降级（只剩「优惠前」，提示"登录查看更多优惠"）
const SOFT_JS = `(() => {
  const b = document.body ? (document.body.innerText || '').slice(0, 4000) : '';
  const t = document.title || '';
  return { soft: /访问存在异常|访问异常提示|登录查看更多优惠|稍后再试/.test(b + ' ' + t) };
})()`;

// 下架/失效：商品本身没了，不是抓取失败——重试多少次都没用，只能换链接
const DOWN_JS = `(() => {
  const t = document.title || '';
  const b = document.body ? (document.body.innerText || '').slice(0, 1200) : '';
  const s = t + ' ' + b;
  const hit = /已下架|下架了|商品不存在|宝贝不存在|找不到该宝贝|商品已删除|商品过期|已失效|此商品无法购买|该宝贝已转移|页面不存在/.test(s);
  return { down: hit, title: t.slice(0, 80) };
})()`;

// 新版详情页的数据是异步注入的：readyState=complete 时 __ICE_APP_CONTEXT__ 可能还是空的。
// 老版页面（没有 #ice-container）直接放行，避免每个商品白等十几秒。
const ICE_READY_JS = `(() => {
  const el = document.querySelector('#ice-container');
  if (!el) return true;
  try {
    const r = ((window.__ICE_APP_CONTEXT__ || {}).loaderData || {}).home;
    return !!(r && r.data && r.data.res);
  } catch (e) { return false; }
})()`;

// 主图（头图）：主图库第 1 张缩略图，首图是视频取第 2 张
const GALLERY_JS = `(() => {
  const a = [];
  document.querySelectorAll('img').forEach(i => {
    const c = String(i.className || '');
    if (!/thumb/i.test(c)) return;
    const s = i.currentSrc || i.src || i.getAttribute('data-src') || '';
    if (!s || s.startsWith('data:')) return;
    const r = i.getBoundingClientRect();
    if (r.left > 480) return;
    a.push({ y: Math.round(r.top), x: Math.round(r.left), s });
  });
  a.sort((p, q) => p.y - q.y || p.x - q.x);
  const out = []; const seen = new Set();
  a.forEach(o => { if (!seen.has(o.s)) { seen.add(o.s); out.push(o.s); } });
  return out;
})()`;

const HAS_VIDEO_JS = `(() => { const v = document.querySelector('video'); if (!v) return false; const r = v.getBoundingClientRect(); return r.width > 200 && r.height > 200 && r.left < 450; })()`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

function cleanUrl(u) {
  // 去掉广告追踪参数，降低异常流量特征；保留 id / skuId
  try {
    const x = new URL(u);
    ['utparam', 'mi_id', 'priceTId', 'spm', 'ns', 'abbucket', 'xxc', 'scene', 'ali_refid', 'ali_trackid'].forEach(k => x.searchParams.delete(k));
    return x.toString();
  } catch { return u; }
}

function hiRes(u) {
  if (!u) return u;
  u = u.replace(/^\/\//, 'https://');
  return u.replace(/\.jpg_\.webp$/i, '.jpg').replace(/\.png_\.webp$/i, '.png').replace(/\.jpeg_\.webp$/i, '.jpeg');
}

function fetchImg(url, fileBase) {
  return new Promise(res => {
    let mod = http; try { if (url.startsWith('https')) mod = https; } catch { }
    const req = mod.get(url, { headers: { 'User-Agent': UA, 'Referer': 'https://detail.tmall.com/' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        try { return fetchImg(hiRes(new URL(r.headers.location, url).href), fileBase).then(res); } catch { return res(null); }
      }
      if (r.statusCode !== 200) { r.resume(); return res(null); }
      const ch = []; r.on('data', c => ch.push(c));
      r.on('end', () => {
        const b = Buffer.concat(ch);
        if (b.length < 3000) return res(null);
        let ext = (url.match(/\.(jpg|jpeg|png|webp)(?:\?|$)/i) || [])[1] || 'jpg';
        ext = ext.toLowerCase().replace('jpeg', 'jpg');
        const f = path.join(OUT, fileBase + '.' + ext);
        fs.writeFileSync(f, b); res(f);
      });
    });
    req.on('error', () => res(null));
    req.setTimeout(15000, () => { try { req.destroy(); } catch { } res(null); });
  });
}

async function waitLoad(cdp) {
  for (let i = 0; i < 50; i++) {
    await sleep(1000);
    try { const rs = await cdp.eval('document.readyState'); if (rs === 'complete') return; } catch { }
  }
}

// 拟人化：随机滚动 + 随机鼠标移动，让停留行为接近真人
async function humanize(cdp) {
  try {
    const h = await cdp.eval('(document.body&&document.body.scrollHeight)||1200');
    const steps = rand(2, 4);
    for (let i = 0; i < steps; i++) {
      const y = rand(120, Math.min(h, 1500));
      await cdp.eval(`window.scrollTo({top:${y},behavior:'smooth'})`).catch(() => { });
      await sleep(rand(500, 1400));
    }
    await cdp.eval('window.scrollTo({top:0,behavior:"smooth"})').catch(() => { });
    await sleep(rand(400, 900));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rand(120, 520), y: rand(220, 560) }, cdp.sid).catch(() => { });
  } catch { }
}

async function captureHeader(cdp, fileBase) {
  try {
    const animated = await cdp.eval(HAS_VIDEO_JS).catch(() => false);
    const thumbs = await cdp.eval(GALLERY_JS).catch(() => []);
    let src = animated ? (thumbs[1] || thumbs[0]) : (thumbs[0] || null);
    if (!src) return null;
    let f = await fetchImg(hiRes(src), fileBase);
    if (!f) { const raw = src.startsWith('//') ? 'https:' + src : src; f = await fetchImg(raw, fileBase); }
    return f ? path.basename(f) : null;
  } catch { return null; }
}

// 上一轮 results.json 全部记录（用于继承 mech、ONLY 模式保留其它列）
function loadOld() {
  const rf = path.join(OUT, 'results.json');
  if (!fs.existsSync(rf)) return new Map();
  try {
    const m = new Map();
    JSON.parse(fs.readFileSync(rf, 'utf8')).forEach(r => { if (r && r.col) m.set(r.col, r); });
    return m;
  } catch { return new Map(); }
}

// 已成功拿到结果的列（用于断点续跑，跳过不再重复消耗额度）
// 判定标准收紧：必须拿到「优惠后价」语义，或明确是下架页；
// 只有「优惠前/划线价」的降级页不算成功，下次要重抓。
function loadDone(oldMap) {
  if (!RESUME) return new Map();
  const m = new Map();
  oldMap.forEach((r, c) => {
    const p = r.page || {};
    const hasAfter = (p.daoshou || []).length
      || (p.raw || []).some(t => /(?:优惠后|加补后|补贴后|券后|到手|折后)/.test(String(t)));
    const isDown = !!r.down || /已下架|商品不存在|已失效|商品过期|找不到该宝贝/.test(String(r.title || ''));
    if (!r.blocked && (hasAfter || isDown)) m.set(c, r);
  });
  return m;
}

async function main() {
  const ver = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/version`));
  const cdp = new CDP(ver.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Browser.enable');

  let tasks = JSON.parse(fs.readFileSync(TASKS, 'utf8'));
  const OLD = loadOld();
  const done = loadDone(OLD);
  if (ONLY.length) tasks = tasks.filter(t => ONLY.includes(String(t.col).toUpperCase()));
  const todo = tasks.filter(t => !done.has(t.col));
  log(`TASKS=${tasks.length} TODO=${todo.length} SKIP=${tasks.length - todo.length}`);

  // 单页复用：全程只用 1 个 tab，避免反复开关标签页触发风控
  const tgt = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const att = await cdp.send('Target.attachToTarget', { targetId: tgt.result.targetId, flatten: true });
  cdp.sid = att.result.sessionId;
  await cdp.send('Page.enable', {}, cdp.sid);
  await cdp.send('Runtime.enable', {}, cdp.sid);

  // 热身：先逛一次首页，让登录态与 cookie 活跃（比直接怼详情页安全）
  log('WARMUP: https://www.taobao.com');
  await cdp.nav('https://www.taobao.com');
  await waitLoad(cdp); await sleep(rand(4000, 7000));

  const results = Array.from(done.values());
  let blockedCount = 0, okCount = 0;

  for (let idx = 0; idx < todo.length; idx++) {
    const task = todo[idx];
    const item = (task.items || [])[0] || {};
    const url = cleanUrl(item.url || task.url);
    let rec = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      log(`[${idx + 1}/${todo.length}] ${task.col} ${task.brand}`);
      // 单次尝试整体兜异常：导航超时/页面崩溃不能把整轮抓取打断
      try {
      await cdp.nav(url);
      await waitLoad(cdp);
      await sleep(rand(2500, 5000));
      await humanize(cdp);
      // 等新版页面的异步价格数据落位（最多 ~18s）
      for (let w = 0; w < 12; w++) {
        const ready = await cdp.eval(ICE_READY_JS).catch(() => true);
        if (ready) break;
        await sleep(1500);
      }

      const b = await cdp.eval(BLOCK_JS).catch(() => ({ blocked: true, title: 'eval-fail', url }));
      if (b.blocked) {
        blockedCount++;
        log(`  BLOCKED (${blockedCount}/${MAX_BLOCKED}) title="${b.title}"`);
        if (blockedCount >= MAX_BLOCKED) {
          log('ABORT_RISK: 连续被拦，停止抓取，保留已拿到的数据');
          fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
          log('DONE_PARTIAL ->', path.join(OUT, 'results.json'));
          await cdp.send('Target.closeTarget', { targetId: tgt.result.targetId }).catch(() => { });
          cdp.ws.close(); process.exit(0);
        }
        const cool = Math.round(COOLDOWN_MIN * 60000 * (0.8 + Math.random() * 0.6));
        log(`  COOLDOWN ${Math.round(cool / 60000)} 分钟`);
        await sleep(cool);
        await cdp.nav('https://www.taobao.com'); await waitLoad(cdp); await sleep(5000);
        continue; // 冷却后重试同一个
      }

      const title = await cdp.eval(TITLE_JS).catch(() => ({ docTitle: '', og: '', h1: '' }));
      const page = await cdp.eval(PRICE_JS).catch(() => ({ daoshou: [], main: [], origin: [], raw: [] }));
      const header = NO_IMAGE ? null : await captureHeader(cdp, `${task.col}_${String(task.brand).replace(/[-\s/\\]/g, '')}`);
      const soft = await cdp.eval(SOFT_JS).catch(() => ({ soft: false }));
      const down = await cdp.eval(DOWN_JS).catch(() => ({ down: false, title: '' }));
      const dp = (page.daoshou[0] || page.main[0] || null);
      const hasAfter = (page.daoshou || []).length > 0
        || (page.raw || []).some(t => /(?:优惠后|加补后|补贴后|券后|到手|折后)/.test(String(t)));
      log(`  price(page)=${dp || '-'}  daoshou=${JSON.stringify(page.daoshou)}  raw=${JSON.stringify((page.raw || []).slice(0, 3))}  soft=${soft.soft ? 1 : 0}  down=${down.down ? 1 : 0}  img=${header || '-'}`);

      // 降级页：页面开了，但促销价模块没下发（只有优惠前/划线价），换一次页面重来
      // 下架页不重试——商品没了，重试多少次都一样
      if (!down.down && !hasAfter && attempt === 0) {
        log('  SOFT_DEGRADED: 没取到优惠后价，冷却后重试一次');
        await sleep(rand(18000, 32000));
        continue;
      }

      // 上一次尝试已拿到数据，这一次却整页空白（导航失败/错误页灰屏）——保留上一次，别用空值覆盖
      const cnt = (o) => (o.raw || []).length + (o.daoshou || []).length + (o.main || []).length + (o.origin || []).length;
      if (rec && rec.page && cnt(rec.page) > 0 && cnt(page) === 0) {
        log('  KEEP_PREV: 本次重试页面空白，保留上一次已拿到的数据');
        break;
      }

      rec = {
        col: task.col, brand: task.brand, url: item.url || task.url,
        title: title.h1 || title.og || title.docTitle || '',
        header: header, price: null, mech: '', page: page, blocked: false,
        soft: !!soft.soft, down: !!down.down,
        ts: new Date().toISOString()
      };
      if (down.down) log('  DOWN: 商品已下架/失效，需更换链接');
      okCount++;
      break;
      } catch (e) {
        log(`  NAV_FAIL: ${String((e && e.message) || e)}`);
        if (attempt === 0) {
          log('  冷却后重试同一个');
          await sleep(rand(20000, 35000));
          continue;
        }
        rec = null;
      }
    }

    if (rec) results.push(rec);
    else if (blockedCount < MAX_BLOCKED) {
      results.push({ col: task.col, brand: task.brand, url: item.url || task.url, title: '', header: null, price: null, mech: '', page: null, blocked: true, ts: new Date().toISOString() });
    }

    // 每 N 个长休一次
    if ((idx + 1) % LONG_REST_EVERY === 0 && idx + 1 < todo.length) {
      log(`  LONG_REST ${Math.round(LONG_REST_MS / 1000)}s`);
      await sleep(LONG_REST_MS);
    } else if (idx + 1 < todo.length) {
      await sleep(rand(MIN_GAP, MAX_GAP));
    }
  }

  // 只跑部分列时，把没跑到的旧记录原样保留，避免整表被覆盖
  if (ONLY.length) {
    const have = new Set(results.map(r => r.col));
    OLD.forEach((o, c) => { if (!have.has(c)) results.push(o); });
  }
  // 上一轮人工/AI 填过的机制文案，本轮没填就继承下来，不丢数据
  results.forEach(r => {
    const o = OLD.get(r.col);
    if (o && (!r.mech || !String(r.mech).trim()) && o.mech) r.mech = o.mech;
  });

  results.sort((a, b) => {
    const ca = String(a.col), cb = String(b.col);
    return ca.length - cb.length || (ca > cb ? 1 : -1);
  });
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  log(`DONE ok=${okCount} blocked=${blockedCount} -> ${path.join(OUT, 'results.json')}`);
  await cdp.send('Target.closeTarget', { targetId: tgt.result.targetId }).catch(() => { });
  cdp.ws.close(); process.exit(0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
