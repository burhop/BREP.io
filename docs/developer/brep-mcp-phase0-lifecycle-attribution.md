# BREP-MCP Phase 0: headless lifecycle attribution

Date: 2026-07-16

## Scope and conclusion

This is a focused follow-up to the Phase 0 built-package characterization. It
attributes Node resources retained by the published `brep-io-kernel` boundary.
The harness imports only the package export from a temporary external-consumer
directory; it does not import BREP source files.

Two independent resource owners were observed:

- Package import creates one referenced `MessagePort` for the module-scope VFS
  storage `BroadcastChannel`. It is present before any `PartHistory` exists and
  prevents natural Node process exit.
- Calling `Solid.volume()` creates a referenced 60-second Manifold cleanup
  timer on that solid. Replay without a geometry query creates no such timer.
  Repeatedly measuring replaced solids retains one timer per old solid until it
  fires or `Solid.free()` is called.

No BREP production change is justified for the current BREP-MCP worker model by
this slice. A parent can terminate a disposable worker to release the
module-scope resource, and an adapter can call the existing public
`Solid.free()` before reset or replay to release per-solid Manifold resources.
Long-lived in-process hosts cannot safely close the module-scope storage
channel through the current package API; the smallest general-purpose API for
that separate requirement is recorded below but is not implemented here.

## Reproduction environment

- BREP baseline and `origin/integration/brep-mcp-v1`:
  `18362d3480e02f1ea5a54ef2366428660bd7a890`
- Owner-controlled `upstream/master`:
  `d04f4c72c21c880e51f8995e3eeff8dba4dd4f93`
- Node: `v25.2.0`
- pnpm: `11.7.0`
- Platform: Windows 11 Pro `10.0.26200`, `win32-x64`
- Submodules:
  - `vendor/emsdk` at `d223ae73c6998296e3ab27cf81dc2c2c9fd383de`
  - `vendor/manifold3d` at
    `ae2dbdb2fb87a424c970e415260165ef0e6041ec`
- Manifold source: `local`, compiled from the checked-out
  `vendor/manifold3d` submodule plus the repository's `manifold-plus` bindings
  by `scripts/buildManifoldPlus.ts`
- Local Manifold bundle SHA-256:
  - `manifold-plus/dist/manifold.js`:
    `87ecc6a81edca7d8b627d0bffac272919396a316a4e6072c78f22b7666dd28a1`
  - `manifold-plus/dist/manifold.wasm`:
    `b6cecbdeec77f768209660e6220fb0904a55b0f2615ff67c3f3ee2e30fa5f18f`
- Package export: `./dist-kernel/brep-kernel.js`, 227,467 bytes,
  SHA-256
  `e60b7fcc80daff9242851e6851113440c41d06df5de9d8d8f6a3bc5dfdf678c7`
- Complete `dist-kernel`: 380 files, tree SHA-256
  `ab0b930a968279b3a641f5fc4a0f93bb424c73d90e0fae658cd212b8206a0930`

The local Manifold and `dist-kernel` outputs are ignored build products and are
not part of this change.

## Harness

Run:

```sh
node scripts/characterizeHeadlessLifecycle.mjs --repetitions 3
```

The controller creates a temporary consumer with
`node_modules/brep-io-kernel` linked to this checkout, copies the worker outside
the repository, and starts a fresh Node process for every case and repetition.
The worker installs `async_hooks` and timer wrappers before importing the
package. It records referenced `MESSAGEPORT` and package-created `Timeout`
resources, their creation stacks, natural exit, public lifecycle-like methods,
and stable cube volumes. The controller waits 1.25 seconds for natural exit and
then terminates a retained worker. Temporary paths, checkout paths, and async
IDs are normalized before repetition comparison.

The focused matrix expects the following stable state after 100 ms of settling:

| Case | Histories | Geometry query | MessagePorts | 60 s timers | Natural exit |
| --- | ---: | --- | ---: | ---: | --- |
| control | 0 | no import | 0 | 0 | yes |
| import only | 0 | none | 1 | 0 | no |
| construct | 1 | none | 1 | 0 | no |
| run once | 1 | none | 1 | 0 | no |
| measure once | 1 | one cube volume | 1 | 1 | no |
| measure, reset | 1 | one cube volume | 1 | 1 | no |
| measure, free, reset | 1 | one cube volume | 1 | 0 | no |
| edit/replay/measure four times | 1 | four cube volumes | 1 | 4 | no |
| free before each later replay | 1 | four cube volumes | 1 | 1 | no |
| two histories concurrently | 2 | one cube volume each | 1 | 2 | no |

The measured edit sequence was exactly `750`, `900`, `1050`, and `1200`; two
concurrent default histories each measured `750`. Resource counts, details,
normalized stacks, and exit behavior were identical across the focused
repetitions. These are short characterization repetitions, not the final
architecture thresholds.

## Attribution

The import-only stack is:

```text
new BroadcastChannel (node:internal/worker/io)
VfsStorage._setupBroadcast (dist-kernel/PartHistory-*.js)
VfsStorage._init (dist-kernel/PartHistory-*.js)
```

Source inspection attributes it to `src/idbStorage.ts`: a `VfsStorage`
singleton is constructed at module scope, and its asynchronous initialization
unconditionally creates a `BroadcastChannel` wherever that global exists. The
storage backend is not part of the kernel package exports, and neither it nor
the exported `PartHistory` has a public close/dispose method. The observed
`PartHistory` lifecycle-like prototype methods were only `reset` and
`resetHistoryUndo`.

The timer stack is:

```text
Solid.volume
Solid.getMesh
Solid._manifoldize
setTimeout(..., 60000)
```

Source inspection confirms `_manifoldize()` resets a per-solid 60-second timer
whose callback calls `Solid.free()`. `Solid.free()` cancels that timer and
deletes cached Manifold/native resources while leaving the solid reusable.
`PartHistory.reset()` clears scene objects and managers but does not call
`Solid.free()` for scene solids. In the harness, freeing the visible solid
before reset cancelled the timer; freeing before each subsequent replay
prevented old-solid timers from accumulating.

## Adapter boundary and missing API

The two owners require different treatment:

- Per-history geometry is observable through `PartHistory.scene`, and each
  scene solid exposes the documented `free()` operation. A BREP-MCP adapter can
  safely free current solids before it clears, resets, or replays a history.
  This experiment therefore does not prove a need for `PartHistory.dispose()`.
  The adapter must free before replay removes the old solids; it cannot recover
  those solid references afterwards.
- The storage `BroadcastChannel` is module-scoped, created on import, and shared
  by all histories in the process. An adapter cannot safely reach into the
  bundled private singleton, monkey-patch `BroadcastChannel`, or close a
  process-global resource when another consumer may still use it. Disposable
  worker termination is a safe owner-level boundary for BREP-MCP, but a reused
  in-process host currently has no supported shutdown operation.

If long-lived/reused Node hosts become a supported requirement, the smallest
general-purpose additive API would be an idempotent, package-level
`disposeKernelRuntime(): Promise<void>` that drains pending storage writes and
closes only module-owned runtime channels. It must be explicitly host-scoped,
not a `PartHistory` method, because the channel is shared. A still smaller
implementation possibility is to `unref()` the Node `BroadcastChannel` while
leaving browser behavior unchanged, but that is a runtime-behavior change
rather than an explicit lifecycle API and needs a focused compatibility test.
Neither change is implemented here.

## Remaining uncertainty and next experiment

This harness observes referenced Node resources, timer attribution, volumes,
and exit behavior. It does not measure Wasm heap reclamation, storage write
draining, callback/listener counts inside browser APIs, or behavior after the
60-second automatic cleanup fires. It also does not prove that every feature
places every owned solid in `PartHistory.scene`.

The next smallest experiment is an external-consumer memory test that replays
and measures a bounded cube history many times, compares Wasm/native memory
after adapter-side `Solid.free()` versus automatic timeout cleanup, and verifies
that freeing all current scene solids covers the supported v1 features. A
separate import-only test can prototype `BroadcastChannel.unref()` outside
production code and verify storage messaging plus natural Node exit before any
runtime lifecycle change is proposed.

## Validation record

Commands run on this branch:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed; lockfile and install were already current. |
| `node scripts/characterizeHeadlessLifecycle.mjs --repetitions 3` | Passed in 47.5 seconds; every case and normalized repetition was stable. |
| `node --check scripts/characterizeHeadlessLifecycle.mjs` | Passed. |
| `node --check scripts/fixtures/headlessLifecycleWorker.mjs` | Passed. |
| `pnpm exec eslint scripts/characterizeHeadlessLifecycle.mjs scripts/fixtures/headlessLifecycleWorker.mjs` | Passed with no findings. |
| `pnpm typecheck` | Passed. |
| `pnpm lint` | Failed on the unchanged repository baseline: one `no-unreachable` error at `scripts/capture.ts:1149` and seven existing warnings. The two new harness files pass focused lint. |
| `pnpm build:kernel` | Failed before Vite on the unchanged native Windows bootstrap baseline: no runnable `cmake`, and `python3` was unavailable to bootstrap one. The characterized build artifact and digests remained unchanged. |

No broad feature suite was run because this change does not alter production
or feature behavior; fresh-process execution and measurement are exercised
directly by the focused harness. No generated build, volatile log, coverage, or
temporary consumer output is committed.
