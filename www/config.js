// =====================================================================
//  부스 설정 파일 — 상품, 가격, 재고, 계좌는 여기서만 고치면 돼요.
//
//  상품 항목
//    id        바꾸지 마세요. 판매 기록이 id로 저장돼요.
//    name      크게 보이는 이름. 선입금 CSV의 열 이름도 이걸로 맞춰요.
//    sub       이름 아래 작게 보이는 부제 (없으면 빼도 돼요)
//    price     가격 (원). 0이면 '가격 미정'으로 보이고 팔 수 없어요.
//    stock     처음 재고
//    image     www/images 폴더 안 사진 파일
//    badge     사진 위에 크게 쓰는 글자 (포토카드 1·5·10)
//    pool      같은 pool 이름을 가진 상품끼리 재고를 같이 써요.
//    units     pool 재고를 몇 개씩 쓰는지 (10세트 = 10)
//    preorderOnly  선입금 전용 (판매 화면에 안 보여요)
//    noPreorder    선입금이 없는 상품 (상품 카드에 선입금 잔여 칸을 안 보여줘요)
//    variants  종류 목록 (족자봉 A~Y)
//    owner     수익을 전부 가져가는 사람 (없으면 부스의 owner, 그것도 없으면 공동 수익)
//    r18       true면 받기를 누를 때 '성인 인증 팔찌 확인' 경고가 떠요
//
//  파일을 고친 뒤에는 sw.js의 VERSION 숫자를 하나 올려 주세요.
// =====================================================================
const TODO = 0; // 아직 모르는 값. 채워 넣어 주세요.

self.BOOTH_CONFIG = {
  booths: {
    A: {
      name: '초건전회지위원회',
      account: { bank: '은행 이름', number: '계좌번호를 넣어 주세요', owner: '예금주' },
      // 선입금 사은품: need 상품을 모두 산 분께 give 상품 1개 (1인당 1개). 설정에서 바꿀 수 있어요
      gift: { on: true, need: ['postcardbook', 'jokja'], give: 'pc1' },
      pools: {
        photocard: { name: '랜덤 포토카드', unit: '세트', stock: 500 }, // 1세트 기준 전체 수량
      },
      products: [
        { id: 'postcardbook', name: '엽서북', sub: '청록 : WORK!', price: 20000, stock: 300, image: 'images/postcardbook.jpg' },
        { id: 'pc1', name: '랜덤 포토카드 1세트', price: 2000, pool: 'photocard', units: 1, badge: '1', image: 'images/photocard.jpg' },
        { id: 'pc5', name: '랜덤 포토카드 5세트', price: 10000, // 임시: 1세트 가격 × 5
          pool: 'photocard', units: 5, badge: '5', image: 'images/photocard.jpg' },
        { id: 'pc10', name: '랜덤 포토카드 10세트', price: 20000, // 임시: 1세트 가격 × 10
          pool: 'photocard', units: 10, badge: '10', image: 'images/photocard.jpg' },
        { id: 'jokja', name: '족자봉', price: 20000, preorderOnly: true, variants: 'ABCDEFGHIJKLMNOPQRSTUVWXY'.split('') },
        // 하치 님 책: 현장 판매만, 수익은 전부 하치 몫. 이름(가제)·가격·수량 미정. id는 이름이 바뀌어도 그대로 둬요.
        { id: 'hachibook', name: '녹스책', sub: '가제', price: TODO, stock: TODO, noPreorder: true, owner: '하치' },
      ],
    },
    B: {
      name: 'PPPP2',
      owner: '잏엫', // 이 부스 수익(선입금 + 현장 판매)은 전부 잏엫 몫
      account: { bank: '은행 이름', number: '계좌번호를 넣어 주세요', owner: '예금주' },
      products: [
        { id: 'pppp2', name: 'PPPP2', r18: true, price: 12000, stock: TODO, image: 'images/pppp2.jpg' }, // 수량 미정
      ],
    },
  },
};
