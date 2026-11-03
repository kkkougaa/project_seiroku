/* 부스 포스 — 오프라인 단독 동작 웹앱
 * 데이터는 이 기기의 localStorage에만 저장돼요. (부스별로 따로)
 */
(() => {
'use strict';

const CFG = self.BOOTH_CONFIG;
const DEVICE_KEY = 'boothpos:device';
const dataKey = b => 'boothpos:v1:' + b;
const REASONS_OUT = ['파손·불량', '전시용 샘플', '증정·서비스', '분실', '기타'];
const REASONS_IN = ['추가 입고', '재고 정정', '기타'];
const BACKUP_WARN_MIN = 60;
const APP_VERSION = '14';

/* ---------------- 저장소 ---------------- */
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const emptyData = () => ({ v: 1, preorders: [], sales: [], adj: [], seq: 0, savedAt: null, backupAt: null, importInfo: null, ov: { price: {}, stock: {} } });

let booth = ls.get(DEVICE_KEY);
if (booth && !CFG.booths[booth]) booth = null;
let D = booth ? load(booth) : null;

function load(b) {
  const raw = ls.get(dataKey(b));
  if (!raw) return emptyData();
  try { return Object.assign(emptyData(), JSON.parse(raw)); } catch { return emptyData(); }
}
function save() {
  D.savedAt = Date.now();
  if (!ls.set(dataKey(booth), JSON.stringify(D))) toast('저장하지 못했어요. 지금 바로 백업 파일을 내보내 주세요');
}
const nextId = () => ++D.seq;

/* ---------------- 상품·재고 ---------------- */
const $ = s => document.querySelector(s);
const B = () => CFG.booths[booth];
const ov = () => { D.ov = D.ov || { price: {}, stock: {} }; D.ov.r18 = D.ov.r18 || {}; return D.ov; };
const products = () => { const o = ov(); return B().products.map(p => ({ ...p, price: o.price[p.id] ?? p.price, stock: o.stock[p.id] ?? p.stock, r18: o.r18[p.id] ?? !!p.r18 })); };
const sellable = () => products().filter(p => !p.preorderOnly);
const prod = id => products().find(p => p.id === id);
const units = p => (p && p.pool ? p.units || 1 : 1);
const skey = p => (p.pool ? 'pool:' + p.pool : p.id);

function keyInfo(k) {
  if (k.startsWith('pool:')) {
    const id = k.slice(5), pl = (B().pools || {})[id] || { name: id, stock: 0 };
    return { name: pl.name, sub: products().filter(p => p.pool === id).map(p => p.badge || p.name).join(' · ') + ' 공용', stock: ov().stock[k] ?? (pl.stock || 0), unit: pl.unit || '개' };
  }
  const p = prod(k);
  return p ? { name: p.name, sub: p.sub || '', stock: p.stock || 0, unit: '개' } : { name: k, sub: '', stock: 0, unit: '개' };
}
function stockKeys() {
  const seen = new Set(), out = [];
  for (const p of sellable()) { const k = skey(p); if (!seen.has(k)) { seen.add(k); out.push(k); } }
  return out;
}
function usage(k) {
  let sold = 0, done = 0, wait = 0, out = 0;
  const w = id => { const p = prod(id); return p && !p.preorderOnly && skey(p) === k ? units(p) : 0; };
  for (const s of D.sales) if (!s.canceled) for (const [id, q] of Object.entries(s.items)) sold += q * w(id);
  for (const p of D.preorders) for (const [id, q] of Object.entries(p.items)) { const n = q * w(id); if (n) p.at ? done += n : wait += n; }
  for (const a of D.adj) if (!a.canceled && a.id === k) out += a.q;
  const left = keyInfo(k).stock - sold - done - out;
  return { sold, done, wait, out, left, avail: left - wait };
}
const cartUnits = k => Object.entries(cart).reduce((s, [id, q]) => { const p = prod(id); return s + (p && skey(p) === k ? q * units(p) : 0); }, 0);
const availFor = p => Math.floor((usage(skey(p)).avail - cartUnits(skey(p))) / units(p));
const waitOf = id => D.preorders.reduce((s, o) => s + (o.at ? 0 : o.items[id] || 0), 0);

/* ---------------- 유틸 ---------------- */
const won = n => (n || 0).toLocaleString('ko-KR') + '원';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sumItems = it => Object.entries(it).reduce((s, [k, q]) => s + (prod(k)?.price || 0) * q, 0);
const cnt = it => Object.values(it).reduce((a, b) => a + b, 0);
const hhmm = ts => { if (!ts) return ''; const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const mdhm = ts => { const d = new Date(ts); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hhmm(ts); };
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
const pname = id => prod(id)?.name || id;
const varPlain = v => Object.entries(v || {}).sort(([a], [b]) => (a === '?') - (b === '?') || a.localeCompare(b)).map(([L, q]) => (L === '?' ? '종류 미정' : L) + (q > 1 ? '×' + q : '')).join(', ');
// 같은 공용 재고(포토카드 1·5·10세트)는 한 줄로 합쳐요: 1세트 + 5세트 = 랜덤 포토카드 6세트
function groupItems(it) {
  const out = [], pools = {};
  for (const [id, q] of Object.entries(it)) {
    const p = prod(id);
    if (p && p.pool) {
      const k = 'pool:' + p.pool;
      if (!pools[k]) { const info = keyInfo(k); pools[k] = { key: k, pool: true, name: info.name, unit: info.unit, qty: 0, total: 0, parts: [] }; out.push(pools[k]); }
      pools[k].qty += q * units(p); pools[k].total += p.price * q; pools[k].parts.push([p, q]);
    } else out.push({ key: id, pool: false, name: pname(id), sub: p?.sub || '', unit: '개', qty: q, total: (p?.price || 0) * q, p });
  }
  return out;
}
const partsText = g => g.parts.map(([p, q]) => `${p.units}${g.unit} ${q}개`).join(' + ');
function itemsText(it, vars) {
  return groupItems(it).map(g => `${esc(g.name)} ${g.qty}${g.unit}${!g.pool && vars && vars[g.key] ? ' (' + esc(varPlain(vars[g.key])) + ')' : ''}`).join(' · ');
}
const pricedMissing = () => sellable().filter(p => !p.price);
const stockMissing = () => stockKeys().filter(k => !keyInfo(k).stock);

/* ---------------- 화면 상태 ---------------- */
let tab = 'sell', mode = 'pre', cart = {}, digits = '', selKey = null, justDone = null;
let cartOrder = [];
let sheet = null, cashIn = 0, adj = null, addPre = null, importDraft = null, restoreDraft = null;
let qs = '', lf = 'all', toastState = null, toastTimer = null, hist = [];
// 되돌리기는 '판매 완료'와 '선입금 수령'만 해요. 그 사이 다른 기록은 건드리지 않아요.
let redo = [];
function pushUndo(h) { hist.push(h); if (hist.length > 30) hist.shift(); redo = []; }
function undoLast() {
  const h = hist.pop(); if (!h) return;
  if (h.type === 'sale') {
    const i = D.sales.findIndex(x => x.n === h.n);
    if (i >= 0) { h.sale = D.sales.splice(i, 1)[0]; cart = { ...h.sale.items }; mode = 'sale'; }
    toast(h.label + '를 취소했어요. 상품은 장바구니로 돌아왔어요');
  } else if (h.type === 'give') {
    const p = D.preorders.find(x => x.key === h.key); if (p) { h.at = p.at; p.at = null; }
    if (justDone === h.key) justDone = null;
    toast(h.label + '을 취소했어요');
  }
  redo.push(h); sheet = null; save();
}
function redoLast() {
  const h = redo.pop(); if (!h) return;
  if (h.type === 'sale' && h.sale) {
    D.sales.push(h.sale); D.sales.sort((a, b) => a.n - b.n);
    for (const [id, q] of Object.entries(h.sale.items)) { if (cart[id]) { cart[id] -= q; if (cart[id] <= 0) delete cart[id]; } }
    toast(h.label + '를 다시 기록했어요');
  } else if (h.type === 'give') {
    const p = D.preorders.find(x => x.key === h.key); if (p) p.at = h.at || Date.now();
    toast(h.label + '을 다시 기록했어요');
  }
  hist.push(h); sheet = null; save();
}

function toast(msg, undo) {
  clearTimeout(toastTimer);
  toastState = { msg, undo: !!undo };
  renderToast();
  toastTimer = setTimeout(() => { toastState = null; renderToast(); }, undo ? 5000 : 2600);
}
// 화면 위쪽에 잠깐 떴다 사라지는 큰 경고 (성인 인증 확인 등)
let alertTimer = null;
function alertBanner(msg) {
  let a = $('#alert');
  if (!a) { a = document.createElement('div'); a.id = 'alert'; a.className = 'alert'; a.setAttribute('role', 'alert'); document.body.appendChild(a); }
  a.textContent = msg; a.classList.remove('show'); void a.offsetWidth; a.classList.add('show');
  clearTimeout(alertTimer); alertTimer = setTimeout(() => a.classList.remove('show'), 2600);
}

// 결제 완료 '띵동' 소리. 음원 파일 없이 기기에서 직접 만들어요
let actx = null, customBuf = null, customLoaded = false;
const SOUND_KEY = 'boothpos:sound';
// 형이 기기에서 고른 소리 파일 (이 기기에만 저장)
// 순서: 기기에서 고른 파일 → 앱에 들어 있는 sounds/pay.mp3 → 기본 띵동(합성)
async function loadCustomSound() {
  customLoaded = true; customBuf = null;
  actx = actx || new (window.AudioContext || window.webkitAudioContext)();
  const decode = buf => new Promise((ok, no) => actx.decodeAudioData(buf, ok, no));
  const url = ls.get(SOUND_KEY);
  if (url) {
    try {
      const bin = atob(url.split(',')[1]), arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      customBuf = await decode(arr.buffer); return;
    } catch { customBuf = null; }
  }
  try { const r = await fetch('sounds/pay.mp3'); if (r.ok) customBuf = await decode(await r.arrayBuffer()); } catch { customBuf = null; }
}
function chime() {
  if (D && D.sound === false) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    if (!customLoaded) { loadCustomSound().then(() => customBuf && playBuf()); return; }
    if (customBuf) { playBuf(); return; }
    const t0 = actx.currentTime + 0.01;
    const note = (f, at, dur, vol) => {
      for (const [mul, v] of [[1, 1], [2, 0.18], [3, 0.06]]) {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = 'sine'; o.frequency.value = f * mul;
        g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(vol * v, at + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        o.connect(g).connect(actx.destination); o.start(at); o.stop(at + dur + 0.05);
      }
    };
    note(1318.5, t0, 0.55, 0.32);        // 띵 (E6)
    note(1760, t0 + 0.12, 0.9, 0.28);    // 동 (A6)
  } catch {}
}
function playBuf() { try { const src = actx.createBufferSource(); src.buffer = customBuf; src.connect(actx.destination); src.start(); } catch {} }

function renderToast() {
  let t = $('#toast');
  if (!toastState) { t && t.remove(); return; }
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.innerHTML = `<span>${esc(toastState.msg)}</span>${toastState.undo ? '<button data-act="undo">되돌리기</button>' : ''}`;
}

/* ---------------- 아이콘 ---------------- */
const IC = {
  check: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  del: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6h10a1 1 0 011 1v10a1 1 0 01-1 1H9l-5-6 5-6z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10l4 4M16 10l-4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  cash: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2.5" stroke="var(--green)" stroke-width="1.8"/><circle cx="12" cy="12" r="2.6" stroke="var(--green)" stroke-width="1.8"/></svg>',
  bank: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 9.5L12 4l9 5.5M5 10v7M9.5 10v7M14.5 10v7M19 10v7M3.5 20h17" stroke="var(--blue)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/* ================= 렌더 ================= */
// 화면 전체를 갈아끼우지 않고 바뀐 부분만 고쳐요 (사진 깜빡임, 시트 다시 올라오기 방지)
function morph(from, to, root) {
  if (from.nodeType === 1 && !root) {
    for (const a of [...from.attributes]) if (!to.hasAttribute(a.name)) from.removeAttribute(a.name);
    for (const a of [...to.attributes]) if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value);
    if (from.tagName === 'INPUT' && document.activeElement !== from) { const v = to.getAttribute('value') ?? ''; if (from.value !== v) from.value = v; }
  }
  const fc = [...from.childNodes], tc = [...to.childNodes];
  for (let i = 0; i < tc.length; i++) {
    const f = fc[i], t = tc[i];
    if (!f) { from.appendChild(t); continue; }
    if (f.nodeType !== t.nodeType || f.nodeName !== t.nodeName) { from.replaceChild(t, f); continue; }
    if (f.nodeType !== 1) { if (f.nodeValue !== t.nodeValue) f.nodeValue = t.nodeValue; continue; }
    if (f.tagName === 'IMG' && f.getAttribute('src') === t.getAttribute('src')) continue;
    morph(f, t);
  }
  for (let i = fc.length - 1; i >= tc.length; i--) from.removeChild(fc[i]);
}
const tpl = document.createElement('div');
function render() {
  const app = $('#app');
  tpl.innerHTML = !booth ? welcomeView()
    : topView() + sellView(tab !== 'sell') + (tab === 'list' ? listView() : tab === 'stock' ? stockView() : tab === 'settings' ? settingsView() : '') + sheetView();
  morph(app, tpl, true);
  renderToast();
  publishMonitor();
}

/* ---------- 족자봉 모니터 (같은 기기의 다른 창, 외장 모니터용) ---------- */
const MON_KEY = 'boothpos:monitor:';
let monChan = null; try { monChan = new BroadcastChannel('boothpos-monitor'); } catch {}
let monLast = '';
function publishMonitor() {
  if (!booth) return;
  const p = justDone ? D.preorders.find(x => x.key === justDone) : (tab === 'sell' && mode === 'pre' && digits.length === 4 ? selected() : null);
  if (!p) return; // 화면이 비어도 모니터는 마지막 손님을 그대로 보여줘요
  const vp = products().filter(x => x.variants);
  const msg = {
    booth, key: p.key, name: p.name, done: !!p.at,
    groups: vp.map(x => ({ name: x.name, vars: (p.vars && p.vars[x.id]) || (p.items[x.id] ? { '?': p.items[x.id] } : {}) })).filter(g => Object.keys(g.vars).length),
  };
  const str = JSON.stringify(msg);
  if (str === monLast) return;
  monLast = str;
  ls.set(MON_KEY + booth, JSON.stringify({ ...msg, ts: Date.now() }));
  try { monChan && monChan.postMessage({ ...msg, ts: Date.now() }); } catch {}
}
const badImg = new Set();
window.__imgfail = el => { badImg.add(el.getAttribute('src')); el.remove(); };

function topView() {
  const old = !D.backupAt || Date.now() - D.backupAt > BACKUP_WARN_MIN * 60000;
  const hasData = D.sales.length || D.preorders.some(p => p.at) || D.adj.length;
  const t = (k, l) => `<button role="tab" aria-selected="${tab === k}" data-tab="${k}">${l}</button>`;
  return `<div class="top"><span class="booth">${esc(B().name)}</span>
    <div class="tabs" role="tablist">${t('sell', '판매')}${t('list', '선입금 명단')}${t('stock', '재고·정산')}${t('settings', '설정')}</div>
    ${hist.length || redo.length ? `<span class="undo-wrap">${hist.length ? `<button class="undo-btn" data-act="undo">되돌리기<small>${esc(hist[hist.length - 1].label)}</small></button>` : ''}${redo.length ? `<button class="undo-btn" data-act="redo">다시 실행<small>${esc(redo[redo.length - 1].label)}</small></button>` : ''}</span>` : ''}
    ${old && hasData ? `<button class="saved" data-tab="settings" style="color:var(--orange);font-weight:600">${D.backupAt ? '백업한 지 1시간이 넘었어요' : '아직 백업하지 않았어요'}</button>`
      : `<span class="saved"><i></i>이 기기에 저장됨${D.savedAt ? ' · ' + hhmm(D.savedAt) : ''}</span>`}</div>`;
}

function welcomeView() {
  return `<div class="welcome"><div class="in">
    <h1>부스 선택</h1>
    ${Object.entries(CFG.booths).map(([k, b]) => `<button class="bpick" data-pick="${k}"><span>${esc(b.name)}<small>상품 ${b.products.filter(p => !p.preorderOnly).length}개</small></span><span class="chev">›</span></button>`).join('')}
  </div></div>`;
}

/* ---------- 판매 ---------- */
function selected() { return D.preorders.find(p => p.key === selKey) || null; }

function thumb(p) {
  return `<span class="thumb">${p.image && !badImg.has(p.image) ? `<img src="${esc(p.image)}" alt="" onerror="__imgfail(this)">` : ''}<span class="ph">${esc(p.name.slice(0, 1))}</span>
    ${p.badge ? `<span class="setno num">${esc(p.badge)}</span>` : ''}</span>`;
}

function sellView(hide) {
  const sel = selected();
  const pickItems = mode === 'pre' && sel && !sel.at && !justDone ? sel.items : {};
  const tiles = sellable().map(p => {
    const inCart = cart[p.id] || 0, av = availFor(p), pick = pickItems[p.id];
    const cls = !p.price ? 'out' : av <= 0 ? 'out' : av <= 3 ? 'low' : '';
    const wt = waitOf(p.id);
    return `<button class="tile ${cls} ${pick ? 'pick' : ''}" data-add="${p.id}">${thumb(p)}
      ${pick ? `<span class="pk">선입금 ${pick}</span>` : inCart ? `<span class="inc num">${inCart}</span>` : ''}
      <span class="tb"><span class="nm">${esc(p.name)}</span>${p.sub ? `<span class="sb">${esc(p.sub)}</span>` : ''}
      <span class="pr num">${p.price ? won(p.price) : '가격 미정 · 설정에서 넣어 주세요'}</span>
      <span class="counts"><span class="cnt site"><b class="num">${Math.max(0, av)}</b><small>${av <= 0 ? '현장 품절' : '현장 재고'}</small></span>
      <span class="cnt pre ${wt ? 'on' : ''}"><b class="num">${wt}</b><small>선입금 대기</small></span></span></span></button>`;
  }).join('');
  const c = cnt(cart);
  return `<div class="sell" ${hide ? 'hidden' : ''}><div class="goods"><div class="goods-h"><h2>상품</h2></div><div class="grid">${tiles}</div></div>
    <div class="panel"><div class="seg" role="tablist">
      <button role="tab" aria-selected="${mode === 'pre'}" data-mode="pre">선입금 수령</button>
      <button role="tab" aria-selected="${mode === 'sale'}" data-mode="sale">현장 구매${c ? ' ' + c : ''}</button></div>
      ${mode === 'sale' ? panelSale() : panelPre()}</div></div>`;
}

function panelSale() {
  const lines = Object.entries(cart), total = sumItems(cart);
  const body = lines.length ? groupItems(cart).map(g => g.pool
    ? `<div class="row"><div class="l"><div class="t">${esc(g.name)} <b class="num">${g.qty}${g.unit}</b></div><div class="s num">${partsText(g)} · ${won(g.total)}</div></div>
      <div class="step"><button data-decpool="${esc(g.key)}" aria-label="마지막으로 담은 묶음 빼기">−</button><span class="num">${g.qty}</span><button data-addlast="${esc(g.key)}" aria-label="마지막으로 담은 묶음 더하기">+</button></div></div>`
    : `<div class="row"><div class="l"><div class="t">${esc(g.name)}</div><div class="s num">${g.sub ? esc(g.sub) + ' · ' : ''}${won(g.total)}</div></div>
      <div class="step"><button data-dec="${g.key}" aria-label="하나 빼기">−</button><span class="num">${g.qty}</span><button data-add="${g.key}" aria-label="하나 더하기">+</button></div></div>`).join('')
    : `<div class="empty"><b>담긴 상품 없음</b></div>`;
  return `<div class="pbody">${body}</div><div class="pfoot">
    ${lines.length ? `<div class="total"><span>합계</span><b class="num">${won(total)}</b></div>` : ''}
    <button class="cta" data-act="pay" ${lines.length ? '' : 'disabled'}>${lines.length ? won(total) + ' 받기' : '결제하기'}</button>
    <button class="cta sub2" data-act="openOut">재고에서 제외하기</button>
    ${lines.length ? '<button class="txtbtn" data-act="clear">모두 비우기</button>' : ''}</div>`;
}

function vchips(v) {
  return `<div class="vchips">${Object.entries(v).sort(([a], [b]) => (a === '?') - (b === '?') || a.localeCompare(b)).map(([L, q]) =>
    L === '?' ? `<span class="vchip warn">종류 미정${q > 1 ? ` <small>×${q}</small>` : ''}</span>` : `<span class="vchip">${esc(L)}${q > 1 ? `<small>×${q}</small>` : ''}</span>`).join('')}</div>`;
}

function panelPre() {
  if (justDone) {
    const p = D.preorders.find(x => x.key === justDone);
    if (p) return `<div class="pbody"><div class="result"><div class="done-mark">${IC.check}</div><h3>${esc(p.name)}님께 전달했어요</h3><p>${itemsText(p.items, p.vars)}</p></div></div>
      <div class="pfoot"><button class="cta" data-act="next">다음 손님</button><button class="txtbtn" data-act="addmore">이 분 현장 구매 추가하기</button></div>`;
    justDone = null;
  }
  const total = D.preorders.length, done = D.preorders.filter(p => p.at).length;
  if (!total) return `<div class="pbody"><div class="empty"><b>선입금 명단 없음</b></div></div>
    <div class="pfoot"><button class="cta weak" data-tab="settings">명단 불러오러 가기</button></div>`;
  if (digits.length < 4) {
    const cells = [0, 1, 2, 3].map(i => `<div class="num ${digits[i] ? 'on' : ''} ${i === digits.length ? 'cur' : ''}">${digits[i] || ''}</div>`).join('');
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clr', '0', 'del'].map(k =>
      k === 'clr' ? '<button class="fn" data-k="clr">전체 삭제</button>'
        : k === 'del' ? `<button class="fn" data-k="del" aria-label="한 자리 지우기">${IC.del}</button>`
          : `<button class="num" data-k="${k}">${k}</button>`).join('');
    return `<div class="pbody"><p class="ask">전화번호 뒷자리</p><div class="digits">${cells}</div>
      <div class="pad">${keys}</div></div><div class="pfoot" style="padding-top:4px"><p class="meta num">${done}명 받아갔어요 · 남은 ${total - done}명</p></div>`;
  }
  const res = D.preorders.filter(p => p.last4 === digits);
  if (!res.length) return `<div class="pbody"><div class="empty"><b>${digits} 선입금 없음</b></div></div>
    <div class="pfoot"><button class="cta weak" data-act="reset">다시 입력하기</button></div>`;
  let sel = selected();
  if (res.length === 1) { sel = res[0]; selKey = sel.key; }
  if (!sel || !res.includes(sel)) {
    return `<div class="pbody"><p class="ask">${digits} · ${res.length}명</p>
      <div class="list">${res.map(p => `<button class="row pick-row" data-sel="${esc(p.key)}"><div class="l"><div class="t">${esc(p.name)}</div><div class="s">${p.at ? hhmm(p.at) + '에 받아갔어요' : '상품 ' + cnt(p.items) + '개'}</div></div><span class="chev">›</span></button>`).join('')}</div></div>
      <div class="pfoot"><button class="txtbtn" data-act="reset">다시 입력하기</button></div>`;
  }
  return preDetail(sel);
}

function recent(n) { return D.preorders.filter(p => p.at).sort((a, b) => b.at - a.at).slice(0, n); }
function lastRecv() {
  const p = recent(1)[0]; if (!p) return '';
  return `<div class="lastrecv"><span>마지막 수령 <b>${esc(p.name)}</b> <span class="num">${esc(p.last4)} · ${hhmm(p.at)}</span></span><button data-ungive="${esc(p.key)}">수령 취소</button></div>`;
}
function preDetail(p) {
  // 족자봉처럼 종류를 골라 챙겨야 하는 상품을 맨 위에 보여줘요
  const lines = groupItems(p.items).sort((a, b) => !!(p.vars && p.vars[b.key]) - !!(p.vars && p.vars[a.key]));
  const hasOnly = lines.some(g => g.p?.preorderOnly);
  return `<div class="pbody">
    ${p.at ? `<p class="recvcount done num">${hhmm(p.at)}에 받아갔어요</p>` : `<p class="recvcount num">받을 상품 <b>${cnt(p.items)}개</b></p>`}${p.manual ? '<span class="badge gray">직접 추가</span>' : ''}
    <p class="who">${esc(p.name)}님</p><p class="sub num">010-••••-${esc(p.last4)}${p.no ? ' · ' + esc(p.no) : ''}</p>
    <div class="list big">${lines.map(g => `<div class="row ${p.vars && p.vars[g.key] ? 'tall' : ''}"><div class="l"><div class="t">${esc(g.name)}${g.sub ? ` <span class="s">${esc(g.sub)}</span>` : ''}${g.pool && g.parts.length > 1 ? ` <span class="s num">${partsText(g)}</span>` : ''}</div>
      ${p.vars && p.vars[g.key] ? vchips(p.vars[g.key]) : ''}</div><span class="num qty">${g.qty}${g.unit}</span></div>`).join('')}</div>
  </div><div class="pfoot">
    ${p.at ? `<button class="cta weak" data-act="reset">다른 번호 찾기</button><button class="txtbtn" data-act="cancelGive">이 분 전달 취소하기</button>`
      : `<button class="cta" data-act="give">전달 완료</button><button class="txtbtn" data-act="reset">다른 번호 찾기</button>`}</div>`;
}

/* ---------- 선입금 명단 ---------- */
function listRows() {
  const s = qs.trim().toLowerCase();
  const rows = D.preorders.filter(p => (lf === 'all' || (lf === 'wait' ? !p.at : !!p.at)) &&
    (!s || p.name.toLowerCase().includes(s) || p.last4.includes(s) || (p.no || '').toLowerCase().includes(s)));
  if (!D.preorders.length) return `<div class="empty" style="padding:40px 0"><b>명단 없음</b></div>`;
  if (!rows.length) return `<div class="empty" style="padding:40px 0"><b>검색 결과 없음</b></div>`;
  return rows.map(p => `<div class="sr"><div class="l"><div class="t">${esc(p.name)} <span class="num l4">${esc(p.last4)}</span></div>
    <div class="s num">${itemsText(p.items, p.vars)}</div></div>
    ${p.at ? `<span class="badge gray">${hhmm(p.at)} 수령</span>` : `<button class="mini" data-go="${esc(p.key)}">수령 처리</button>`}</div>`).join('');
}
function listView() {
  const w = D.preorders.filter(p => !p.at).length, d = D.preorders.length - w;
  const f = [['all', '전체 ' + D.preorders.length], ['wait', '대기 ' + w], ['done', '완료 ' + d]];
  return `<div class="page"><div class="box">
    <div class="lhead"><h2>선입금 명단</h2><span class="cap num">총 ${D.preorders.length}명</span></div>
    <div class="ltools"><input id="q" class="search" placeholder="이름, 뒷자리, 주문번호로 찾기" value="${esc(qs)}" autocomplete="off">
      <div class="seg sm" role="tablist">${f.map(([k, l]) => `<button role="tab" class="num" aria-selected="${lf === k}" data-lf="${k}">${l}</button>`).join('')}</div>
      <button class="mini gray" data-act="openAddPre" style="height:46px;padding:0 16px">직접 추가</button></div>
    <div id="prelist">${listRows()}</div></div>
    <div class="box"><h2>최근 수령</h2>${recent(10).map(p => `<div class="sr"><div class="l"><div class="t">${esc(p.name)} <span class="num l4">${esc(p.last4)}</span></div><div class="s num">${hhmm(p.at)} · ${itemsText(p.items, p.vars)}</div></div>
      <button class="mini red" data-ungive="${esc(p.key)}">수령 취소</button></div>`).join('') || '<p class="cap">없음</p>'}</div></div>`;
}

/* ---------- 재고·정산 ---------- */
function preorderOnlyBoxes() {
  return products().filter(p => p.preorderOnly).map(p => {
    let done = 0, wait = 0; const per = {};
    for (const o of D.preorders) {
      const q = o.items[p.id] || 0; if (!q) continue;
      o.at ? done += q : wait += q;
      const v = (o.vars && o.vars[p.id]) || { '?': q };
      for (const [L, n] of Object.entries(v)) { per[L] = per[L] || { done: 0, wait: 0 }; per[L][o.at ? 'done' : 'wait'] += n; }
    }
    const letters = [...(p.variants || []), ...(per['?'] ? ['?'] : [])];
    const grid = p.variants ? `<div class="vgrid">${letters.map(L => { const x = per[L] || { done: 0, wait: 0 };
      return `<div class="vcell ${x.wait ? 'on' : ''} ${L === '?' ? 'warn' : ''}"><b>${L === '?' ? '미정' : L}</b><span class="num">${x.wait ? '대기 ' + x.wait : x.done ? '완료' : '-'}</span>${x.done && x.wait ? `<small class="num">전달 ${x.done}</small>` : ''}</div>`; }).join('')}</div>` : '';
    return `<div class="box"><h2>${esc(p.name)} <span class="cap" style="font-weight:400">선입금 전용</span></h2><p class="cap num">전달 ${done} · 남은 ${wait}</p>${grid}</div>`;
  }).join('');
}

function stockView() {
  const rows = stockKeys().map(k => {
    const info = keyInfo(k), s = usage(k), r = Math.max(0, Math.min(1, s.left / Math.max(1, info.stock)));
    const tag = !info.stock ? '<small class="out">재고 미입력</small>' : s.avail < 0 ? `<small class="out">선입금 ${-s.avail}${info.unit} 부족</small>` : s.avail === 0 ? '<small class="out">현장 품절</small>'
      : s.avail <= 3 ? `<small class="low">현장 ${s.avail}${info.unit}</small>` : `<small>현장 ${s.avail}${info.unit}</small>`;
    return `<div class="sr"><div class="l"><div class="t">${esc(info.name)}${info.sub ? ` <span class="s">${esc(info.sub)}</span>` : ''}</div>
      <div class="s num">현장 판매 ${s.sold} · 선입금 전달 ${s.done} · 대기 ${s.wait}${s.out ? ' · 조정 ' + (s.out > 0 ? '−' + s.out : '+' + -s.out) : ''}</div>
      <div class="bar ${s.avail <= 3 ? 'low' : ''}"><i style="width:${r * 100}%"></i></div></div>
      <div class="r"><b class="num">${s.left}${info.unit}</b>${tag}</div><button class="mini gray" data-adj="${esc(k)}">조정</button></div>`;
  }).join('');
  const live = D.sales.filter(s => !s.canceled);
  const cash = live.filter(s => s.m === 'cash').reduce((a, s) => a + s.total, 0);
  const tr = live.filter(s => s.m === 'transfer').reduce((a, s) => a + s.total, 0);
  const done = D.preorders.filter(p => p.at).length, all = D.preorders.length;
  const adjLog = D.adj.slice().reverse().map(x => `<div class="sr ${x.canceled ? 'canceled' : ''}"><div class="l"><div class="t">${esc(keyInfo(x.id).name)} <span class="num" style="color:${x.q > 0 ? 'var(--red)' : 'var(--blue)'}">${x.q > 0 ? '−' + x.q : '+' + -x.q}</span></div>
    <div class="s">${esc(x.reason)}${x.memo ? ' · ' + esc(x.memo) : ''} · ${hhmm(x.ts)}${x.canceled ? ' · 취소됨' : ''}</div></div>${x.canceled ? '' : `<button class="txtbtn" data-unadj="${x.n}">취소</button>`}</div>`).join('');
  const saleLog = D.sales.slice().reverse().slice(0, 40).map(s => `<div class="sr ${s.canceled ? 'canceled' : ''}"><div class="l"><div class="t num">${won(s.total)} <span style="color:var(--ink3);font-weight:400;font-size:13px">${s.m === 'cash' ? '현금' : '계좌이체'} · ${hhmm(s.ts)}</span></div>
    <div class="s">${itemsText(s.items)}${s.canceled ? ' · 취소됨' : ''}</div></div>${s.canceled ? '' : `<button class="txtbtn" data-unsale="${s.n}">판매 취소</button>`}</div>`).join('');
  return `<div class="page"><div class="cols">
    <div><div class="box"><h2>재고</h2>${rows}</div>
      ${preorderOnlyBoxes()}
      <div class="box"><h2>현장 판매 기록</h2>${saleLog || '<p class="cap">없음</p>'}</div></div>
    <div class="side">
      <div class="box"><p class="cap">현장 매출</p><p class="money num">${won(cash + tr)}</p>
        <div class="kv"><span>현금</span><b class="num">${won(cash)}</b></div><div class="kv"><span>계좌이체</span><b class="num">${won(tr)}</b></div><div class="kv"><span>판매 건수</span><b class="num">${live.length}건</b></div></div>
      <div class="box"><h2>현금 시재</h2>
        <div class="kv"><span>시작 현금</span><b class="num">${won(D.cashStart || 0)}</b></div>
        <div class="kv"><span>현금 매출</span><b class="num">+ ${won(cash)}</b></div>
        <div class="kv hl"><span>금고에 있어야 할 현금</span><b class="num">${won((D.cashStart || 0) + cash)}</b></div>
        <div class="sr" style="border:0;padding-bottom:0"><div class="l"><div class="t">실제로 센 금액</div>${D.cashCount != null ? `<div class="s num">${mdhm(D.cashCountAt)} 기준</div>` : ''}</div>
          <label class="fld"><span>금액</span><input class="num" type="number" inputmode="numeric" min="0" step="1000" data-cashcount value="${D.cashCount ?? ''}"></label></div>
        ${D.cashCount != null ? (() => { const diff = D.cashCount - ((D.cashStart || 0) + cash); return `<div class="kv ${diff === 0 ? 'hl' : 'bad'}"><span>차이</span><b class="num">${diff === 0 ? '딱 맞아요' : (diff > 0 ? '+' : '−') + won(Math.abs(diff))}</b></div>`; })() : ''}</div>
      <div class="box"><p class="cap">선입금 전달</p><p class="money num" style="margin-bottom:0">${done} / ${all}명</p><div class="prog"><i style="width:${all ? done / all * 100 : 0}%"></i></div></div>
      <div class="box"><h2 style="margin-bottom:0">재고 조정 내역</h2>${adjLog || '<p class="cap">없음</p>'}</div>
    </div></div></div>`;
}

/* ---------- 설정 ---------- */
function settingsView() {
  const ii = D.importInfo, mp = pricedMissing(), ms = stockMissing();
  const warn = mp.length || ms.length ? `<div class="box notice"><h2>채워야 할 값이 있어요</h2>
    ${mp.length ? `<p class="cap">가격: ${mp.map(p => esc(p.name)).join(', ')}</p>` : ''}
    ${ms.length ? `<p class="cap">재고: ${ms.map(k => esc(keyInfo(k).name)).join(', ')}</p>` : ''}
    </div>` : '';
  return `<div class="page"><div class="cols"><div>
    ${warn}
    <div class="box"><h2>가격과 처음 재고</h2>
      ${products().map(p => `<div class="sr"><div class="l"><div class="t">${esc(p.name)}</div><div class="s">${p.preorderOnly ? '선입금 전용' : p.pool ? keyInfo(skey(p)).name + ' 공용 재고 · ' + units(p) + '세트씩' : ''}</div></div>
        ${p.preorderOnly ? '<span class="fld sm"></span>' : `<label class="fld sm chk"><span>R18</span><input type="checkbox" data-ovr="${p.id}" ${p.r18 ? 'checked' : ''}></label>`}
        <label class="fld"><span>가격</span><input class="num" type="number" inputmode="numeric" min="0" step="500" data-ovp="${p.id}" value="${p.price || 0}"></label>
        ${!p.pool && !p.preorderOnly ? `<label class="fld"><span>처음 재고</span><input class="num" type="number" inputmode="numeric" min="0" data-ovs="${p.id}" value="${p.stock || 0}"></label>` : '<span class="fld"></span>'}</div>`).join('')}
      ${Object.keys(B().pools || {}).map(id => { const k = 'pool:' + id, i = keyInfo(k); return `<div class="sr"><div class="l"><div class="t">${esc(i.name)} 공용 재고</div><div class="s">${esc(i.sub)} · ${i.unit} 단위</div></div><span class="fld"></span>
        <label class="fld"><span>처음 재고</span><input class="num" type="number" inputmode="numeric" min="0" data-ovs="${esc(k)}" value="${i.stock}"></label></div>`; }).join('')}
      ${Object.keys(ov().price).length || Object.keys(ov().stock).length ? '<button class="txtbtn" data-act="ovReset" style="padding-left:0">config.js 값으로 되돌리기</button>' : ''}</div>
    <div class="box"><h2>현금 시재</h2>
      <div class="sr"><div class="l"><div class="t">시작 현금</div></div>
        <label class="fld"><span>금액</span><input class="num" type="number" inputmode="numeric" min="0" step="1000" data-cashstart value="${D.cashStart || 0}"></label></div>
      <div class="sr"><div class="l"><div class="t">결제 소리</div></div>
        <button class="mini ${D.sound === false ? 'gray' : ''}" data-act="toggleSound">${D.sound === false ? '꺼짐' : '켜짐'}</button><button class="mini gray" data-act="testSound">들어보기</button></div>
      <div class="sr"><div class="l"><div class="t">소리 파일</div><div class="s">${ls.get(SOUND_KEY) ? esc(ls.get(SOUND_KEY + ':name') || '내 소리 파일') : '기본 소리'}</div></div>
        <button class="mini gray" data-act="pickSound">파일 고르기</button>${ls.get(SOUND_KEY) ? '<button class="mini gray" data-act="clearSound">기본으로</button>' : ''}</div></div>
    <div class="box"><h2>선입금 명단</h2>
      <button class="link" data-act="importCsv"><span>CSV 파일 불러오기<span class="s">${ii ? `${esc(ii.file)} · ${mdhm(ii.ts)} · ${ii.count}명` : ''}</span></span><span class="chev">›</span></button>
      <button class="link" data-act="loadTest"><span>테스트용 선입금 넣기<span class="s">가짜 40명</span></span><span class="chev">›</span></button>
      <button class="link" data-act="sampleCsv"><span>양식 예시 파일 받기</span><span class="chev">›</span></button></div>
    <div class="box"><h2>백업</h2>
      <button class="link" data-act="backup"><span>백업 파일 내보내기<span class="s">${D.backupAt ? '마지막 백업 ' + mdhm(D.backupAt) : '백업 없음'}</span></span><span class="chev">›</span></button>
      <button class="link" data-act="restore"><span>백업 파일로 되살리기</span><span class="chev">›</span></button>
      <button class="link" data-act="exportCsv"><span>정산 CSV 내보내기</span><span class="chev">›</span></button></div>
  </div><div class="side">
    <div class="box"><h2>이 기기</h2>
      <div class="kv"><span>부스</span><b>${esc(B().name)}</b></div>
      <div class="kv"><span>상품</span><b class="num">${products().length}개</b></div>
      <div class="kv"><span>저장 위치</span><b>이 기기 안</b></div>
      <div class="kv"><span>앱 버전</span><b class="num">${APP_VERSION}</b></div>
      <a class="link" href="monitor.html?booth=${booth}" target="_blank" rel="noopener"><span>족자봉 모니터 열기</span><span class="chev">›</span></a>
      <button class="link" data-act="switchBooth"><span>다른 부스로 바꾸기</span><span class="chev">›</span></button></div>
    <div class="box"><button class="link danger" data-act="askReset"><span>이 부스 데이터 모두 지우기</span><span class="chev">›</span></button></div>
  </div></div></div>`;
}

/* ---------- 바텀시트 ---------- */
function sheetView() {
  if (!sheet) return '';
  const total = sumItems(cart);
  let h = '';
  if (sheet === 'method') h = `<h3>결제 방법</h3><p class="amt num">${won(total)}</p>
    <button class="opt" data-m="cash"><span class="ico">${IC.cash}</span><span><span class="t">현금</span></span></button>
    <button class="opt" data-m="transfer"><span class="ico">${IC.bank}</span><span><span class="t">계좌이체</span></span></button>`;
  if (sheet === 'cash') {
    const ch = cashIn - total;
    h = `<h3>받은 금액</h3><p class="bigamt num ${cashIn ? '' : 'zero'}">${won(cashIn)}</p>
    <div class="chips"><button data-cash="exact">딱 맞게</button><button data-cash="1000">+1천원</button><button data-cash="5000">+5천원</button><button data-cash="10000">+1만원</button><button data-cash="50000">+5만원</button><button data-cash="0">지우기</button></div>
    <div class="kv"><span>받을 금액</span><b class="num">${won(total)}</b></div>
    <div class="kv ${cashIn && ch < 0 ? 'bad' : 'hl'}"><span>${cashIn && ch < 0 ? '모자란 금액' : '거스름돈'}</span><b class="num">${cashIn ? won(Math.abs(ch)) : '-'}</b></div>
    <div class="foot"><button class="back" data-act="back">이전</button><button class="cta" data-act="done" ${cashIn >= total ? '' : 'disabled'}>판매 완료</button></div>`;
  }
  if (sheet === 'transfer') {
    h = `<h3>계좌이체</h3><p class="bigamt num">${won(total)}</p>
    <div class="foot"><button class="back" data-act="back">이전</button><button class="cta" data-act="done">입금 확인했어요</button></div>`;
  }
  if (sheet === 'adj' && !adj.id) {
    h = `<h3>재고에서 제외</h3>
    ${stockKeys().map(k => { const i = keyInfo(k), u = usage(k); return `<button class="opt" data-adjpick="${esc(k)}"><span style="flex:1"><span class="t">${esc(i.name)}</span><br><span class="s num">${i.sub ? esc(i.sub) + ' · ' : ''}남은 재고 ${u.left}${i.unit}</span></span><span class="chev">›</span></button>`; }).join('')}
    <div class="foot"><button class="back" style="flex:1" data-act="close">닫기</button></div>`;
  } else if (sheet === 'adj') {
    const info = keyInfo(adj.id), s = usage(adj.id), reasons = adj.dir === 'out' ? REASONS_OUT : REASONS_IN;
    const need = adj.reason === '기타' && !adj.memo.trim();
    h = `<h3>재고 조정</h3><p class="amt num">${esc(info.name)} · 지금 남은 재고 ${s.left}${info.unit}</p>
    <div class="seg" style="margin:0 0 14px"><button aria-selected="${adj.dir === 'out'}" data-dir="out">빼기</button><button aria-selected="${adj.dir === 'in'}" data-dir="in">더하기</button></div>
    <div class="kv"><span>${adj.dir === 'out' ? '뺄' : '더할'} 수량 (${info.unit})</span><div class="step"><button data-aq="-1" aria-label="하나 줄이기">−</button><span class="num">${adj.q}</span><button data-aq="1" aria-label="하나 늘리기">+</button></div></div>
    ${adj.dir === 'out' && adj.q > s.avail ? '<p class="warnline">현장 판매 가능 수량보다 많아요. 선입금 몫이 모자랄 수 있어요</p>' : ''}
    <p class="lbl">사유</p><div class="chips">${reasons.map(r => `<button class="${adj.reason === r ? 'on' : ''}" data-rs="${r}">${r}</button>`).join('')}</div>
    <input id="memo" class="search" style="width:100%" placeholder="${adj.reason === '기타' ? '사유를 적어주세요 (꼭 필요해요)' : '메모 (안 적어도 돼요)'}" value="${esc(adj.memo)}" autocomplete="off">
    <div class="foot"><button class="back" data-act="close">닫기</button><button class="cta" id="adjgo" data-act="adjgo" ${adj.reason && !need ? '' : 'disabled'}>${adj.q}${info.unit} ${adj.dir === 'out' ? '빼기' : '더하기'}</button></div>`;
  }
  if (sheet === 'addpre') {
    const ok = addPreOk();
    h = `<h3>선입금 직접 추가</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><input id="apName" class="search" placeholder="이름" value="${esc(addPre.name)}" autocomplete="off">
    <input id="apLast4" class="search num" style="flex:0 0 140px;min-width:0" inputmode="numeric" maxlength="4" placeholder="뒷자리 4자리" value="${esc(addPre.last4)}" autocomplete="off"></div>
    <div class="list" style="margin-top:12px">${products().map(p => p.variants ? `<div class="row tall"><div class="l"><div class="t">${esc(p.name)}</div>
      <div class="vpick">${p.variants.map(L => { const n = (addPre.vars[p.id] || {})[L] || 0; return `<button class="${n ? 'on' : ''}" data-apv="${p.id}" data-l="${L}">${L}${n > 1 ? `<small>${n}</small>` : ''}</button>`; }).join('')}</div>
      ${addPre.items[p.id] ? `<button class="txtbtn" style="padding-left:0" data-apvclr="${p.id}">${esc(p.name)} 선택 지우기</button>` : ''}</div><span class="num" style="font-weight:600">${addPre.items[p.id] || 0}개</span></div>`
      : `<div class="row"><div class="l"><div class="t">${esc(p.name)}</div><div class="s num">${p.sub ? esc(p.sub) + ' · ' : ''}${won(p.price)}</div></div>
      <div class="step"><button data-apq="${p.id}" data-d="-1" aria-label="빼기">−</button><span class="num">${addPre.items[p.id] || 0}</span><button data-apq="${p.id}" data-d="1" aria-label="더하기">+</button></div></div>`).join('')}</div>
    <div class="foot"><button class="back" data-act="close">닫기</button><button class="cta" id="apgo" data-act="apgo" ${ok ? '' : 'disabled'}>추가하기</button></div>`;
  }
  if (sheet === 'import') {
    const r = importDraft;
    h = `<h3>이 명단을 불러올까요?</h3><p class="amt">${esc(r.file)}</p>
    <div class="kv"><span>파일 전체</span><b class="num">${r.total}줄</b></div>
    <div class="kv hl"><span>${esc(B().name)} 상품이 있는 분</span><b class="num">${r.list.length}명</b></div>
    ${r.unpaid ? `<div class="kv"><span>입금 확인이 안 돼서 뺀 분</span><b class="num">${r.unpaid}명</b></div>` : ''}
    ${r.noPhone ? `<div class="kv bad"><span>전화번호가 없어서 뺀 줄</span><b class="num">${r.noPhone}줄</b></div>` : ''}
    ${r.unknownVar ? `<div class="kv bad"><span>족자봉 종류를 못 읽은 수량</span><b class="num">${r.unknownVar}개</b></div>` : ''}
    <div class="preview">찾은 상품 열: ${r.matched.length ? r.matched.map(esc).join(', ') : '<b style="color:var(--red)">없음</b>'}
      ${r.unknown.length ? `<ul><li>모르는 열이라 건너뛴 것: ${r.unknown.map(esc).join(', ')}</li></ul>` : ''}</div>
    ${r.missingCols.length ? `<p class="warnline">${r.missingCols.join(', ')} 열을 찾지 못했어요. 양식 예시 파일과 열 이름을 맞춰 주세요</p>` : ''}
    <div class="foot"><button class="back" data-act="close">닫기</button><button class="cta" data-act="importGo" ${r.list.length && !r.missingCols.length ? '' : 'disabled'}>${r.list.length}명 불러오기</button></div>`;
  }
  if (sheet === 'restore') {
    const r = restoreDraft;
    h = `<h3>백업으로 되살릴까요?</h3><p class="amt">${esc(r.file)}</p>
    <div class="kv"><span>부스</span><b>${esc(CFG.booths[r.booth]?.name || r.booth)}</b></div>
    <div class="kv"><span>백업한 시각</span><b>${r.exportedAt ? mdhm(r.exportedAt) : '-'}</b></div>
    <div class="kv"><span>선입금 / 판매 기록</span><b class="num">${r.data.preorders.length}명 / ${r.data.sales.length}건</b></div>
    <p class="warnline">지금 이 기기의 ${esc(CFG.booths[r.booth]?.name || r.booth)} 데이터는 백업 내용으로 바뀌어요</p>
    <div class="foot"><button class="back" data-act="close">닫기</button><button class="cta" data-act="restoreGo">되살리기</button></div>`;
  }
  if (sheet === 'reset') h = `<h3>${esc(B().name)} 데이터를 모두 지울까요?</h3><p class="amt">되돌릴 수 없어요</p>
    <div class="foot"><button class="back" data-act="close">닫기</button><button class="cta danger" data-act="resetGo">모두 지우기</button></div>`;
  if (sheet === 'booth') h = `<h3>부스 선택</h3>
    ${Object.entries(CFG.booths).map(([k, b]) => `<button class="opt" data-pick="${k}"><span><span class="t">${esc(b.name)}</span><br><span class="s">${k === booth ? '지금 쓰는 부스' : '상품 ' + b.products.length + '개'}</span></span></button>`).join('')}`;
  return `<div class="dim" data-act="close"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${h}</div>`;
}
const addPreOk = () => addPre && addPre.name.trim() && /^\d{4}$/.test(addPre.last4) && cnt(addPre.items) > 0;

/* ================= CSV ================= */
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split('\n')[0];
  const delim = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : ',';
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}
const norm = s => String(s).toLowerCase().replace(/[\s「」『』"'“”‘’()\[\]<>《》〈〉_\-·.,:!?！？]/g, '');
const META = {
  no: ['주문번호', '번호', '신청번호', 'no', 'id', '주문id'],
  name: ['이름', '닉네임', '성함', '성명', '입금자명', 'name'],
  phone: ['전화번호', '연락처', '휴대폰', '휴대폰번호', '핸드폰', '핸드폰번호', '휴대전화', 'phone', '전화'],
  paid: ['입금확인', '입금여부', '입금', '확인', 'paid'],
};
const IGNORE = ['타임스탬프', 'timestamp', '메모', '비고', '이메일', 'email', '이메일주소', '주소', '트위터', 'x', '계정', '합계', '총액', '금액', '총금액', '입금액', '입금일', '수령방법'];
const truthy = v => /^(o|y|yes|true|1|확인|완료|입금|ㅇ|v|✓|✔|●|○)/i.test(String(v).trim());
const qtyOf = v => { v = String(v || '').trim(); const d = v.match(/\d+/); return d ? parseInt(d[0], 10) : (v && truthy(v) ? 1 : 0); };

// "A, C, C" / "A×2 C" / "a2, c1" 같은 값을 {A:1, C:2} 로 읽어요
function parseVariants(v, letters) {
  const out = {}, set = new Set(letters.map(x => x.toUpperCase()));
  const re = /([A-Za-z])\s*(?:[x×*]\s*)?(\d+)?/g; let m;
  const s = String(v || '').replace(/[xX×*](?=\s*\d)/g, '×');
  while ((m = re.exec(s))) {
    const L = m[1].toUpperCase();
    if (!set.has(L)) continue;
    out[L] = (out[L] || 0) + (m[2] ? parseInt(m[2], 10) : 1);
  }
  return out;
}

function analyzeCSV(rows, file) {
  const head = rows[0].map(h => h.trim()), body = rows.slice(1);
  const col = {}, prodCols = [], matched = [], unknown = [];
  const allProducts = Object.values(CFG.booths).flatMap(b => b.products);
  const isAny = (cand, p) => cand.includes(norm(p.name)) || cand.includes(norm(p.id));
  head.forEach((h, i) => {
    const bracket = h.match(/\[([^\]]+)\]\s*$/);
    const cand = [h, bracket ? bracket[1] : null].filter(Boolean).map(norm);
    for (const [k, names] of Object.entries(META)) if (col[k] === undefined && names.map(norm).some(n => cand.includes(n))) { col[k] = i; return; }
    // 종류별 열: "족자봉 A", "족자봉 [A]", "족자봉_A"
    for (const p of products()) if (p.variants) {
      const L = p.variants.find(L => norm(h) === norm(p.name) + L.toLowerCase() || norm(h) === norm(p.id) + L.toLowerCase());
      if (L) { prodCols.push([i, p.id, L]); if (!matched.includes(p.name + ' (종류별 열)')) matched.push(p.name + ' (종류별 열)'); return; }
    }
    const mine = products().find(p => isAny(cand, p));
    if (mine) { prodCols.push([i, mine.id, null]); matched.push(mine.name); return; }
    if (allProducts.some(p => isAny(cand, p) || (p.variants && p.variants.some(L => norm(h) === norm(p.name) + L.toLowerCase())))) return; // 다른 부스 상품
    if (IGNORE.map(norm).some(n => cand.includes(n))) return;
    if (h) unknown.push(h);
  });
  const missingCols = [];
  if (col.name === undefined) missingCols.push('이름');
  if (col.phone === undefined) missingCols.push('전화번호');
  const list = []; let unpaid = 0, noPhone = 0, unknownVar = 0;
  for (const r of body) {
    if (col.paid !== undefined && !truthy(r[col.paid] || '')) { unpaid++; continue; }
    const items = {}, vars = {};
    const addVar = (id, L, n) => { vars[id] = vars[id] || {}; vars[id][L] = (vars[id][L] || 0) + n; };
    for (const [i, id, L] of prodCols) {
      const v = r[i], p = prod(id);
      if (L) { const n = qtyOf(v); if (n) { items[id] = (items[id] || 0) + n; addVar(id, L, n); } continue; }
      if (p.variants) {
        const pv = parseVariants(v, p.variants), n = cnt(pv);
        if (n) { items[id] = (items[id] || 0) + n; for (const [k, q] of Object.entries(pv)) addVar(id, k, q); }
        else { const q = qtyOf(v); if (q) { items[id] = (items[id] || 0) + q; addVar(id, '?', q); unknownVar += q; } }
        continue;
      }
      const q = qtyOf(v); if (q > 0) items[id] = (items[id] || 0) + q;
    }
    if (!cnt(items)) continue;
    const phone = String(r[col.phone] ?? '').replace(/\D/g, '');
    if (phone.length < 4) { noPhone++; continue; }
    const name = String(r[col.name] ?? '').trim() || '(이름 없음)';
    const no = col.no !== undefined ? String(r[col.no] || '').trim() : '';
    const o = { key: no ? 'no:' + no : 'np:' + name + '|' + phone, no, name, last4: phone.slice(-4), items, at: null };
    if (Object.keys(vars).length) o.vars = vars;
    list.push(o);
  }
  const keyset = new Set(list.map(p => p.key));
  const keep = D.preorders.filter(p => p.at).length;
  return { file, total: body.length, list, unpaid, noPhone, unknownVar, matched, unknown, missingCols, keep, keyset };
}

function applyImport(r) {
  const old = new Map(D.preorders.map(p => [p.key, p]));
  const next = r.list.map(p => { const o = old.get(p.key); return o ? { ...p, at: o.at } : p; });
  for (const p of D.preorders) if (!r.keyset.has(p.key) && (p.at || p.manual)) next.push(p);
  D.preorders = next;
  D.importInfo = { file: r.file, ts: Date.now(), count: r.list.length };
  save();
}

async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { try { return new TextDecoder('euc-kr').decode(buf); } catch { return new TextDecoder().decode(buf); } }
}

function csvCell(v) { v = String(v ?? ''); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function toCSV(rows) { return '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'); }

function sampleCSV() {
  const all = Object.values(CFG.booths).flatMap(b => b.products);
  const names = ['김하늘', '윤솔', '박서진', '이도윤', '최유나', '정민재'];
  const phones = ['010-1234-1234', '010-5555-1234', '010-2222-5678', '010-3030-0291', '010-7777-7777', '010-8282-3141'];
  const rows = [['주문번호', '타임스탬프', '이름', '전화번호', '입금확인', ...all.map(p => p.name)]];
  names.forEach((n, i) => rows.push([`P${String(i + 1).padStart(3, '0')}`, `2026-10-${10 + i} 21:0${i}`, n, phones[i], i === 4 ? '' : 'O',
    ...all.map((p, j) => {
      const on = (i * 3 + j * 5) % 7 < 3;
      if (p.variants) return on ? [p.variants[(i * 7) % 25], p.variants[(i * 11 + 3) % 25]].join(', ') + (i % 2 ? '×2' : '') : '';
      return on ? 1 + ((i + j) % 2) : 0;
    })]));
  return toCSV(rows);
}

// 테스트용 선입금 40명 (가짜 데이터)
function testCSV() {
  const fam = '김이박최정강조윤장임한오서신권황안송류홍', given = ['하늘', '솔', '서진', '도윤', '유나', '민재', '지우', '세린', '하람', '시우', '나래', '태오', '이안', '봄', '규리', '라온', '은호', '다온', '여름', '새벽'];
  const all = Object.values(CFG.booths).flatMap(b => b.products);
  let seed = 7; const rnd = n => (seed = (seed * 9301 + 49297) % 233280, Math.floor(seed / 233280 * n));
  const rows = [['주문번호', '타임스탬프', '이름', '전화번호', '입금확인', ...all.map(p => p.name)]];
  for (let i = 0; i < 40; i++) {
    const last4 = [3, 17, 29].includes(i) ? '1234' : String(1000 + rnd(9000));
    const row = [`T${String(i + 1).padStart(3, '0')}`, `2026-10-${String(1 + (i % 28)).padStart(2, '0')} 2${i % 4}:${String(10 + i).slice(-2)}`,
      fam[i % fam.length] + given[(i * 7) % given.length], `010-${1000 + rnd(9000)}-${last4}`, i % 13 === 12 ? '' : 'O'];
    let any = false;
    for (const p of all) {
      if (p.variants) {
        if (rnd(10) < 5) { any = true; const n = 1 + rnd(3), picks = []; for (let k = 0; k < n; k++) picks.push(p.variants[rnd(p.variants.length)]); row.push(picks.join(', ')); }
        else row.push('');
      } else if (rnd(10) < 4) { any = true; row.push(['dakimakura', 'pc5', 'pc10'].includes(p.id) ? 1 : 1 + rnd(2)); } else row.push(0);
    }
    if (!any) row[5 + 0] = 1;
    rows.push(row);
  }
  return toCSV(rows);
}

function settlementCSV() {
  const rows = [['시각', '구분', '결제수단', '이름', '상품', '수량', '단가', '금액', '상태', '종류', '메모']];
  for (const s of D.sales) for (const [k, q] of Object.entries(s.items)) {
    const p = prod(k); rows.push([mdhm(s.ts), '현장 판매', s.m === 'cash' ? '현금' : '계좌이체', '', p?.name || k, q, p?.price || 0, (p?.price || 0) * q, s.canceled ? '취소' : '완료', '', '']);
  }
  for (const pr of D.preorders) for (const [k, q] of Object.entries(pr.items)) {
    const p = prod(k); rows.push([pr.at ? mdhm(pr.at) : '', '선입금', '선입금', pr.name, p?.name || k, q, p?.price || 0, (p?.price || 0) * q, pr.at ? '전달' : '미수령', pr.vars && pr.vars[k] ? varPlain(pr.vars[k]) : '', pr.no || '']);
  }
  for (const a of D.adj) rows.push([mdhm(a.ts), '재고 조정', '', '', keyInfo(a.id).name, -a.q, '', '', a.canceled ? '취소' : '반영', '', a.reason + (a.memo ? ' / ' + a.memo : '')]);
  return toCSV(rows);
}

/* ================= 파일 저장 ================= */
async function saveFile(name, text, mime) {
  const cap = window.Capacitor;
  if (cap && cap.isNativePlatform && cap.isNativePlatform()) {
    const FS = cap.Plugins.Filesystem, SH = cap.Plugins.Share;
    try {
      const r = await FS.writeFile({ path: name, data: text, directory: 'CACHE', encoding: 'utf8' });
      if (SH) { await SH.share({ title: name, files: [r.uri] }); return '저장할 곳을 골라 주세요'; }
    } catch (e) { if (/cancel/i.test(String(e && e.message || e))) return null; }
    await FS.writeFile({ path: name, data: text, directory: 'DOCUMENTS', encoding: 'utf8', recursive: true });
    return '문서(Documents) 폴더에 저장했어요';
  }
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return '파일을 저장했어요';
}
async function doSave(name, text, mime, after) {
  try { const msg = await saveFile(name, text, mime); if (msg) { after && after(); toast(msg); render(); } }
  catch (e) { toast('파일을 저장하지 못했어요: ' + (e && e.message || e)); }
}

/* ================= 이벤트 ================= */
const app = document.getElementById('app');

app.addEventListener('click', e => {
  const g = s => e.target.closest(s);
  const actEl = g('[data-act]'), a = actEl && actEl.dataset.act;
  const pick = g('[data-pick]');
  if (pick) {
    booth = pick.dataset.pick; ls.set(DEVICE_KEY, booth); D = load(booth); hist = []; redo = [];
    tab = 'sell'; mode = 'pre'; cart = {}; digits = ''; selKey = null; justDone = null; sheet = null;
    render(); return;
  }
  if (!booth) return;
  const tb = g('[data-tab]'), md = g('[data-mode]'), k = g('[data-k]'), sl = g('[data-sel]'), add = g('[data-add]'), dec = g('[data-dec]'),
    m = g('[data-m]'), c = g('[data-cash]'), lfb = g('[data-lf]'), go = g('[data-go]'), ad = g('[data-adj]'), aq = g('[data-aq]'), rs = g('[data-rs]'),
    dir = g('[data-dir]'), un = g('[data-unadj]'), us = g('[data-unsale]'), apq = g('[data-apq]'), apv = g('[data-apv]'), apvc = g('[data-apvclr]'),
    ug = g('[data-ungive]'), ap = g('[data-adjpick]');
  if (ug) { const p = D.preorders.find(x => x.key === ug.dataset.ungive); hist = hist.filter(h => h.key !== ug.dataset.ungive); redo = redo.filter(h => h.key !== ug.dataset.ungive); if (p) { p.at = null; if (justDone === p.key) justDone = null; save(); toast(`${p.name}님 수령을 취소했어요`); } render(); return; }
  if (ap) { adj.id = ap.dataset.adjpick; }

  if (tb) { tab = tb.dataset.tab; sheet = null; }
  if (md) { if (md.dataset.mode === 'pre' && mode === 'sale') { cart = {}; cartOrder = []; } mode = md.dataset.mode; }
  if (k) { const v = k.dataset.k; if (v === 'clr') digits = ''; else if (v === 'del') digits = digits.slice(0, -1); else if (digits.length < 4) digits += v; selKey = null; }
  if (sl) selKey = sl.dataset.sel;
  if (add && !g('.sheet')) {
    const p = prod(add.dataset.add);
    if (!p.price) { toast('가격이 비어 있어요. config.js에 가격을 넣어 주세요'); return; }
    if (availFor(p) >= 1) { cart[p.id] = (cart[p.id] || 0) + 1; cartOrder.push(p.id); mode = 'sale'; justDone = null; }
    else { toast(usage(skey(p)).left > 0 ? '남은 수량은 선입금 몫이라 현장에서 팔 수 없어요' : '재고가 없어요'); return; }
  }
  const dp = g('[data-decpool]'), al = g('[data-addlast]');
  const lastOf = k => { for (let i = cartOrder.length - 1; i >= 0; i--) if (cart[cartOrder[i]] && skey(prod(cartOrder[i])) === k) return cartOrder[i]; return Object.keys(cart).find(id => skey(prod(id)) === k); };
  if (dp) { const id = lastOf(dp.dataset.decpool); if (id) { cart[id]--; if (!cart[id]) delete cart[id]; const i = cartOrder.lastIndexOf(id); if (i >= 0) cartOrder.splice(i, 1); } }
  if (al) { const p = prod(lastOf(al.dataset.addlast)); if (p && availFor(p) >= 1) { cart[p.id]++; cartOrder.push(p.id); } else if (p) { toast('남은 수량이 없어요'); return; } }
  if (dec) { cart[dec.dataset.dec]--; if (!cart[dec.dataset.dec]) delete cart[dec.dataset.dec]; }
  if (m) { sheet = m.dataset.m; cashIn = 0; }
  if (c) { const v = c.dataset.cash; cashIn = v === 'exact' ? sumItems(cart) : v === '0' ? 0 : cashIn + (+v); }
  if (lfb) lf = lfb.dataset.lf;
  if (go) { const p = D.preorders.find(x => x.key === go.dataset.go); if (p) { tab = 'sell'; mode = 'pre'; digits = p.last4; selKey = p.key; justDone = null; } }
  if (ad) { adj = { id: ad.dataset.adj, dir: 'out', q: 1, reason: '', memo: '' }; sheet = 'adj'; }
  if (dir) { adj.dir = dir.dataset.dir; adj.reason = ''; }
  if (aq) { const mx = adj.dir === 'out' ? Math.max(1, usage(adj.id).left) : 99999; adj.q = Math.min(mx, Math.max(1, adj.q + (+aq.dataset.aq))); }
  if (rs) adj.reason = rs.dataset.rs;
  if (apq) { const id = apq.dataset.apq; addPre.items[id] = Math.max(0, (addPre.items[id] || 0) + (+apq.dataset.d)); if (!addPre.items[id]) delete addPre.items[id]; }
  if (apv) { const id = apv.dataset.apv, L = apv.dataset.l; addPre.vars[id] = addPre.vars[id] || {}; addPre.vars[id][L] = (addPre.vars[id][L] || 0) + 1; addPre.items[id] = (addPre.items[id] || 0) + 1; }
  if (apvc) { const id = apvc.dataset.apvclr; delete addPre.vars[id]; delete addPre.items[id]; }
  if (un) { const x = D.adj.find(z => z.n === +un.dataset.unadj); x.canceled = true; save(); toast(`${keyInfo(x.id).name} 재고 조정을 취소했어요`); render(); return; }
  if (us) { const s = D.sales.find(z => z.n === +us.dataset.unsale); s.canceled = true; save(); toast(`${won(s.total)} 판매를 취소했어요`); render(); return; }

  switch (a) {
    case 'pay': if (Object.keys(cart).some(id => prod(id)?.r18)) alertBanner('성인 인증 팔찌 확인하세요!'); sheet = 'method'; break;
    case 'close': sheet = null; break;
    case 'back': sheet = 'method'; break;
    case 'clear': cart = {}; break;
    case 'toggleSound': D.sound = D.sound === false; save(); if (D.sound) chime(); break;
    case 'testSound': chime(); return;
    case 'pickSound': $('#fileSound').value = ''; $('#fileSound').click(); return;
    case 'clearSound': ls.del(SOUND_KEY); ls.del(SOUND_KEY + ':name'); customLoaded = false; customBuf = null; toast('기본 소리로 바꿨어요'); break;
    case 'openOut': adj = { id: null, dir: 'out', q: 1, reason: '', memo: '' }; sheet = 'adj'; break;
    case 'ovReset': D.ov = { price: {}, stock: {} }; save(); toast('config.js 값으로 되돌렸어요'); break;
    case 'done': {
      const t = sumItems(cart), cash = sheet === 'cash';
      const sn = nextId(); pushUndo({ type: 'sale', n: sn, label: won(t) + ' 판매' });
      D.sales.push({ n: sn, ts: Date.now(), items: { ...cart }, total: t, m: cash ? 'cash' : 'transfer', cashIn: cash ? cashIn : null });
      const ch = cash ? cashIn - t : 0;
      cart = {}; sheet = null; save();
      toast(`${won(t)} ${cash ? '현금' : '계좌이체'}로 판매했어요${ch > 0 ? ' · 거스름돈 ' + won(ch) : ''}`, true); chime();
      break;
    }
    case 'give': { const p = selected(); pushUndo({ type: 'give', key: p.key, label: p.name + '님 수령' }); p.at = Date.now(); justDone = p.key; save(); toast(`${p.name}님 수령 완료`, true); chime(); break; }
    case 'cancelGive': { const p = selected(); p.at = null; save(); toast(`${p.name}님 전달을 취소했어요`); break; }
    case 'next': justDone = null; digits = ''; selKey = null; break;
    case 'addmore': justDone = null; digits = ''; selKey = null; mode = 'sale'; break;
    case 'reset': digits = ''; selKey = null; break;
    case 'undo': clearTimeout(toastTimer); toastState = null; undoLast(); break;
    case 'redo': clearTimeout(toastTimer); toastState = null; redoLast(); break;
    case 'adjgo': {
      const q = adj.dir === 'out' ? adj.q : -adj.q, info = keyInfo(adj.id);
            D.adj.push({ n: nextId(), ts: Date.now(), id: adj.id, q, reason: adj.reason, memo: adj.memo.trim() });
      sheet = null; save(); toast(`${info.name} ${adj.q}${info.unit}를 재고${adj.dir === 'out' ? '에서 뺐어요' : '에 더했어요'}`); adj = null; break;
    }
    case 'openAddPre': addPre = { name: '', last4: '', items: {}, vars: {} }; sheet = 'addpre'; break;
    case 'apgo': {
      if (!addPreOk()) break;
      const p = { key: 'm:' + Date.now(), no: '', name: addPre.name.trim(), last4: addPre.last4, items: { ...addPre.items }, at: null, manual: true };
      if (Object.keys(addPre.vars).length) p.vars = JSON.parse(JSON.stringify(addPre.vars));
      D.preorders.push(p); sheet = null; save(); toast(`${p.name}님을 명단에 추가했어요`); break;
    }
    case 'importCsv': $('#fileCsv').value = ''; $('#fileCsv').click(); return;
    case 'importGo': applyImport(importDraft); toast(`선입금 ${importDraft.list.length}명을 불러왔어요`); importDraft = null; sheet = null; break;
    case 'loadTest': { const rows = parseCSV(testCSV().replace(/^\uFEFF/, '')); importDraft = analyzeCSV(rows, '테스트 데이터 (가짜 40명)'); sheet = 'import'; break; }
    case 'sampleCsv': doSave('선입금_양식_예시.csv', sampleCSV(), 'text/csv'); return;
    case 'backup': {
      const ts = Date.now();
      const payload = JSON.stringify({ app: 'booth-pos', v: 1, booth, exportedAt: ts, data: { ...D, backupAt: ts } }, null, 1);
      doSave(`부스포스_${booth}_백업_${stamp()}.json`, payload, 'application/json', () => { D.backupAt = ts; save(); });
      return;
    }
    case 'restore': $('#fileBackup').value = ''; $('#fileBackup').click(); return;
    case 'restoreGo': {
      const r = restoreDraft; ls.set(dataKey(r.booth), JSON.stringify(Object.assign(emptyData(), r.data)));
      booth = r.booth; ls.set(DEVICE_KEY, booth); D = load(booth); hist = []; redo = []; restoreDraft = null; sheet = null;
      cart = {}; digits = ''; selKey = null; justDone = null; toast('백업 내용으로 되살렸어요'); break;
    }
    case 'exportCsv': doSave(`부스포스_${booth}_정산_${stamp()}.csv`, settlementCSV(), 'text/csv'); return;
    case 'switchBooth': sheet = 'booth'; break;
    case 'askReset': sheet = 'reset'; break;
    case 'resetGo': ls.del(dataKey(booth)); D = emptyData(); hist = []; redo = []; sheet = null; cart = {}; digits = ''; selKey = null; justDone = null; toast('이 부스 데이터를 모두 지웠어요'); break;
  }
  render();
});

document.addEventListener('click', e => {
  if (e.target.closest('#toast [data-act="undo"]')) { clearTimeout(toastTimer); toastState = null; undoLast(); render(); }
});

app.addEventListener('input', e => {
  const id = e.target.id;
  if (id === 'q') { qs = e.target.value; $('#prelist').innerHTML = listRows(); }
  if (id === 'memo' && adj) { adj.memo = e.target.value; $('#adjgo').disabled = !adj.reason || (adj.reason === '기타' && !adj.memo.trim()); }
  if ((id === 'apName' || id === 'apLast4') && addPre) {
    if (id === 'apLast4') { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); addPre.last4 = e.target.value; } else addPre.name = e.target.value;
    $('#apgo').disabled = !addPreOk();
  }
});

app.addEventListener('change', e => {
  const t = e.target, v = Math.max(0, Math.round(+t.value || 0));
  if (t.dataset.ovp) { ov().price[t.dataset.ovp] = v; save(); toast('가격을 바꿨어요'); render(); }
  if (t.dataset.ovr) { ov().r18[t.dataset.ovr] = t.checked; save(); toast(t.checked ? 'R18 상품으로 표시했어요' : 'R18 표시를 껐어요'); render(); return; }
  if (t.hasAttribute('data-cashstart')) { D.cashStart = v; save(); toast('시작 현금을 저장했어요'); render(); return; }
  if (t.hasAttribute('data-cashcount')) { D.cashCount = t.value === '' ? null : v; D.cashCountAt = Date.now(); save(); render(); return; }
  if (t.dataset.ovs) { ov().stock[t.dataset.ovs] = v; save(); toast('처음 재고를 바꿨어요'); render(); }
});

document.addEventListener('keydown', e => {
  if (!booth || e.target.tagName === 'INPUT') return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redoLast() : undoLast(); render(); return; }
  if (e.key === 'Escape' && sheet) { sheet = null; render(); return; }
  if (tab !== 'sell' || mode !== 'pre' || justDone || sheet) return;
  if (/^[0-9]$/.test(e.key) && digits.length < 4) { digits += e.key; selKey = null; render(); }
  else if (e.key === 'Backspace' && digits.length) { digits = digits.slice(0, -1); selKey = null; render(); }
});

$('#fileCsv').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const rows = parseCSV(await readTextFile(f));
    if (rows.length < 2) { toast('파일에 명단이 없어요'); return; }
    importDraft = analyzeCSV(rows, f.name); sheet = 'import'; render();
  } catch (err) { toast('CSV 파일을 읽지 못했어요'); }
});
$('#fileSound').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  if (f.size > 1024 * 1024) { toast('1MB보다 작은 소리 파일을 골라 주세요'); return; }
  const r = new FileReader();
  r.onload = async () => {
    if (!ls.set(SOUND_KEY, r.result)) { toast('소리 파일을 저장하지 못했어요'); return; }
    ls.set(SOUND_KEY + ':name', f.name);
    await loadCustomSound();
    if (customBuf) { toast('소리를 바꿨어요'); playBuf(); } else { ls.del(SOUND_KEY); ls.del(SOUND_KEY + ':name'); toast('이 파일은 재생할 수 없어요'); }
    render();
  };
  r.readAsDataURL(f);
});
$('#fileBackup').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const j = JSON.parse(await readTextFile(f));
    if (j.app !== 'booth-pos' || !j.data || !CFG.booths[j.booth]) throw new Error();
    restoreDraft = { file: f.name, booth: j.booth, exportedAt: j.exportedAt, data: Object.assign(emptyData(), j.data) }; sheet = 'restore'; render();
  } catch { toast('부스 포스 백업 파일이 아니에요'); }
});

/* ================= 시작 ================= */
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
async function keepAwake() { try { if ('wakeLock' in navigator && document.visibilityState === 'visible') await navigator.wakeLock.request('screen'); } catch {} }
document.addEventListener('visibilitychange', keepAwake); keepAwake();
const native = window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform();
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !native) {
  // 새 버전이 설치되면 한 번 새로고침해서 바로 적용해요
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded && !sheet) { reloaded = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {});
}

render();
})();
