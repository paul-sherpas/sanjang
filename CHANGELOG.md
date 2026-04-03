# Changelog

## [0.2.0] - 2026-04-04

### Added

- **포털 홈**: 이어하기(PR + 캠프 목록)와 새로 시작(자연어 퀵스타트) 섹션으로 대시보드 첫 화면 개편
- **의존성 캐시**: init 시 node_modules를 프리빌드하고, 캠프 생성 시 캐시 클론으로 설치 시간 수초로 단축
- **멀티앱 감지**: 모노레포에서 여러 앱을 자동 감지하고 init 시 인터랙티브 선택
- **config 핫 리로드**: 캠프 생성마다 sanjang.config.js를 다시 읽어 변경사항 즉시 반영
- **캐시 관리 API**: GET /api/cache/status, POST /api/cache/rebuild 엔드포인트
- **한국어 슬러그**: 자연어 입력을 kebab-case 브랜치명으로 변환 (한→영 매핑 포함)
- **92개 테스트**: e2e 서버 테스트, 캐시/프로세스/포털/config 단위 테스트 추가

### Changed

- **캠프 생성 비동기화**: npm install을 spawn으로 전환해 HTTP 응답 블로킹 해소
- **portFlag null 지원**: shadow-cljs 등 포트 오버라이드 없는 프레임워크 정상 동작
- **Turborepo portFlag**: null로 변경 (turbo가 자체 포트 관리)

### Fixed

- **대시보드 포트 불일치**: portFlag null 시 캠프 카드에 잘못된 포트 표시되던 문제 수정
- **로딩 상태**: 캠프 생성 중 버튼 비활성화 + 진행 토스트 표시
- **Shell injection 방지**: cache.js의 execSync → execFileSync 전환
- **config.js appDir 인용**: setup 명령에서 디렉토리명 shell-escape 처리
- **비동기 null guard**: 캠프 삭제 중 setup 콜백에서 발생 가능한 데이터 corruption 방지
- **gh pr list 제한**: unbounded 결과 방지를 위해 --limit 50 추가
- **DRY 리팩터링**: 캠프 셋업 로직을 setupCampDeps() 헬퍼로 추출해 중복 제거

## [0.1.0] - 2026-04-03

Initial release.
