import { execSync } from 'node:child_process';

interface ProcessInfo {
  feLogs?: string[];
  feExitCode: number | null;
}

interface PlaygroundInfo {
  fePort: number;
}

interface DiagnosticCheck {
  name: string;
  status: string;
  detail: string;
  guide: string | null;
}

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function checkPortConflict(processInfo: ProcessInfo): DiagnosticCheck {
  const combined = (processInfo.feLogs ?? []).join('');
  const hit = /address already in use/i.test(combined);
  return {
    name: 'port-conflict',
    status: hit ? 'error' : 'ok',
    detail: hit
      ? '포트가 이미 사용 중입니다.'
      : '포트 충돌 없음.',
    guide: hit
      ? '다른 프로그램이 같은 포트를 쓰고 있어요. "중지" → "시작"을 눌러보세요. 계속되면 "삭제" 후 다시 만들어보세요.'
      : null,
  };
}

function checkFrontendExit(processInfo: ProcessInfo): DiagnosticCheck {
  const { feExitCode, feLogs } = processInfo;

  if (feExitCode === null || feExitCode === 0) {
    return {
      name: 'frontend-exit',
      status: 'ok',
      detail: feExitCode === 0 ? 'Frontend가 정상 종료되었습니다.' : 'Frontend 프로세스 실행 중.',
      guide: null,
    };
  }

  const tail = (feLogs ?? []).join('').slice(-500);
  const isModuleError = /MODULE_NOT_FOUND|Cannot find module/i.test(tail);
  const guide = isModuleError
    ? '필요한 패키지가 없어요. "처음부터 다시"를 눌러 의존성을 다시 설치해보세요.'
    : '서버가 에러로 종료됐어요. "처음부터 다시"를 누르거나, "디버그" 버튼으로 로그를 복사해서 Claude에게 물어보세요.';
  return {
    name: 'frontend-exit',
    status: 'error',
    detail: `Frontend가 비정상 종료되었습니다 (코드 ${feExitCode}).`,
    guide,
  };
}

function checkFePort(pg: PlaygroundInfo): DiagnosticCheck {
  const port = pg.fePort;
  const output = tryExec(`lsof -i :${port} -t`);

  return {
    name: 'fe-port',
    status: output?.length ? 'ok' : 'warn',
    detail: output?.length
      ? `Frontend 포트 ${port}이 사용 중 (PID: ${output}).`
      : `Frontend 포트 ${port}이 비어있습니다.`,
    guide: !output?.length
      ? '서버가 아직 준비 안 됐거나 종료됐어요. "시작" 버튼을 눌러보세요.'
      : null,
  };
}

export async function buildDiagnostics(pg: PlaygroundInfo, processInfo: ProcessInfo): Promise<DiagnosticCheck[]> {
  return [
    checkPortConflict(processInfo),
    checkFrontendExit(processInfo),
    checkFePort(pg),
  ];
}
