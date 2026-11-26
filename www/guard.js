/* 현장 사고 방지 (포스·모니터·카드 뽑기 공용)
 * - 두 번 톡톡 / 두 손가락으로 벌려서 화면이 확대되지 않게
 * - 꾹 누를 때 글자 선택·복사 메뉴·사진 저장 메뉴가 뜨지 않게 (글자 입력 칸만 예외)
 * - 사진·글자가 손가락에 끌려 다니지 않게
 * - 키보드 Ctrl(⌘) +/−, Ctrl+휠 확대도 막아요
 */
(() => {
  const editable = t => !!(t && t.closest && t.closest('input,textarea,select,[contenteditable="true"]'));
  const css = document.createElement('style');
  css.textContent = 'html{touch-action:manipulation;-webkit-text-size-adjust:100%;text-size-adjust:100%}'
    + '*{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}'
    + 'input,textarea,select,[contenteditable="true"]{-webkit-user-select:text;user-select:text;-webkit-touch-callout:default}'
    + 'img,svg,a{-webkit-user-drag:none}';
  document.head.appendChild(css);

  const stop = e => { if (e.cancelable) e.preventDefault(); };
  const opt = { passive: false };
  // iPhone·iPad 사파리의 두 손가락 확대
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(t => document.addEventListener(t, stop, opt));
  document.addEventListener('touchmove', e => { if (e.touches.length > 1 || (e.scale !== undefined && e.scale !== 1)) stop(e); }, opt);
  // 두 번 톡톡 확대 (touch-action으로 대부분 막히고, 남은 경우 대비)
  document.addEventListener('dblclick', stop, opt);
  // 꾹 누르기 메뉴, 글자 선택, 끌기
  document.addEventListener('contextmenu', e => { if (!editable(e.target)) stop(e); }, opt);
  document.addEventListener('selectstart', e => { if (!editable(e.target)) stop(e); }, opt);
  document.addEventListener('dragstart', e => { if (!editable(e.target)) stop(e); }, opt);
  // 키보드·트랙패드 확대
  document.addEventListener('wheel', e => { if (e.ctrlKey) stop(e); }, opt);
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0', '_'].includes(e.key)) stop(e); });
})();
