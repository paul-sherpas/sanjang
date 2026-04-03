import { execSync } from 'node:child_process';

function tryExec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function checkPortConflict(processInfo) {
  const combined = (processInfo.feLogs ?? []).join('');
  const hit = /address already in use/i.test(combined);
  return {
    name: 'port-conflict',
    status: hit ? 'error' : 'ok',
    detail: hit
      ? '포트가 이미 사용 중입니다. 다른 프로그램이 같은 포트를 점유하고 있을 수 있습니다.'
      : '포트 충돌 없음.',
  };
}

function checkFrontendExit(processInfo) {
  const { feExitCode, feLogs } = processInfo;

  if (feExitCode === null || feExitCode === 0) {
    return {
      name: 'frontend-exit',
      status: 'ok',
      detail: feExitCode === 0 ? 'Frontend가 정상 종료되었습니다.' : 'Frontend 프로세스 실행 중.',
    };
  }

  const tail = (feLogs ?? []).join('').slice(-500);
  return {
    name: 'frontend-exit',
    status: 'error',
    detail: `Frontend가 비정상 종료되었습니다 (코드 ${feExitCode}). 마지막 로그:\n${tail}`,
  };
}

function checkFePort(pg) {
  const port = pg.fePort;
  const output = tryExec(`lsof -i :${port} -t`);

  return {
    name: 'fe-port',
    status: output?.length ? 'ok' : 'warn',
    detail: output?.length
      ? `Frontend 포트 ${port}이 사용 중 (PID: ${output}).`
      : `Frontend 포트 ${port}이 비어있습니다.`,
  };
}

export async function buildDiagnostics(pg, processInfo) {
  return [
    checkPortConflict(processInfo),
    checkFrontendExit(processInfo),
    checkFePort(pg),
  ];
}
