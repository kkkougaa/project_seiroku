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

// 탭 이름과 열 구조. 사이트가 이 열 이름으로 값을 찾아요. (열 순서는 바꿔도 되지만 이름은 그대로 둬요)
const TABS = {
  '작가': ['No', '닉네임', 'X 아이디', '수락 여부', '섭외 메모', '디스코드', '제출 여부', '현장 수령',
    '후기 (한)', '후기 (일)', '작업 폴더 링크', '주소', '계좌번호', '실명', '기타'],
  '선입금 리스트': ['번호', '작성시간', '엽서북', '족자봉', '배송방법', '배송비', '총 주문금액', '주문자명', '닉네임',
    '주문자연락처', '결제날짜', '수령자명', '수령자연락처', '우편번호', '주소', '배송메모', '환불은행', '환불계좌',
    '환불예금주', '총 주문금액', '이메일', '족자봉', '트위터계정', '인스타계정', '택배사', '운송장번호', '진행상태', '메모', '주문번호'],
  '입금기록': ['거래 일시', '적요', '거래 유형', '거래 기관', '계좌번호', '거래 금액', '거래 후 잔액', '메모'],
  '주문 처리': ['주문번호', '족자봉 확정', '입금 처리', '입금 키', '메모', '수정 시각'],
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
  ['포스 족자봉 표기', '알파벳', '포스용 명단을 뽑을 때 1→A 로 바꿀지 (알파벳 / 숫자)'],
];

// ------------------------------------------------------------------
// 시트 메뉴
// ------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('관리 사이트')
    .addItem('1. 처음 설정 (탭 만들기 + 작가 가져오기)', 'setup')
    .addItem('비밀키 보기', 'showKey')
    .addItem('비밀키 새로 만들기', 'resetKey')
    .addSeparator()
    .addItem('작년 선입금/입금 데이터 가져오기 (연습용)', 'importLastYearOrders')
    .addToUi();
}

function setup() {
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
  const def = ss.getSheetByName('시트1') || ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);

  const st = ss.getSheetByName('설정');
  if (st.getLastRow() <= 1) st.getRange(2, 1, DEFAULT_SETTINGS.length, 3).setValues(DEFAULT_SETTINGS);

  let msg = '탭을 만들었어요.';
  const au = ss.getSheetByName('작가');
  if (au.getLastRow() <= 1) {
    try { msg += '\n작가 ' + importAuthors_() + '명을 작년 시트에서 가져왔어요.'; }
    catch (e) { msg += '\n작가 가져오기 실패: ' + e.message; }
  }
  const key = getKey_();
  SpreadsheetApp.getUi().alert(msg + '\n\n사이트 설정에 넣을 비밀키:\n' + key + '\n\n이제 배포 → 새 배포 → 웹 앱 으로 배포해 주세요.');
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
      pick(c, '후기 (한)'), pick(c, '후기 (일)'), pick(c, '작업 폴더 링크'), pick(c, '주소'), pick(c, '계좌번호'), pick(c, '실명'), pick(c, '기타')];
  });
  if (rows.length) SpreadsheetApp.getActive().getSheetByName('작가').getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  return rows.length;
}

// 작년 선입금 리스트(A~AC)와 입금기록(A~H)을 그대로 복사해요. 사이트를 미리 연습해볼 때만 써요.
function importLastYearOrders() {
  const ui = SpreadsheetApp.getUi();
  if (ui.alert('작년 선입금/입금 데이터로 덮어쓸까요?', '지금 선입금 리스트, 입금기록 탭 내용이 지워져요.', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  const src = SpreadsheetApp.openById(SOURCE_SHEET_ID);
  const o = src.getSheetByName('선입금 리스트').getRange('A:AC').getDisplayValues().filter((r, i) => i === 0 || (r[0] && /^\d+$/.test(r[0])));
  const d = src.getSheetByName('입금기록').getRange('A:H').getDisplayValues().filter(r => r.some(Boolean));
  replace_('선입금 리스트', o);
  replace_('입금기록', d);
  ui.alert('선입금 ' + (o.length - 1) + '건, 입금 ' + (d.length - 1) + '건을 가져왔어요.');
}

function getKey_() {
  const p = PropertiesService.getScriptProperties();
  let k = p.getProperty('KEY');
  if (!k) { k = Utilities.getUuid().replace(/-/g, ''); p.setProperty('KEY', k); }
  return k;
}
function showKey() { SpreadsheetApp.getUi().alert('비밀키:\n' + getKey_()); }
function resetKey() {
  PropertiesService.getScriptProperties().deleteProperty('KEY');
  SpreadsheetApp.getUi().alert('새 비밀키:\n' + getKey_() + '\n\n사이트 설정에서도 바꿔 주세요. 예전 키는 이제 안 돼요.');
}

// ------------------------------------------------------------------
// 사이트 API
//  요청: POST, 본문은 JSON 글자 { key, action, ... }
//  응답: { ok: true, ... } 또는 { ok: false, error }
// ------------------------------------------------------------------
function doGet() {
  return json_({ ok: true, hello: '관리 사이트 API예요. 사이트에서 연결해 주세요.' });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (!req.key || req.key !== PropertiesService.getScriptProperties().getProperty('KEY')) {
      Utilities.sleep(800);
      return json_({ ok: false, error: '비밀키가 맞지 않아요.' });
    }
    if (req.action === 'read') return json_({ ok: true, tabs: readAll_(), at: new Date().toISOString() });

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      switch (req.action) {
        case 'update': return json_({ ok: true, row: update_(req.sheet, req.row, req.values, req.match) });
        case 'upsert': return json_({ ok: true, row: upsert_(req.sheet, req.keyCol, req.keyVal, req.values) });
        case 'append': return json_({ ok: true, row: append_(req.sheet, req.values) });
        case 'remove': remove_(req.sheet, req.row, req.match); return json_({ ok: true });
        case 'replace': replace_(req.sheet, req.rows); return json_({ ok: true, count: req.rows.length - 1 });
        default: return json_({ ok: false, error: '모르는 요청이에요: ' + req.action });
      }
    } finally { lock.releaseLock(); }
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

function readAll_() {
  const out = {};
  Object.keys(TABS).forEach(name => {
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
