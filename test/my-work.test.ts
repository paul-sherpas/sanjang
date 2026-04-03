import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { createApp } from "../lib/server.ts";
import { slugify } from "../lib/engine/naming.ts";

// ---------------------------------------------------------------------------
// Shared e2e helpers (same pattern as e2e-server.test.ts)
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

function createMockProject() {
  const root = mkdtempSync(join(tmpdir(), "sanjang-mywork-"));
  execSync("git init", { cwd: root, stdio: "pipe" });
  execSync("git checkout -b main", { cwd: root, stdio: "pipe" });

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "mock-project",
      scripts: { dev: "node -e \"require('http').createServer((_,r)=>{r.end('ok')}).listen(13998)\"" },
    }),
  );
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  mkdirSync(join(root, "node_modules", ".package-lock.json"), { recursive: true });
  writeFileSync(join(root, "node_modules", ".package-lock.json", "index.js"), "");

  const config = {
    dev: {
      command: "node -e \"require('http').createServer((_,r)=>{r.end('ok')}).listen(13998)\"",
      port: 13998,
      portFlag: null,
      cwd: ".",
    },
    setup: "echo setup-done",
    copyFiles: [],
  };
  writeFileSync(join(root, "sanjang.config.js"), `export default ${JSON.stringify(config, null, 2)};`);

  execSync("git add -A", { cwd: root, stdio: "pipe" });
  execSync('git commit -m "init" --allow-empty', { cwd: root, stdio: "pipe" });

  const bareDir = join(root, ".bare-origin");
  execSync(`git clone --bare "${root}" "${bareDir}"`, { stdio: "pipe" });
  execSync(`git remote add origin "${bareDir}"`, { cwd: root, stdio: "pipe" });

  return root;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

const TEST_PORT = 14568;

before(async () => {
  projectRoot = createMockProject();
  const result = await createApp(projectRoot, { port: TEST_PORT });
  server = result.server;
  await new Promise<void>((resolve) => server.listen(TEST_PORT, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${TEST_PORT}`;
});

after(async () => {
  // Clean up camps
  interface CampData { name: string }
  const { data: camps } = await api<CampData[]>("/api/playgrounds");
  for (const camp of camps) {
    await api(`/api/playgrounds/${camp.name}/stop`, { method: "POST" }).catch(() => {});
    await api(`/api/playgrounds/${camp.name}`, { method: "DELETE" }).catch(() => {});
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(projectRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// /api/my-work tests
// ---------------------------------------------------------------------------

describe("e2e — /api/my-work", () => {
  it("GET /api/my-work returns array", async () => {
    const { status, data } = await api<unknown[]>("/api/my-work");
    assert.equal(status, 200);
    assert.ok(Array.isArray(data));
  });

  it("GET /api/my-work includes local camps", async () => {
    // Create a camp first
    await api("/api/playgrounds", {
      method: "POST",
      body: { name: "mywork-camp", branch: "main" },
    });
    // Wait for setup
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const { data } = await api<Array<Record<string, unknown>>>("/api/playgrounds");
      if (data.find((c) => c.name === "mywork-camp")?.status === "stopped") break;
    }

    const { status, data } = await api<Array<Record<string, unknown>>>("/api/my-work");
    assert.equal(status, 200);
    const campItem = data.find((w) => w.camp === "mywork-camp");
    assert.ok(campItem, "my-work should include the local camp");
    assert.equal(campItem!.type, "camp");
    assert.equal(campItem!.branch, "main");

    // Cleanup
    await api("/api/playgrounds/mywork-camp/stop", { method: "POST" }).catch(() => {});
    await api("/api/playgrounds/mywork-camp", { method: "DELETE" }).catch(() => {});
  });

  it("GET /api/my-work items have required fields", async () => {
    await api("/api/playgrounds", {
      method: "POST",
      body: { name: "mywork-fields", branch: "main" },
    });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const { data } = await api<Array<Record<string, unknown>>>("/api/playgrounds");
      if (data.find((c) => c.name === "mywork-fields")?.status === "stopped") break;
    }

    const { data } = await api<Array<Record<string, unknown>>>("/api/my-work");
    for (const item of data) {
      assert.ok("type" in item, "item should have type");
      assert.ok("title" in item, "item should have title");
      assert.ok("branch" in item, "item should have branch");
      assert.ok("camp" in item, "item should have camp field");
    }

    await api("/api/playgrounds/mywork-fields/stop", { method: "POST" }).catch(() => {});
    await api("/api/playgrounds/mywork-fields", { method: "DELETE" }).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// /api/quick-start negative paths
// ---------------------------------------------------------------------------

describe("e2e — /api/quick-start negative paths", () => {
  it("returns 400 for empty description", async () => {
    const { status, data } = await api("/api/quick-start", {
      method: "POST",
      body: { description: "" },
    });
    assert.equal(status, 400);
    assert.ok(data.error);
  });

  it("returns 400 for whitespace-only description", async () => {
    const { status, data } = await api("/api/quick-start", {
      method: "POST",
      body: { description: "   " },
    });
    assert.equal(status, 400);
    assert.ok(data.error);
  });

  it("returns 400 for missing description field", async () => {
    const { status, data } = await api("/api/quick-start", {
      method: "POST",
      body: {},
    });
    assert.equal(status, 400);
    assert.ok(data.error);
  });

  it("returns 409 for duplicate camp name", async () => {
    // Create a camp via quick-start
    const desc = "duplicate-test-unique-abc";
    const { status: firstStatus } = await api("/api/quick-start", {
      method: "POST",
      body: { description: desc },
    });
    // First call may succeed or fail (branch creation), but the name is now reserved if 201
    if (firstStatus === 201) {
      // Wait for setup
      const slug = slugify(desc).slice(0, 30);
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const { data } = await api<Array<Record<string, unknown>>>("/api/playgrounds");
        const camp = data.find((c) => c.name === slug);
        if (!camp || camp.status === "stopped" || camp.status === "error") break;
      }

      // Second call with same description should 409
      const { status: secondStatus } = await api("/api/quick-start", {
        method: "POST",
        body: { description: desc },
      });
      assert.equal(secondStatus, 409);

      // Cleanup
      await api(`/api/playgrounds/${slug}/stop`, { method: "POST" }).catch(() => {});
      await api(`/api/playgrounds/${slug}`, { method: "DELETE" }).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// slugify — additional edge cases
// ---------------------------------------------------------------------------

describe("slugify — extended edge cases", () => {
  it("handles very long Korean input (100+ chars)", () => {
    const longKorean = "대시보드 설정 페이지 사용자 관리 목록 검색 필터 정렬 알림 권한 기기 소프트웨어 자산 구성원 보고서 차트 테이블 폼 모달 메뉴 헤더 푸터 사이드바 카드 탭";
    const result = slugify(longKorean);
    assert.ok(result.length <= 50, `result length ${result.length} should be <= 50`);
    assert.ok(result.length > 0);
    assert.ok(/^[a-z0-9-]+$/.test(result));
  });

  it("handles mixed unicode (CJK) + ascii", () => {
    const result = slugify("React 컴포넌트 렌더링 fix");
    assert.ok(/^[a-z0-9-]+$/.test(result));
    assert.ok(result.includes("react"));
    assert.ok(result.includes("fix"));
  });

  it("handles consecutive special characters", () => {
    const result = slugify("fix---bug!!!###test");
    assert.ok(/^[a-z0-9-]+$/.test(result));
    // Should not have consecutive hyphens
    assert.ok(!result.includes("--"), `"${result}" should not contain --`);
  });

  it("handles emoji input", () => {
    const result = slugify("🚀 launch feature 🎉");
    assert.ok(/^[a-z0-9-]+$/.test(result));
    assert.ok(result.includes("launch"));
  });

  it("handles tabs and newlines", () => {
    const result = slugify("fix\tbug\nhere");
    assert.ok(/^[a-z0-9-]+$/.test(result));
    assert.ok(result.length > 0);
  });

  it("handles repeated Korean mapped words", () => {
    const result = slugify("로그인 로그인 로그인");
    assert.equal(result, "login-login-login");
  });
});

// ---------------------------------------------------------------------------
// updateCampStatus — null guard (tested via endpoint behavior)
// ---------------------------------------------------------------------------

describe("e2e — updateCampStatus null guard", () => {
  it("stopping a non-existent camp returns 404", async () => {
    const { status } = await api("/api/playgrounds/nonexistent-camp-xyz/stop", { method: "POST" });
    assert.equal(status, 404);
  });

  it("starting a non-existent camp returns 404", async () => {
    const { status } = await api("/api/playgrounds/nonexistent-camp-xyz/start", { method: "POST" });
    assert.equal(status, 404);
  });

  it("deleting a non-existent camp returns 404", async () => {
    const { status } = await api("/api/playgrounds/nonexistent-camp-xyz", { method: "DELETE" });
    assert.equal(status, 404);
  });
});
