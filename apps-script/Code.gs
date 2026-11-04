/**
 * 행사 관리 사이트용 Apps Script
 * ------------------------------------------------------------------
 * 새 구글 시트 → 확장 프로그램 → Apps Script 에 이 파일 내용을 통째로 붙여넣어요.
 * 자세한 순서는 저장소의 apps-script/README.md 를 봐 주세요.
 *
 * 이 스크립트는 '시트 주인 권한'으로 시트를 읽고 써요.
 * 시트 자체는 비공개로 두고, 사이트는 비밀키를 아는 사람만 쓸 수 있어요.
 */

// 작년 시트 ID (작가 섭외 / 확정 작가 리스트를 가져올 곳). 다른 시트에서 가져오려면 여기만 바꿔요.
const SOURCE_SHEET_ID = '13ovtJ2eaVsNqu52vkqcdg2lriarol2KCzQFIxzpGbTY';

// 관리 사이트 주소. 동료용 연결 링크를 만들 때 써요.
const SITE_URL = 'https://kkkougaa.github.io/project_seiroku/admin/';

// 이 스크립트의 웹 앱 주소 (배포 후 채워 둠)
const DEPLOYED_URL = 'https://script.google.com/macros/s/AKfycbxtSj0sZ3KUpgC11YHqN_HDLPYhbzyRV61sk00vSbxHpw9o95DiF7ULEMYbqw3ddghL/exec';

// 구글 로그인 ---------------------------------------------------------
// GOOGLE_CLIENT_ID: Google Cloud 에서 만든 OAuth 클라이언트 ID (www/admin/settings.js 와 같은 값)
// ALLOWED_EMAILS : 들어올 수 있는 구글 계정. 시트 메뉴 '구글 계정 허용 관리'로도 더할 수 있어요.
//                  보통은 사이트 설정 → 로그인 허용 계정 에서 관리해요. 시트 주인 계정은 항상 들어올 수 있어요.
const GOOGLE_CLIENT_ID = '75198476685-1jiqig544kvoephkcirpqbp5cp37aoqq.apps.googleusercontent.com';
const ALLOWED_EMAILS = [];

// 탭 이름과 열 구조. 사이트가 이 열 이름으로 값을 찾아요. (열 순서는 바꿔도 되지만 이름은 그대로 둬요)
const TABS = {
  '작가': ['No', '닉네임', 'X 아이디', '수락 여부', '섭외 메모', '디스코드', '제출 여부', '현장 수령',
    '후기 (한)', '후기 (일)', '작업 폴더 링크', '주소', '계좌번호', '실명', '기타', '프로필 사진'],
  '선입금 리스트': ['번호', '작성시간', '엽서북', '족자봉', '배송방법', '배송비', '총 주문금액', '주문자명', '닉네임',
    '주문자연락처', '결제날짜', '수령자명', '수령자연락처', '우편번호', '주소', '배송메모', '환불은행', '환불계좌',
    '환불예금주', '총 주문금액', '이메일', '족자봉', '트위터계정', '인스타계정', '택배사', '운송장번호', '진행상태', '메모', '주문번호'],
  '입금기록': ['거래 일시', '적요', '거래 유형', '거래 기관', '계좌번호', '거래 금액', '거래 후 잔액', '메모'],
  '주문 처리': ['주문번호', '족자봉 확정', '입금 처리', '입금 키', '메모', '수정 시각', '수정한 사람'],
  '추가 수량': ['구분', '넘버', '개수', '대상', '메모'],
  '수입': ['항목', '금액', '메모'],
  '비용': ['항목', '단가', '개수', '출금자', '처리', '메모'],
  '예외기록': ['날짜', '대상', '내용', '상태'],
  '설정': ['항목', '값', '설명'],
};

// 붙여넣는 원본 데이터 탭은 전부 '글자'로 저장해요. (환불계좌가 3.33E+12 처럼 깨지는 것 방지)
const TEXT_TABS = ['선입금 리스트', '입금기록'];

const DEFAULT_SETTINGS = [
  ['엽서북 가격', 20000, '선입금 1권 가격'],
  ['족자봉 가격', 25000, '선입금 1개 가격'],
  ['작가 여분 족자봉', 1, '족자봉 넘버마다 작가 몫으로 더 만드는 개수'],
  ['작가 증정 엽서북', 1, '확정 작가 1명당 엽서북 권수'],
  ['분배 비율', '잏엫 5, 하치 4, 라굴 1', '수익 분배. "이름 비율" 을 쉼표로 구분'],
  ['현재 잔고 + 현금', '', '정산할 때 통장 잔고와 현금을 더한 금액'],
  ['남겨둘 금액', '', '분배하지 않고 남겨둘 돈 (비워두면 공금 미처리 비용 합계)'],
  ['족자봉 표기', '알파벳', '족자봉 넘버를 A, B, C 로 쓸지 (알파벳 / 숫자). 작가 No 1 = A'],
];

// ------------------------------------------------------------------
// 시트 메뉴
// ------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('관리 사이트')
    .addItem('1. 처음 설정 (탭 만들기 + 작가 가져오기)', 'setup')
    .addItem('내 연결 링크 / 비밀키 보기', 'showKey')
    .addItem('비밀키 새로 만들기', 'resetKey')
    .addSeparator()
    .addItem('동료 추가 (개인 연결 링크 만들기)', 'addMember')
    .addItem('동료 목록 / 연결 끊기', 'manageMembers')
    .addItem('웹 앱 주소 바꾸기', 'setWebAppUrl')
    .addSeparator()
    .addItem('구글 계정 허용 관리', 'manageEmails')
    .addSeparator()
    .addItem('작년 선입금/입금 데이터 가져오기 (연습용)', 'importLastYearOrders')
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActive();
  ensureTabs_();
  const def = ss.getSheetByName('시트1') || ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
  let msg = '탭을 만들었어요.';
  const au = ss.getSheetByName('작가');
  if (au.getLastRow() <= 1) {
    try { msg += '\n작가 ' + importAuthors_() + '명을 작년 시트에서 가져왔어요.'; }
    catch (e) { msg += '\n작가 가져오기 실패: ' + e.message; }
  }
  const key = getKey_();
  SpreadsheetApp.getUi().alert(msg + '\n\n이제 관리 사이트를 쓸 수 있어요.\n(비밀키 연결용: ' + key + ')');
}

// 탭이 없으면 만들어요. 사이트에서 처음 부를 때도 알아서 해요.
function ensureTabs_() {
  const cache = CacheService.getScriptCache();
  if (cache.get('tabs-ok')) return;
  const ss = SpreadsheetApp.getActive();
  Object.entries(TABS).forEach(([name, header]) => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    if (TEXT_TABS.includes(name)) sh.getRange('A:AZ').setNumberFormat('@');
  });
  const st = ss.getSheetByName('설정');
  if (st.getLastRow() <= 1) st.getRange(2, 1, DEFAULT_SETTINGS.length, 3).setValues(DEFAULT_SETTINGS);
  const au = ss.getSheetByName('작가');
  if (au.getLastRow() <= 1 && !PropertiesService.getScriptProperties().getProperty('AUTHORS_IMPORTED')) {
    PropertiesService.getScriptProperties().setProperty('AUTHORS_IMPORTED', '1');
    try { importAuthors_(); } catch (e) { /* 작년 시트를 못 열면 빈 탭으로 둬요 */ }
  }
  cache.put('tabs-ok', '1', 600);
}

// 섭외 진행 + 확정 작가 리스트를 한 탭(작가)으로 합쳐요. X 아이디로 짝을 맞춰요.
function importAuthors_() {
  const src = SpreadsheetApp.openById(SOURCE_SHEET_ID);
  const sv = src.getSheetByName('섭외 진행').getDataRange().getDisplayValues();
  const cv = src.getSheetByName('확정 작가 리스트').getDataRange().getDisplayValues();
  const ch = cv[0], byX = {};
  cv.slice(1).forEach(r => { const x = String(r[ch.indexOf('X 아이디')] || '').trim().toLowerCase(); if (x) byX[x] = r; });
  const pick = (r, name) => { const i = ch.indexOf(name); return r && i >= 0 ? r[i] : ''; };
  let no = 0;
  const rows = sv.slice(1).filter(r => r[0] || r[1]).map(r => {
    const ok = String(r[2]).trim() === '수락';
    const c = byX[String(r[1]).trim().toLowerCase()];
    return [ok ? ++no : '', r[0], r[1], r[2], r[3], pick(c, '디스코드'), pick(c, '제출 여부'), pick(c, '현장 수령'),
      pick(c, '후기 (한)'), pick(c, '후기 (일)'), pick(c, '작업 폴더 링크'), pick(c, '주소'), pick(c, '계좌번호'), pick(c, '실명'), pick(c, '기타'), ''];
  });
  if (rows.length) SpreadsheetApp.getActive().getSheetByName('작가').getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  return rows.length;
}

// 작년 선입금 리스트(A~AC)와 입금기록(A~H)을 그대로 복사해요. 사이트를 미리 연습해볼 때만 써요.
function importLastYearOrders() {
  const ui = SpreadsheetApp.getUi();
  if (ui.alert('작년 선입금/입금 데이터로 덮어쓸까요?', '지금 선입금 리스트, 입금기록 탭 내용이 지워져요.', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  ui.alert('선입금 ' + sample_('orders') + '건, 입금 ' + sample_('deposits') + '건을 가져왔어요.');
}

// 작년 데이터를 연습용으로 복사해요. orders = 선입금 리스트(A~AC), deposits = 입금기록(A~H)
function sample_(which) {
  const src = SpreadsheetApp.openById(SOURCE_SHEET_ID);
  if (which === 'orders') {
    const o = src.getSheetByName('선입금 리스트').getRange('A:AC').getDisplayValues().filter((r, i) => i === 0 || (r[0] && /^\d+$/.test(r[0])));
    replace_('선입금 리스트', o);
    return o.length - 1;
  }
  if (which === 'deposits') {
    const d = src.getSheetByName('입금기록').getRange('A:H').getDisplayValues().filter(r => r.some(Boolean));
    replace_('입금기록', d);
    return d.length - 1;
  }
  throw new Error('모르는 샘플이에요: ' + which);
}

// orders: 선입금 리스트 + 주문 처리 를 비워요 / deposits: 입금기록을 비워요 (첫 줄 제목은 남겨요)
function reset_(which) {
  const names = which === 'orders' ? ['선입금 리스트', '주문 처리'] : which === 'deposits' ? ['입금기록'] : null;
  if (!names) throw new Error('모르는 초기화예요: ' + which);
  names.forEach(n => { const sh = sheet_(n); if (sh.getLastRow() > 1) sh.deleteRows(2, sh.getLastRow() - 1); });
}

// X 프로필 사진 주소를 받아서 작가 탭 '프로필 사진' 열에 저장해요. (한 번 받으면 다시 안 받아요)
//  handles 를 주면 그 아이디만 다시 받아요 (사진이 바뀌어서 깨졌을 때)
function avatars_(handles) {
  const sh = sheet_('작가');
  const header = header_(sh);
  let pi = colIndex_(header, '프로필 사진');
  if (pi < 0) { pi = header.length; sh.getRange(1, pi + 1).setValue('프로필 사진').setFontWeight('bold'); header.push('프로필 사진'); }
  const xi = colIndex_(header, 'X 아이디');
  if (xi < 0 || sh.getLastRow() < 2) return {};
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, header.length).getDisplayValues();
  const want = handles ? handles.map(h => String(h).replace(/^@/, '').toLowerCase()) : null;
  const out = {}, started = Date.now();
  vals.forEach((r, i) => {
    if (Date.now() - started > 20000) return; // 너무 오래 걸리면 다음에 이어서
    const h = String(r[xi] || '').trim().replace(/^@/, '');
    if (!/^\w{1,15}$/.test(h)) return;
    if (want ? !want.includes(h.toLowerCase()) : r[pi]) return;
    const url = lookupAvatar_(h);
    if (url) { sh.getRange(i + 2, pi + 1).setValue(url); out[i + 2] = url; }
  });
  return out;
}

function lookupAvatar_(h) {
  const get = u => { try { const r = UrlFetchApp.fetch(u, { muteHttpExceptions: true, followRedirects: true }); return r.getResponseCode() === 200 ? JSON.parse(r.getContentText()) : null; } catch (e) { return null; } };
  const ua = get('https://unavatar.io/x/' + encodeURIComponent(h) + '?json&fallback=false');
  let url = ua && ua.url;
  if (!url) { const fx = get('https://api.fxtwitter.com/' + encodeURIComponent(h)); url = fx && fx.user && fx.user.avatar_url; }
  if (!url || !/^https:\/\//.test(url)) return '';
  return url.replace(/_normal(\.\w+)$/, '_bigger$1'); // 48px → 73px
}

function getKey_() {
  const p = PropertiesService.getScriptProperties();
  let k = p.getProperty('KEY');
  if (!k) { k = Utilities.getUuid().replace(/-/g, ''); p.setProperty('KEY', k); }
  return k;
}
function showKey() {
  const url = webAppUrl_(true);
  SpreadsheetApp.getUi().alert('비밀키:\n' + getKey_() + (url ? '\n\n내 다른 기기용 연결 링크 (남에게 주지 마세요):\n' + link_(url, getKey_(), '관리자') : ''));
}

// ------------------------------------------------------------------
// 동료 관리: 사람마다 키를 따로 줘요. 한 명만 끊을 수 있어요.
// ------------------------------------------------------------------
function members_() { try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('MEMBERS') || '{}'); } catch (e) { return {}; } }
function saveMembers_(m) { PropertiesService.getScriptProperties().setProperty('MEMBERS', JSON.stringify(m)); }

// 키 → 이름. 맞는 키가 없으면 null
function whoIs_(key) {
  if (!key) return null;
  if (key === PropertiesService.getScriptProperties().getProperty('KEY')) return '관리자';
  const m = members_();
  return Object.keys(m).find(name => m[name] === key) || null;
}

function webAppUrl_(quiet) {
  const p = PropertiesService.getScriptProperties();
  let url = p.getProperty('WEBAPP_URL') || DEPLOYED_URL;
  if (!url && !quiet) url = setWebAppUrl();
  return url;
}
function setWebAppUrl() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('웹 앱 주소', '배포 → 배포 관리에 있는 웹 앱 URL을 넣어 주세요.\n(https://script.google.com/macros/s/…/exec)', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return null;
  const url = r.getResponseText().trim();
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) { ui.alert('주소가 이상해요. /exec 로 끝나는 웹 앱 URL을 넣어 주세요.'); return null; }
  PropertiesService.getScriptProperties().setProperty('WEBAPP_URL', url);
  return url;
}

// 사이트 주소 #c=… 뒤에 연결 정보를 넣어요. # 뒤는 서버로 전송되지 않아요.
function link_(url, key, name) {
  return SITE_URL + '#c=' + Utilities.base64EncodeWebSafe(JSON.stringify({ u: url, k: key, n: name }), Utilities.Charset.UTF_8).replace(/=+$/, '');
}

function addMember() {
  const ui = SpreadsheetApp.getUi();
  const url = webAppUrl_(false);
  if (!url) return;
  const r = ui.prompt('동료 추가', '동료 이름을 넣어 주세요. (주문 처리 탭에 누가 고쳤는지 이 이름으로 남아요)', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const name = r.getResponseText().trim();
  if (!name) return;
  const m = members_();
  if (m[name] && ui.alert(name + ' 님은 이미 있어요', '새 링크를 만들면 예전 링크는 끊겨요. 계속할까요?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  m[name] = Utilities.getUuid().replace(/-/g, '');
  saveMembers_(m);
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;font-size:14px;line-height:1.5">' +
    '<p><b>' + esc_(name) + '</b> 님 전용 링크예요. 이 링크를 한 번 열면 그 기기에 자동으로 연결돼요.</p>' +
    '<textarea id="l" style="width:100%;height:110px;font-size:12px" readonly>' + esc_(link_(url, m[name], name)) + '</textarea>' +
    '<p><button onclick="var t=document.getElementById(\'l\');t.select();document.execCommand(\'copy\');this.textContent=\'복사했어요\'">링크 복사</button></p>' +
    '<p style="color:#6b7684">링크 = 열쇠예요. 단톡방 말고 그 사람에게만 따로 보내 주세요. 새어나가면 동료 목록에서 끊으면 돼요.</p></div>'
  ).setWidth(520).setHeight(300);
  ui.showModalDialog(html, '동료 연결 링크');
}

function manageMembers() {
  const ui = SpreadsheetApp.getUi();
  const names = Object.keys(members_());
  if (!names.length) { ui.alert('아직 추가한 동료가 없어요.'); return; }
  const r = ui.prompt('동료 목록', '지금 연결할 수 있는 사람: ' + names.join(', ') + '\n\n연결을 끊을 사람 이름을 넣으면 그 사람 링크가 바로 막혀요. (그냥 볼 거면 취소)', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const name = r.getResponseText().trim(), m = members_();
  if (!m[name]) { ui.alert('"' + name + '" 님이 목록에 없어요.'); return; }
  delete m[name]; saveMembers_(m);
  ui.alert(name + ' 님 연결을 끊었어요.');
}

// ------------------------------------------------------------------
// 구글 로그인: 사이트가 보낸 ID 토큰을 구글에 확인하고, 허용된 계정인지 봐요
// ------------------------------------------------------------------
function ownerEmail_() { return String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); }
function extraEmails_() { return (PropertiesService.getScriptProperties().getProperty('ALLOWED') || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean); }
function allowedEmails_() {
  return ALLOWED_EMAILS.concat(extraEmails_(), [ownerEmail_()]).map(e => String(e || '').trim().toLowerCase()).filter(Boolean);
}

// 맞으면 { email, name }, 토큰이 틀리거나 지났으면 null
function verifyToken_(t) {
  if (!GOOGLE_CLIENT_ID || !t) return null;
  const cache = CacheService.getScriptCache();
  const ck = 't' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, t));
  const hit = cache.get(ck);
  if (hit) return JSON.parse(hit);
  const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(t), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return null;
  const j = JSON.parse(r.getContentText());
  const left = Math.floor(+j.exp - Date.now() / 1000);
  if (j.aud !== GOOGLE_CLIENT_ID || String(j.email_verified) !== 'true' || left <= 0) return null;
  const u = { email: String(j.email).toLowerCase(), name: j.name || String(j.email).split('@')[0] };
  cache.put(ck, JSON.stringify(u), Math.min(21600, left));
  return u;
}

function manageEmails() {
  const ui = SpreadsheetApp.getUi(), p = PropertiesService.getScriptProperties();
  const extra = (p.getProperty('ALLOWED') || '').split(',').filter(Boolean);
  const r = ui.prompt('구글 계정 허용 관리',
    '지금 들어올 수 있는 계정:\n' + allowedEmails_().join('\n') +
    '\n\n더할 계정은 그냥 쓰고, 뺄 계정은 앞에 - 를 붙여요. 여러 개는 쉼표로.\n예: friend@gmail.com, -old@gmail.com\n(코드의 ALLOWED_EMAILS 와 시트 주인은 여기서 못 빼요)', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  let list = extra.slice();
  r.getResponseText().split(',').map(x => x.trim().toLowerCase()).filter(Boolean).forEach(x => {
    if (x[0] === '-') list = list.filter(e => e !== x.slice(1));
    else if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x) && !list.includes(x)) list.push(x);
  });
  p.setProperty('ALLOWED', list.join(','));
  ui.alert('저장했어요.\n\n' + allowedEmails_().join('\n'));
}

function esc_(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function resetKey() {
  PropertiesService.getScriptProperties().deleteProperty('KEY');
  SpreadsheetApp.getUi().alert('새 비밀키:\n' + getKey_() + '\n\n사이트 설정에서도 바꿔 주세요. 예전 키는 이제 안 돼요. (동료 링크는 그대로예요)');
}

// ------------------------------------------------------------------
// 사이트 API
//  요청: POST, 본문은 JSON 글자 { key, action, ... }
//  응답: { ok: true, ... } 또는 { ok: false, error }
// ------------------------------------------------------------------
function doGet() {
  return json_({ ok: true, hello: '관리 사이트 API예요. 사이트에서 연결해 주세요.', login: !!GOOGLE_CLIENT_ID });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    let who = null, me = null;
    if (req.idToken) {
      const u = verifyToken_(req.idToken);
      if (!u) return json_({ ok: false, code: 'LOGIN', error: '구글 로그인이 만료됐어요. 다시 로그인해 주세요.' });
      if (!allowedEmails_().includes(u.email)) return json_({ ok: false, code: 'DENIED', error: u.email + ' 계정은 허용되지 않았어요. 관리자에게 말해 주세요.' });
      who = u.name; me = { email: u.email, owner: u.email === ownerEmail_() };
    } else {
      who = whoIs_(req.key); me = { email: '', owner: who === '관리자' };
      if (!who) {
        Utilities.sleep(800);
        return json_({ ok: false, code: 'LOGIN', error: '비밀키가 맞지 않아요.' });
      }
    }
    ensureTabs_();
    if (req.action === 'read') return json_({ ok: true, tabs: readFast_(!!req.fresh), at: new Date().toISOString(), who: who, admin: !!me.owner });
    if (req.sheet === '주문 처리' && req.values) req.values['수정한 사람'] = who;

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    clearReadCache_();
    try {
      switch (req.action) {
        case 'update': return json_({ ok: true, row: update_(req.sheet, req.row, req.values, req.match) });
        case 'upsert': return json_({ ok: true, row: upsert_(req.sheet, req.keyCol, req.keyVal, req.values) });
        case 'append': return json_({ ok: true, row: append_(req.sheet, req.values) });
        case 'remove': remove_(req.sheet, req.row, req.match); return json_({ ok: true });
        case 'replace': replace_(req.sheet, req.rows); return json_({ ok: true, count: req.rows.length - 1 });
        case 'sample': return json_({ ok: true, count: sample_(req.which) });
        case 'reset': reset_(req.which); return json_({ ok: true });
        case 'avatars': return json_({ ok: true, rows: avatars_(req.handles || null) });
        case 'emails': return json_({ ok: true, list: extraEmails_(), owner: ownerEmail_(), fixed: ALLOWED_EMAILS, canEdit: me.owner });
        case 'setEmails': {
          if (!me.owner) return json_({ ok: false, error: '로그인 허용 계정은 시트 주인만 바꿀 수 있어요.' });
          const list = (req.list || []).map(e => String(e).trim().toLowerCase()).filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
          PropertiesService.getScriptProperties().setProperty('ALLOWED', [...new Set(list)].join(','));
          return json_({ ok: true, list: extraEmails_() });
        }
        default: return json_({ ok: false, error: '모르는 요청이에요: ' + req.action });
      }
    } finally { clearReadCache_(); lock.releaseLock(); }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_(name) {
  if (!TABS[name]) throw new Error('없는 탭이에요: ' + name);
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('"' + name + '" 탭이 없어요. 시트 메뉴에서 처음 설정을 눌러 주세요.');
  return sh;
}

// 읽기 속도: 탭 9개를 Sheets API 한 번으로 읽고, 결과를 압축해서 5분 캐시해요.
//  사이트에서 저장하거나 시트에서 직접 고치면(onEdit) 캐시를 바로 지워요.
function readFast_(fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) {
    const hit = cache.get('read');
    if (hit) { try { return JSON.parse(Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(hit), 'application/x-gzip')).getDataAsString()); } catch (e) {} }
  }
  const tabs = readAll_();
  try {
    const z = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(JSON.stringify(tabs), 'application/json')).getBytes());
    if (z.length < 95000) cache.put('read', z, 300);
  } catch (e) {}
  return tabs;
}
function clearReadCache_() { CacheService.getScriptCache().remove('read'); }
function onEdit() { clearReadCache_(); } // 시트에서 직접 고치면 캐시를 지워요

function readAll_() {
  const names = Object.keys(TABS);
  if (typeof Sheets !== 'undefined') {
    try {
      const ss = SpreadsheetApp.getActive();
      const have = new Set(ss.getSheets().map(sh => sh.getName()));
      const want = names.filter(n => have.has(n));
      const res = Sheets.Spreadsheets.Values.batchGet(ss.getId(), { ranges: want.map(n => "'" + n.replace(/'/g, "''") + "'"), valueRenderOption: 'FORMATTED_VALUE' });
      const out = {};
      names.forEach(n => { out[n] = { header: TABS[n], rows: [] }; });
      (res.valueRanges || []).forEach((vr, i) => {
        const v = vr.values || [];
        if (v.length) out[want[i]] = { header: v[0].map(String), rows: v.slice(1).map(r => r.map(String)) };
      });
      return out;
    } catch (e) { /* 아래 느린 방법으로 */ }
  }
  const out = {};
  names.forEach(name => {
    const sh = SpreadsheetApp.getActive().getSheetByName(name);
    if (!sh || sh.getLastRow() === 0) { out[name] = { header: TABS[name], rows: [] }; return; }
    const v = sh.getDataRange().getDisplayValues();
    out[name] = { header: v[0], rows: v.slice(1) };
  });
  return out;
}

function header_(sh) { return sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getDisplayValues()[0]; }

// values: { 열이름: 값 } 같은 이름 열이 여러 개면 "족자봉#2" 처럼 몇 번째인지 붙여요
function colIndex_(header, name) {
  const m = String(name).match(/^(.*)#(\d+)$/);
  const base = m ? m[1] : name, nth = m ? +m[2] : 1;
  let seen = 0;
  for (let i = 0; i < header.length; i++) if (header[i] === base && ++seen === nth) return i;
  return -1;
}

function writeRow_(sh, row, values) {
  const header = header_(sh);
  Object.entries(values || {}).forEach(([k, v]) => {
    let i = colIndex_(header, k);
    if (i < 0) { i = header.length; header.push(k); sh.getRange(1, i + 1).setValue(k).setFontWeight('bold'); }
    sh.getRange(row, i + 1).setValue(v);
  });
}

function check_(sh, row, match) {
  if (row < 2 || row > sh.getLastRow()) throw new Error('없는 줄이에요. 새로고침해 주세요.');
  if (!match) return;
  const header = header_(sh);
  Object.entries(match).forEach(([k, v]) => {
    const i = colIndex_(header, k);
    if (i >= 0 && String(sh.getRange(row, i + 1).getDisplayValue()) !== String(v))
      throw new Error('그 사이 시트가 바뀌었어요. 새로고침한 뒤 다시 해 주세요.');
  });
}

function update_(name, row, values, match) {
  const sh = sheet_(name);
  check_(sh, row, match);
  writeRow_(sh, row, values);
  return row;
}

function upsert_(name, keyCol, keyVal, values) {
  const sh = sheet_(name);
  const header = header_(sh), i = colIndex_(header, keyCol);
  if (i < 0) throw new Error('열이 없어요: ' + keyCol);
  let row = -1;
  if (sh.getLastRow() > 1) {
    const col = sh.getRange(2, i + 1, sh.getLastRow() - 1, 1).getDisplayValues();
    const at = col.findIndex(r => String(r[0]) === String(keyVal));
    if (at >= 0) row = at + 2;
  }
  if (row < 0) row = sh.getLastRow() + 1;
  writeRow_(sh, row, Object.assign({ [keyCol]: keyVal }, values));
  return row;
}

function append_(name, values) {
  const sh = sheet_(name);
  const row = sh.getLastRow() + 1;
  writeRow_(sh, row, values);
  return row;
}

function remove_(name, row, match) {
  const sh = sheet_(name);
  check_(sh, row, match);
  sh.deleteRow(row);
}

// 탭 전체를 새 표로 바꿔요. (선입금 리스트, 입금기록 붙여넣기용)
function replace_(name, rows) {
  if (!TEXT_TABS.includes(name)) throw new Error('이 탭은 통째로 바꿀 수 없어요: ' + name);
  if (!rows || !rows.length) throw new Error('빈 표예요.');
  const sh = sheet_(name);
  const w = Math.max.apply(null, rows.map(r => r.length));
  const data = rows.map(r => { const x = r.slice(); while (x.length < w) x.push(''); return x.map(v => String(v == null ? '' : v)); });
  sh.clearContents();
  sh.getRange('A:AZ').setNumberFormat('@');
  sh.getRange(1, 1, data.length, w).setValues(data);
  sh.getRange(1, 1, 1, w).setFontWeight('bold');
  sh.setFrozenRows(1);
}
