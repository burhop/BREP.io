# BREP-MCP Phase 0 export and round-trip characterization

## Scope

This experiment covers architecture experiment 21.13 at the published
`brep-io-kernel` boundary. It asks whether an external, headless consumer can
export replayed history geometry as STL, STEP, or 3MF; distinguish a valid
artifact from empty geometry; and export two bodies as one artifact.

The harness imports only `brep-io-kernel`. It does not import BREP source files
or internal exporter modules. No BREP production code was changed.

## Environment and artifact

- BREP integration baseline: `0460cdd30fd00c652abdfca743bb7240215bc95d`
- Owner baseline: `upstream/master` at
  `d04f4c72c21c880e51f8995e3eeff8dba4dd4f93`
- Exact npm artifact: `brep-io-kernel@1.0.306`
- Artifact source `gitHead`: `d04f4c72c21c880e51f8995e3eeff8dba4dd4f93`
- Package entry: `./dist-kernel/brep-kernel.js`, 219,927 bytes, SHA-256
  `e02210b77308d6110ca1454fb9ee19a3206e6b5259713732104e299c08d975ef`
- Node: `v24.14.0`; pnpm: `11.7.0`
- Platform: Windows x64, `Microsoft Windows NT 10.0.26200.0`
- Submodules: EMSDK `d223ae73c6998296e3ab27cf81dc2c2c9fd383de`;
  Manifold `ae2dbdb2fb87a424c970e415260165ef0e6041ec`
- Package-reported Manifold source: `local`, with custom extensions present

The checkout build was also smoke-tested under Node `v25.2.0`. Release evidence
below is from the exact npm artifact and the pinned Node 24 runtime.

## Harness

Run the exact-package experiment with:

```powershell
& 'C:\Users\markb\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' `
  scripts\characterizeExportRoundTrip.mjs `
  --repetitions 5 `
  --package-root C:\tmp\brep-mcp-npm-consumer\node_modules\brep-io-kernel
```

The harness creates a temporary external consumer and package link, then uses
fresh Node processes to author and replay a 5 x 10 x 15 mm cube. It independently
parses ASCII STL and a deliberately triangulated faceted STEP variant, computing
bounds, surface area, signed-volume magnitude, triangle count, and undirected
edge incidence. It also inspects the default STEP structure, an already-proven
scale-corner zero-geometry case, and a two-body history. Temporary histories and
artifacts are deleted.

Five repetitions used 16 fresh processes and passed. As in the earlier package
lifecycle characterization, all 16 workers retained a package-level
`MessagePort` and required controller termination after reporting their result.

## Evidence

### Valid single-body export

The public `Solid.toSTL()` and `Solid.toSTEP()` methods worked after both author
and fresh-process replay. Independent measurements agreed for every artifact:

- 12 triangles, 18 unique triangulation edges, and no edge incidence other
  than two;
- bounds `[0, 0, 0]` through `[5, 10, 15]` mm;
- surface area `550` mm2 and volume `750` mm3;
- one closed shell and one faceted BREP in STEP.

STL was byte-stable without normalization, SHA-256
`379cc63ac46cb37a6dec6a75cb79cce6314ea0e09f0724505df70f529def5849`.
Default STEP merged the triangles into six advanced faces. The triangulated
STEP variant contained twelve advanced faces. Their stable normalized SHA-256
values were, respectively,
`ed6bd60a41c8d74bccaafadd311fd9015de872dfa510c4fccf2efd0e1d713093`
and `e64f54995ad037211e8c8b3d08e6147d197ce98989f248be71e6ea27607ec477`.

Raw STEP bytes were not stable because `FILE_NAME` contains the current
second-resolution timestamp. The harness replaces only that timestamp before
comparison. Raw history JSON likewise differed only through the already-known
feature timestamp; canonical property ordering plus timestamp replacement gave
one authored/replayed digest,
`27e20424d5c1d478d658230cf14c2c3c062f84491c479229b2f094667d874205`.

### Empty geometry is not an export failure

The scale-corner fixture at a 1,000,000 mm origin and 0.00001 mm base size ran
without a feature error and left an observable solid with zero triangles and
zero volume. Export calls also returned without throwing:

- STL returned a 38-byte, syntactically framed, zero-facet ASCII file;
- both STEP variants returned the empty string.

Therefore return-without-throwing, non-null scene presence, and syntactic STL
framing are not sufficient export-success criteria. The BREP-MCP adapter must
apply independent pre-export geometry checks and post-export artifact checks.

### Public package boundary and multiple bodies

The package root exposes neither `generateSTEP` nor `generate3MF`; a `Solid`
has no `to3MF()` method. Deep imports of
`brep-io-kernel/src/exporters/step.js` and
`brep-io-kernel/src/exporters/threeMF.js` both fail with
`ERR_PACKAGE_PATH_NOT_EXPORTED`.

A two-body history produced two independently valid solids. Public methods can
export each body separately, but they cannot create one multi-body STEP or 3MF
artifact. Concatenating complete STEP files would not produce one conforming
ISO 10303-21 exchange structure. Reaching into package internals is also not a
safe adapter option because package exports explicitly forbid it.

## API conclusion

Single-body STL and STEP need no BREP production change for the currently safe
feature subset, provided the adapter validates geometry and exported artifacts.
The required multi-body STEP and 3MF capabilities are not safely implementable
through the current public package.

The smallest general-purpose additive BREP change is to expose the existing
multi-solid exporters through a documented headless package surface, returning
structured export results rather than discarding skip information. A suitable
non-MCP-specific contract would report the artifact bytes plus the requested,
exported, and skipped solid identities and reasons. An analogous structured
multi-solid STL function would make all formats consistent. Existing
`Solid.toSTL()` and `Solid.toSTEP()` behavior should remain unchanged for
compatibility.

This task stops before implementing that API. BREP-MCP must not claim multi-body
STEP or any 3MF export until the additive package contract is reviewed,
implemented, and independently characterized.

## Validation and unchanged baselines

- Exact npm artifact harness, five repetitions: passed; 16 fresh processes.
- Checkout artifact smoke harness, two repetitions under Node `v25.2.0`:
  passed; seven fresh processes.
- `pnpm exec eslint scripts/characterizeExportRoundTrip.mjs`: passed with no
  findings.
- `pnpm typecheck`: passed.
- `pnpm lint`: unchanged baseline failure at `scripts/capture.ts:1149`
  (`no-unreachable`) plus seven existing warnings. The new harness has no lint
  findings.
- `pnpm build:kernel`: unchanged environment baseline failure before Vite;
  locally compiled Manifold preparation could not find runnable `cmake`, and
  `python3` was unavailable to bootstrap it.

The broader source test suite was not run because this task changes no source
behavior and the fresh-process built-artifact harness directly exercises the
boundary under review.

## Remaining uncertainty and next experiment

The experiment does not validate import into an independent CAD application,
curved geometry fidelity, color/metadata preservation, or ZIP-level 3MF
determinism. The next smallest BREP experiment is a focused contract test for a
proposed public multi-solid export result, including all-requested-or-explicitly-
skipped accounting and independent STEP/3MF readers. Until that API is approved,
the next adapter-side work is limited to single-body STL/STEP with geometry and
artifact validation.
