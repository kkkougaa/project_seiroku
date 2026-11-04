'use strict';
// =====================================================================
//  행사 관리 사이트
//  구글 시트(데이터) ← Apps Script(API) ← 이 페이지(화면)
//  이 파일에는 데이터가 없어요. 연결 주소와 비밀키는 이 브라우저에만 저장돼요.
// =====================================================================

const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = n => (Math.round(n) < 0 ? '-' : '') + '₩' + Math.abs(Math.round(n || 0)).toLocaleString('ko-KR');
const cnt = n => (n || 0).toLocaleString('ko-KR');
const toNum = v => { const s = String(v ?? '').replace(/[^\d.\-]/g, ''); const n = parseFloat(s); return isFinite(n) ? n : 0; };
const normName = s => String(s || '').toLowerCase().replace(/[\s()\[\]{}.,·_\-/\\'"]/g, '');

// ---------------------------------------------------------------------
// 저장 (이 브라우저에만)
// ---------------------------------------------------------------------
const LS_KEY = 'seiroku-admin';
const store = (() => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; } })();
const saveStore = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch {} };

// 연결 링크: 사이트주소#c=<base64url(JSON {u, k, n})>
//  # 뒤는 서버로 가지 않아요. 열자마자 이 브라우저에 저장하고 주소창에서 지워요.
function encodeLink(o) {
  const bytes = new TextEncoder().encode(JSON.stringify(o));
  let bin = ''; bytes.forEach(b => { bin += String.fromCharCode(b); });
  return location.origin + location.pathname + '#c=' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeLink(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s), bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}
let linkMsg = '';
if (location.hash.startsWith('#c=')) {
  try {
    const o = decodeLink(location.hash.slice(3));
    if (!/^https:\/\/script\.google\.com\//.test(o.u) || !o.k) throw new Error();
    store.url = o.u; store.key = o.k; store.who = o.n || ''; store.demo = false; saveStore();
    linkMsg = (o.n ? o.n + ' 님, ' : '') + '연결했어요';
  } catch { linkMsg = '!연결 링크가 이상해요. 링크를 다시 받아 주세요.'; }
  history.replaceState(null, '', location.pathname + '#home');
}

// ---------------------------------------------------------------------
// 기본 설정 (settings.js) + 구글 로그인
// ---------------------------------------------------------------------
const CFG = self.ADMIN_SETTINGS || {};
// settings.js 에 주소가 있으면 항상 그 주소를 써요 (예전에 직접 넣은 주소는 무시)
const apiUrl = () => CFG.apiUrl || store.url || '';
if (CFG.apiUrl && store.url && store.url !== CFG.apiUrl) { delete store.url; saveStore(); }
const tokOk = () => !!(store.tok && store.tok.exp * 1000 > Date.now() + 30000);
const useGoogle = () => !!CFG.googleClientId && !store.key;
const connected = () => st.demo || (apiUrl() && (store.key || (CFG.googleClientId && tokOk())));
function jwtPayload(t) {
  let s = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0))));
}
let gisReady = null;
function loadGis() {
  if (gisReady) return gisReady;
  gisReady = new Promise((ok, no) => {
    const sc = document.createElement('script'); sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true;
    sc.onload = () => {
      google.accounts.id.initialize({
        client_id: CFG.googleClientId, auto_select: true, cancel_on_tap_outside: false, use_fedcm_for_prompt: true,
        callback: resp => {
          const p = jwtPayload(resp.credential);
          store.tok = { t: resp.credential, exp: p.exp, email: p.email, name: p.name || p.email, pic: p.picture || '' };
          saveStore(); st.loginErr = '';
          load();
        },
      });
      ok();
    };
    sc.onerror = () => no(new Error('구글 로그인을 불러오지 못했어요'));
    document.head.appendChild(sc);
  });
  return gisReady;
}
function drawGoogleButton() {
  const el = document.getElementById('gbtn'); if (!el) return;
  loadGis().then(() => {
    google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', locale: 'ko', width: 280 });
    if (store.tok) google.accounts.id.prompt(); // 전에 로그인했던 사람은 자동으로
  }).catch(e => { el.textContent = e.message; });
}
function signOut() {
  if (store.tok && self.google) try { google.accounts.id.disableAutoSelect(); } catch {}
  delete store.tok; saveStore(); dropCache(); st.tabs = null; st.emails = null; render();
}

// ---------------------------------------------------------------------
// 화면 상태
// ---------------------------------------------------------------------
const VIEWS = [['home', '홈'], ['authors', '작가'], ['orders', '주문'], ['match', '입금 대조'], ['make', '제작 수량'], ['money', '정산'], ['memo', '예외기록'], ['settings', '설정']];
const st = {
  view: (location.hash.slice(1) || 'home'),
  tabs: null, loading: false, err: '', at: null, demo: !!store.demo,
  authorSeg: 'all', orderFilter: 'all', orderQ: '', authorQ: '',
};
if (!VIEWS.some(v => v[0] === st.view)) st.view = 'home';

// ---------------------------------------------------------------------
// API — Apps Script 로 보내요. 둘러보기 모드면 이 브라우저 안에서 똑같이 처리해요.
// ---------------------------------------------------------------------
async function api(action, payload = {}) {
  if (st.demo) {
    if (action === 'read') { if (!st.demoTabs) st.demoTabs = self.DEMO_TABS(); return { ok: true, tabs: JSON.parse(JSON.stringify(st.demoTabs)) }; }
    if (action === 'sample') {
      const fresh = self.DEMO_TABS(), name = payload.which === 'orders' ? '선입금 리스트' : '입금기록';
      st.demoTabs[name] = fresh[name]; return { ok: true, count: fresh[name].rows.length };
    }
    if (action === 'reset') {
      (payload.which === 'orders' ? ['선입금 리스트', '주문 처리'] : ['입금기록']).forEach(n => { st.demoTabs[n].rows = []; });
      return { ok: true };
    }
    if (action === 'avatars') return { ok: true, rows: {} };
    if (action === 'emails') return { ok: true, list: [], owner: 'demo@example.com', canEdit: false };
    applyOp(st.demoTabs, { action, ...payload });
    return { ok: true };
  }
  if (!connected()) throw new Error('로그인해 주세요.');
  const auth = store.key ? { key: store.key } : { idToken: store.tok.t };
  const r = await fetch(apiUrl(), { method: 'POST', body: JSON.stringify({ ...auth, action, ...payload }), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow' });
  if (!r.ok) throw new Error('연결 실패 (' + r.status + ')');
  let j; try { j = await r.json(); } catch { throw new Error('응답을 못 읽었어요. 웹 앱 배포 주소가 맞는지 확인해 주세요.'); }
  if (!j.ok) {
    if (j.code === 'LOGIN' || j.code === 'DENIED') {
      if (store.tok && !store.key) { delete store.tok; saveStore(); }
      st.loginErr = j.error; st.tabs = null; setTimeout(render);
    }
    throw new Error(j.error || '알 수 없는 오류');
  }
  return j;
}

// 같은 이름 열이 여러 개면 "족자봉#2" 처럼 몇 번째인지 붙여요 (Code.gs 와 같은 규칙)
function colIdx(header, name) {
  const m = String(name).match(/^(.*)#(\d+)$/);
  const base = m ? m[1] : name, nth = m ? +m[2] : 1;
  let seen = 0;
  for (let i = 0; i < header.length; i++) if (String(header[i]).trim() === base && ++seen === nth) return i;
  return -1;
}

// 시트에 쓴 내용을 화면 데이터에도 똑같이 반영해요 (새로 다 불러오지 않아도 되게)
function applyOp(tabs, req) {
  const t = tabs[req.sheet] || (tabs[req.sheet] = { header: [], rows: [] });
  const setVals = (row, values) => Object.entries(values || {}).forEach(([k, v]) => {
    let i = colIdx(t.header, k);
    if (i < 0) { i = t.header.length; t.header.push(k); }
    while (row.length <= i) row.push('');
    row[i] = String(v ?? '');
  });
  const checkMatch = (row, match) => Object.entries(match || {}).forEach(([k, v]) => {
    const i = colIdx(t.header, k);
    if (i >= 0 && String(row[i] ?? '') !== String(v)) throw new Error('그 사이 시트가 바뀌었어요. 새로고침한 뒤 다시 해 주세요.');
  });
  if (req.action === 'update') { const row = t.rows[req.row - 2]; if (!row) throw new Error('없는 줄이에요.'); checkMatch(row, req.match); setVals(row, req.values); }
  else if (req.action === 'upsert') {
    const i = colIdx(t.header, req.keyCol);
    let row = i >= 0 ? t.rows.find(r => String(r[i]) === String(req.keyVal)) : null;
    if (!row) { row = t.header.map(() => ''); t.rows.push(row); }
    setVals(row, { [req.keyCol]: req.keyVal, ...req.values });
  }
  else if (req.action === 'append') { const row = t.header.map(() => ''); t.rows.push(row); setVals(row, req.values); }
  else if (req.action === 'remove') { const row = t.rows[req.row - 2]; if (!row) throw new Error('없는 줄이에요.'); checkMatch(row, req.match); t.rows.splice(req.row - 2, 1); }
  else if (req.action === 'replace') { tabs[req.sheet] = { header: req.rows[0].map(String), rows: req.rows.slice(1).map(r => r.map(v => String(v ?? ''))) }; }
}

// 화면에 먼저 반영하고, 시트 저장은 뒤에서 순서대로 해요. (기다리지 않아도 돼요)
let pending = 0, queue = Promise.resolve();
function write(action, payload, okMsg) {
  try { applyOp(st.tabs, { action, ...payload }); }
  catch (e) { toast(e.message, true); return Promise.resolve(false); }
  model = null; saveCache(); render();
  if (okMsg) toast(okMsg);
  pending++; setSync('busy');
  queue = queue.then(() => api(action, payload)).then(() => { pending--; if (!pending) setSync('ok'); }, e => {
    pending = 0; queue = Promise.resolve();
    toast('시트에 저장하지 못했어요: ' + e.message, true); setSync('err');
    load();
  });
  return Promise.resolve(true);
}
const CACHE = 'seiroku-admin-cache';
function saveCache() { if (st.demo || !st.tabs) return; try { sessionStorage.setItem(CACHE, JSON.stringify(st.tabs)); } catch {} }
function readCache() { try { return JSON.parse(sessionStorage.getItem(CACHE)); } catch { return null; } }
function dropCache() { try { sessionStorage.removeItem(CACHE); } catch {} }

async function load(fresh = false) {
  await queue.catch(() => {});
  st.loading = true; st.err = ''; setSync('busy');
  if (!st.tabs) render();
  try {
    const j = await api('read', fresh ? { fresh: true } : {});
    st.tabs = j.tabs; st.at = new Date(); model = null; saveCache();
    if (j.who && j.who !== store.who) { store.who = j.who; saveStore(); }
    st.admin = st.demo ? true : !!j.admin;
    if (!st.demo) setTimeout(fetchAvatars, 300);
    setSync('ok');
  } catch (e) { st.err = e.message; setSync('err'); }
  st.loading = false;
  render();
}

// ---------------------------------------------------------------------
// 표 읽기 도우미
// ---------------------------------------------------------------------
function T(name) {
  const t = (st.tabs && st.tabs[name]) || { header: [], rows: [] };
  return {
    header: t.header,
    rows: t.rows.map((r, i) => {
      const get = col => { const k = colIdx(t.header, col); return k >= 0 ? String(r[k] ?? '').trim() : ''; };
      return { row: i + 2, raw: r, get };
    }),
  };
}

// ---------------------------------------------------------------------
// 족자봉 글자 → 넘버 목록
//  "2,27,18" / "9번, 11번" / "4번 / 15번" / "2호×2, 7호×1" / "18번 2개" / "1번 6번 8번"
// ---------------------------------------------------------------------
//  알파벳: "A, C", "B×2", "a b", "D번" / 숫자(작년): "2,27,18" 도 같이 읽어요. 안에서는 A=1, B=2 … 로 셉니다.
//  "UZA", "ku-n" 처럼 단어 속 알파벳은 넘버로 안 봐요.
function parseJokja(text) {
  const out = {};
  let s = String(text || '').replace(/[＊*]/g, '×').replace(/(?<=[A-Za-z0-9번호]\s*)[xX](?=\s*\d)/g, '×');
  if (!/[A-Za-z]{2,}/.test(s)) s = s.toUpperCase(); // 소문자 a, b 는 단어가 없을 때만 넘버로 봐요
  const re = /(?<![A-Za-z])([A-Z])(?![A-Za-z])(?:(\d+)(?!\d)|\s*(?:번|호)?\s*(?:×\s*(\d+)|(\d+)\s*개))?|(\d+)\s*(?:번|호)?\s*(?:×\s*(\d+)|(\d+)\s*개)?/g;
  let m;
  while ((m = re.exec(s))) {
    let n, q;
    if (m[1]) { n = m[1].charCodeAt(0) - 64; q = +(m[2] || m[3] || m[4] || 1); }
    else { n = +m[5]; q = +(m[6] || m[7] || 1); }
    if (!n) continue;
    out[n] = (out[n] || 0) + q;
  }
  return out;
}
let jAlpha = true; // 설정 '족자봉 표기' (build 에서 정해요)
const jName = n => jAlpha && n >= 1 && n <= 26 ? String.fromCharCode(64 + n) : String(n);
const sumObj = o => Object.values(o || {}).reduce((a, b) => a + b, 0);
const jokjaText = o => Object.keys(o).map(Number).sort((a, b) => a - b).map(n => o[n] > 1 ? `${jName(n)}×${o[n]}` : jName(n)).join(', ');
const jokjaChips = o => {
  const ks = Object.keys(o || {}).map(Number).sort((a, b) => a - b);
  return ks.length ? `<span class="jk">${ks.map(n => `<span>${jName(n)}${o[n] > 1 ? `<em>×${o[n]}</em>` : ''}</span>`).join('')}</span>` : '<span class="muted">-</span>';
};

// ---------------------------------------------------------------------
// 모든 계산은 여기서 한 번에 해요
// ---------------------------------------------------------------------
let model = null;
function M() { if (!model) model = build(); return model; }

function build() {
  // 설정
  const cfg = {};
  for (const r of T('설정').rows) if (r.get('항목')) cfg[r.get('항목')] = r.get('값');
  jAlpha = (cfg['족자봉 표기'] || cfg['포스 족자봉 표기'] || '알파벳') !== '숫자';
  const priceBook = toNum(cfg['엽서북 가격']) || 20000;
  const priceJ = toNum(cfg['족자봉 가격']) || 25000;
  const spareJ = cfg['작가 여분 족자봉'] === '' || cfg['작가 여분 족자봉'] === undefined ? 1 : toNum(cfg['작가 여분 족자봉']);
  const bookPerAuthor = cfg['작가 증정 엽서북'] === '' || cfg['작가 증정 엽서북'] === undefined ? 1 : toNum(cfg['작가 증정 엽서북']);
  const ratios = String(cfg['분배 비율'] || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/^(.*?)[\s:]*([\d.]+)$/); return m ? { name: m[1].trim(), w: +m[2] } : null;
  }).filter(x => x && x.name && x.w > 0);

  // 작가
  const authors = T('작가').rows.filter(r => r.get('닉네임') || r.get('X 아이디')).map(r => ({
    row: r.row, r, no: toNum(r.get('No')) || null, nick: r.get('닉네임'), x: r.get('X 아이디'), status: r.get('수락 여부'),
    discord: r.get('디스코드'), submit: r.get('제출 여부'), pickup: r.get('현장 수령'), revKo: r.get('후기 (한)'), revJa: r.get('후기 (일)'), pic: r.get('프로필 사진'), comment: r.get('기타'),
  }));
  const confirmed = authors.filter(a => a.status === '수락');
  const authorByNo = {}; confirmed.forEach(a => { if (a.no) authorByNo[a.no] = a; });
  const maxNo = Math.max(confirmed.length, ...confirmed.map(a => a.no || 0), 0);

  // 주문 처리 (사이트에서 고친 값)
  const proc = {};
  for (const r of T('주문 처리').rows) if (r.get('주문번호')) proc[r.get('주문번호')] = { row: r.row, j: r.get('족자봉 확정'), pay: r.get('입금 처리'), dep: r.get('입금 키'), memo: r.get('메모') };

  // 입금기록
  const deposits = T('입금기록').rows.filter(r => r.get('거래 일시') || r.get('적요')).map(r => {
    const amt = toNum(r.get('거래 금액'));
    const type = r.get('거래 유형') || (amt < 0 ? '출금' : '입금');
    const key = [r.get('거래 일시'), r.get('적요'), Math.abs(amt)].join('|');
    return { row: r.row, key, at: r.get('거래 일시'), who: r.get('적요'), type, amt: Math.abs(amt), bal: r.get('거래 후 잔액'), balN: toNum(r.get('거래 후 잔액')), memo: r.get('메모'), bank: r.get('거래 기관'), order: null };
  });
  const depByKey = {}; deposits.forEach(d => { depByKey[d.key] = d; });

  // 주문
  const orders = T('선입금 리스트').rows.filter(r => r.get('주문번호') || r.get('번호')).map(r => {
    const id = r.get('주문번호') || ('#' + r.get('번호'));
    const p = proc[id] || {};
    const text = r.get('족자봉#2');
    const qty = toNum(r.get('족자봉#1'));
    const parsed = parseJokja(text);
    const fixed = p.j ? parseJokja(p.j) : null;
    const jk = fixed || parsed;
    const bad = Object.keys(jk).map(Number).filter(n => n < 1 || (maxNo && n > maxNo));
    let jState = 'ok';
    if (fixed) jState = 'fixed';
    else if (sumObj(parsed) !== qty || bad.length) jState = 'check';
    if (!qty && !text && !fixed) jState = 'none';
    const books = toNum(r.get('엽서북')), ship = toNum(r.get('배송비')), total = toNum(r.get('총 주문금액#1'));
    const expect = books * priceBook + qty * priceJ + ship;
    return {
      row: r.row, r, id, num: r.get('번호'), nick: r.get('닉네임'), name: r.get('주문자명'), payer: r.get('환불예금주'), recv: r.get('수령자명'),
      phone: r.get('수령자연락처') || r.get('주문자연락처'), books, qty, text, parsed, fixed, jk, jCount: sumObj(jk), jState, bad,
      total, expect, ship, method: r.get('배송방법'), formStatus: r.get('진행상태'), proc: p, pay: null, dep: null, deps: [], depSum: 0, cand: null,
    };
  });

  // 입금 대조
  //  1) 폼에서 결제완료 → 폼 결제   2) 사이트에서 손으로 연결/확인   3) 이름 + 금액이 같은 입금 자동 연결
  const used = new Set();
  for (const o of orders) {
    const pay = o.proc.pay;
    if (pay === '취소') { o.pay = 'cancel'; continue; }
    const keys = String(o.proc.dep || '').split('\n').filter(k => depByKey[k]);
    if (keys.length) {
      o.deps = keys.map(k => depByKey[k]); o.deps.forEach(d => { d.order = o; used.add(d.key); });
      o.dep = o.deps[0]; o.depSum = o.deps.reduce((a, d) => a + d.amt, 0);
      o.pay = o.depSum === o.total ? 'linked' : 'diff'; continue;
    }
    if (pay === '확인') { o.pay = 'manual'; continue; }
    if (pay === '미입금') { o.pay = 'unpaid'; continue; }
    if (o.formStatus === '결제완료') { o.pay = 'form'; continue; }
  }
  const names = o => [o.payer, o.name, o.recv, o.nick].map(normName).filter(x => x.length >= 2);
  const free = () => deposits.filter(d => d.type === '입금' && !used.has(d.key));
  const pend = () => orders.filter(o => !o.pay);
  const tryMatch = (test, how) => {
    for (const o of pend()) {
      const ns = names(o);
      const d = free().find(d => d.amt === o.total && test(normName(d.who), ns));
      if (d) { o.dep = d; o.deps = [d]; o.depSum = d.amt; d.order = o; used.add(d.key); o.pay = 'auto'; o.how = how; }
    }
  };
  tryMatch((w, ns) => ns.includes(w), '이름·금액 일치');
  tryMatch((w, ns) => ns.some(n => w.includes(n) || (w.length >= 2 && n.includes(w))), '이름 일부·금액 일치');
  for (const o of orders.filter(o => !o.pay || (o.pay === 'diff' && o.deps.length))) {
    const ns = names(o);
    o.cand = free().filter(d => { const w = normName(d.who); return ns.some(n => w === n || w.includes(n) || n.includes(w)); });
    if (!o.pay) o.pay = o.cand.length ? 'diff' : 'none';
  }
  const unusedDeps = deposits.filter(d => d.type === '입금' && !used.has(d.key));

  const PAID = ['form', 'linked', 'manual', 'auto'];
  const live = orders.filter(o => o.pay !== 'cancel');
  const paid = live.filter(o => PAID.includes(o.pay));

  // 제작 수량
  const extra = T('추가 수량').rows.map(r => ({ row: r.row, r, kind: r.get('구분') || '족자봉', no: toNum(r.get('넘버')), n: toNum(r.get('개수')), who: r.get('대상'), memo: r.get('메모') }));
  const jOrder = {}; live.forEach(o => Object.entries(o.jk).forEach(([n, q]) => { jOrder[n] = (jOrder[n] || 0) + q; }));
  const topNo = Math.max(maxNo, ...Object.keys(jOrder).map(Number), 0);
  const make = [];
  for (let n = 1; n <= topNo; n++) {
    const ex = extra.filter(e => e.kind === '족자봉' && e.no === n);
    const order = jOrder[n] || 0, spare = authorByNo[n] || n <= maxNo ? spareJ : 0, add = ex.reduce((a, e) => a + e.n, 0);
    make.push({ no: n, author: authorByNo[n], order, spare, add, adds: ex, total: order + spare + add });
  }
  const bookOrder = live.reduce((a, o) => a + o.books, 0);
  const bookAuthor = confirmed.length * bookPerAuthor;
  const bookExtra = extra.filter(e => e.kind === '엽서북').reduce((a, e) => a + e.n, 0);

  // 정산
  const income = T('수입').rows.filter(r => r.get('항목') || r.get('금액')).map(r => ({ row: r.row, r, name: r.get('항목'), amt: toNum(r.get('금액')), memo: r.get('메모') }));
  const costs = T('비용').rows.filter(r => r.get('항목') || r.get('단가')).map(r => {
    const unit = toNum(r.get('단가')), n = r.get('개수') === '' ? 1 : toNum(r.get('개수'));
    return { row: r.row, r, name: r.get('항목'), unit, n, amt: unit * n, who: r.get('출금자') || '공금', done: r.get('처리') === '완료', memo: r.get('메모') };
  });
  const preForm = paid.filter(o => o.pay === 'form').reduce((a, o) => a + o.total, 0);
  const preBank = paid.filter(o => o.pay !== 'form').reduce((a, o) => a + o.total, 0);
  const incomeSum = preForm + preBank + income.reduce((a, x) => a + x.amt, 0);
  const costShared = costs.filter(c => c.amt > 0).reduce((a, c) => a + c.amt, 0);
  // 개인 선정산: 개인이 낸 비용(+)과 개인이 공금에서 가져간 돈(-) 중 아직 처리 안 된 것
  const personal = {};
  costs.filter(c => c.who !== '공금' && !c.done).forEach(c => { personal[c.who] = (personal[c.who] || 0) + c.amt; });
  const personalSum = Object.values(personal).reduce((a, b) => a + b, 0);
  const reserveAuto = costs.filter(c => c.who === '공금' && !c.done && c.amt > 0).reduce((a, c) => a + c.amt, 0);
  const balanceIn = cfg['현재 잔고 + 현금'] === undefined || cfg['현재 잔고 + 현금'] === '' ? null : toNum(cfg['현재 잔고 + 현금']);
  const reserve = cfg['남겨둘 금액'] === undefined || cfg['남겨둘 금액'] === '' ? reserveAuto : toNum(cfg['남겨둘 금액']);
  const pool = balanceIn === null ? null : balanceIn - reserve - personalSum;
  const wsum = ratios.reduce((a, x) => a + x.w, 0);
  const people = [...new Set([...ratios.map(x => x.name), ...Object.keys(personal)])].map(name => {
    const w = (ratios.find(x => x.name === name) || {}).w || 0;
    const share = pool === null || !wsum ? 0 : pool * w / wsum;
    return { name, w, share, pre: personal[name] || 0, total: share + (personal[name] || 0) };
  });

  // 통장 흐름 (입금기록이 최신순이든 오래된순이든 상관없게 잔액으로 확인)
  const dIn = deposits.filter(d => d.type === '입금').reduce((a, d) => a + d.amt, 0);
  const dOut = deposits.filter(d => d.type !== '입금').reduce((a, d) => a + d.amt, 0);
  let bankCheck = null;
  if (deposits.length >= 1 && deposits.some(d => d.bal)) {
    const sorted = deposits.slice().sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
    const first = sorted[0], last = sorted[sorted.length - 1];
    const start = first.balN - (first.type === '입금' ? first.amt : -first.amt);
    bankCheck = { start, end: last.balN, calc: start + dIn - dOut };
  }

  return {
    cfg, priceBook, priceJ, spareJ, bookPerAuthor, ratios, authors, confirmed, authorByNo, maxNo, orders, live, paid, deposits, unusedDeps,
    extra, make, bookOrder, bookAuthor, bookExtra, income, costs, preForm, preBank, incomeSum, costShared, personal, personalSum, reserve, reserveAuto,
    balanceIn, pool, people, wsum, dIn, dOut, bankCheck,
  };
}

const PAY = {
  form: ['폼 결제', 'blue'], auto: ['입금 확인', 'green'], linked: ['입금 연결', 'green'], manual: ['수동 확인', 'green'],
  diff: ['확인 필요', 'orange'], none: ['미입금', 'red'], unpaid: ['미입금', 'red'], cancel: ['취소', ''],
};
const payBadge = o => { const [t, c] = PAY[o.pay] || ['?', '']; return `<span class="badge ${c}">${t}</span>`; };
const jBadge = o => o.jState === 'check' ? '<span class="badge orange">족자봉 확인</span>' : o.jState === 'fixed' ? '<span class="badge">고침</span>' : '';

// ---------------------------------------------------------------------
// 검증 목록 (홈, 정산에 같이 보여줘요)
// ---------------------------------------------------------------------
function checks() {
  const m = M(), out = [];
  const add = (lv, t, d, go) => out.push({ lv, t, d, go });
  const diff = m.live.filter(o => o.pay === 'diff'), none = m.live.filter(o => o.pay === 'none' || o.pay === 'unpaid');
  if (!m.orders.length) add('warn', '선입금 리스트가 비어 있어요', '주문 탭에서 위치폼 데이터를 붙여넣어 주세요.', 'orders');
  if (diff.length) add('warn', `입금 확인이 필요한 주문 ${diff.length}건`, '이름은 비슷한데 금액이 다르거나, 이름이 일부만 같아요.', 'match');
  if (none.length) add('bad', `입금이 안 보이는 주문 ${none.length}건`, '통장 내역에 같은 이름의 입금이 없어요.', 'match');
  if (m.unusedDeps.length) add('warn', `주문과 연결 안 된 입금 ${m.unusedDeps.length}건`, '입금자명이 신청서 이름과 다를 수 있어요.', 'match');
  const jc = m.live.filter(o => o.jState === 'check');
  if (jc.length) add('warn', `족자봉 넘버를 확인할 주문 ${jc.length}건`, '적은 넘버 개수가 주문 개수와 다르거나 없는 넘버가 있어요.', 'orders:jokja');
  const money = m.live.filter(o => o.total !== o.expect);
  if (money.length) add('warn', `신청서 금액이 계산과 다른 주문 ${money.length}건`, `엽서북 ${won(m.priceBook)}, 족자봉 ${won(m.priceJ)} 기준으로 계산했어요.`, 'orders:money');
  const qSum = m.live.reduce((a, o) => a + o.qty, 0), jSum = m.live.reduce((a, o) => a + o.jCount, 0);
  if (m.orders.length) add(qSum === jSum ? 'ok' : 'warn', `족자봉 주문 수 ${cnt(qSum)}개 / 넘버로 센 수 ${cnt(jSum)}개`, qSum === jSum ? '신청서 개수와 넘버 개수가 같아요.' : '차이 나는 주문을 주문 탭에서 확인해 주세요.', qSum === jSum ? null : 'orders:jokja');
  if (m.bankCheck) {
    const ok = Math.round(m.bankCheck.calc) === Math.round(m.bankCheck.end);
    add(ok ? 'ok' : 'bad', ok ? '통장 잔액 흐름이 맞아요' : '통장 잔액 흐름이 안 맞아요', `시작 ${won(m.bankCheck.start)} + 입금 ${won(m.dIn)} − 출금 ${won(m.dOut)} = ${won(m.bankCheck.calc)} (통장 마지막 잔액 ${won(m.bankCheck.end)})`, ok ? null : 'match');
  }
  const bankPaid = m.paid.filter(o => o.deps.length).reduce((a, o) => a + o.depSum, 0), bankWant = m.paid.filter(o => o.deps.length).reduce((a, o) => a + o.total, 0);
  if (bankPaid || bankWant) add(bankPaid === bankWant ? 'ok' : 'warn', `연결된 입금 ${won(bankPaid)} / 신청서 기준 ${won(bankWant)}`, bankPaid === bankWant ? '입금액과 신청 금액이 같아요.' : '손으로 연결한 주문 중 금액이 다른 게 있어요.', bankPaid === bankWant ? null : 'match');
  const noSub = m.confirmed.filter(a => a.submit !== '제출 완료');
  if (m.confirmed.length) add(noSub.length ? 'warn' : 'ok', noSub.length ? `원고 제출 안 된 작가 ${noSub.length}명` : '확정 작가 원고가 모두 제출됐어요', noSub.slice(0, 6).map(a => a.nick).join(', ') + (noSub.length > 6 ? ' 외' : ''), noSub.length ? 'authors' : null);
  if (m.ratios.length && m.wsum && m.balanceIn === null) add('warn', '정산할 잔고가 아직 없어요', '설정의 "현재 잔고 + 현금"을 넣으면 분배 금액이 계산돼요.', 'money');
  return out.sort((a, b) => ({ bad: 0, warn: 1, ok: 2 }[a.lv] - { bad: 0, warn: 1, ok: 2 }[b.lv]));
}
const checkList = list => list.length ? `<div class="checks">${list.map(c => `<div class="chk ${c.lv}"><span class="ic">${c.lv === 'ok' ? '✓' : '!'}</span><div><div class="t">${esc(c.t)}</div>${c.d ? `<div class="d">${esc(c.d)}</div>` : ''}</div>${c.go ? `<button class="btn sm go" data-go="${c.go}">보기</button>` : ''}</div>`).join('')}</div>` : '<div class="empty">확인할 게 없어요</div>';

// ---------------------------------------------------------------------
// 화면 그리기
// ---------------------------------------------------------------------
function render() {
  const app = $('#app');
  if (!connected()) { app.innerHTML = topBar(false) + `<main>${viewConnect()}</main>`; drawGoogleButton(); return; }
  let body;
  if (!st.tabs) body = st.err ? `<div class="hello"><div class="note warn"><b>불러오지 못했어요</b><br>${esc(st.err)}</div><div class="acts"><button class="btn pri" data-act="reload">다시 시도</button><button class="btn" data-go="settings">연결 설정</button></div></div>` : '<div class="loading"><div class="spin"></div>시트를 불러오는 중이에요</div>';
  else body = ({ home: viewHome, authors: viewAuthors, orders: viewOrders, match: viewMatch, make: viewMake, money: viewMoney, memo: viewMemo, settings: viewSettings }[st.view] || viewHome)();
  const y = scrollY;
  app.innerHTML = topBar(true) + `<main>${body}</main>`;
  scrollTo(0, y);
  setSync(st.loading || pending ? 'busy' : st.err ? 'err' : 'ok');
}

function topBar(nav) {
  return `<header class="top"><div class="top-in">
    <div class="brand">행사 관리${st.demo ? ' <span class="badge orange">둘러보기</span>' : store.tok && !store.key ? ` <span class="badge">${esc(store.tok.name)}</span>` : store.who ? ` <span class="badge">${esc(store.who)}</span>` : ''}</div>
    ${nav ? `<nav class="tabs" role="tablist">${VIEWS.map(([k, t]) => `<button role="tab" aria-selected="${st.view === k}" data-go="${k}">${t}</button>`).join('')}</nav>
    <div class="sync" id="sync"><i></i><span id="syncT"></span><button data-act="reload">새로고침</button></div>` : ''}
  </div></header>`;
}
function setSync(s) {
  const el = $('#sync'); if (!el) return;
  el.className = 'sync ' + (s === 'busy' ? 'busy' : s === 'err' ? 'err' : '');
  $('#syncT').textContent = s === 'busy' ? (pending ? '저장 중' : '불러오는 중') : s === 'err' ? '연결 오류' : st.at ? st.at.toTimeString().slice(0, 5) + ' 불러옴' : '';
}
// 시트에 저장된 사진 주소가 있으면 그걸, 없으면 unavatar 에서 바로 받아요 (브라우저가 캐시해요)
function avatar(name, pic, cls = '', handle = '') {
  const ini = esc(String(name || '?').replace(/[(（].*$/, '').trim().slice(0, 1).toUpperCase());
  const h = String(handle || '').trim().replace(/^@/, '');
  const src = pic || (/^\w{1,15}$/.test(h) ? `https://unavatar.io/x/${h}?fallback=false` : '');
  return `<span class="av ${cls}">${ini}${src ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" ${pic ? 'data-av' : ''}>` : ''}</span>`;
}
const head = (title, sub, acts = '') => `<div class="head"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="acts">${acts}</div></div>`;
const stat = (k, v, d, cls = '', go = '', pct = null) => `<${go ? 'button' : 'div'} class="stat ${cls}" ${go ? `data-go="${go}"` : ''}><div class="k">${k}</div><div class="v num">${v}</div>${d ? `<div class="d">${d}</div>` : ''}${pct !== null ? `<div class="bar"><i style="width:${Math.min(100, Math.max(0, pct))}%"></i></div>` : ''}</${go ? 'button' : 'div'}>`;

// ---------- 연결 ----------
function viewConnect() {
  const err = st.loginErr ? `<div class="note warn">${esc(st.loginErr)}</div>` : '';
  if (CFG.googleClientId) return `<div class="hello">
    <h1>행사 관리</h1>
    <p>허용된 구글 계정으로 로그인해 주세요.</p>
    ${err}
    <div class="card gbox"><div id="gbtn"></div><p class="hint" style="margin:0">로그인 정보는 이 브라우저에만 남아요. 시트에 접근할 수 있는 계정은 관리자가 정해요.</p></div>
    <div class="card"><h2>먼저 둘러보기</h2><p class="sub">가짜 데이터로 화면을 미리 써볼 수 있어요. 시트에는 아무것도 저장되지 않아요.</p><button class="btn soft" data-act="demo">둘러보기 시작</button>
      <details class="more"><summary>비밀키로 연결하기</summary><div style="margin-top:12px">${connectForm()}</div></details></div>
  </div>`;
  return `<div class="hello">
    <h1>시트와 연결해요</h1>
    <p>관리자에게 받은 연결 링크를 열면 자동으로 연결돼요. 비밀키를 직접 넣어도 돼요.</p>
    ${err}
    <div class="card">${connectForm()}</div>
    <div class="card">
      <h2>처음이라면</h2>
      <ol class="steps">
        <li>새 구글 시트를 만들고 <b>확장 프로그램 → Apps Script</b>를 열어요.</li>
        <li>저장소의 <code>apps-script/Code.gs</code> 내용을 붙여넣고 저장해요.</li>
        <li>시트를 새로고침하면 생기는 <b>관리 사이트 → 처음 설정</b>을 눌러요. 비밀키가 나와요.</li>
        <li><b>배포 → 새 배포 → 웹 앱</b>, 실행 계정 <b>나</b>, 액세스 <b>모든 사용자</b>로 배포해요.</li>
        <li>나온 웹 앱 주소(<code>https://script.google.com/macros/s/…/exec</code>)를 위에 넣어요.</li>
      </ol>
    </div>
    <div class="card"><h2>먼저 둘러보기</h2><p class="sub">가짜 데이터로 화면을 미리 써볼 수 있어요. 시트에는 아무것도 저장되지 않아요.</p><button class="btn soft" data-act="demo">둘러보기 시작</button></div>
  </div>`;
}
function connectForm() {
  return `<div class="fields">
    <div class="field full"><label>웹 앱 주소</label><input class="inp" id="cUrl" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(apiUrl())}" autocomplete="off"></div>
    <div class="field full"><label>비밀키</label><input class="inp" id="cKey" type="password" placeholder="처음 설정 때 나온 키" value="${esc(store.key || '')}" autocomplete="off"></div>
  </div><div class="acts" style="margin-top:14px"><button class="btn pri" data-act="connect">연결하기</button>${store.url ? '<button class="btn danger" data-act="disconnect">이 기기에서 연결 해제</button>' : ''}</div>`;
}

// ---------- 홈 ----------
function viewHome() {
  const m = M();
  const diff = m.live.filter(o => o.pay === 'diff').length, none = m.live.filter(o => ['none', 'unpaid'].includes(o.pay)).length;
  const sub = m.confirmed.filter(a => a.submit === '제출 완료').length;
  const jTotal = m.make.reduce((a, x) => a + x.total, 0), bTotal = m.bookOrder + m.bookAuthor + m.bookExtra;
  return head('홈', st.demo ? '가짜 데이터로 둘러보는 중이에요. 고친 내용은 새로고침하면 사라져요.' : '시트 데이터를 한눈에 봐요.') +
    `<div class="stats">
      ${stat('선입금 주문', cnt(m.live.length) + '<small>건</small>', `입금 완료 ${cnt(m.paid.length)}건`, '', 'orders', m.live.length ? m.paid.length / m.live.length * 100 : 0)}
      ${stat('입금 확인 필요', cnt(diff + none) + '<small>건</small>', `금액·이름 확인 ${diff} · 미입금 ${none}`, diff + none ? 'warn' : 'good', 'match')}
      ${stat('확정 작가', cnt(m.confirmed.length) + '<small>명</small>', `원고 제출 ${sub}명`, '', 'authors', m.confirmed.length ? sub / m.confirmed.length * 100 : 0)}
      ${stat('선입금 금액', won(m.preForm + m.preBank), `폼 결제 ${won(m.preForm)} · 통장 ${won(m.preBank)}`, '', 'money')}
    </div>
    <div class="grid2">
      <div class="card"><h2>확인할 것</h2><p class="sub">시트 데이터를 서로 맞춰본 결과예요.</p>${checkList(checks())}</div>
      <div>
        <div class="card"><div class="card-h"><div><h2>제작 수량</h2></div><button class="btn sm" data-go="make">자세히</button></div>
          <div class="kv"><span>엽서북</span><b class="num">${cnt(bTotal)}권</b></div>
          <div class="kv sub"><span>주문 ${cnt(m.bookOrder)} + 작가 ${cnt(m.bookAuthor)} + 추가 ${cnt(m.bookExtra)}</span><b></b></div>
          <div class="kv"><span>족자봉 (${m.make.length}종)</span><b class="num">${cnt(jTotal)}개</b></div>
          <div class="kv sub"><span>주문 ${cnt(m.make.reduce((a, x) => a + x.order, 0))} + 작가 여분 ${cnt(m.make.reduce((a, x) => a + x.spare, 0))} + 추가 ${cnt(m.make.reduce((a, x) => a + x.add, 0))}</span><b></b></div>
        </div>
        <div class="card"><div class="card-h"><h2>내보내기</h2></div>
          <p class="sub">부스 포스에 넣을 선입금 명단, 책에 넣을 작가 후기를 CSV로 받아요.</p>
          <div class="acts"><button class="btn soft" data-act="exportPos">포스로 내보내기</button><button class="btn" data-act="exportReviews">작가 후기</button></div>
        </div>
      </div>
    </div>`;
}

// ---------- 작가 ----------
function viewAuthors() {
  const m = M();
  const q = normName(st.authorQ);
  let list = st.authorSeg === 'ok' ? m.confirmed : m.authors;
  if (q) list = list.filter(a => normName(a.nick + a.x).includes(q));
  const counts = { all: m.authors.length, ok: m.confirmed.length };
  const sb = s => s === '수락' ? 'green' : s === '거절' ? 'red' : s ? 'orange' : '';
  const sub = s => s === '제출 완료' ? 'green' : s ? 'orange' : 'red';
  const rows = list.map(a => `<tr data-open="author:${a.row}">
      <td class="num muted">${a.no || ''}</td><td><div class="who">${avatar(a.nick, a.pic, '', a.x)}<div><b>${esc(a.nick)}</b><div class="muted" style="font-size:13px">${esc(a.x)}</div></div></div></td>
      <td><span class="badge ${sb(a.status)}">${esc(a.status || '미정')}</span></td>
      ${st.authorSeg === 'ok' ? `<td class="c">${esc(a.discord || '-')}</td><td><span class="badge ${sub(a.submit)}">${esc(a.submit || '미제출')}</span></td><td style="white-space:nowrap">${esc(a.pickup || '-')}</td><td class="rev" title="${esc(a.revKo)}">${esc(a.revKo) || '<span class="muted">-</span>'}</td><td class="rev" title="${esc(a.revJa)}">${esc(a.revJa) || '<span class="muted">-</span>'}</td><td class="muted clip" title="${esc(a.comment)}">${esc(a.comment)}</td>`
      : `<td class="muted clip">${esc(a.r.get('섭외 메모'))}</td>`}
    </tr>`).join('');
  return head('작가', '섭외 수락 여부만 바꾸면 확정 작가 목록에 자동으로 들어가요. 줄을 누르면 고칠 수 있어요.', `<button class="btn" data-act="exportReviews">후기 내보내기</button><button class="btn pri" data-act="newRow" data-tab="작가">작가 추가</button>`) +
    `<div class="tools"><div class="seg">${[['all', '섭외 전체'], ['ok', '확정 작가']].map(([k, t]) => `<button aria-selected="${st.authorSeg === k}" data-seg="authorSeg:${k}">${t} ${counts[k]}</button>`).join('')}</div>
      <input class="search" id="authorQ" placeholder="닉네임, X 아이디 검색" value="${esc(st.authorQ)}"></div>
    <div class="tbl-wrap">${list.length ? `<table class="tbl"><thead><tr><th>No</th><th>작가</th><th>수락</th>${st.authorSeg === 'ok' ? '<th class="c">디스코드</th><th>원고</th><th>현장 수령</th><th>후기 (한)</th><th>후기 (일)</th><th>코멘트</th>' : '<th>섭외 메모</th>'}</tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">작가가 없어요</div>'}</div>`;
}

// ---------- 주문 ----------
const ORDER_FILTERS = [
  ['all', '전체', o => o.pay !== 'cancel'], ['check', '입금 확인 필요', o => ['diff', 'none', 'unpaid'].includes(o.pay)],
  ['jokja', '족자봉 확인', o => o.jState === 'check'], ['money', '금액 다름', o => o.pay !== 'cancel' && o.total !== o.expect],
  ['paid', '입금 완료', o => ['form', 'auto', 'linked', 'manual'].includes(o.pay)], ['cancel', '취소', o => o.pay === 'cancel'],
];
function viewOrders() {
  const m = M();
  const [, , fn] = ORDER_FILTERS.find(f => f[0] === st.orderFilter) || ORDER_FILTERS[0];
  const q = normName(st.orderQ);
  let list = m.orders.filter(fn);
  if (q) list = list.filter(o => normName([o.nick, o.name, o.payer, o.recv, o.id, o.phone].join(' ')).includes(q) || String(o.phone).replace(/\D/g, '').endsWith(q));
  const rows = list.map(o => `<tr data-open="order:${esc(o.id)}">
      <td class="num muted">${esc(o.num)}</td><td><b>${esc(o.nick || o.name)}</b><div class="muted" style="font-size:13px">${esc(o.name)}${o.payer && o.payer !== o.name ? ' · 입금 ' + esc(o.payer) : ''}</div></td>
      <td class="r num">${o.books || '-'}</td><td>${jokjaChips(o.jk)} ${jBadge(o)}</td>
      <td class="r num">${won(o.total)}${o.total !== o.expect ? `<div style="font-size:12px;color:var(--orange)">계산 ${won(o.expect)}</div>` : ''}</td><td>${payBadge(o)}</td>
    </tr>`).join('');
  return head('주문', `위치폼 선입금 ${cnt(m.orders.length)}건. 줄을 누르면 족자봉 넘버와 입금 처리를 고칠 수 있어요.`, `<button class="btn" data-act="exportPos">포스로 내보내기</button><button class="btn pri" data-act="paste" data-tab="선입금 리스트">선입금 데이터 넣기</button>`) +
    `<div class="chips">${ORDER_FILTERS.map(([k, t, f]) => `<button class="chip" aria-pressed="${st.orderFilter === k}" data-seg="orderFilter:${k}">${t} <b>${m.orders.filter(f).length}</b></button>`).join('')}</div>
    <div class="tools"><input class="search" id="orderQ" placeholder="이름, 닉네임, 입금자명, 전화번호 뒷자리, 주문번호" value="${esc(st.orderQ)}"></div>
    <div class="tbl-wrap">${list.length ? `<table class="tbl"><thead><tr><th>번호</th><th>주문자</th><th class="r">엽서북</th><th>족자봉</th><th class="r">금액</th><th>입금</th></tr></thead><tbody>${rows}</tbody></table>` : `<div class="empty">${m.orders.length ? '조건에 맞는 주문이 없어요' : '아직 선입금 데이터가 없어요. 오른쪽 위 버튼으로 넣어 주세요.'}</div>`}</div>`;
}

// ---------- 입금 대조 ----------
function viewMatch() {
  const m = M();
  const need = m.live.filter(o => ['diff', 'none', 'unpaid'].includes(o.pay));
  const auto = m.live.filter(o => ['auto', 'linked'].includes(o.pay));
  const bankOrders = m.live.filter(o => o.pay !== 'form');
  return head('입금 대조', '통장 입금자명과 금액으로 주문을 자동으로 연결해요. 안 맞는 것만 손으로 확인하면 돼요.', `<button class="btn pri" data-act="paste" data-tab="입금기록">통장 내역 넣기</button>`) +
    `<div class="stats">
      ${stat('통장 입금 주문', cnt(bankOrders.length) + '<small>건</small>', '폼 결제 제외')}
      ${stat('자동·수동 연결', cnt(auto.length + m.live.filter(o => o.pay === 'manual').length) + '<small>건</small>', '', 'good')}
      ${stat('확인 필요', cnt(need.length) + '<small>건</small>', '', need.length ? 'warn' : 'good')}
      ${stat('남은 입금', cnt(m.unusedDeps.length) + '<small>건</small>', won(m.unusedDeps.reduce((a, d) => a + d.amt, 0)), m.unusedDeps.length ? 'warn' : '')}
    </div>
    <div class="card"><div class="card-h"><div><h2>확인이 필요한 주문</h2><p class="sub" style="margin:2px 0 0">비슷한 입금이 있으면 바로 연결할 수 있어요.</p></div></div>
      ${need.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>주문자</th><th class="r">신청 금액</th><th>상태</th><th>비슷한 입금</th><th></th></tr></thead><tbody>${need.map(o => `<tr>
        <td><b>${esc(o.payer || o.name)}</b><div class="muted" style="font-size:13px">${esc(o.nick)} · ${esc(o.num)}번</div></td>
        <td class="r num">${won(o.total)}${o.deps.length ? `<div style="font-size:12px;color:var(--orange)">연결 ${won(o.depSum)}</div>` : ''}</td><td>${payBadge(o)}</td>
        <td>${(o.cand || []).slice(0, 3).map(d => `<button class="btn sm soft" data-link="${esc(o.id)}" data-dep="${esc(d.key)}">${esc(d.who)} ${won(d.amt)}</button>`).join(' ') || '<span class="muted">-</span>'}</td>
        <td class="r"><button class="btn sm" data-open="order:${esc(o.id)}">처리</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">모두 확인됐어요 🎉</div>'}
    </div>
    <div class="card"><div class="card-h"><div><h2>주문과 연결 안 된 입금</h2><p class="sub" style="margin:2px 0 0">입금자명이 신청서와 다르면 여기 남아요. 눌러서 주문에 연결해요.</p></div></div>
      ${m.unusedDeps.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>입금 일시</th><th>입금자명</th><th class="r">금액</th><th>메모</th></tr></thead><tbody>${m.unusedDeps.map(d => `<tr data-open="dep:${esc(d.key)}"><td class="num muted">${esc(d.at)}</td><td><b>${esc(d.who)}</b></td><td class="r num">${won(d.amt)}</td><td class="muted">${esc(d.memo)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">남은 입금이 없어요</div>'}
    </div>
    <div class="card"><div class="card-h"><div><h2>자동으로 연결된 입금</h2><p class="sub" style="margin:2px 0 0">틀린 게 있으면 주문을 눌러 연결을 풀 수 있어요.</p></div></div>
      ${auto.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>주문자</th><th>입금자명</th><th class="r">금액</th><th>방법</th></tr></thead><tbody>${auto.map(o => `<tr data-open="order:${esc(o.id)}"><td><b>${esc(o.payer || o.name)}</b> <span class="muted">${esc(o.nick)}</span></td><td>${o.deps.map(d => esc(d.who)).join(' + ')}</td><td class="r num">${won(o.depSum)}</td><td class="muted">${o.pay === 'linked' ? '손으로 연결' : esc(o.how)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">아직 없어요</div>'}
    </div>`;
}

// ---------- 제작 수량 ----------
function viewMake() {
  const m = M();
  const sum = k => m.make.reduce((a, x) => a + x[k], 0);
  const bTotal = m.bookOrder + m.bookAuthor + m.bookExtra;
  return head('제작 수량', `족자봉 넘버별로 주문 + 작가 여분(${m.spareJ}개) + 추가 수량을 더했어요.`, `<button class="btn" data-act="exportMake">CSV로 받기</button><button class="btn pri" data-act="newRow" data-tab="추가 수량">추가 수량 넣기</button>`) +
    `<div class="stats">
      ${stat('족자봉 전체', cnt(sum('total')) + '<small>개</small>', `${m.make.length}종`)}
      ${stat('주문', cnt(sum('order')) + '<small>개</small>')}
      ${stat('엽서북 전체', cnt(bTotal) + '<small>권</small>', `주문 ${cnt(m.bookOrder)} + 작가 ${cnt(m.bookAuthor)} + 추가 ${cnt(m.bookExtra)}`)}
      ${stat('확정 작가', cnt(m.confirmed.length) + '<small>명</small>', `작가 1명당 엽서북 ${m.bookPerAuthor}권`)}
    </div>
    <div class="grid2">
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>넘버</th><th>작가</th><th class="r">주문</th><th class="r">여분</th><th class="r">추가</th><th class="r">최종</th></tr></thead><tbody>
        ${m.make.map(x => `<tr><td class="num"><b>${jName(x.no)}</b></td><td>${x.author ? `<div class="who">${avatar(x.author.nick, x.author.pic, 'sm', x.author.x)}${esc(x.author.nick)}</div>` : '<span class="badge orange">작가 없음</span>'}</td><td class="r num">${x.order}</td><td class="r num muted">${x.spare}</td><td class="r num ${x.add ? '' : 'muted'}" title="${esc(x.adds.map(e => e.who + ' ' + e.n).join(', '))}">${x.add}</td><td class="r num"><b>${x.total}</b></td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="2">합계</td><td class="r num">${sum('order')}</td><td class="r num">${sum('spare')}</td><td class="r num">${sum('add')}</td><td class="r num">${sum('total')}</td></tr></tfoot></table></div>
      <div>${listCard('추가 수량', '하치 1개, 밀키봇 엽서북 2권처럼 주문 밖에서 더 만드는 수량이에요.', ['구분', '넘버', '개수', '대상', '메모'])}</div>
    </div>`;
}

// ---------- 정산 ----------
function viewMoney() {
  const m = M();
  const incomeList = `<div class="kv"><span>선입금 · 폼 결제</span><b class="num">${won(m.preForm)}</b></div><div class="kv"><span>선입금 · 통장 입금 확인</span><b class="num">${won(m.preBank)}</b></div>` +
    m.income.map(x => `<div class="kv"><span>${esc(x.name)}</span><b class="num">${won(x.amt)}</b></div>`).join('') + `<div class="kv total"><span>수입 합계</span><b class="num">${won(m.incomeSum)}</b></div>`;
  const dist = m.balanceIn === null
    ? `<div class="note warn"><b>현재 잔고 + 현금</b>을 설정에 넣으면 분배 금액을 계산해요.</div><button class="btn soft" data-go="settings">설정에서 넣기</button>`
    : `<div class="kv"><span>현재 잔고 + 현금</span><b class="num">${won(m.balanceIn)}</b></div>
       <div class="kv minus"><span>남겨둘 금액 ${m.cfg['남겨둘 금액'] ? '' : '(공금 미처리 비용)'}</span><b class="num">${won(-m.reserve)}</b></div>
       <div class="kv minus"><span>개인 선정산 합계</span><b class="num">${won(-m.personalSum)}</b></div>
       <div class="kv total"><span>분배할 금액</span><b class="num">${won(m.pool)}</b></div>`;
  st.distHtml = `<h4 style="margin:4px 0 2px">분배</h4><p class="hint" style="margin:0 0 6px">${esc(m.ratios.map(r => r.name + ' ' + r.w).join(' : ') || '설정에서 분배 비율을 넣어 주세요')}</p>${dist}
    <h4 style="margin:22px 0 2px">사람별 받을 돈</h4><p class="hint" style="margin:0 0 6px">분배 금액 + 개인 선정산</p>
    ${m.people.length ? m.people.map(p => `<div class="kv"><span>${esc(p.name)}${p.w ? ` <span class="muted">(${p.w})</span>` : ''}</span><b class="num">${won(p.total)}</b></div><div class="kv sub"><span>분배 ${won(p.share)} · 선정산 ${won(p.pre)}</span><b></b></div>`).join('') : '<div class="empty">아직 없어요</div>'}`;
  const nPre = Object.keys(m.personal).length;
  return head('정산', '비용은 누구나 추가할 수 있어요. 분배 금액은 관리자만 볼 수 있어요.', `${st.admin ? '<button class="btn soft" data-act="dist">분배 · 받을 돈 보기</button>' : ''}<button class="btn" data-act="newRow" data-tab="수입">수입 추가</button><button class="btn pri" data-act="newRow" data-tab="비용">비용 추가</button>`) +
    `<div class="grid2">
      <div class="card"><h2>수입</h2><p class="sub">선입금은 입금 대조 결과로 자동 계산해요.</p>${incomeList}</div>
      <div class="card"><h2>비용</h2><p class="sub">아래 비용 목록을 합친 값이에요.</p>
        <div class="kv"><span>공동 비용 합계</span><b class="num">${won(m.costShared)}</b></div>
        <div class="kv"><span>공금 미처리 비용</span><b class="num">${won(m.reserveAuto)}</b></div>
        <div class="kv"><span>개인 선정산 대상</span><b class="num">${nPre}명</b></div>
        ${st.admin ? '<button class="btn soft" data-act="dist" style="margin-top:12px">분배 · 받을 돈 보기</button>' : ''}
      </div>
    </div>
    ${listCard('비용', `줄을 누르면 고쳐요. 출금자가 공금이 아니고 처리가 "완료"가 아니면 개인 선정산에 들어가요. 개인이 공금에서 가져간 돈은 단가를 마이너스로 적어요. 공동 비용 합계 ${won(m.costShared)}`, ['항목', '단가', '개수', '금액', '출금자', '처리', '메모'], { amount: true })}
    ${listCard('수입', '현장 판매처럼 선입금 말고 들어온 돈이에요.', ['항목', '금액', '메모'])}
    <div class="card"><h2>검증</h2><p class="sub">작년 "최종 정산" 시트의 검증용 데이터를 자동으로 맞춰봐요.</p>${checkList(checks())}</div>`;
}

// ---------- 예외기록 ----------
function viewMemo() {
  return head('예외기록', '추가 구매, 입금자명 변경, 수동 환불 같은 예외를 적어둬요.', `<button class="btn pri" data-act="newRow" data-tab="예외기록">기록 추가</button>`) +
    listCard('예외기록', '', ['날짜', '대상', '내용', '상태'], { bare: true });
}

// ---------- 설정 ----------
function viewSettings() {
  return head('설정', '') +
    `<div class="grid2"><div>${listCard('설정', '가격, 작가 여분, 분배 비율 같은 값이에요. 시트의 "설정" 탭과 같아요.', ['항목', '값', '설명'])}</div>
    <div>
      <div class="card"><h2>연결</h2><p class="sub">${st.demo ? '지금은 둘러보기 모드예요.' : '이 브라우저에만 저장돼요. 다른 사람 기기에서 쓰면 꼭 연결 해제해 주세요.'}</p>
        ${st.demo ? '<button class="btn pri" data-act="exitDemo">둘러보기 끝내고 연결하기</button>' : useGoogle() && store.tok ? `<div class="me">${avatar(store.tok.name, store.tok.pic)}<div><b>${esc(store.tok.name)}</b><div class="hint">${esc(store.tok.email)}</div></div></div><div class="acts" style="margin-top:14px"><button class="btn danger" data-act="signOut">로그아웃</button></div>` : connectForm()}</div>
      ${st.demo || !CFG.googleClientId ? '' : emailsCard()}
      ${st.demo ? '' : `<div class="card"><h2>테스트 데이터</h2><p class="sub">작년 데이터로 연습해보고, 끝나면 초기화로 날려요. 작가, 정산, 설정 탭은 건드리지 않아요.</p>
        <div class="kv"><span>작년 선입금 주문 (164건)</span><b><button class="btn sm soft" data-act="sample" data-which="orders">불러오기</button></b></div>
        <div class="kv"><span>작년 통장 입금내역 (89건)</span><b><button class="btn sm soft" data-act="sample" data-which="deposits">불러오기</button></b></div>
        <div class="kv"><span>선입금 내역 초기화<br><small class="muted">선입금 리스트 + 주문 처리(입금 연결, 족자봉 고침)</small></span><b><button class="btn sm danger" data-act="reset" data-which="orders">초기화</button></b></div>
        <div class="kv"><span>입금내역 초기화<br><small class="muted">입금기록 탭</small></span><b><button class="btn sm danger" data-act="reset" data-which="deposits">초기화</button></b></div></div>`}
      ${st.demo || useGoogle() ? '' : `<div class="card"><h2>동료에게 주기</h2><p class="sub">시트 메뉴 <b>관리 사이트 → 동료 추가</b>를 누르면 그 사람 전용 링크가 나와요. 링크를 한 번 열면 자동으로 연결되고, 누가 고쳤는지도 남아요. 한 명만 끊을 수도 있어요.</p>
        <div class="acts"><button class="btn soft" data-act="copyLink">내 연결 링크 복사</button></div><p class="hint" style="margin:8px 0 0">내 다른 기기(아이패드, 폰)에서 열 때 쓰세요. 이 링크는 내 키라서 남에게 주면 안 돼요.</p></div>`}
      <div class="card"><h2>원본 데이터 넣기</h2><p class="sub">위치폼 엑셀, 통장 내역을 복사해서 붙여넣거나 CSV 파일을 골라요. 그 탭은 통째로 바뀌고, 사이트에서 처리한 내용(입금 연결, 족자봉 고침)은 주문번호로 그대로 남아요.</p>
        <div class="acts"><button class="btn soft" data-act="paste" data-tab="선입금 리스트">선입금 리스트</button><button class="btn soft" data-act="paste" data-tab="입금기록">입금기록</button></div></div>
      <div class="card"><h2>테마</h2><div class="seg">${[['', '자동'], ['light', '밝게'], ['dark', '어둡게']].map(([k, t]) => `<button aria-selected="${(store.theme || '') === k}" data-theme-set="${k}">${t}</button>`).join('')}</div></div>
    </div></div>`;
}

// ---------- 로그인 허용 계정 ----------
function emailsCard() {
  if (!st.emails) { if (!st.emailsLoading) loadEmails(); return '<div class="card"><h2>로그인 허용 계정</h2><div class="loading" style="min-height:80px"><div class="spin"></div></div></div>'; }
  const e = st.emails;
  return `<div class="card"><h2>로그인 허용 계정</h2><p class="sub">이 구글 계정들만 사이트에 로그인할 수 있어요.${e.canEdit ? '' : ' 바꾸는 건 시트 주인만 할 수 있어요.'}</p>
    <div class="kv"><span>${esc(e.owner)}</span><b><span class="badge blue">시트 주인</span></b></div>
    ${(e.fixed || []).map(x => `<div class="kv"><span>${esc(x)}</span><b><span class="badge">코드에 고정</span></b></div>`).join('')}
    ${e.list.map(x => `<div class="kv"><span>${esc(x)}</span><b>${e.canEdit ? `<button class="btn sm danger" data-email-del="${esc(x)}">빼기</button>` : ''}</b></div>`).join('')}
    ${e.canEdit ? `<div class="tools" style="margin:12px 0 0"><input class="inp" id="newEmail" type="email" placeholder="friend@gmail.com" style="flex:1;min-width:180px"><button class="btn pri" data-act="emailAdd">추가</button></div>` : ''}
  </div>`;
}
async function loadEmails() {
  st.emailsLoading = true;
  try { const j = await api('emails'); st.emails = j; } catch (e) { st.emails = { list: [], owner: '?', canEdit: false, err: e.message }; }
  st.emailsLoading = false; render();
}
async function saveEmails(list) {
  setSync('busy');
  try { const j = await api('setEmails', { list }); st.emails = { ...st.emails, list: j.list }; toast('저장했어요'); setSync('ok'); }
  catch (e) { toast(e.message, true); setSync('err'); }
  render();
}

// ---------------------------------------------------------------------
// 일반 표 카드 (비용, 수입, 추가 수량, 예외기록, 설정)
// ---------------------------------------------------------------------
function listCard(tab, sub, cols, opt = {}) {
  const t = T(tab);
  const rows = t.rows.filter(r => r.raw.some(v => String(v).trim()));
  const money = c => ['단가', '금액'].includes(c);
  const cell = (r, c) => {
    if (c === '금액' && opt.amount) { const u = toNum(r.get('단가')), n = r.get('개수') === '' ? 1 : toNum(r.get('개수')); return `<td class="r num">${won(u * n)}</td>`; }
    const v = r.get(c);
    if (c === '처리') return `<td><span class="badge ${v === '완료' ? 'green' : 'orange'}">${esc(v || '미완료')}</span></td>`;
    if (money(c)) return `<td class="r num">${v === '' ? '' : won(toNum(v))}</td>`;
    if (['개수', '넘버'].includes(c)) return `<td class="r num">${esc(v)}</td>`;
    return `<td class="${['메모', '설명', '내용'].includes(c) ? 'muted clip' : ''}">${esc(v)}</td>`;
  };
  const table = rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr>${cols.map(c => `<th class="${money(c) || ['개수', '넘버'].includes(c) ? 'r' : ''}">${c}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr data-open="row:${esc(tab)}:${r.row}">${cols.map(c => cell(r, c)).join('')}</tr>`).join('')}</tbody></table></div>` : '<div class="empty">아직 없어요</div>';
  if (opt.bare) return table;
  return `<div class="card"><div class="card-h"><div><h2>${esc(tab)}</h2>${sub ? `<p class="sub" style="margin:2px 0 0">${sub}</p>` : ''}</div><button class="btn sm" data-act="newRow" data-tab="${esc(tab)}">추가</button></div>${table}</div>`;
}

// ---------------------------------------------------------------------
// 모달
// ---------------------------------------------------------------------
let modalSave = null, modalUnlink = null;
function openModal({ title, sub = '', body, foot, wide = false, onSave = null }) {
  closeModal();
  const d = document.createElement('div');
  d.className = 'dim'; d.id = 'dim';
  d.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true"><div class="m-h"><div><h3>${title}</h3>${sub ? `<p>${sub}</p>` : ''}</div><button class="m-x" data-act="close" aria-label="닫기">✕</button></div><div class="m-b">${body}</div>${foot ? `<div class="m-f">${foot}</div>` : ''}</div>`;
  document.body.appendChild(d);
  modalSave = onSave;
  const f = d.querySelector('input:not([type=hidden]),textarea,select'); if (f && innerWidth > 600) f.focus();
}
function closeModal() { const d = $('#dim'); if (d) d.remove(); modalSave = null; }

const LONG = ['후기 (한)', '후기 (일)', '섭외 메모', '기타', '주소', '메모', '내용', '설명'];
const SUGGEST = {
  '수락 여부': ['수락', '대기', '보류', '거절'], '디스코드': ['O', 'X'], '제출 여부': ['제출 완료', '연장', '미제출'], '현장 수령': ['O (퍼클)', 'O', 'X'],
  '출금자': ['공금'], '처리': ['완료', '미완료'], '구분': ['족자봉', '엽서북'], '상태': ['확인 필요', '처리 완료'],
};
function rowForm(tab, rowNo) {
  const t = T(tab);
  const r = rowNo ? t.rows.find(x => x.row === rowNo) : null;
  const cols = t.header.length ? t.header.filter(Boolean) : [];
  const fields = cols.map((c, i) => {
    const v = r ? String(r.raw[i] ?? '') : (c === 'No' && tab === '작가' ? '' : c === '처리' ? '미완료' : c === '출금자' ? '공금' : c === '개수' ? '1' : '');
    const opts = [...new Set([...(SUGGEST[c] || []), ...t.rows.map(x => x.get(c)).filter(x => x && x.length < 30)])].slice(0, 30);
    const id = 'f' + i;
    const input = LONG.includes(c) ? `<textarea class="inp" data-col="${esc(c)}" id="${id}">${esc(v)}</textarea>` :
      `<input class="inp" data-col="${esc(c)}" id="${id}" value="${esc(v)}" autocomplete="off" ${['단가', '금액', '개수', '넘버', 'No'].includes(c) ? 'inputmode="numeric"' : ''}>${opts.length ? `<div class="picks">${opts.slice(0, 8).map(o => `<button type="button" class="pick ${o === v ? 'on' : ''}" data-pick-for="${id}" data-pick="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}`;
    return `<div class="field ${LONG.includes(c) ? 'full' : ''}"><label for="${id}">${esc(c)}</label>${input}</div>`;
  }).join('');
  const hint = tab === '작가' ? '<p class="hint">수락 여부를 "수락"으로 바꾸면 확정 작가에 들어가요. No는 족자봉 넘버예요. (1 = A, 2 = B …)</p>' :
    tab === '비용' ? '<p class="hint">공금에서 개인 용도로 쓴 돈은 단가를 마이너스(-)로 적어요.</p>' :
    tab === '설정' ? '<p class="hint">분배 비율은 "이름 비율, 이름 비율" 형식이에요. 예: 잏엫 5, 하치 4, 라굴 1</p>' : '';
  const match = r ? { [cols[0]]: String(r.raw[0] ?? '') } : null;
  openModal({
    title: r ? `${esc(tab)} 고치기` : `${esc(tab)} 추가`, body: `<div class="fields">${fields}</div>${hint}`,
    foot: `${r ? '<button class="btn danger" data-act="delRow">삭제</button>' : ''}<span class="sp"></span><button class="btn" data-act="close">취소</button><button class="btn pri" data-act="save">저장</button>`,
    onSave: async (act) => {
      if (act === 'del') {
        if (!confirm('이 줄을 시트에서 지울까요?')) return;
        if (await write('remove', { sheet: tab, row: r.row, match }, '지웠어요')) closeModal();
        return;
      }
      const values = {};
      document.querySelectorAll('#dim [data-col]').forEach(el => {
        const c = el.dataset.col, i = cols.indexOf(c);
        if (!r || String(r.raw[i] ?? '') !== el.value) values[c] = el.value;
      });
      if (!r && tab === '작가' && values['수락 여부'] === '수락' && !values['No']) values['No'] = String(M().maxNo + 1);
      if (r && tab === '작가' && values['수락 여부'] === '수락' && !r.get('No') && !values['No']) values['No'] = String(M().maxNo + 1);
      if (!Object.keys(values).length) { closeModal(); return; }
      const ok = r ? await write('update', { sheet: tab, row: r.row, values, match }, '저장했어요') : await write('append', { sheet: tab, values }, '추가했어요');
      if (ok) closeModal();
    },
  });
}

function orderModal(id) {
  const m = M(), o = m.orders.find(x => x.id === id);
  if (!o) return;
  const unlinked = new Set();
  modalUnlink = k => { unlinked.add(k); const b = document.querySelector(`[data-unlink="${CSS.escape(k)}"]`); if (b) { b.textContent = '저장하면 풀려요'; b.disabled = true; } };
  const opts = m.unusedDeps.map(d => `<option value="${esc(d.key)}">${esc(d.who)} · ${won(d.amt)} · ${esc(d.at)}</option>`).join('');
  const manual = o.pay !== 'auto' && o.deps.length;
  const info = [['닉네임', o.nick], ['주문자', o.name], ['입금자(환불예금주)', o.payer], ['수령자', o.recv], ['연락처', o.phone], ['수령 방법', o.method], ['주문번호', o.id], ['폼 진행상태', o.formStatus]]
    .map(([k, v]) => `<div class="kv"><span>${k}</span><b>${esc(v || '-')}</b></div>`).join('');
  openModal({
    title: esc(o.nick || o.name), sub: `${esc(o.num)}번 주문 · 엽서북 ${o.books} · 족자봉 ${o.qty} · ${won(o.total)}`, wide: true,
    body: `<div class="grid2"><div>
        <h4 style="margin:4px 0 6px">족자봉</h4>
        <div class="raw">${esc(o.text || '(적은 내용 없음)')}</div>
        <div class="kv"><span>자동으로 읽은 넘버</span><b>${jokjaChips(o.parsed)}</b></div>
        <div class="kv"><span>신청 개수 / 읽은 개수</span><b class="num" style="${sumObj(o.parsed) !== o.qty ? 'color:var(--orange)' : ''}">${o.qty} / ${sumObj(o.parsed)}</b></div>
        ${o.bad.length ? `<div class="note warn">없는 넘버: ${o.bad.map(jName).join(', ')}</div>` : ''}
        <div class="field" style="margin-top:8px"><label for="oJ">확정 넘버 (고칠 때만)</label><input class="inp" id="oJ" placeholder="${jAlpha ? '예: A, C×2, F' : '예: 2, 7×2, 18'}" value="${esc(o.proc.j || '')}"><span class="hint">비워두면 자동으로 읽은 값을 써요.</span></div>
        <h4 style="margin:18px 0 6px">주문 정보</h4>${info}
      </div><div>
        <h4 style="margin:4px 0 6px">입금</h4>
        <div class="kv"><span>지금 상태</span><b>${payBadge(o)}</b></div>
        ${o.deps.map(d => `<div class="kv"><span>${esc(d.who)} · ${won(d.amt)}<br><small class="muted">${esc(d.at)}${o.how ? ' · ' + esc(o.how) : ''}</small></span><b>${manual ? `<button class="btn sm" data-unlink="${esc(d.key)}">연결 풀기</button>` : ''}</b></div>`).join('')}
        ${o.deps.length > 1 || (o.deps.length && o.depSum !== o.total) ? `<div class="kv"><span>연결된 입금 합계</span><b class="num" style="${o.depSum !== o.total ? 'color:var(--orange)' : ''}">${won(o.depSum)} / ${won(o.total)}</b></div>` : ''}
        <div class="field" style="margin-top:8px"><label for="oPay">입금 처리</label><select class="inp" id="oPay">
          ${[['', '자동 (폼 상태·통장 대조)'], ['확인', '입금 확인 (통장 밖에서 받음)'], ['미입금', '미입금으로 표시'], ['취소', '주문 취소·환불']].map(([v, t]) => `<option value="${v}" ${o.proc.pay === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select></div>
        <div class="field" style="margin-top:12px"><label for="oDep">입금 연결</label><select class="inp" id="oDep"><option value="">${o.pay === 'auto' ? '자동 연결 그대로' : o.deps.length ? '더 연결 안 함' : '연결 안 함'}</option>${opts}</select><span class="hint">입금자명이 다르거나 나눠서 입금했을 때 골라요. 여러 건 연결할 수 있어요.</span></div>
        <div class="field" style="margin-top:12px"><label for="oMemo">메모</label><textarea class="inp" id="oMemo">${esc(o.proc.memo || '')}</textarea></div>
      </div></div>`,
    foot: `<span class="sp"></span><button class="btn" data-act="close">닫기</button><button class="btn pri" data-act="save">저장</button>`,
    onSave: async () => {
      const j = $('#oJ').value.trim(), pay = $('#oPay').value, dep = $('#oDep').value, memo = $('#oMemo').value;
      const keys = (o.pay === 'auto' ? [] : o.deps.map(d => d.key).filter(k => !unlinked.has(k)));
      if (dep) { if (o.pay === 'auto') keys.push(o.dep.key); keys.push(dep); }
      const values = { '족자봉 확정': j ? jokjaText(parseJokja(j)) : '', '입금 처리': pay, '입금 키': keys.join('\n'), '메모': memo, '수정 시각': new Date().toLocaleString('ko-KR') };
      if (await write('upsert', { sheet: '주문 처리', keyCol: '주문번호', keyVal: o.id, values }, '저장했어요')) closeModal();
    },
  });
}

function depModal(key) {
  const m = M(), d = m.deposits.find(x => x.key === key);
  if (!d) return;
  const left = o => o.total - o.depSum;
  const near = m.live.filter(o => !['form', 'auto', 'linked', 'manual'].includes(o.pay)).sort((a, b) => (Math.abs(left(a) - d.amt) - Math.abs(left(b) - d.amt)));
  openModal({
    title: `${esc(d.who)} · ${won(d.amt)}`, sub: esc(d.at + (d.bank ? ' · ' + d.bank : '')),
    body: `<div class="field"><label for="dO">연결할 주문</label><select class="inp" id="dO"><option value="">골라 주세요</option>${near.map(o => `<option value="${esc(o.id)}">${esc(o.payer || o.name)} (${esc(o.nick)}) · ${won(o.total)}${o.depSum ? ' (남은 ' + won(left(o)) + ')' : ''}${left(o) === d.amt ? ' · 금액 같음' : ''}</option>`).join('')}</select>
      <span class="hint">아직 입금 확인 안 된 주문만 보여요. 금액이 가까운 순서예요.</span></div>`,
    foot: `<span class="sp"></span><button class="btn" data-act="close">취소</button><button class="btn pri" data-act="save">연결</button>`,
    onSave: async () => { const id = $('#dO').value; if (!id) return toast('주문을 골라 주세요', true); if (await linkDep(id, key)) closeModal(); },
  });
}
function linkDep(id, key) {
  const o = M().orders.find(x => x.id === id);
  const keys = o && o.pay !== 'auto' ? o.deps.map(d => d.key) : o && o.dep ? [o.dep.key] : [];
  if (!keys.includes(key)) keys.push(key);
  return write('upsert', { sheet: '주문 처리', keyCol: '주문번호', keyVal: id, values: { '입금 키': keys.join('\n'), '입금 처리': '', '수정 시각': new Date().toLocaleString('ko-KR') } }, '연결했어요');
}

// ---------------------------------------------------------------------
// 원본 붙여넣기 (위치폼 / 통장)
// ---------------------------------------------------------------------
const NEED = { '선입금 리스트': ['주문번호', '진행상태'], '입금기록': ['적요', '거래 금액'] };
function parseTable(text) {
  text = String(text).replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const sep = firstLine.includes('\t') || (text.includes('\t') && !firstLine.includes(',')) ? '\t' : ',';
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"' && f === '') q = true;
    else if (c === sep) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim() !== ''));
}
function pasteModal(tab) {
  const need = NEED[tab];
  openModal({
    title: `${tab} 넣기`, wide: true,
    sub: tab === '입금기록' ? '은행 앱에서 받은 거래내역(엑셀)을 통째로 복사해서 붙여넣어요.' : '위치폼에서 받은 엑셀을 열고 전체 선택(⌘A) → 복사해서 붙여넣어요.',
    body: `<div class="note"><b>${tab}</b> 탭 내용이 통째로 바뀌어요. 첫 줄 위에 제목 줄이 있어도 괜찮아요. 꼭 있어야 하는 열: ${need.map(n => `<code>${n}</code>`).join(' ')}</div>
      <textarea class="inp" id="pTxt" style="min-height:220px;font-size:13px" placeholder="여기에 붙여넣기"></textarea>
      <div class="acts" style="margin-top:10px"><button class="btn sm" data-act="pickFile">CSV 파일 고르기</button><span class="hint" id="pInfo"></span></div>`,
    foot: `<span class="sp"></span><button class="btn" data-act="close">취소</button><button class="btn pri" data-act="save">시트에 저장</button>`,
    onSave: async () => {
      const rows = parseTable($('#pTxt').value);
      const hi = rows.findIndex(r => need.every(n => r.map(x => String(x).trim()).includes(n)));
      if (hi < 0) return toast(`${need.join(', ')} 열이 있는 줄을 못 찾았어요`, true);
      let data = rows.slice(hi);
      if (tab === '선입금 리스트') data = [data[0], ...data.slice(1).filter(r => r[colIdx(data[0], '주문번호')] || r[colIdx(data[0], '번호')])];
      if (!confirm(`${tab}에 ${data.length - 1}줄을 저장할까요? 지금 탭 내용은 지워져요.`)) return;
      if (await write('replace', { sheet: tab, rows: data }, `${data.length - 1}줄을 저장했어요`)) closeModal();
    },
  });
  $('#pTxt').addEventListener('input', () => {
    const rows = parseTable($('#pTxt').value), hi = rows.findIndex(r => need.every(n => r.map(x => String(x).trim()).includes(n)));
    $('#pInfo').textContent = rows.length ? (hi < 0 ? `${rows.length}줄 · 필요한 열을 못 찾았어요` : `${rows.length - hi - 1}줄을 찾았어요`) : '';
  });
}
async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { try { return new TextDecoder('euc-kr').decode(buf); } catch { return new TextDecoder().decode(buf); } }
}

// ---------------------------------------------------------------------
// 내보내기
// ---------------------------------------------------------------------
const csvCell = v => { v = String(v ?? ''); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
function download(name, rows) {
  const blob = new Blob(['﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function posRows() {
  const m = M();
  // 부스 포스(config.js)의 족자봉 종류 글자 (A~Y)
  const booths = (self.BOOTH_CONFIG && self.BOOTH_CONFIG.booths) || {};
  const jp = Object.values(booths).flatMap(b => b.products || []).find(p => p.variants);
  const letters = jp ? jp.variants : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const useLetters = jAlpha;
  const over = [];
  const rows = [['주문번호', '이름', '전화번호', '입금확인', '엽서북', '족자봉']];
  for (const o of m.live) {
    const paid = ['form', 'auto', 'linked', 'manual'].includes(o.pay);
    const j = Object.keys(o.jk).map(Number).sort((a, b) => a - b).map(n => {
      const L = useLetters ? letters[n - 1] : String(n);
      if (!L) over.push(n);
      return (L || String(n)) + (o.jk[n] > 1 ? '×' + o.jk[n] : '');
    }).join(', ');
    rows.push([o.id, o.nick || o.name, o.phone, paid ? 'O' : '', o.books || '', j]);
  }
  return { rows, over: [...new Set(over)], letters, useLetters, paid: rows.filter(r => r[3] === 'O').length };
}
const POS_HANDOFF = 'booth-pos-handoff';
function posModal() {
  const x = posRows(), n = x.rows.length - 1;
  const sample = x.rows.slice(1).find(r => r[5]);
  openModal({
    title: '포스로 내보내기', sub: '입금 확인된 사람만 포스에서 수령할 수 있어요. 미입금은 명단에는 들어가지만 포스가 걸러내요.',
    body: `<div class="kv"><span>명단</span><b class="num">${cnt(n)}명</b></div>
      <div class="kv"><span>입금 확인</span><b class="num">${cnt(x.paid)}명</b></div>
      <div class="kv"><span>족자봉 표기</span><b>${x.useLetters ? `알파벳 (1→A … ${x.letters.length}→${x.letters[x.letters.length - 1]})` : '숫자'}</b></div>
      ${sample ? `<div class="kv sub"><span>예: ${esc(sample[1])} → ${esc(sample[5])}</span><b></b></div>` : ''}
      ${x.over.length ? `<div class="note warn"><b>넘버 ${x.over.join(', ')}번</b>은 포스 족자봉 종류(${x.letters.length}개, A~${x.letters[x.letters.length - 1]})에 없어서 포스가 개수를 잘못 셀 수 있어요. 포스 config.js의 족자봉 종류를 늘리거나, 해당 주문의 족자봉 넘버를 고친 뒤 보내 주세요.</div>` : ''}
      <div class="note" style="margin-top:12px"><b>이 기기 포스로 보내기</b>: 이 브라우저(같은 홈 화면 앱)에 열린 포스가 바로 받아요. 포스 설정 → 선입금 명단 → <b>관리 사이트에서 받기</b>를 누르면 돼요.<br><b>CSV 받기</b>: 다른 기기 포스는 파일을 옮겨서 CSV 파일 불러오기로 넣어요.</div>`,
    foot: `<span class="sp"></span><button class="btn" data-act="posCsv">CSV 받기</button><button class="btn pri" data-act="posSend">이 기기 포스로 보내기</button>`,
  });
}
function posCsvText(rows) { return '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'); }
function exportReviews() {
  const m = M();
  download('작가_후기.csv', [['No', '닉네임', 'X 아이디', '후기 (한)', '후기 (일)'], ...m.confirmed.slice().sort((a, b) => (a.no || 999) - (b.no || 999)).map(a => [a.no || '', a.nick, a.x, a.revKo, a.revJa])]);
}
function exportMake() {
  const m = M();
  download('제작_수량.csv', [['넘버', '작가', '주문', '작가 여분', '추가', '최종'], ...m.make.map(x => [jName(x.no), x.author ? x.author.nick : '', x.order, x.spare, x.add, x.total]),
    [], ['엽서북', '', m.bookOrder, m.bookAuthor, m.bookExtra, m.bookOrder + m.bookAuthor + m.bookExtra]]);
}

// ---------------------------------------------------------------------
// X 프로필 사진: 처음 한 번만 받아서 시트에 저장해요. 사진이 깨지면(바뀌면) 그 사람만 다시 받아요.
// ---------------------------------------------------------------------
const AV_TRIED = 'seiroku-admin-av';
const avTried = (() => { try { return new Set(JSON.parse(sessionStorage.getItem(AV_TRIED)) || []); } catch { return new Set(); } })();
let avBusy = false, avBroken = new Set(), avTimer;
async function fetchAvatars(handles) {
  if (avBusy || st.demo || !st.tabs) return;
  const authors = T('작가').rows.filter(r => /^@?\w{1,15}$/.test(r.get('X 아이디')));
  if (!handles) {
    const miss = authors.filter(r => !r.get('프로필 사진') && !avTried.has(r.get('X 아이디').toLowerCase()));
    if (!miss.length) return;
    handles = null;
    miss.forEach(r => avTried.add(r.get('X 아이디').toLowerCase()));
  } else {
    handles = handles.filter(h => !avTried.has('!' + h.toLowerCase()));
    if (!handles.length) return;
    handles.forEach(h => avTried.add('!' + h.toLowerCase()));
  }
  try { sessionStorage.setItem(AV_TRIED, JSON.stringify([...avTried])); } catch {}
  avBusy = true;
  try {
    const j = await api('avatars', handles ? { handles } : {});
    const rows = j.rows || {};
    if (Object.keys(rows).length) {
      Object.entries(rows).forEach(([row, url]) => applyOp(st.tabs, { action: 'update', sheet: '작가', row: +row, values: { '프로필 사진': url } }));
      model = null; render();
    }
  } catch {} finally { avBusy = false; }
}
document.addEventListener('error', e => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.closest('.av')) return;
  img.remove();
  if (!img.hasAttribute('data-av')) return;
  const a = M().authors.find(a => a.pic === img.getAttribute('src'));
  if (a && a.x) { avBroken.add(a.x); clearTimeout(avTimer); avTimer = setTimeout(() => { fetchAvatars([...avBroken]); avBroken = new Set(); }, 1500); }
}, true);

// ---------------------------------------------------------------------
// 토스트
// ---------------------------------------------------------------------
let toastT;
function toast(msg, err = false) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, err ? 5000 : 2400);
}

function applyTheme() { if (store.theme) document.documentElement.dataset.theme = store.theme; else delete document.documentElement.dataset.theme; }

// ---------------------------------------------------------------------
// 이벤트
// ---------------------------------------------------------------------
function go(v) {
  const [view, filter] = v.split(':');
  st.view = view; if (filter) st.orderFilter = filter;
  history.replaceState(null, '', '#' + view);
  closeModal(); render(); scrollTo(0, 0);
}

document.addEventListener('click', async e => {
  const pk = e.target.closest('[data-pick-for]');
  if (pk) {
    const inp = document.getElementById(pk.dataset.pickFor); inp.value = pk.dataset.pick;
    pk.parentElement.querySelectorAll('.pick').forEach(b => b.classList.toggle('on', b === pk)); return;
  }
  const el = e.target.closest('[data-go],[data-act],[data-open],[data-seg],[data-link],[data-unlink],[data-theme-set],[data-email-del]');
  if (!el) { if (e.target.id === 'dim') closeModal(); return; }
  if (el.dataset.go) return go(el.dataset.go);
  if (el.dataset.seg) { const [k, v] = el.dataset.seg.split(':'); st[k] = v; return render(); }
  if (el.dataset.link) return linkDep(el.dataset.link, el.dataset.dep);
  if (el.dataset.unlink) return modalUnlink && modalUnlink(el.dataset.unlink);
  if (el.dataset.emailDel) { if (!confirm(el.dataset.emailDel + ' 계정을 뺄까요? 바로 로그인이 막혀요.')) return; return saveEmails(st.emails.list.filter(x => x !== el.dataset.emailDel)); }
  if (el.dataset.themeSet !== undefined) { store.theme = el.dataset.themeSet; saveStore(); applyTheme(); return render(); }
  if (el.dataset.open) {
    e.stopPropagation();
    const [kind, ...rest] = el.dataset.open.split(':');
    if (kind === 'author') return rowForm('작가', +rest[0]);
    if (kind === 'order') return orderModal(rest.join(':'));
    if (kind === 'dep') return depModal(rest.join(':'));
    if (kind === 'row') return rowForm(rest[0], +rest[1]);
    return;
  }
  const act = el.dataset.act;
  if (act === 'close') return closeModal();
  if (act === 'save') return modalSave && modalSave('save');
  if (act === 'delRow') return modalSave && modalSave('del');
  if (act === 'reload') { model = null; if (st.demo) st.tabs = null; return load(true); }
  if (act === 'newRow') return rowForm(el.dataset.tab, 0);
  if (act === 'paste') return pasteModal(el.dataset.tab);
  if (act === 'pickFile') return $('#fileIn').click();
  if (act === 'exportPos') return posModal();
  if (act === 'posCsv') { download('포스용_선입금_명단.csv', posRows().rows); return toast('CSV를 받았어요. 포스 설정 → CSV 파일 불러오기에 넣어 주세요'); }
  if (act === 'posSend') {
    const x = posRows();
    try { localStorage.setItem(POS_HANDOFF, JSON.stringify({ csv: posCsvText(x.rows), ts: Date.now(), count: x.rows.length - 1 })); }
    catch { return toast('이 브라우저에 저장하지 못했어요. CSV 받기를 써 주세요', true); }
    closeModal();
    openModal({ title: '포스로 보냈어요', sub: `${cnt(x.rows.length - 1)}명`, body: '<p style="margin:0">포스를 열고 <b>설정 → 선입금 명단 → 관리 사이트에서 받기</b>를 눌러 주세요.</p>',
      foot: `<span class="sp"></span><button class="btn" data-act="close">닫기</button><a class="btn pri" href="../index.html">포스 열기</a>` });
    return;
  }
  if (act === 'signOut') return signOut();
  if (act === 'dist') { if (!st.admin) return; viewMoney(); return openModal({ title: '분배 · 받을 돈', sub: '관리자만 볼 수 있어요', body: st.distHtml, foot: '<span class="sp"></span><button class="btn pri" data-act="close">닫기</button>' }); }
  if (act === 'emailAdd') {
    const v = $('#newEmail').value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return toast('이메일 주소를 확인해 주세요', true);
    if (st.emails.list.includes(v) || v === st.emails.owner) return toast('이미 있는 계정이에요', true);
    return saveEmails([...st.emails.list, v]);
  }
  if (act === 'sample' || act === 'reset') {
    const w = el.dataset.which, what = w === 'orders' ? '선입금 리스트' : '입금기록';
    const msg = act === 'sample' ? `작년 ${what} 샘플로 ${what} 탭을 덮어쓸까요?` : `${w === 'orders' ? '선입금 리스트와 주문 처리' : '입금기록'} 탭 내용을 모두 지울까요? 되돌릴 수 없어요.`;
    if (!confirm(msg)) return;
    setSync('busy');
    try { const j = await api(act, { which: w }); toast(act === 'sample' ? `${j.count != null ? j.count + '건을 ' : ''}불러왔어요` : '초기화했어요'); }
    catch (e) { toast(e.message, true); }
    return load();
  }
  if (act === 'exportReviews') return exportReviews();
  if (act === 'exportMake') return exportMake();
  if (act === 'demo') { st.demo = true; store.demo = true; saveStore(); st.tabs = null; st.demoTabs = null; return load(); }
  if (act === 'exitDemo') { st.demo = false; store.demo = false; saveStore(); st.tabs = null; st.demoTabs = null; render(); return; }
  if (act === 'connect') {
    const url = $('#cUrl').value.trim(), key = $('#cKey').value.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) return toast('script.google.com 으로 시작하는 웹 앱 주소를 넣어 주세요', true);
    if (!key) return toast('비밀키를 넣어 주세요', true);
    store.url = url; store.key = key; store.demo = false; st.demo = false; saveStore(); st.tabs = null;
    await load();
    if (st.tabs) { toast('연결했어요'); go('home'); }
    return;
  }
  if (act === 'copyLink') {
    const link = encodeLink({ u: store.url, k: store.key, n: store.who || '' });
    try { await navigator.clipboard.writeText(link); toast('복사했어요. 내 다른 기기에서 열어 주세요'); }
    catch { prompt('이 링크를 복사해 주세요', link); }
    return;
  }
  if (act === 'disconnect') {
    if (!confirm('이 브라우저에서 연결 정보를 지울까요? 시트 데이터는 그대로예요.')) return;
    delete store.url; delete store.key; delete store.who; delete store.tok; saveStore(); dropCache(); st.tabs = null; render(); return;
  }
});

document.addEventListener('input', e => {
  if (e.target.id === 'orderQ' || e.target.id === 'authorQ') {
    st[e.target.id] = e.target.value;
    const pos = e.target.selectionStart, id = e.target.id;
    render();
    const el = document.getElementById(id); el.focus(); el.setSelectionRange(pos, pos);
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && modalSave) modalSave('save');
});
$('#fileIn').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const t = $('#pTxt'); if (!t) return;
  t.value = await readTextFile(f);
  t.dispatchEvent(new Event('input'));
});

applyTheme();
render();
if (linkMsg) toast(linkMsg.replace(/^!/, ''), linkMsg.startsWith('!'));
if (connected()) {
  // 같은 탭에서 다시 열면 지난 데이터를 먼저 보여주고 뒤에서 새로 불러와요
  const c = !st.demo && readCache();
  if (c) { st.tabs = c; render(); }
  load();
}
