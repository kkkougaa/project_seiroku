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
  authorSeg: 'ok', orderFilter: 'all', orderQ: '', authorQ: '',
};
if (!VIEWS.some(v => v[0] === st.view)) st.view = 'home';

// ---------------------------------------------------------------------
// API — Apps Script 로 보내요. 둘러보기 모드면 이 브라우저 안에서 똑같이 처리해요.
// ---------------------------------------------------------------------
async function api(action, payload = {}) {
  if (st.demo) {
    if (action === 'read') { if (!st.demoTabs) st.demoTabs = self.DEMO_TABS(); return { ok: true, tabs: JSON.parse(JSON.stringify(st.demoTabs)), editions: [{ id: 'demo', name: '둘러보기' }], edition: 'demo' }; }
    if (action === 'sample') {
      const fresh = self.DEMO_TABS(), name = payload.which === 'orders' ? '선입금 리스트' : '입금기록';
      st.demoTabs[name] = fresh[name]; return { ok: true, count: fresh[name].rows.length };
    }
    if (action === 'reset') {
      (payload.which === 'orders' ? ['선입금 리스트', '수동 주문', '주문 처리'] : ['입금기록', '출금 처리']).forEach(n => { if (st.demoTabs[n]) st.demoTabs[n].rows = []; });
      return { ok: true };
    }
    if (action === 'avatars') return { ok: true, rows: {} };
    if (action === 'emails') return { ok: true, list: [], owner: 'demo@example.com', canEdit: false };
    applyOp(st.demoTabs, { action, ...payload });
    return { ok: true };
  }
  if (!connected()) throw new Error('로그인해 주세요.');
  const auth = store.key ? { key: store.key } : { idToken: store.tok.t };
  const r = await fetch(apiUrl(), { method: 'POST', body: JSON.stringify({ ...auth, edition: store.edition || '', action, ...payload }), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow' });
  if (!r.ok) throw new Error('연결 실패 (' + r.status + ')');
  let j; try { j = await r.json(); } catch { throw new Error('응답을 못 읽었어요. 웹 앱 배포 주소가 맞는지 확인해 주세요.'); }
  if (!j.ok) {
    if (j.code === 'LOGIN' || j.code === 'DENIED') {
      // 틀린 비밀키·만료된 로그인은 지우고 로그인 화면으로 보내요 (갇히지 않게)
      if (store.key) { delete store.key; delete store.who; } else delete store.tok;
      saveStore(); dropCache();
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

// 선입금 리스트 열. 열 제목으로 찾지 않고, 정해 둔 열 글자(A, B … AA)에서만 읽어요.
//  주문 탭 → 열 설정에서 바꾸면 설정 탭의 '선입금 열'에 "순번=A, 엽서북 수량=C …" 로 저장돼요.
const ORDER_FIELDS = [
  ['num', '순번', 'A'], ['books', '엽서북 수량', 'C'], ['qty', '족자봉 수량', 'D'], ['text', '족자봉 선택', 'V'],
  ['total', '총 주문금액', 'G'], ['name', '이름', 'H'], ['payer', '입금자명', 'I'], ['nick', '닉네임', 'J'], ['phone', '연락처', 'K'],
  ['recv', '수령자명', 'M'], ['recvPhone', '수령자 연락처', 'N'], ['refundName', '환불 예금주', 'T'],
  ['method', '배송방법', 'E'], ['ship', '배송비', 'F'], ['status', '진행 상태', 'AA'], ['id', '주문번호', ''],
];
const ORDER_COLS_KEY = '선입금 열';
const colNo = s => { s = String(s ?? '').trim().toUpperCase(); if (!/^[A-Z]{1,2}$/.test(s)) return -1; let n = 0; for (const ch of s) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const colName = i => i < 0 ? '' : (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : '') + String.fromCharCode(65 + i % 26);
function orderCols() {
  const row = T('설정').rows.find(r => r.get('항목') === ORDER_COLS_KEY);
  const saved = {};
  if (row) row.get('값').split(',').forEach(x => { const [k, v = ''] = x.split('='); saved[k.trim()] = v.trim(); });
  const out = {};
  for (const [k, label, def] of ORDER_FIELDS) out[k] = colNo(label in saved ? saved[label] : def);
  return out;
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
const cacheKey = () => CACHE + ':' + (store.edition || '');
function saveCache() { if (st.demo || !st.tabs) return; try { sessionStorage.setItem(cacheKey(), JSON.stringify({ tabs: st.tabs, editions: st.editions })); } catch {} }
function readCache() { try { const c = JSON.parse(sessionStorage.getItem(cacheKey())); if (c && c.tabs) { st.editions = c.editions || st.editions; return c.tabs; } } catch {} return null; }
function dropCache() { try { Object.keys(sessionStorage).filter(k => k.startsWith(CACHE)).forEach(k => sessionStorage.removeItem(k)); } catch {} }

async function load(fresh = false) {
  await queue.catch(() => {});
  st.loading = true; st.err = ''; setSync('busy');
  if (!st.tabs) render();
  try {
    const j = await api('read', fresh ? { fresh: true } : {});
    st.tabs = j.tabs; st.at = new Date(); model = null; saveCache();
    if (j.who && j.who !== store.who) { store.who = j.who; saveStore(); }
    st.admin = st.demo ? true : !!j.admin;
    if (j.editions) { st.editions = j.editions; st.sheetUrl = j.sheetUrl || ''; if (j.edition && j.edition !== store.edition) { store.edition = j.edition; saveStore(); } }
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
  if (!jAlpha) { // 숫자 표기: 알파벳은 넘버로 안 읽어요 ("x", "A" 는 무시)
    const t = String(text || '').replace(/[＊*]/g, '×').replace(/(?<=[0-9번호]\s*)[xX](?=\s*\d)/g, '×');
    const re = /(\d+)\s*(?:번|호)?\s*(?:×\s*(\d+)|(\d+)\s*개)?/g;
    let m;
    while ((m = re.exec(t))) { const n = +m[1]; if (n) out[n] = (out[n] || 0) + +(m[2] || m[3] || 1); }
    return out;
  }
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
let jAlpha = false; // 설정 '족자봉 표기' 가 '알파벳'일 때만 A, B, C 로 읽고 보여줘요 (build 에서 정해요)
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
  jAlpha = cfg['족자봉 표기'] === '알파벳';
  const posAlpha = (cfg['포스 족자봉 표기'] || '알파벳') !== '숫자'; // 포스로 보낼 때 1→A 로 바꿀지
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
  for (const r of T('주문 처리').rows) if (r.get('주문번호')) proc[r.get('주문번호')] = { row: r.row, j: r.get('족자봉 확정'), pay: r.get('입금 처리'), dep: r.get('입금 키'), memo: r.get('메모'), merge: r.get('합침') };

  // 입금기록
  const deposits = T('입금기록').rows.filter(r => r.get('거래 일시') || r.get('적요')).map(r => {
    const amt = toNum(r.get('거래 금액'));
    const type = r.get('거래 유형') || (amt < 0 ? '출금' : '입금');
    const key = [r.get('거래 일시'), r.get('적요'), Math.abs(amt)].join('|');
    return { row: r.row, key, at: r.get('거래 일시'), who: r.get('적요'), type, amt: Math.abs(amt), bal: r.get('거래 후 잔액'), balN: toNum(r.get('거래 후 잔액')), memo: r.get('메모'), bank: r.get('거래 기관'), order: null };
  });
  const depByKey = {}; deposits.forEach(d => { depByKey[d.key] = d; });
  // 출금 처리: 출금마다 환불 / 비용 / 기타 로 분류하고, 환불이면 어느 주문인지 적어요
  const wdProc = {};
  for (const r of T('출금 처리').rows) if (r.get('출금 키')) wdProc[r.get('출금 키')] = { row: r.row, kind: r.get('구분'), order: r.get('주문번호'), memo: r.get('메모') };
  const withdrawals = deposits.filter(d => d.type !== '입금');
  withdrawals.forEach(d => { d.wp = wdProc[d.key] || null; });

  // 주문
  const oT = T('선입금 리스트'), oc = orderCols();
  const oGet = (r, k) => oc[k] >= 0 ? String(r.raw[oc[k]] ?? '').trim() : '';
  const orders = oT.rows.filter(r => oGet(r, 'id') || oGet(r, 'num')).map(r => {
    const g = k => oGet(r, k);
    const id = g('id') || ('#' + g('num'));
    const p = proc[id] || {};
    const text = g('text');
    const qty = toNum(g('qty'));
    // 족자봉 수량이 0인데 선택 칸에 "x", "-", "없음"처럼 적은 건 넘버가 아니에요 (x 를 X번으로 읽지 않게)
    const noPick = !qty && /^(x|-+|\.+|0|없음|없어요|없습니다|해당\s*없음|no|none|n\/a|ㄴ+)$/i.test(text);
    const parsed = noPick ? {} : parseJokja(text);
    const fixed = p.j ? parseJokja(p.j) : null;
    const jk = fixed || parsed;
    const bad = Object.keys(jk).map(Number).filter(n => n < 1 || (maxNo && n > maxNo));
    let jState = 'ok';
    if (fixed) jState = 'fixed';
    else if (sumObj(parsed) !== qty || bad.length) jState = 'check';
    if (!qty && !text && !fixed) jState = 'none';
    const books = toNum(g('books')), ship = toNum(g('ship')), total = toNum(g('total'));
    const expect = books * priceBook + (fixed ? sumObj(fixed) : qty) * priceJ + ship; // 수량 열 개수로 계산
    return {
      row: r.row, r, id, num: g('num'), nick: g('nick'), name: g('name'), payer: g('payer') || g('refundName'), recv: g('recv'),
      phone: g('recvPhone') || g('phone'), books, qty, text, parsed, fixed, jk, jCount: fixed ? sumObj(fixed) : qty, jState, bad, // 개수는 수량 열 그대로 (사이트에서 넘버를 고쳤으면 고친 개수)
      total, expect, ship, method: g('method'), formStatus: g('status').replace(/\s+/g, ''), proc: p, pay: null, dep: null, deps: [], depSum: 0, cand: null,
    };
  });
  // 위치폼 밖에서 받은 주문 (수동 주문 탭). 족자봉 개수는 적은 넘버로 세요.
  T('수동 주문').rows.filter(r => r.get('주문번호')).forEach(r => {
    const id = r.get('주문번호'), p = proc[id] || {};
    const text = r.get('족자봉'), parsed = parseJokja(text), fixed = p.j ? parseJokja(p.j) : null, jk = fixed || parsed;
    const bad = Object.keys(jk).map(Number).filter(n => n < 1 || (maxNo && n > maxNo));
    const books = toNum(r.get('엽서북')), qty = sumObj(parsed), total = toNum(r.get('총 주문금액'));
    orders.push({
      row: r.row, r, id, num: '직접', manualOrder: true, nick: r.get('닉네임'), name: r.get('이름'), payer: r.get('입금자명') || r.get('이름'), recv: r.get('이름'),
      phone: r.get('연락처'), books, qty, text, parsed, fixed, jk, jCount: sumObj(jk), jState: fixed ? 'fixed' : bad.length ? 'check' : qty ? 'ok' : 'none', bad,
      total, expect: books * priceBook + sumObj(jk) * priceJ, ship: 0, method: r.get('수령 방법'), formStatus: '', proc: p, pay: null, dep: null, deps: [], depSum: 0, cand: null, at: r.get('작성시간'),
    });
  });

  // 폼 진행 상태가 '자동주문취소', '환불완료'면 취소한 주문이에요. (사이트에서 입금 처리를 따로 골랐으면 그쪽을 따라요)
  const formCancel = o => !o.proc.pay && (o.formStatus.includes('취소') || o.formStatus.includes('환불완료'));
  // 합친 주문: 주문 처리의 '합침'에 적힌 주문으로 수량·금액을 더하고, 목록에서는 빼요 (원본 시트는 그대로예요)
  const byId = {}; orders.forEach(o => { byId[o.id] = o; });
  const part = o => ({ id: o.id, num: o.num, nick: o.nick, name: o.name, books: o.books, qty: o.qty, jk: o.jk, total: o.total, formStatus: o.formStatus });
  const addObj = (x, y) => { const z = { ...x }; Object.entries(y).forEach(([k, v]) => { z[k] = (z[k] || 0) + v; }); return z; };
  for (const b of orders.slice()) {
    const a = byId[b.proc.merge];
    if (!a || a === b || a.proc.merge || b.proc.pay === '취소' || a.proc.pay === '취소' || formCancel(a) || formCancel(b)) continue;
    if (!a.parts) a.parts = [part(a)];
    a.parts.push(part(b));
    a.books += b.books; a.qty += b.qty; a.total += b.total; a.ship += b.ship;
    a.text = [a.text, b.text].filter(Boolean).join(' / ');
    a.parsed = addObj(a.parsed, b.parsed); a.jk = addObj(a.jk, b.jk); a.jCount += b.jCount;
    a.bad = [...new Set([...a.bad, ...b.bad])];
    a.alt = [...(a.alt || []), b.payer, b.name, b.recv, b.nick]; // 합친 주문 쪽 이름으로 들어온 입금도 찾아요
    a.fixed = a.fixed || b.fixed ? a.jk : null;
    a.jState = a.fixed ? 'fixed' : (sumObj(a.jk) !== a.jCount || a.bad.length) ? 'check' : a.qty ? 'ok' : 'none';
    a.expect = a.books * priceBook + a.jCount * priceJ + a.ship;
    a.proc = { ...a.proc, dep: [a.proc.dep, b.proc.dep].filter(Boolean).join('\n') };
    orders.splice(orders.indexOf(b), 1);
  }
  // 합친 주문 중 일부만 폼에서 결제했으면, 그만큼은 받은 돈으로 치고 나머지만 통장에서 찾아요
  for (const o of orders) {
    o.formPaid = 0;
    if (!o.parts) continue;
    const done = o.parts.filter(p => p.formStatus === '결제완료');
    if (done.length === o.parts.length) o.formStatus = '결제완료';
    else { o.formStatus = done.length ? '일부결제완료' : o.parts[0].formStatus; o.formPaid = done.reduce((s, p) => s + p.total, 0); }
  }

  // 입금 대조
  //  1) 폼에서 결제완료 → 폼 결제   2) 사이트에서 손으로 연결/확인   3) 이름 + 금액이 같은 입금 자동 연결
  const used = new Set();
  for (const o of orders) {
    const pay = o.proc.pay;
    if (pay === '취소' || formCancel(o)) { o.pay = 'cancel'; continue; }
    const keys = String(o.proc.dep || '').split('\n').filter(k => depByKey[k]);
    if (keys.length) {
      o.deps = keys.map(k => depByKey[k]); o.deps.forEach(d => { d.order = o; used.add(d.key); });
      o.dep = o.deps[0]; o.depSum = o.deps.reduce((a, d) => a + d.amt, 0);
      if (o.formStatus === '결제완료' && pay !== '미입금') { o.pay = 'form'; continue; } // 폼 결제 + 추가 입금(추가 구매)
      o.pay = o.depSum + o.formPaid === o.total || o.depSum + o.formPaid === o.expect ? 'linked' : 'diff'; continue;
    }
    if (pay === '확인') { o.pay = 'manual'; continue; }
    if (pay === '미입금') { o.pay = 'unpaid'; continue; }
    if (o.formStatus === '결제완료') { o.pay = 'form'; continue; }
  }
  const names = o => [o.payer, o.name, o.recv, o.nick, ...(o.alt || [])].map(normName).filter(x => x.length >= 2);
  const free = () => deposits.filter(d => d.type === '입금' && !used.has(d.key));
  const pend = () => orders.filter(o => !o.pay);
  const tryMatch = (test, how) => {
    for (const o of pend()) {
      const ns = names(o);
      const d = free().find(d => d.amt === o.total - o.formPaid && test(normName(d.who), ns));
      if (d) { o.dep = d; o.deps = [d]; o.depSum = d.amt; d.order = o; used.add(d.key); o.pay = 'auto'; o.how = how; continue; }
      if (!o.parts) continue;
      // 합친 주문은 따로따로 입금했을 수 있어요. 주문마다 같은 금액의 입금을 하나씩 찾아요.
      const got = [];
      for (const p of o.parts.filter(p => p.formStatus !== '결제완료')) {
        const x = free().find(d => !got.includes(d) && d.amt === p.total && test(normName(d.who), ns));
        if (!x) { got.length = 0; break; }
        got.push(x);
      }
      if (got.length) { o.deps = got; o.dep = got[0]; o.depSum = got.reduce((s, d) => s + d.amt, 0); got.forEach(d => { d.order = o; used.add(d.key); }); o.pay = 'auto'; o.how = how; }
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

  // 금액 검증: 실제 엽서북·족자봉 개수로 계산한 금액(expect) ↔ 받은 금액(입금됐으면, 환불 빼고) 또는 신청 금액
  for (const o of orders) {
    o.refunds = withdrawals.filter(d => d.wp && d.wp.kind === '환불' && d.wp.order === o.id);
    o.refundSum = o.refunds.reduce((a, d) => a + d.amt, 0);
    const paid = ['form', 'linked', 'auto', 'manual'].includes(o.pay) || (o.pay === 'diff' && o.deps.length);
    o.paidAmt = (o.pay === 'form' ? o.total + o.depSum : o.deps.length ? o.depSum + o.formPaid : o.pay === 'manual' ? o.total : 0) - o.refundSum;
    o.cmpAmt = paid ? o.paidAmt : o.total;
    o.cmpLabel = paid ? '받은 금액' : '신청 금액';
    o.amtWarn = o.pay !== 'cancel' && o.cmpAmt !== o.expect;
  }

  const PAID = ['form', 'linked', 'manual', 'auto'];
  const live = orders.filter(o => o.pay !== 'cancel');
  // 신청서만 보고 잡는 문제 (입금 내역이 없어도 잡아요)
  const digits = o => String(o.phone).replace(/\D/g, '').replace(/^82/, '0');
  const byPhone = {}; live.forEach(o => { const d = digits(o); if (d.length >= 8) (byPhone[d] = byPhone[d] || []).push(o); });
  for (const o of orders) {
    const is = o.issues = [];
    if (o.pay === 'cancel') continue;
    const hasJ = o.qty > 0 || o.jCount > 0;
    if (!o.books && !hasJ) is.push(['empty', '수량 없음', '엽서북도 족자봉도 0개예요']);
    if (!o.books && hasJ) is.push(['onlyJ', '족자봉만 주문', '엽서북을 1권 이상 사야 족자봉을 살 수 있어요']);
    if (o.qty > 0 && !o.fixed && !sumObj(o.parsed)) is.push(['noNum', '넘버 안 적음', `족자봉 ${o.qty}개를 주문했는데 넘버가 없어요`]);
    if (/국내\s*창고/.test(o.method)) is.push(['ship', '국내 창고 선택', `배송이 안 되는데 "${o.method}"을 골랐어요`]);
    else if (o.ship > 0) is.push(['ship', '배송비 있음', `배송이 안 되는데 배송비 ${won(o.ship)}이 붙었어요`]);
    const d = digits(o);
    if (!o.manualOrder && !/^01\d{8,9}$/.test(d)) is.push(['phone', '연락처 확인', d ? '휴대폰 번호 모양이 아니에요' : '연락처가 비어 있어요']);
    const same = (byPhone[d] || []).filter(x => x !== o);
    if (same.length) is.push(['dup', '중복 의심', `같은 연락처 주문: ${same.map(x => x.num + '번').join(', ')}`]);
    o.dupIds = same.map(x => x.id);
  }
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
  // 포토카드: 족자봉 1개를 살 때마다 1개씩 같이 나가요 (넘버를 안 적은 주문도 개수대로 세요)
  const cardOrder = live.reduce((a, o) => a + o.jCount, 0);
  const cardExtra = extra.filter(e => e.kind === '포토카드').reduce((a, e) => a + e.n, 0);

  // 정산
  const income = T('수입').rows.filter(r => r.get('항목') || r.get('금액')).map(r => ({ row: r.row, r, name: r.get('항목'), amt: toNum(r.get('금액')), memo: r.get('메모') }));
  const costs = T('비용').rows.filter(r => r.get('내용') || r.get('항목') || r.get('단가')).map(r => {
    const unit = toNum(r.get('단가')), n = r.get('개수') === '' ? 1 : toNum(r.get('개수'));
    return { row: r.row, r, name: r.get('내용') || r.get('항목'), unit, n, amt: unit * n, who: r.get('사용 출처') || r.get('출금자') || '공금', done: r.get('처리') === '완료', memo: r.get('메모') };
  });
  const preForm = paid.filter(o => o.pay === 'form').reduce((a, o) => a + o.total, 0);
  const preBank = paid.reduce((a, o) => a + (o.pay === 'form' ? o.depSum : o.deps.length ? o.depSum : o.total), 0);
  const refundSum = live.reduce((a, o) => a + o.refundSum, 0);
  const incomeSum = preForm + preBank - refundSum + income.reduce((a, x) => a + x.amt, 0);
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
    cfg, priceBook, priceJ, spareJ, bookPerAuthor, ratios, authors, confirmed, authorByNo, maxNo, orders, posAlpha, live, paid, deposits, unusedDeps, withdrawals, refundSum,
    extra, make, bookOrder, bookAuthor, bookExtra, cardOrder, cardExtra, income, costs, preForm, preBank, incomeSum, costShared, personal, personalSum, reserve, reserveAuto,
    balanceIn, pool, people, wsum, dIn, dOut, bankCheck,
  };
}

const PAY = {
  form: ['폼 결제', 'blue'], auto: ['입금 확인', 'green'], linked: ['입금 연결', 'green'], manual: ['수동 확인', 'green'],
  diff: ['확인 필요', 'orange'], none: ['미입금', 'red'], unpaid: ['미입금', 'red'], cancel: ['취소', ''],
};
// 폼 진행 상태가 '결제전'인데 통장에서도 입금을 못 찾았으면 '결제 안함'으로 보여줘요
const payBadge = o => { const [t, c] = PAY[o.pay] || ['?', '']; return `<span class="badge ${c}">${o.pay === 'none' && o.formStatus === '결제전' ? '결제 안함' : t}</span>`; };
const ISSUES = [['onlyJ', '족자봉만 주문'], ['noNum', '족자봉 넘버를 안 적은 주문'], ['ship', '배송이 안 되는데 국내 창고·배송비가 있는 주문'], ['empty', '수량이 0인 주문'], ['dup', '같은 연락처로 여러 번 넣은 주문'], ['phone', '연락처를 확인할 주문']];
const mergeBtn = o => `<button class="btn sm" data-act="mergeAsk" data-id="${esc(o.id)}">주문 합치기</button>`;
const issueBadges = o => (o.issues || []).map(([k, t, d]) => `<span class="badge red" title="${esc(d)}">${t}</span>${k === 'dup' ? ' ' + mergeBtn(o) : ''}`).join(' ');
const partsBadge = o => o.parts ? ` <span class="badge blue">${o.parts.slice(1).map(p => esc(p.num) + '번').join(', ')} 합침</span>` : '';
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
  const wdNew = m.withdrawals.filter(d => !d.wp || !d.wp.kind);
  if (wdNew.length) add('warn', `분류 안 된 출금 ${wdNew.length}건`, '환불인지, 비용인지 입금 대조에서 표시해 주세요.', 'match');
  const jc = m.live.filter(o => o.jState === 'check');
  if (jc.length) add('warn', `족자봉 넘버를 확인할 주문 ${jc.length}건`, '적은 넘버 개수가 주문 개수와 다르거나 없는 넘버가 있어요.', 'orders:jokja');
  for (const [k, t] of ISSUES) { const n = m.live.filter(o => o.issues.some(i => i[0] === k)).length; if (n) add(k === 'dup' || k === 'phone' ? 'warn' : 'bad', `${t} ${n}건`, '', 'orders:issue'); }
  const money = m.live.filter(o => o.amtWarn);
  if (money.length) add('warn', `금액이 맞지 않는 주문 ${money.length}건`, `실제 개수로 계산한 금액(엽서북 ${won(m.priceBook)}, 족자봉 ${won(m.priceJ)})과 받은·신청 금액이 달라요.`, 'orders:money');
  const qSum = m.live.reduce((a, o) => a + o.qty, 0), jSum = m.live.reduce((a, o) => a + sumObj(o.jk), 0);
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
  if (!st.tabs) body = st.err ? `<div class="hello"><div class="note warn"><b>불러오지 못했어요</b><br>${esc(st.err)}</div><div class="acts"><button class="btn pri" data-act="reload">다시 시도</button><button class="btn" data-act="relogin">다시 로그인</button></div></div>` : '<div class="loading"><div class="spin"></div>시트를 불러오는 중이에요</div>';
  else body = ({ home: viewHome, authors: viewAuthors, orders: viewOrders, match: viewMatch, make: viewMake, money: viewMoney, memo: viewMemo, settings: viewSettings }[st.view] || viewHome)();
  const y = scrollY;
  app.innerHTML = topBar(true) + `<main>${body}</main>`;
  scrollTo(0, y);
  setSync(st.loading || pending ? 'busy' : st.err ? 'err' : 'ok');
}

function topBar(nav) {
  return `<header class="top"><div class="top-in">
    <div class="brand">${nav ? edButton() : '행사 관리'}${st.demo ? ' <span class="badge orange">둘러보기</span>' : ''}</div>
    ${nav ? `<nav class="tabs" role="tablist">${VIEWS.map(([k, t]) => `<button role="tab" aria-selected="${st.view === k}" data-go="${k}">${t}</button>`).join('')}</nav>
    <div class="sync" id="sync"><i></i><span id="syncT"></span><button data-act="reload">새로고침</button></div>` : ''}
  </div></header>`;
}
// ---------- 회차 고르기 ----------
const curEdition = () => (st.editions || []).find(e => e.id === store.edition) || (st.editions || [])[0];
function edButton() {
  const cur = curEdition();
  return `<button class="edbtn" data-act="edMenu" aria-haspopup="menu">${esc(cur ? cur.name : '행사 관리')}<svg width="12" height="8" viewBox="0 0 12 8" aria-hidden="true"><path d="M1 1.5l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
}
function edMenu() {
  closeEdMenu();
  const btn = document.querySelector('.edbtn'); if (!btn) return;
  const r = btn.getBoundingClientRect(), cur = curEdition();
  const m = document.createElement('div'); m.className = 'edmenu'; m.id = 'edmenu'; m.setAttribute('role', 'menu');
  m.style.left = Math.max(8, r.left) + 'px'; m.style.top = (r.bottom + 6) + 'px';
  m.innerHTML = (st.editions || []).map(e => `<button role="menuitem" data-ed="${esc(e.id)}" class="${cur && e.id === cur.id ? 'on' : ''}"><span>${esc(e.name)}</span>${cur && e.id === cur.id ? '<b>✓</b>' : ''}</button>`).join('') +
    (st.admin ? `<hr><button role="menuitem" data-act="edNew"><span>+ 새 회차 만들기</span></button><button role="menuitem" data-act="edRename"><span>지금 회차 이름 바꾸기</span></button>${st.sheetUrl ? `<a role="menuitem" href="${esc(st.sheetUrl)}" target="_blank" rel="noopener"><span>지금 회차 시트 열기 ↗</span></a>` : ''}` : '');
  document.body.appendChild(m);
}
function closeEdMenu() { const m = $('#edmenu'); if (m) m.remove(); }
function switchEdition(id) {
  closeEdMenu();
  if (id === store.edition) return;
  store.edition = id; saveStore(); model = null; st.tabs = readCache(); render(); load();
}
function edModal(rename) {
  const cur = curEdition();
  openModal({
    title: rename ? '회차 이름 바꾸기' : '새 회차 만들기', sub: rename ? '' : '구글 드라이브에 새 시트를 만들어요. 작가·주문·정산이 회차마다 따로예요.',
    body: `<div class="field"><label for="edName">회차 이름</label><input class="inp" id="edName" value="${rename && cur ? esc(cur.name) : ''}" placeholder="예: 4th : PLAY!" autocomplete="off"></div>
      ${rename ? '' : '<label class="depi" style="border:0;padding:12px 0 0"><input type="checkbox" id="edLast"><span class="t"><b>작년 선입금·입금 데이터 넣기</b><small>2nd 회차를 만들 때처럼 작년 시트의 주문과 통장 내역을 그대로 가져와요</small></span></label>'}`,
    foot: `<span class="sp"></span><button class="btn" data-act="close">취소</button><button class="btn pri" data-act="save">${rename ? '저장' : '만들기'}</button>`,
    onSave: async () => {
      const name = $('#edName').value.trim(); if (!name) return toast('회차 이름을 넣어 주세요', true);
      const b = document.querySelector('#dim [data-act=save]'); b.disabled = true; b.textContent = rename ? '저장 중' : '시트 만드는 중…';
      try {
        const j = await api(rename ? 'renameEdition' : 'addEdition', rename ? { id: cur.id, name } : { name, fromLastYear: $('#edLast').checked });
        st.editions = j.editions; closeModal();
        if (rename) { toast('이름을 바꿨어요'); render(); } else { toast(`${name} 회차를 만들었어요`); switchEdition(j.edition.id); }
      } catch (e) { toast(e.message, true); b.disabled = false; b.textContent = rename ? '저장' : '만들기'; }
    },
  });
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
    <div class="card gbox"><div id="gbtn"></div></div>
  </div>`;
  return `<div class="hello">
    <h1>행사 관리</h1>
    ${err}
    <div class="card">${connectForm()}</div>
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
  return head('홈', st.demo ? '둘러보기 모드 · 새로고침하면 고친 내용이 사라져요' : '') +
    `<div class="stats">
      ${stat('선입금 주문', cnt(m.live.length) + '<small>건</small>', `입금 완료 ${cnt(m.paid.length)}건`, '', 'orders', m.live.length ? m.paid.length / m.live.length * 100 : 0)}
      ${stat('입금 확인 필요', cnt(diff + none) + '<small>건</small>', `금액·이름 확인 ${diff} · 미입금 ${none}`, diff + none ? 'warn' : 'good', 'match')}
      ${stat('확정 작가', cnt(m.confirmed.length) + '<small>명</small>', `원고 제출 ${sub}명`, '', 'authors', m.confirmed.length ? sub / m.confirmed.length * 100 : 0)}
      ${stat('선입금 금액', won(m.preForm + m.preBank), `폼 결제 ${won(m.preForm)} · 통장 ${won(m.preBank)}`, '', 'money')}
    </div>
    <div class="grid2">
      <div class="card"><h2>확인할 것</h2>${checkList(checks())}</div>
      <div>
        <div class="card"><div class="card-h"><div><h2>제작 수량</h2></div><button class="btn sm" data-go="make">자세히</button></div>
          <div class="kv"><span>엽서북</span><b class="num">${cnt(bTotal)}권</b></div>
          <div class="kv sub"><span>주문 ${cnt(m.bookOrder)} + 작가 ${cnt(m.bookAuthor)} + 추가 ${cnt(m.bookExtra)}</span><b></b></div>
          <div class="kv"><span>포토카드</span><b class="num">${cnt(m.cardOrder + m.cardExtra)}개</b></div>
          <div class="kv sub"><span>족자봉 주문 ${cnt(m.cardOrder)} + 추가 ${cnt(m.cardExtra)}</span><b></b></div>
          <div class="kv"><span>족자봉 (${m.make.length}종)</span><b class="num">${cnt(jTotal)}개</b></div>
          <div class="kv sub"><span>주문 ${cnt(m.make.reduce((a, x) => a + x.order, 0))} + 작가 여분 ${cnt(m.make.reduce((a, x) => a + x.spare, 0))} + 추가 ${cnt(m.make.reduce((a, x) => a + x.add, 0))}</span><b></b></div>
        </div>
        <div class="card"><div class="card-h"><h2>내보내기</h2></div>
          
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
  return head('작가', '', `<button class="btn" data-act="exportReviews">후기 내보내기</button><button class="btn pri" data-act="newRow" data-tab="작가">작가 추가</button>`) +
    `<div class="tools"><div class="seg">${[['ok', '확정 작가'], ['all', '섭외 전체']].map(([k, t]) => `<button aria-selected="${st.authorSeg === k}" data-seg="authorSeg:${k}">${t} ${counts[k]}</button>`).join('')}</div>
      <input class="search" id="authorQ" placeholder="닉네임, X 아이디 검색" value="${esc(st.authorQ)}"></div>
    <div class="tbl-wrap">${list.length ? `<table class="tbl"><thead><tr><th>No</th><th>작가</th><th>수락</th>${st.authorSeg === 'ok' ? '<th class="c">디스코드</th><th>원고</th><th>현장 수령</th><th>후기 (한)</th><th>후기 (일)</th><th>코멘트</th>' : '<th>섭외 메모</th>'}</tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">작가가 없어요</div>'}</div>`;
}

// ---------- 주문 ----------
const ORDER_FILTERS = [
  ['all', '전체', o => o.pay !== 'cancel'], ['check', '입금 확인 필요', o => ['diff', 'none', 'unpaid'].includes(o.pay)],
  ['issue', '문제 있음', o => o.issues.length > 0], ['jokja', '족자봉 확인', o => o.jState === 'check'], ['money', '금액 다름', o => o.amtWarn],
  ['paid', '입금 완료', o => ['form', 'auto', 'linked', 'manual'].includes(o.pay)], ['cancel', '취소', o => o.pay === 'cancel'],
];
function viewOrders() {
  const m = M();
  const [, , fn] = ORDER_FILTERS.find(f => f[0] === st.orderFilter) || ORDER_FILTERS[0];
  const q = normName(st.orderQ);
  let list = m.orders.filter(fn);
  if (q) list = list.filter(o => normName([o.nick, o.name, o.payer, o.recv, o.id, o.phone].join(' ')).includes(q) || String(o.phone).replace(/\D/g, '').endsWith(q));
  const rows = list.map(o => `<tr data-open="order:${esc(o.id)}"${o.pay === 'cancel' ? ' style="opacity:.45"' : ''}>
      <td class="num muted">${o.manualOrder ? '<span class="badge">직접</span>' : esc(o.num)}</td><td><b>${esc(o.nick || o.name)}</b>${partsBadge(o)}<div class="muted" style="font-size:13px">${esc(o.name)}${o.payer && o.payer !== o.name ? ' · 입금 ' + esc(o.payer) : ''}</div>${o.issues.length ? `<div style="margin-top:4px">${issueBadges(o)}</div>` : ''}</td>
      <td class="r num">${o.books || '-'}</td><td>${o.jCount ? `<b class="num">${o.jCount}개</b> ` : ''}${o.jCount || sumObj(o.jk) ? jokjaChips(o.jk) : '<span class="muted">-</span>'} ${jBadge(o)}</td>
      <td class="r num">${won(o.cmpAmt)}${o.amtWarn ? `<div style="font-size:12px;color:var(--orange)">계산 ${won(o.expect)}</div>` : ''}</td><td>${payBadge(o)}</td>
    </tr>`).join('');
  return head('주문', '', `<button class="btn" data-act="exportPos">포스로 내보내기</button><button class="btn" data-act="orderCols">열 설정</button><button class="btn" data-act="newOrder">주문 직접 추가</button><button class="btn pri" data-act="paste" data-tab="선입금 리스트">선입금 데이터 넣기</button>`) +
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
  return head('입금 대조', '', `<button class="btn pri" data-act="paste" data-tab="입금기록">통장 내역 넣기</button>`) +
    `<div class="stats">
      ${stat('통장 입금 주문', cnt(bankOrders.length) + '<small>건</small>', '폼 결제 제외')}
      ${stat('자동·수동 연결', cnt(auto.length + m.live.filter(o => o.pay === 'manual').length) + '<small>건</small>', '', 'good')}
      ${stat('확인 필요', cnt(need.length) + '<small>건</small>', '', need.length ? 'warn' : 'good')}
      ${stat('남은 입금', cnt(m.unusedDeps.length) + '<small>건</small>', won(m.unusedDeps.reduce((a, d) => a + d.amt, 0)), m.unusedDeps.length ? 'warn' : '')}
    </div>
    <div class="card"><div class="card-h"><div><h2>확인이 필요한 주문</h2></div></div>
      ${need.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>주문자</th><th class="r">신청 금액</th><th>상태</th><th>비슷한 입금</th><th></th></tr></thead><tbody>${need.map(o => `<tr>
        <td><b>${esc(o.payer || o.name)}</b><div class="muted" style="font-size:13px">${esc(o.nick)} · ${esc(o.num)}번</div></td>
        <td class="r num">${won(o.total)}${o.deps.length ? `<div style="font-size:12px;color:var(--orange)">연결 ${won(o.depSum)}</div>` : ''}</td><td>${payBadge(o)}</td>
        <td>${(o.cand || []).slice(0, 3).map(d => `<button class="btn sm soft" data-link="${esc(o.id)}" data-dep="${esc(d.key)}">${esc(d.who)} ${won(d.amt)}</button>`).join(' ') || '<span class="muted">-</span>'}</td>
        <td class="r"><button class="btn sm" data-open="order:${esc(o.id)}">처리</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">모두 확인됐어요 🎉</div>'}
    </div>
    <div class="card"><div class="card-h"><div><h2>주문과 연결 안 된 입금</h2></div></div>
      ${m.unusedDeps.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>입금 일시</th><th>입금자명</th><th class="r">금액</th><th>메모</th></tr></thead><tbody>${m.unusedDeps.map(d => `<tr data-open="dep:${esc(d.key)}"><td class="num muted">${esc(d.at)}</td><td><b>${esc(d.who)}</b></td><td class="r num">${won(d.amt)}</td><td class="muted">${esc(d.memo)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">남은 입금이 없어요</div>'}
    </div>
    ${wdCard(m)}
    <div class="card"><div class="card-h"><div><h2>자동으로 연결된 입금</h2></div></div>
      ${auto.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>주문자</th><th>입금자명</th><th class="r">금액</th><th>방법</th></tr></thead><tbody>${auto.map(o => `<tr data-open="order:${esc(o.id)}"><td><b>${esc(o.payer || o.name)}</b> <span class="muted">${esc(o.nick)}</span></td><td>${o.deps.map(d => esc(d.who)).join(' + ')}</td><td class="r num">${won(o.depSum)}</td><td class="muted">${o.pay === 'linked' ? '손으로 연결' : esc(o.how)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">아직 없어요</div>'}
    </div>`;
}

// ---------- 제작 수량 ----------
function viewMake() {
  const m = M();
  const sum = k => m.make.reduce((a, x) => a + x[k], 0);
  const bTotal = m.bookOrder + m.bookAuthor + m.bookExtra;
  return head('제작 수량', '', `<button class="btn" data-act="exportMake">CSV로 받기</button><button class="btn pri" data-act="newRow" data-tab="추가 수량">추가 수량 넣기</button>`) +
    `<div class="stats">
      ${stat('족자봉 전체', cnt(sum('total')) + '<small>개</small>', `${m.make.length}종 · 주문 ${cnt(sum('order'))}`)}
      ${stat('엽서북 전체', cnt(bTotal) + '<small>권</small>', `주문 ${cnt(m.bookOrder)} + 작가 ${cnt(m.bookAuthor)} + 추가 ${cnt(m.bookExtra)}`)}
      ${stat('포토카드 전체', cnt(m.cardOrder + m.cardExtra) + '<small>개</small>', `족자봉 주문 ${cnt(m.cardOrder)} + 추가 ${cnt(m.cardExtra)}`)}
      ${stat('확정 작가', cnt(m.confirmed.length) + '<small>명</small>', `작가 1명당 엽서북 ${m.bookPerAuthor}권`)}
    </div>
    <div class="grid2">
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>넘버</th><th>작가</th><th class="r">주문</th><th class="r">여분</th><th class="r">추가</th><th class="r">최종</th></tr></thead><tbody>
        ${m.make.map(x => `<tr><td class="num"><b>${jName(x.no)}</b></td><td>${x.author ? `<div class="who">${avatar(x.author.nick, x.author.pic, 'sm', x.author.x)}${esc(x.author.nick)}</div>` : '<span class="badge orange">작가 없음</span>'}</td><td class="r num">${x.order}</td><td class="r num muted">${x.spare}</td><td class="r num ${x.add ? '' : 'muted'}" title="${esc(x.adds.map(e => e.who + ' ' + e.n).join(', '))}">${x.add}</td><td class="r num"><b>${x.total}</b></td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="2">합계</td><td class="r num">${sum('order')}</td><td class="r num">${sum('spare')}</td><td class="r num">${sum('add')}</td><td class="r num">${sum('total')}</td></tr></tfoot></table></div>
      <div>${listCard('추가 수량', '', ['구분', '넘버', '개수', '대상', '메모'])}</div>
    </div>`;
}

// ---------- 정산 ----------
function viewMoney() {
  const m = M();
  const incomeList = `<div class="kv"><span>선입금 · 폼 결제</span><b class="num">${won(m.preForm)}</b></div><div class="kv"><span>선입금 · 통장 입금 확인</span><b class="num">${won(m.preBank)}</b></div>${m.refundSum ? `<div class="kv minus"><span>환불</span><b class="num">${won(-m.refundSum)}</b></div>` : ''}` +
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
  return head('정산', '', `${st.admin ? '<button class="btn soft" data-act="dist">분배 · 받을 돈 보기</button>' : ''}<button class="btn" data-act="newRow" data-tab="수입">수입 추가</button><button class="btn pri" data-act="newRow" data-tab="비용">비용 추가</button>`) +
    `<div class="grid2">
      <div class="card"><h2>수입</h2>${incomeList}</div>
      <div class="card"><h2>비용</h2>
        <div class="kv"><span>공동 비용 합계</span><b class="num">${won(m.costShared)}</b></div>
        <div class="kv"><span>공금 미처리 비용</span><b class="num">${won(m.reserveAuto)}</b></div>
        <div class="kv"><span>개인 선정산 대상</span><b class="num">${nPre}명</b></div>
        ${st.admin ? '<button class="btn soft" data-act="dist" style="margin-top:12px">분배 · 받을 돈 보기</button>' : ''}
      </div>
    </div>
    ${listCard('비용', '', [costCol('내용', '항목'), '단가', '개수', '금액', costCol('사용 출처', '출금자'), '처리', '메모'], { amount: true })}
    ${listCard('수입', '', ['항목', '금액', '메모'])}
    <div class="card"><h2>검증</h2>${checkList(checks())}</div>`;
}

// ---------- 예외기록 ----------
function viewMemo() {
  return head('예외기록', '', `<button class="btn pri" data-act="newRow" data-tab="예외기록">기록 추가</button>`) +
    listCard('예외기록', '', ['날짜', '대상', '내용', '상태'], { bare: true });
}

// ---------- 설정 ----------
function viewSettings() {
  return head('설정', '') +
    `<div class="${st.admin ? 'grid2' : ''}">${st.admin ? `<div>${listCard('설정', '', ['항목', '값', '설명'])}</div>` : ''}
    <div>
      <div class="card"><h2>연결</h2>
        ${st.demo ? '<button class="btn pri" data-act="exitDemo">둘러보기 끝내고 연결하기</button>' : useGoogle() && store.tok ? `<div class="me">${avatar(store.tok.name, store.tok.pic)}<div><b>${esc(store.tok.name)}</b><div class="hint">${esc(store.tok.email)}</div></div></div><div class="acts" style="margin-top:14px"><button class="btn danger" data-act="signOut">로그아웃</button></div>` : connectForm()}</div>
      ${st.demo || !CFG.googleClientId || !st.admin ? '' : emailsCard()}
      ${st.demo ? '' : `<div class="card"><h2>테스트 데이터</h2>
        <div class="kv"><span>작년 선입금 주문 (164건)</span><b><button class="btn sm soft" data-act="sample" data-which="orders">불러오기</button></b></div>
        <div class="kv"><span>작년 통장 입금내역 (89건)</span><b><button class="btn sm soft" data-act="sample" data-which="deposits">불러오기</button></b></div>
        <div class="kv"><span>선입금 내역 초기화<br><small class="muted">선입금 리스트 + 직접 추가한 주문 + 주문 처리(입금 연결, 족자봉 고침)</small></span><b><button class="btn sm danger" data-act="reset" data-which="orders">초기화</button></b></div>
        <div class="kv"><span>입금내역 초기화<br><small class="muted">입금기록 + 출금 처리(환불·비용 표시)</small></span><b><button class="btn sm danger" data-act="reset" data-which="deposits">초기화</button></b></div></div>`}
      ${st.demo || useGoogle() ? '' : `<div class="card"><h2>동료에게 주기</h2><p class="sub">시트 메뉴 <b>관리 사이트 → 동료 추가</b>를 누르면 그 사람 전용 링크가 나와요. 링크를 한 번 열면 자동으로 연결되고, 누가 고쳤는지도 남아요. 한 명만 끊을 수도 있어요.</p>
        <div class="acts"><button class="btn soft" data-act="copyLink">내 연결 링크 복사</button></div><p class="hint" style="margin:8px 0 0">내 다른 기기(아이패드, 폰)에서 열 때 쓰세요. 이 링크는 내 키라서 남에게 주면 안 돼요.</p></div>`}
      <div class="card"><h2>원본 데이터 넣기</h2>
        <div class="acts"><button class="btn soft" data-act="paste" data-tab="선입금 리스트">선입금 리스트</button><button class="btn soft" data-act="paste" data-tab="입금기록">입금기록</button></div></div>
      <div class="card"><h2>테마</h2><div class="seg">${[['', '자동'], ['light', '밝게'], ['dark', '어둡게']].map(([k, t]) => `<button aria-selected="${(store.theme || '') === k}" data-theme-set="${k}">${t}</button>`).join('')}</div></div>
    </div></div>`;
}

// ---------- 로그인 허용 계정 ----------
function emailsCard() {
  if (!st.emails) { if (!st.emailsLoading) loadEmails(); return '<div class="card"><h2>로그인 허용 계정</h2><div class="loading" style="min-height:80px"><div class="spin"></div></div></div>'; }
  const e = st.emails;
  return `<div class="card"><h2>로그인 허용 계정</h2>${e.canEdit ? '' : '<p class="sub">시트 주인만 바꿀 수 있어요</p>'}
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
// 비용 탭 열 이름이 바뀌기 전(항목, 출금자) 시트도 읽게
function costCol(now, old) { const h = T('비용').header; return h.includes(now) || !h.includes(old) ? now : old; }
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
  '출금자': ['공금'], '처리': ['미완료', '완료'], '구분': ['족자봉', '엽서북', '포토카드'], '상태': ['확인 필요', '처리 완료'],
};
// 비용의 사용 출처: 공금 + 운영진 (분배 비율에 있는 이름도 자동으로 붙어요)
function sources() { return [...new Set(['공금', '라굴', '하치', '잏엫', ...M().ratios.map(x => x.name)])]; }
function rowForm(tab, rowNo) {
  const t = T(tab);
  const r = rowNo ? t.rows.find(x => x.row === rowNo) : null;
  const cols = t.header.length ? t.header.filter(Boolean) : [];
  const fields = cols.map((c, i) => {
    const v = r ? String(r.raw[i] ?? '') : (c === 'No' && tab === '작가' ? '' : c === '처리' ? '미완료' : ['출금자', '사용 출처'].includes(c) ? '공금' : c === '개수' ? '1' : '');
    const segOpts = tab === '비용' && ['사용 출처', '출금자'].includes(c) ? sources() : tab === '비용' && c === '처리' ? ['미완료', '완료'] : null;
    if (segOpts) {
      const all = v && !segOpts.includes(v) ? [...segOpts, v] : segOpts;
      return `<div class="field"><label>${esc(c)}</label><input type="hidden" data-col="${esc(c)}" id="f${i}" value="${esc(v)}"><div class="seg segf">${all.map(o => `<button type="button" aria-selected="${o === v}" data-segf="f${i}" data-val="${esc(o)}">${esc(o)}</button>`).join('')}</div></div>`;
    }
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
  // 입금 고르기: 연결된 것 → 이름 비슷한 것 → 남은 금액과 가까운 것 순서
  const ns = [o.payer, o.name, o.recv, o.nick].map(normName).filter(x => x.length >= 2);
  const like = d => { const w = normName(d.who); return ns.some(n => w === n || w.includes(n) || n.includes(w)); };
  const left = o.total - o.depSum;
  const pool = [...o.deps, ...m.unusedDeps.filter(d => !o.deps.includes(d)).sort((a, b) => (like(b) - like(a)) || (Math.abs(a.amt - left) - Math.abs(b.amt - left)))];
  const depItems = pool.map(d => `<label class="depi" data-q="${esc(normName(d.who))}"><input type="checkbox" value="${esc(d.key)}" data-amt="${d.amt}" ${o.deps.includes(d) ? 'checked' : ''}>
      <span class="t"><b>${esc(d.who)}</b>${like(d) ? ' <span class="badge blue">이름 비슷</span>' : ''}<small>${esc(d.at)}</small></span><b class="num">${won(d.amt)}</b></label>`).join('');
  const info = [['닉네임', o.nick], ['주문자', o.name], ['입금자', o.payer], ['수령자', o.recv], ['연락처', o.phone], ['수령 방법', o.method], ['주문번호', o.id], ['폼 진행상태', o.formStatus]]
    .map(([k, v]) => `<div class="kv"><span>${k}</span><b>${esc(v || '-')}</b></div>`).join('');
  openModal({
    title: esc(o.nick || o.name), sub: `${esc(o.num)}번 주문 · 엽서북 ${o.books} · 족자봉 ${o.qty} · ${won(o.total)}`, wide: true,
    body: `${o.issues.length ? `<div style="margin-bottom:10px">${o.issues.map(([k, t, d]) => `<div class="kv sub"><span><span class="badge red">${t}</span></span><b>${esc(d)}${k === 'dup' ? ' ' + mergeBtn(o) : ''}</b></div>`).join('')}</div>` : ''}${o.parts ? `<div style="margin-bottom:10px">${o.parts.slice(1).map(p => `<div class="kv sub"><span><span class="badge blue">합친 주문</span> ${esc(p.num)}번 · 엽서북 ${p.books} · 족자봉 ${p.qty} · ${won(p.total)}</span><b><button class="btn sm" data-act="unmerge" data-id="${esc(p.id)}">합치기 풀기</button></b></div>`).join('')}</div>` : ''}<div class="grid2"><div>
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
        <h4 style="margin:14px 0 4px">금액 확인</h4>
        <div class="kv sub"><span>엽서북 ${o.books}권 × ${won(m.priceBook)}</span><b class="num">${won(o.books * m.priceBook)}</b></div>
        <div class="kv sub"><span>족자봉 ${o.jCount}개 × ${won(m.priceJ)}</span><b class="num">${won(o.jCount * m.priceJ)}</b></div>
        ${o.ship ? `<div class="kv sub"><span>배송비</span><b class="num">${won(o.ship)}</b></div>` : ''}
        <div class="kv"><span>실제 개수로 계산</span><b class="num">${won(o.expect)}</b></div>
        <div class="kv"><span>신청 금액</span><b class="num">${won(o.total)}</b></div>
        ${o.refunds.map(d => `<div class="kv sub minus"><span>환불 · ${esc(d.who)} · ${esc(d.at)}</span><b class="num">${won(-d.amt)}</b></div>`).join('')}
        ${o.deps.length || o.pay === 'form' ? `<div class="kv"><span>받은 금액${o.refundSum ? ' (환불 뺌)' : ''}${o.pay === 'form' && o.depSum ? ' (폼 결제 + 추가 입금)' : ''}</span><b class="num">${won(o.paidAmt)}</b></div>` : ''}
        ${o.amtWarn ? `<div class="note warn">${o.cmpLabel}이 계산보다 <b>${won(Math.abs(o.cmpAmt - o.expect))} ${o.cmpAmt > o.expect ? '많아요' : '적어요'}</b>. 족자봉 넘버나 입금 연결을 확인해 주세요.</div>` : '<div class="kv sub"><span style="color:var(--green)">✓ 금액이 맞아요</span><b></b></div>'}
        ${o.how ? `<div class="kv sub"><span>${esc(o.how)}으로 자동 연결됨</span><b></b></div>` : ''}
        <div class="field" style="margin-top:8px"><label for="oPay">입금 처리</label><select class="inp" id="oPay">
          ${[['', '자동 (폼 상태·통장 대조)'], ['확인', '입금 확인 (통장 밖에서 받음)'], ['미입금', '미입금으로 표시'], ['취소', '주문 취소·환불']].map(([v, t]) => `<option value="${v}" ${o.proc.pay === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select></div>
        <div class="field" style="margin-top:12px"><label for="oDepQ">입금 연결 · 나눠서 입금했으면 여러 건 골라요</label>
          <input class="inp" id="oDepQ" placeholder="입금자명 검색" autocomplete="off">
          <div class="deplist" id="oDepList">${depItems || '<div class="empty" style="padding:16px">고를 수 있는 입금이 없어요</div>'}</div>
          <div class="kv"><span>고른 입금 합계</span><b class="num" id="oDepSum"></b></div></div>
        <div class="field" style="margin-top:12px"><label for="oMemo">메모</label><textarea class="inp" id="oMemo">${esc(o.proc.memo || '')}</textarea></div>
      </div></div>`,
    foot: `${o.manualOrder ? `<button class="btn" data-act="editOrder" data-id="${esc(o.id)}">주문 정보 고치기</button>` : ''}<span class="sp"></span><button class="btn" data-act="close">닫기</button><button class="btn pri" data-act="save">저장</button>`,
    onSave: async () => {
      const j = $('#oJ').value.trim(), pay = $('#oPay').value, memo = $('#oMemo').value;
      let keys = [...document.querySelectorAll('#oDepList input:checked')].map(x => x.value);
      if (o.pay === 'auto' && keys.length === 1 && keys[0] === o.dep.key) keys = []; // 자동 연결 그대로
      const values = { '족자봉 확정': j ? jokjaText(parseJokja(j)) : '', '입금 처리': pay, '입금 키': keys.join('\n'), '메모': memo, '수정 시각': new Date().toLocaleString('ko-KR') };
      if (await write('upsert', { sheet: '주문 처리', keyCol: '주문번호', keyVal: o.id, values }, '저장했어요')) closeModal();
    },
  });
  const sum = () => {
    const t = [...document.querySelectorAll('#oDepList input:checked')].reduce((a, x) => a + +x.dataset.amt, 0);
    const el = $('#oDepSum'); el.textContent = `${won(t)} / 신청 ${won(o.total)}`; el.style.color = t === o.total ? 'var(--green)' : t ? 'var(--orange)' : '';
  };
  $('#oDepList').addEventListener('change', sum); sum();
  $('#oDepQ').addEventListener('input', e => {
    const q = normName(e.target.value);
    document.querySelectorAll('#oDepList .depi').forEach(l => { l.hidden = !!q && !l.dataset.q.includes(q) && !l.querySelector('input').checked; });
  });
}

function depModal(key) {
  const m = M(), d = m.deposits.find(x => x.key === key);
  if (!d) return;
  const left = o => o.total - o.depSum;
  const w = normName(d.who);
  const like = o => [o.payer, o.name, o.recv, o.nick].map(normName).filter(x => x.length >= 2).some(n => w.includes(n) || n.includes(w));
  const unpaid = o => !['form', 'auto', 'linked', 'manual'].includes(o.pay);
  const near = m.live.slice().sort((a, b) => (like(b) - like(a)) || (unpaid(b) - unpaid(a)) || (Math.abs(left(a) - d.amt) - Math.abs(left(b) - d.amt)));
  openModal({
    title: `${esc(d.who)} · ${won(d.amt)}`, sub: esc(d.at + (d.bank ? ' · ' + d.bank : '')),
    body: `<div class="field"><label for="dO">연결할 주문</label><select class="inp" id="dO"><option value="">골라 주세요</option>${near.map(o => `<option value="${esc(o.id)}">${like(o) ? '★ ' : ''}${esc(o.payer || o.name)} (${esc(o.nick)}) · ${won(o.total)} · ${(PAY[o.pay] || [''])[0]}${o.depSum && unpaid(o) ? ' · 남은 ' + won(left(o)) : ''}</option>`).join('')}</select>
      <span class="hint">★ 이름 비슷한 주문이 위에 있어요. 이미 입금된 주문에도 연결할 수 있어요.</span></div>
      <div class="field" style="margin-top:12px"><label for="dAdd">추가로 산 족자봉 (추가 구매일 때만)</label><input class="inp" id="dAdd" placeholder="${jAlpha ? '예: F' : '예: 6'}" autocomplete="off"><span class="hint" id="dAddH"></span></div>`,
    foot: `<button class="btn soft" data-act="newOrderFromDep" data-dep="${esc(d.key)}">이 입금으로 새 주문</button><span class="sp"></span><button class="btn" data-act="close">취소</button><button class="btn pri" data-act="save">연결</button>`,
    onSave: async () => {
      const id = $('#dO').value; if (!id) return toast('주문을 골라 주세요', true);
      const add = parseJokja($('#dAdd').value);
      if (await linkDep(id, key, sumObj(add) ? add : null)) closeModal();
    },
  });
  $('#dAdd').addEventListener('input', () => { const a = parseJokja($('#dAdd').value); $('#dAddH').textContent = sumObj(a) ? `족자봉 ${jokjaText(a)} (${sumObj(a)}개 · ${won(sumObj(a) * m.priceJ)})를 그 주문에 더해요` : ''; });
}
// ---------- 출금 (환불 / 비용 / 기타) ----------
const WD_KIND = { '환불': 'red', '비용': 'blue', '기타': '' };
function wdCard(m) {
  const list = m.withdrawals.slice().sort((a, b) => (!!(a.wp && a.wp.kind) - !!(b.wp && b.wp.kind)) || (a.at < b.at ? 1 : -1));
  const ord = id => m.orders.find(o => o.id === id);
  return `<div class="card"><div class="card-h"><div><h2>출금 내역</h2></div></div>
    ${list.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>출금 일시</th><th>받는 분 / 적요</th><th class="r">금액</th><th>구분</th><th>주문</th></tr></thead><tbody>${list.map(d => {
      const k = d.wp && d.wp.kind, o = k === '환불' && ord(d.wp.order);
      return `<tr data-open="wd:${esc(d.key)}"><td class="num muted">${esc(d.at)}</td><td><b>${esc(d.who)}</b>${d.wp && d.wp.memo ? `<div class="muted" style="font-size:13px">${esc(d.wp.memo)}</div>` : ''}</td><td class="r num">${won(d.amt)}</td>
        <td>${k ? `<span class="badge ${WD_KIND[k] || ''}">${esc(k)}</span>` : '<span class="badge orange">분류 필요</span>'}</td><td>${o ? `${esc(o.nick || o.name)}${o.pay === 'cancel' ? ' <span class="badge">취소</span>' : ''}` : '<span class="muted">-</span>'}</td></tr>`;
    }).join('')}</tbody></table></div>` : '<div class="empty">출금이 없어요</div>'}</div>`;
}
function wdModal(key) {
  const m = M(), d = m.withdrawals.find(x => x.key === key);
  if (!d) return;
  const wp = d.wp || {}, kind = wp.kind || '환불';
  const w = normName(d.who);
  const like = o => [o.payer, o.name, o.recv, o.nick].map(normName).filter(x => x.length >= 2).some(n => w.includes(n) || n.includes(w));
  const list = m.orders.slice().sort((a, b) => (like(b) - like(a)) || (Math.abs(a.paidAmt - d.amt) - Math.abs(b.paidAmt - d.amt)));
  const cur = m.orders.find(o => o.id === wp.order);
  openModal({
    title: `출금 · ${esc(d.who)} · ${won(d.amt)}`, sub: esc(d.at),
    body: `<div class="field"><label>구분</label><input type="hidden" id="wK" value="${esc(kind)}"><div class="seg segf">${Object.keys(WD_KIND).map(k => `<button type="button" aria-selected="${k === kind}" data-segf="wK" data-val="${k}">${k}</button>`).join('')}</div></div>
      <div class="field" style="margin-top:12px" id="wOBox"><label for="wO">환불한 주문</label><select class="inp" id="wO"><option value="">골라 주세요</option>${list.map(o => `<option value="${esc(o.id)}" ${o.id === wp.order ? 'selected' : ''}>${like(o) ? '★ ' : ''}${esc(o.payer || o.name)} (${esc(o.nick)}) · 받은 ${won(o.paidAmt)}${o.pay === 'cancel' ? ' · 취소됨' : ''}</option>`).join('')}</select>
        <label class="depi" style="border:0;padding:10px 0 0"><input type="checkbox" id="wCancel" ${cur && cur.pay === 'cancel' ? 'checked' : ''}><span class="t"><b>주문 전체 취소</b><small>체크하면 주문 목록·제작 수량·포스 명단에서 빠져요. 일부만 환불했으면 체크하지 말고 족자봉 넘버를 고쳐 주세요.</small></span></label></div>
      <div class="field" style="margin-top:12px"><label for="wM">메모</label><input class="inp" id="wM" value="${esc(wp.memo || '')}" autocomplete="off"></div>`,
    foot: `${d.wp && d.wp.kind ? '<button class="btn danger" data-act="delRow">분류 지우기</button>' : ''}<span class="sp"></span><button class="btn" data-act="close">취소</button><button class="btn pri" data-act="save">저장</button>`,
    onSave: async (act) => {
      const now = new Date().toLocaleString('ko-KR');
      if (act === 'del') { if (await write('upsert', { sheet: '출금 처리', keyCol: '출금 키', keyVal: key, values: { '구분': '', '주문번호': '', '메모': '', '수정 시각': now } }, '분류를 지웠어요')) closeModal(); return; }
      const k = $('#wK').value, oid = k === '환불' ? $('#wO').value : '';
      if (k === '환불' && !oid) return toast('환불한 주문을 골라 주세요', true);
      const ok = await write('upsert', { sheet: '출금 처리', keyCol: '출금 키', keyVal: key, values: { '구분': k, '주문번호': oid, '메모': $('#wM').value.trim(), '수정 시각': now } }, '저장했어요');
      if (ok && oid) {
        const o = M().orders.find(x => x.id === oid), cancel = $('#wCancel').checked;
        if (cancel && o.proc.pay !== '취소') await write('upsert', { sheet: '주문 처리', keyCol: '주문번호', keyVal: oid, values: { '입금 처리': '취소', '수정 시각': now } });
        if (!cancel && o.proc.pay === '취소') await write('upsert', { sheet: '주문 처리', keyCol: '주문번호', keyVal: oid, values: { '입금 처리': '', '수정 시각': now } });
      }
      if (ok) closeModal();
    },
  });
  const sync = () => { $('#wOBox').hidden = $('#wK').value !== '환불'; };
  $('#wK').addEventListener('change', sync); sync();
}

// 주문 직접 추가 / 고치기 (수동 주문 탭). dep 를 주면 저장하면서 그 입금을 바로 연결해요.
function newOrderModal({ edit = null, dep = null } = {}) {
  const m = M(), r = edit ? edit.r : null, g = c => (r ? r.get(c) : '');
  const pre = { nick: g('닉네임'), name: g('이름') || (dep ? dep.who : ''), payer: g('입금자명') || (dep ? dep.who : ''), phone: g('연락처'),
    books: r ? g('엽서북') : '1', j: g('족자봉'), total: r ? g('총 주문금액') : (dep ? String(dep.amt) : ''), method: g('수령 방법') || '현장', memo: g('메모') };
  const f = (id, label, v, extra = '') => `<div class="field"><label for="${id}">${label}</label><input class="inp" id="${id}" value="${esc(v)}" autocomplete="off" ${extra}></div>`;
  openModal({
    title: edit ? '주문 정보 고치기' : '주문 직접 추가', sub: dep ? `${esc(dep.who)} · ${won(dep.amt)} 입금과 바로 연결돼요` : '',
    body: `<div class="fields">
      ${f('nO_nick', '닉네임', pre.nick)}${f('nO_name', '이름', pre.name)}
      ${f('nO_payer', '입금자명', pre.payer, 'placeholder="이름과 같으면 비워도 돼요"')}${f('nO_phone', '연락처', pre.phone, 'inputmode="tel" placeholder="010-0000-0000"')}
      ${f('nO_books', '엽서북 (권)', pre.books, 'inputmode="numeric"')}${f('nO_j', '족자봉 넘버', pre.j, `placeholder="${jAlpha ? '예: A, C×2' : '예: 2, 7×2'}"`)}
      <div class="field"><label for="nO_total">금액</label><input class="inp" id="nO_total" value="${esc(pre.total)}" inputmode="numeric"><span class="hint" id="nO_calc"></span></div>
      <div class="field"><label>수령 방법</label><input type="hidden" id="nO_method" value="${esc(pre.method)}"><div class="seg segf">${['현장', '택배'].map(x => `<button type="button" aria-selected="${x === pre.method}" data-segf="nO_method" data-val="${x}">${x}</button>`).join('')}</div></div>
      <div class="field full"><label for="nO_memo">메모</label><textarea class="inp" id="nO_memo">${esc(pre.memo)}</textarea></div>
    </div>`,
    foot: `${edit ? '<button class="btn danger" data-act="delRow">주문 삭제</button>' : ''}<span class="sp"></span><button class="btn" data-act="close">취소</button><button class="btn pri" data-act="save">저장</button>`,
    onSave: async (act) => {
      if (act === 'del') {
        if (!confirm('이 주문을 지울까요?')) return;
        if (await write('remove', { sheet: '수동 주문', row: edit.row, match: { '주문번호': edit.id } }, '지웠어요')) closeModal();
        return;
      }
      const v = id => $('#' + id).value.trim();
      if (!v('nO_nick') && !v('nO_name')) return toast('닉네임이나 이름을 넣어 주세요', true);
      const jk = parseJokja(v('nO_j'));
      const values = { '닉네임': v('nO_nick'), '이름': v('nO_name'), '입금자명': v('nO_payer'), '연락처': v('nO_phone'), '엽서북': String(toNum(v('nO_books'))),
        '족자봉': jokjaText(jk), '총 주문금액': String(toNum(v('nO_total')) || calc()), '수령 방법': v('nO_method'), '메모': v('nO_memo') };
      let ok;
      if (edit) ok = await write('update', { sheet: '수동 주문', row: edit.row, values, match: { '주문번호': edit.id } }, '저장했어요');
      else {
        const id = 'M' + Date.now().toString(36).toUpperCase();
        ok = await write('append', { sheet: '수동 주문', values: { '주문번호': id, '작성시간': new Date().toLocaleString('ko-KR'), ...values } }, '주문을 추가했어요');
        if (ok && dep) await linkDep(id, dep.key);
      }
      if (ok) closeModal();
    },
  });
  const calc = () => toNum($('#nO_books').value) * m.priceBook + sumObj(parseJokja($('#nO_j').value)) * m.priceJ;
  const upd = () => {
    const c = calc(), jk = parseJokja($('#nO_j').value);
    $('#nO_calc').textContent = `계산 ${won(c)} (엽서북 ${toNum($('#nO_books').value)} · 족자봉 ${sumObj(jk)}${sumObj(jk) ? ': ' + jokjaText(jk) : ''})`;
    $('#nO_calc').style.color = toNum($('#nO_total').value) && toNum($('#nO_total').value) !== c ? 'var(--orange)' : '';
  };
  ['nO_books', 'nO_j', 'nO_total'].forEach(id => $('#' + id).addEventListener('input', upd)); upd();
}
// add: 추가 구매한 족자봉 {넘버: 개수} 이면 그 주문의 확정 넘버에 더해요
function linkDep(id, key, add = null) {
  const o = M().orders.find(x => x.id === id);
  const keys = o && o.pay !== 'auto' ? o.deps.map(d => d.key) : o && o.dep ? [o.dep.key] : [];
  if (!keys.includes(key)) keys.push(key);
  const values = { '입금 키': keys.join('\n'), '수정 시각': new Date().toLocaleString('ko-KR') };
  if (!o || o.proc.pay !== '확인') values['입금 처리'] = '';
  if (add && o) { const j = { ...o.jk }; Object.entries(add).forEach(([n, q]) => { j[n] = (j[n] || 0) + q; }); values['족자봉 확정'] = jokjaText(j); }
  return write('upsert', { sheet: '주문 처리', keyCol: '주문번호', keyVal: id, values }, add ? '추가 구매로 연결했어요' : '연결했어요');
}

// ---------------------------------------------------------------------
// 원본 붙여넣기 (위치폼 / 통장)
// ---------------------------------------------------------------------
const NEED = { '입금기록': ['적요', '거래 금액'] };
// 선입금 리스트: 순번 열에 숫자가 처음 나오는 줄의 바로 윗줄이 제목 줄이에요. (열 제목 글자는 안 봐요)
const headerRow = (tab, rows) => {
  if (tab !== '선입금 리스트') return rows.findIndex(r => NEED[tab].every(n => r.map(x => String(x).trim()).includes(n)));
  const c = orderCols().num, first = rows.findIndex(r => /^\d+$/.test(String(r[c] ?? '').trim()));
  return first > 0 ? first - 1 : -1;
};
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
  const need = NEED[tab] || [`${colName(orderCols().num)}열 순번`];
  openModal({
    title: `${tab} 넣기`, wide: true,
    sub: tab === '입금기록' ? '은행 앱에서 받은 거래내역(엑셀)을 통째로 복사해서 붙여넣어요.' : '위치폼에서 받은 엑셀을 열고 전체 선택(⌘A) → 복사해서 붙여넣어요.',
    body: `<div class="note"><b>${tab}</b> 탭 내용이 통째로 바뀌어요. 첫 줄 위에 제목 줄이 있어도 괜찮아요. 꼭 있어야 하는 열: ${need.map(n => `<code>${n}</code>`).join(' ')}</div>
      <textarea class="inp" id="pTxt" style="min-height:220px;font-size:13px" placeholder="여기에 붙여넣기"></textarea>
      <div class="acts" style="margin-top:10px"><button class="btn sm" data-act="pickFile">CSV 파일 고르기</button><span class="hint" id="pInfo"></span></div>`,
    foot: `<span class="sp"></span><button class="btn" data-act="close">취소</button><button class="btn pri" data-act="save">시트에 저장</button>`,
    onSave: async () => {
      const rows = parseTable($('#pTxt').value);
      const hi = headerRow(tab, rows);
      if (hi < 0) return toast(NEED[tab] ? `${need.join(', ')} 열이 있는 줄을 못 찾았어요` : `${need[0]}에 숫자가 있는 줄을 못 찾았어요. 열 설정을 확인해 주세요`, true);
      let data = rows.slice(hi);
      if (tab === '선입금 리스트') { const c = orderCols(); data = [data[0], ...data.slice(1).filter(r => String(r[c.id] ?? '').trim() || String(r[c.num] ?? '').trim())]; }
      if (!confirm(`${tab}에 ${data.length - 1}줄을 저장할까요? 지금 탭 내용은 지워져요.`)) return;
      if (await write('replace', { sheet: tab, rows: data }, `${data.length - 1}줄을 저장했어요`)) closeModal();
    },
  });
  $('#pTxt').addEventListener('input', () => {
    const rows = parseTable($('#pTxt').value), hi = headerRow(tab, rows);
    $('#pInfo').textContent = rows.length ? (hi < 0 ? `${rows.length}줄 · 필요한 열을 못 찾았어요` : `${rows.length - hi - 1}줄을 찾았어요`) : '';
  });
}
// 같은 연락처로 들어온 주문들을 하나로 합쳐요. 순번이 가장 앞선 주문에 나머지를 더해요.
function mergeModal(id) {
  const m = M(), o = m.orders.find(x => x.id === id);
  if (!o || !(o.dupIds || []).length) return;
  const group = m.orders.filter(x => x === o || o.dupIds.includes(x.id)), [to, ...rest] = group;
  const jk = group.reduce((a, x) => { Object.entries(x.jk).forEach(([k, v]) => { a[k] = (a[k] || 0) + v; }); return a; }, {});
  const sum = k => group.reduce((a, x) => a + x[k], 0);
  const card = x => `<div class="card" style="margin:0"><div class="card-h"><h2>${esc(x.num)}번 · ${esc(x.nick || x.name)}</h2>${payBadge(x)}</div>
      ${[['이름', esc(x.name)], ['입금자', esc(x.payer)], ['연락처', esc(x.phone)], ['엽서북', x.books + '권'], ['족자봉', jokjaChips(x.jk)], ['금액', won(x.total)]].map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v || '-'}</b></div>`).join('')}</div>`;
  openModal({
    title: '정말 합칠까요?', wide: true,
    body: `<div class="grid2">${group.map(card).join('')}</div>
      <div class="card" style="margin:12px 0 0"><div class="card-h"><h2>합친 뒤 · ${esc(to.num)}번</h2></div>
        <div class="kv"><span>엽서북</span><b>${sum('books')}권</b></div><div class="kv"><span>족자봉</span><b>${jokjaChips(jk)}</b></div><div class="kv"><span>금액</span><b class="num">${won(sum('total'))}</b></div></div>`,
    foot: `<span class="sp"></span><button class="btn" data-act="close">취소</button><button class="btn pri" data-act="save">합치기</button>`,
    onSave: async () => {
      const now = new Date().toLocaleString('ko-KR');
      let ok = true;
      for (const x of rest) ok = await write('upsert', { sheet: '주문 처리', keyCol: '주문번호', keyVal: x.id, values: { '합침': to.id, '수정 시각': now } }) && ok;
      if (ok) { closeModal(); toast(`${rest.map(x => x.num + '번').join(', ')} 주문을 ${to.num}번에 합쳤어요`); }
    },
  });
}
async function unmerge(id) {
  if (!confirm('합친 주문을 다시 따로 나눌까요?')) return;
  if (await write('upsert', { sheet: '주문 처리', keyCol: '주문번호', keyVal: id, values: { '합침': '', '수정 시각': new Date().toLocaleString('ko-KR') } }, '합치기를 풀었어요')) closeModal();
}
// 선입금 리스트의 어느 열을 어떤 값으로 읽을지 고르는 창
function orderColsModal() {
  const t = (st.tabs && st.tabs['선입금 리스트']) || { header: [], rows: [] }, cur = orderCols();
  const n = Math.max(30, t.header.length, ...Object.values(cur).map(i => i + 1));
  const clip = v => { v = String(v ?? '').trim(); return v.length > 28 ? v.slice(0, 28) + '…' : v; };
  const opts = sel => '<option value="">안 씀</option>' + Array.from({ length: n }, (_, i) => {
    const h = clip(t.header[i]), ex = clip((t.rows.find(r => String(r[i] ?? '').trim()) || [])[i]);
    return `<option value="${colName(i)}" ${i === sel ? 'selected' : ''}>${colName(i)}${h ? ' · ' + esc(h) : ''}${ex ? ' (' + esc(ex) + ')' : ''}</option>`;
  }).join('');
  openModal({
    title: '선입금 리스트 열 설정', wide: true,
    body: `<div class="grid2">${ORDER_FIELDS.map(([k, label]) => `<div class="field"><label for="oc_${k}">${label}</label><select class="inp" id="oc_${k}">${opts(cur[k])}</select></div>`).join('')}</div>`,
    foot: `<button class="btn" data-act="orderColsReset">처음 값으로</button><span class="sp"></span><button class="btn" data-act="close">취소</button><button class="btn pri" data-act="save">저장</button>`,
    onSave: async (act) => {
      if (act === 'orderColsReset') { ORDER_FIELDS.forEach(([k, , def]) => { $('#oc_' + k).value = def; }); return; }
      const v = ORDER_FIELDS.map(([k, label]) => `${label}=${$('#oc_' + k).value}`).join(', ');
      if (!$('#oc_num').value) return toast('순번 열은 꼭 골라 주세요', true);
      if (await write('upsert', { sheet: '설정', keyCol: '항목', keyVal: ORDER_COLS_KEY, values: { '값': v } }, '열 설정을 저장했어요')) closeModal();
    },
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
  const useLetters = m.posAlpha;
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
    [], ['엽서북', '', m.bookOrder, m.bookAuthor, m.bookExtra, m.bookOrder + m.bookAuthor + m.bookExtra],
    ['포토카드', '', m.cardOrder, 0, m.cardExtra, m.cardOrder + m.cardExtra]]);
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
  const sf = e.target.closest('[data-segf]');
  if (sf) { const h = document.getElementById(sf.dataset.segf); h.value = sf.dataset.val; sf.parentElement.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', b === sf)); h.dispatchEvent(new Event('change')); return; }
  const pk = e.target.closest('[data-pick-for]');
  if (pk) {
    const inp = document.getElementById(pk.dataset.pickFor); inp.value = pk.dataset.pick;
    pk.parentElement.querySelectorAll('.pick').forEach(b => b.classList.toggle('on', b === pk)); return;
  }
  const edi = e.target.closest('[data-ed]');
  if (edi) return switchEdition(edi.dataset.ed);
  if (!e.target.closest('#edmenu') && !e.target.closest('[data-act=edMenu]')) closeEdMenu();
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
    if (kind === 'wd') return wdModal(rest.join(':'));
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
  if (act === 'edMenu') { e.stopPropagation(); return $('#edmenu') ? closeEdMenu() : edMenu(); }
  if (act === 'edNew') { closeEdMenu(); return edModal(false); }
  if (act === 'edRename') { closeEdMenu(); return edModal(true); }
  if (act === 'newOrder') return newOrderModal();
  if (act === 'orderCols') return orderColsModal();
  if (act === 'mergeAsk') { e.stopPropagation(); return mergeModal(el.dataset.id); }
  if (act === 'unmerge') return unmerge(el.dataset.id);
  if (act === 'orderColsReset') return modalSave && modalSave('orderColsReset');
  if (act === 'newOrderFromDep') return newOrderModal({ dep: M().deposits.find(d => d.key === el.dataset.dep) });
  if (act === 'editOrder') return newOrderModal({ edit: M().orders.find(o => o.id === el.dataset.id) });
  if (act === 'relogin') { delete store.key; delete store.who; delete store.tok; saveStore(); dropCache(); st.tabs = null; st.err = ''; return render(); }
  if (act === 'dist') { if (!st.admin) return; viewMoney(); return openModal({ title: '분배 · 받을 돈', sub: '관리자만 볼 수 있어요', body: st.distHtml, foot: '<span class="sp"></span><button class="btn pri" data-act="close">닫기</button>' }); }
  if (act === 'emailAdd') {
    const v = $('#newEmail').value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return toast('이메일 주소를 확인해 주세요', true);
    if (st.emails.list.includes(v) || v === st.emails.owner) return toast('이미 있는 계정이에요', true);
    return saveEmails([...st.emails.list, v]);
  }
  if (act === 'sample' || act === 'reset') {
    const w = el.dataset.which, what = w === 'orders' ? '선입금 리스트' : '입금기록';
    const msg = act === 'sample' ? `작년 ${what} 샘플로 ${what} 탭을 덮어쓸까요?` : `${w === 'orders' ? '선입금 리스트, 직접 추가한 주문, 주문 처리' : '입금기록, 출금 처리'} 탭 내용을 모두 지울까요? 되돌릴 수 없어요.`;
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
