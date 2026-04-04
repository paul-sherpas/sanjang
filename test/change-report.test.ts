import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildChangeReport, categorizeFile, detectWarnings } from "../lib/engine/change-report.ts";
import type { ChangeReportFile } from "../lib/types.ts";

describe("categorizeFile", () => {
  describe("test files", () => {
    it("classifies .test.ts as test", () => {
      assert.equal(categorizeFile("lib/engine/naming.test.ts"), "test");
    });

    it("classifies .spec.js as test", () => {
      assert.equal(categorizeFile("src/util.spec.js"), "test");
    });

    it("classifies files under test/ directory as test", () => {
      assert.equal(categorizeFile("test/cache.test.ts"), "test");
    });

    it("classifies files under __tests__ directory as test", () => {
      assert.equal(categorizeFile("src/__tests__/util.ts"), "test");
    });

    it("classifies files under __mocks__ directory as test", () => {
      assert.equal(categorizeFile("src/__mocks__/api.ts"), "test");
    });

    it("classifies files under fixtures directory as test", () => {
      assert.equal(categorizeFile("test/fixtures/data.json"), "test");
    });
  });

  describe("ui files", () => {
    it("classifies .css as ui", () => {
      assert.equal(categorizeFile("dashboard/style.css"), "ui");
    });

    it("classifies .scss as ui", () => {
      assert.equal(categorizeFile("src/styles/main.scss"), "ui");
    });

    it("classifies .tsx as ui", () => {
      assert.equal(categorizeFile("src/components/Button.tsx"), "ui");
    });

    it("classifies .jsx as ui", () => {
      assert.equal(categorizeFile("src/pages/Home.jsx"), "ui");
    });

    it("classifies .vue as ui", () => {
      assert.equal(categorizeFile("src/views/Dashboard.vue"), "ui");
    });

    it("classifies .svelte as ui", () => {
      assert.equal(categorizeFile("src/App.svelte"), "ui");
    });

    it("classifies .html as ui", () => {
      assert.equal(categorizeFile("dashboard/index.html"), "ui");
    });

    it("classifies .svg as ui", () => {
      assert.equal(categorizeFile("public/logo.svg"), "ui");
    });

    it("classifies files under components/ as ui", () => {
      assert.equal(categorizeFile("src/components/Modal.ts"), "ui");
    });

    it("classifies files under pages/ as ui", () => {
      assert.equal(categorizeFile("src/pages/index.ts"), "ui");
    });

    it("classifies files under layouts/ as ui", () => {
      assert.equal(categorizeFile("src/layouts/Default.ts"), "ui");
    });

    it("classifies files under styles/ as ui", () => {
      assert.equal(categorizeFile("src/styles/variables.ts"), "ui");
    });

    it("classifies files under public/ as ui", () => {
      assert.equal(categorizeFile("public/favicon.ico"), "ui");
    });
  });

  describe("api files", () => {
    it("classifies files under api/ as api", () => {
      assert.equal(categorizeFile("src/api/users.ts"), "api");
    });

    it("classifies files under routes/ as api", () => {
      assert.equal(categorizeFile("src/routes/auth.ts"), "api");
    });

    it("classifies files under controllers/ as api", () => {
      assert.equal(categorizeFile("src/controllers/user.ts"), "api");
    });

    it("classifies files under middleware/ as api", () => {
      assert.equal(categorizeFile("src/middleware/auth.ts"), "api");
    });

    it("classifies files under handlers/ as api", () => {
      assert.equal(categorizeFile("src/handlers/webhook.ts"), "api");
    });

    it("classifies server.ts as api", () => {
      assert.equal(categorizeFile("lib/server.ts"), "api");
    });

    it("classifies files under graphql/ as api", () => {
      assert.equal(categorizeFile("src/graphql/query.ts"), "api");
    });

    it("classifies files under resolvers/ as api", () => {
      assert.equal(categorizeFile("src/resolvers/user.ts"), "api");
    });
  });

  describe("docs files", () => {
    it("classifies .md as docs", () => {
      assert.equal(categorizeFile("README.md"), "docs");
    });

    it("classifies files under docs/ as docs", () => {
      assert.equal(categorizeFile("docs/architecture.ts"), "docs");
    });

    it("classifies CHANGELOG as docs", () => {
      assert.equal(categorizeFile("CHANGELOG.md"), "docs");
    });

    it("classifies LICENSE as docs", () => {
      assert.equal(categorizeFile("LICENSE"), "docs");
    });

    it("classifies CONTRIBUTING as docs", () => {
      assert.equal(categorizeFile("CONTRIBUTING.md"), "docs");
    });
  });

  describe("config files", () => {
    it("classifies package.json as config", () => {
      assert.equal(categorizeFile("package.json"), "config");
    });

    it("classifies tsconfig.json as config", () => {
      assert.equal(categorizeFile("tsconfig.json"), "config");
    });

    it("classifies .json as config", () => {
      assert.equal(categorizeFile("settings.json"), "config");
    });

    it("classifies .yaml as config", () => {
      assert.equal(categorizeFile("config.yaml"), "config");
    });

    it("classifies .yml as config", () => {
      assert.equal(categorizeFile(".github/workflows/ci.yml"), "config");
    });

    it("classifies .toml as config", () => {
      assert.equal(categorizeFile("Cargo.toml"), "config");
    });

    it("classifies dotfiles as config", () => {
      assert.equal(categorizeFile(".eslintrc"), "config");
    });

    it("classifies .env as config", () => {
      assert.equal(categorizeFile(".env"), "config");
    });

    it("classifies vite.config.ts as config", () => {
      assert.equal(categorizeFile("vite.config.ts"), "config");
    });

    it("classifies next.config.js as config", () => {
      assert.equal(categorizeFile("next.config.js"), "config");
    });

    it("classifies jest.config.ts as config", () => {
      assert.equal(categorizeFile("jest.config.ts"), "config");
    });

    it("classifies biome.json as config", () => {
      assert.equal(categorizeFile("biome.json"), "config");
    });
  });

  describe("other files", () => {
    it("classifies regular .ts as other", () => {
      assert.equal(categorizeFile("lib/engine/naming.ts"), "other");
    });

    it("classifies plain .js as other", () => {
      assert.equal(categorizeFile("bin/sanjang.js"), "other");
    });
  });
});

describe("detectWarnings", () => {
  const file = (path: string): ChangeReportFile => ({
    path,
    status: "수정",
    category: "other",
  });

  it("detects env warning for .env file", () => {
    const warnings = detectWarnings([file(".env")]);
    assert.ok(warnings.some((w) => w.type === "env"));
  });

  it("detects env warning for .env.local", () => {
    const warnings = detectWarnings([file(".env.local")]);
    assert.ok(warnings.some((w) => w.type === "env"));
  });

  it("detects db warning for migration file", () => {
    const warnings = detectWarnings([file("db/migrations/001_init.sql")]);
    assert.ok(warnings.some((w) => w.type === "db"));
  });

  it("detects db warning for schema file", () => {
    const warnings = detectWarnings([file("prisma/schema.prisma")]);
    assert.ok(warnings.some((w) => w.type === "db"));
  });

  it("detects db warning for .sql file", () => {
    const warnings = detectWarnings([file("db/seed.sql")]);
    assert.ok(warnings.some((w) => w.type === "db"));
  });

  it("detects infra warning for Dockerfile", () => {
    const warnings = detectWarnings([file("Dockerfile")]);
    assert.ok(warnings.some((w) => w.type === "infra"));
  });

  it("detects infra warning for docker-compose.yml", () => {
    const warnings = detectWarnings([file("docker-compose.yml")]);
    assert.ok(warnings.some((w) => w.type === "infra"));
  });

  it("detects infra warning for .github/ path", () => {
    const warnings = detectWarnings([file(".github/workflows/ci.yml")]);
    assert.ok(warnings.some((w) => w.type === "infra"));
  });

  it("detects infra warning for deploy/ path", () => {
    const warnings = detectWarnings([file("deploy/k8s.yaml")]);
    assert.ok(warnings.some((w) => w.type === "infra"));
  });

  it("detects infra warning for k8s/ path", () => {
    const warnings = detectWarnings([file("k8s/deployment.yaml")]);
    assert.ok(warnings.some((w) => w.type === "infra"));
  });

  it("detects infra warning for terraform/ path", () => {
    const warnings = detectWarnings([file("terraform/main.tf")]);
    assert.ok(warnings.some((w) => w.type === "infra"));
  });

  it("detects config warning for package.json", () => {
    const warnings = detectWarnings([file("package.json")]);
    assert.ok(warnings.some((w) => w.type === "config"));
  });

  it("detects config warning for package-lock.json", () => {
    const warnings = detectWarnings([file("package-lock.json")]);
    assert.ok(warnings.some((w) => w.type === "config"));
  });

  it("detects config warning for yarn.lock", () => {
    const warnings = detectWarnings([file("yarn.lock")]);
    assert.ok(warnings.some((w) => w.type === "config"));
  });

  it("detects config warning for pnpm-lock.yaml", () => {
    const warnings = detectWarnings([file("pnpm-lock.yaml")]);
    assert.ok(warnings.some((w) => w.type === "config"));
  });

  it("detects security warning for auth file", () => {
    const warnings = detectWarnings([file("lib/auth/middleware.ts")]);
    assert.ok(warnings.some((w) => w.type === "security"));
  });

  it("detects security warning for token file", () => {
    const warnings = detectWarnings([file("src/utils/token.ts")]);
    assert.ok(warnings.some((w) => w.type === "security"));
  });

  it("detects security warning for secret file", () => {
    const warnings = detectWarnings([file("config/secrets.ts")]);
    assert.ok(warnings.some((w) => w.type === "security"));
  });

  it("deduplicates warnings by type", () => {
    const files = [file("package.json"), file("yarn.lock")];
    const warnings = detectWarnings(files);
    const configWarnings = warnings.filter((w) => w.type === "config");
    assert.equal(configWarnings.length, 1);
  });

  it("returns empty array for safe files", () => {
    const files = [file("src/utils/format.ts"), file("lib/engine/naming.ts")];
    const warnings = detectWarnings(files);
    assert.equal(warnings.length, 0);
  });

  it("returns multiple warning types for mixed files", () => {
    const files = [file(".env"), file("package.json"), file("Dockerfile")];
    const warnings = detectWarnings(files);
    const types = warnings.map((w) => w.type);
    assert.ok(types.includes("env"));
    assert.ok(types.includes("config"));
    assert.ok(types.includes("infra"));
  });
});

describe("buildChangeReport", () => {
  it("returns correct total count", () => {
    const report = buildChangeReport([
      { path: "src/app.ts", status: "수정" },
      { path: "src/style.css", status: "추가" },
    ]);
    assert.equal(report.totalCount, 2);
  });

  it("groups files by category", () => {
    const report = buildChangeReport([
      { path: "src/app.ts", status: "수정" },
      { path: "src/style.css", status: "추가" },
      { path: "src/api/users.ts", status: "새 파일" },
    ]);
    assert.ok(report.byCategory.other !== undefined);
    assert.ok(report.byCategory.ui !== undefined);
    assert.ok(report.byCategory.api !== undefined);
  });

  it("attaches warnings to report", () => {
    const report = buildChangeReport([{ path: ".env", status: "수정" }]);
    assert.ok(report.warnings.some((w) => w.type === "env"));
  });

  it("sets summary and humanDescription to null", () => {
    const report = buildChangeReport([{ path: "src/app.ts", status: "수정" }]);
    assert.equal(report.summary, null);
    assert.equal(report.humanDescription, null);
  });

  it("handles empty file list", () => {
    const report = buildChangeReport([]);
    assert.equal(report.totalCount, 0);
    assert.equal(report.files.length, 0);
    assert.deepEqual(report.byCategory, {});
    assert.deepEqual(report.warnings, []);
  });

  it("assigns correct category to each file", () => {
    const report = buildChangeReport([
      { path: "src/components/Button.tsx", status: "수정" },
      { path: "src/api/users.ts", status: "추가" },
    ]);
    const uiFile = report.files.find((f) => f.path === "src/components/Button.tsx");
    const apiFile = report.files.find((f) => f.path === "src/api/users.ts");
    assert.equal(uiFile?.category, "ui");
    assert.equal(apiFile?.category, "api");
  });

  it("preserves file status", () => {
    const report = buildChangeReport([{ path: "src/app.ts", status: "삭제" }]);
    assert.equal(report.files[0]?.status, "삭제");
  });
});
