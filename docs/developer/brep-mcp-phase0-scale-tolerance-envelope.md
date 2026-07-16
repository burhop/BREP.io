# Phase 0: scale and tolerance envelope

- Date: 2026-07-16
- Experiment: architecture 21.7
- Capability: bounded primitive and sketch-plus-new-body-extrude creation
  through the built `brep-io-kernel` package
- Production BREP changes: none

## Identity and scope

| Item | Evidence |
| --- | --- |
| BREP experiment base | `0460cdd30fd00c652abdfca743bb7240215bc95d` |
| `origin/integration/brep-mcp-v1` | `0460cdd30fd00c652abdfca743bb7240215bc95d` |
| owner-controlled `upstream/master` | `d04f4c72c21c880e51f8995e3eeff8dba4dd4f93` |
| Node / pnpm | Node `v25.2.0`; pnpm `11.7.0` |
| Platform | Windows x64, `Windows_NT` release `10.0.26200` |
| EMSDK / Manifold submodules | `d223ae73c6998296e3ab27cf81dc2c2c9fd383de` / `ae2dbdb2fb87a424c970e415260165ef0e6041ec` |
| Manifold source | repository-local build with custom extensions enabled |
| Package export | `brep-io-kernel` -> `./dist-kernel/brep-kernel.js` |
| Built entry | 227,467 bytes; SHA-256 `e60b7fcc80daff9242851e6851113440c41d06df5de9d8d8f6a3bc5dfdf678c7` |
| `dist-kernel` tree | 380 sorted files; SHA-256 `ab0b930a968279b3a641f5fc4a0f93bb424c73d90e0fae658cd212b8206a0930` |

The branch was created from the clean fetched integration branch. The harness
copies itself into a temporary external consumer, resolves the built package by
name, and does not import BREP source files. The owner-controlled baseline was
not moved or merged.

## Method

Run:

```powershell
node scripts/characterizeScaleToleranceEnvelope.mjs --repetitions 5 --summary-only
```

The harness ran 48 cases five times in alternating forward and reverse order,
for 240 fresh Node processes. Each process:

1. imported `brep-io-kernel` from the temporary consumer;
2. authored and ran one `PartHistory` containing either a rectangular primitive
   or a rectangle sketch plus new-body extrude;
3. serialized the history;
4. reconstructed and replayed it in a second `PartHistory`;
5. compared the author and replay observations;
6. measured analytic bounds, extents, area, volume, faces, triangles, and
   coherent manifold orientation.

The cube sweep used dimensions `[s, 2s, 3s]`, scalar origins from 0 through
1,000,000 mm, and sizes from 0.00001 through 1 mm. Separate origin-zero cases
used sizes 10, 1,000, and 1,000,000 mm. Sketch/extrude checkpoints sampled the
observed boundary at origins from 0 through 1,000,000 mm.

A case was admitted only when both author and replay:

- had finite geometry and measurements;
- had positive extents, six faces, twelve triangles, and coherent manifold
  orientation;
- satisfied the provisional scalar length comparator;
- exceeded the provisional tiny-area and tiny-volume thresholds;
- stayed within 1% relative error for each extent, area, and volume; and
- produced identical canonical author and replay observations.

The 1% fidelity limit is an experiment oracle, not a hidden kernel tolerance.
It makes collapse and material shape distortion fail even when an absolute
coordinate comparator regards the endpoints as equal.

## Results

All 48 cases were stable across five repetitions. There were no worker crashes,
author/replay differences, or ordering-dependent results. All 240 workers
retained the already-attributed package-level `BroadcastChannel` and required
controller termination after reporting.

### Primitive frontier

| Scalar origin (mm) | Smallest admitted `s` (mm) | Important rejected point |
| ---: | ---: | --- |
| 0 | 0.001 | 0.0001 is below the tiny-volume threshold |
| 100 | 0.001 | 0.0001 exceeds the fidelity limit and thresholds |
| 1,000 | 0.01 | 0.001 has 2.34375% maximum extent error |
| 10,000 | 1 | 0.1 fails the sampled fidelity gate |
| 100,000 | 1 | every sampled size below 1 failed |
| 1,000,000 | 1 | every sampled size below 1 failed |

At origin 1,000 mm and size 0.01 mm, the measured extents were
`[0.01000976563, 0.019989013672, 0.029998779297]`. Maximum extent error was
0.0977%, surface-area error was 0.0011%, and volume error was 0.0386%. The same
case replayed exactly.

At the same origin and size 0.001 mm, topology remained present, but maximum
extent error was 2.34375% and volume error was 1.45625%. That point is outside
the admitted envelope even though the scalar absolute comparator accepts its
length differences.

Origin-zero cube sizes 10, 1,000, and 1,000,000 mm also passed. Those isolated
upper-size results do not prove every large-size/large-offset combination.

### Sketch/extrude checkpoints

Sketch-plus-new-body-extrude passed at:

- origin 0 / size 0.001 mm;
- origin 100 / size 0.001 mm;
- origin 1,000 / size 0.01 mm;
- origin 100,000 / size 1 mm; and
- origin 1,000,000 / size 1 mm.

It rejected origin 1,000 / size 0.001 mm and origin 10,000 / size 0.1 mm under
the same acceptance rules. The package's established forward-extrude direction
for the default plane is negative Z; the independent bounds oracle accounts for
that convention.

### Provisional-profile failure

The architecture's provisional pair of a 1,000,000 mm coordinate envelope and
a 0.00001 mm modeling length is unsafe for this package build. At that corner,
the cube reported:

- min and max bounds both `[1000000, -500000, 250000]`;
- extents `[0, 0, 0]`;
- zero triangles, area, and volume;
- six retained face labels and `true` coherent-manifold status; and
- no feature execution error.

Author and replay reproduced the collapse exactly. The provisional scalar and
tiny-value comparisons masked 13 sampled failures, including this complete
collapse. Therefore numeric equality cannot substitute for positive geometry,
topology, and relative-fidelity checks.

## Numeric-policy decision

For the initial admitted BREP-MCP creation spine, use this conservative profile:

```json
{
  "profileId": "numeric-v1/default",
  "coordinateEnvelopeMm": 1000,
  "modelingMm": 0.01,
  "comparisonAbsoluteMm": 0.0001,
  "comparisonRelative": 0.000001,
  "angularRad": 0.000001,
  "tinyAreaMm2": 1e-8,
  "tinyVolumeMm3": 1e-10
}
```

The BREP-MCP adapter must fail closed before execution when an authored world
coordinate exceeds the envelope or a nonzero modeled length is below
`modelingMm`. Post-execution validation must independently require positive
extents, positive area and volume above policy thresholds, expected topology,
and coherent manifold orientation. Assertions must define dimensional norms;
the scalar comparator alone is insufficient.

This policy intentionally leaves performance and capability on the table. It
is the smallest closed interval directly supported by both primitive and
sketch/extrude boundary observations in this sweep, not a claim about the
kernel's universal limits.

## API and ownership decision

No BREP production change is justified. The existing package exposes enough to
author, serialize, replay, and measure the admitted operations. Envelope
rejection and evidence-bound validation are BREP-MCP adapter policy, not kernel
behavior.

The package does not emit a structured warning when geometry collapses, and
face labels plus coherent-manifold status can survive zero-triangle geometry.
The adapter therefore cannot safely infer validity from feature success, face
labels, or manifold orientation alone. This does not require a new API for the
narrow v1 slice because independent bounds, topology, area, and volume are
observable through the package.

## Validation record

| Command | Result |
| --- | --- |
| `git diff --check` | passed |
| `node --check scripts/characterizeScaleToleranceEnvelope.mjs` | passed |
| `pnpm exec eslint scripts/characterizeScaleToleranceEnvelope.mjs` | passed |
| `node scripts/characterizeScaleToleranceEnvelope.mjs --repetitions 2 --summary-only` | passed after oracle correction; 96 fresh processes |
| `node scripts/characterizeScaleToleranceEnvelope.mjs --repetitions 5 --summary-only` | passed; 240 fresh processes, 48 stable cases |
| `node scripts/characterizeSketchExtrudeRoundTrip.mjs --repetitions 2` | passed; used to confirm the established extrude-axis convention |
| `pnpm typecheck` | passed |
| `pnpm lint` | unchanged baseline failure: `scripts/capture.ts:1149` has `no-unreachable`; seven existing warnings remain |
| `pnpm build:kernel` | unchanged Windows bootstrap failure before Vite: no runnable `cmake`, and `python3` is unavailable |

No generated build, temporary JSON, log, coverage, or package artifact is
included.

## Remaining uncertainty and next smallest experiment

This is a Windows/package-build result. It does not establish browser or
cross-platform equivalence, arbitrary sketches, booleans, revolve, derived
sub-feature minima, every sign/axis combination at the boundary, or every
large-size/large-offset combination.

The next smallest experiment is architecture 21.14: run the admitted boundary
goldens through a validator independent of feature success and compare its
evidence against the package measurements. Exact positive/negative envelope
corners and axis permutations should be included before widening this profile.
