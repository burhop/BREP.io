# Phase 0: built-package `PartHistory` characterization

- Date: 2026-07-16
- Experiment: Phase 0 slice of 21.1 through 21.3
- Capability: create, serialize, reconstruct, and replay one minimal supported
  `PartHistory` from the published package boundary in fresh Node processes
- Production BREP changes: none

## Identity and environment

| Item | Evidence |
| --- | --- |
| BREP experiment base | `18362d3480e02f1ea5a54ef2366428660bd7a890` |
| `origin/integration/brep-mcp-v1` after fetch | `18362d3480e02f1ea5a54ef2366428660bd7a890` |
| owner-controlled `upstream/master` after fetch | `d04f4c72c21c880e51f8995e3eeff8dba4dd4f93` |
| merge base with `upstream/master` | `d04f4c72c21c880e51f8995e3eeff8dba4dd4f93` |
| Node / pnpm | Node `v25.2.0`; pnpm `11.7.0` |
| Platform | Windows 10 Pro, version 2009, build 26200, 64-bit |
| EMSDK submodule | `d223ae73c6998296e3ab27cf81dc2c2c9fd383de` |
| Manifold submodule | `ae2dbdb2fb87a424c970e415260165ef0e6041ec` (`v3.5.1-3-gae2dbdb2`) |
| Manifold runtime | repository-local build; package reports `manifoldBuildSource === "local"` and custom extensions enabled |
| Package export | `brep-io-kernel` -> `./dist-kernel/brep-kernel.js` |
| Built entry SHA-256 | `e60b7fcc80daff9242851e6851113440c41d06df5de9d8d8f6a3bc5dfdf678c7` |
| `dist-kernel` tree SHA-256 | `ab0b930a968279b3a641f5fc4a0f93bb424c73d90e0fae658cd212b8206a0930` over 380 sorted files |
| Temporary `pnpm pack` artifact | `brep-io-kernel-1.0.0.tgz`, SHA-256 `91164b5cd874e55fe5763373c8c1c34f926657b5512f3b9d60ceb2cbc7fc34c3` |

Before initialization, both submodules were recorded with Git's `-` prefix.
After `git submodule update --init --recursive`, both were clean at the pinned
commits above. The worktree was clean before the task branch was created.

## Harness boundary and input

Run:

```powershell
node scripts/characterizeHeadlessPackage.mjs --repetitions 3
```

The controller creates a temporary external consumer directory, links this
checkout as `node_modules/brep-io-kernel`, copies the worker outside the
checkout, and starts a new Node process for each action. The copied worker uses
only `import('brep-io-kernel')`; it never imports a `src/` path or the built
entry by relative path. The package export therefore selects the built entry.
Temporary histories and worker files are removed after every run.

The minimal authored history is one `P.CU` feature with dimensions 5 x 10 x
15. Each repetition uses one fresh author process and a second fresh process
which calls `fromJSON()`, `runHistory({ throwOnFeatureError: true })`, and
`toJSON()` again. The concurrency probe creates two histories in one fresh
process, gives them different expression sources, metadata, callbacks, and
cube dimensions, then awaits both `runHistory()` calls with `Promise.all()`.

## Results

Three author processes and three replay processes passed. Across all six:

- authored feature ID and solid name were `P.CU1`;
- face names were the same sorted six labels (`NX`, `NY`, `NZ`, `PX`, `PY`,
  and `PZ` under `P.CU1`);
- bounds were `[0, 0, 0]` to `[5, 10, 15]`;
- volume was 750, surface area was 550, and triangle count was 12;
- authored-record SHA-256 was always
  `ef6849baffb7cf3feb94fbb269e45dd901607f3f7ce0bd429f379f8950b481ab`;
- normalized serialization SHA-256 was always
  `72bc4a46ba31067aadf4352fb251a1f7f77519ab1d33596d8797c30cd2d697f8`.

Raw serialization digests differed for every author and replay process. The
only normalized value was each feature's runtime `timestamp`, replaced with
`null`; object keys were sorted before hashing, and no other field was removed.
Thus this slice found timestamp noise but no meaningful authored-record,
geometry, ordering, formatting, or property-order difference.

The concurrent histories also passed the scoped checks:

- expression-evaluated cubes measured 2 x 3 x 4 (volume 24) and 5 x 6 x 7
  (volume 210);
- callback streams stayed separate and each was exactly
  `run:P.CU1`, then `after`;
- expressions and metadata serialized back to their originating histories;
- scenes, feature-registry instances, assembly registries, and PMI,
  simulation, CAM, sheet, wire-harness, and metadata manager instances were
  distinct;
- the registered `P.CU` feature class was shared at module scope, as expected,
  without observed cross-history mutation.

## Retained state and observability limits

No worker exited naturally. After a 100 ms settling interval and excluding the
worker's stdout/stderr transport resources, a single-history process reported
one active `MessagePort` and one active `Timeout`; the two-history process
reported one `MessagePort` and two active `Timeout`s. The
controller therefore terminated each worker 750 ms after receiving its result.
A separate import-only probe printed `import-resolved` but exceeded a 9-second
process timeout; its settled resource probe identified a `MessagePort`.

This establishes retained Node resources, but not their source-level owner or
whether the per-history timeout is intentionally long-lived. The public package
does not expose enough lifecycle diagnostics to attribute or close these
resources. BREP-MCP can safely bound this initial use through its already-owned
disposable worker process, so the finding does not yet prove that BREP-MCP
requires a kernel API change.

This slice also does not establish sketch serialization completeness, edit
behavior, topology-label stability, cache isolation, Manifold singleton
isolation, browser parity, or stable ordering beyond one primitive. Manager
identity checks do not prove that every internal cache or module singleton is
isolated.

## Build and validation record

| Command | Result |
| --- | --- |
| `git fetch origin integration/brep-mcp-v1` | passed; local and remote integration commits matched |
| `git fetch upstream master` | passed; owner baseline remained separate |
| `git submodule update --init --recursive` | passed |
| `pnpm install --frozen-lockfile` | passed; already up to date |
| `pnpm build:kernel` on the untouched Windows baseline | failed before Vite: local Manifold preparation found no runnable `cmake`, and the script's bootstrap requires an available `python3` command |
| initial `pnpm typecheck` before a build artifact existed | failed with 16 missing-module errors for `dist-kernel`, the package self-reference examples, and `manifold-plus/dist/manifold.js` |
| manual local Manifold configure/build | passed with temporary CMake 4.4.0 and Ninja 1.13.0 under `C:\tmp`, pinned EMSDK 3.1.64, the repository's release flags, and target `manifoldjs` |
| remaining official build stages (`pnpm generateLicenses`, clean worker assets, Vite kernel build, CLI build, asset sync) | passed; generated tracked license changes were discarded |
| `node scripts/characterizeHeadlessPackage.mjs --repetitions 3` | passed: 3 author, 3 replay, and 1 concurrent process |
| final `pnpm typecheck` | passed |
| focused ESLint for both new harness files | passed |
| full `pnpm lint` | baseline failure in `scripts/capture.ts:1149` (`no-unreachable`); existing warnings left unchanged |
| `pnpm pack --pack-destination C:\tmp\brep-phase0-pack` | passed; temporary artifact only |

The native Windows `build:kernel` failure is a pre-existing build-path
limitation: after CMake is supplied, `buildManifoldPlus.ts` still explicitly
states that automatic EMSDK activation is only implemented for non-Windows
bash environments. No build-script change is included here. The local
Manifold artifact was prepared manually with the same source, version, flags,
copy step, and generated destructor guard used by that script, after which the
remaining official kernel build stages succeeded.

The broad source test suite was not run. Its launcher repeats the same failing
Manifold preparation, while the focused built-package harness directly covers
the requested external-client behavior and the existing primitive test does
not cover serialization or fresh-process replay.

## Decision and next experiment

The existing public package is sufficient for the characterized creation,
serialization, reconstruction, replay, authored-record inspection, and solid
measurements. No BREP production change is justified by this slice, and no
serialization, topology, tolerance, default, package-export, or browser
compatibility change was made.

The next smallest experiment is lifecycle attribution: separate import-only,
constructor-only, single-run, and multiple-history cases; use Node async
resource attribution to identify the `MessagePort` and `Timeout` owners; and
exercise any existing cleanup paths before proposing an API. Only if the
resources are kernel-owned, cannot be safely controlled by normal headless
clients, and matter outside disposable workers should BREP consider an
idempotent general-purpose `PartHistory.dispose()` and, independently, a
module-runtime disposal function for a proven module-scoped resource. After
that, the next serialization slice should use one rectangle sketch plus
extrude to exercise persistent sketch data and cross-feature references.
