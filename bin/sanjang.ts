// Node 22+ required for --experimental-transform-types
const nodeVersion = parseInt(process.versions.node.split(".")[0]!, 10);
if (nodeVersion < 22) {
  console.error(`⛰ 산장: Node 22 이상이 필요합니다. (현재: v${process.versions.node})`);
  console.error("  해결: nvm install 22 && nvm use 22");
  console.error("  또는: https://nodejs.org 에서 최신 LTS를 설치하세요.");
  process.exit(1);
}

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const args: string[] = process.argv.slice(2);
const command: string | undefined = args[0];

// Parse options
let projectRoot: string = process.cwd();
let port: number = 4000;
let force: boolean = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--project" && args[i + 1]) {
    projectRoot = resolve(args[i + 1]!);
    i++;
  }
  if (args[i] === "--port" && args[i + 1]) {
    port = parseInt(args[i + 1]!, 10);
    i++;
  }
  if (args[i] === "--force") {
    force = true;
  }
}

// Find git root
try {
  projectRoot = execSync("git rev-parse --show-toplevel", {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
} catch {
  console.error("⛰ 산장: git 저장소를 찾을 수 없습니다.");
  console.error("  git 저장소 안에서 실행해주세요.");
  process.exit(1);
}

if (command === "init") {
  const { generateConfig, detectApps } = await import("../lib/config.ts");

  // Detect apps in subdirectories
  const apps = detectApps(projectRoot);
  let appDir: string | undefined;

  if (apps.length >= 2) {
    // Multi-app interview
    console.log("");
    console.log("⛰ 여러 앱이 감지되었습니다:");
    for (let i = 0; i < apps.length; i++) {
      console.log(`  ${i + 1}) ${apps[i]!.dir}/\t(${apps[i]!.framework})`);
    }
    console.log("");

    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question("  어떤 앱을 띄울까요? [번호]: ", resolve);
    });
    rl.close();

    const idx = parseInt(answer, 10) - 1;
    if (idx < 0 || idx >= apps.length || Number.isNaN(idx)) {
      console.error("⛰ 잘못된 선택입니다.");
      process.exit(1);
    }
    appDir = apps[idx]!.dir;
    console.log(`  → ${appDir}/ (${apps[idx]!.framework}) 선택됨`);
  } else if (apps.length === 1) {
    appDir = apps[0]!.dir;
  }

  const result = generateConfig(projectRoot, { appDir, force });

  if (result.created) {
    console.log(`⛰ ${result.message}`);
    console.log(`  프레임워크: ${result.framework}`);
    console.log(`  설정 파일: ${result.configPath}`);
  } else {
    console.log(`⛰ ${result.message}`);
  }

  // Add .sanjang to .gitignore if not present
  const gitignorePath = resolve(projectRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    const { readFileSync, appendFileSync } = await import("node:fs");
    const content = readFileSync(gitignorePath, "utf8");
    if (!content.includes(".sanjang")) {
      appendFileSync(gitignorePath, "\n# Sanjang local dev camps\n.sanjang/\n");
      console.log("  .gitignore에 .sanjang/ 추가됨");
    }
  }

  // Prebuild dependency cache
  const { loadConfig } = await import("../lib/config.ts");
  const initConfig = await loadConfig(projectRoot);
  if (initConfig.setup) {
    console.log("");
    console.log("  의존성 캐시를 빌드합니다...");
    const { buildCache } = await import("../lib/engine/cache.ts");
    const cacheResult = await buildCache(projectRoot, initConfig, (msg: string) => {
      console.log(`  ${msg}`);
    });
    if (cacheResult.success) {
      console.log(`  캐시 빌드 완료 ✓ (${(cacheResult.duration / 1000).toFixed(1)}초)`);
    } else {
      console.log(`  ⚠️ 캐시 빌드 실패: ${cacheResult.error}`);
      console.log("  캠프 생성 시 일반 설치를 사용합니다.");
    }
  }

  // Auto-start server unless --no-start
  const noStart = args.includes("--no-start");
  if (!noStart) {
    console.log("");
    console.log("  서버를 시작합니다...");
    const { startServer } = await import("../lib/server.ts");
    await startServer(projectRoot, { port });
  } else {
    console.log("");
    console.log("  다음 단계: sanjang 또는 npx sanjang 으로 서버를 시작하세요.");
  }
} else if (command === "help" || command === "--help" || command === "-h") {
  console.log(`
⛰ 산장 (Sanjang) — 비개발자가 AI로 코드를 고치고 PR을 보낼 수 있는 로컬 개발 환경

사용법:
  sanjang              서버 시작 (대시보드: http://localhost:4000)
  sanjang init         프로젝트 분석 → sanjang.config.js 생성
  sanjang list         캠프 목록 보기
  sanjang status       서버 + 캠프 상태 확인
  sanjang start <name> 캠프 시작
  sanjang stop <name>  캠프 중지
  sanjang open <name>  캠프를 브라우저에서 열기
  sanjang help         이 도움말

옵션:
  --port <N>           대시보드 포트 (기본: 4000)
  --project <path>     프로젝트 경로 (기본: 현재 디렉토리)
  --json               JSON으로 출력 (Claude Code 등 자동화용)
  --force              기존 설정을 덮어쓰고 다시 생성

자세히: https://github.com/paul-sherpas/sanjang
`);
} else if (command === "list" || command === "status" || command === "start" || command === "stop" || command === "open") {
  // CLI commands that talk to the running sanjang server
  const jsonMode = args.includes("--json");
  const campName = args[1] && !args[1]!.startsWith("-") ? args[1] : undefined;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function apiFetch(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const opts: RequestInit = { method, headers: { "content-type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${baseUrl}${path}`, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  async function tryApi<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).cause && String((err as NodeJS.ErrnoException).cause).includes("ECONNREFUSED")) {
        console.error("⛰ 산장 서버가 실행되지 않고 있습니다.");
        console.error(`  sanjang 또는 npx sanjang 으로 먼저 시작하세요.`);
        process.exit(1);
      }
      throw err;
    }
  }

  try {
    if (command === "list") {
      const camps = await tryApi(() => apiFetch("/api/playgrounds")) as Array<{
        name: string; branch: string; status: string; fePort?: number;
      }>;
      if (jsonMode) {
        process.stdout.write(JSON.stringify(camps, null, 2) + "\n");
      } else if (camps.length === 0) {
        console.log("⛰ 캠프가 없습니다. 대시보드에서 만들어보세요.");
      } else {
        console.log("⛰ 캠프 목록:\n");
        for (const c of camps) {
          const status = c.status === "running" ? "🟢" : c.status === "error" ? "🔴" : "⚪";
          const url = c.status === "running" && c.fePort ? `http://localhost:${c.fePort}` : "";
          console.log(`  ${status} ${c.name}\t${c.branch}\t${url}`);
        }
      }
    } else if (command === "status") {
      const camps = await tryApi(() => apiFetch("/api/playgrounds")) as Array<{
        name: string; status: string; fePort?: number;
      }>;
      const running = camps.filter(c => c.status === "running").length;
      const total = camps.length;
      if (jsonMode) {
        process.stdout.write(JSON.stringify({ server: { url: baseUrl, status: "running" }, camps }, null, 2) + "\n");
      } else {
        console.log(`⛰ 산장 서버: ${baseUrl}`);
        console.log(`  캠프: ${total}개 (실행 중 ${running}개)`);
        for (const c of camps) {
          const status = c.status === "running" ? "🟢" : c.status === "error" ? "🔴" : "⚪";
          console.log(`  ${status} ${c.name} (${c.status})`);
        }
      }
    } else if (command === "start") {
      if (!campName) { console.error("⛰ 사용법: sanjang start <캠프이름>"); process.exit(1); }
      const result = await tryApi(() => apiFetch(`/api/playgrounds/${campName}/start`, "POST"));
      if (jsonMode) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        console.log(`⛰ ${campName} 캠프를 시작합니다.`);
      }
    } else if (command === "stop") {
      if (!campName) { console.error("⛰ 사용법: sanjang stop <캠프이름>"); process.exit(1); }
      const result = await tryApi(() => apiFetch(`/api/playgrounds/${campName}/stop`, "POST"));
      if (jsonMode) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } else {
        console.log(`⛰ ${campName} 캠프를 중지합니다.`);
      }
    } else if (command === "open") {
      if (!campName) { console.error("⛰ 사용법: sanjang open <캠프이름>"); process.exit(1); }
      const camps = await tryApi(() => apiFetch("/api/playgrounds")) as Array<{
        name: string; status: string; fePort?: number;
      }>;
      const camp = camps.find(c => c.name === campName);
      if (!camp) { console.error(`⛰ "${campName}" 캠프를 찾을 수 없습니다.`); process.exit(1); }
      if (camp.status !== "running" || !camp.fePort) {
        console.error(`⛰ "${campName}" 캠프가 실행 중이 아닙니다. sanjang start ${campName} 을 먼저 실행하세요.`);
        process.exit(1);
      }
      const campUrl = `http://localhost:${camp.fePort}`;
      if (jsonMode) {
        process.stdout.write(JSON.stringify({ name: campName, url: campUrl, status: camp.status }, null, 2) + "\n");
      } else {
        console.log(`⛰ ${campName} 캠프를 브라우저에서 엽니다. → ${campUrl}`);
      }
      const { spawn: spawnOpen } = await import("node:child_process");
      const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      try { spawnOpen(openCmd, [campUrl], { stdio: "ignore", detached: true }).unref(); } catch { /* */ }
    }
  } catch (err) {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ error: (err as Error).message }, null, 2) + "\n");
    } else {
      console.error(`⛰ 오류: ${(err as Error).message}`);
    }
    process.exit(1);
  }
} else {
  // Default: start server — auto-init if no config exists
  const configPath = resolve(projectRoot, "sanjang.config.js");
  if (!existsSync(configPath)) {
    console.log("⛰ 설정 파일이 없습니다. 프로젝트를 분석합니다...\n");

    const { generateConfig, detectApps } = await import("../lib/config.ts");
    const apps = detectApps(projectRoot);
    let appDir: string | undefined;

    if (apps.length >= 2) {
      console.log("⛰ 여러 앱이 감지되었습니다:");
      for (let i = 0; i < apps.length; i++) {
        console.log(`  ${i + 1}) ${apps[i]!.dir}/\t(${apps[i]!.framework})`);
      }
      console.log("");
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((r) => {
        rl.question("  어떤 앱을 띄울까요? [번호]: ", r);
      });
      rl.close();
      const idx = parseInt(answer, 10) - 1;
      if (idx < 0 || idx >= apps.length || Number.isNaN(idx)) {
        console.error("⛰ 잘못된 선택입니다.");
        process.exit(1);
      }
      appDir = apps[idx]!.dir;
      console.log(`  → ${appDir}/ (${apps[idx]!.framework}) 선택됨\n`);
    } else if (apps.length === 1) {
      appDir = apps[0]!.dir;
    }

    const result = generateConfig(projectRoot, { appDir, force });
    if (result.created) {
      console.log(`⛰ ${result.message}`);
      console.log(`  프레임워크: ${result.framework}\n`);
    }

    // Add .sanjang to .gitignore
    const gitignorePath = resolve(projectRoot, ".gitignore");
    if (existsSync(gitignorePath)) {
      const { readFileSync, appendFileSync } = await import("node:fs");
      const content = readFileSync(gitignorePath, "utf8");
      if (!content.includes(".sanjang")) {
        appendFileSync(gitignorePath, "\n# Sanjang local dev camps\n.sanjang/\n");
      }
    }
  }

  const { startServer } = await import("../lib/server.ts");
  await startServer(projectRoot, { port });
}
