# Changelog

## [0.4.0] - 2026-04-05

### Added

- **WS 프록시 (HMR 지원)**: 프리뷰 iframe에서 Vite/Next.js HMR이 동작. WebSocket 업그레이드를 캠프 dev 서버로 패스스루
- **프리뷰 URL 바**: 라우트 직접 입력, 뒤로가기, 새로고침. iframe 안에서 자유 네비게이션
- **반응형 뷰포트**: 데스크탑/태블릿(768px)/모바일(375px) 전환 버튼
- **UI 항목 → 프리뷰 이동**: 변경 리포트의 🎨 화면 항목 클릭 시 해당 라우트로 프리뷰 이동 (파일 기반 라우팅 자동 추론)
- **고쳐줘 버튼**: 브라우저 에러 + 서버 로그를 Claude Code용 프롬프트로 클립보드 복사
- **CLI 확장**: `list`, `status`, `start`, `stop`, `open` 명령 추가. `--json` 플래그로 자동화 지원
- **Node 22 버전 체크**: 미만 버전에서 명확한 에러 메시지 + nvm 해결법 안내
- **브라우저 자동 오픈**: 서버 시작 후 대시보드 URL 자동 오픈

### Changed

- **README 재작성**: 기능을 만들기/확인하기/고치기/보내기 4단계로 재구성
- **GitHub 메타데이터**: description, topics 업데이트

## [0.3.0] - 2026-04-04

### Changed

- **TypeScript 전환**: 전체 코드베이스를 JavaScript에서 TypeScript로 마이그레이션. strict mode + noUncheckedIndexedAccess 적용. `any` 타입 제로.
- **lib/types.ts 중앙 타입**: Camp, SanjangConfig, CacheResult, PortAllocation 등 18개 인터페이스를 단일 파일로 관리
- **Node --experimental-transform-types**: 빌드 스텝 없이 .ts 파일 직접 실행
- **biome 린터**: ESLint 대신 biome으로 코드 품질 관리

### Added

- **GitHub Actions CI**: Node 22/23 매트릭스로 테스트 + 타입체크 자동화
- **120+ 테스트**: Phase 1 버그픽스 테스트 + TS 마이그레이션 검증 테스트 추가

### Fixed

- **캐시 해시 분리**: setupCwd별 독립 해시 파일로 멀티앱 캐시 충돌 방지
- **reset 핸들러**: stale config 참조 대신 매번 fresh config 로드
- **에러 메시지 개선**: 캐시 실패, 설치 실패, 디스크 부족 등 구체적 안내

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
