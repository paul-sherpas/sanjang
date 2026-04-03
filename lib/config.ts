import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SanjangConfig, DetectedProject, DetectedApp, GenerateConfigResult } from './types.js';

const CONFIG_FILE: string = 'sanjang.config.js';

const DEFAULTS: SanjangConfig = {
  dev: {
    command: 'npm run dev',
    port: 3000,
    portFlag: '--port',
    cwd: '.',
    env: {},
  },
  setup: null,
  copyFiles: [],
  backend: null,
  ports: {
    fe: { base: 3000, slots: 8 },
    be: { base: 8000, slots: 8 },
  },
};

/**
 * Load sanjang.config.js from project root.
 * Returns merged config with defaults.
 */
export async function loadConfig(projectRoot: string): Promise<SanjangConfig> {
  const configPath = join(projectRoot, CONFIG_FILE);

  if (!existsSync(configPath)) {
    console.warn('⚠️ sanjang.config.js를 찾을 수 없습니다. 기본 설정을 사용합니다.');
    console.warn('  → sanjang init 으로 프로젝트에 맞는 설정을 생성하세요.');
    return { ...DEFAULTS, _autoDetected: false };
  }

  try {
    const mod = await import(pathToFileURL(configPath).href);
    const userConfig = mod.default || mod;
    return mergeConfig(userConfig);
  } catch (err) {
    console.error(`sanjang.config.js 로드 실패: ${(err as Error).message}`);
    return { ...DEFAULTS, _autoDetected: false };
  }
}

function mergeConfig(user: Record<string, unknown>): SanjangConfig {
  const config: SanjangConfig = { ...DEFAULTS };

  if (typeof user.dev === 'string') {
    config.dev = { ...DEFAULTS.dev, command: user.dev };
  } else if (user.dev) {
    config.dev = { ...DEFAULTS.dev, ...(user.dev as Partial<SanjangConfig['dev']>) };
  }

  if (user.setup) config.setup = user.setup as string;
  if (user.copyFiles) config.copyFiles = user.copyFiles as string[];
  if (user.backend) config.backend = user.backend as SanjangConfig['backend'];
  if (user.ports) {
    const userPorts = user.ports as Partial<SanjangConfig['ports']>;
    config.ports = {
      fe: { ...DEFAULTS.ports.fe, ...userPorts.fe },
      be: { ...DEFAULTS.ports.be, ...userPorts.be },
    };
  }

  return config;
}

/**
 * Auto-detect project type and generate config.
 */
export function detectProject(projectRoot: string): DetectedProject {
  const has = (f: string): boolean => existsSync(join(projectRoot, f));
  const readJson = (f: string): Record<string, unknown> | null => {
    try { return JSON.parse(readFileSync(join(projectRoot, f), 'utf8')) as Record<string, unknown>; }
    catch { return null; }
  };

  // Framework detection
  if (has('next.config.js') || has('next.config.mjs') || has('next.config.ts')) {
    return {
      framework: 'Next.js',
      dev: { command: 'npx next dev', port: 3000, portFlag: '-p', cwd: '.', env: {} },
      setup: has('bun.lockb') ? 'bun install' : has('pnpm-lock.yaml') ? 'pnpm install' : 'npm install',
      copyFiles: findEnvFiles(projectRoot),
    };
  }

  if (has('nuxt.config.js') || has('nuxt.config.ts')) {
    return {
      framework: 'Nuxt',
      dev: { command: 'npx nuxt dev', port: 3000, portFlag: '--port', cwd: '.', env: {} },
      setup: detectPackageManager(projectRoot),
      copyFiles: findEnvFiles(projectRoot),
    };
  }

  if (has('svelte.config.js') || has('svelte.config.ts')) {
    return {
      framework: 'SvelteKit',
      dev: { command: 'npx vite dev', port: 5173, portFlag: '--port', cwd: '.', env: {} },
      setup: detectPackageManager(projectRoot),
      copyFiles: findEnvFiles(projectRoot),
    };
  }

  if (has('angular.json')) {
    return {
      framework: 'Angular',
      dev: { command: 'npx ng serve', port: 4200, portFlag: '--port', cwd: '.', env: {} },
      setup: 'npm install',
      copyFiles: findEnvFiles(projectRoot),
    };
  }

  if (has('vite.config.js') || has('vite.config.ts') || has('vite.config.mjs')) {
    return {
      framework: 'Vite',
      dev: { command: 'npx vite dev', port: 5173, portFlag: '--port', cwd: '.', env: {} },
      setup: detectPackageManager(projectRoot),
      copyFiles: findEnvFiles(projectRoot),
    };
  }

  // ClojureScript / shadow-cljs (root or common subdirectories)
  const shadowDirs = ['.', 'frontend', 'client', 'web', 'app'];
  for (const dir of shadowDirs) {
    const prefix = dir === '.' ? '' : `${dir}/`;
    if (has(`${prefix}shadow-cljs.edn`)) {
      const hasBb = has(`${prefix}bb.edn`);
      return {
        framework: 'shadow-cljs',
        dev: { command: hasBb ? 'bb dev' : 'npx shadow-cljs watch app', port: 3000, portFlag: null, cwd: dir, env: {} },
        setup: 'npm install',
        copyFiles: findEnvFiles(projectRoot),
      };
    }
  }

  // Monorepo detection
  if (has('turbo.json')) {
    const turbo = readJson('turbo.json');
    return {
      framework: 'Turborepo',
      dev: { command: 'npx turbo run dev', port: 3000, portFlag: null, cwd: '.', env: {} },
      setup: detectPackageManager(projectRoot),
      copyFiles: findEnvFiles(projectRoot),
      _note: 'Turborepo detected. You may need to adjust the dev command to filter a specific app.',
    };
  }

  // Fallback: package.json scripts
  const pkg = readJson('package.json');
  if ((pkg?.scripts as Record<string, unknown> | undefined)?.dev) {
    return {
      framework: 'Node.js',
      dev: { command: 'npm run dev', port: 3000, portFlag: '--port', cwd: '.', env: {} },
      setup: detectPackageManager(projectRoot),
      copyFiles: findEnvFiles(projectRoot),
    };
  }

  return {
    framework: 'unknown',
    dev: { command: 'npm run dev', port: 3000, portFlag: '--port', cwd: '.', env: {} },
    setup: 'npm install',
    copyFiles: [],
  };
}

/**
 * Scan first-level subdirectories for app candidates.
 * Returns array of { dir, framework, detected } sorted by dir name.
 */
export function detectApps(projectRoot: string): DetectedApp[] {
  const entries = readdirSync(projectRoot, { withFileTypes: true });
  const ignore = new Set(["node_modules", ".git", ".sanjang", "dist", "build", ".next", ".nuxt"]);

  const apps: DetectedApp[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || ignore.has(entry.name)) continue;

    const subPath = join(projectRoot, entry.name);
    const detected = detectProject(subPath);
    if (detected.framework === "unknown") continue;

    apps.push({
      dir: entry.name,
      framework: detected.framework,
      detected,
    });
  }

  return apps.sort((a, b) => a.dir.localeCompare(b.dir));
}

function detectPackageManager(root: string): string {
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun install';
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm install';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn install';
  return 'npm install';
}

function findEnvFiles(root: string): string[] {
  const envFiles = ['.env', '.env.local', '.env.development', '.env.development.local'];
  return envFiles.filter(f => existsSync(join(root, f)));
}

export function generateConfig(projectRoot: string, options: { appDir?: string; force?: boolean } = {}): GenerateConfigResult {
  const { appDir, force } = options;
  const configPath = join(projectRoot, CONFIG_FILE);

  if (existsSync(configPath) && !force) {
    return { created: false, message: 'sanjang.config.js already exists.' };
  }

  // Detect from selected app subdirectory or root
  const detectRoot = appDir ? join(projectRoot, appDir) : projectRoot;
  const detected = detectProject(detectRoot);

  // Override cwd and setup for subdirectory apps
  if (appDir && appDir !== '.') {
    detected.dev.cwd = appDir;
    if (detected.setup) {
      detected.setup = `cd '${appDir.replace(/'/g, "'\\''")}' && ${detected.setup}`;
    }
    detected.copyFiles = findEnvFiles(join(projectRoot, appDir)).map(f => `${appDir}/${f}`);
  }

  const lines = [
    'export default {',
    `  // ${detected.framework} detected`,
    '',
    '  // Dev server command',
    '  dev: {',
    `    command: '${detected.dev.command}',`,
    `    port: ${detected.dev.port},`,
    `    portFlag: ${detected.dev.portFlag ? `'${detected.dev.portFlag}'` : 'null'},`,
    `    cwd: '${detected.dev.cwd}',`,
    '  },',
    '',
  ];

  if (detected.setup) {
    lines.push(`  // Install dependencies after creating a camp`);
    lines.push(`  setup: '${detected.setup}',`);
    lines.push('');
  }

  if (detected.copyFiles.length) {
    lines.push('  // Copy gitignored files from main repo');
    lines.push(`  copyFiles: ${JSON.stringify(detected.copyFiles)},`);
    lines.push('');
  }

  if (detected._note) {
    lines.push(`  // NOTE: ${detected._note}`);
    lines.push('');
  }

  lines.push('  // (optional) Backend server');
  lines.push('  // backend: {');
  lines.push("  //   command: 'npm run start:api',");
  lines.push('  //   port: 8000,');
  lines.push("  //   healthCheck: '/health',");
  lines.push('  // },');
  lines.push('};');
  lines.push('');

  writeFileSync(configPath, lines.join('\n'), 'utf8');

  return {
    created: true,
    framework: detected.framework,
    configPath,
    message: `sanjang.config.js created (${detected.framework} detected).`,
  };
}
