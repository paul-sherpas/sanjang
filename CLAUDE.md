# Sanjang

바이브코더를 위한 AI 개발 환경 에이전트. Git worktree 기반 캠프 관리 + 자가 치유 + 스마트 어시스턴트.

## Design Principles

- **관찰 > 예측**: 포트를 미리 정하지 않고 stdout에서 감지. config를 추측하지 않고 프로젝트를 분석.
- **자가 치유**: 에러 → 패턴 매칭 → 자동 수정 → 재시작. 사용자에게 에러를 보여주기 전에 고침.
- **인간 언어**: 포트, 브랜치, 워크트리 등 개발 용어를 숨김. "열기", "준비 중", "문제 발생"으로 표현.
- **에이전트 위임**: 사용자가 이해할 필요 없는 건 AI가 처리 (PR 설명, 작업 제안, config 수정).

## Architecture

```
bin/sanjang.js    → .ts wrapper (npx 엔트리포인트)
bin/sanjang.ts    → CLI (init, help, start)
lib/server.ts     → Express + WebSocket 대시보드 서버 (~900줄, 가장 큰 파일)
lib/config.ts     → sanjang.config.js 로드/생성/프레임워크 감지
lib/types.ts      → 모든 인터페이스 중앙 관리
lib/engine/
  state.ts        → 캠프 상태 JSON 파일 관리
  ports.ts        → 포트 할당/충돌 감지
  process.ts      → dev 서버 프로세스 관리 + stdout 포트 감지
  cache.ts        → node_modules 캐시 (빌드/적용/검증)
  worktree.ts     → git worktree 생성/삭제/브랜치 목록
  naming.ts       → 한국어→영어 slugify
  snapshot.ts     → git stash 기반 스냅샷
  pr.ts           → PR 생성 프롬프트/본문 빌드
  smart-pr.ts     → AI PR 설명 생성 (claude -p 또는 fallback)
  conflict.ts     → git 충돌 감지
  smart-init.ts   → 프로젝트 깊이 분석 (.env 스캔, 이슈 감지)
  self-heal.ts    → 에러 패턴 매칭 → 자동 수정 → 재시작
  suggest.ts      → 작업 제안 (이슈, PR, 최근 활동 조합)
  config-hotfix.ts → sanjang.config.js 자동 수정
  diagnostics.ts  → 캠프 상태 진단
  warp.ts         → Warp 터미널 감지/열기
dashboard/
  index.html      → SPA 대시보드 (브라우저 JS, TS 마이그레이션 제외)
  app.js          → 대시보드 로직
  style.css       → 스타일
```

## Dev commands

```bash
npm test              # 128 tests (node --experimental-transform-types)
npm run typecheck     # tsc --noEmit --strict
npm run lint          # biome check
node bin/sanjang.js   # 로컬 실행
```

## Key decisions

- TypeScript strict mode, zero any, no build step (node --experimental-transform-types)
- Import 확장자는 .ts (strip-types가 .js→.ts resolve 안 함)
- portFlag: null 인 프레임워크는 stdout에서 실제 포트를 파싱 (process.ts detectPortFromStdout)
- dashboard/는 브라우저 직접 실행이므로 JS 유지
- 캠프 최대 7개 (MAX_CAMPS), 포트는 슬롯 기반 할당

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
