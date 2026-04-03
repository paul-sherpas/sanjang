# Reloop Plan: Sanjang Bugfix + TypeScript Migration

## Goal
Phase 1: Fix 7 review issues (tests, cp -Rc, README, error msgs, stale config, cache hash, pnpm).
Phase 2: Migrate entire codebase from JS to TypeScript with strict types, zero any, biome lint.

## Success Criteria
1. 120+ tests, 0 failures
2. tsc --noEmit --strict: 0 errors
3. sanjang help + init --no-start + init --force all work
4. Zero .js files in lib/ and test/
5. Zero `any` type in codebase (grep verified)
6. Zero `cp -Rc` (replaced with fs.cpSync)
7. biome check: 0 errors
8. All core types in lib/types.ts (Camp, Config, CacheResult, PortAllocation)
9. JSDoc comments replaced by TS types
10. README updated for v0.2.0 + TypeScript

## Scope
- Modifiable: lib/**/*.{js,ts}, test/**/*.{js,ts}, bin/sanjang.*, package.json, tsconfig.json, biome.json, README.md, lib/types.ts
- Read-only: dashboard/**, templates/**, node_modules/**

## Pre-resolved Decisions
- D1: Use `node --experimental-strip-types` (no build step)
- D2: Test runner: `node --experimental-strip-types --test test/**/*.test.ts`
- D3: Linter: biome (single tool, fast, TS native)
- D4: Import extensions stay `.js` (strip-types doesn't transform imports)
- D5: `strict: true` + `noUncheckedIndexedAccess: true`
- D6: bin/sanjang.ts with shell wrapper for npx

## Reference Patterns
- lib/engine/state.js — cleanest module, module-scope var + export pattern
- test/state.test.js — test conventions (describe/it + tmpdir + before/after)
- lib/engine/cache.js — most complex (async + fs + spawn)

## Task Checklist
- [ ] task-1: Test coverage boost (slugify, buildCache, quick-start, my-work)
- [ ] task-2: cp -Rc → fs.cpSync
- [ ] task-3: README v0.2.0 update
- [ ] task-4: Error message improvements
- [ ] task-5: Reset handler stale config fix
- [ ] task-6: Cache hash file per setupCwd
- [ ] task-7: pnpm symlink compat
- [ ] task-8: tsconfig.json + biome.json
- [ ] task-9: package.json scripts + devDeps
- [ ] task-10: lib/types.ts (interfaces)
- [ ] task-11: state.js → state.ts
- [ ] task-12: ports.js → ports.ts
- [ ] task-13: naming.js → naming.ts
- [ ] task-14: cache.js → cache.ts
- [ ] task-15: process.js → process.ts
- [ ] task-16: worktree.js → worktree.ts
- [ ] task-17: snapshot/pr/conflict/diagnostics/warp.js → .ts
- [ ] task-18: config.js → config.ts
- [ ] task-19: server.js → server.ts
- [ ] task-20: bin/sanjang.js → .ts + wrapper
- [ ] task-21: test/*.test.js → .ts
- [ ] task-22: JSDoc removal + .js cleanup
- [ ] task-23: tsc --noEmit --strict pass
- [ ] task-24: biome check pass
- [ ] task-25: Final verification (120+ tests, 0 any, 0 .js)
