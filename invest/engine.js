/*
 * 月供投資規則引擎（純函式，無 DOM / 網路依賴）
 * 對應「投資組合管理系統規格摘要 (2026-11-05)」。
 * 瀏覽器：window.InvestEngine；Node：module.exports。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InvestEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ADD_ASSETS = ['QQQ', 'SMH', 'VYM', 'SCHD']; // 加倉系統只鎖定這四個，不含 GLD
  const MONTHLY_ASSETS = ['VYM', 'SCHD', 'QQQ', 'SMH', 'GLD'];
  const EPS = 1e-9;

  const DEFAULT_SETTINGS = {
    utilization: 0.7,       // 資金池 = 總流動資金 x 70%
    assetCapPct: 0.4,       // 單一資產累計加倉上限 = 資金池 x 40%
    // upper = 該 Level 的淺端邊界（回撤 <= upper 即進入該 Level，較深的 Level 優先）
    levels: [
      { id: 'L1', upper: -0.10, sharePct: 0.10, maxCount: 6 },
      { id: 'L2', upper: -0.15, sharePct: 0.20, maxCount: 8 },
      { id: 'L3', upper: -0.25, sharePct: 0.30, maxCount: 6 },
      { id: 'L4', upper: -0.35, sharePct: 0.40, maxCount: 4 }
    ],
    weights: { VYM: 0.32, SCHD: 0.28, QQQ: 0.15, SMH: 0.12, GLD: 0.13 },
    monthly: { user: 1250, spouse: 6250, day: 5 },
    spcxUsd: { user: 200, spouse: 1000 }, // SPCX 為月供以外的獨立定投，以美元金額計（舊欄位 spcx 為股數，已停用）
    withholding: 0.30,                    // 香港居民收美股股息的預扣稅率
    otherHoldings: ['QQQI', 'QYLD'],      // 既有持倉（不在月供與加倉範圍），只用於持倉盈虧統計
    recovery: { triggerPct: 0.95, weeks: 10, tranchePct: 0.10 },
    lockedLiquid: null,           // 若設定，資金池改用此固定流動資金基準
    apiKey: ''                    // Twelve Data 金鑰（只存在你的私有 Firestore 文件）
  };

  // 初始狀態。預設只含公開的市場數據（52 週高點），帳戶餘額與加倉紀錄一律為 0：
  // 這份程式碼放在公開倉庫，不能內嵌真實財務數字。登入後到「設定」填入實際值即可。
  // 需要完整快照時（例如測試）用 initialState(seed) 傳入。
  const PUBLIC_HIGHS = { QQQ: 762.860, SMH: 671.830, VYM: 166.684, SCHD: 36.380 };
  function initialState(seed) {
    seed = seed || {};
    const blank = (high) => ({
      high52: high, counts: { L1: 0, L2: 0, L3: 0, L4: 0 },
      cumulative: 0, roundId: 1, lastClose: null, recovery: null
    });
    const s = {
      version: 1,
      asOf: seed.asOf || new Date().toISOString().slice(0, 10),
      cash: num(seed.cash),
      boxx: num(seed.boxx),
      assets: {},
      holdings: { VYM: 0, SCHD: 0, QQQ: 0, SMH: 0, GLD: 0 }
    };
    ADD_ASSETS.forEach((k) => {
      const o = (seed.assets && seed.assets[k]) || {};
      s.assets[k] = blank(o.high52 || PUBLIC_HIGHS[k]);
      if (o.counts) Object.assign(s.assets[k].counts, o.counts);
      if (o.cumulative) s.assets[k].cumulative = o.cumulative;
    });
    return s;
  }

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);

  function mergeSettings(saved) {
    const s = clone(DEFAULT_SETTINGS);
    if (!saved) return s;
    for (const k of Object.keys(saved)) {
      if (saved[k] && typeof saved[k] === 'object' && !Array.isArray(saved[k]) && s[k] && typeof s[k] === 'object') {
        s[k] = Object.assign({}, s[k], saved[k]);
      } else if (saved[k] !== undefined) {
        s[k] = saved[k];
      }
    }
    return s;
  }

  function drawdown(close, high) {
    return (close - high) / high;
  }

  // 回撤 -> Level 物件索引（找不到回傳 -1）。邊界值歸入較深的 Level。
  function levelIndex(settings, dd) {
    let idx = -1;
    settings.levels.forEach((lv, i) => { if (dd <= lv.upper + EPS) idx = i; });
    return idx;
  }

  // 資金池與各 Level 金額。總額先四捨五入再除以次數，與規格表一致。
  function poolInfo(settings, cash, boxx) {
    const liquid = settings.lockedLiquid > 0 ? settings.lockedLiquid : num(cash) + num(boxx);
    const pool = liquid * settings.utilization;
    const cap = pool * settings.assetCapPct;
    const levels = settings.levels.map((lv) => {
      const total = Math.round(cap * lv.sharePct);
      return { id: lv.id, upper: lv.upper, maxCount: lv.maxCount, total, weekly: Math.round(total / lv.maxCount) };
    });
    return { liquid, pool, reserve: liquid - pool, cap, levels };
  }

  // 規則總覽：只由設定與流動資金算出，不依賴帳本。給網頁逐層列出「每次金額、次數、佔用資金」，
  // 方便對照原始設計。數字全部來自 poolInfo，與指引頁同一套算法。
  function ruleSheet(settings, cash, boxx, highs) {
    const info = poolInfo(settings, cash, boxx);
    const n = settings.levels.length;
    const levels = info.levels.map((l, i) => {
      const deeper = i + 1 < n ? settings.levels[i + 1].upper : null;
      const full = l.weekly * l.maxCount;                       // 每次金額 x 次數上限（實際會花的錢）
      return {
        id: l.id, upper: l.upper, deeper, maxCount: l.maxCount, sharePct: settings.levels[i].sharePct,
        total: l.total, weekly: l.weekly, full,
        roundDiff: full - l.total,                              // 四捨五入造成的差額
        pctOfCap: info.cap > 0 ? full / info.cap : 0,
        pctOfPool: info.pool > 0 ? full / info.pool : 0,
        pctOfLiquid: info.liquid > 0 ? full / info.liquid : 0
      };
    });
    const ladder = levels.reduce((s, l) => s + l.full, 0);       // 一個資產走完整個階梯
    const nAssets = ADD_ASSETS.length;
    const triggers = {};
    ADD_ASSETS.forEach((sym) => {
      const h = highs && highs[sym];
      if (h > 0) triggers[sym] = levels.map((l) => ({ id: l.id, price: h * (1 + l.upper) }));
    });
    return {
      liquid: info.liquid, pool: info.pool, reserve: info.reserve, cap: info.cap,
      utilization: settings.utilization, assetCapPct: settings.assetCapPct,
      levels, ladder, ladderPctOfCap: info.cap > 0 ? ladder / info.cap : 0,
      shareSum: settings.levels.reduce((s, l) => s + l.sharePct, 0),
      nAssets, allAssetsFull: ladder * nAssets, allAssetsPctOfPool: info.pool > 0 ? ladder * nAssets / info.pool : 0,
      allAssetsPctOfLiquid: info.liquid > 0 ? ladder * nAssets / info.liquid : 0,
      triggers,
      recovery: { triggerPct: settings.recovery.triggerPct, weeks: settings.recovery.weeks, tranchePct: settings.recovery.tranchePct }
    };
  }

  // 每週日檢視：回傳更新後狀態（尚未執行任何買賣）與下週三的計畫
  function review(settings, state, closes, opts) {
    opts = opts || {};
    const next = clone(state);
    const cash = opts.cash != null ? opts.cash : state.cash;
    const boxx = opts.boxx != null ? opts.boxx : state.boxx;
    next.cash = cash; next.boxx = boxx;
    if (opts.date) next.asOf = opts.date;

    const info = poolInfo(settings, cash, boxx);
    const events = [];
    const items = [];

    for (const sym of ADD_ASSETS) {
      const a = next.assets[sym];
      const close = closes[sym];
      if (!(close > 0)) { items.push({ sym, error: '缺少收盤價' }); continue; }
      a.lastClose = close;

      // 1) 本金回收觸發。先於創新高重置判斷，避免價格直接跳過 95% 區間時漏掉觸發。
      const trigPrice = () => a.high52 * settings.recovery.triggerPct;
      if (!(a.recovery && a.recovery.active) && close >= trigPrice() - EPS && a.cumulative > 0) {
        a.recovery = { active: true, weeksDone: 0, base: a.cumulative, roundId: a.roundId, startedAt: opts.date || null, id: sym + ':' + a.roundId + ':' + (opts.date || 'x') };
        events.push({ sym, type: 'recovery-start', base: a.cumulative });
      } else if (a.recovery && a.recovery.active && num(a.recovery.weeksDone) === 0 && a.recovery.roundId === a.roundId && a.cumulative > 0) {
        // 還沒賣出第一筆：基數隨最新累計本金更新（一旦賣出第一筆就鎖定，之後新倉不併入）
        a.recovery.base = a.cumulative;
      }

      // 2) 創新高重置：僅更新基準與 Level 次數，不影響進行中的回收排程。
      if (close > a.high52 + EPS) {
        events.push({ sym, type: 'new-high', from: a.high52, to: close });
        a.high52 = close;
        a.counts = { L1: 0, L2: 0, L3: 0, L4: 0 };
        a.cumulative = 0;
        a.roundId += 1;
      }

      const dd = drawdown(close, a.high52);
      const idx = levelIndex(settings, dd);
      const item = { sym, close, high52: a.high52, dd, level: null, used: null, max: null, planned: 0, status: 'none', note: '', add: null, recovery: null };

      if (idx >= 0) {
        const lv = info.levels[idx];
        item.level = lv.id; item.max = lv.maxCount; item.used = a.counts[lv.id] || 0;
        const capLeft = info.cap - a.cumulative;
        const backlog = num(a.backlog);
        if (item.used >= lv.maxCount) { item.status = 'exhausted'; item.note = lv.id + ' 次數已用滿'; }
        else if (capLeft + EPS < lv.weekly) { item.status = 'capped'; item.note = '已達單一資產上限'; }
        else {
          // 本週金額 = 該 Level 每週金額 + 以前買不足累積的欠買；整體不得超過單一資產上限
          item.status = 'triggered'; item.base = lv.weekly; item.backlog = backlog;
          item.planned = Math.min(lv.weekly + backlog, capLeft);
        }
      }

      // 本金回收（賣出）計畫
      const r = a.recovery;
      if (r && r.active) {
        const trig = trigPrice();
        if (opts.date && close >= trig - EPS) {
          r.advised = r.advised || [];
          const awk = nextWednesday(opts.date);
          if (!r.advised.includes(awk)) r.advised.push(awk);
        }
        const tranche = Math.round(r.base * settings.recovery.tranchePct * 100) / 100;
        if (close >= trig - EPS) item.recovery = { status: 'sell', week: r.weeksDone + 1, of: settings.recovery.weeks, amount: tranche, trigger: trig, base: r.base, locked: r.weeksDone > 0, startedAt: r.startedAt, pctAbove: close / trig - 1 };
        else item.recovery = { status: 'paused', week: r.weeksDone + 1, of: settings.recovery.weeks, amount: 0, trigger: trig, base: r.base, locked: r.weeksDone > 0, startedAt: r.startedAt, pctAbove: close / trig - 1 };
      }
      items.push(item);
    }

    // 資金分配：由深到淺全額滿足，資金用盡即停止（不補到部分金額）
    const triggered = items.filter((i) => i.status === 'triggered').sort((x, y) => x.dd - y.dd);
    const availableCash = opts.availableCash != null ? opts.availableCash : cash;
    const sumCum = ADD_ASSETS.reduce((s, k) => s + num(next.assets[k].cumulative), 0);
    const headroom = Math.max(0, info.pool - sumCum);
    let remaining = Math.min(availableCash, headroom);
    // 回撤最深者優先；資金不夠全額時，買得到多少就買多少，記為一次，差額累積為「欠買」下次補上。
    for (const it of triggered) {
      if (it.planned <= remaining + EPS) {
        remaining -= it.planned;
        it.add = it.planned;
        it.status = 'funded';
      } else if (remaining >= 1) {
        it.add = Math.floor(remaining * 100) / 100;
        it.short = it.planned - it.add;
        remaining -= it.add;
        it.status = 'partial';
        it.note = '資金只夠買 ' + it.add.toFixed(2) + '，仍記為一次；差額 ' + it.short.toFixed(2) + ' 記為欠買，下次加倉補上';
      } else {
        it.add = 0;
        it.status = 'unfunded';
        it.note = '資金用盡，本週不加倉，不記次數；下次依原進度繼續';
      }
    }
    const totalAdd = items.reduce((s, i) => s + (i.add || 0), 0);
    const totalSell = items.reduce((s, i) => s + (i.recovery && i.recovery.status === 'sell' ? i.recovery.amount : 0), 0);

    return {
      state: next,
      plan: { info, items, events, totalAdd, totalSell, availableCash, headroom, cashLimit: Math.min(availableCash, headroom) }
    };
  }

  // 週三執行結果寫回狀態（不使用帳本的簡易路徑，主要供測試；介面一律走帳本 + deriveAssets）。
  // execs: [{type:'add', sym, level, planned, amount}, {type:'recovery', sym, amount}]
  function applyExecutions(settings, state, execs) {
    const next = clone(state);
    const events = [];
    for (const e of execs) {
      const a = next.assets[e.sym];
      if (!a || !(e.amount > 0)) continue;
      if (e.type === 'add') {
        if (e.level) a.counts[e.level] = (a.counts[e.level] || 0) + 1; // 買了就記一次
        a.cumulative += e.amount;
        const owed = Math.max(0, num(a.backlog) + (e.base != null ? e.base : e.planned - num(a.backlog)) - e.amount);
        a.backlog = owed;
        events.push({ sym: e.sym, type: 'add' });
      } else if (e.type === 'recovery' && a.recovery && a.recovery.active) {
        a.recovery.weeksDone += 1;
        a.cumulative = Math.max(0, a.cumulative - e.amount);
        if (a.recovery.weeksDone >= settings.recovery.weeks) { a.recovery = null; events.push({ sym: e.sym, type: 'recovery-done' }); }
      }
    }
    return { state: next, events };
  }

  // ───────── 帳本：次數、累計本金、回收進度全部由帳本重算 ─────────
  // 帳本記錄格式：
  // { id, date:'YYYY-MM-DD', sym, kind:'add'|'recovery', level:'L1'..'L4'(add), counted:bool(add 是否計入次數),
  //   amount, price?, shares?, round:加倉當下的創新高輪次, recoveryId?:回收排程 id, note? }
  function weekKey(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    const day = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - day + 3);
    const y = d.getUTCFullYear();
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const wk = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
    return y + '-W' + String(wk).padStart(2, '0');
  }
  // 下一個週三（今天就是週三則回傳今天）
  function nextWednesday(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + ((3 - d.getUTCDay() + 7) % 7));
    return d.toISOString().slice(0, 10);
  }

  // 由帳本重算各資產的 Level 次數、累計本金、欠買、回收進度。
  // 規則：
  //  - 每筆加倉買入都記為一次；實際金額少於「該次應買」的差額累積成欠買（backlog），下次加倉時補上。
  //    應買 = 該 Level 每週金額 + 當時欠買。欠買不會超過單一資產上限的剩餘額度（由 review 控制）。
  //  - 回收賣出每一筆立即釋放等額累計本金（不必等 10 週賣完）。
  //  - 回收排程在「賣出第一筆之前」基數隨最新累計本金更新；賣出第一筆後基數鎖定、固定每週金額，之後新加的倉不併入該排程。
  //  - 累計本金 = 當前這一輪所有加倉買入金額 - 已回收賣出金額（淨額，即仍留在市場、尚未收回的加倉本金）。
  //  - 排程完成（賣滿週數）時，累計本金扣到「基數 - 已釋放」為零頭則一併結清。
  function deriveAssets(settings, state, ledger) {
    const next = clone(state);
    const events = [];
    ADD_ASSETS.forEach((sym) => {
      const a = next.assets[sym];
      const rows = (ledger || []).filter((e) => e.sym === sym);
      a.counts = { L1: 0, L2: 0, L3: 0, L4: 0 };
      let cum = 0, backlog = 0;
      rows.forEach((e) => {
        if ((e.round || 1) !== a.roundId) return;
        if (e.kind === 'add') {
          if (e.level) a.counts[e.level] = (a.counts[e.level] || 0) + 1;
          cum += num(e.amount);
          // e.base = 該次 Level 的每週基本金額；沒記錄 base 的手動補記視為足額，不產生欠買
          if (e.base > 0) backlog = Math.max(0, backlog + e.base - num(e.amount));
        } else if (e.kind === 'recovery') {
          cum -= num(e.amount);
        }
      });
      a.cumulative = Math.max(0, cum);
      a.backlog = Math.max(0, backlog);
      if (a.recovery && a.recovery.active) {
        const mine = rows.filter((e) => e.kind === 'recovery' && e.recoveryId === a.recovery.id);
        a.recovery.weeksDone = mine.length;
        a.recovery.released = mine.reduce((s, e) => s + num(e.amount), 0);
        if (a.recovery.weeksDone >= settings.recovery.weeks) {
          const rest = Math.max(0, a.recovery.base - a.recovery.released);
          if (a.recovery.roundId === a.roundId) a.cumulative = Math.max(0, a.cumulative - rest);
          events.push({ sym, type: 'recovery-done' });
          a.recovery = null;
        }
      }
    });
    return { state: next, events };
  }

  // 統計：每個資產每個 Level 的次數與金額（當前輪 / 歷史總計）、持股、平均成本
  function ledgerStats(settings, state, ledger) {
    const out = {};
    ADD_ASSETS.forEach((sym) => {
      const a = state.assets[sym];
      const rows = (ledger || []).filter((e) => e.sym === sym && e.kind === 'add');
      const lv = {};
      settings.levels.forEach((l) => {
        const cur = rows.filter((e) => e.level === l.id && (e.round || 1) === a.roundId);
        const all = rows.filter((e) => e.level === l.id);
        lv[l.id] = {
          max: l.maxCount,
          count: cur.length, amount: cur.reduce((s, e) => s + num(e.amount), 0),
          allCount: all.length, allAmount: all.reduce((s, e) => s + num(e.amount), 0)
        };
      });
      const sharesOf = (e) => (e.shares > 0 ? e.shares : (e.price > 0 ? e.amount / e.price : 0));
      const withPrice = rows.filter((e) => e.price > 0 || e.shares > 0);
      const costKnown = withPrice.reduce((s, e) => s + num(e.amount), 0);
      const sharesKnown = withPrice.reduce((s, e) => s + sharesOf(e), 0);
      const curRows = (ledger || []).filter((e) => e.sym === sym && (e.round || 1) === a.roundId);
      out[sym] = {
        levels: lv, roundId: a.roundId, cumulative: a.cumulative,
        roundGross: curRows.filter((e) => e.kind === 'add').reduce((s, e) => s + num(e.amount), 0),
        roundRecovered: curRows.filter((e) => e.kind === 'recovery').reduce((s, e) => s + num(e.amount), 0),
        totalAmount: rows.reduce((s, e) => s + num(e.amount), 0), totalCount: rows.length, backlog: num(a.backlog),
        shares: sharesKnown, avgCost: sharesKnown > 0 ? costKnown / sharesKnown : null,
        sold: (ledger || []).filter((e) => e.sym === sym && e.kind === 'recovery').reduce((s, e) => s + num(e.amount), 0)
      };
    });
    return out;
  }

  const m2 = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const p2 = (n) => (n * 100).toFixed(1) + '%';
  const px = (n) => '$' + n.toFixed(2);
  const usdFmt = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // 指引：先由帳本重算，再跑週檢視，並為每個資產產生白話建議與「再跌/再漲多少會觸發」的價位。
  function guidance(settings, state, ledger, closes, opts) {
    opts = opts || {};
    const base = deriveAssets(settings, state, ledger);
    const r = review(settings, base.state, closes, opts);
    const wed = nextWednesday(opts.date);
    const wk = weekKey(wed);
    const info = r.plan.info;
    const items = r.plan.items.map((it) => {
      if (it.error) return it;
      const a = r.state.assets[it.sym];
      const rows = (ledger || []).filter((e) => e.sym === it.sym);
      const doneAdd = rows.some((e) => e.kind === 'add' && weekKey(e.date) === wk);
      const doneSell = rows.some((e) => e.kind === 'recovery' && weekKey(e.date) === wk);
      const lvPrices = settings.levels.map((l, i) => ({ id: l.id, price: a.high52 * (1 + l.upper), weekly: info.levels[i].weekly, upper: l.upper }));
      const trigPrice = a.high52 * settings.recovery.triggerPct;
      const lines = [];
      const li = it.level ? settings.levels.findIndex((l) => l.id === it.level) : -1;
      const backlogTxt = it.backlog > 0 ? '（本週基本 ' + m2(it.base) + ' + 以前欠買 ' + m2(it.backlog) + '）' : '';
      if (it.status === 'funded') {
        lines.push(doneAdd
          ? { kind: 'done', text: '本週三（' + wed + '）已記錄加倉，不需再買' }
          : { kind: 'buy', text: '週三（' + wed + '）買入 ' + m2(it.add) + backlogTxt + '，記為 ' + it.level + ' 第 ' + (it.used + 1) + '/' + it.max + ' 次' });
      } else if (it.status === 'partial') {
        lines.push(doneAdd
          ? { kind: 'done', text: '本週三（' + wed + '）已記錄加倉，不需再買' }
          : { kind: 'warn', text: '資金只夠買 ' + usdFmt(it.add) + '（應買 ' + m2(it.planned) + backlogTxt + '）：照買並記為 ' + it.level + ' 第 ' + (it.used + 1) + '/' + it.max + ' 次，差額 ' + usdFmt(it.short) + ' 記為欠買，下次加倉補上' });
      } else if (it.status === 'unfunded') {
        lines.push({ kind: 'warn', text: '已觸發 ' + it.level + '（應買 ' + m2(it.planned) + '），但可動用資金已用盡，本週不加倉、不計次數；資金恢復後依原進度繼續' });
      } else if (it.status === 'capped') {
        lines.push({ kind: 'warn', text: '累計加倉 ' + m2(a.cumulative) + ' 已達單一資產上限 ' + m2(info.cap) + '，不再加倉' });
      } else if (it.status === 'exhausted') {
        lines.push({ kind: 'info', text: it.level + ' 次數已用滿（' + it.max + '/' + it.max + '），在此 Level 區間不再加碼，除非跌入更深的 Level' });
      } else {
        const l1 = lvPrices[0];
        lines.push({ kind: 'wait', text: '回撤 ' + p2(it.dd) + '，未達 ' + p2(l1.upper) + '，不加倉。跌至 ' + px(l1.price) + '（再跌 ' + p2(1 - l1.price / it.close) + '）才觸發 ' + l1.id + '，每週 ' + m2(l1.weekly) });
      }
      if (li >= 0 && li < settings.levels.length - 1) {
        const nx = lvPrices[li + 1];
        lines.push({ kind: 'info', text: '若再跌至 ' + px(nx.price) + '（' + nx.id + '，再跌 ' + p2(1 - nx.price / it.close) + '）改為每週 ' + m2(nx.weekly) });
      }
      if (it.recovery) {
        const rc = it.recovery;
        const rr = a.recovery;
        // 已建議但沒執行的週數：排程記錄過的建議週三，不含本週，且該週沒有對應的賣出記錄
        const sells = rows.filter((e) => e.kind === 'recovery' && e.recoveryId === (rr && rr.id));
        const pending = ((rr && rr.advised) || []).filter((w) => w < wed && !sells.some((e) => weekKey(e.date) === weekKey(w))).length;
        if (rc.status === 'sell') {
          lines.push(doneSell
            ? { kind: 'done', text: '本週三（' + wed + '）已記錄本金回收賣出，不需再賣' }
            : { kind: 'sell', text: '週三（' + wed + '）賣出 ' + m2(rc.amount) + ' 做本金回收（第 ' + rc.week + '/' + rc.of + ' 週），所得匯回現金寶；獲利部分保留' });
          if (!doneSell && rc.week === 1 && pending > 0) {
            lines.push({ kind: 'warn', text: '已建議賣出但尚未執行：前 ' + pending + ' 週的建議你都沒賣。排程不會自動往前走，也不補賣；現價高於觸發價 ' + px(rc.trigger) + ' ' + p2(rc.pctAbove) + '，要再等可以繼續等，賣出第一筆後每週金額就鎖定為 ' + m2(rc.amount) });
          }
          if (!rc.locked) lines.push({ kind: 'info', text: '回收基數目前跟隨累計本金（' + m2(rc.base) + '），你賣出第一筆後才會鎖定，之後新加的倉不併入這一輪' });
        } else {
          lines.push({ kind: 'warn', text: '本金回收暫停：現價低於觸發價 ' + px(rc.trigger) + '（還差 ' + p2(-rc.pctAbove) + '），本週不賣、不補賣，站回後續接第 ' + rc.week + ' 週' });
        }
      } else if (a.cumulative > 0) {
        lines.push({ kind: 'info', text: '回升至 ' + px(trigPrice) + '（52 週高 95%，需再漲 ' + p2(trigPrice / it.close - 1) + '）將啟動本金回收，累計本金 ' + m2(a.cumulative) });
      }
      r.plan.events.filter((e) => e.sym === it.sym).forEach((e) => {
        if (e.type === 'new-high') lines.unshift({ kind: 'info', text: '收盤創 52 週新高 ' + px(e.to) + '：高點基準上移，Level 次數歸零' });
        if (e.type === 'recovery-start') lines.unshift({ kind: 'sell', text: '觸發本金回收：下個週三起連續 ' + settings.recovery.weeks + ' 週，每週賣出 ' + m2(e.base * settings.recovery.tranchePct) + '（累計本金 ' + m2(e.base) + ' 的 ' + (settings.recovery.tranchePct * 100).toFixed(0) + '%）' });
      });
      return Object.assign({}, it, { doneAdd, doneSell, lvPrices, trigPrice, advice: lines });
    });
    const needCash = items.reduce((s, i) => s + (i.add > 0 && !i.doneAdd ? i.add : 0), 0);
    const sellTotal = items.reduce((s, i) => s + (i.recovery && i.recovery.status === 'sell' && !i.doneSell ? i.recovery.amount : 0), 0);
    return { state: r.state, derivedEvents: base.events, wed, plan: Object.assign({}, r.plan, { items, needCash, sellTotal }) };
  }

  // ───────── 持倉與盈虧 ─────────
  // 底倉 base[sym] = { shares, cost（每股成本價）, asOf:'YYYY-MM-DD' }，視為富途在 asOf 當天顯示的全部持倉。
  // 之後新增的買入（月供、加倉、SPCX）才累加進來；asOf 當天及之前的記錄一律視為已含在底倉內。
  // 買入若沒填成交價就無法換算股數：只計入「待定投入」，不計入市值與盈虧，並在畫面標示。
  // 賣出（本金回收）按平均成本法減少成本與股數，已實現盈虧另外列示。
  function holdingsSummary(base, buys, prices, opts) {
    opts = opts || {};
    const syms = opts.syms || Object.keys(base || {});
    const rows = syms.map((sym) => {
      const b = (base && base[sym]) || {};
      const since = b.asOf || '0000-00-00';
      let shares = num(b.shares), cost = num(b.shares) * num(b.cost), unpriced = 0, unpricedN = 0, realized = 0;
      (buys || []).filter((e) => e.sym === sym && e.date > since).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : (x.ts || 0) - (y.ts || 0))).forEach((e) => {
        const sh = e.shares > 0 ? e.shares : (e.price > 0 ? e.amount / e.price : 0);
        if (e.side === 'sell') {
          if (!(sh > 0)) { unpricedN += 1; return; }            // 賣出沒填價格，無法換算，標示即可
          const avg = shares > 0 ? cost / shares : 0;
          const sold = Math.min(sh, shares);
          realized += e.amount - avg * sold;
          shares -= sold; cost -= avg * sold;
        } else if (sh > 0) { shares += sh; cost += num(e.amount); }
        else { unpriced += num(e.amount); unpricedN += 1; }
      });
      const price = prices && prices[sym] > 0 ? prices[sym] : null;
      const value = price != null ? shares * price : null;
      const pnl = value != null ? value - cost : null;
      return {
        sym, shares, cost, avgCost: shares > 0 ? cost / shares : null, price, value, pnl,
        pnlPct: pnl != null && cost > 0 ? pnl / cost : null, unpriced, unpricedN, realized, hasBase: num(b.shares) > 0
      };
    });
    const known = rows.filter((r) => r.value != null);
    const totalCost = rows.reduce((s, r) => s + r.cost, 0);
    const totalValue = known.reduce((s, r) => s + r.value, 0);
    const costOfKnown = known.reduce((s, r) => s + r.cost, 0);
    const pnl = known.reduce((s, r) => s + r.pnl, 0);
    return {
      rows, totalCost, totalValue, pnl,
      pnlPct: costOfKnown > 0 ? pnl / costOfKnown : null,
      realized: rows.reduce((s, r) => s + r.realized, 0),
      unpriced: rows.reduce((s, r) => s + r.unpriced, 0),
      missingPrice: rows.filter((r) => r.price == null && (r.shares > 0 || r.cost > 0)).map((r) => r.sym)
    };
  }

  // ───────── 富途同步（唯讀資料進網頁）─────────
  // 同步區只進「待確認」佇列，絕不自動寫入帳本。處理結果記在使用者自己的文件 doc.futu.handled：
  //   handled[dealId] = { action:'add'|'recovery'|'monthly'|'ignore', at: ms }

  // 成交 -> 建議動作（只是預設，使用者可改）
  //  - 只有追蹤代號才建議；賣出只在該資產有進行中的回收排程時建議為回收，否則建議忽略
  //  - 月供資產在月供日前後 3 天內買入，優先視為月供；其餘加倉資產視為加倉
  function suggestDeal(deal, settings, state, ledger) {
    if (!deal.tracked) return { action: 'ignore', why: '不在追蹤範圍' };
    const isAdd = ADD_ASSETS.indexOf(deal.sym) >= 0;
    if (deal.side === 'sell') {
      const a = isAdd && state.assets[deal.sym];
      if (a && a.recovery && a.recovery.active) return { action: 'ledger', kind: 'recovery', why: '有進行中的本金回收排程' };
      return { action: 'ignore', why: '沒有進行中的本金回收，賣出不入帳本' };
    }
    const day = Number(String(deal.date).slice(8, 10));
    const monthlyDay = settings.monthly && settings.monthly.day;
    const isMonthlyAsset = MONTHLY_ASSETS.indexOf(deal.sym) >= 0 || deal.sym === 'SPCX';
    if (monthlyDay && isMonthlyAsset && Math.abs(day - monthlyDay) <= 3) return { action: 'monthly', why: '接近月供日（' + monthlyDay + ' 號）' };
    if (isAdd) return { action: 'ledger', kind: 'add', why: '追蹤的加倉資產' };
    return { action: 'monthly', why: '月供資產' };
  }

  // 待確認：未處理、追蹤中的成交，新的在前
  function pendingDeals(sync, handled, opts) {
    opts = opts || {};
    const h = handled || {};
    return ((sync && sync.deals) || [])
      .filter((d) => !h[d.id] && (opts.includeUntracked || d.tracked))
      .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  }

  // 富途會把「一次買入」拆成多筆成交（整手一筆、碎股一筆，或分批成交），但對策略來說那只是「一次」。
  // 所以待確認佇列把「同日、同代號、同方向」的成交合併成一筆再讓使用者確認：
  //   股數、金額相加，成交價 = 總金額 / 總股數（加權平均）；ids 記錄所有被合併的成交，確認時全部標為已處理。
  // 合併後的 id 取排序後第一筆成交的 id；只有一筆時與原本完全相同（所以帳本草稿 id 不變）。
  const r4 = (n) => Math.round(n * 10000) / 10000;
  function groupDeals(deals) {
    const m = new Map();
    (deals || []).forEach((d) => {
      const k = [d.sym, d.side, d.date].join('|');
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(d);
    });
    const out = [];
    m.forEach((arr) => {
      arr = arr.slice().sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : String(a.id) < String(b.id) ? -1 : 1));
      if (arr.length === 1) { out.push(Object.assign({}, arr[0], { ids: [arr[0].id], count: 1, parts: [{ shares: arr[0].shares, price: arr[0].price }] })); return; }
      const shares = Math.round(arr.reduce((s, d) => s + num(d.shares), 0) * 1e6) / 1e6;
      const amount = arr.reduce((s, d) => s + num(d.amount, num(d.shares) * num(d.price)), 0);
      out.push(Object.assign({}, arr[0], {
        shares, amount: r4(amount), price: shares > 0 ? r4(amount / shares) : arr[0].price,
        time: arr[arr.length - 1].time, ids: arr.map((d) => d.id), count: arr.length,
        dealId: arr.map((d) => d.dealId).join('+'), parts: arr.map((d) => ({ shares: d.shares, price: d.price }))
      }));
    });
    return out.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  }
  function pendingGroups(sync, handled, opts) { return groupDeals(pendingDeals(sync, handled, opts)); }

  // 修復已經入帳的「同一次買入被拆成多筆」：把同日、同代號、同種類、同 Level、同輪次，且都來自富途成交（id 以 f 開頭）的記錄合併。
  // 金額、股數相加，價格 = 總金額 / 總股數；base 取第一筆（同一次買入的每週基本金額本來就相同）。
  // 回傳 { updates: [合併後的記錄], removeIds: [被併掉的 id], groups: n }。不修改傳入的帳本。
  function mergeSplitLedger(ledger) {
    const m = new Map();
    (ledger || []).forEach((e) => {
      if (!/^f/.test(String(e.id || '')) || !/^(富途成交|合併)/.test(String(e.note || ''))) return;   // 只動來自富途成交的記錄，手動新增的不碰
      const k = [e.sym, e.kind, e.level || '', e.round || 1, e.date, e.recoveryId || ''].join('|');
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e);
    });
    const updates = [], removeIds = [];
    m.forEach((arr) => {
      if (arr.length < 2) return;
      arr = arr.slice().sort((a, b) => num(a.ts) - num(b.ts) || (a.id < b.id ? -1 : 1));
      const first = arr[0];
      const amount = arr.reduce((s, e) => s + num(e.amount), 0);
      const sharesOf = (e) => (e.shares > 0 ? e.shares : (e.price > 0 ? e.amount / e.price : 0));
      const allHaveShares = arr.every((e) => sharesOf(e) > 0);
      const shares = Math.round(arr.reduce((s, e) => s + sharesOf(e), 0) * 1e6) / 1e6;
      const e = Object.assign({}, first, { amount: Math.round(amount * 100) / 100, note: ('合併 ' + arr.length + ' 筆富途成交').slice(0, 100) });
      if (allHaveShares && shares > 0) { e.shares = shares; e.price = r4(amount / shares); }
      updates.push(e);
      arr.slice(1).forEach((x) => removeIds.push(x.id));
    });
    return { updates, removeIds, groups: updates.length };
  }

  // 成交 -> 帳本草稿（level / base 由使用者在畫面上選）。id 由成交 id 決定，所以重複確認不會重複入帳。
  function dealToLedger(deal, kind, extra) {
    const e = {
      id: 'f' + String(deal.id).replace(/[^A-Za-z0-9_]/g, '').slice(-40), ts: Date.now(), date: deal.date, sym: deal.sym, kind: kind,
      amount: Math.round(deal.amount * 100) / 100, price: deal.price, shares: deal.shares, note: ('富途成交 ' + deal.dealId).slice(0, 100)
    };
    return Object.assign(e, extra || {});
  }

  // 派息：以「同代號、除息日不晚於派發日、尚未被富途配對」的最近一筆手填記錄配對；沒有就新增一筆（來源 futu）。
  // 回傳 { dividends: 新陣列, matched, created, skipped, ambiguous }
  function mergeFutuDividends(dividends, feed, holdingsAt) {
    const out = (dividends || []).map((d) => Object.assign({}, d));
    let matched = 0, created = 0, skipped = 0; const ambiguous = [];
    (feed || []).forEach((f) => {
      if (f.ambiguous || !f.sym || f.sym === '?') { ambiguous.push(f); return; }
      if (out.some((d) => d.futuId === f.id)) { skipped += 1; return; }
      const cands = out.filter((d) => d.sym === f.sym && !d.futuId && d.exDate <= f.paidDate).sort((a, b) => (a.exDate < b.exDate ? 1 : -1));
      const hit = cands[0];
      if (hit) {
        hit.paidDate = f.paidDate; hit.netReceived = f.net; hit.grossReceived = f.gross; hit.futuId = f.id; hit.source = 'futu';
        matched += 1;
      } else {
        // 沒有手填記錄：除息日未知，暫用派發日；每股派息由當時持股反推，持股未知則標記待人工
        const sh = holdingsAt ? holdingsAt(f.sym, f.paidDate) : 0;
        out.push({
          id: 'fd_' + String(f.id).replace(/[^A-Za-z0-9_]/g, '').slice(-40), sym: f.sym, exDate: f.paidDate, perShare: sh > 0 ? f.gross / sh : 0,
          source: 'futu', paidDate: f.paidDate, netReceived: f.net, grossReceived: f.gross, futuId: f.id, needsReview: !(sh > 0)
        });
        created += 1;
      }
    });
    return { dividends: out, matched: matched, created: created, skipped: skipped, ambiguous: ambiguous };
  }

  // 對照：富途實際持倉 vs 網頁推算持倉（只看差異，不自動修正）。diff = 網頁 - 富途
  function comparePositions(futuPositions, holdingsRows, tol) {
    tol = tol == null ? 0.01 : tol;
    const f = {}; (futuPositions || []).forEach((p) => { f[p.sym] = p; });
    const syms = Array.from(new Set(Object.keys(f).concat((holdingsRows || []).filter((r) => r.shares > 0).map((r) => r.sym))));
    return syms.sort().map((sym) => {
      const mine = (holdingsRows || []).find((r) => r.sym === sym);
      const web = mine ? mine.shares : 0, fu = f[sym] ? f[sym].shares : 0;
      const diff = web - fu;
      return { sym: sym, web: web, futu: fu, diff: diff, ok: Math.abs(diff) <= tol, futuCost: f[sym] ? f[sym].costPrice : null, webCost: mine ? mine.avgCost : null };
    });
  }

  // 同步新鮮度：超過 maxHours 沒更新就視為過期，畫面要提醒
  function syncAge(sync, nowMs, maxHours) {
    if (!sync || !sync.syncedAt) return { state: 'never', hours: null };
    const hours = (nowMs - sync.syncedAt) / 3600000;
    return { state: hours > (maxHours || 26) ? 'stale' : 'fresh', hours: hours };
  }

  // ───────── 派息 ─────────
  // 派息記錄 { id, sym, exDate:'YYYY-MM-DD', perShare, source:'manual'|'futu', paidDate?, netReceived? }。
  // 你只需要填除息日；paidDate（派發日）與 netReceived（實際入帳淨額）由日後富途同步帶入。
  // 沒有 paidDate 的視為「預計入帳」：先用 持股數 x 每股派息 x (1 - 預扣稅率) 估算並計入統計；
  // 有 netReceived 的視為「已入帳」：以實際金額取代估算（稅額 = 稅前 - 實收）。
  // 稅前派息 = 除息日「前一個交易日收盤時」的持股數 x 每股派息；香港居民收美股股息預扣 30%。
  // 持股數用 holdingsSummary 同一套規則回推：底倉 + 起算日之後、除息日之前（不含除息日當天）的買賣。
  // 只統計「自統計起始日起（含當天）」的派息：除息日早於起始日的不計（那之前的收益不在這次統計裡）。
  function sharesBefore(base, buys, sym, dateStr) {
    const b = (base && base[sym]) || {};
    const since = b.asOf || '0000-00-00';
    let shares = num(b.shares);
    (buys || []).filter((e) => e.sym === sym && e.date > since && e.date < dateStr)
      .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : (x.ts || 0) - (y.ts || 0))).forEach((e) => {
        const sh = e.shares > 0 ? e.shares : (e.price > 0 ? e.amount / e.price : 0);
        if (e.side === 'sell') shares = Math.max(0, shares - sh); else shares += sh;
      });
    return shares;
  }
  function dividendSummary(base, buys, divs, opts) {
    opts = opts || {};
    const rate = opts.withholding != null ? opts.withholding : 0.30;
    const from = opts.from || '0000-00-00';
    const rows = (divs || []).filter((d) => d.exDate >= from).map((d) => {
      const shares = sharesBefore(base, buys, d.sym, d.exDate);
      const gross = shares * num(d.perShare);
      const paid = d.netReceived != null && isFinite(d.netReceived);
      const net = paid ? num(d.netReceived) : gross * (1 - rate);
      const tax = gross - net;
      return { id: d.id, sym: d.sym, exDate: d.exDate, perShare: num(d.perShare), shares, gross, tax, net, source: d.source || 'manual', paid, paidDate: d.paidDate || null };
    }).sort((a, b) => (a.exDate < b.exDate ? 1 : a.exDate > b.exDate ? -1 : 0));
    const bySym = {};
    rows.forEach((r) => { const s = bySym[r.sym] || (bySym[r.sym] = { gross: 0, tax: 0, net: 0, n: 0 }); s.gross += r.gross; s.tax += r.tax; s.net += r.net; s.n += 1; });
    const sum = (arr, k) => arr.reduce((s, r) => s + r[k], 0);
    const paidRows = rows.filter((r) => r.paid), pendingRows = rows.filter((r) => !r.paid);
    return {
      rows, bySym, rate, from,
      gross: sum(rows, 'gross'), tax: sum(rows, 'tax'), net: sum(rows, 'net'),
      netPaid: sum(paidRows, 'net'), netPending: sum(pendingRows, 'net'), nPaid: paidRows.length, nPending: pendingRows.length
    };
  }

  // 月供：依目標權重拆分
  // 本人與配偶各算各的：本人要記錄，配偶只列出每月每檔金額。
  // 金額四捨五入到分，並把尾差補在權重最大的資產上，確保各檔加總剛好等於月供總額。
  function splitAmount(total, weights) {
    const amts = {}; let sum = 0;
    MONTHLY_ASSETS.forEach((s) => { amts[s] = Math.round(total * weights[s] * 100) / 100; sum += amts[s]; });
    const diff = Math.round((total - sum) * 100) / 100;
    if (diff !== 0) {
      const big = MONTHLY_ASSETS.reduce((a, b) => (weights[b] > weights[a] ? b : a));
      amts[big] = Math.round((amts[big] + diff) * 100) / 100;
    }
    return amts;
  }
  function monthlyPlan(settings, prices) {
    const user = num(settings.monthly.user), spouse = num(settings.monthly.spouse);
    const ua = splitAmount(user, settings.weights), sa = splitAmount(spouse, settings.weights);
    const rows = MONTHLY_ASSETS.map((sym) => {
      const price = prices && prices[sym] > 0 ? prices[sym] : null;
      return {
        sym, weight: settings.weights[sym], price,
        amount: ua[sym], shares: price ? ua[sym] / price : null,            // 本人
        spouseAmount: sa[sym], spouseShares: price ? sa[sym] / price : null // 配偶（僅供參考）
      };
    });
    return {
      user, spouse, total: user + spouse, rows,
      spcx: { user: settings.spcxUsd.user, spouse: settings.spcxUsd.spouse, total: settings.spcxUsd.user + settings.spcxUsd.spouse }
    };
  }

  // 大額入金再平衡：優先補足低於目標的資產，不賣出任何持倉。
  // 注意：這裡用的是月供目標權重（VYM32/SCHD28/QQQ15/SMH12/GLD13），與加倉用的 Level 金額表是兩套不同的表。
  // values: { sym: 目前市值 }
  function rebalance(settings, values, deposit) {
    const syms = MONTHLY_ASSETS;
    const cur = {}; let curTotal = 0;
    syms.forEach((s) => { cur[s] = num(values[s]); curTotal += cur[s]; });
    const total = curTotal + deposit;
    const target = {}; const deficit = {}; let deficitSum = 0;
    syms.forEach((s) => {
      target[s] = total * settings.weights[s];
      deficit[s] = Math.max(0, target[s] - cur[s]);
      deficitSum += deficit[s];
    });
    const buys = {};
    if (deposit <= 0) syms.forEach((s) => { buys[s] = 0; });
    else if (deficitSum >= deposit) syms.forEach((s) => { buys[s] = deficitSum > 0 ? deposit * deficit[s] / deficitSum : 0; });
    else syms.forEach((s) => { buys[s] = deficit[s] + (deposit - deficitSum) * settings.weights[s]; }); // 缺口補滿後餘額按目標權重分配

    const rows = syms.map((s) => {
      const after = cur[s] + buys[s];
      return { sym: s, current: cur[s], curWeight: curTotal > 0 ? cur[s] / curTotal : 0, target: settings.weights[s], buy: buys[s], after, afterWeight: total > 0 ? after / total : 0 };
    });
    // 不產生任何賣出建議：所有賣出只來自本金回收排程。
    return { rows, total, deficitSum };
  }

  return {
    ADD_ASSETS, MONTHLY_ASSETS, DEFAULT_SETTINGS,
    initialState, mergeSettings, drawdown, levelIndex, poolInfo, ruleSheet,
    review, applyExecutions, monthlyPlan, rebalance,
    deriveAssets, ledgerStats, guidance, weekKey, nextWednesday, holdingsSummary, sharesBefore, dividendSummary,
    suggestDeal, pendingDeals, groupDeals, pendingGroups, mergeSplitLedger, dealToLedger, mergeFutuDividends, comparePositions, syncAge
  };
});
