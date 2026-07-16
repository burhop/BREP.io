# Phase 0: final isolation, replay, and serialization thresholds

- Date: 2026-07-16
- Experiments: architecture 21.1, 21.2, and 21.3 final thresholds
- Supported execution identity: pinned Windows package build recorded below
- Production BREP changes: none

## Identity and scope

| Item | Evidence |
| --- | --- |
| BREP experiment base | `da1d4a24954c150bcea0ca8efa179bfdcc646b35` |
| `origin/integration/brep-mcp-v1` after fetch | `da1d4a24954c150bcea0ca8efa179bfdcc646b35` |
| owner-controlled `upstream/master` | `d04f4c72c21c880e51f8995e3eeff8dba4dd4f93` |
| Node / pnpm | Node `v25.2.0`; pnpm `11.7.0` |
| Platform | Windows x64, `Windows_NT` release `10.0.26200` |
| EMSDK / Manifold submodules | `d223ae73c6998296e3ab27cf81dc2c2c9fd383de` / `ae2dbdb2fb87a424c970e415260165ef0e6041ec` |
| Manifold runtime | repository-local build with custom extensions enabled |
| Package export | `brep-io-kernel` -> `./dist-kernel/brep-kernel.js` |
| Built entry | 227,467 bytes; SHA-256 `e60b7fcc80daff9242851e6851113440c41d06df5de9d8d8f6a3bc5dfdf678c7` |
| `dist-kernel` tree | 380 sorted files; SHA-256 `ab0b930a968279b3a641f5fc4a0f93bb424c73d90e0fae658cd212b8206a0930` |

The branch was created from the clean fetched integration branch. Every
harness consumes the package by name from a temporary external consumer. The
owner-controlled baseline was not moved or merged.

This report closes the repetition gates for the admitted Phase 0 surface:
primitive bodies, bounded sketch macros, new-body extrude, serialization/edit
of that spine, and the characterized direct sidewall dependency. It does not
promote boolean, revolve, arbitrary constraints, suppression, or deferred
features.

## Experiment 21.1: 1,000 PartHistory interleavings

Run:

```powershell
node scripts/characterizePartHistoryStress.mjs --interleavings 1000 --workers 10
```

Ten fresh workers each executed 100 A/B history pairs. Within every pair, the
harness alternated feature-creation order and `Promise.all` run order. Widths,
expressions, metadata labels, and expected volumes varied deterministically by
interleaving so stale or cross-history values could not pass as a constant
result.

Results:

- 1,000/1,000 interleavings passed: 500 A-first and 500 B-first;
- zero cross-scene object resolution, callback, expression, metadata, manager,
  registry, or measurement failures;
- histories had distinct scenes, feature registries, assembly/PMI/simulation/
  CAM/sheet/wire managers, metadata managers, and callback maps;
- the immutable primitive feature class was shared as expected;
- all 1,000 pairs produced one manager-identity digest,
  `4efdfd04fadb650cb919a79852baa9050da8447c6d526e839132dae68c66b9a9`;
- the canonical 1,000-record digest was
  `381db11f4e3332ab81ca1067006817bf197ba5dbf736807804f0b5ea8b9d1061`.

Independent cube bounds and volumes used a tolerance of
`max(1e-6, abs(expected) * 1e-7)` to account for the package's float mesh
representation. The first smoke run used exact volume equality and correctly
failed on values such as `25.1999988556` versus 25.2; those discarded failures
were harness-oracle precision noise, not cross-history mutation.

## Experiment 21.2: 100 replays per admitted golden

### Primitive package golden

```powershell
node scripts/characterizeHeadlessPackage.mjs --repetitions 100
```

Passed in 265.6 seconds: 100 author processes, 100 replay processes, and one
concurrent probe. Normalized serialization, authored records, bounds, face
names, volume, area, and triangle count were stable. The concurrent probe again
kept its two histories isolated at volumes 24 and 210.

### Sketch/extrude create-edit golden

```powershell
node scripts/characterizeSketchExtrudeRoundTrip.mjs --repetitions 100
```

Passed in 716.8 seconds: 100 author/replay/edit/replay-edited chains and 400
fresh processes.

| Stage | Normalized serialization | Intent | Normalized runtime | Geometry |
| --- | ---: | ---: | ---: | ---: |
| Author | 1 digest | 1 | 1 | 1 |
| Replay | 1 | same stable stage | 1 | 1 |
| Edit | 1 | 1 | 1 | 1 |
| Replay edited | 1 | same stable stage | 1 | 1 |

Raw author and edit serialization each had 100 digests, entirely attributable
to the documented runtime UUID/timestamp fields. After normalization there was
one digest and zero difference paths. Original and edited geometry each had one
digest across all repetitions.

### Dependent sidewall-reference golden

```powershell
node scripts/characterizeSidewallReferenceSafety.mjs --repetitions 100
```

Passed in 717.2 seconds: 100 author/replay/edit/replay-edited chains and 400
fresh processes. Every stage had exactly one normalized serialization, intent,
semantic reference-snapshot, and independent geometry digest. The source face,
dependent sketch basis, and dependent solid all moved by `[1, 0, 0]` after the
source-width edit in every chain.

These three goldens are the admitted Windows plan corpus at this phase. Adding
another plan or supported platform requires its own 100-replay result; this
report is not a cross-platform claim.

## Experiment 21.3: serialization completeness

Across the 100 sketch/extrude and 100 sidewall chains, round trip and edited
round trip retained:

- feature IDs, order, types, input parameters, expressions, and metadata;
- sketch points, geometry IDs, constraints, dimensions, and construction/
  fixed flags used by the admitted macros;
- profile and sidewall reference strings plus semantic reference snapshots;
- sketch basis and source feature attribution;
- expected face roles, adjacency, bounds, volume, area, and triangle counts;
- the complete top-level BREP serialization boundary for the golden plans.

Normalized noise was limited to:

- `features[*].timestamp`;
- sketch `persistentData.lastSketchChanged`;
- reference-snapshot `sourceUuid` and `sourceTimestamp`;
- object property order.

No other normalized difference path remained. Raw runtime-record differences
were likewise reduced to one digest after the same explicit normalization.

Suppression fields were absent from the golden serialization because
suppression is not yet in the admitted creation slice. It remains gated until a
dedicated create/suppress/serialize/restore/edit/unsuppress chain passes; this
report does not convert an unobserved field into a success claim.

## Lifecycle and deployment decision

All stress and replay workers retained the already-attributed package-level
`BroadcastChannel` and required controller termination after reporting. The
production adapter must therefore own `PartHistory` inside terminable workers;
natural process exit is not an available cleanup contract.

Within that worker boundary, experiment 21.1 found no ordering dependence or
cross-history mutation at the required 1,000 interleavings. Experiments 21.2
and 21.3 found no normalized replay or supported-field loss at 100 repetitions
per admitted golden on the pinned Windows identity.

## API and readiness decision

No BREP production change is justified for the narrow admitted surface. The
existing package supports Phase 1 BREP-MCP development: canonical model store,
worker-owned adapter, inspect, validate, diagnostics/evidence digests, and the
bounded primitive/sketch/new-body-extrude creation spine.

Boolean and revolve remain deferred by the implicit-adjustment report. General
constraint sketches, automatic reference healing, suppression, and all other
deferred feature families remain absent from the advertised capability matrix
until their own gates pass.

## Validation record

| Command | Result |
| --- | --- |
| `node --check scripts/characterizePartHistoryStress.mjs` | passed |
| `pnpm exec eslint scripts/characterizePartHistoryStress.mjs` | passed |
| `node scripts/characterizePartHistoryStress.mjs --interleavings 1000 --workers 10` | passed; 1,000 interleavings, zero failures |
| `node scripts/characterizeHeadlessPackage.mjs --repetitions 100` | passed; 201 fresh processes |
| `node scripts/characterizeSketchExtrudeRoundTrip.mjs --repetitions 100` | passed; 400 fresh processes |
| `node scripts/characterizeSidewallReferenceSafety.mjs --repetitions 100` | passed; 400 fresh processes |
| `pnpm typecheck` | passed |
| `pnpm lint` | unchanged baseline failure: `scripts/capture.ts:1149` has `no-unreachable`; seven existing warnings remain |
| `pnpm build:kernel` | unchanged Windows bootstrap failure before Vite: no runnable `cmake`, and `python3` is unavailable |

No generated build, temporary JSON, log, coverage, or package artifact is
included.

## Next smallest experiment

Proceed to experiment 21.7 for the narrowed supported surface: establish a
closed scale/tolerance interval with repeatable independent measurement error.
BREP-MCP Phase 1 plumbing may begin in parallel, but its capability catalog
must remain pinned to the admitted matrix above.
