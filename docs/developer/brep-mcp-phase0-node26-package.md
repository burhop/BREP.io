# Phase 0: Node 26 exact-package compatibility

- Date: 2026-07-21
- Package: `brep-io-kernel@1.0.306`
- Runtime: Node `v26.5.0`; pnpm `11.7.0`; Windows x64
- Production BREP changes: none

## Immutable artifact identity

The package was installed by exact version into a disposable external consumer.
The pnpm lockfile recorded registry integrity
`sha512-zI5xEYVRtNWVvzC0N7xtoFxKP/Lvzc50soGK64NwEcpdcjaGrfT8xtIrWVww16VI5iNuBE4g3xJ2/jFX3dYqPg==`.
The npm artifact reports source `gitHead`
`d04f4c72c21c880e51f8995e3eeff8dba4dd4f93`.

Every harness independently confirmed:

| Item | Evidence |
| --- | --- |
| Package entry | `./dist-kernel/brep-kernel.js` |
| Entry bytes | 219,927 |
| Entry SHA-256 | `e02210b77308d6110ca1454fb9ee19a3206e6b5259713732104e299c08d975ef` |
| `dist-kernel` files | 511 |
| `dist-kernel` tree SHA-256 | `f25880614cae01e29d150f7eed7c64922bdb225e615dde5774a548ab78cb9869` |
| Manifold | package-reported `local`, custom extensions present |

No sibling source path, checkout build, floating dependency, or mutable package
specifier was used as the kernel under test.

## Node 26 admitted-corpus results

The published-package harnesses from commit
`85d5b685b592d8396becd85110c27cc78e7f2684` were run unchanged against the
installed package with the checksum-verified official Node 26.5.0 Windows x64
binary.

| Experiment | Command threshold | Result |
| --- | --- | --- |
| Primitive replay/isolation | `characterizeHeadlessPackage.mjs --repetitions 100` | Passed; 100 author and 100 replay processes plus one concurrent probe; one normalized serialization and authored-record digest; 201 forced worker terminations. |
| Sketch/extrude create-edit replay | `characterizeSketchExtrudeRoundTrip.mjs --repetitions 100` | Passed; 400 fresh processes; every stage had one normalized history, intent, runtime-record, and geometry digest; no normalized difference paths. |
| Direct sidewall reference | `characterizeSidewallReferenceSafety.mjs --repetitions 100` | Passed; 400 fresh processes; every stage had one normalized history, intent, reference-snapshot, and geometry digest; source face, dependent basis, and dependent solid moved by `[1, 0, 0]`. |
| PartHistory isolation | `characterizePartHistoryStress.mjs --interleavings 1000 --workers 10` | Passed 1,000/1,000 with zero failures; record digest `381db11f4e3332ab81ca1067006817bf197ba5dbf736807804f0b5ea8b9d1061`; identity digest `4efdfd04fadb650cb919a79852baa9050da8447c6d526e839132dae68c66b9a9`. |

These results reproduce the complete currently admitted primitive,
bounded-sketch/new-body-extrude, serialization/edit, direct-reference, replay,
and worker-isolation spine on Node 26.5.0.

## Additional Phase 0 gates on Node 26

The focused harnesses from their immutable evidence commits were also run
against the same installed artifact:

- **21.7 scale/tolerance:** five repetitions of 48 cases (240 fresh processes)
  passed. The conservative `numeric-v1/default` policy remains a 1,000 mm
  absolute-coordinate envelope and 0.01 mm modeling floor, with 0.0001 mm
  absolute and 0.000001 relative comparison limits plus independent positive
  geometry/topology checks.
- **21.13 export:** five repetitions (16 fresh processes) passed for
  independently checked single-body STL and STEP. Empty geometry still returns
  success-shaped artifacts and must fail pre/post export validation. Multi-body
  STEP and all 3MF remain blocked by the public package boundary.
- **21.14 external geometry oracle:** five repetitions of 19 cases (95 fresh
  processes) passed. Package and independent STEP/STL measurements agreed;
  missing-triangle, moved-vertex, and disconnected-triangle seeds were all
  rejected by the combined gates.

Boolean remains omitted under 21.8. Only npm execution is claimed, so 21.12 is
not applicable. Experiments 21.9, 21.10, and 21.11 remain BREP-MCP application,
store/worker, and release gates rather than missing kernel capabilities.

## Static headless-boundary audit

The exact package root export was traversed through static relative ESM imports.
Its reachable closure contains five bundles:

| Reachable bundle | Bytes | Concrete browser API references |
| --- | ---: | --- |
| `brep-kernel.js` | 219,927 | none in executable code sampled by the focused patterns |
| `deepClone-DtPu-m_d.js` | 1,359,030 | one `document.createElement` |
| `index.esm-C2RuGKV3.js` | 120,452 | none in the focused patterns |
| `PartHistory-CIahaME9.js` | 9,567,757 | 299 `document.createElement`, 24 window listener, 14 `localStorage`, and 10 `indexedDB` references |
| `SketchSolver2D-BChaMU-H.js` | 40,561 | none in the focused patterns |

The root package imports and the admitted operations execute in Node because
the browser-dependent paths are dormant or guarded. That runtime observation
does not satisfy BREP-MCP's stronger static requirement that the production
headless dependency boundary exclude UI/editor/browser-global modules.

## Compatibility decision

The immutable-artifact and Node-major reproduction gates are satisfied for the
narrow Windows x64 matrix. The static headless-boundary gate is **failed**, not
unresolved: the exact reachable closure contains browser-dependent code.

Therefore this evidence does not yet approve a production BREP-MCP dependency
pin or Phase 2 adapter implementation. The smallest safe kernel task is to add
a documented headless package entry whose complete reachable import closure
contains only the general-purpose geometry/history/solver boundary needed by
the admitted spine. It must not change existing browser exports or behavior.
After that entry is published as a new immutable exact artifact, rerun this
corpus and the static audit against those exact bytes.

Changing the BREP-MCP requirement to permit dormant bundled UI/browser code
would be an architectural decision, not an evidence reinterpretation, and
would require an ADR and normative architecture update.

## Validation notes

- The official Node 26.5.0 Windows x64 archive matched SHA-256
  `d3b2277dbcccfdf24ef6302928f64f484cff1d77a6d3caa3a28f4d20ce9158f6`.
- All geometry harnesses exited zero at their recorded thresholds.
- Every geometry worker retained the known package-level message resource and
  required controller termination; natural process exit remains forbidden.
- No generated package, geometry artifact, temporary consumer, log, or raw
  harness output is committed.
