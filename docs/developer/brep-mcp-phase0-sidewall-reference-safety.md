# Phase 0: sidewall reference-safety characterization

- Date: 2026-07-16
- Experiment: focused Phase 0 topology-label and persistent-reference slice
- Capability: replay a dependent sketch and extrude attached to an authored
  extrude sidewall before and after a source-sketch edit
- Production BREP changes: none

## Identity and environment

| Item | Evidence |
| --- | --- |
| BREP experiment base | `e00c906b48f77512c593ae5a117fa6d471d54ace` |
| `origin/integration/brep-mcp-v1` after fetch | `e00c906b48f77512c593ae5a117fa6d471d54ace` |
| owner-controlled `upstream/master` after fetch | `d04f4c72c21c880e51f8995e3eeff8dba4dd4f93` |
| Node / pnpm | Node `v25.2.0`; pnpm `11.7.0` |
| Platform | Windows x64, `Windows_NT` release `10.0.26200` |
| EMSDK submodule | `d223ae73c6998296e3ab27cf81dc2c2c9fd383de` (`6.0.0`) |
| Manifold submodule | `ae2dbdb2fb87a424c970e415260165ef0e6041ec` (`v3.5.1-3-gae2dbdb2`) |
| Manifold runtime | repository-local build; package reports `manifoldBuildSource === "local"` and custom extensions enabled |
| Package export | `brep-io-kernel` -> `./dist-kernel/brep-kernel.js` |
| Built entry | 227,467 bytes; SHA-256 `e60b7fcc80daff9242851e6851113440c41d06df5de9d8d8f6a3bc5dfdf678c7` |
| `dist-kernel` tree | 380 sorted files; SHA-256 `ab0b930a968279b3a641f5fc4a0f93bb424c73d90e0fae658cd212b8206a0930` |

The branch was created from the fetched integration commit above after the
preceding sketch-extrude characterization was merged. The worktree was clean,
and the distinct owner-controlled `upstream/master` reference was not moved or
merged.

## Harness boundary and model

Run:

```powershell
node scripts/characterizeSidewallReferenceSafety.mjs --repetitions 3
```

The single-file controller copies itself into a temporary external consumer,
links this checkout as `node_modules/brep-io-kernel`, and starts the copied file
in worker mode. Worker mode dynamically imports only `brep-io-kernel`; it does
not import a source path or the built entry by relative path. Temporary worker
and JSON files are removed after the run.

Each repetition uses four fresh Node processes:

1. author `S1`, a constrained 6 x 6 rectangle, and extrude it as `E2`;
2. author circle sketch `S3` on `E2:S1:G1_SW`, then extrude it independently
   as `E4`;
3. serialize, restore, replay, and serialize again;
4. restore in another process, widen `S1` from 6 to 8, replay, and serialize;
5. restore and replay the edited result in a fourth process.

The dependent extrude uses boolean operation `NONE`; this keeps the experiment
inside the initial sketch/extrude spine and avoids admitting deferred boolean,
fillet, or chamfer behavior. The harness measures both solids and the sketch
attachment plane independently. It records face names, selected authored-role
metadata, boundary adjacency and lengths, reference-snapshot geometry, sketch
basis, bounds, volume, area, and triangle counts.

## Results

All three chains passed: 12 fresh processes completed author, replay, edit, and
replay-edited actions. Each stage produced one digest across all repetitions:

| Record | Original | Edited |
| --- | --- | --- |
| Authored intent | `fc8dfc9dd51e392111299b001dd77fdcfd78459d1b8ed01034bb78ccdd2862d1` | `48a16f3f64374abc90c103698acd836898ada6a41305c6c0690a80021f5eba16` |
| Normalized serialization | `5e90964cc29facbe4aea8db99d1a8bc7b0edc333ce9a627f810ea29bc431f468` | `878a461a6b6e1a9f60194357808c4073873e253ad5c37a82985272082433d7f6` |
| Semantic sidewall snapshot | `9da00e8137ea5ec165deb36a49b6b90b52771745fd9d2980c9af47688718d82c` | `38b7d4bf5b1d84aca7c0c67914ed3959ec4adafc209a888c9d20bd1b29dbd955` |
| Independent geometry | `0e71c3a6fe4fabc779fb742dc460da05d76d56791c31a57b6e0aa60ddbde0506` | `23276cb53d73aea685f2aaf66c8050afa1d691f4f4668f2e33520e2d284ee52a` |

The source edit made the expected geometric change:

| Measurement | Original `E2` | Edited `E2` |
| --- | --- | --- |
| Bounds | `[2, 2, -10]` to `[8, 8, 1]` | `[2, 2, -10]` to `[10, 8, 1]` |
| Volume | 396 | 528 |
| Surface area | 336 | 404 |
| Triangles | 12 | 12 |

The referenced sidewall center moved from `[5, 2, -4.5]` to
`[6, 2, -4.5]`. The persisted `S3` basis origin and the `E4` bounds center
both moved by exactly `[1, 0, 0]`. Before and after the edit:

- the sketch profile's mean distance and spread from the reference plane were
  both zero;
- the basis origin's distance from the projected sidewall center was zero;
- the snapshot remained type `FACE`, with `sourceFeatureId: "E2"` and normal
  `[0, 1, 0]`;
- the dependent cylinder retained volume `9.36433494507`, surface area
  `25.0621803925`, and 124 triangles;
- its bounds translated from `[4, 0, -5.5]`–`[6, 3, -3.5]` to
  `[5, 0, -5.5]`–`[7, 3, -3.5]`.

## Topology-label matrix for this edit

| Observation | `E2` source solid | `E4` dependent solid |
| --- | --- | --- |
| Face count | 6 -> 6 | 3 -> 3 |
| Face-label / selected-role digest | `6aa3768b283d1ac86dbb3589d2d139645a8dfd699805da99fcc23b567ff28a32` preserved | `bbf73b0d3bd55eaf9dc1730b91658e8d85504d8292af36367c816b10466f01cb` preserved |
| Adjacency labels | all 12 named boundaries preserved | both named closed boundaries preserved |
| Meaningful geometry change | four cap boundaries lengthened from 6 to 8 | rigid translation only |
| Split / merge / delete / duplicate | none observed | none observed |
| Symmetric ambiguity | not exercised | not exercised |

The source labels remained `G1_SW`, `G2_SW`, `G3_SW`, `G4_SW`,
`PROFILE_END`, and `PROFILE_START` under `E2:S1`. The dependent labels
remained `G1_SW`, `PROFILE_END`, and `PROFILE_START` under `E4:S3`.
This is a preservation result for one direct rectangle-width edit. It is not a
claim that generated topology IDs are stable generally.

## Serialization noise and attribution

Within each original or edited replay pair, raw differences were limited to:

- all four feature timestamps;
- `sourceUuid` and `sourceTimestamp` in the `E2` profile snapshot, `S3`
  sidewall snapshot, and `E4` profile snapshot;
- `S1.persistentData.lastSketchChanged` in the edited pair.

The harness normalizes only those runtime-derived fields and object property
order. No normalized difference paths remained within a chain or across
repetitions. Snapshot geometry, basis, source feature ID, authored parameters,
face labels, adjacency, and measurements are retained in every comparison.

The resolved `FACE` object reported `owningFeatureID: null`. Attribution was
still observable through its parent solid name `E2`, the explicit authored
reference `E2:S1:G1_SW`, and the snapshot's `sourceFeatureId: "E2"`. An
adapter must not assume that every resolved topology child exposes
`owningFeatureID`; for this case it can verify the parent solid and serialized
snapshot instead.

## What was not established

- No split, merge, deletion, duplication, or symmetric ambiguity occurred, so
  this result does not establish how an adapter should rebind those cases.
- A missing or stale sidewall name was not exercised. The adapter must not
  infer automatic healing from this successful direct-name replay.
- Boolean result topology and implicit overlap conditioning were deliberately
  excluded.
- Edge-level authored-role resolution was recorded only through public
  boundary adjacency; no durable edge identity is claimed.
- The prior package experiments cover scoped concurrent-history isolation.
  This fresh-process slice does not repeat the in-process concurrency probe.
- Every worker still retained the previously attributed package-level
  `BroadcastChannel` and required controller termination after reporting.

## API decision

The existing published package is sufficient for this direct sidewall
attachment, snapshot update, edit, replay, topology query, and independent
geometry validation. No BREP production change is justified.

BREP-MCP can preserve the authored reference string and complete BREP JSON,
then verify the resolved parent solid, snapshot source feature, face role,
adjacency, and independent geometry. It cannot safely invent a stable topology
ID, silently heal a missing name, or claim that an ambiguous result is unique.
Those cases require separate failing experiments before any general-purpose
kernel diagnostic or query can be proposed.

## Validation record

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | passed; already up to date |
| `node --check scripts/characterizeSidewallReferenceSafety.mjs` | passed |
| focused ESLint for the new harness | passed |
| `node scripts/characterizeSidewallReferenceSafety.mjs --repetitions 3` | passed; 3 chains and 12 fresh processes |
| `pnpm typecheck` | passed |
| `pnpm lint` | unchanged baseline failure: `scripts/capture.ts:1149` has `no-unreachable`; seven existing warnings remain |
| `pnpm build:kernel` | unchanged Windows bootstrap failure before Vite: no runnable `cmake`, and `python3` is unavailable |
| `pnpm test -- test_sketch_face_attachment_alignment` | blocked by the same pre-test Manifold bootstrap failure |

No generated build, temporary JSON, log, coverage, or package artifact is
included. The tested package is the byte-identical built artifact recorded
above.

## Next smallest experiment

Run the Phase 0 sketch-observability matrix through the published standalone
constraint-solver export: valid, under-constrained, over-constrained,
contradictory, and near-degenerate sketches. Record status, residual/error,
degree-of-freedom evidence, solved coordinates, ordering, and repeatability in
fresh processes before proposing any read-only diagnostics API.
