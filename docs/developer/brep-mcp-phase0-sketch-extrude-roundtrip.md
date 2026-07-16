# Phase 0: sketch-extrude round-trip characterization

- Date: 2026-07-16
- Experiment: Phase 0 serialization completeness and replay determinism slice
- Capability: author, replay, edit, and replay a constrained rectangle sketch
  plus expression-driven extrude through the built `brep-io-kernel` package
- Production BREP changes: none

## Identity and environment

| Item | Evidence |
| --- | --- |
| BREP experiment base | `61b1b187da33a886cc38062d69a0621553a39916` |
| `origin/integration/brep-mcp-v1` after fetch | `61b1b187da33a886cc38062d69a0621553a39916` |
| owner-controlled `upstream/master` after fetch | `d04f4c72c21c880e51f8995e3eeff8dba4dd4f93` |
| Node / pnpm | Node `v25.2.0`; pnpm `11.7.0` |
| Platform | Windows x64, `Windows_NT` release `10.0.26200` |
| EMSDK submodule | `d223ae73c6998296e3ab27cf81dc2c2c9fd383de` (`6.0.0`) |
| Manifold submodule | `ae2dbdb2fb87a424c970e415260165ef0e6041ec` (`v3.5.1-3-gae2dbdb2`) |
| Manifold runtime | repository-local build; package reports `manifoldBuildSource === "local"` and custom extensions enabled |
| Package export | `brep-io-kernel` -> `./dist-kernel/brep-kernel.js` |
| Built entry | 227,467 bytes; SHA-256 `e60b7fcc80daff9242851e6851113440c41d06df5de9d8d8f6a3bc5dfdf678c7` |
| `dist-kernel` tree | 380 sorted files; SHA-256 `ab0b930a968279b3a641f5fc4a0f93bb424c73d90e0fae658cd212b8206a0930` |

The worktree was clean before the branch was created. The experiment branch
was based directly on the fetched integration commit above. The distinct
`upstream/master` reference was fetched and not moved or merged.

## Harness boundary and history

Run:

```powershell
node scripts/characterizeSketchExtrudeRoundTrip.mjs --repetitions 3
```

The controller creates a temporary external consumer, links this checkout as
`node_modules/brep-io-kernel`, copies the worker outside the checkout, and
starts four fresh Node processes per repetition. The worker imports only
`brep-io-kernel`; it does not import `src/PartHistory.ts`, any other `src/`
file, or the built entry by relative path. Temporary JSON and worker files are
deleted after the run.

Each chain performs:

1. author a constrained 6 x 6 rectangle sketch `S1` and extrude `E2`;
2. serialize, restore in a fresh process, run, and serialize again;
3. restore in another fresh process, edit the rectangle to 8 x 7, change the
   expression-driven forward distance from 10 to 14 and the back distance
   from 1 to 2, run, and serialize;
4. restore the edited result in a fourth fresh process, run, and serialize.

The sketch uses four line geometries and five constraints: one fixed origin
and four coincident endpoint constraints. The extrude references
`S1:PROFILE`, consumes the profile, binds `distance` to the expression
`depth`, and uses boolean operation `NONE`.

The harness hashes raw serialization, normalized serialization, authored
intent, raw and normalized persistent runtime records, and independent
geometry measurements. It also records full constraint records, bounds,
volume, surface area, triangle count, scene objects, and sorted face labels.

## Results

All three chains passed: 12 fresh worker processes completed the author,
replay, edit, and replay-edited actions. The stable digests were:

| Record | Original | Edited |
| --- | --- | --- |
| Authored intent | `89fceb23f1f3723d837a3c8c65dad1b2a69f5723d451b902b1016dfc25018b54` | `bfa5a79b4b1518ca355b596c11465ef4ed7ec40d35f6c9bea186c347385454c7` |
| Normalized serialization | `29ae544351c31f9bbdf26c6245c4f807635e5e32ff8c492e1195c7ecb9eb7832` | `d476ad321e276a00c20c17572eb9a585b5ce8151254af3cb1a09e8cd71baec3e` |
| Normalized persistent runtime record | `2bdbd94a029c44925f09e041aa64ce626cdeba0eaec2050120394709a5e694f8` | `91f552d817d2277000ad4af069e7079a293a882581fd26265174563b5560677e` |
| Constraint records | `b2e6e51b711f1b02b93ea622f0e409761e5b37f54f6907ad193c9d6df1c0c7c7` | `dd79751cf6808f2764a8fb8b72febd53cfd8f6e5a1eb773ed934f2376376dfe0` |
| Geometry | `08d2f5b26432461cc79e82cbbe002da0291ba8c6b7eed40e239f9a134090a23f` | `370ec92f38591d12647972aa8b60089d3326e1c61db47631eb75ec89a3c5a296` |

Independent geometry measurements agreed before and after every replay:

| Measurement | Original | Edited |
| --- | --- | --- |
| Bounds | `[2, 2, -10]` to `[8, 8, 1]` | `[2, 2, -14]` to `[10, 9, 2]` |
| Volume | 396 | 896 |
| Surface area | 336 | 592 |
| Triangles | 12 | 12 |

Both models had one scene solid named `E2`. The sorted face roles remained
`G1_SW`, `G2_SW`, `G3_SW`, `G4_SW`, `PROFILE_END`, and `PROFILE_START`.
This is evidence for this rectangle edit only; it is not a claim that generated
topology labels are generally stable.

The public serialization preserved the authored sketch points, geometries,
constraints, expression source, expression binding, feature IDs, profile
reference, boolean parameters, metadata, managers, and workbench. All five
constraints replayed with status `solved`, no error, and stable authored point
references. Editing changed both authored intent and independently measured
geometry, and replay preserved both changes.

## Raw differences and normalization

Raw JSON and raw persistent-runtime hashes intentionally did not match. Across
independent author processes, the only raw difference paths were:

```text
$.features[0].timestamp
$.features[1].persistentData.referenceSnapshots.profile.S1:PROFILE.sourceTimestamp
$.features[1].persistentData.referenceSnapshots.profile.S1:PROFILE.sourceUuid
$.features[1].timestamp
```

The edited-to-replay-edited comparison additionally differed at:

```text
$.features[0].persistentData.lastSketchChanged
```

The harness normalizes only those four categories before deterministic
comparison: feature timestamps; the sketch's per-run `lastSketchChanged`
flag; and `sourceUuid` / `sourceTimestamp` inside reference snapshots. It sorts
object keys before hashing. It does not remove authored values, snapshot
geometry, source feature IDs, constraints, feature persistent data, or other
fields. After this normalization there were no difference paths within a
chain or across repetitions.

The snapshot UUID identifies a newly created runtime scene object, and the
snapshot timestamp follows runtime feature execution. They should remain in
the model JSON used for replay; a BREP-MCP adapter may ignore them when
comparing canonical authored intent but should not rewrite persisted BREP data
to strip them. `lastSketchChanged` describes the current run, not authored
sketch intent. These are retained-derived differences, not formatting or
property-order differences.

## What was not observable

- `currentHistoryStepId` was set to `E2` before author and edit serialization,
  but no such field appeared in the JSON and a restored history reported
  `null`. Full-history replay does not need this UI cursor, so this omission
  does not justify an API change for the current BREP-MCP capability.
- No feature suppression/enable field was present in either feature's public
  input or serialized record. This experiment does not establish suppression
  behavior or require it for the initial full-replay adapter.
- `lastProfileDiagnostics` was not serialized. Geometry, constraints, and
  persistent snapshot data were observable, but this slice does not establish
  a supported public sketch/profile diagnostics contract.
- The earlier built-package experiment already exercised two concurrent
  histories and found no scoped manager, expression, callback, registry, or
  scene crossover. This fresh-process slice does not repeat that in-process
  concurrency probe or claim isolation for every module singleton.
- All 12 workers still required controller termination after their results
  because the known package-level `BroadcastChannel` handle remains live. The
  lifecycle and memory reports attribute and bound that separate finding.

## API decision

The existing package is sufficient to author, serialize, reconstruct, edit,
replay, and independently measure this supported sketch-plus-extrude history.
No BREP production change is justified by this experiment.

The BREP-MCP adapter can safely preserve the complete BREP JSON as its replay
source of truth and derive a separate comparison record that ignores the
documented runtime fields. It cannot safely invent general sketch diagnostics,
feature suppression semantics, stable topology IDs, or a persisted history
cursor; those would be new contracts rather than adapter translations. This
slice does not prove that any of those contracts is required.

If a later supported capability requires headless diagnostics that cannot be
derived from the public serialization and geometry queries, the smallest
general-purpose candidate would be a read-only, structured feature-run
diagnostics query on `PartHistory`. Its contents and compatibility contract
must first be justified by a failing built-package experiment; it should not
expose mutable internal solver or scene state.

## Validation record

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | passed; already up to date |
| `node --check scripts/characterizeSketchExtrudeRoundTrip.mjs` | passed |
| `node --check scripts/fixtures/headlessSketchExtrudeRoundTripWorker.mjs` | passed |
| focused ESLint for both new scripts | passed |
| `node scripts/characterizeSketchExtrudeRoundTrip.mjs --repetitions 3` | passed; 3 chains and 12 fresh processes |
| `pnpm typecheck` | passed |
| `pnpm lint` | unchanged baseline failure: `scripts/capture.ts:1149` has `no-unreachable`; seven existing warnings remain |
| `pnpm build:kernel` | unchanged Windows bootstrap failure before Vite: no runnable `cmake`, and `python3` is unavailable |
| `pnpm test -- test_extrude_rectangle_profile_has_one_sidewall_per_sketch_edge` | blocked by the same pre-test Manifold bootstrap failure |

No generated build, temporary JSON, log, coverage, or package artifact is
included in this change. The tested built package is byte-for-byte the artifact
recorded above.

## Next smallest experiment

Use a dependent feature that references one generated extrude sidewall, then
edit the source sketch and replay in fresh processes. Compare semantic face
roles, reference snapshots, independent geometry, and failure diagnostics
without assuming that generated topology IDs are stable. This would directly
characterize reference safety and topology-label behavior before moving to
implicit geometry-adjustment experiments.
