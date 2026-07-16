# Phase 0: sketch-observability characterization

- Date: 2026-07-16
- Experiment: architecture experiment 21.4 through the published package
- Capability: distinguish valid, under-constrained, redundant,
  contradictory, and near-degenerate sketches without source imports
- Production BREP changes: none

## Identity and environment

| Item | Evidence |
| --- | --- |
| BREP experiment base | `412ca888aa97ac952165dbc4d661df8d42d1fc4a` |
| `origin/integration/brep-mcp-v1` after fetch | `412ca888aa97ac952165dbc4d661df8d42d1fc4a` |
| owner-controlled `upstream/master` after fetch | `d04f4c72c21c880e51f8995e3eeff8dba4dd4f93` |
| Node / pnpm | Node `v25.2.0`; pnpm `11.7.0` |
| Platform | Windows x64, `Windows_NT` release `10.0.26200` |
| EMSDK submodule | `d223ae73c6998296e3ab27cf81dc2c2c9fd383de` (`6.0.0`) |
| Manifold submodule | `ae2dbdb2fb87a424c970e415260165ef0e6041ec` (`v3.5.1-3-gae2dbdb2`) |
| Manifold runtime | repository-local build; package reports `manifoldBuildSource === "local"` and custom extensions enabled |
| Package export | `brep-io-kernel` -> `./dist-kernel/brep-kernel.js` |
| Built entry | 227,467 bytes; SHA-256 `e60b7fcc80daff9242851e6851113440c41d06df5de9d8d8f6a3bc5dfdf678c7` |
| `dist-kernel` tree | 380 sorted files; SHA-256 `ab0b930a968279b3a641f5fc4a0f93bb424c73d90e0fae658cd212b8206a0930` |

The worktree was clean before the branch was created from the fetched
integration commit. The distinct owner-controlled `upstream/master` reference
was not moved or merged.

## Harness boundary

Run:

```powershell
node scripts/characterizeSketchObservability.mjs --repetitions 100
```

The controller copies itself into a temporary external consumer, links this
checkout as `node_modules/brep-io-kernel`, and starts the copied file in worker
mode. Each worker dynamically imports only `brep-io-kernel`; it does not import
`src/`, a source file, or the built entry by relative path. Temporary files are
removed after the run.

Each fresh process solves the same five-case matrix. Forward and reverse case
orders alternate to expose obvious module-retained or order-sensitive state.
The harness records the public solver output and independently evaluates the
supported constraint subset's residual vector and numerical Jacobian rank.
The independent calculation is intentionally in the external-client harness,
not an assertion that the package publishes those diagnostics.

## Results

All 100 fresh processes and 500 case executions passed. Fifty processes used
each order. The canonical result had one digest,
`3eb9b4ef916a4459a854ff8a525a50c7f32637b3dea2dc94d7e2b6cc310939bf`.

| Case | Independent evidence | Public observation |
| --- | --- | --- |
| Valid fully constrained | zero maximum residual, rank 4/4, zero degrees of freedom, no redundant equation | every constraint `solved`; no error |
| Under-constrained | zero residual, rank 0/4, four degrees of freedom | no aggregate status or degrees-of-freedom result |
| Redundant over-constrained | zero residual, rank 4 with five equations, one redundant equation | every constraint `solved`; no error or aggregate status |
| Contradictory fixed distance | maximum residual 1 against package tolerance `1e-5` | distance constraint has `error: "points 0 and 1 are both fixed"` while its status and every other status are `solved` |
| Near-degenerate point-line distance | fixed line endpoints collapse to one point; the true line-distance residual is non-finite | every constraint `solved`; no error; the free point moves to approximately `[0.707116, 0.707116]` |

`ConstraintEngine.solve()` returned only `points`, `geometries`, and
`constraints`. Its prototype exposed `constructor`,
`processConstraintsOfType`, `solve`, and `tidyDecimalsOfPoints`. Neither it nor
the exported `ConstraintSolver` exposed an analysis method matching status,
residual, degrees of freedom, or rank.

## Interpretation and retained state

No result or order drift was observed across the 100 processes. That is useful
repeatability evidence for this bounded matrix, not a proof for all constraint
types or numeric inputs.

The public per-constraint `status` field is not a reliable aggregate validity
signal: the contradictory case reports both `status: "solved"` and an error.
The near-degenerate case is more serious for an unrestricted client because it
reports no error after implicitly treating a collapsed line like a point. A
method returning without throwing therefore does not establish sketch
validity, rank, or editability.

As in the preceding lifecycle experiments, none of the worker processes exited
naturally within the controller's grace period. All 100 were terminated after
reporting because the already-attributed package-level `BroadcastChannel`
remained live. This experiment found no additional retained-state symptom.

## Adapter and API decision

The published API is sufficient for BREP-MCP v1 only if sketch authoring stays
inside explicitly bounded macros whose inputs can be checked before solving and
whose solved coordinates, residuals, and resulting solid measurements can be
validated independently afterward. The adapter must not expose arbitrary
constraint graphs, infer validity from `status === "solved"`, or promise
degrees-of-freedom classification.

For that bounded v1 surface, no BREP production change is justified. Input
policy and independent postconditions belong in BREP-MCP because they describe
the adapter's admitted macro language rather than general kernel behavior.

If a future capability must accept general sketch constraints, the missing
general-purpose additive API is a read-only structured sketch analysis result:
aggregate solve classification, residuals per authored constraint, rank or
degrees of freedom, redundancy/contradiction diagnostics, and explicit
degenerate-geometry diagnostics. An adapter cannot safely reconstruct that for
all kernel constraint types from mutable per-constraint status/error fields.
This report stops before proposing or implementing such an API.

## What was not established

- The matrix covers only fixed, horizontal, distance, and point-line distance
  constraints; it is not a complete solver verification suite.
- Numerical Jacobian rank is an independent bounded-harness oracle, not a
  replacement implementation for arbitrary sketches.
- Cross-platform numeric behavior has not been measured in this Windows run.
- This experiment does not characterize topology naming, boolean conditioning,
  implicit geometry repair beyond the observed degenerate-line fallback, or
  serialization of arbitrary sketch diagnostics.
- The existing package lifecycle requires worker ownership/termination; this
  experiment does not change that conclusion.

## Validation record

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | passed; already up to date |
| `node --check scripts/characterizeSketchObservability.mjs` | passed |
| `pnpm exec eslint scripts/characterizeSketchObservability.mjs` | passed |
| `node scripts/characterizeSketchObservability.mjs --repetitions 100` | passed; 100 fresh processes, 500 cases, one digest |
| `pnpm typecheck` | passed |
| `pnpm lint` | unchanged baseline failure: `scripts/capture.ts:1149` has `no-unreachable`; seven existing warnings remain |
| `pnpm build:kernel` | unchanged Windows bootstrap failure before Vite: no runnable `cmake`, and `python3` is unavailable |

No generated build, temporary output, log, coverage, or package artifact is
included. The tested package is the byte-identical built artifact recorded
above.

## Next smallest experiment

Run architecture experiment 21.5 against the package boundary: deliberately
create split, merged, deleted, duplicated, and symmetric candidate topology,
then record whether an adapter can detect unique, missing, and ambiguous
reference outcomes without inventing stable generated topology IDs.
