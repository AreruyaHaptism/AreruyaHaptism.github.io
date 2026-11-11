/*
 * 月供投資模組：登入閘門 + Firestore + 帳本 + 指引 UI。
 * 依賴：engine.js（window.InvestEngine）、firebase-config.js（window.FIREBASE_CONFIG）
 * 資料來源原則：加倉帳本（ledger）是唯一事實來源；各 Level 次數、累計本金、回收進度全部由帳本重算。
 * 未填 Firebase 設定時進入「本機測試模式」（資料只存瀏覽器 localStorage）。
 * 本檔不使用 inline 事件與 inline style，以便套用嚴格 CSP。
 */
(function () {
  'use strict';
  if (window.top !== window.self) { document.documentElement.textContent = ''; return; } // 防被 iframe 嵌入
  const E = window.InvestEngine;
  const IDLE_MS = 30 * 60 * 1000;
  const LOCAL_DOC = 'invest_local_doc_v2';
  const LOCAL_LEDGER = 'invest_local_ledger_v2';
  const LOCAL_SYNC = 'invest_local_futusync_v1';
  const ADD = E.ADD_ASSETS, ALL = E.MONTHLY_ASSETS;
  let futuSync = null, syncErr = '';
  const LV = ['L1', 'L2', 'L3', 'L4'];

  const cfg = window.FIREBASE_CONFIG || {};
  const cfgOk = !!(cfg.apiKey && cfg.projectId && !/^YOUR_/.test(cfg.apiKey) && !/^YOUR_/.test(cfg.projectId));
  const mode = cfgOk ? 'cloud' : 'local';

  let fb = null, user = null, doc = null, ledger = [];
  let view = 'guide', started = false, loading = true;
  let gd = null, fetched = null, rbRes = null, msg = null, idleT = null, loginErr = '';
  let fails = 0, lockUntil = 0;

  // ───────── 小工具 ─────────
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = (n) => (n == null || isNaN(n) ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const usd0 = (n) => (n == null || isNaN(n) ? '—' : '$' + Math.round(n).toLocaleString('en-US'));
  const pct = (n) => (n == null || isNaN(n) ? '—' : (n * 100).toFixed(2) + '%');
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const r2 = (n) => Math.round(n * 100) / 100;
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z'));
  const nv = (id) => { const el = $(id); const v = el ? parseFloat(el.value) : NaN; return isFinite(v) ? v : NaN; };
  const sv = (id) => { const el = $(id); return el ? el.value.trim() : ''; };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const banner = (t, cls) => '<div class="inv-banner ' + (cls || '') + '">' + t + '</div>';
  const STATUS = { funded: '加倉', partial: '部分資金', unfunded: '資金用盡', capped: '達上限', exhausted: '次數用滿', none: '未觸發', triggered: '待配置' };

  // ───────── 儲存層 ─────────
  const store = {
    async loadDoc() {
      if (mode === 'local') { const t = localStorage.getItem(LOCAL_DOC); return t ? JSON.parse(t) : null; }
      const m = fb.fs; const snap = await m.getDoc(m.doc(fb.db, 'users', user.uid, 'invest', 'main'));
      return snap.exists() ? JSON.parse(snap.data().json) : null;
    },
    async saveDoc(d) {
      if (mode === 'local') { localStorage.setItem(LOCAL_DOC, JSON.stringify(d)); return; }
      const m = fb.fs; await m.setDoc(m.doc(fb.db, 'users', user.uid, 'invest', 'main'), { json: JSON.stringify(d), updatedAt: Date.now() });
    },
    async loadSync() {
      if (mode === 'local') { const s = localStorage.getItem(LOCAL_SYNC); return s ? JSON.parse(s) : null; }
      const m = fb.fs; const snap = await m.getDoc(m.doc(fb.db, 'users', user.uid, 'futuSync', 'main'));
      return snap.exists() ? JSON.parse(snap.data().json) : null;
    },
    async loadLedger() {
      let a;
      if (mode === 'local') a = JSON.parse(localStorage.getItem(LOCAL_LEDGER) || '[]');
      else { const m = fb.fs; const snap = await m.getDocs(m.collection(fb.db, 'users', user.uid, 'investLedger')); a = snap.docs.map((d) => d.data()); }
      return a.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : (x.ts || 0) - (y.ts || 0)));
    },
    async addEntry(e) {
      if (mode === 'local') { const a = JSON.parse(localStorage.getItem(LOCAL_LEDGER) || '[]'); a.push(e); localStorage.setItem(LOCAL_LEDGER, JSON.stringify(a)); return; }
      const m = fb.fs; await m.setDoc(m.doc(fb.db, 'users', user.uid, 'investLedger', e.id), e);
    },
    async removeEntry(id) {
      if (mode === 'local') { const a = JSON.parse(localStorage.getItem(LOCAL_LEDGER) || '[]').filter((x) => x.id !== id); localStorage.setItem(LOCAL_LEDGER, JSON.stringify(a)); return; }
      const m = fb.fs; await m.deleteDoc(m.doc(fb.db, 'users', user.uid, 'investLedger', id));
    }
  };

  function normalize(d) {
    d = d || {};
    const st = d.state || E.initialState();
    ADD.forEach((s) => {
      if (!st.assets[s]) st.assets[s] = { high52: 0, counts: { L1: 0, L2: 0, L3: 0, L4: 0 }, cumulative: 0, roundId: 1, lastClose: null, recovery: null };
      const a = st.assets[s]; a.counts = Object.assign({ L1: 0, L2: 0, L3: 0, L4: 0 }, a.counts); a.recoveryDone = a.recoveryDone || [];
    });
    const inp = Object.assign({ date: null, closes: {}, highs: {}, cash: null, boxx: null, avail: null }, d.inputs || {});
    return { state: st, settings: E.mergeSettings(d.settings), inputs: inp, prices: d.prices || {}, monthlyDone: d.monthlyDone || {}, holdingsBase: d.holdingsBase || {}, dividends: d.dividends || [], divFrom: d.divFrom || today(), values: d.values || {}, futu: Object.assign({ handled: {} }, d.futu || {}) };
  }
  async function persist() { doc.state.asOf = doc.state.asOf || today(); await store.saveDoc(doc); }
  function rederive() { const r = E.deriveAssets(doc.settings, doc.state, ledger); doc.state = r.state; return r.events; }

  // ───────── 行情（Twelve Data，每週收盤，可選） ─────────
  async function fetchWeekly(key, syms) {
    const url = 'https://api.twelvedata.com/time_series?symbol=' + syms.join(',') + '&interval=1week&outputsize=53&apikey=' + encodeURIComponent(key);
    const res = await fetch(url); const j = await res.json();
    if (j.status === 'error' && j.message) {
      // 批次整批被拒（常見：其中一個代號行情源沒有）時，改成逐檔抓，讓抓得到的照常更新；金鑰錯誤則直接回報
      if (syms.length > 1 && !/api ?key|apikey|credits|limit/i.test(j.message)) {
        const out = {};
        for (const s of syms) { try { Object.assign(out, await fetchWeekly(key, [s])); } catch (e) { out[s] = { error: e.message }; } }
        return out;
      }
      throw new Error(j.message);
    }
    const out = {};
    syms.forEach((sym) => {
      const x = syms.length === 1 ? j : j[sym];
      if (!x || x.status === 'error' || !x.values || !x.values.length) { out[sym] = { error: (x && x.message) || '無資料' }; return; }
      const closes = x.values.map((v) => parseFloat(v.close)).filter((c) => isFinite(c));
      const prev = closes.slice(1, 52);
      out[sym] = { close: closes[0], date: x.values[0].datetime, prevHigh: prev.length ? Math.max.apply(null, prev) : null };
    });
    return out;
  }

  // ───────── 畫面骨架 ─────────
  const VIEWS = [['guide', '操作指引'], ['ledger', '帳本與統計'], ['futu', '富途同步'], ['rules', '規則總覽'], ['monthly', '月供'], ['positions', '持倉盈虧'], ['rebalance', '再平衡'], ['settings', '設定']];

  function render() {
    const el = $('invest-root'); if (!el) return;
    if (loading) { el.innerHTML = '<div class="inv-card">載入中…</div>'; return; }
    if (mode === 'cloud' && !user) { el.innerHTML = loginView(); return; }
    if (!doc) { el.innerHTML = '<div class="inv-card">' + banner(esc(msg ? msg.text : '無法載入資料'), 'err') + '<button class="inv-btn ghost" data-act="logout">登出</button></div>'; return; }
    const who = mode === 'cloud' ? esc(user.email) : '本機測試模式';
    let body = '';
    try { body = ({ guide: vGuide, ledger: vLedger, rules: vRules, futu: vFutu, monthly: vMonthly, positions: vPositions, rebalance: vRebalance, settings: vSettings })[view](); }
    catch (e) { body = banner('畫面錯誤：' + esc(e.message), 'err'); }
    el.innerHTML =
      '<div class="inv-card"><div class="inv-head"><div><h1>月供投資計劃</h1><div class="inv-sub">資料截至 ' + esc(doc.state.asOf) + ' · ' + who + '</div></div>' +
      '<div>' + (mode === 'cloud' ? '<button class="inv-btn ghost" data-act="logout">登出</button>' : '') + '</div></div>' +
      (mode === 'local' ? banner('尚未設定 Firebase，目前為<b>本機測試模式</b>：沒有登入保護，資料只存在這個瀏覽器。請依 <code>SETUP.md</code> 完成設定後才會啟用登入與雲端同步。') : '') +
      '<div class="inv-subtabs">' + VIEWS.map((v) => '<div class="inv-subtab' + (v[0] === view ? ' active' : '') + '" data-act="view" data-v="' + v[0] + '">' + v[1] + '</div>').join('') + '</div>' +
      (msg && msg.text ? banner(esc(msg.text), msg.cls || '') : '') + '</div>' + body;
    msg = null;
  }

  function loginView() {
    const wait = Math.ceil((lockUntil - Date.now()) / 1000);
    return '<div class="inv-card inv-login"><h1>登入</h1><div class="inv-sub">此頁面僅限本人使用</div>' +
      (loginErr ? banner(esc(loginErr), 'err') : '') +
      '<div class="row"><label>電子郵件</label><input type="email" id="lg-email" autocomplete="username"></div>' +
      '<div class="row"><label>密碼</label><input type="password" id="lg-pass" autocomplete="current-password"></div>' +
      '<button class="inv-btn" data-act="login"' + (wait > 0 ? ' disabled' : '') + '>登入</button></div>';
  }

  // ───────── 操作指引（主頁面） ─────────
  function inputsRows() {
    const inp = doc.inputs, st = doc.state;
    return ADD.map((sym) => {
      const a = st.assets[sym]; const f = fetched && fetched[sym];
      const hi = inp.highs[sym] != null ? inp.highs[sym] : a.high52;
      const cl = inp.closes[sym] != null ? inp.closes[sym] : '';
      const warn = f && f.prevHigh && f.prevHigh > a.high52 + 1e-9 ? '<div class="inv-note neg">近 52 週最高收盤 ' + usd(f.prevHigh) + ' 高於你的記錄，已用較高者</div>' : '';
      const err = f && f.error ? '<div class="inv-note neg">' + esc(f.error) + '</div>' : '';
      return '<tr><td><b>' + sym + '</b>' + warn + err + '</td><td><input type="number" step="0.001" id="g-high-' + sym + '" value="' + hi + '"></td><td><input type="number" step="0.001" id="g-close-' + sym + '" value="' + cl + '"></td></tr>';
    }).join('');
  }

  function adviceHtml(it) {
    return it.advice.map((l) => '<div class="adv adv-' + l.kind + '">' + esc(l.text) + '</div>').join('');
  }

  function recordForm(it, wed) {
    let h = '';
    if (it.add > 0 && !it.doneAdd) {
      h += '<div class="inv-rec"><span class="tag funded">記錄買入</span><div><label>實際買入金額（買不足照填，差額自動記欠買）</label><input type="number" step="0.01" id="rg-amt-' + it.sym + '" value="' + it.add + '"></div>' +
        '<div><label>成交價（選填，用於均價）</label><input type="number" step="0.001" id="rg-px-' + it.sym + '"></div>' +
        '<div><label>日期</label><input type="date" id="rg-date-' + it.sym + '" value="' + wed + '"></div>' +
        '<button class="inv-btn" data-act="recAdd" data-sym="' + it.sym + '">記錄為 ' + it.level + ' 加倉</button></div>';
    }
    if (it.recovery && it.recovery.status === 'sell' && !it.doneSell) {
      h += '<div class="inv-rec"><span class="tag sell">記錄賣出</span><div><label>實際賣出金額</label><input type="number" step="0.01" id="rs-amt-' + it.sym + '" value="' + it.recovery.amount + '"></div>' +
        '<div><label>成交價（選填）</label><input type="number" step="0.001" id="rs-px-' + it.sym + '"></div>' +
        '<div><label>日期</label><input type="date" id="rs-date-' + it.sym + '" value="' + wed + '"></div>' +
        '<button class="inv-btn" data-act="recSell" data-sym="' + it.sym + '">記錄本金回收賣出</button></div>';
    }
    return h;
  }

  function guideResult() {
    if (!gd) return '<div class="inv-card"><div class="inv-note">輸入最新價與 52 週高後按「計算指引」。</div></div>';
    const p = gd.plan;
    const cash = doc.inputs.cash;
    const evs = p.events.map((e) => e.type === 'new-high' ? e.sym + ' 創 52 週新高' : e.type === 'recovery-start' ? e.sym + ' 觸發本金回收' : e.type).concat(gd.derivedEvents.map((e) => e.sym + ' 本金回收排程已完成'));
    const cards = p.items.map((it) => {
      if (it.error) return '<div class="inv-asset"><b>' + it.sym + '</b> <span class="neg">' + esc(it.error) + '</span></div>';
      const tag = '<span class="tag ' + it.status + '">' + (it.level ? it.level + ' ' + it.used + '/' + it.max + ' · ' : '') + (STATUS[it.status] || it.status) + '</span>';
      return '<div class="inv-asset"><div class="inv-asset-head"><b>' + it.sym + '</b><span>最新 ' + usd(it.close) + '</span><span>52 週高 ' + usd(it.high52) + '</span><span class="' + (it.dd < 0 ? 'neg' : '') + '">回撤 ' + pct(it.dd) + '</span>' + tag + '</div>' +
        adviceHtml(it) + recordForm(it, gd.wed) + '</div>';
    }).join('');
    return '<div class="inv-card"><h2>指引：下一個執行日 ' + esc(gd.wed) + '（週三）</h2>' +
      (evs.length ? banner(esc(evs.join('；')) + '。按下方「儲存本週數據」或直接記錄操作時才會正式生效。', '') : '') +
      '<div class="inv-grid">' +
      '<div class="inv-stat"><span>待執行加倉合計</span><b>' + usd0(p.needCash) + '</b></div>' +
      '<div class="inv-stat"><span>待執行回收賣出</span><b>' + usd0(p.sellTotal) + '</b></div>' +
      '<div class="inv-stat"><span>現金寶</span><b>' + usd0(cash) + '</b></div>' +
      '<div class="inv-stat"><span>資金池剩餘額度</span><b>' + usd0(p.headroom) + '</b></div></div>' +
      (p.needCash > cash ? banner('待執行加倉 ' + usd0(p.needCash) + ' 超過現金寶 ' + usd0(cash) + '，差額需先由 BOXX 變現。') : '') +
      '</div>' + cards +
      '<div class="inv-card"><button class="inv-btn alt" data-act="commit">儲存本週數據</button><div class="inv-note">儲存會把新高重置、回收排程啟動寫入記錄。次數與金額一律由「帳本」統計，不會因此重複計算。</div></div>';
  }

  function vGuide() {
    const inp = doc.inputs, st = doc.state;
    const fdate = fetched ? Object.values(fetched).find((x) => x.date) : null;
    const first = ledger.length === 0 ? banner('帳本目前是空的。請先到「帳本與統計」把你以前每一次加倉補記進去（例如 QQQ L1 一次 $420、SMH L3 一次 $1,259），次數與累計金額才會正確。') : '';
    return first + '<div class="inv-card"><h2>輸入最新數據</h2>' +
      '<div class="inv-grid"><div><label>檢視日期</label><input type="date" id="g-date" value="' + esc(inp.date || today()) + '"></div>' +
      '<div><label>現金寶 (USD)</label><input type="number" step="0.01" id="g-cash" value="' + (inp.cash != null ? inp.cash : st.cash) + '"></div>' +
      '<div><label>BOXX 市值 (USD)</label><input type="number" step="0.01" id="g-boxx" value="' + (inp.boxx != null ? inp.boxx : st.boxx) + '"></div>' +
      '<div><label>本週可動用資金（留空 = 現金寶）</label><input type="number" step="0.01" id="g-avail" value="' + (inp.avail != null ? inp.avail : '') + '" placeholder="自動"></div></div>' +
      '<div class="inv-scroll mt12"><table><tr><th>資產</th><th>52 週高（週線收盤，創新高前的舊高點）</th><th>最新價 / 本週收盤</th></tr>' + inputsRows() + '</table></div>' +
      (fdate ? '<div class="inv-note">最新週線日期：' + esc(fdate.date) + '（週中抓取時為當時最新價）</div>' : '') +
      '<div class="sp8"></div><button class="inv-btn" data-act="compute">計算指引</button><button class="inv-btn alt" data-act="fetch" data-target="guide">自動抓價（選用）</button>' +
      '<div class="inv-note">加倉指引只涵蓋 QQQ、SMH、VYM、SCHD；SPCX、GLD 與 QQQI、QYLD 不在加倉系統內。不抓價也能用：手動填入 52 週高與最新價即可。若最新價高於 52 週高，系統會判定創新高並重置次數。</div></div>' + guideResult();
  }

  // ───────── 帳本與統計 ─────────
  function vLedger() {
    const s = doc.settings;
    const stats = E.ledgerStats(s, doc.state, ledger);
    const head = '<tr><th>資產</th>' + s.levels.map((l) => '<th>' + l.id + ' 次數 · 金額</th>').join('') + '<th>本輪加倉總額</th><th>已回收本金</th><th>累計本金（淨額）</th><th>欠買</th><th>歷史加倉次數</th><th>歷史加倉總額</th><th>加倉持股</th><th>加倉均價</th><th>已回收賣出</th></tr>';
    const rows = ADD.map((sym) => {
      const x = stats[sym]; const a = doc.state.assets[sym];
      return '<tr><td><b>' + sym + '</b><div class="inv-note">第 ' + a.roundId + ' 輪</div></td>' +
        s.levels.map((l) => { const c = x.levels[l.id]; return '<td>' + c.count + '/' + c.max + ' · ' + usd0(c.amount) + (c.allCount !== c.count ? '<div class="inv-note">歷史 ' + c.allCount + ' 次 ' + usd0(c.allAmount) + '</div>' : '') + '</td>'; }).join('') +
        '<td>' + usd0(x.roundGross) + '</td><td>' + usd0(x.roundRecovered) + '</td><td><b>' + usd0(x.cumulative) + '</b></td><td class="' + (x.backlog > 0.005 ? 'neg' : 'muted') + '">' + (x.backlog > 0.005 ? usd(x.backlog) : '—') + '</td><td>' + x.totalCount + '</td><td>' + usd0(x.totalAmount) + '</td><td>' + (x.shares ? x.shares.toFixed(3) : '—') + '</td><td>' + (x.avgCost ? usd(x.avgCost) : '—') + '</td><td>' + usd0(x.sold) + '</td></tr>';
    }).join('');
    const list = ledger.slice().reverse().map((e) => '<tr><td>' + esc(e.date) + '</td><td><b>' + esc(e.sym) + '</b></td><td>' + (e.kind === 'add' ? '加倉' : '本金回收賣出') + '</td><td>' + esc(e.level || '—') + '</td><td>' + usd(e.amount) + '</td><td>' + (e.price ? usd(e.price) : '—') + '</td><td>' + (e.kind === 'add' && e.base > 0 && e.amount + 0.005 < e.base ? '<span class="neg">短 ' + usd(e.base - e.amount) + '</span>' : '—') + '</td><td>第 ' + esc(e.round || 1) + ' 輪</td><td>' + esc(e.note || '') + '</td><td><button class="inv-btn ghost" data-act="delEntry" data-id="' + esc(e.id) + '">刪除</button></td></tr>').join('');
    return '<div class="inv-card"><h2>加倉統計（由帳本自動計算）</h2><div class="inv-scroll"><table>' + head + rows + '</table></div>' +
      '<div class="inv-note">各 Level 次數與金額為「當前輪」（創新高後歸零重算）；加倉只針對 QQQ、SMH、VYM、SCHD（SPCX 沒有回撤 Level 規則，它的每月買入記在「月供」頁、盈虧在「持倉盈虧」頁）。「累計本金（淨額）」= 本輪加倉總額 - 已回收本金，也就是目前仍留在市場、還沒收回的加倉本金；它決定回收排程的基數與單一資產上限的使用量。小字「歷史」為跨輪累計。每筆買入都算一次；買不足的差額記為「欠買」，下次加倉時自動補上。持股與均價只含加倉部分（且只計有填成交價的記錄），不含月供與既有持倉。</div></div>' +
      '<div class="inv-card"><h2>新增一筆記錄</h2><div class="inv-grid">' +
      '<div><label>日期</label><input type="date" id="m-date" value="' + today() + '"></div>' +
      '<div><label>資產</label><select id="m-sym">' + ADD.map((x) => '<option>' + x + '</option>').join('') + '</select></div>' +
      '<div><label>類型</label><select id="m-kind"><option value="add">加倉買入</option><option value="recovery">本金回收賣出</option></select></div>' +
      '<div><label>Level（加倉才需要）</label><select id="m-level">' + LV.map((x) => '<option>' + x + '</option>').join('') + '</select></div>' +
      '<div><label>金額 (USD)</label><input type="number" step="0.01" id="m-amt"></div>' +
      '<div><label>成交價（選填）</label><input type="number" step="0.001" id="m-px"></div>' +
      '<div><label>備註</label><input type="text" id="m-note" maxlength="100"></div>' +
      '<div><label>該次基本金額（選填，買不足時才填）</label><input type="number" step="0.01" id="m-base"></div></div>' +
      '<div class="sp8"></div><button class="inv-btn" data-act="addEntry">新增記錄</button>' +
      '<div class="inv-note">每筆加倉買入都算一次。若當時買不足，填上「該次基本金額」（例如 L1 是 $420，實際只買 $300），系統會把差額 $120 記為欠買，下次加倉補上。記錄一律歸入該資產「當前輪」；舊一輪的操作請先在設定頁調整輪次再補記。</div></div>' +
      '<div class="inv-card"><h2>全部記錄（' + ledger.length + ' 筆）</h2>' + (list ? '<div class="inv-scroll"><table><tr><th>日期</th><th>資產</th><th>類型</th><th>Level</th><th>金額</th><th>成交價</th><th>當次短買</th><th>輪次</th><th>備註</th><th></th></tr>' + list + '</table></div>' : '<div class="inv-note">尚無記錄。</div>') + '</div>';
  }

  // ───────── 月供 ─────────
  // 本人月供要記錄的資產：月供五檔 + SPCX（獨立定投，不計入月供比例）
  const MP_SYMS = ALL.concat(['SPCX']);
  function vMonthly() {
    const s = doc.settings; const mp = E.monthlyPlan(s, {});
    const key = today().slice(0, 7);
    const rec = doc.monthlyDone[key] && typeof doc.monthlyDone[key] === 'object' ? doc.monthlyDone[key] : null;
    const line = (sym, label, due, weightTxt) => {
      const p = doc.prices[sym]; const act = rec && rec.items && rec.items[sym];
      return '<tr><td><b>' + sym + '</b>' + (label || '') + '</td><td>' + weightTxt + '</td><td>' + usd(due) + '</td>' +
        '<td><input type="number" step="0.001" id="mp-price-' + sym + '" data-monthly="1" data-amount="' + due + '" value="' + (p ? p.price : '') + '"></td>' +
        '<td id="mp-sh-' + sym + '">—</td><td id="mp-wh-' + sym + '">—</td>' +
        '<td><input type="number" step="0.01" id="mp-act-' + sym + '" value="' + (act ? act.amount : due) + '"></td></tr>';
    };
    const rows = mp.rows.map((r) => line(r.sym, '', r.amount, (r.weight * 100).toFixed(0) + '%')).join('') +
      line('SPCX', '<div class="inv-note">月供以外的獨立定投</div>', s.spcxUsd.user, '不計入');
    const spouseRows = mp.rows.map((r) => '<tr><td><b>' + r.sym + '</b></td><td>' + (r.weight * 100).toFixed(0) + '%</td><td>' + usd(r.spouseAmount) + '</td></tr>').join('') +
      '<tr><td><b>SPCX</b><div class="inv-note">月供以外的獨立定投</div></td><td>不計入</td><td>' + usd(s.spcxUsd.spouse) + '</td></tr>';
    const hist = Object.keys(doc.monthlyDone).sort().reverse().slice(0, 12).map((k) => '<span class="tag funded">' + esc(k) + '</span>').join(' ');
    return '<div class="inv-card"><h2>本人月供：每月 ' + s.monthly.day + ' 日 ' + usd0(s.monthly.user) + '，另加 SPCX ' + usd0(s.spcxUsd.user) + '</h2>' +
      '<div class="inv-scroll"><table><tr><th>資產</th><th>目標比例</th><th>應買金額</th><th>成交價</th><th>約可買股數</th><th>整股</th><th>實際買入金額</th></tr>' + rows + '</table></div>' +
      '<div class="inv-note">填「成交價」才會把這次買入計入持倉與盈虧（金額 ÷ 成交價 = 股數）；沒填價格只記金額，持倉頁會標示為待定投入。QQQI、QYLD 為既有持倉，不在月供與加倉範圍。</div>' +
      '<div class="sp8"></div><button class="inv-btn alt" data-act="fetch" data-target="monthly">自動抓價（選用）</button>' +
      '<div class="inv-grid mt8"><div><label>執行日期</label><input type="date" id="mp-date" value="' + today() + '"></div></div>' +
      '<div class="sp8"></div><button class="inv-btn" data-act="logMonthly">記錄本月月供已執行</button>' +
      '<div class="inv-note">已記錄月份：' + (hist || '尚無') + '</div></div>' +
      '<div class="inv-card"><h2>配偶月供（僅供參考，不記錄）：每月 ' + usd0(s.monthly.spouse) + '，另加 SPCX ' + usd0(s.spcxUsd.spouse) + '</h2>' +
      '<div class="inv-scroll"><table><tr><th>資產</th><th>目標比例</th><th>每月買入金額</th></tr>' + spouseRows + '</table></div>' +
      '<div class="inv-note">這裡只列出每月要買多少，不做記錄與統計。</div></div>';
  }
  function recalcMonthly() {
    document.querySelectorAll('input[data-monthly]').forEach((inp) => {
      const sym = inp.id.replace('mp-price-', ''); const p = parseFloat(inp.value); const amt = parseFloat(inp.dataset.amount);
      $('mp-sh-' + sym).textContent = p > 0 ? (amt / p).toFixed(3) : '—';
      $('mp-wh-' + sym).textContent = p > 0 ? Math.floor(amt / p) + '（剩 ' + usd(amt - Math.floor(amt / p) * p) + '）' : '—';
    });
  }

  // ───────── 持倉與盈虧 ─────────
  // 底倉 = 你在富途看到的、截至「起算日」的全部持倉；起算日之後記錄的月供、加倉、SPCX 才會累加。
  const POS_BASE = ALL.concat(['SPCX']);
  function posSyms() { return POS_BASE.concat((doc.settings.otherHoldings || []).filter((x) => !POS_BASE.includes(x))); }
  // 把月供記錄與加倉帳本統一成買賣流水，供 holdingsSummary 累加
  function buyFlow() {
    const out = [];
    Object.keys(doc.monthlyDone).forEach((k) => {
      const m = doc.monthlyDone[k]; if (!m || typeof m !== 'object' || !m.items) return;
      Object.keys(m.items).forEach((sym) => { const it = m.items[sym]; if (it.amount > 0) out.push({ sym, date: m.date, amount: it.amount, price: it.price, ts: 0, src: 'monthly' }); });
    });
    ledger.forEach((e) => out.push({ sym: e.sym, date: e.date, amount: e.amount, price: e.price, shares: e.shares, side: e.kind === 'recovery' ? 'sell' : 'buy', ts: e.ts || 0, src: 'ledger' }));
    return out;
  }
  function priceMap() { const m = {}; Object.keys(doc.prices).forEach((k) => { m[k] = doc.prices[k].price; }); return m; }

  function vPositions() {
    const syms = posSyms();
    const base = doc.holdingsBase || {};
    const hs = E.holdingsSummary(base, buyFlow(), priceMap(), { syms });
    const cls = (n) => (n == null ? 'muted' : n >= 0 ? 'pos' : 'neg');
    const sg = (n) => (n == null ? '—' : (n >= 0 ? '+' : '-') + usd(Math.abs(n)));
    const sp = (n) => (n == null ? '—' : (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%');
    const stat = (l, v, c) => '<div class="inv-stat"><span>' + l + '</span><b class="' + (c || '') + '">' + v + '</b></div>';
    const rows = hs.rows.map((r) => {
      const b = base[r.sym] || {};
      return '<tr><td><b>' + r.sym + '</b>' + (r.unpricedN ? '<div class="inv-note neg">' + r.unpricedN + ' 筆沒填成交價（' + usd(r.unpriced) + '）未計入</div>' : '') + '</td>' +
        '<td>' + (r.shares ? r.shares.toFixed(4) : '—') + '</td><td>' + (r.avgCost ? usd(r.avgCost) : '—') + '</td><td>' + (r.price != null ? usd(r.price) : '<span class="neg">未填</span>') + '</td>' +
        '<td>' + usd(r.cost) + '</td><td>' + (r.value != null ? usd(r.value) : '—') + '</td>' +
        '<td class="' + cls(r.pnl) + '">' + sg(r.pnl) + '</td><td class="' + cls(r.pnlPct) + '">' + sp(r.pnlPct) + '</td></tr>';
    }).join('');
    const baseRows = syms.map((sym) => { const b = base[sym] || {};
      return '<tr><td><b>' + sym + '</b></td><td><input type="number" step="0.0001" id="pb-sh-' + sym + '" value="' + (b.shares != null ? b.shares : '') + '"></td>' +
        '<td><input type="number" step="0.0001" id="pb-cost-' + sym + '" value="' + (b.cost != null ? b.cost : '') + '"></td>' +
        '<td><input type="date" id="pb-asof-' + sym + '" value="' + esc(b.asOf || '') + '"></td>' +
        '<td><input type="number" step="0.001" id="pp-' + sym + '" value="' + (doc.prices[sym] ? doc.prices[sym].price : '') + '"></td></tr>'; }).join('');
    const warn = [];
    if (hs.missingPrice.length) warn.push('以下資產沒有最新價，未計入市值與盈虧：' + hs.missingPrice.join('、'));
    if (hs.unpriced > 0) warn.push('有 ' + usd(hs.unpriced) + ' 的買入沒填成交價，無法換算股數，未計入持倉（請到月供頁或帳本補填價格）');
    // 三種盈虧：僅持倉盈虧（未實現 + 本金回收已實現）、派息淨額（扣預扣稅）、總盈虧
    const ds = E.dividendSummary(base, buyFlow(), doc.dividends, { from: doc.divFrom, withholding: doc.settings.withholding });
    const holdPnl = hs.pnl + hs.realized;
    const totalPnl = holdPnl + ds.net;
    const taxPct = (doc.settings.withholding * 100).toFixed(0);
    const divRows = ds.rows.map((r) => '<tr><td>' + esc(r.exDate) + '</td><td><b>' + esc(r.sym) + '</b></td><td>' + usd(r.perShare) + '</td><td>' + r.shares.toFixed(4) + '</td><td>' + usd(r.gross) + '</td><td class="neg">-' + usd(r.tax) + '</td><td class="pos">' + usd(r.net) + '</td><td>' + (r.paid ? '<span class="tag funded">已入帳' + (r.paidDate ? ' ' + esc(r.paidDate) : '') + '</span>' : '<span class="tag partial">預計入帳</span>') + '</td><td>' + (r.source === 'futu' ? '富途' : '手填') + '</td>' +
      '<td><button class="inv-btn ghost" data-act="delDiv" data-id="' + esc(r.id) + '">刪除</button></td></tr>').join('');
    const outOfRange = (doc.dividends || []).length - ds.rows.length;
    return '<div class="inv-card"><h2>盈虧總覽</h2>' +
      (warn.length ? banner(esc(warn.join('；'))) : '') +
      '<div class="inv-grid">' +
      stat('僅持倉盈虧', sg(holdPnl), cls(holdPnl)) + stat('派息淨額（扣 ' + taxPct + '% 預扣稅）', sg(ds.net), cls(ds.net)) + stat('總盈虧', sg(totalPnl), cls(totalPnl)) + '</div>' +
      '<div class="inv-grid mt8">' + stat('總市值', usd(hs.totalValue)) + stat('總成本', usd(hs.totalCost)) + stat('持倉報酬率', sp(hs.pnlPct), cls(hs.pnlPct)) +
      stat('其中：未實現', sg(hs.pnl), cls(hs.pnl)) + stat('其中：已實現（本金回收）', sg(hs.realized), cls(hs.realized)) + stat('派息稅前 / 預扣稅', usd(ds.gross) + ' / ' + usd(ds.tax)) + stat('其中：已入帳', usd(ds.netPaid) + '（' + ds.nPaid + ' 筆）') + stat('其中：預計待入帳', usd(ds.netPending) + '（' + ds.nPending + ' 筆）') + '</div>' +
      '<div class="inv-note">總盈虧 = 僅持倉盈虧 + 派息淨額。派息只統計 <b>' + esc(doc.divFrom) + '</b> 起（含當天）的除息記錄；僅持倉盈虧不受統計起始日影響，是持倉相對成本的全部盈虧。</div></div>' +
      '<div class="inv-card"><h2>持倉明細（月供 + 加倉 + SPCX + 既有持倉）</h2>' +
      '<div class="inv-scroll mt12"><table><tr><th>資產</th><th>股數</th><th>均價</th><th>最新價</th><th>成本</th><th>市值</th><th>盈虧</th><th>報酬率</th></tr>' + rows + '</table></div>' +
      '<div class="inv-note">總盈虧只含「有最新價」的資產。已實現盈虧來自本金回收的賣出（平均成本法），不含在上面的未實現總盈虧內。</div></div>' +
      '<div class="inv-card"><h2>派息記錄（預扣 ' + taxPct + '%）</h2>' +
      '<div class="inv-grid"><div><label>統計起始日（只計此日起的除息）</label><input type="date" id="dv-from" value="' + esc(doc.divFrom) + '"></div></div>' +
      '<div class="sp8"></div><button class="inv-btn alt" data-act="saveDivFrom">更新起始日</button>' +
      '<div class="inv-grid mt12"><div><label>資產</label><select id="dv-sym">' + syms.map((x) => '<option>' + x + '</option>').join('') + '</select></div>' +
      '<div><label>除息日</label><input type="date" id="dv-date" value="' + today() + '"></div>' +
      '<div><label>每股派息 (USD)</label><input type="number" step="0.0001" id="dv-ps"></div></div>' +
      '<div class="sp8"></div><button class="inv-btn" data-act="addDiv">新增派息</button>' +
      '<div class="inv-note">用「除息日前一日收盤時的持股數」乘每股派息得稅前金額，再扣 ' + taxPct + '% 預扣稅。持股數由底倉與之後的買賣記錄自動推算；除息日當天才買入的股數不享有該次派息。每股派息請填稅前金額。你只需填除息日：新增後立刻以預計金額計入統計（標示「預計入帳」）；日後接上富途同步，派發日與實際入帳淨額會自動帶入並取代預計值，不會重複計算。富途帳戶要到派發日才會收到這筆錢，所以派發日之前你的統計會比富途帳面多出「預計待入帳」這一項。</div>' +
      (divRows ? '<div class="inv-scroll mt12"><table><tr><th>除息日</th><th>資產</th><th>每股</th><th>持股</th><th>稅前</th><th>預扣稅</th><th>稅後淨額</th><th>狀態</th><th>來源</th><th></th></tr>' + divRows + '</table></div>' : '<div class="inv-note">起始日之後尚無派息記錄。</div>') +
      (outOfRange > 0 ? '<div class="inv-note">另有 ' + outOfRange + ' 筆除息日早於起始日，未計入。</div>' : '') + '</div>' +
      '<div class="inv-card"><h2>底倉與最新價</h2><div class="inv-note">底倉填你在富途看到的、截至「起算日」的全部持倉（股數與每股成本價）。系統只會累加起算日<b>之後</b>記錄的月供、加倉與 SPCX，起算日當天及之前的記錄視為已含在底倉內，不會重複計算。最新價與月供頁、指引頁共用。</div>' +
      '<div class="inv-scroll mt8"><table><tr><th>資產</th><th>股數</th><th>每股成本價</th><th>起算日</th><th>最新價</th></tr>' + baseRows + '</table></div>' +
      '<div class="sp8"></div><button class="inv-btn" data-act="savePositions">儲存底倉與最新價</button><button class="inv-btn alt" data-act="fetch" data-target="positions">自動抓價（選用）</button></div>';
  }


  async function doAddDiv() {
    const sym = sv('dv-sym'), exDate = sv('dv-date'), ps = nv('dv-ps');
    if (!posSyms().includes(sym)) throw new Error('資產無效'); if (!isDate(exDate)) throw new Error('除息日格式不正確');
    if (!(ps > 0)) throw new Error('每股派息必須大於 0');
    if ((doc.dividends || []).some((d) => d.sym === sym && d.exDate === exDate) && !confirm(sym + ' 在 ' + exDate + ' 已有一筆派息，仍要新增嗎？')) return;
    doc.dividends = (doc.dividends || []).concat([{ id: newId(), sym, exDate, perShare: ps, source: 'manual' }]);
    await persist(); msg = { text: sym + ' ' + exDate + ' 派息已記錄', cls: 'ok' };
  }
  async function doDelDiv(id) {
    if (!confirm('刪除這筆派息？')) return;
    doc.dividends = (doc.dividends || []).filter((d) => d.id !== id); await persist(); msg = { text: '已刪除', cls: 'ok' };
  }
  async function doSaveDivFrom() {
    const d = sv('dv-from'); if (!isDate(d)) throw new Error('起始日格式不正確');
    doc.divFrom = d; await persist(); msg = { text: '統計起始日已更新為 ' + d, cls: 'ok' };
  }

  async function doSavePositions() {
    const base = {}, syms = posSyms(); const bad = [];
    syms.forEach((sym) => {
      const sh = nv('pb-sh-' + sym), cost = nv('pb-cost-' + sym), asOf = sv('pb-asof-' + sym), pr = nv('pp-' + sym);
      if (isFinite(sh) && sh > 0) {
        if (!(cost >= 0)) bad.push(sym + ' 缺每股成本價'); else if (!isDate(asOf)) bad.push(sym + ' 缺起算日');
        else base[sym] = { shares: sh, cost, asOf };
      } else if (isFinite(cost) && cost > 0) bad.push(sym + ' 有成本價但沒有股數');
      if (pr > 0) doc.prices[sym] = { price: pr, date: today() };
    });
    if (bad.length) throw new Error('底倉資料不完整：' + bad.join('；'));
    doc.holdingsBase = base; await persist(); msg = { text: '底倉與最新價已儲存', cls: 'ok' };
  }

  // ───────── 再平衡 ─────────
  function vRebalance() {
    const rows = ALL.map((s) => '<tr><td><b>' + s + '</b></td><td>' + (doc.settings.weights[s] * 100).toFixed(0) + '%</td><td><input type="number" step="0.01" id="rb-v-' + s + '" value="' + (doc.values[s] != null ? doc.values[s] : '') + '"></td></tr>').join('');
    let out = '';
    if (rbRes) {
      out = '<div class="inv-card"><h2>建議</h2><div class="inv-scroll"><table><tr><th>資產</th><th>目標</th><th>目前市值</th><th>目前佔比</th><th>建議買入</th><th>買入後佔比</th></tr>' +
        rbRes.rows.map((r) => '<tr><td><b>' + r.sym + '</b></td><td>' + pct(r.target) + '</td><td>' + usd(r.current) + '</td><td>' + pct(r.curWeight) + '</td><td class="' + (r.buy > 0 ? 'pos' : 'muted') + '">' + usd(r.buy) + '</td><td>' + pct(r.afterWeight) + '</td></tr>').join('') + '</table></div>' +
        '<div class="inv-note">這裡只建議新入金買哪幾檔，不會建議賣出任何持倉。所有賣出只來自「本金回收」排程。使用的是月供目標比例，與加倉的 Level 金額表無關。</div></div>';
    }
    return '<div class="inv-card"><h2>大額入金再平衡</h2><div class="inv-note">優先用新入金補足低於目標的資產，盡量不賣出已偏高的資產。輸入各資產目前市值與入金金額。</div>' +
      '<div class="inv-scroll"><table><tr><th>資產</th><th>目標比例</th><th>目前市值 (USD)</th></tr>' + rows + '</table></div>' +
      '<div class="inv-grid mt8"><div><label>新入金金額 (USD)</label><input type="number" step="0.01" id="rb-dep" value=""></div></div>' +
      '<div class="sp8"></div><button class="inv-btn" data-act="rebalance">計算</button></div>' + out;
  }

  // ───────── 設定 ─────────
  // ───────── 規則總覽：逐層列出金額、次數、佔用資金，供對照原始設計 ─────────
  function vRules() {
    const s = doc.settings, st = doc.state, i = doc.inputs;
    const cash = i.cash != null ? i.cash : st.cash, boxx = i.boxx != null ? i.boxx : st.boxx;
    const highs = {}; ADD.forEach((k) => { highs[k] = st.assets[k].high52; });
    const R = E.ruleSheet(s, cash, boxx, highs);
    const stats = E.ledgerStats(s, st, ledger);
    const pc = (n) => (n * 100).toFixed(1) + '%';
    const lock = s.lockedLiquid > 0;

    const derive = '<div class="inv-card"><h2>① 資金池怎麼來</h2><div class="inv-scroll"><table>' +
      '<tr><th>項目</th><th>算法</th><th>金額</th></tr>' +
      '<tr><td>總流動資金</td><td>' + (lock ? '固定基準（設定頁鎖定）' : '現金寶 ' + usd0(cash) + ' + BOXX ' + usd0(boxx)) + '</td><td><b>' + usd0(R.liquid) + '</b></td></tr>' +
      '<tr><td>資金池</td><td>總流動資金 x ' + pc(R.utilization) + '</td><td><b>' + usd0(R.pool) + '</b></td></tr>' +
      '<tr><td>保留不動</td><td>總流動資金 - 資金池（' + pc(1 - R.utilization) + '）</td><td>' + usd0(R.reserve) + '</td></tr>' +
      '<tr><td>單一資產上限</td><td>資金池 x ' + pc(R.assetCapPct) + '</td><td><b>' + usd0(R.cap) + '</b></td></tr>' +
      '</table></div><div class="inv-note">加倉只針對 ' + ADD.join('、') + ' 共 ' + R.nAssets + ' 個資產，每個資產各有自己的上限，彼此不共用。</div></div>';

    const rows = R.levels.map((l) => '<tr><td><b>' + l.id + '</b></td>' +
      '<td>回撤 ' + pc(l.upper) + (l.deeper != null ? ' ～ ' + pc(l.deeper) + '（不含）' : ' 以下') + '</td>' +
      '<td>' + pc(l.sharePct) + '</td><td>' + usd0(l.total) + '</td><td>' + l.maxCount + ' 次</td>' +
      '<td><b>' + usd0(l.weekly) + '</b></td><td><b>' + usd0(l.full) + '</b>' + (l.roundDiff ? '<div class="inv-note">與總額差 ' + (l.roundDiff > 0 ? '+' : '') + usd0(l.roundDiff) + '（四捨五入）</div>' : '') + '</td>' +
      '<td>' + pc(l.pctOfCap) + '</td><td>' + pc(l.pctOfPool) + '</td><td>' + pc(l.pctOfLiquid) + '</td></tr>').join('');
    const sumRow = '<tr><td><b>合計</b></td><td>走完全部 Level</td><td>' + pc(R.shareSum) + '</td><td></td><td>' + R.levels.reduce((a, l) => a + l.maxCount, 0) + ' 次</td><td></td>' +
      '<td><b>' + usd0(R.ladder) + '</b></td><td><b>' + pc(R.ladderPctOfCap) + '</b></td><td>' + pc(R.ladder / (R.pool || 1)) + '</td><td>' + pc(R.ladder / (R.liquid || 1)) + '</td></tr>';
    const ladder = '<div class="inv-card"><h2>② 每個 Level：金額、次數、佔用資金（每個資產）</h2><div class="inv-scroll"><table>' +
      '<tr><th>Level</th><th>觸發回撤區間</th><th>佔上限比例</th><th>該層總額</th><th>次數上限</th><th>每次金額</th><th>實際佔用（每次 x 次數）</th><th>佔單一資產上限</th><th>佔資金池</th><th>佔總流動資金</th></tr>' +
      rows + sumRow + '</table></div>' +
      '<div class="inv-note">該層總額 = 單一資產上限 x 佔上限比例（先四捨五入）；每次金額 = 該層總額 / 次數上限（再四捨五入）。每次金額是固定的，同一層的每一次買入都相同，與月供比例無關。' +
      (Math.abs(R.shareSum - 1) > 1e-9 ? '<br><b class="neg">注意：各層比例加起來是 ' + pc(R.shareSum) + '，不是 100%。</b>' : '') + '</div></div>';

    const worst = '<div class="inv-card"><h2>③ 最壞情況佔用</h2><div class="inv-grid">' +
      '<div class="inv-stat"><span>單一資產走完整個階梯</span><b>' + usd0(R.ladder) + '</b></div>' +
      '<div class="inv-stat"><span>' + R.nAssets + ' 個資產同時走完</span><b>' + usd0(R.allAssetsFull) + '</b></div>' +
      '<div class="inv-stat"><span>佔資金池</span><b>' + pc(R.allAssetsPctOfPool) + '</b></div>' +
      '<div class="inv-stat"><span>佔總流動資金</span><b>' + pc(R.allAssetsPctOfLiquid) + '</b></div></div>' +
      '<div class="inv-note">每個資產各有自己的上限，所以 ' + R.nAssets + ' 個資產理論上可以同時用滿；如果「同時走完」超過資金池，代表資金會先被先觸發的資產用掉，後面的資產可能買不到（指引頁會按「回撤深的優先」分配）。</div></div>';

    const trig = '<div class="inv-card"><h2>④ 以目前 52 週高計算的觸發價</h2><div class="inv-scroll"><table><tr><th>資產</th><th>52 週高</th>' +
      R.levels.map((l) => '<th>' + l.id + ' 觸發價（' + pc(l.upper) + '）</th>').join('') + '</tr>' +
      ADD.map((k) => '<tr><td><b>' + k + '</b></td><td>' + usd(highs[k]) + '</td>' + R.triggers[k].map((x) => '<td>≤ ' + usd(x.price) + '</td>').join('') + '</tr>').join('') +
      '</table></div><div class="inv-note">價格剛好等於邊界時，歸入較深的 Level。收盤價創新高後，次數和累計本金歸零，進入下一輪。</div></div>';

    const used = '<div class="inv-card"><h2>⑤ 目前實際使用量（來自帳本）</h2><div class="inv-scroll"><table><tr><th>資產</th>' +
      R.levels.map((l) => '<th>' + l.id + ' 已用 / 上限</th>').join('') + '<th>累計本金（淨額）</th><th>上限剩餘</th><th>已用上限</th></tr>' +
      ADD.map((k) => { const x = stats[k]; const left = R.cap - x.cumulative; return '<tr><td><b>' + k + '</b><div class="inv-note">第 ' + x.roundId + ' 輪</div></td>' +
        R.levels.map((l) => { const c = x.levels[l.id]; return '<td' + (c.count >= c.max ? ' class="neg"' : '') + '>' + c.count + ' / ' + c.max + '<div class="inv-note">' + usd0(c.amount) + ' / ' + usd0(l.full) + '</div></td>'; }).join('') +
        '<td>' + usd0(x.cumulative) + '</td><td class="' + (left < 0 ? 'neg' : '') + '">' + usd0(left) + '</td><td>' + pc(R.cap > 0 ? x.cumulative / R.cap : 0) + '</td></tr>'; }).join('') +
      '</table></div><div class="inv-note">次數用完的 Level 以紅字標示。累計本金是淨額（加倉總額減已回收），上限比的是這個淨額。</div></div>';

    const rec = '<div class="inv-card"><h2>⑥ 本金回收規則</h2><div class="inv-note flush">收盤價回到 52 週高的 ' + pc(R.recovery.triggerPct) + ' 以上，且累計本金大於 0，啟動回收；分 ' + R.recovery.weeks + ' 週，每週賣出基數的 ' + pc(R.recovery.tranchePct) + '，從下個週三開始；賣出的錢立即釋放等額累計本金。賣出第一筆之前基數隨累計本金更新，之後鎖定。</div></div>';

    return derive + ladder + worst + trig + used + rec;
  }

  // ───────── 富途同步頁 ─────────
  function holdingsAt(sym, date) {
    const hs = E.holdingsSummary(doc.holdingsBase || {}, buyFlow().filter((e) => e.date < date), priceMap(), { syms: [sym] });
    return hs.rows[0] ? hs.rows[0].shares : 0;
  }
  function vFutu() {
    const age = E.syncAge(futuSync, Date.now(), 26);
    const handled = doc.futu.handled || {};
    const pend = E.pendingDeals(futuSync, handled);
    const stat = (l, v, c) => '<div class="inv-stat"><span>' + l + '</span><b class="' + (c || '') + '">' + v + '</b></div>';
    const status = age.state === 'never' ? banner('還沒有同步資料。請先在你的電腦跑同步程式（見 futu-sync 資料夾的 README），第一次同步後這裡就會出現成交與派息。' + (syncErr ? '<br>' + esc(syncErr) : ''), syncErr ? 'err' : '')
      : age.state === 'stale' ? banner('同步資料已經 ' + age.hours.toFixed(0) + ' 小時沒有更新，請檢查電腦與 OpenD 是否在運行。以下資料可能不是最新。', 'err')
      : '<div class="inv-note">最後同步：' + esc(new Date(futuSync.syncedAt).toLocaleString('zh-TW')) + '（' + age.hours.toFixed(1) + ' 小時前）· 富途賬戶末四碼 ' + esc(futuSync.accountTail || '—') + '</div>';

    // ① 待確認成交
    const rows = pend.map((d) => {
      const sg = E.suggestDeal(d, doc.settings, doc.state, ledger);
      const isAdd = ADD.includes(d.sym);
      const lvSel = '<select id="fd-lv-' + esc(d.id) + '">' + LV.map((l) => '<option value="' + l + '">' + l + '</option>').join('') + '</select>';
      return '<tr><td>' + esc(d.date) + '<div class="inv-note">' + esc(d.time.slice(11)) + '</div></td><td><b>' + esc(d.sym) + '</b></td><td>' + (d.side === 'buy' ? '買入' : '賣出') + '</td>' +
        '<td>' + d.shares + '</td><td>' + usd(d.price) + '</td><td>' + usd(d.amount) + '</td>' +
        '<td><select id="fd-act-' + esc(d.id) + '">' +
        (isAdd ? '<option value="add"' + (sg.action === 'ledger' && sg.kind === 'add' ? ' selected' : '') + '>記為加倉</option><option value="recovery"' + (sg.kind === 'recovery' ? ' selected' : '') + '>記為本金回收賣出</option>' : '') +
        '<option value="monthly"' + (sg.action === 'monthly' ? ' selected' : '') + '>記為月供</option>' +
        '<option value="ignore"' + (sg.action === 'ignore' ? ' selected' : '') + '>忽略（不入帳）</option></select>' +
        (isAdd ? '<div class="inv-note">加倉的 Level：' + lvSel + '</div>' : '') +
        '<div class="inv-note">建議理由：' + esc(sg.why || '') + '</div></td>' +
        '<td><button class="inv-btn" data-act="dealConfirm" data-id="' + esc(d.id) + '">確認</button> <button class="inv-btn ghost" data-act="dealIgnore" data-id="' + esc(d.id) + '">忽略</button></td></tr>';
    }).join('');
    const pending = '<div class="inv-card"><h2>① 待確認的富途成交（' + pend.length + ' 筆）</h2>' +
      (pend.length ? '<div class="inv-scroll"><table><tr><th>日期</th><th>代號</th><th>方向</th><th>股數</th><th>成交價</th><th>金額</th><th>怎麼記</th><th></th></tr>' + rows + '</table></div>'
        : '<div class="inv-note">沒有待確認的成交。</div>') +
      '<div class="inv-note">同步程式只讀取富途資料，不會替你記帳；每一筆都要在這裡確認才會寫入帳本（成交價與股數會一併帶入，持倉盈虧因此更準）。已確認或忽略的不會再出現，重複同步也不會重複入帳。</div></div>';

    // ② 派息
    const feed = (futuSync && futuSync.dividends) || [];
    const newFeed = feed.filter((f) => !f.ambiguous && !(doc.dividends || []).some((d) => d.futuId === f.id));
    const amb = feed.filter((f) => f.ambiguous);
    const divCard = '<div class="inv-card"><h2>② 派息入帳</h2><div class="inv-grid">' +
      stat('富途派息記錄', feed.length + ' 筆') + stat('尚未配對', newFeed.length + ' 筆') + stat('無法判斷代號', amb.length + ' 筆', amb.length ? 'neg' : '') + '</div>' +
      (newFeed.length ? '<div class="inv-scroll mt12"><table><tr><th>派發日</th><th>代號</th><th>稅前</th><th>預扣稅</th><th>實收淨額</th></tr>' + newFeed.map((f) => '<tr><td>' + esc(f.paidDate) + '</td><td><b>' + esc(f.sym) + '</b></td><td>' + usd(f.gross) + '</td><td>' + usd(f.tax) + '</td><td><b>' + usd(f.net) + '</b></td></tr>').join('') + '</table></div>' +
        '<button class="inv-btn alt mt12" data-act="divMerge">配對到派息記錄</button>' : '') +
      (amb.length ? banner('有 ' + amb.length + ' 筆派息抓不到代號（富途備註格式不同），請到富途 App 核對後在「持倉盈虧」手動新增：' + amb.map((f) => esc(f.paidDate) + ' ' + usd(f.net) + '（' + esc((f.remarks || [''])[0]) + '）').join('；'), 'err') : '') +
      '<div class="inv-note">配對規則：同代號、除息日不晚於派發日、尚未被富途配對的最近一筆手填記錄，會補上派發日與實收淨額，並標為「已入帳」；找不到手填記錄時會新增一筆（來源：富途）。每筆富途記錄只會配對一次。</div></div>';

    // ③ 持倉對照
    const hs = E.holdingsSummary(doc.holdingsBase || {}, buyFlow(), priceMap(), { syms: posSyms() });
    const cmp = E.comparePositions((futuSync && futuSync.positions) || [], hs.rows);
    const cmpCard = '<div class="inv-card"><h2>③ 持倉對照（網頁推算 vs 富途實際）</h2>' +
      (cmp.length ? '<div class="inv-scroll"><table><tr><th>代號</th><th>網頁推算股數</th><th>富途實際股數</th><th>差異</th><th>富途成本價</th><th>網頁均價</th><th></th></tr>' +
        cmp.map((c) => '<tr><td><b>' + esc(c.sym) + '</b></td><td>' + c.web.toFixed(4) + '</td><td>' + c.futu.toFixed(4) + '</td><td class="' + (c.ok ? 'muted' : 'neg') + '">' + (c.diff >= 0 ? '+' : '') + c.diff.toFixed(4) + '</td><td>' + (c.futuCost ? usd(c.futuCost) : '—') + '</td><td>' + (c.webCost ? usd(c.webCost) : '—') + '</td><td>' + (c.ok ? '<span class="tag funded">一致</span>' : '<span class="tag unfunded">不一致</span>') + '</td></tr>').join('') + '</table></div>'
        : '<div class="inv-note">沒有可對照的持倉。</div>') +
      '<div class="inv-note">只做對照，不會自動修改。不一致通常是：有成交還沒確認、底倉日期或股數不對、或持倉裡有未追蹤的買賣。</div></div>';

    return '<div class="inv-card"><h2>富途同步（唯讀）</h2>' + status + '<button class="inv-btn ghost" data-act="syncReload">重新讀取</button>' +
      '<div class="inv-note">這個頁面只讀取你電腦上的同步程式寫入雲端的資料，網頁本身不連接富途、也不能下單。</div></div>' + pending + divCard + cmpCard;
  }

  async function doDealConfirm(id) {
    const d = ((futuSync && futuSync.deals) || []).find((x) => x.id === id); if (!d) throw new Error('找不到這筆成交，請重新讀取');
    if ((doc.futu.handled || {})[id]) throw new Error('這筆成交已處理過');
    const action = sv('fd-act-' + id);
    if (action === 'ignore') return doDealIgnore(id);
    if (action === 'add' || action === 'recovery') {
      if (!ADD.includes(d.sym)) throw new Error(d.sym + ' 不在加倉資產內');
      const a = doc.state.assets[d.sym];
      let e;
      if (action === 'add') {
        if (d.side !== 'buy') throw new Error('賣出不能記為加倉');
        const level = sv('fd-lv-' + id); if (!LV.includes(level)) throw new Error('請選擇 Level');
        const info = E.poolInfo(doc.settings, doc.inputs.cash != null ? doc.inputs.cash : doc.state.cash, doc.inputs.boxx != null ? doc.inputs.boxx : doc.state.boxx);
        const lv = info.levels.find((l) => l.id === level);
        e = E.dealToLedger(d, 'add', { level, base: lv ? lv.weekly : undefined, round: a.roundId });
        if (!(e.base > 0)) delete e.base;
      } else {
        if (d.side !== 'sell') throw new Error('買入不能記為本金回收');
        if (!a.recovery || !a.recovery.active) throw new Error(d.sym + ' 目前沒有進行中的本金回收排程，無法記為回收賣出');
        e = E.dealToLedger(d, 'recovery', { round: a.roundId, recoveryId: a.recovery.id });
      }
      if (ledger.some((x) => x.id === e.id)) throw new Error('帳本已有這筆成交');
      await addLedger(e, d.sym + ' 成交已記入帳本');
    } else if (action === 'monthly') {
      if (d.side !== 'buy') throw new Error('賣出不能記為月供');
      const key = d.date.slice(0, 7);
      const cur = doc.monthlyDone[key] && typeof doc.monthlyDone[key] === 'object' ? doc.monthlyDone[key] : { date: d.date, total: 0, items: {} };
      const it = cur.items[d.sym] || { amount: 0 };
      // 同月同代號多筆成交：金額累加，成交價取加權平均（總金額 / 總股數）
      const prevSh = it.price > 0 ? it.amount / it.price : 0, totSh = prevSh + d.shares;
      it.amount = r2(it.amount + d.amount); it.price = totSh > 0 ? r2(it.amount / totSh) : d.price;
      cur.items[d.sym] = it; cur.total = r2(Object.keys(cur.items).reduce((s, k) => s + cur.items[k].amount, 0)); cur.date = cur.date || d.date;
      doc.monthlyDone[key] = cur;
      doc.prices[d.sym] = { price: d.price, date: d.date };
    } else throw new Error('請選擇處理方式');
    doc.futu.handled[id] = { action, at: Date.now() };
    await persist();
    if (!msg) msg = { text: d.sym + ' 成交已處理', cls: 'ok' };
  }
  async function doDealIgnore(id) {
    doc.futu.handled[id] = { action: 'ignore', at: Date.now() }; await persist(); msg = { text: '已忽略（不入帳）', cls: 'ok' };
  }
  async function doDivMerge() {
    const r = E.mergeFutuDividends(doc.dividends, (futuSync && futuSync.dividends) || [], holdingsAt);
    doc.dividends = r.dividends; await persist();
    msg = { text: '派息配對完成：配對 ' + r.matched + ' 筆、新增 ' + r.created + ' 筆、略過 ' + r.skipped + ' 筆' + (r.ambiguous.length ? '、' + r.ambiguous.length + ' 筆需人工處理' : ''), cls: r.ambiguous.length ? '' : 'ok' };
  }

  function vSettings() {
    const s = doc.settings, st = doc.state;
    const fld = (id, label, v, step) => '<div><label>' + label + '</label><input type="number" step="' + (step || 'any') + '" id="' + id + '" value="' + v + '"></div>';
    const assetRows = ADD.map((sym) => {
      const a = st.assets[sym]; const r = a.recovery && a.recovery.active ? a.recovery : null;
      return '<tr><td><b>' + sym + '</b></td><td><input type="number" step="0.001" id="se-high-' + sym + '" value="' + a.high52 + '"></td><td><input type="number" step="1" id="se-round-' + sym + '" value="' + a.roundId + '"></td>' +
        '<td><input type="checkbox" id="se-ract-' + sym + '"' + (r ? ' checked' : '') + '></td><td><input type="number" step="0.01" id="se-rbase-' + sym + '" value="' + (r ? r.base : 0) + '"></td></tr>';
    }).join('');
    return '<div class="inv-card"><h2>帳戶</h2><div class="inv-grid">' + fld('se-cash', '現金寶', st.cash, '0.01') + fld('se-boxx', 'BOXX 市值', st.boxx, '0.01') +
      '<div><label>資料日期</label><input type="date" id="se-asof" value="' + esc(st.asOf) + '"></div></div>' +
      '<div class="inv-scroll mt12"><table><tr><th>資產</th><th>52 週高</th><th>輪次（每創新高 +1）</th><th>本金回收中</th><th>回收基數（累計本金）</th></tr>' + assetRows + '</table></div>' +
      '<div class="inv-note">Level 次數、累計本金（本輪加倉總額減已回收）、已回收週數都由帳本計算，無需也無法在此手改；要更正就到「帳本與統計」刪除或補記。</div></div>' +
      '<div class="inv-card"><h2>規則參數</h2><div class="inv-grid">' +
      fld('se-util', '資金池利用率 (0~1)', s.utilization) + fld('se-cap', '單一資產上限比例 (0~1)', s.assetCapPct) +
      fld('se-locked', '固定流動資金基準（0 = 自動）', s.lockedLiquid || 0, '0.01') +
      fld('se-rtrig', '回收觸發價比例', s.recovery.triggerPct) + fld('se-rweeks', '回收週數', s.recovery.weeks, '1') + fld('se-rtr', '每週賣出比例', s.recovery.tranchePct) + '</div>' +
      '<div class="inv-grid mt10">' + ALL.map((a) => fld('se-w-' + a, a + ' 目標比例', s.weights[a])).join('') + '</div>' +
      '<div class="inv-grid mt10">' + fld('se-mu', '月供：本人 (USD)', s.monthly.user, '0.01') + fld('se-ms', '月供：配偶 (USD)', s.monthly.spouse, '0.01') + fld('se-md', '月供日', s.monthly.day, '1') +
      fld('se-spu', 'SPCX 本人每月 (USD)', s.spcxUsd.user, '0.01') + fld('se-sps', 'SPCX 配偶每月 (USD)', s.spcxUsd.spouse, '0.01') + fld('se-wh', '股息預扣稅率 (0~1，香港居民美股為 0.30)', s.withholding) + '</div>' +
      '<div class="inv-grid wide mt10"><div><label>Twelve Data API 金鑰（選用，只存在你的私有雲端文件）</label><input type="password" id="se-key" value="' + esc(s.apiKey) + '" autocomplete="off"></div></div>' +
      '<div class="sp8"></div><button class="inv-btn" data-act="saveSettings">儲存設定</button></div>' +
      '<div class="inv-card"><h2>備份</h2><button class="inv-btn alt" data-act="export">匯出 JSON</button><label class="inv-btn ghost inv-file">匯入 JSON<input type="file" id="se-import" accept=".json"></label>' +
      '<div class="inv-note">匯出檔含帳本，不含 API 金鑰。匯入會覆蓋設定與狀態，帳本以相同 id 合併。</div></div>';
  }

  // ───────── 動作 ─────────
  async function logIn() {
    if (Date.now() < lockUntil) { loginErr = '嘗試次數過多，請稍後再試'; render(); return; }
    const email = sv('lg-email'), pass = $('lg-pass').value;
    if (!email || !pass) { loginErr = '請輸入電子郵件和密碼'; render(); return; }
    try { await fb.m.auth.signInWithEmailAndPassword(fb.auth, email, pass); loginErr = ''; fails = 0; }
    catch (e) {
      fails += 1; if (fails >= 5) { lockUntil = Date.now() + 60000; fails = 0; }
      const map = { 'auth/invalid-credential': '帳號或密碼錯誤', 'auth/wrong-password': '帳號或密碼錯誤', 'auth/user-not-found': '帳號或密碼錯誤', 'auth/invalid-email': '電子郵件格式不正確', 'auth/too-many-requests': '嘗試次數過多，請稍後再試', 'auth/network-request-failed': '網路連線失敗', 'auth/user-disabled': '此帳號已停用' };
      loginErr = map[e.code] || '登入失敗'; render();
    }
  }
  async function logOut() { clearTimeout(idleT); if (mode === 'cloud' && fb) await fb.m.auth.signOut(fb.auth); doc = null; ledger = []; gd = null; fetched = null; rbRes = null; render(); }

  function readInputs() {
    const closes = {}, highs = {};
    for (const sym of ADD) {
      const c = nv('g-close-' + sym), h = nv('g-high-' + sym);
      if (!(c > 0) || !(h > 0)) throw new Error(sym + ' 的最新價或 52 週高無效');
      closes[sym] = c; highs[sym] = h;
    }
    const cash = nv('g-cash'), boxx = nv('g-boxx'), av = nv('g-avail'), date = sv('g-date') || today();
    if (!(cash >= 0) || !(boxx >= 0)) throw new Error('現金寶與 BOXX 必須為有效數字');
    if (!isDate(date)) throw new Error('日期格式不正確');
    doc.inputs = { date, closes, highs, cash, boxx, avail: isFinite(av) ? av : null };
  }
  function computeGd() {
    const i = doc.inputs; if (!i.date || !ADD.every((s) => i.closes[s] > 0)) { gd = null; return; }
    const st = clone(doc.state); ADD.forEach((s) => { st.assets[s].high52 = i.highs[s] > 0 ? i.highs[s] : st.assets[s].high52; });
    gd = E.guidance(doc.settings, st, ledger, i.closes, { date: i.date, cash: i.cash != null ? i.cash : st.cash, boxx: i.boxx != null ? i.boxx : st.boxx, availableCash: i.avail });
  }
  async function commitGd() {
    if (!gd) return;
    doc.state = gd.state; doc.state.asOf = doc.inputs.date;
    ADD.forEach((s) => { doc.inputs.highs[s] = doc.state.assets[s].high52; });
    await persist();
  }

  async function doFetch(target) {
    const key = doc.settings.apiKey; if (!key) throw new Error('請先到「設定」填入 Twelve Data API 金鑰，或改用手動輸入');
    const syms = target === 'monthly' ? MP_SYMS : target === 'positions' ? posSyms() : ADD;
    fetched = Object.assign(fetched || {}, await fetchWeekly(key, syms));
    const bad = syms.filter((k) => fetched[k] && fetched[k].error);
    syms.forEach((s) => { if (fetched[s] && fetched[s].close) doc.prices[s] = { price: fetched[s].close, date: fetched[s].date }; });
    if (target === 'guide') {
      ADD.forEach((s) => {
        const f = fetched[s]; if (!f || !f.close) return;
        doc.inputs.closes[s] = f.close;
        doc.inputs.highs[s] = Math.max(doc.state.assets[s].high52, f.prevHigh || 0);
      });
      doc.inputs.date = doc.inputs.date || today();
      if (doc.inputs.cash == null) doc.inputs.cash = doc.state.cash;
      if (doc.inputs.boxx == null) doc.inputs.boxx = doc.state.boxx;
      computeGd();
    }
    await persist();
    msg = bad.length ? { text: '部分資產抓價失敗：' + bad.map((k) => k + '（' + fetched[k].error + '）').join('、'), cls: 'err' } : { text: '已抓取最新週線收盤價', cls: 'ok' };
  }

  async function addLedger(e, okText) {
    await store.addEntry(e); ledger.push(e);
    ledger.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : (x.ts || 0) - (y.ts || 0)));
    const evs = rederive(); await persist(); computeGd();
    msg = { text: okText + (evs.some((x) => x.type === 'recovery-done') ? '；本金回收排程已完成（10 週賣滿）' : ''), cls: 'ok' };
  }

  async function doRecAdd(sym) {
    const it = gd && gd.plan.items.find((i) => i.sym === sym); if (!it || !it.level) throw new Error('目前沒有可記錄的加倉');
    const amt = nv('rg-amt-' + sym), px = nv('rg-px-' + sym), date = sv('rg-date-' + sym);
    if (!(amt > 0)) throw new Error('金額必須大於 0'); if (!isDate(date)) throw new Error('日期格式不正確');
    await commitGd();
    // 買了就記一次；base = 該 Level 每週基本金額。實際買入少於「基本 + 欠買」的差額，會累積為欠買。
    const e = { id: newId(), ts: Date.now(), date, sym, kind: 'add', level: it.level, base: it.base, amount: r2(amt), round: doc.state.assets[sym].roundId };
    if (px > 0) e.price = px;
    const owed = Math.max(0, (it.backlog || 0) + it.base - amt);
    await addLedger(e, sym + ' ' + it.level + ' 加倉 ' + usd(amt) + ' 已記錄為一次' + (owed > 0.005 ? '；目前欠買 ' + usd(owed) + '，下次加倉補上' : ''));
  }
  async function doRecSell(sym) {
    const it = gd && gd.plan.items.find((i) => i.sym === sym); if (!it || !it.recovery || it.recovery.status !== 'sell') throw new Error('目前沒有可記錄的回收賣出');
    const amt = nv('rs-amt-' + sym), px = nv('rs-px-' + sym), date = sv('rs-date-' + sym);
    if (!(amt > 0)) throw new Error('金額必須大於 0'); if (!isDate(date)) throw new Error('日期格式不正確');
    await commitGd();
    const a = doc.state.assets[sym]; if (!a.recovery) throw new Error('回收排程不存在，請重新計算');
    const e = { id: newId(), ts: Date.now(), date, sym, kind: 'recovery', amount: r2(amt), round: a.roundId, recoveryId: a.recovery.id };
    if (px > 0) e.price = px;
    await addLedger(e, sym + ' 本金回收賣出 ' + usd(amt) + ' 已記錄');
  }
  async function doAddEntry() {
    const date = sv('m-date'), sym = sv('m-sym'), kind = sv('m-kind'), level = sv('m-level'), amt = nv('m-amt'), px = nv('m-px');
    if (!isDate(date)) throw new Error('日期格式不正確'); if (!ADD.includes(sym)) throw new Error('資產無效'); if (!(amt > 0)) throw new Error('金額必須大於 0');
    const a = doc.state.assets[sym];
    const e = { id: newId(), ts: Date.now(), date, sym, kind, amount: r2(amt), round: a.roundId };
    if (kind === 'add') {
      if (!LV.includes(level)) throw new Error('請選擇 Level'); e.level = level;
      const base = nv('m-base'); if (base > 0) e.base = base; // 填了「該次基本金額」才會產生欠買；不填視為足額
    } else if (a.recovery) e.recoveryId = a.recovery.id;
    if (px > 0) e.price = px; const note = sv('m-note'); if (note) e.note = note.slice(0, 100);
    await addLedger(e, '已新增記錄');
  }
  async function doDelEntry(id) {
    if (!confirm('刪除這筆記錄？次數與金額會自動重算。')) return;
    await store.removeEntry(id); ledger = ledger.filter((e) => e.id !== id);
    rederive(); await persist(); computeGd(); msg = { text: '已刪除並重新統計', cls: 'ok' };
  }

  async function doLogMonthly() {
    const date = sv('mp-date') || today(); if (!isDate(date)) throw new Error('日期格式不正確'); const key = date.slice(0, 7);
    if (doc.monthlyDone[key] && !confirm(key + ' 已記錄過月供，要覆蓋嗎？')) return;
    // 只記錄本人：月供五檔 + SPCX 的實際買入金額與（選填的）成交價；配偶不記錄。
    const items = {}; let total = 0;
    MP_SYMS.forEach((sym) => {
      const amt = nv('mp-act-' + sym); const p = nv('mp-price-' + sym);
      if (!(amt >= 0)) throw new Error(sym + ' 的實際買入金額無效');
      if (p > 0) doc.prices[sym] = { price: p, date };
      items[sym] = { amount: r2(amt) }; if (p > 0) items[sym].price = p;
      total += amt;
    });
    doc.monthlyDone[key] = { date, total: r2(total), items };
    await persist(); msg = { text: key + ' 本人月供已記錄（含 SPCX，合計 ' + usd(total) + '）', cls: 'ok' };
  }
  function doRebalance() {
    const vals = {}; ALL.forEach((s) => { const v = nv('rb-v-' + s); vals[s] = isFinite(v) ? v : 0; });
    const dep = nv('rb-dep'); if (!(dep >= 0)) throw new Error('請輸入有效的入金金額');
    doc.values = vals; rbRes = E.rebalance(doc.settings, vals, dep);
  }

  async function doSaveSettings() {
    const s = clone(doc.settings), st = clone(doc.state);
    const need = (id, label) => { const v = nv(id); if (!isFinite(v)) throw new Error(label + ' 必須是有效數字'); return v; };
    s.utilization = need('se-util', '利用率'); s.assetCapPct = need('se-cap', '單一資產上限');
    s.lockedLiquid = need('se-locked', '固定流動資金') || null;
    s.recovery.triggerPct = need('se-rtrig', '回收觸發價比例'); s.recovery.weeks = need('se-rweeks', '回收週數'); s.recovery.tranchePct = need('se-rtr', '每週賣出比例');
    if (s.utilization <= 0 || s.utilization > 1 || s.assetCapPct <= 0 || s.assetCapPct > 1) throw new Error('利用率與上限比例必須介於 0 與 1 之間');
    let sum = 0; ALL.forEach((a) => { s.weights[a] = need('se-w-' + a, a + ' 目標比例'); sum += s.weights[a]; });
    if (Math.abs(sum - 1) > 0.001) throw new Error('目標比例合計必須為 100%（目前 ' + (sum * 100).toFixed(1) + '%）');
    s.monthly.user = need('se-mu', '本人月供'); s.monthly.spouse = need('se-ms', '配偶月供'); s.monthly.day = need('se-md', '月供日');
    s.spcxUsd.user = need('se-spu', 'SPCX 本人'); s.spcxUsd.spouse = need('se-sps', 'SPCX 配偶');
    s.withholding = need('se-wh', '預扣稅率'); if (s.withholding < 0 || s.withholding >= 1) throw new Error('預扣稅率必須介於 0 與 1 之間（不含 1）'); s.apiKey = sv('se-key');
    st.cash = need('se-cash', '現金寶'); st.boxx = need('se-boxx', 'BOXX'); st.asOf = sv('se-asof') || st.asOf;
    ADD.forEach((sym) => {
      const a = st.assets[sym]; a.high52 = need('se-high-' + sym, sym + ' 52 週高'); a.roundId = Math.max(1, Math.round(need('se-round-' + sym, sym + ' 輪次')));
      if ($('se-ract-' + sym).checked) {
        const base = need('se-rbase-' + sym, sym + ' 回收基數');
        if (!a.recovery) a.recovery = { active: true, weeksDone: 0, base, roundId: a.roundId, startedAt: st.asOf, id: sym + ':' + a.roundId + ':manual' };
        else a.recovery.base = base;
      } else a.recovery = null;
    });
    doc.settings = s; doc.state = st; rederive(); await persist(); computeGd(); msg = { text: '已儲存', cls: 'ok' };
  }

  function doExport() {
    const d = clone(doc); d.settings.apiKey = ''; d.ledger = ledger;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
    a.download = 'invest-backup-' + today() + '.json'; a.click(); URL.revokeObjectURL(a.href);
  }

  async function act(name, ds) {
    try {
      switch (name) {
        case 'login': await logIn(); return;
        case 'logout': await logOut(); return;
        case 'view': view = ds.v; break;
        case 'compute': readInputs(); computeGd(); await persist(); break;
        case 'fetch': await doFetch(ds.target); break;
        case 'commit': await commitGd(); msg = { text: '本週數據已儲存', cls: 'ok' }; break;
        case 'recAdd': await doRecAdd(ds.sym); break;
        case 'recSell': await doRecSell(ds.sym); break;
        case 'addEntry': await doAddEntry(); break;
        case 'delEntry': await doDelEntry(ds.id); break;
        case 'logMonthly': await doLogMonthly(); break;
        case 'savePositions': await doSavePositions(); break;
        case 'addDiv': await doAddDiv(); break;
        case 'delDiv': await doDelDiv(ds.id); break;
        case 'saveDivFrom': await doSaveDivFrom(); break;
        case 'rebalance': doRebalance(); break;
        case 'syncReload': futuSync = await store.loadSync(); syncErr = ''; msg = { text: '已重新讀取同步資料', cls: 'ok' }; break;
        case 'dealConfirm': await doDealConfirm(ds.id); break;
        case 'dealIgnore': await doDealIgnore(ds.id); break;
        case 'divMerge': await doDivMerge(); break;
        case 'saveSettings': await doSaveSettings(); break;
        case 'export': doExport(); return;
      }
    } catch (e) { msg = { text: e.message || String(e), cls: 'err' }; }
    render();
    if (view === 'monthly') recalcMonthly();
  }

  // ───────── 啟動 ─────────
  function bumpIdle() { clearTimeout(idleT); if (user) idleT = setTimeout(logOut, IDLE_MS); }

  async function loadAll() {
    try {
      let d = await store.loadDoc();
      doc = normalize(d);
      if (!d) { await persist(); msg = { text: '首次使用：已建立初始資料（52 週高點為公開數據，帳戶餘額為 0）。請先到「設定」填入現金寶與 BOXX，再到「帳本與統計」補記以前的加倉。' }; }
      ledger = await store.loadLedger();
      try { futuSync = await store.loadSync(); syncErr = ''; } catch (e) { futuSync = null; syncErr = e.code === 'permission-denied' ? '沒有權限讀取同步區（請確認 firestore.rules 已發布）' : e.message; }
      rederive(); computeGd();
    } catch (e) {
      doc = null; msg = { text: '讀取資料失敗：' + (e.code === 'permission-denied' ? '沒有權限（請確認 firestore.rules 已發布且包含你的 uid）' : e.message), cls: 'err' };
    }
  }

  async function init() {
    if (started) return; started = true;
    const el = $('invest-root');
    el.addEventListener('click', (e) => { const t = e.target.closest('[data-act]'); if (t && !t.disabled) act(t.dataset.act, t.dataset); });
    el.addEventListener('input', (e) => { if (e.target.dataset && e.target.dataset.monthly) recalcMonthly(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.target.id === 'lg-pass' || e.target.id === 'lg-email')) act('login', {}); });
    el.addEventListener('change', (e) => {
      if (e.target.id !== 'se-import' || !e.target.files[0]) return;
      const rd = new FileReader();
      rd.onload = async () => {
        try {
          if (!confirm('匯入會覆蓋設定與狀態，確定？')) return;
          const j = JSON.parse(rd.result); const imp = j.ledger || []; delete j.ledger;
          const d = normalize(j); d.settings.apiKey = doc.settings.apiKey; doc = d;
          for (const x of imp) { if (x && x.id && ADD.includes(x.sym) && x.amount > 0 && isDate(x.date)) { await store.addEntry(x); if (!ledger.some((l) => l.id === x.id)) ledger.push(x); } }
          rederive(); await persist(); computeGd(); msg = { text: '匯入完成', cls: 'ok' };
        } catch (err) { msg = { text: '匯入失敗：' + err.message, cls: 'err' }; }
        render();
      };
      rd.readAsText(e.target.files[0]);
    });
    ['click', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, bumpIdle, { passive: true }));

    if (mode === 'local') { await loadAll(); loading = false; render(); return; }
    render();
    try {
      const [appM, authM, fsM] = await Promise.all([import('./vendor/firebase-app.js'), import('./vendor/firebase-auth.js'), import('./vendor/firebase-firestore.js')]);
      const app = appM.initializeApp(cfg);
      // 只存在當前分頁（關閉分頁即登出）；不帶 popup/redirect resolver，避免載入外部腳本
      const auth = authM.initializeAuth(app, { persistence: authM.browserSessionPersistence });
      fb = { auth, db: fsM.getFirestore(app), m: { auth: authM }, fs: fsM };
      authM.onAuthStateChanged(auth, async (u) => {
        user = u; loading = true; render();
        if (u) { await loadAll(); bumpIdle(); } else { doc = null; ledger = []; }
        loading = false; render();
      });
    } catch (e) { loading = false; el.innerHTML = '<div class="inv-card">' + banner('無法載入 Firebase：' + esc(e.message), 'err') + '</div>'; }
  }

  window.Invest = { start: init };
})();
