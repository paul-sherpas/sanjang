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
    port = parseInt(args[i + 1]!);
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

    const idx = parseInt(answer) - 1;
    if (idx < 0 || idx >= apps.length || isNaN(idx)) {
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
⛰ 산장 (Sanjang) — 바이브코더를 위한 로컬 개발 환경 매니저

사용법:
  sanjang              서버 시작 (대시보드: http://localhost:4000)
  sanjang init         프로젝트 분석 → sanjang.config.js 생성
  sanjang help         이 도움말

옵션:
  --port <N>           대시보드 포트 (기본: 4000)
  --project <path>     프로젝트 경로 (기본: 현재 디렉토리)
  --force              기존 설정을 덮어쓰고 다시 생성

자세히: https://github.com/paul-sherpas/sanjang
`);
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
      const answer = await new Promise<string>((r) => { rl.question("  어떤 앱을 띄울까요? [번호]: ", r); });
      rl.close();
      const idx = parseInt(answer) - 1;
      if (idx < 0 || idx >= apps.length || isNaN(idx)) {
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
