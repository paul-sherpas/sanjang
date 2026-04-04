import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Diagnosis: pattern-match logs to identify fixable issues
// ---------------------------------------------------------------------------

export interface HealAction {
  type: "reinstall" | "copy-env" | "restart" | "ask-ai";
  message: string;
  auto: boolean; // can be fixed without human input
}

const PATTERNS: Array<{ test: RegExp; action: () => HealAction }> = [
  {
    test: /Cannot find module|MODULE_NOT_FOUND/i,
    action: () => ({
      type: "reinstall",
      message: "필요한 패키지가 없습니다. 다시 설치합니다.",
      auto: true,
    }),
  },
  {
    test: /does not provide an export named|env\/static\/public/i,
    action: () => ({
      type: "copy-env",
      message: "환경 설정 파일이 없습니다. 메인에서 복사합니다.",
      auto: true,
    }),
  },
  {
    test: /ENOENT.*\.env/i,
    action: () => ({
      type: "copy-env",
      message: ".env 파일을 찾을 수 없습니다. 메인에서 복사합니다.",
      auto: true,
    }),
  },
  {
    test: /403.*Forbidden|server\.fs\.allow/i,
    action: () => ({
      type: "reinstall",
      message: "파일 접근 문제가 있습니다. 의존성을 다시 설치합니다.",
      auto: true,
    }),
  },
  {
    test: /EADDRINUSE|address already in use/i,
    action: () => ({
      type: "restart",
      message: "다른 프로그램과 충돌이 있습니다. 다시 시작합니다.",
      auto: true,
    }),
  },
];

export function diagnoseFromLogs(logs: string[]): HealAction[] {
  const combined = logs.join("\n");
  const actions: HealAction[] = [];
  const seenTypes = new Set<string>();

  for (const pattern of PATTERNS) {
    if (pattern.test.test(combined)) {
      const action = pattern.action();
      if (!seenTypes.has(action.type)) {
        seenTypes.add(action.type);
        actions.push(action);
      }
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Heal: execute fixes
// ---------------------------------------------------------------------------

export interface HealResult {
  action: HealAction;
  success: boolean;
  detail?: string;
}

export function executeHeal(
  action: HealAction,
  campPath: string,
  projectRoot: string,
  setupCommand: string | null,
  copyFiles: string[],
): HealResult {
  switch (action.type) {
    case "reinstall": {
      if (!setupCommand) return { action, success: false, detail: "설치 명령이 없습니다." };
      try {
        execSync(setupCommand, {
          cwd: campPath,
          stdio: "pipe",
          timeout: 120_000,
          shell: true,
        } as unknown as import("node:child_process").ExecSyncOptions);
        return { action, success: true };
      } catch {
        return { action, success: false, detail: "설치에 실패했습니다." };
      }
    }

    case "copy-env": {
      let copied = 0;
      for (const file of copyFiles) {
        const src = join(projectRoot, file);
        const dst = join(campPath, file);
        if (existsSync(src) && !existsSync(dst)) {
          try {
            mkdirSync(dirname(dst), { recursive: true });
            copyFileSync(src, dst);
            copied++;
          } catch {
            /* skip */
          }
        }
      }
      return {
        action,
        success: copied > 0,
        detail: copied > 0 ? `${copied}개 파일 복사됨` : "복사할 파일이 없습니다.",
      };
    }

    case "restart":
      // Restart is handled by the caller (stop + start)
      return { action, success: true, detail: "재시작을 시도합니다." };

    case "ask-ai":
      return { action, success: false, detail: "자동 수정할 수 없습니다." };

    default:
      return { action, success: false, detail: "알 수 없는 액션입니다." };
  }
}
