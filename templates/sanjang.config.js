// sanjang.config.js — 산장 설정 파일
// 'sanjang init' 명령으로 자동 생성되지만, 직접 수정할 수도 있습니다.

export default {
  // 프론트엔드 개발 서버
  dev: {
    command: 'npm run dev',
    port: 3000,
    portFlag: '--port',
    cwd: '.',
    env: {},
  },

  // (선택) 설치 명령 — 캠프 생성 시 자동 실행
  // setup: 'npm install',

  // (선택) 복사할 파일 — gitignored 파일을 메인에서 복사
  // copyFiles: ['.env', '.env.local'],

  // (선택) 백엔드 — 전체 캠프가 공유하는 서버
  // backend: {
  //   command: 'npm run start:api',
  //   port: 8000,
  //   healthCheck: '/health',
  // },

  // (선택) 포트 범위
  // ports: {
  //   fe: { base: 3000, slots: 8 },
  //   be: { base: 8000, slots: 8 },
  // },
};
