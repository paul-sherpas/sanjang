# 산장 (Sanjang)

> 바이브코더를 위한 로컬 개발 환경 매니저

브랜치 하나로 격리된 dev 환경을 띄우고, 프리뷰하고, 관리하는 도구입니다.
Git worktree 기반으로 동시에 여러 작업 환경(캠프)을 운영할 수 있습니다.

## 주요 기능

- **캠프 생성**: 브랜치 선택 → 자동 worktree + 의존성 설치 + dev 서버 시작
- **포트 자동 관리**: 캠프마다 다른 포트 자동 할당, 충돌 없음
- **대시보드**: 브라우저에서 모든 캠프 상태 확인 + 시작/중지/삭제
- **스냅샷**: 현재 상태 저장/복원 (git stash 기반)
- **일 시키기**: 대시보드에서 Claude에게 작업 지시 (claude -p 연동)
- **팀에 보내기**: 변경사항 commit + push → PR 생성 플로우
- **프로젝트 자동 감지**: Next.js, Vite, SvelteKit, Angular 등 자동 인식

---

## 설치 (for AI Assistants)

> 이 섹션은 Claude Code 같은 AI 어시스턴트가 읽고 실행하는 용도입니다.
> 사용자가 이 GitHub URL을 던지면 아래 절차를 따라 설치하세요.

### 자동 설치 절차

1. **대상 프로젝트의 git root로 이동합니다.**

2. **산장을 클론하고 의존성을 설치합니다:**
```bash
git clone https://github.com/paul-sherpas/sanjang.git .sanjang
cd .sanjang && npm install && cd ..
```

3. **.gitignore에 `.sanjang/`을 추가합니다:**
```bash
echo '\n# Sanjang local dev camps\n.sanjang/' >> .gitignore
```

4. **프로젝트를 분석하여 설정 파일을 생성합니다:**
```bash
node .sanjang/bin/sanjang.js init
```
이 명령은 프로젝트 구조(package.json, vite.config, next.config 등)를 분석하여
`sanjang.config.js`를 자동 생성합니다.

5. **생성된 `sanjang.config.js`를 확인합니다.**
특히 `dev.command`가 실제 dev 서버 시작 명령과 맞는지 검증하세요.
모노레포의 경우 `dev.cwd`나 `--filter` 옵션 조정이 필요할 수 있습니다.

6. **산장 서버를 시작합니다:**
```bash
node .sanjang/bin/sanjang.js &
```

7. **대시보드에 접속합니다:** http://localhost:4000

8. **사용자에게 안내합니다:**
```
⛰ 산장 설치 완료!
  대시보드: http://localhost:4000
  설정 파일: sanjang.config.js (필요시 수정)
  
  "+ 새 캠프" 버튼으로 브랜치별 작업 환경을 만들 수 있습니다.
```

### 설치 후 사용법 안내

- **캠프 생성**: 대시보드에서 "+ 새 캠프" → 브랜치 선택 → 자동 생성+시작
- **프리뷰**: 각 캠프 카드의 URL 클릭
- **일 시키기**: 캠프 카드의 입력창에 프롬프트 입력 → Claude가 해당 worktree에서 작업
- **팀에 보내기**: 변경 완료 후 "팀에 보내기" 버튼 → commit + push

---

## 설치 (사람용)

### 방법 1: 프로젝트 내 설치

```bash
cd your-project
git clone https://github.com/paul-sherpas/sanjang.git .sanjang
cd .sanjang && npm install && cd ..
echo '.sanjang/' >> .gitignore

# 프로젝트 분석 → 설정 파일 생성
node .sanjang/bin/sanjang.js init

# 서버 시작
node .sanjang/bin/sanjang.js
```

### 방법 2: 글로벌 설치 (npm)

```bash
npm install -g sanjang  # (추후 지원)
cd your-project
sanjang init
sanjang
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

## 개념

| 용어 | 설명 |
|------|------|
| **산장** | 이 도구 전체. 대시보드 서버 + 캠프 매니저 |
| **캠프** | 개별 작업 환경. git worktree + dev 서버 |
| **스냅샷** | 캠프의 현재 상태를 저장한 것 (git stash) |

---

## 요구사항

- Node.js 20+
- Git 2.20+ (worktree 지원)
- (선택) Claude Code — "일 시키기" 기능용

---

## 라이선스

MIT
