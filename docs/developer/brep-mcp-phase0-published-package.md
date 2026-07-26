# Phase 0: published package compatibility corpus

- Date: 2026-07-16
- Package: `brep-io-kernel@1.0.306`
- Capability: exact npm artifact pin for the admitted BREP-MCP creation spine
- Production BREP changes: none

## Immutable identity

| Item | Evidence |
| --- | --- |
| npm package | `brep-io-kernel@1.0.306` |
| npm source commit | `d04f4c72c21c880e51f8995e3eeff8dba4dd4f93` |
| npm integrity | `sha512-zI5xEYVRtNWVvzC0N7xtoFxKP/Lvzc50soGK64NwEcpdcjaGrfT8xtIrWVww16VI5iNuBE4g3xJ2/jFX3dYqPg==` |
| npm tarball SHA-1 | `821196b3ac847a4242fc4294ae27a1a31cf7670a` |
| npm tarball | `https://registry.npmjs.org/brep-io-kernel/-/brep-io-kernel-1.0.306.tgz` |
| package export | `brep-io-kernel` -> `./dist-kernel/brep-kernel.js` |
| built entry | 219,927 bytes; SHA-256 `e02210b77308d6110ca1454fb9ee19a3206e6b5259713732104e299c08d975ef` |
| `dist-kernel` tree | 511 sorted files; SHA-256 `f25880614cae01e29d150f7eed7c64922bdb225e615dde5774a548ab78cb9869` |
| Manifold runtime | package reports `local` with custom extensions enabled |
| Runtime | Node `v24.14.0`; pnpm `11.7.0` |
| Platform | Windows x64, `Windows_NT` release `10.0.26200` |
| owner-controlled source baseline | `upstream/master` at the same source commit, `d04f4c72c21c880e51f8995e3eeff8dba4dd4f93` |

The artifact was installed by exact version into a disposable external consumer
under Node 24. No sibling source path, BREP source module, local package link,
or generated repository output was used as the package under test.

The npm bundle is not byte-identical to the previously characterized checkout
build. The checkout entry was 227,467 bytes with SHA-256 `e60b7fcc...`, while
the npm entry is 219,927 bytes with SHA-256 `e02210b7...`. The npm `dist-kernel`
tree also has 511 files rather than 380. Source-commit equality therefore was
not treated as sufficient; the threshold corpus was rerun against the exact
installed artifact.

## Harness change

The existing external-client harnesses now accept an optional absolute package
directory:

```text
--package-root <directory>
```

When omitted, behavior remains unchanged and the harness characterizes the
checkout package. When supplied, package metadata, entry bytes, `dist-kernel`
digest, and the temporary consumer link all come from that directory. Worker
fixtures and acceptance oracles still come from the reviewed repository test
corpus, avoiding a second implementation of the experiments.

## Results

### Primitive replay and isolation

```powershell
node scripts/characterizeHeadlessPackage.mjs --repetitions 100 `
  --package-root <installed-brep-io-kernel-1.0.306>
```

Passed in 246.8 seconds:

- 100 author processes, 100 replay processes, and one concurrent probe;
- one normalized serialization digest and one authored-record digest;
- stable bounds, face roles, volume, area, and triangle count;
- two concurrent histories remained isolated at volumes 24 and 210; and
- all 201 workers required controller termination.

### Sketch/extrude create-edit replay

```powershell
node scripts/characterizeSketchExtrudeRoundTrip.mjs --repetitions 100 `
  --package-root <installed-brep-io-kernel-1.0.306>
```

Passed in 722.1 seconds across 400 fresh processes. Author, replay, edit, and
replay-edited stages each produced one normalized history, intent, normalized
runtime-record, and geometry digest. Raw author/edit history and runtime records
had 100 digests only because of the four already documented timestamp/UUID
paths; no normalized difference path remained.

### Dependent sidewall reference

```powershell
node scripts/characterizeSidewallReferenceSafety.mjs --repetitions 100 `
  --package-root <installed-brep-io-kernel-1.0.306>
```

Passed in 777.9 seconds across 400 fresh processes. Every stage produced one
normalized serialization, authored-intent, semantic-reference-snapshot, and
geometry digest. The declared direct sidewall attachment and expected source
edit movement were preserved. All workers required controller termination.

### PartHistory stress

```powershell
node scripts/characterizePartHistoryStress.mjs --interleavings 1000 `
  --workers 10 --package-root <installed-brep-io-kernel-1.0.306>
```

Passed in 6.6 seconds:

- 1,000/1,000 alternating A/B interleavings passed, split 500/500 by order;
- zero cross-history scene, registry, expression, callback, metadata, or manager
  failures;
- canonical record digest
  `381db11f4e3332ab81ca1067006817bf197ba5dbf736807804f0b5ea8b9d1061`;
- manager-identity digest
  `4efdfd04fadb650cb919a79852baa9050da8447c6d526e839132dae68c66b9a9`;
  and
- all ten workers required controller termination.

These two digests match the checkout-build threshold, despite the distinct npm
bundle identity.

### Scale/tolerance envelope

The scale harness from commit `3908580` was extracted into the disposable npm
package so its package-root calculation, entry digest, and worker imports all
resolved to the installed artifact:

```powershell
node scripts/characterizeScaleToleranceEnvelope.mjs --repetitions 5 --summary-only
```

Passed in 184.3 seconds: 48 cases, five forward/reverse repetitions, and 240
fresh processes. All cases were stable and the frontier exactly matched the
checkout build:

- origin 0 / 100 mm: minimum admitted sampled size 0.001 mm;
- origin 1,000 mm: minimum admitted sampled size 0.01 mm;
- origins 10,000 / 100,000 / 1,000,000 mm: minimum admitted sampled size 1 mm;
- sketch/new-body-extrude passed at origin 1,000 / size 0.01 mm and rejected
  origin 1,000 / size 0.001 mm; and
- the provisional 1,000,000 / 0.00001 corner remained collapsed and rejected.

Thirteen sampled invalid cases were still masked by the provisional scalar/tiny
comparisons. The conservative BREP-MCP profile remains a 1,000 mm coordinate
envelope with a 0.01 mm modeling floor plus mandatory positive topology and
relative-fidelity validation.

## Compatibility decision

`brep-io-kernel@1.0.306` is approved for an exact dependency pin only for:

- Windows x64 with Node 24;
- worker-owned `PartHistory` construction, run, serialization, reconstruction,
  replay, and termination;
- admitted primitive creation;
- deterministic rectangle/circle/fixed-polyline adapter macros once their
  adapter lowering is contract-tested;
- finite new-body sketch extrude;
- the characterized direct sidewall dependency; and
- package-observable bounds, area, volume, face labels, triangle count, and
  coherent-manifold evidence, cross-checked by independent adapter validation.

The pin does not approve boolean operations, revolve, through-all, add/subtract/
intersect extrudes, arbitrary constraints, suppression, automatic reference
healing, export formats, browser execution, another platform, or another Node
major. Those capabilities remain absent or blocked until their own evidence
passes.

The adapter must fail closed at startup unless package version, package-manager
integrity, source commit, execution mode, numeric policy, and supported platform
match the compatibility record. It must own each history in a terminable worker;
natural process exit is not a cleanup contract.

## BREP API decision

No production BREP change is justified for the admitted slice. The exact
published package exposes the required lifecycle, serialization, replay,
measurement, and direct-reference observations. Missing structured sketch and
implicit-adjustment diagnostics continue to block broader capabilities rather
than justify an adapter-side approximation.

## Validation record

| Command | Result |
| --- | --- |
| `git diff --check` | passed |
| `node --check` for all four parameterized harnesses | passed |
| focused ESLint for all four parameterized harnesses | passed |
| `node scripts/characterizeHeadlessPackage.mjs --repetitions 2` without `--package-root` | passed; default checkout behavior preserved |
| `pnpm typecheck` | passed |
| `pnpm lint` | unchanged baseline failure: `scripts/capture.ts:1149` has `no-unreachable`; seven existing warnings remain |
| `pnpm build:kernel` | unchanged Windows bootstrap failure before Vite: no runnable `cmake`, and `python3` is unavailable |

No npm installation, lockfile, generated build, temporary JSON, log, coverage,
or package artifact is included in the repository diff.

## Remaining uncertainty

- npm and checkout bundles differ despite sharing the source commit; every
  upgrade must rerun the corpus against exact installed bytes;
- the scale sweep covers selected boundaries, not every axis/sign combination;
- external geometry-oracle defect injection is still required before a
  production semantic-correctness claim;
- crash/cancel atomicity, quotas, export round trips, and 24-hour soak are
  BREP-MCP worker/store/release gates, not claims made by this package pin; and
- browser and non-Windows compatibility remain untested.
