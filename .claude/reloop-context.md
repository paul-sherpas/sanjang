# Reloop Context: 산장 e2e 안정화

## 목표
산장 셋업→캐시→캠프 생성→시작→정리 전체 e2e 플로우 안정화.

## 환경
- SMPLY 프로젝트: /Users/pauljeong/Documents/07-SMPLY/smply
- 산장 코드: /Users/pauljeong/Documents/07-SMPLY/sanjang
- Config: new-frontend (turbo+bun+smply-web, port 3002)
- Dev command: npx turbo run dev --filter=smply-web (cwd: new-frontend)
- portFlag: null (포트 오버라이드 불가)
- bun.lock (v2 텍스트 포맷)
- 모노레포: 13개 node_modules 디렉토리

## 체크리스트
1. e2e 검증 스크립트 작성 (test/e2e-setup.test.js)
   - init → cache build → camp create → cache apply 확인
   - camp start → port open 확인 → camp stop → camp delete → cleanup
2. 검증 스크립트 실행하여 실패 지점 발견
3. 실패 원인 수정 (cache.js, server.js, config.js, process.js 등)
4. 재검증 → 통과할 때까지 반복
5. 기존 단위 테스트 전부 통과 확인

## 주의사항
- 산장 서버가 이미 4000에 떠있을 수 있음 → 먼저 kill
- 캠프 FE port와 실제 vite port가 다를 수 있음 (portFlag: null)
- 테스트 캠프는 반드시 정리할 것
- 서버 시작/종료를 테스트 내에서 프로그래매틱하게 처리 (createApp 사용)
