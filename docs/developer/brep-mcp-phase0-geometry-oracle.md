# BREP-MCP Phase 0 external geometry oracle

## Scope

This experiment covers architecture experiment 21.14 for the currently admitted
primitive geometry domain. It compares package-owned measurements with a
separate parent-process implementation and verifies that deliberately damaged
geometry fails the appropriate gates.

The package worker imports only `brep-io-kernel`. It authors a transformed cube,
records package measurements, and writes ASCII STL and deliberately triangulated
faceted STEP. The parent process does not import BREP. It independently parses
those artifacts and calculates bounds, triangle count, surface area,
translation-stabilized signed-volume magnitude, oriented edge incidence,
connected components, axis-normal classes, and the six expected semantic face
planes.

No BREP production code was changed.

## Execution identity

- BREP integration baseline: `0460cdd30fd00c652abdfca743bb7240215bc95d`
- Owner baseline: `upstream/master` at
  `d04f4c72c21c880e51f8995e3eeff8dba4dd4f93`
- Exact npm artifact: `brep-io-kernel@1.0.306`
- Artifact source `gitHead`: `d04f4c72c21c880e51f8995e3eeff8dba4dd4f93`
- Package entry: 219,927 bytes, SHA-256
  `e02210b77308d6110ca1454fb9ee19a3206e6b5259713732104e299c08d975ef`
- Node `v24.14.0`; pnpm `11.7.0`; Windows x64
- EMSDK submodule `d223ae73c6998296e3ab27cf81dc2c2c9fd383de`
- Manifold submodule `ae2dbdb2fb87a424c970e415260165ef0e6041ec`
- Package-reported Manifold source `local`, with custom extensions present

## Matrix and tolerances

The 19-case matrix covers cube base sizes `0.01`, `0.1`, `1`, `10`, and `100`
mm and translated origins `0`, `100`, `500`, and `900` mm. Combinations remain
inside the provisional 1,000 mm absolute-coordinate envelope. Cube extents are
`size`, `2 * size`, and `3 * size`.

The oracle uses the already-characterized numeric profile:

- coordinate comparison: maximum of `0.0001` mm absolute and `0.000001`
  relative;
- surface-area comparison: maximum of `1e-8` mm2 absolute and 1% relative;
- volume comparison: maximum of `1e-10` mm3 absolute and 1% relative;
- artifact coordinates: twelve decimal places.

The coordinate bound covers Float32 quantization at the tested envelope. The 1%
fidelity bound is the companion scale/tolerance experiment's conservative
limit at the 0.01 mm floor. Tighter initial limits incorrectly rejected valid
small features at translated origins even though the package and independent
measurements agreed; that failed tuning run is not treated as a kernel failure.

Run the exact-package experiment with:

```powershell
& 'C:\Users\markb\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' `
  scripts\characterizeExternalGeometryOracle.mjs `
  --repetitions 5 `
  --package-root C:\tmp\brep-mcp-npm-consumer\node_modules\brep-io-kernel
```

## Evidence

Every valid STEP and STL artifact passed all independent gates across the full
matrix. Independent STEP measurements also agreed with package-owned bounds,
area, volume, and manifoldness. Translated STL bounds agreed with the authored
world transform; no transform-loss exception is required for this primitive
path. Normalized artifact and measurement digests were stable across
repetitions.

For the representative 1 x 2 x 3 mm cube at origin 100 mm, both implementations
reported bounds `[100, -50, 25]` through `[101, -48, 28]`, area `22` mm2,
volume `6` mm3, 12 triangles, one connected component, an oriented closed
manifold, four triangles in each axis-normal class, and exactly two semantic
planes per axis.

Three independent defect seeds were all rejected:

| Seed | Critical failures |
|---|---|
| remove one triangle | triangle count, area, oriented manifoldness, semantic axis probe |
| move one shared vertex while retaining a closed shell | area, volume, semantic axis probe |
| add one disconnected translated triangle | count, bounds, area, volume, manifoldness, connected components, semantics |

The missing-triangle seed deliberately demonstrates why volume alone is not an
oracle: its translation-stabilized volume still equals the expected volume.
The moved-vertex seed remains a closed oriented manifold, demonstrating why
manifoldness and component count alone are also insufficient. All gates must be
combined.

As in other package experiments, every worker retained a package-level
`MessagePort`; the controller terminated each worker after consuming the result.

## Validation and unchanged baselines

- Exact npm artifact oracle matrix, five repetitions: passed; 19 cases per
  repetition and 95 fresh processes; zero valid-gate failures; all three defects
  rejected; normalized results stable.
- `pnpm exec eslint scripts/characterizeExternalGeometryOracle.mjs`: passed
  with no findings.
- `pnpm typecheck`: passed.
- `pnpm lint`: unchanged baseline failure at `scripts/capture.ts:1149`
  (`no-unreachable`) plus seven existing warnings. The new harness has no lint
  findings.
- `pnpm build:kernel`: unchanged environment baseline failure before Vite;
  locally compiled Manifold preparation could not find runnable `cmake`, and
  `python3` was unavailable to bootstrap it.

The broad source test suite was not run because no source behavior changed and
the built-artifact matrix directly exercises the package boundary under review.

## Adapter decision

The public package supplies enough observable geometry for an independent
BREP-MCP validation gate in the currently admitted cube/sketch/new-body-extrude
domain. The adapter must calculate its own artifact-derived evidence and compare
it with canonical intent and package measurements. It must not accept any
producer measurement as its own oracle.

This evidence does not admit curved features, booleans, mutating extrudes,
arbitrary sketches, or topology healing. Those require capability-specific
semantic probes and defect seeds.

## Explicit remaining capability deferrals

### 21.8 boolean/tangency domain

Boolean remains absent from the v1 supported schema. The implicit-adjustment
characterization already demonstrates unconditional nudges, overlap
conditioning, cleanup, fallback, pass-through-on-failure, and missing structured
diagnostics. Running the 21.8 shape matrix cannot promote the capability until
those paths can be disabled or deterministically reported. Therefore 21.8 is a
recorded capability deferral, not an unreported pass: boolean stays blocked and
no production API change is justified by this oracle task.

### 21.12 npm/WASM equivalence

Only one execution mode is supported: the exact npm artifact and identity above.
The checkout build differs bytewise and the current machine cannot rebuild its
local Manifold dependency because runnable CMake/Python bootstrap tooling is
absent. A second local/source WASM mode is not advertised, so equivalence is not
a release claim or current gate. If a second mode is proposed, it must receive a
distinct execution identity until the complete golden corpus proves normalized
equivalence.

## Remaining uncertainty and next experiment

The oracle covers axis-aligned transformed cuboids over the admitted numeric
envelope, not the complete supported sketch/extrude semantic corpus. The next
smallest adapter-side experiment is validation-independence fault injection
(21.9) through the real candidate pipeline: forged package measurements, stale
artifacts, missing semantic evidence, and failed assertions must each prevent
publication. BREP production code is not required for that work.
