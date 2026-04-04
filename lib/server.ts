import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "./config.ts";
import { applyCacheToWorktree, buildCache, isCacheValid } from "./engine/cache.ts";
import { buildConflictPrompt, parseConflictFiles } from "./engine/conflict.ts";
import { buildDiagnostics } from "./engine/diagnostics.ts";
import { aiSlugify, slugify } from "./engine/naming.ts";
import { allocate, scanPorts, setPortConfig } from "./engine/ports.ts";
import { buildClaudePrPrompt, buildFallbackPrBody } from "./engine/pr.ts";
import { getProcessInfo, setConfig, startCamp, stopAllCamps, stopCamp } from "./engine/process.ts";
import { listSnapshots, restoreSnapshot, saveSnapshot } from "./engine/snapshot.ts";
import { getAll, getOne, remove, setCampsDir, upsert } from "./engine/state.ts";
import { detectWarp, openWarpTab, removeLaunchConfig } from "./engine/warp.ts";
import { CampWatcher } from "./engine/watcher.ts";
import { diagnoseFromLogs, executeHeal } from "./engine/self-heal.ts";
import { suggestTasks } from "./engine/suggest.ts";
import { generatePrDescription } from "./engine/smart-pr.ts";
import { suggestConfigFix, applyConfigFix } from "./engine/config-hotfix.ts";
import {
  addWorktree,
  campPath,
  getProjectRoot,
  listBranches,
  removeWorktree,
  setProjectRoot,
} from "./engine/worktree.ts";

import type { BroadcastMessage, Camp, SanjangConfig } from "./types.ts";

// Typed request helpers for Express strict mode
type NameParams = { name: string };
type NameReq = Request<NameParams>;

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChangedFile {
  path: string;
  status: string;
}

interface ActionEntry {
  description: string;
  files: string[];
  timestamp?: string;
  ts?: number;
}

interface CreateAppOptions {
  port?: number;
}

interface CreateAppResult {
  app: express.Application;
  server: Server;
  port: number;
  runningTasks: Map<string, ChildProcess>;
  warpStatus: { installed: boolean };
  watchers: Map<string, CampWatcher>;
}

interface WorkItem {
  type: "pr" | "camp";
  title: string;
  prNumber?: number;
  prUrl?: string;
  branch: string;
  updatedAt?: string;
  isDraft?: boolean;
  reviewStatus?: string;
  status?: string;
  camp: string | null;
}

interface PrInfo {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  updatedAt: string;
  isDraft: boolean;
  reviewDecision: string;
}

// ---------------------------------------------------------------------------
// Error translation
// ---------------------------------------------------------------------------

function runGit(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr?.trim() || `git ${args[0]} failed`);
  return r.stdout || "";
}

function getChangedFiles(wtPath: string): ChangedFile[] {
  const diff = (
    spawnSync("git", ["-C", wtPath, "diff", "--name-status"], { encoding: "utf8", stdio: "pipe" }).stdout || ""
  ).trim();
  const untracked = (
    spawnSync("git", ["-C", wtPath, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8", stdio: "pipe" })
      .stdout || ""
  ).trim();
  const files: ChangedFile[] = [];
  if (diff) {
    for (const line of diff.split("\n")) {
      const [status, ...pathParts] = line.split("\t");
      files.push({
        path: pathParts.join("\t"),
        status: status === "M" ? "수정" : status === "D" ? "삭제" : status === "A" ? "추가" : status!,
      });
    }
  }
  if (untracked) {
    for (const p of untracked.split("\n")) files.push({ path: p, status: "새 파일" });
  }
  return files;
}

function copyCampFiles(
  projectRoot: string,
  wtPath: string,
  copyFiles: string[] | undefined,
  onLog?: (msg: string) => void,
): void {
  if (!copyFiles?.length) return;
  for (const file of copyFiles) {
    try {
      copyFileSync(join(projectRoot, file), join(wtPath, file));
      onLog?.(`${file} 복사 완료 ✓`);
    } catch {
      onLog?.(`⚠️ ${file} 파일을 찾을 수 없습니다.`);
    }
  }
}

function friendlyError(err: unknown, branch: string): string {
  const msg = (err as Error)?.message || String(err);
  if (/invalid reference/.test(msg)) return `"${branch}" 브랜치를 찾을 수 없습니다.`;
  if (/already exists/.test(msg)) return "이미 같은 이름의 캠프가 있습니다.";
  if (/already checked out/.test(msg)) return "이 브랜치가 다른 곳에서 사용 중입니다.";
  if (/No available port/.test(msg)) return "캠프를 더 만들 수 없습니다. 기존 캠프를 삭제해주세요.";
  if (/cache copy failed/.test(msg)) return "설치 준비에 실패했습니다. 다시 시도해주세요.";
  if (/setup failed/.test(msg)) return "의존성 설치에 실패했습니다. 다시 시도해주세요.";
  if (/ENOSPC/.test(msg)) return "디스크 공간이 부족합니다.";
  return msg;
}

function friendlyStartError(err: unknown): string {
  const msg = (err as Error)?.message || String(err);
  if (/Timeout|시작되지 않았|열리지/.test(msg)) return "시작하는 데 시간이 오래 걸리고 있습니다. 다시 시도해주세요.";
  if (/ECONNREFUSED/.test(msg)) return "서버에 연결할 수 없습니다. 다시 시도해주세요.";
  return msg;
}

function updateCampStatus(name: string, status: Camp["status"], extra?: Partial<Camp>): void {
  const camp = getOne(name);
  if (!camp) return; // camp may have been deleted during async setup
  upsert({ ...camp, status, ...extra });
}

function setupCampDeps(
  name: string,
  wtPath: string,
  cfg: SanjangConfig,
  broadcast: (msg: BroadcastMessage) => void,
): void {
  if (!cfg.setup) {
    updateCampStatus(name, "stopped");
    broadcast({ type: "playground-status", name, data: { status: "stopped" } });
    return;
  }

  const setupCwd = cfg.dev?.cwd || ".";
  const isBun = cfg.setup.includes("bun install");

  // bun projects: skip cache (bun uses absolute symlinks that break in worktrees)
  if (!isBun) {
    const cacheResult = applyCacheToWorktree(getProjectRoot(), wtPath, setupCwd);
    if (cacheResult.applied) {
      broadcast({
        type: "log",
        name,
        source: "sanjang",
        data: `캐시에서 node_modules 복사 완료 ✓ (${cacheResult.duration}ms)`,
      });
      updateCampStatus(name, "stopped");
      broadcast({ type: "playground-status", name, data: { status: "stopped" } });
      return;
    }
    broadcast({ type: "log", name, source: "sanjang", data: `캐시 없음 (${cacheResult.reason}), 설치 중...` });
  } else {
    broadcast({ type: "log", name, source: "sanjang", data: "bun install 실행 중... (bun은 캐시 대신 직접 설치)" });
  }
  const setupProc = spawn(cfg.setup, [], {
    cwd: wtPath,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  setupProc.stdout!.on("data", (d: Buffer) => {
    broadcast({ type: "log", name, source: "setup", data: d.toString() });
  });
  setupProc.stderr!.on("data", (d: Buffer) => {
    broadcast({ type: "log", name, source: "setup", data: d.toString() });
  });
  setupProc.on("close", (code: number | null) => {
    if (code === 0) {
      broadcast({ type: "log", name, source: "sanjang", data: "설치 완료 ✓" });
      updateCampStatus(name, "stopped");
      broadcast({ type: "playground-status", name, data: { status: "stopped" } });
    } else {
      broadcast({ type: "log", name, source: "sanjang", data: `⚠️ 설치 실패 (코드 ${code})` });
      updateCampStatus(name, "error");
      broadcast({ type: "playground-status", name, data: { status: "error", error: "의존성 설치에 실패했습니다." } });
    }
  });
}

// ---------------------------------------------------------------------------
const MAX_CAMPS = 7;

// Initialize
// ---------------------------------------------------------------------------

export async function createApp(projectRoot: string, options: CreateAppOptions = {}): Promise<CreateAppResult> {
  const port = options.port ?? 4000;

  // Initialize modules
  setProjectRoot(projectRoot);

  const campsDir = join(projectRoot, ".sanjang", "camps");
  setCampsDir(campsDir);

  const config = await loadConfig(projectRoot);
  setConfig(config);

  if (config.ports) setPortConfig(config.ports);

  // Reset stale running/starting statuses from previous sessions
  for (const camp of getAll()) {
    if (camp.status === "running" || camp.status === "starting") {
      upsert({ ...camp, status: "stopped" });
    }
  }

  // Warp detection (cached for this server instance)
  const warpStatus = detectWarp();

  // File watchers for running camps — push changes via WebSocket
  const watchers = new Map<string, CampWatcher>();

  function startWatcher(name: string): void {
    if (watchers.has(name)) return;
    const wtPath = campPath(name);
    const watcher = new CampWatcher(wtPath, () => {
      try {
        const files = getChangedFiles(wtPath);
        broadcast({
          type: "file-changes",
          name,
          data: { count: files.length, files, ts: Date.now() },
        });
      } catch { /* ignore — worktree may be deleted */ }
    }, 800);
    watcher.start();
    watchers.set(name, watcher);
  }

  function stopWatcher(name: string): void {
    const w = watchers.get(name);
    if (w) {
      w.stop();
      watchers.delete(name);
    }
  }

  // Express app
  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, "..", "dashboard")));

  const server = createServer(app);
  const wss = new WebSocketServer({ server });

  function broadcast(msg: BroadcastMessage): void {
    const text = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(text);
    }
  }

  wss.on("connection", (ws: WebSocket) => {
    ws.on("error", (err: Error) => console.error("[ws] client error:", err.message));
  });

  // -------------------------------------------------------------------------
  // REST API
  // -------------------------------------------------------------------------

  // Project info — used by dashboard header
  const projectName = projectRoot.split("/").pop() ?? "project";
  app.get("/api/project", (_req: Request, res: Response) => res.json({ name: projectName }));

  app.get("/api/ports", (_req: Request, res: Response) => res.json(scanPorts()));

  app.get("/api/branches", async (_req: Request, res: Response) => {
    try {
      res.json(await listBranches());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/playgrounds", (_req: Request, res: Response) => res.json(getAll()));

  app.post("/api/playgrounds", async (req: Request, res: Response) => {
    const { name, branch } = req.body ?? {};
    if (!name) return res.status(400).json({ error: "name is required" });
    if (!branch) return res.status(400).json({ error: "branch is required" });
    if (!/^[a-z0-9-]+$/.test(name)) return res.status(400).json({ error: "name must match /^[a-z0-9-]+$/" });
    if (!/^[a-zA-Z0-9/_.-]+$/.test(branch))
      return res.status(400).json({ error: "branch name contains invalid characters" });

    const existing = getAll();
    if (getOne(name)) return res.status(409).json({ error: `'${name}' 캠프가 이미 있습니다.` });
    if (existing.length >= MAX_CAMPS)
      return res.status(400).json({ error: `최대 ${MAX_CAMPS}개 캠프까지 가능합니다.` });

    try {
      // Reload config for each camp creation (hot reload)
      const freshConfig = await loadConfig(projectRoot);
      setConfig(freshConfig);
      if (freshConfig.ports) setPortConfig(freshConfig.ports);

      const { slot, fePort, bePort } = allocate(existing);
      // When portFlag is null, dev server uses its own fixed port
      const actualFePort = freshConfig.dev?.portFlag ? fePort : freshConfig.dev?.port || fePort;
      await addWorktree(name, branch);

      const wtPath = campPath(name);

      // Copy gitignored files first (sync, fast)
      copyCampFiles(projectRoot, wtPath, freshConfig.copyFiles, (msg: string) => {
        broadcast({ type: "log", name, source: "sanjang", data: msg });
      });

      const baseCommit = spawnSync("git", ["-C", wtPath, "rev-parse", "HEAD"], { encoding: "utf8", stdio: "pipe" }).stdout?.trim() || undefined;
      const record: Camp = { name, branch, slot, fePort: actualFePort, bePort, status: "setting-up", baseCommit, parentBranch: branch };
      upsert(record);
      broadcast({ type: "playground-created", name, data: record });
      res.status(201).json(record);

      setupCampDeps(name, wtPath, freshConfig, broadcast);
    } catch (err) {
      // Clean up orphan worktree on failure
      try {
        await removeWorktree(name);
      } catch {
        /* may not exist */
      }
      res.status(500).json({ error: friendlyError(err, branch) });
    }
  });

  // Track in-flight start operations
  const startingSet = new Set<string>();

  app.post("/api/playgrounds/:name/start", async (req: NameReq, res: Response) => {
    const { name } = req.params;
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: "not found" });
    if (startingSet.has(name)) return res.json({ status: "already-starting" });

    startingSet.add(name);
    upsert({ ...pg, status: "starting" });
    broadcast({ type: "playground-status", name, data: { status: "starting" } });
    res.json({ status: "starting" });

    (async () => {
      try {
        const detectedPort = await startCamp(pg, (event) => {
          broadcast({ type: event.type, name, data: event.data, source: event.source });
        });
        const url = `http://localhost:${detectedPort}`;
        const updatedCamp = { ...getOne(name)!, status: "running" as const, fePort: detectedPort, url };
        upsert(updatedCamp);
        broadcast({ type: "playground-status", name, data: { status: "running", url } });
        startWatcher(name);
      } catch (err) {
        const current = getOne(name) ?? pg;
        const processInfo = getProcessInfo(name) ?? { feLogs: [], feExitCode: null };

        // Self-heal: try to auto-fix before giving up
        const healActions = diagnoseFromLogs(processInfo.feLogs);
        const autoFixable = healActions.filter(a => a.auto);

        if (autoFixable.length > 0) {
          broadcast({ type: "log", name, source: "sanjang", data: "문제를 발견했습니다. 자동으로 고치는 중..." });

          const freshConfig = await loadConfig(projectRoot);
          const wtPath = campPath(name);
          let healed = false;

          for (const action of autoFixable) {
            broadcast({ type: "log", name, source: "sanjang", data: `  → ${action.message}` });
            const result = executeHeal(action, wtPath, projectRoot, freshConfig.setup, freshConfig.copyFiles);
            if (result.success) healed = true;
          }

          if (healed) {
            broadcast({ type: "log", name, source: "sanjang", data: "수정 완료. 다시 시작합니다..." });
            upsert({ ...current, status: "starting" });
            broadcast({ type: "playground-status", name, data: { status: "starting" } });

            try {
              const retryPort = await startCamp(current, (event) => {
                broadcast({ type: event.type, name, data: event.data, source: event.source });
              });
              const retryUrl = `http://localhost:${retryPort}`;
              upsert({ ...getOne(name)!, status: "running", fePort: retryPort, url: retryUrl });
              broadcast({ type: "playground-status", name, data: { status: "running", url: retryUrl } });
              startWatcher(name);
              broadcast({ type: "log", name, source: "sanjang", data: "자동 복구 성공 ✓" });
              return; // healed successfully
            } catch {
              // retry failed too, fall through to error
            }
          }
        }

        upsert({ ...current, status: "error" });
        broadcast({ type: "playground-status", name, data: { status: "error", error: friendlyStartError(err) } });
        const diagnostics = await buildDiagnostics(current, processInfo);
        broadcast({ type: "playground-diagnostics", name, data: diagnostics });
      } finally {
        startingSet.delete(name);
      }
    })();
  });

  app.post("/api/playgrounds/:name/stop", (req: NameReq, res: Response) => {
    const { name } = req.params;
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: "not found" });
    startingSet.delete(name);
    stopCamp(name);
    stopWatcher(name);
    upsert({ ...pg, status: "stopped" });
    broadcast({ type: "playground-status", name, data: { status: "stopped" } });
    res.json({ status: "stopped" });
  });

  app.delete("/api/playgrounds/:name", async (req: NameReq, res: Response) => {
    const { name } = req.params;
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: "not found" });
    try {
      startingSet.delete(name);
      stopCamp(name);
      stopWatcher(name);
      await removeWorktree(name);
      remove(name);
      removeLaunchConfig(name);
      broadcast({ type: "playground-deleted", name, data: null });
      res.json({ deleted: true });
    } catch (err) {
      remove(name);
      removeLaunchConfig(name);
      broadcast({ type: "playground-deleted", name, data: null });
      res.json({ deleted: true, warning: (err as Error).message });
    }
  });

  app.post("/api/playgrounds/:name/snapshot", async (req: NameReq, res: Response) => {
    const { name } = req.params;
    const { label } = req.body ?? {};
    if (!getOne(name)) return res.status(404).json({ error: "not found" });
    try {
      await saveSnapshot(name, label ?? new Date().toISOString());
      res.json({ saved: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/playgrounds/:name/restore", async (req: NameReq, res: Response) => {
    const { name } = req.params;
    const { index } = req.body ?? {};
    if (!getOne(name)) return res.status(404).json({ error: "not found" });
    const idx = parseInt(index, 10);
    if (!Number.isFinite(idx) || idx < 0)
      return res.status(400).json({ error: "index must be a non-negative integer" });
    try {
      await restoreSnapshot(name, idx);
      res.json({ restored: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/playgrounds/:name/snapshots", async (req: NameReq, res: Response) => {
    const { name } = req.params;
    if (!getOne(name)) return res.status(404).json({ error: "not found" });
    try {
      res.json(await listSnapshots(name));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // POST /api/playgrounds/:name/save — 💾 세이브 (auto git add + AI commit message + commit)
  app.post("/api/playgrounds/:name/save", async (req: NameReq, res: Response) => {
    const { name } = req.params;
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: "not found" });
    const wtPath = campPath(name);

    const files = getChangedFiles(wtPath);
    if (files.length === 0) return res.json({ saved: false, reason: "변경사항이 없습니다." });

    try {
      // Reattach to branch if in detached HEAD state
      const headRef = spawnSync("git", ["-C", wtPath, "symbolic-ref", "--quiet", "HEAD"], { encoding: "utf8", stdio: "pipe" });
      if (headRef.status !== 0 && pg.branch) {
        // Detached HEAD — move branch pointer to current commit and checkout
        const currentCommit = spawnSync("git", ["-C", wtPath, "rev-parse", "HEAD"], { encoding: "utf8", stdio: "pipe" }).stdout?.trim();
        if (currentCommit) {
          spawnSync("git", ["-C", wtPath, "branch", "-f", pg.branch, currentCommit], { stdio: "pipe" });
          spawnSync("git", ["-C", wtPath, "checkout", pg.branch], { stdio: "pipe" });
        }
      }

      // Stage all changes
      runGit(["-C", wtPath, "add", "-A"], wtPath);

      // Generate commit message with AI
      const diff = spawnSync("git", ["-C", wtPath, "diff", "--cached", "--stat"], { encoding: "utf8", stdio: "pipe" }).stdout || "";
      let message = `${files.length}개 파일 변경`;
      try {
        const aiResult = spawnSync(
          "claude",
          ["-p", "--model", "haiku", `이 git diff를 한국어 커밋 메시지로 작성해. 한 줄, 50자 이내, 설명 없이 메시지만:\n\n${diff.slice(0, 2000)}`],
          { encoding: "utf8", stdio: "pipe", timeout: 10_000 },
        );
        if (aiResult.status === 0 && aiResult.stdout?.trim()) {
          message = aiResult.stdout.trim();
        }
      } catch {
        /* fallback to default message */
      }

      // Commit
      runGit(["-C", wtPath, "commit", "-m", message], wtPath);

      broadcast({ type: "playground-saved", name, data: { message } });
      res.json({ saved: true, message });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/playgrounds/:name/reset", async (req: NameReq, res: Response) => {
    const { name } = req.params;
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: "not found" });
    try {
      const wtPath = campPath(name);
      runGit(["-C", wtPath, "fetch", "origin"], wtPath);
      runGit(["-C", wtPath, "reset", "--hard", `origin/${pg.branch}`], wtPath);
      runGit(["-C", wtPath, "clean", "-fd"], wtPath);

      // Reload config to avoid stale references
      const freshConfig = await loadConfig(projectRoot);

      // Re-copy gitignored files (git clean deletes them)
      copyCampFiles(projectRoot, wtPath, freshConfig.copyFiles);

      // Re-apply cached node_modules (git clean deletes them)
      if (freshConfig.setup) {
        const setupCwd = freshConfig.dev?.cwd || ".";
        const cacheResult = applyCacheToWorktree(projectRoot, wtPath, setupCwd);
        if (cacheResult.applied) {
          broadcast({
            type: "log",
            name,
            source: "sanjang",
            data: `캐시에서 node_modules 복원 ✓ (${cacheResult.duration}ms)`,
          });
        }
      }

      writeActions(name, []);
      broadcast({ type: "playground-reset", name, data: { branch: pg.branch } });
      res.json({ reset: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/playgrounds/:name/diagnostics", async (req: NameReq, res: Response) => {
    const { name } = req.params;
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: "not found" });
    const processInfo = getProcessInfo(name) ?? { feLogs: [], feExitCode: null };
    try {
      res.json(await buildDiagnostics(pg, processInfo));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // Cache management
  // -------------------------------------------------------------------------

  app.get("/api/cache/status", (_req: Request, res: Response) => {
    const setupCwd = config.dev?.cwd || ".";
    res.json(isCacheValid(projectRoot, setupCwd));
  });

  app.post("/api/cache/rebuild", async (_req: Request, res: Response) => {
    try {
      broadcast({ type: "cache-rebuild", data: { status: "building" } });
      const result = await buildCache(projectRoot, config, (msg: string) => {
        broadcast({ type: "log", name: "_cache", source: "sanjang", data: msg });
      });
      if (result.success) {
        broadcast({ type: "cache-rebuild", data: { status: "done", duration: result.duration } });
        res.json({ success: true, duration: result.duration });
      } else {
        broadcast({ type: "cache-rebuild", data: { status: "error", error: result.error } });
        res.status(500).json({ error: result.error });
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // Action log + Ship + Revert + Sync
  // -------------------------------------------------------------------------

  function actionsFile(name: string): string {
    return join(campPath(name), "actions.json");
  }

  function readActions(name: string): ActionEntry[] {
    try {
      return JSON.parse(readFileSync(actionsFile(name), "utf8")) as ActionEntry[];
    } catch {
      return [];
    }
  }

  function writeActions(name: string, actions: ActionEntry[]): void {
    try {
      writeFileSync(actionsFile(name), JSON.stringify(actions, null, 2));
    } catch {
      /* worktree may not exist yet */
    }
  }

  app.post("/api/playgrounds/:name/log-action", (req: NameReq, res: Response) => {
    const { name } = req.params;
    const { description, files } = req.body ?? {};
    if (!description) return res.status(400).json({ error: "description required" });
    const actions = readActions(name);
    actions.push({ description, files: files || [], timestamp: new Date().toISOString() });
    writeActions(name, actions);
    broadcast({ type: "playground-action", name, data: { description } });
    res.json({ logged: true });
  });

  app.post("/api/playgrounds/:name/remove-action", (req: NameReq, res: Response) => {
    const { name } = req.params;
    const { index } = req.body ?? {};
    const actions = readActions(name);
    if (index >= 0 && index < actions.length) {
      actions.splice(index, 1);
      writeActions(name, actions);
    }
    res.json({ removed: true });
  });

  app.get("/api/playgrounds/:name/changes", (req: NameReq, res: Response) => {
    const { name } = req.params;
    if (!getOne(name)) return res.status(404).json({ error: "not found" });
    try {
      const wtPath = campPath(name);
      const files = getChangedFiles(wtPath);
      res.json({ count: files.length, files, actions: readActions(name) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/playgrounds/:name/changes-summary — AI 한 줄 변경 요약
  app.get("/api/playgrounds/:name/changes-summary", async (req: NameReq, res: Response) => {
    const { name } = req.params;
    if (!getOne(name)) return res.status(404).json({ error: "not found" });
    try {
      const wtPath = campPath(name);
      const diff = spawnSync("git", ["-C", wtPath, "diff", "--stat"], { encoding: "utf8", stdio: "pipe" }).stdout || "";
      if (!diff.trim()) return res.json({ summary: null });

      const result = spawnSync(
        "claude",
        ["-p", "--model", "haiku", `이 git diff를 한국어 한 줄(20자 이내)로 요약해. 설명 없이 요약만:\n\n${diff.slice(0, 2000)}`],
        { encoding: "utf8", stdio: "pipe", timeout: 10_000 },
      );
      const summary = result.status === 0 ? (result.stdout ?? "").trim() : null;
      res.json({ summary });
    } catch {
      res.json({ summary: null });
    }
  });

  app.post("/api/playgrounds/:name/ship", async (req: NameReq, res: Response) => {
    const { name } = req.params;
    const { message } = req.body ?? {};
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: "not found" });
    if (!message) return res.status(400).json({ error: "변경 내용을 한 줄로 설명해주세요." });
    try {
      const wtPath = campPath(name);
      const ts = Date.now();
      const branchName = `sanjang/${name}-${ts}`;
      // Check for actual changes before shipping
      spawnSync("git", ["-C", wtPath, "add", "-A"], { stdio: "pipe" });
      spawnSync("git", ["-C", wtPath, "reset", "HEAD", "actions.json"], { stdio: "pipe" });
      const statusCheck = spawnSync("git", ["-C", wtPath, "diff", "--cached", "--quiet"], { stdio: "pipe" });
      if (statusCheck.status === 0) {
        return res.status(400).json({ error: "변경된 파일이 없습니다." });
      }

      spawnSync("git", ["-C", wtPath, "checkout", "-b", branchName], { stdio: "pipe" });
      spawnSync("git", ["-C", wtPath, "add", "-A"], { stdio: "pipe" });
      spawnSync("git", ["-C", wtPath, "reset", "HEAD", "actions.json"], { stdio: "pipe" });
      const commitResult = spawnSync("git", ["-C", wtPath, "commit", "-m", message], { stdio: "pipe" });
      if (commitResult.status !== 0) throw new Error(commitResult.stderr?.toString() || "commit failed");
      const pushResult = spawnSync("git", ["-C", wtPath, "push", "-u", "origin", branchName], { stdio: "pipe" });
      if (pushResult.status !== 0) throw new Error(pushResult.stderr?.toString() || "push failed");
      spawnSync("git", ["-C", wtPath, "checkout", "--detach"], { stdio: "pipe" });

      // Read actions before clearing (used for fallback PR body)
      const actions = readActions(name);
      writeActions(name, []);
      broadcast({ type: "playground-shipped", name, data: { branch: branchName } });
      // Respond immediately after push
      res.json({ shipped: true, branch: branchName });

      // Background: create PR via gh CLI
      setImmediate(async () => {
        try {
          const ghCheck = spawnSync("which", ["gh"], { stdio: "pipe" });
          if (ghCheck.status !== 0) return; // gh not installed, skip

          const diffStat =
            spawnSync("git", ["-C", wtPath, "diff", "--stat", "HEAD~1"], { encoding: "utf8", stdio: "pipe" }).stdout ||
            "";
          const diff =
            spawnSync("git", ["-C", wtPath, "diff", "HEAD~1"], { encoding: "utf8", stdio: "pipe" }).stdout || "";

          // Try Claude for rich PR body, fallback to simple
          const claudeCheck = spawnSync("which", ["claude"], { stdio: "pipe" });
          let prBody: string;

          if (claudeCheck.status === 0) {
            const prompt = buildClaudePrPrompt({ message, diffStat, diff });
            const claudeResult = spawnSync("claude", ["-p", prompt, "--output-format", "text"], {
              cwd: wtPath,
              encoding: "utf8",
              stdio: ["pipe", "pipe", "pipe"],
              timeout: 30_000,
              env: { ...process.env, FORCE_COLOR: "0" },
            });
            prBody =
              claudeResult.status === 0 && claudeResult.stdout?.trim()
                ? claudeResult.stdout.trim()
                : buildFallbackPrBody({ message, actions, diffStat });
          } else {
            prBody = buildFallbackPrBody({ message, actions, diffStat });
          }

          const prResult = spawnSync(
            "gh",
            ["pr", "create", "--title", message, "--body", prBody, "--head", branchName],
            { cwd: wtPath, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
          );

          if (prResult.status === 0) {
            const prUrl = prResult.stdout.trim();
            broadcast({ type: "playground-pr-created", name, data: { prUrl, branch: branchName } });
          }
        } catch {
          // Background task — swallow errors silently
        }
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/playgrounds/:name/revert-files", (req: NameReq, res: Response) => {
    const { name } = req.params;
    const { files } = req.body ?? {};
    if (!getOne(name)) return res.status(404).json({ error: "not found" });
    if (!files?.length) return res.status(400).json({ error: "되돌릴 파일을 선택해주세요." });
    // Validate file paths against traversal and shell injection
    for (const file of files) {
      if (typeof file !== "string" || file.includes("..") || file.startsWith("/") || /[`$;"'\\|&]/.test(file)) {
        return res.status(400).json({ error: `invalid file path: ${file}` });
      }
    }
    try {
      const wtPath = campPath(name);
      for (const file of files) {
        const fullPath = resolve(join(wtPath, file));
        if (!fullPath.startsWith(wtPath)) {
          continue; // path traversal attempt
        }
        const result = spawnSync("git", ["-C", wtPath, "checkout", "--", file], { stdio: "pipe" });
        if (result.status !== 0) {
          try {
            unlinkSync(fullPath);
          } catch {
            /* file may not exist */
          }
        }
      }
      res.json({ reverted: files.length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Shared task runner state (used by task endpoint and conflict resolver)
  const runningTasks = new Map<string, ChildProcess>();

  app.post("/api/playgrounds/:name/sync", (req: NameReq, res: Response) => {
    const { name } = req.params;
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: "not found" });
    try {
      const wtPath = campPath(name);
      runGit(["-C", wtPath, "fetch", "origin"], wtPath);
      const mergeResult = spawnSync("git", ["-C", wtPath, "merge", `origin/${pg.branch}`, "--no-edit"], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const result = ((mergeResult.stdout || "") + (mergeResult.stderr || "")).trim();
      if (result.includes("CONFLICT") || (mergeResult.status !== 0 && result.includes("CONFLICT"))) {
        // Don't abort — leave merge state so user can resolve
        const statusOut =
          spawnSync("git", ["-C", wtPath, "status", "--porcelain"], {
            encoding: "utf8",
            stdio: "pipe",
          }).stdout || "";
        const conflictFiles = parseConflictFiles(statusOut);
        res.json({ synced: false, conflict: true, conflictFiles, message: "충돌이 있습니다. 어떻게 할까요?" });
      } else {
        broadcast({ type: "playground-synced", name });
        res.json({ synced: true, message: "최신 버전이 반영되었습니다." });
      }
    } catch (err) {
      const msg = (err as Error).message || "";
      if (msg.includes("CONFLICT")) {
        const statusOut =
          spawnSync("git", ["-C", campPath(name), "status", "--porcelain"], {
            encoding: "utf8",
            stdio: "pipe",
          }).stdout || "";
        const conflictFiles = parseConflictFiles(statusOut);
        res.json({ synced: false, conflict: true, conflictFiles, message: "충돌이 있습니다. 어떻게 할까요?" });
      } else {
        res.status(500).json({ error: (err as Error).message });
      }
    }
  });

  // POST /api/playgrounds/:name/resolve-conflict
  // body: { strategy: 'claude' | 'ours' | 'theirs' }
  app.post("/api/playgrounds/:name/resolve-conflict", async (req: NameReq, res: Response) => {
    const { name } = req.params;
    const { strategy } = req.body ?? {};
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: "not found" });

    const wtPath = campPath(name);

    if (strategy === "ours") {
      spawnSync("git", ["-C", wtPath, "checkout", "--ours", "."], { stdio: "pipe" });
      spawnSync("git", ["-C", wtPath, "add", "."], { stdio: "pipe" });
      spawnSync("git", ["-C", wtPath, "commit", "--no-edit"], { stdio: "pipe" });
      return res.json({ resolved: true, strategy: "ours" });
    }

    if (strategy === "theirs") {
      spawnSync("git", ["-C", wtPath, "checkout", "--theirs", "."], { stdio: "pipe" });
      spawnSync("git", ["-C", wtPath, "add", "."], { stdio: "pipe" });
      spawnSync("git", ["-C", wtPath, "commit", "--no-edit"], { stdio: "pipe" });
      return res.json({ resolved: true, strategy: "theirs" });
    }

    if (strategy === "claude") {
      if (runningTasks.has(name)) {
        return res.status(409).json({ error: "이미 작업 중입니다." });
      }

      const statusOut =
        spawnSync("git", ["-C", wtPath, "status", "--porcelain"], {
          encoding: "utf8",
          stdio: "pipe",
        }).stdout || "";
      const conflictFiles = parseConflictFiles(statusOut);
      const prompt = buildConflictPrompt(conflictFiles);

      const child = spawn("claude", ["-p", prompt, "--output-format", "text"], {
        cwd: wtPath,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0" },
      });

      runningTasks.set(name, child);
      broadcast({ type: "task-started", name, data: { prompt: "충돌 해결 중..." } });

      child.stdout!.on("data", (chunk: Buffer) => {
        broadcast({ type: "task-output", name, data: { text: chunk.toString() } });
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        broadcast({ type: "task-output", name, data: { text: chunk.toString() } });
      });
      child.on("close", (_code: number | null) => {
        runningTasks.delete(name);
        // Commit after Claude resolves conflicts
        spawnSync("git", ["-C", wtPath, "add", "."], { stdio: "pipe" });
        const hasConflicts = spawnSync("git", ["-C", wtPath, "diff", "--check"], { stdio: "pipe" }).status !== 0;
        if (!hasConflicts) {
          spawnSync("git", ["-C", wtPath, "commit", "--no-edit"], { stdio: "pipe" });
          broadcast({ type: "conflict-resolved", name, data: { strategy: "claude" } });
        } else {
          broadcast({
            type: "conflict-failed",
            name,
            data: { message: "Claude가 충돌을 완전히 해결하지 못했습니다." },
          });
        }
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        runningTasks.delete(name);
        const msg = err.code === "ENOENT" ? "Claude CLI가 설치되어 있지 않습니다." : err.message;
        broadcast({ type: "task-error", name, data: { error: msg } });
      });

      return res.json({ resolving: true, strategy: "claude" });
    }

    res.status(400).json({ error: "strategy must be claude, ours, or theirs" });
  });

  // POST /api/playgrounds/:name/resolve-abort — cancel conflict state
  app.post("/api/playgrounds/:name/resolve-abort", (req: NameReq, res: Response) => {
    const { name } = req.params;
    if (!getOne(name)) return res.status(404).json({ error: "not found" });
    const wtPath = campPath(name);
    spawnSync("git", ["-C", wtPath, "merge", "--abort"], { stdio: "pipe" });
    res.json({ aborted: true });
  });

  // -------------------------------------------------------------------------
  // Task runner (claude -p spawn)
  // -------------------------------------------------------------------------

  app.post("/api/playgrounds/:name/task", (req: NameReq, res: Response) => {
    const { name } = req.params;
    const { prompt } = req.body ?? {};
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: "캠프를 찾을 수 없습니다." });
    if (!prompt?.trim()) return res.status(400).json({ error: "할 일을 입력해주세요." });
    if (runningTasks.has(name)) return res.status(409).json({ error: "이미 작업 중입니다." });

    const cwd = campPath(name);
    const child = spawn("claude", ["-p", prompt.trim(), "--output-format", "text"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    runningTasks.set(name, child);
    broadcast({ type: "task-started", name, data: { prompt: prompt.trim() } });

    child.stdout!.on("data", (chunk: Buffer) => {
      broadcast({ type: "task-output", name, data: { text: chunk.toString() } });
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      broadcast({ type: "task-output", name, data: { text: chunk.toString() } });
    });
    child.on("close", (code: number | null) => {
      runningTasks.delete(name);
      const actions = readActions(name);
      actions.push({ description: prompt.trim(), files: [], ts: Date.now() });
      writeActions(name, actions);
      broadcast({ type: "task-done", name, data: { code, prompt: prompt.trim() } });
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      runningTasks.delete(name);
      const msg =
        err.code === "ENOENT"
          ? "Claude CLI가 설치되어 있지 않습니다. npm i -g @anthropic-ai/claude-code 로 설치하세요."
          : err.message;
      broadcast({ type: "task-error", name, data: { error: msg } });
    });

    res.json({ started: true });
  });

  app.post("/api/playgrounds/:name/task/cancel", (req: NameReq, res: Response) => {
    const { name } = req.params;
    const child = runningTasks.get(name);
    if (!child) return res.status(404).json({ error: "진행 중인 작업이 없습니다." });
    child.kill("SIGTERM");
    runningTasks.delete(name);
    broadcast({ type: "task-cancelled", name });
    res.json({ cancelled: true });
  });

  app.get("/api/playgrounds/:name/task/status", (req: NameReq, res: Response) => {
    res.json({ running: runningTasks.has(req.params.name) });
  });

  // POST /api/playgrounds/:name/enter — 캠프 진입 (정보 조회만, 터미널은 별도)
  app.post("/api/playgrounds/:name/enter", async (req: NameReq, res: Response) => {
    const { name } = req.params;
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: "not found" });

    const wtPath = campPath(name);

    // 변경사항 조회
    let changes: { count: number; files: ChangedFile[]; actions: ActionEntry[] } = { count: 0, files: [], actions: [] };
    try {
      const files = getChangedFiles(wtPath);
      changes = { count: files.length, files, actions: readActions(name) };
    } catch {
      /* ignore */
    }

    // 커밋 기록 — baseCommit(캠프 생성 시점) 이후만 표시
    let commits: { hash: string; message: string; date: string }[] = [];
    try {
      const base = pg.baseCommit;
      const logArgs = base
        ? ["-C", wtPath, "log", "--oneline", "--format=%h\t%s\t%cr", "--max-count=20", `${base}..HEAD`]
        : ["-C", wtPath, "log", "--oneline", "--format=%h\t%s\t%cr", "--max-count=5", "HEAD"];
      const log = spawnSync("git", logArgs, { encoding: "utf8", stdio: "pipe" }).stdout?.trim() || "";
      if (log) {
        commits = log.split("\n").map(line => {
          const [hash = "", message = "", date = ""] = line.split("\t");
          return { hash, message, date };
        });
      }
    } catch {
      /* ignore */
    }

    res.json({
      camp: pg,
      changes,
      commits,
      warpInstalled: warpStatus.installed,
      previewUrl: pg.status === "running" ? `http://localhost:${pg.fePort}` : null,
    });
  });

  // POST /api/playgrounds/:name/open-terminal — 이름 있는 Warp 탭 열기
  app.post("/api/playgrounds/:name/open-terminal", (req: NameReq, res: Response) => {
    const { name } = req.params;
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: "not found" });

    const wtPath = campPath(name);
    const result = openWarpTab(name, wtPath);
    res.json(result);
  });

  // GET /api/my-work — 내 진행 중인 작업 (open PRs + 로컬 캠프)
  app.get("/api/my-work", async (_req: Request, res: Response) => {
    const camps = getAll();

    // Open PRs by me (gh CLI) — async to avoid blocking event loop
    let prs: PrInfo[] = [];
    const ghCheck = spawnSync("which", ["gh"], { stdio: "pipe" });
    if (ghCheck.status === 0) {
      try {
        const stdout = await new Promise<string>((resolve, reject) => {
          let out = "";
          const proc = spawn(
            "gh",
            [
              "pr",
              "list",
              "--author",
              "@me",
              "--state",
              "open",
              "--limit",
              "50",
              "--json",
              "number,title,url,headRefName,updatedAt,isDraft,reviewDecision",
            ],
            {
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          proc.stdout!.on("data", (d: Buffer) => {
            out += d;
          });
          proc.on("close", (code: number | null) => (code === 0 ? resolve(out) : reject(new Error(`gh exit ${code}`))));
          proc.on("error", reject);
          setTimeout(() => {
            proc.kill();
            reject(new Error("timeout"));
          }, 10_000);
        });
        try {
          prs = JSON.parse(stdout) as PrInfo[];
        } catch {
          /* ignore */
        }
      } catch {
        /* gh not available or timed out */
      }
    }

    // Match camps to PRs
    const work: WorkItem[] = [];
    const campsByBranch = new Map<string, Camp>(camps.map((c) => [c.branch, c]));

    // 1. PRs (리뷰중)
    for (const pr of prs) {
      const camp = campsByBranch.get(pr.headRefName);
      work.push({
        type: "pr",
        title: pr.title,
        prNumber: pr.number,
        prUrl: pr.url,
        branch: pr.headRefName,
        updatedAt: pr.updatedAt,
        isDraft: pr.isDraft,
        reviewStatus: pr.reviewDecision || "PENDING",
        camp: camp?.name || null,
      });
    }

    // 2. Local camps without PR (작업중)
    const prBranches = new Set<string>(prs.map((p) => p.headRefName));
    for (const camp of camps) {
      if (!prBranches.has(camp.branch)) {
        work.push({
          type: "camp",
          title: camp.name,
          branch: camp.branch,
          status: camp.status,
          camp: camp.name,
        });
      }
    }

    res.json(work);
  });

  // POST /api/quick-start — 자연어 → 브랜치 생성 → 캠프 생성
  app.post("/api/quick-start", async (req: Request, res: Response) => {
    const { description } = req.body ?? {};
    if (!description?.trim()) return res.status(400).json({ error: "뭘 하고 싶은지 입력해주세요." });

    const slug = aiSlugify(description.trim()) ?? slugify(description.trim());
    const name = slug.slice(0, 30);
    const branch = `camp/${slug}`;

    // Check if camp already exists
    if (getOne(name)) return res.status(409).json({ error: `'${name}' 캠프가 이미 있습니다.` });

    const existing = getAll();
    if (existing.length >= MAX_CAMPS)
      return res.status(400).json({ error: `최대 ${MAX_CAMPS}개 캠프까지 가능합니다.` });

    try {
      // Create branch from default branch (dev or main)
      const defaultBranch =
        spawnSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
          encoding: "utf8",
          stdio: "pipe",
        })
          .stdout?.trim()
          ?.replace("refs/remotes/origin/", "") || "main";

      const branchResult = spawnSync("git", ["branch", branch, `origin/${defaultBranch}`], {
        encoding: "utf8",
        stdio: "pipe",
      });
      if (branchResult.status !== 0) {
        return res.status(500).json({ error: `브랜치 생성 실패: ${branchResult.stderr?.trim() || "unknown error"}` });
      }

      const freshConfig2 = await loadConfig(projectRoot);
      setConfig(freshConfig2);
      if (freshConfig2.ports) setPortConfig(freshConfig2.ports);

      const { slot, fePort, bePort } = allocate(existing);
      const actualFePort2 = freshConfig2.dev?.portFlag ? fePort : freshConfig2.dev?.port || fePort;
      await addWorktree(name, branch);

      const wtPath = campPath(name);

      copyCampFiles(projectRoot, wtPath, freshConfig2.copyFiles, (msg: string) => {
        broadcast({ type: "log", name, source: "sanjang", data: msg });
      });

      const baseCommit2 = spawnSync("git", ["-C", wtPath, "rev-parse", "HEAD"], { encoding: "utf8", stdio: "pipe" }).stdout?.trim() || undefined;
      const record: Camp = {
        name,
        branch,
        slot,
        fePort: actualFePort2,
        bePort,
        status: "setting-up",
        description: description.trim(),
        baseCommit: baseCommit2,
        parentBranch: defaultBranch,
      };
      upsert(record);
      broadcast({ type: "playground-created", name, data: record });
      res.status(201).json(record);

      setupCampDeps(name, wtPath, freshConfig2, broadcast);
    } catch (err) {
      try {
        await removeWorktree(name);
      } catch {
        /* cleanup */
      }
      spawnSync("git", ["branch", "-D", branch], { stdio: "pipe" });
      res.status(500).json({ error: friendlyError(err, branch) });
    }
  });

  // -------------------------------------------------------------------------
  // Agent features (suggestions, smart-pr, auto-fix)
  // -------------------------------------------------------------------------

  app.get("/api/suggestions", async (_req: Request, res: Response) => {
    try {
      const suggestions = await suggestTasks(projectRoot);
      res.json(suggestions);
    } catch {
      res.json([]); // graceful degradation
    }
  });

  app.post("/api/playgrounds/:name/smart-pr", async (req: NameReq, res: Response) => {
    const { name } = req.params;
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: "not found" });
    const wtPath = campPath(name);
    const description = await generatePrDescription(wtPath);
    res.json({ description });
  });

  app.post("/api/playgrounds/:name/auto-fix", async (req: NameReq, res: Response) => {
    const { name } = req.params;
    const pg = getOne(name);
    if (!pg) return res.status(404).json({ error: "not found" });

    const processInfo = getProcessInfo(name);
    const logs = processInfo?.feLogs ?? [];

    // Try config hotfix
    const fix = suggestConfigFix(projectRoot, logs);
    if (fix && fix.type !== "info") {
      const applied = applyConfigFix(projectRoot, fix);
      if (applied) {
        // Restart the camp after fixing config
        try {
          stopCamp(name);
          stopWatcher(name);
          updateCampStatus(name, "starting");
          broadcast({ type: "playground-status", name, data: { status: "starting" } });
          const detectedPort = await startCamp(pg, (event) => {
            broadcast({ type: event.type, name, data: event.data, source: event.source });
          });
          const url = `http://localhost:${detectedPort}`;
          upsert({ ...getOne(name)!, status: "running", fePort: detectedPort, url });
          broadcast({ type: "playground-status", name, data: { status: "running", url } });
          startWatcher(name);
          return res.json({ fixed: true, description: fix.description });
        } catch (retryErr) {
          return res.json({ fixed: false, description: "설정을 고쳤지만 시작에 실패했습니다." });
        }
      }
    }

    res.json({ fixed: false, description: fix?.description ?? "자동으로 고칠 수 있는 문제를 찾지 못했습니다." });
  });

  // SPA fallback
  app.get("*", (_req: Request, res: Response) => {
    res.sendFile(join(__dirname, "..", "dashboard", "index.html"));
  });

  return { app, server, port, runningTasks, warpStatus, watchers };
}

export async function startServer(projectRoot: string, options: CreateAppOptions = {}): Promise<Server> {
  const { server, port, runningTasks, warpStatus, watchers } = await createApp(projectRoot, options);
  server.listen(port, "127.0.0.1", () => {
    console.log(`⛰ 산장 서버 실행 중 — http://localhost:${port}`);
    if (warpStatus.installed) {
      console.log("  Warp 감지됨 ✓ — 캠프 진입 시 터미널이 자동으로 열립니다");
    } else {
      console.log("  ℹ Warp를 설치하면 캠프↔터미널 자동 연동을 사용할 수 있습니다");
    }
  });

  // Graceful shutdown
  function shutdown(): void {
    console.log("\n⛰ 산장 종료 중...");
    for (const [, child] of runningTasks) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    for (const [, w] of watchers) w.stop();
    watchers.clear();
    stopAllCamps();
    server.close(() => process.exit(0));
    // Force exit after 10s if cleanup hangs
    setTimeout(() => process.exit(1), 10_000);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}
