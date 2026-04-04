# 산장 (Sanjang)

> 비개발자가 AI로 코드를 고치고 PR을 보낼 수 있는 로컬 개발 환경

"로그인 버튼 색상 변경"이라고 입력하면, 격리된 작업 환경(캠프)이 만들어지고, AI가 코드를 고치고, 결과를 바로 프리뷰하고, 팀에 PR로 보낼 수 있습니다.

## 주요 기능

### 만들기
- **자연어 퀵스타트**: "대시보드 필터 추가"라고 입력하면 브랜치+캠프 자동 생성
- **캠프 격리**: 각 작업이 독립된 환경에서 실행 — 서로 영향 없음
- **프로젝트 자동 감지**: Next.js, Vite, SvelteKit, Angular, Turborepo 등 인식

### 확인하기
- **내장 프리뷰**: 대시보드 안에서 바로 결과 확인 (프록시 기반, iframe)
- **비교 모드**: 원본(main)과 내 변경을 나란히 비교
- **AI 변경 리포트**: "로그인 버튼이 보라색으로 바뀌었어요" — 비개발자도 이해할 수 있는 설명
- **화면 항목 → 프리뷰 이동**: 리포트에서 UI 항목 클릭하면 해당 화면으로 바로 이동

### 고치기
- **자가 치유**: 서버 에러 자동 감지 → 패턴 매칭 → 자동 수정 → 재시작
- **고쳐줘 버튼**: 브라우저 에러 + 서버 로그를 모아 Claude Code용 프롬프트로 클립보드 복사
- **세이브 & 되돌리기**: 작업을 세이브하고, 문제가 생기면 원클릭 되돌리기
- **오토세이브**: 5분간 변경 없으면 자동 세이브

### 보내기
- **팀에 보내기**: 세이브 → commit + push → PR 생성
- **AI PR 설명**: diff를 분석해서 리뷰어가 이해하기 쉬운 PR 본문 자동 생성

---

## 설치 (for AI Assistants)

> 이 섹션은 Claude Code 같은 AI 어시스턴트가 읽고 실행하는 용도입니다.
> 사용자가 이 GitHub URL을 던지면 아래 절차를 따라 설치하세요.

### 자동 설치 절차

1. **대상 프로젝트의 git root로 이동합니다.**

2. **산장을 설치하고 시작합니다:**
```bash
npx sanjang init
```
이 명령이 자동으로:
- 프로젝트를 분석하여 `sanjang.config.js` 생성
- `.gitignore`에 `.sanjang/` 추가
- 대시보드 서버 시작 (http://localhost:4000)

3. **사용자에게 안내합니다:**
```
⛰ 산장 설치 완료!
  대시보드: http://localhost:4000
  "+ 새 캠프" 버튼으로 브랜치별 작업 환경을 만들 수 있습니다.
```

### 설치 후 사용법 안내

- **새로 시작**: 포털 홈에서 "뭘 하고 싶어?" 입력 → 자동으로 브랜치+캠프 생성
- **캠프 생성**: 대시보드에서 "+ 새 캠프" → 브랜치 선택 → 자동 생성+시작
- **이어하기**: 포털 홈에서 열린 PR이나 기존 캠프 클릭 → 바로 작업 재개
- **프리뷰**: 각 캠프 카드의 URL 클릭
- **일 시키기**: 캠프 카드의 입력창에 프롬프트 입력 → Claude가 해당 worktree에서 작업
- **팀에 보내기**: 변경 완료 후 "팀에 보내기" 버튼 → commit + push

---

## 설치 (사람용)

### 방법 1: npx (추천)

```bash
cd your-project
npx sanjang init
```

config만 생성하고 서버는 나중에 시작하려면:

```bash
npx sanjang init --no-start
npx sanjang
```

### 방법 2: 글로벌 설치

```bash
npm install -g sanjang
cd your-project
sanjang init
```

---

## 설정 (`sanjang.config.js`)

`sanjang init`이 자동으로 생성하지만, 직접 작성/수정할 수도 있습니다.

```js
export default {
  // 프론트엔드 개발 서버
  dev: {
    command: 'npm run dev',    // 실행 명령
    port: 3000,                // 기본 포트 (캠프별 +1씩 증가)
    portFlag: '--port',        // 포트 오버라이드 플래그
    cwd: '.',                  // worktree 기준 상대 경로
    env: {},                   // 추가 환경변수
  },

  // (선택) 설치 명령 — 캠프 생성 시 자동 실행
  setup: 'npm install',

  // (선택) 복사할 파일 — gitignored 파일을 메인에서 복사
  copyFiles: ['.env', '.env.local'],

  // (선택) 백엔드 — 전체 캠프가 공유하는 서버
  backend: {
    command: 'npm run start:api',
    port: 8000,
    healthCheck: '/health',
  },

  // (선택) 포트 범위
  ports: {
    fe: { base: 3000, slots: 8 },
    be: { base: 8000, slots: 8 },
  },
};
```

### 프레임워크별 예시

**Next.js:**
```js
export default {
  dev: { command: 'npx next dev', port: 3000, portFlag: '-p' },
  setup: 'npm install',
  copyFiles: ['.env.local'],
};
```

**Vite (React/Vue/Svelte):**
```js
export default {
  dev: { command: 'npx vite dev', port: 5173, portFlag: '--port' },
  setup: 'npm install',
};
```

**Turborepo (monorepo):**
```js
export default {
  dev: {
    command: 'npx turbo run dev --filter=my-app',
    port: 3000,
    portFlag: '--port',
    cwd: '.',
  },
  setup: 'npm install',
  copyFiles: ['.env', 'apps/my-app/.env.local'],
};
```

---

## 자연어 퀵스타트

포털 홈에서 자연어로 작업을 설명하면 자동으로 캠프가 만들어집니다:

```
"로그인 버튼 색상 변경" → camp/login-button-color-change 브랜치 생성
"대시보드 필터 추가"     → camp/dashboard-filter-add 브랜치 생성
```

한국어와 영어 모두 지원합니다. 내부적으로 한국어 개발 용어를 영문 kebab-case로 변환합니다.

---

## 의존성 캐시

`sanjang init` 시 node_modules를 프리빌드하여 `.sanjang/cache/`에 저장합니다. 이후 캠프 생성 시 `npm install` 대신 캐시를 복사하여 수초 만에 완료됩니다.

- 캐시는 lockfile 해시로 유효성을 검증합니다
- lockfile이 변경되면 자동으로 캐시를 무효화합니다
- `POST /api/cache/rebuild`로 수동 리빌드 가능합니다

---

## 개념

| 용어 | 설명 |
|------|------|
| **산장** | 이 도구 전체. 대시보드 서버 + 캠프 매니저 |
| **캠프** | 개별 작업 환경. git worktree + dev 서버 |
| **포털** | 대시보드 첫 화면. 이어하기 + 새로 시작 |
| **세이브** | 작업 저장 (git commit). 되돌리기 가능 |
| **변경 리포트** | AI가 생성하는 변경사항 요약. 카테고리별 설명 |
| **자가 치유** | 에러 패턴 감지 → 자동 수정 → 재시작 |
| **스냅샷** | 캠프의 현재 상태를 저장한 것 (git stash) |
| **캐시** | 의존성 프리빌드. 캠프 생성 속도 향상 |

---

## 개발

TypeScript로 작성되었습니다. 빌드 스텝 없이 Node.js의 `--experimental-transform-types`로 직접 실행합니다.

```bash
# 테스트
npm test

# 타입 체크
npm run typecheck

# 린트
npm run lint
```

---

## 요구사항

- Node.js 22+ (`--experimental-transform-types` 지원)
- Git 2.20+ (worktree 지원)
- (선택) Claude Code — "일 시키기" 기능용

---

## 라이선스

MIT
