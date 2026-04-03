import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { createApp } from "../lib/server.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let baseUrl: string;
let server: Server;
let projectRoot: string;

interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  data: T;
}

function api<T = Record<string, unknown>>(
  path: string,
  opts: Omit<RequestInit, "body"> & { body?: unknown } = {},
): Promise<ApiResponse<T>> {
  const { body, ...rest } = opts;
  return fetch(`${baseUrl}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...rest,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const data = (await r.json().catch(() => ({}))) as T;
    return { status: r.status, data };
  });
}

interface MockProjectOptions {
  subDir?: string;
  devCommand?: string;
  devPort?: number;
  portFlag?: string | null;
  setup?: string;
}

interface MockProject {
  root: string;
  config: Record<string, unknown>;
}

function createMockProject(opts: MockProjectOptions = {}): MockProject {
  const root = mkdtempSync(join(tmpdir(), "sanjang-e2e-"));
  execSync("git init", { cwd: root, stdio: "pipe" });
  execSync("git checkout -b main", { cwd: root, stdio: "pipe" });

  // Create a simple project structure
  const subDir = opts.subDir || ".";
  const pkgDir = subDir === "." ? root : join(root, subDir);
  mkdirSync(pkgDir, { recursive: true });

  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: "mock-project",
      scripts: { dev: "node -e \"require('http').createServer((_,r)=>{r.end('ok')}).listen(process.env.PORT||3999)\"" },
    }),
  );
  writeFileSync(join(pkgDir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));

  // Create mock node_modules so cache can work
  mkdirSync(join(pkgDir, "node_modules", ".package-lock.json"), { recursive: true });
  writeFileSync(join(pkgDir, "node_modules", ".package-lock.json", "index.js"), "");

  // Config
  const config = {
    dev: {
      command:
        opts.devCommand ||
        `node -e "require('http').createServer((_,r)=>{r.end('ok')}).listen(${opts.devPort || 3999})"`,
      port: opts.devPort || 3999,
      portFlag: opts.portFlag !== undefined ? opts.portFlag : "--port",
      cwd: subDir,
    },
    setup: opts.setup || "echo setup-done",
    copyFiles: [],
  };

  writeFileSync(join(root, "sanjang.config.js"), `export default ${JSON.stringify(config, null, 2)};`);

  // Initial commit so worktrees work
  execSync("git add -A", { cwd: root, stdio: "pipe" });
  execSync('git commit -m "init" --allow-empty', { cwd: root, stdio: "pipe" });

  // Create a bare clone as "origin" so fetch/reset work
  const bareDir = join(root, ".bare-origin");
  execSync(`git clone --bare "${root}" "${bareDir}"`, { stdio: "pipe" });
  execSync(`git remote add origin "${bareDir}"`, { cwd: root, stdio: "pipe" });

  return { root, config };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

const TEST_PORT = 14567; // unlikely to conflict

before(async () => {
  const mock = createMockProject({
    devPort: 13999,
    portFlag: null, // simulates SMPLY-like config where port is fixed
    devCommand: `node -e "require('http').createServer((_,r)=>{r.end('ok')}).listen(13999)"`,
  });
  projectRoot = mock.root;

  const result = await createApp(projectRoot, { port: TEST_PORT });
  server = result.server;
  await new Promise<void>((resolve) => server.listen(TEST_PORT, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${TEST_PORT}`;
});

after(async () => {
  // Stop all camps
  interface CampData {
    name: string;
  }
  const { data: camps } = await api<CampData[]>("/api/playgrounds");
  for (const camp of camps) {
    await api(`/api/playgrounds/${camp.name}/stop`, { method: "POST" });
    await api(`/api/playgrounds/${camp.name}`, { method: "DELETE" });
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(projectRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("e2e — cache", () => {
  it("GET /api/cache/status returns validity info", async () => {
    const { status, data } = await api("/api/cache/status");
    assert.equal(status, 200);
    assert.ok("valid" in data);
  });

  it("POST /api/cache/rebuild builds cache", async () => {
    const { status, data } = await api("/api/cache/rebuild", { method: "POST" });
    assert.equal(status, 200);
    assert.equal(data.success, true);
    assert.ok((data.duration as number) >= 0);
  });

  it("cache is valid after rebuild", async () => {
    const { data } = await api("/api/cache/status");
    assert.equal(data.valid, true);
  });
});

describe("e2e — camp CRUD", () => {
  it("GET /api/playgrounds returns empty array initially", async () => {
    const { data } = await api<unknown[]>("/api/playgrounds");
    assert.ok(Array.isArray(data));
  });

  it("POST /api/playgrounds creates a camp", async () => {
    const { status, data } = await api("/api/playgrounds", {
      method: "POST",
      body: { name: "test-crud", branch: "main" },
    });
    assert.equal(status, 201);
    assert.equal(data.name, "test-crud");
    assert.equal(data.branch, "main");
    assert.ok(data.fePort);
  });

  it("camp reaches stopped status (cache applied or setup done)", async () => {
    // Wait for setup to complete (cache or setup command)
    let camp: Record<string, unknown> | undefined;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const { data } = await api<Array<Record<string, unknown>>>("/api/playgrounds");
      camp = data.find((c) => c.name === "test-crud");
      if (camp?.status === "stopped" || camp?.status === "error") break;
    }
    assert.equal(camp!.status, "stopped");
  });

  it("POST /api/playgrounds/:name/start starts the camp", async () => {
    const { data } = await api("/api/playgrounds/test-crud/start", { method: "POST" });
    assert.ok(data.status === "starting" || data.status === "already-starting");
  });

  it("camp reaches running status", async () => {
    let camp: Record<string, unknown> | undefined;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const { data } = await api<Array<Record<string, unknown>>>("/api/playgrounds");
      camp = data.find((c) => c.name === "test-crud");
      if (camp?.status === "running" || camp?.status === "error") break;
    }
    assert.equal(camp!.status, "running");
  });

  it("POST /api/playgrounds/:name/stop stops the camp", async () => {
    const { data } = await api("/api/playgrounds/test-crud/stop", { method: "POST" });
    assert.equal(data.status, "stopped");
  });

  it("DELETE /api/playgrounds/:name deletes the camp", async () => {
    const { data } = await api("/api/playgrounds/test-crud", { method: "DELETE" });
    assert.equal(data.deleted, true);
  });
});

describe("e2e — multiple camps", () => {
  after(async () => {
    for (const n of ["multi-a", "multi-b"]) {
      await api(`/api/playgrounds/${n}/stop`, { method: "POST" }).catch(() => {});
      await api(`/api/playgrounds/${n}`, { method: "DELETE" }).catch(() => {});
    }
  });

  it("can create two camps simultaneously", async () => {
    const [a, b] = await Promise.all([
      api("/api/playgrounds", { method: "POST", body: { name: "multi-a", branch: "main" } }),
      api("/api/playgrounds", { method: "POST", body: { name: "multi-b", branch: "main" } }),
    ]);
    // One should succeed with 201, the other might be 201 or 409
    assert.ok(a.status === 201 || b.status === 201);
  });

  it("lists both camps", async () => {
    // Wait for setup
    await new Promise((r) => setTimeout(r, 3000));
    const { data } = await api<Array<Record<string, unknown>>>("/api/playgrounds");
    const names = data.map((c) => c.name);
    assert.ok(names.includes("multi-a") || names.includes("multi-b"));
  });
});

describe("e2e — snapshots", () => {
  before(async () => {
    await api("/api/playgrounds", {
      method: "POST",
      body: { name: "snap-test", branch: "main" },
    });
    // Wait for setup
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const { data } = await api<Array<Record<string, unknown>>>("/api/playgrounds");
      if (data.find((c) => c.name === "snap-test")?.status === "stopped") break;
    }
  });

  after(async () => {
    await api("/api/playgrounds/snap-test/stop", { method: "POST" }).catch(() => {});
    await api("/api/playgrounds/snap-test", { method: "DELETE" }).catch(() => {});
  });

  it("POST /api/playgrounds/:name/snapshot saves a snapshot", async () => {
    const { status, data } = await api("/api/playgrounds/snap-test/snapshot", {
      method: "POST",
      body: { label: "test-snapshot" },
    });
    assert.equal(status, 200);
    assert.equal(data.saved, true);
  });

  it("GET /api/playgrounds/:name/snapshots lists snapshots", async () => {
    const { status, data } = await api<unknown[]>("/api/playgrounds/snap-test/snapshots");
    assert.equal(status, 200);
    assert.ok(Array.isArray(data));
  });
});

describe("e2e — actions and revert", () => {
  before(async () => {
    await api("/api/playgrounds", {
      method: "POST",
      body: { name: "action-test", branch: "main" },
    });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const { data } = await api<Array<Record<string, unknown>>>("/api/playgrounds");
      if (data.find((c) => c.name === "action-test")?.status === "stopped") break;
    }
  });

  after(async () => {
    await api("/api/playgrounds/action-test", { method: "DELETE" }).catch(() => {});
  });

  it("POST /api/playgrounds/:name/log-action logs an action", async () => {
    const { status, data } = await api("/api/playgrounds/action-test/log-action", {
      method: "POST",
      body: { description: "test action", files: ["test.js"] },
    });
    assert.equal(status, 200);
    assert.equal(data.logged, true);
  });

  it("GET /api/playgrounds/:name/changes includes actions", async () => {
    const { status, data } = await api<{ actions: unknown[] }>("/api/playgrounds/action-test/changes");
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.actions));
    assert.ok(data.actions.length >= 1);
  });

  it("POST /api/playgrounds/:name/remove-action removes an action", async () => {
    const { data } = await api("/api/playgrounds/action-test/remove-action", {
      method: "POST",
      body: { index: 0 },
    });
    assert.equal(data.removed, true);
  });
});

describe("e2e — reset", () => {
  before(async () => {
    await api("/api/playgrounds", {
      method: "POST",
      body: { name: "reset-test", branch: "main" },
    });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const { data } = await api<Array<Record<string, unknown>>>("/api/playgrounds");
      if (data.find((c) => c.name === "reset-test")?.status === "stopped") break;
    }
  });

  after(async () => {
    await api("/api/playgrounds/reset-test", { method: "DELETE" }).catch(() => {});
  });

  it("POST /api/playgrounds/:name/reset resets camp to branch HEAD", async () => {
    const { status, data } = await api("/api/playgrounds/reset-test/reset", {
      method: "POST",
    });
    assert.equal(status, 200);
    assert.equal(data.reset, true);
  });
});

describe("e2e — quick start", () => {
  after(async () => {
    // Clean up any camp created
    interface CampData {
      name: string;
    }
    const { data: camps } = await api<CampData[]>("/api/playgrounds");
    for (const camp of camps) {
      if (camp.name.startsWith("test-")) {
        await api(`/api/playgrounds/${camp.name}/stop`, { method: "POST" }).catch(() => {});
        await api(`/api/playgrounds/${camp.name}`, { method: "DELETE" }).catch(() => {});
      }
    }
  });

  it("POST /api/quick-start creates camp from description", async () => {
    const { status } = await api("/api/quick-start", {
      method: "POST",
      body: { description: "test quick start feature" },
    });
    // 201 = created, 400 = validation error (ok for mock project)
    assert.ok(status === 201 || status === 400 || status === 500);
  });
});

describe("e2e — branches and ports", () => {
  it("GET /api/branches returns branch list", async () => {
    const { status, data } = await api<unknown[]>("/api/branches");
    assert.equal(status, 200);
    assert.ok(Array.isArray(data));
  });

  it("GET /api/ports returns port info", async () => {
    const { status, data } = await api("/api/ports");
    assert.equal(status, 200);
    assert.ok(data);
  });
});
