#!/usr/bin/env node

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const command = args[0];

// Parse options
let projectRoot = process.cwd();
let port = 4000;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--project' && args[i + 1]) {
    projectRoot = resolve(args[i + 1]);
    i++;
  }
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1]);
    i++;
  }
}

// Find git root
try {
  projectRoot = execSync('git rev-parse --show-toplevel', {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
} catch {
  console.error('⛰ 산장: git 저장소를 찾을 수 없습니다.');
  console.error('  git 저장소 안에서 실행해주세요.');
  process.exit(1);
}

if (command === 'init') {
  // Generate config
  const { generateConfig } = await import('../lib/config.js');
  const result = generateConfig(projectRoot);

  if (result.created) {
    console.log(`⛰ ${result.message}`);
    console.log(`  프레임워크: ${result.framework}`);
    console.log(`  설정 파일: ${result.configPath}`);
  } else {
    console.log(`⛰ ${result.message}`);
  }

  // Add .sanjang to .gitignore if not present
  const gitignorePath = resolve(projectRoot, '.gitignore');
  if (existsSync(gitignorePath)) {
    const content = (await import('node:fs')).readFileSync(gitignorePath, 'utf8');
    if (!content.includes('.sanjang')) {
      (await import('node:fs')).appendFileSync(gitignorePath, '\n# Sanjang local dev camps\n.sanjang/\n');
      console.log('  .gitignore에 .sanjang/ 추가됨');
    }
  }

  // Auto-start server unless --no-start
  const noStart = args.includes('--no-start');
  if (!noStart) {
    console.log('');
    console.log('  서버를 시작합니다...');
    const { startServer } = await import('../lib/server.js');
    await startServer(projectRoot, { port });
  } else {
    console.log('');
    console.log('  다음 단계: sanjang 또는 npx sanjang 으로 서버를 시작하세요.');
  }
} else if (command === 'help' || command === '--help' || command === '-h') {
  console.log(`
⛰ 산장 (Sanjang) — 바이브코더를 위한 로컬 개발 환경 매니저

사용법:
  sanjang              서버 시작 (대시보드: http://localhost:4000)
  sanjang init         프로젝트 분석 → sanjang.config.js 생성
  sanjang help         이 도움말

옵션:
  --port <N>           대시보드 포트 (기본: 4000)
  --project <path>     프로젝트 경로 (기본: 현재 디렉토리)

자세히: https://github.com/paul-sherpas/sanjang
`);
} else {
  // Default: start server
  const { startServer } = await import('../lib/server.js');
  await startServer(projectRoot, { port });
}
