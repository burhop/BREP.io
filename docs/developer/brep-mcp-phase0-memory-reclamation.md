# BREP-MCP Phase 0: headless memory reclamation

Date: 2026-07-16

## Scope and conclusion

This experiment tests whether a built-package consumer can bound resources
while repeatedly replaying and measuring the initially supported cube and
rectangle-sketch-plus-extrude histories. It compares no cleanup, adapter-side
`Solid.free()`, the real 60-second automatic cleanup, two concurrent histories,
and a harness-only `BroadcastChannel.unref()` prototype. The worker imports only
`brep-io-kernel` from a temporary external-consumer directory.

The existing public package is sufficient for the current BREP-MCP disposable
worker architecture:

- Calling public `Solid.free()` before replay prevents old-solid cleanup timers
  from accumulating and sharply reduces retained V8 heap after forced GC.
- A parent-owned disposable worker remains the reliable boundary for all
  process and Wasm/native resources, including the module-scope storage
  channel and allocator high-water state.
- A test-only Node `BroadcastChannel.unref()` prototype preserves bidirectional
  messaging and allows natural process exit, but this slice does not establish
  browser parity or justify a production behavior change.

No BREP production code is changed. The public package does not expose live
native allocator usage, so this experiment cannot claim exact Wasm/native byte
reclamation. That uncertainty is recorded rather than treated as a leak or a
success.

## Reproduction environment

- BREP baseline and `origin/integration/brep-mcp-v1`:
  `c4ac475161e06223377013731709dd4c9066d216`
- Integrated characterization PRs:
  - PR #2 squash commit `1068dda53cfa7fe6aa7733eaba3673aefdd21040`
  - PR #3 squash commit `c4ac475161e06223377013731709dd4c9066d216`
- Owner-controlled `upstream/master`:
  `d04f4c72c21c880e51f8995e3eeff8dba4dd4f93`
- Node: `v25.2.0`
- pnpm: `11.7.0`
- Platform: Windows 11 Pro `10.0.26200`, `win32-x64`
- Submodules:
  - `vendor/emsdk` at `d223ae73c6998296e3ab27cf81dc2c2c9fd383de`
  - `vendor/manifold3d` at
    `ae2dbdb2fb87a424c970e415260165ef0e6041ec`
- Manifold source: `local`, compiled from `vendor/manifold3d` plus the
  repository's `manifold-plus` bindings
- Package export: `./dist-kernel/brep-kernel.js`, 227,467 bytes, SHA-256
  `e60b7fcc80daff9242851e6851113440c41d06df5de9d8d8f6a3bc5dfdf678c7`
- Complete `dist-kernel`: 380 files, tree SHA-256
  `ab0b930a968279b3a641f5fc4a0f93bb424c73d90e0fae658cd212b8206a0930`

The characterized `dist-kernel` and local Manifold bundle are ignored build
outputs and are not committed.

## Harness and measurements

Run the complete matrix:

```sh
node scripts/characterizeHeadlessMemory.mjs \
  --repetitions 2 \
  --cycles 40 \
  --automatic-wait-ms 61250 \
  --summary-only
```

The controller copies its worker outside the checkout, links the package into a
temporary `node_modules`, and starts every case in a fresh Node process with
`--expose-gc`. Each geometry path executes and explicitly frees one warm-up
model before recording its baseline. Snapshots run two forced GC passes and
record:

- `process.memoryUsage()` RSS, heap, external, and array-buffer values;
- `manifold.HEAP8.buffer.byteLength`;
- exported Embind inherited-instance and emval-handle diagnostics;
- referenced package-created 60-second timers;
- active Node resource types;
- solid counts, volumes, triangle counts, and sorted face labels.

The cube cycles through volumes `750`, `900`, `1050`, and `1200`. The 6-by-6
rectangle extrude cycles through `396`, `432`, `468`, and `504`. Sampled
geometry records and face labels were identical across both repetitions. Every
sample had one 12-triangle solid with six expected face labels.

## Results

The following ranges are the two final 40-cycle repetitions after the warmed
baseline and forced GC. Memory is rounded to MiB. RSS is reported as observed,
not interpreted as live allocation.

| Case | Peak/final cleanup timers | Heap-used delta | RSS delta | External delta | Wasm heap capacity |
| --- | ---: | ---: | ---: | ---: | ---: |
| cube, no cleanup | 40 / 40 | 14.56-14.64 | 38.23-39.33 | 43.9 KiB | 16 MiB -> 16 MiB |
| cube, explicit cleanup | 1 / 0 | 1.07 | 26.38-26.44 | 40 bytes | 16 MiB -> 16 MiB |
| extrude, no cleanup | 40 / 40 | 29.33 | 101.38-101.51 | 68.3 KiB | 16 MiB -> 16 MiB |
| extrude, explicit cleanup | 1 / 0 | 1.89-1.90 | 58.46-58.98 | 40 bytes | 16 MiB -> 16 MiB |
| cube + extrude concurrently, explicit cleanup | 2 / 0 | 1.97 | 90.69-91.25 | 40 bytes | 16 MiB -> 16 MiB |

Explicit cases freed exactly 40 solids for one history and 80 solids for two
concurrent histories. Both concurrent histories retained distinct scenes,
feature registries, and metadata managers. Volumes and face labels continued
to match their independent expected sequences.

The automatic-cleanup case used eight measured cube replays per fresh process.
It accumulated eight referenced timers, waited 61.25 seconds without invoking
cleanup directly, and finished with zero timers in both repetitions. After GC,
heap-used delta from the warmed baseline was approximately 0.62 MiB; RSS was
4.5-5.2 MiB below that baseline. The storage `MessagePort` remained referenced,
so the process still did not exit naturally.

## Interpretation limits

The timer and V8-heap differences show that the timer closures retain replaced
solid object graphs and that `Solid.free()` breaks that retention path. They do
not directly measure live native allocations.

- `manifold.HEAP8.buffer.byteLength` is Wasm linear-memory capacity. It remained
  16 MiB throughout every case and does not decrease when allocator blocks are
  freed.
- `getInheritedInstanceCount()`, `getLiveInheritedInstances()`, and
  `count_emval_handles()` remained zero. They do not count the ordinary
  Manifold/CppSolidCore allocations used by these histories.
- RSS includes V8 heap capacity, Wasm pages, native allocator arenas, code, and
  shared libraries. Its failure to return to baseline is not evidence that the
  corresponding bytes remain live.
- Forced GC makes V8 comparisons more repeatable but is not a production
  control mechanism.

Consequently, exact live Manifold/native bytes are not observable through the
existing public package. BREP-MCP does not need that diagnostic to guarantee
release when the parent terminates a disposable worker.

## Import-time channel prototype

Unmodified package import retained one `MessagePort` and failed to exit
naturally in both repetitions. For the test-only prototype, the worker replaced
the global `BroadcastChannel` constructor before package import with a subclass
that immediately called the native Node `unref()` method. It then used a peer on
the package's storage channel to verify messages in both directions, closed the
peer, and restored the original constructor.

Both prototype repetitions received both messages, reported no referenced
`MessagePort`, and exited naturally. This demonstrates a plausible small Node
runtime improvement, not a production-ready patch: the harness uses a private
channel name, and browser storage behavior was not exercised.

## Adapter boundary and API decision

For the supported cube and sketch-extrude histories, a BREP-MCP adapter can
enumerate current scene solids and call documented `Solid.free()` before the
next replay. It must do so before `runHistory()` replaces the old scene objects.
This is sufficient to bound referenced cleanup timers and retained JavaScript
object graphs; no `PartHistory.dispose()` is justified by this experiment.

If a future long-lived in-process host requires auditable native allocation,
the smallest general-purpose addition would be a read-only package-level
runtime diagnostic backed by actual kernel-owned allocation counters. Existing
Embind diagnostics and Wasm capacity are not substitutes. If natural Node CLI
exit becomes a separate supported requirement, a Node-only channel `unref()` is
smaller than a global dispose API, but it needs package and browser storage
contract tests first. Neither change is implemented here.

## Remaining uncertainty and next experiment

This slice does not test browser storage parity, very long replay plateaus,
features outside cube and rectangle extrude, allocation failure under a fixed
memory limit, or exact native allocator occupancy. It also does not prove that
all future supported features expose every owned solid in the scene before
replacement.

The next smallest Phase 0 experiment is combined replay-determinism and
serialization-completeness coverage for the same rectangle sketch plus
extrude: author, serialize, reconstruct in a fresh package process, edit the
restored sketch/extrude, replay, and compare authored records, constraints,
feature references, normalized serialization, face-role labels, and independent
geometry measurements. Production APIs should remain unchanged unless that
experiment proves a field or diagnostic is unavailable.

## Validation record

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed; already current. |
| `node scripts/characterizeHeadlessMemory.mjs --repetitions 2 --cycles 40 --automatic-wait-ms 61250` | Passed in 96.5 seconds; all eight cases and stable invariants passed. |
| Same command with `--summary-only` | Passed again in 95.9 seconds and emitted the compact evidence summarized above. |
| `node --check scripts/characterizeHeadlessMemory.mjs` | Passed. |
| `node --check scripts/fixtures/headlessMemoryWorker.mjs` | Passed. |
| `pnpm exec eslint scripts/characterizeHeadlessMemory.mjs scripts/fixtures/headlessMemoryWorker.mjs` | Passed with no findings. |
| `pnpm typecheck` | Passed. |
| `pnpm test -- test_extrude_rectangle_profile_has_one_sidewall_per_sketch_edge` | Did not reach the test: the shared Manifold preparation step reproduced the native Windows bootstrap baseline (`cmake` absent and no `python3`). The equivalent built-package rectangle-extrude path passed 40 replay cycles twice in this focused harness. |
| `pnpm lint` | Failed on the unchanged baseline: `scripts/capture.ts:1149` (`no-unreachable`) and seven existing warnings. |
| `pnpm build:kernel` | Failed before Vite on the unchanged native Windows bootstrap baseline: no runnable `cmake`, and `python3` was unavailable to bootstrap one. |

No broad suite was run after its focused entry point was blocked at the shared
native bootstrap. No generated build, volatile log, coverage, or temporary
consumer output is committed.
