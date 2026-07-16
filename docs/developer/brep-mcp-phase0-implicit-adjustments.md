# Phase 0: implicit-adjustment inventory

- Date: 2026-07-16
- Experiment: architecture experiment 21.6 through the published package
- Capability: admit only operations whose geometric adjustments can be
  disabled, independently detected, or deterministically reported
- Production BREP changes: none

## Identity and boundary

| Item | Evidence |
| --- | --- |
| BREP experiment base | `bdf035a104b23edecfc31849ecb7134dc7ffe6b0` |
| `origin/integration/brep-mcp-v1` after fetch | `bdf035a104b23edecfc31849ecb7134dc7ffe6b0` |
| owner-controlled `upstream/master` after fetch | `d04f4c72c21c880e51f8995e3eeff8dba4dd4f93` |
| Node / pnpm | Node `v25.2.0`; pnpm `11.7.0` |
| Platform | Windows x64, `Windows_NT` release `10.0.26200` |
| EMSDK / Manifold submodules | `d223ae73c6998296e3ab27cf81dc2c2c9fd383de` / `ae2dbdb2fb87a424c970e415260165ef0e6041ec` |
| Manifold runtime | repository-local build with custom extensions enabled |
| Package export | `brep-io-kernel` -> `./dist-kernel/brep-kernel.js` |
| Built entry | 227,467 bytes; SHA-256 `e60b7fcc80daff9242851e6851113440c41d06df5de9d8d8f6a3bc5dfdf678c7` |
| `dist-kernel` tree | 380 sorted files; SHA-256 `ab0b930a968279b3a641f5fc4a0f93bb424c73d90e0fae658cd212b8206a0930` |

The branch was created from the clean fetched integration branch. The harness
copies itself into a temporary external consumer and imports only
`brep-io-kernel`. The owner baseline was not moved or merged.

## Method

Run:

```powershell
node scripts/characterizeImplicitAdjustments.mjs --repetitions 3
```

Nine cases run in alternating order and fresh processes. Normal cases use
`PartHistory`; controlled fault-injection cases use the package's public `BREP`
export. The latter override public solid methods in memory to force primary
boolean failures, which makes normally rare fallback branches observable
without importing source files or changing production code.

The harness records structured effect keys, package debug events, authored
features, live scene solids, face labels, bounds, extents, volume, area,
triangle count, and any structured field whose name indicates an adjustment,
conditioning, diagnostic, fallback, nudge, repair, simplification, or weld.

## Results

All 27 fresh processes passed. Every case produced one digest across three
repetitions. No case-order drift was observed.

| Case | Adjustment or behavior | Observability |
| --- | --- | --- |
| New-body extrude (`NONE`) | none observed; authored depth 5 produced depth 5, volume 180, area 192 | independent geometry fully detects the expected result |
| Extrude `UNION`, no targets | unconditional forward nudge; depth `5.00001001358`, volume `180.000360489` | detectable only by independent measurement; no structured diagnostic |
| Extrude `SUBTRACT`, no targets | same unconditional forward nudge despite no boolean target | detectable only by independent measurement; no structured diagnostic |
| Collinear authored-edge split | profile welding/simplification preserves aggregate geometry but replaces `G1_SW` with generic `PROFILE_SW` | detectable by authored-edge count, labels, topology signature, and measurements; no structured diagnostic |
| Duplicate authored edge | no exception; returns an empty `E2` solid with zero faces, volume, area, and triangles | independently detectable and rejectable; no structured diagnostic |
| Cube union | two authored features remain in serialized history, while the live tool solid is removed and one target-named result remains | deterministic and observable from history plus scene; no adjustment diagnostic |
| Forced union primary failure | repair fallback succeeds; tiny-face cleanup is invoked with area threshold `0.001` | fallback and threshold appear only in opt-in debug logs / instrumentation; effects contain only `added` and `removed` |
| Forced subtract primary and welded failure | helper returns the unchanged target while reporting success-shaped `added`/`removed` effects | only opt-in debug log says “passing target through”; no structured failure or adjustment field |
| Unknown boolean operation | unchanged base is returned with no removals and no error | operation must be rejected by adapter schema/preflight; package has no structured diagnostic |

The forced union used a scale-derived weld epsilon
`0.00001732050807568877`, repaired both operands, and then invoked unconditional
tiny-face cleanup at `0.001`. The resulting union had volume 1108, area 672,
28 triangles, and 11 named faces. None of the result or effect objects exposed
a structured fallback, repair, weld, cleanup, or adjustment record.

The forced subtract returned the exact original 10 x 10 x 10 target (volume
1000) after both subtract attempts failed, while the effect still contained
one addition and two removals. A result existing and replay returning without
throwing are therefore insufficient commit evidence.

## Inventory and supported-domain decision

| Adjustment family | Disable | Detect independently | Deterministically report | v1 decision |
| --- | --- | --- | --- | --- |
| New-body primitive/sketch/extrude | boolean operation `NONE` avoids boolean nudges/fallbacks | yes: authored records, topology, bounds, volume, area, triangles | adapter can report its own evidence | admitted within the characterized macro domain |
| Collinear-profile welding | no exposed switch in this path | yes: compare authored edges with face roles and semantic topology | adapter can report detected label/provenance loss | reject the candidate or require explicit reference replacement |
| Duplicate/degenerate profile | no exposed switch | yes: non-empty body/face/volume/manifold gates | adapter can report independent rejection | reject |
| Extrude boolean nudge | no exposed switch | measurable, but exact downstream semantic contribution is operation-dependent | no package record | boolean-mode extrude deferred |
| Boolean overlap conditioning | `overlapConditioningEnabled: false` | partial geometry comparison | debug log only | must remain disabled if boolean is later promoted |
| Boolean repair/weld/mesh fallback | no public disable switch | final geometry can be measured, but fallback use and intent equivalence cannot generally be reconstructed | debug log only | boolean deferred |
| Boolean tiny-face cleanup/coplanar merge | no public disable switch | output differences are measurable only when a pre-cleanup oracle exists | debug log only on failures; no success record | boolean deferred |
| Subtract pass-through on failure | no public strict/fail switch | independent before/after comparison detects this injected case | debug log only | boolean deferred |
| Revolve seam weld | fixed epsilon `1e-6` in the feature path; no exposed control or structured record | not fully characterized here | none | revolve deferred |

This decision narrows the production surface rather than claiming that all
documented BREP feature families passed experiment 21.6. Primitives,
deterministic admitted sketch macros, and new-body extrude can proceed to the
next numeric/geometry experiments. Boolean and revolve must remain absent from
the advertised MCP capability matrix until their adjustment paths are made
strictly observable or separately accepted by a revised contract.

## Missing general-purpose API

If boolean and revolve remain required capabilities, the smallest
general-purpose additive BREP API is a structured per-feature execution result
or diagnostic accessor containing:

- the requested operation and whether it actually executed;
- every input nudge, conditioning transform, weld/simplify/cleanup tolerance,
  repair or fallback attempted and selected;
- explicit strict-failure versus pass-through outcome;
- source/result body disposition and face-provenance changes;
- stable diagnostic codes and numeric parameters, separate from debug text.

It should also provide strict options that reject rather than repair, fall back,
or pass through where feasible. Such a result is useful to any headless kernel
consumer and introduces no MCP concepts. The BREP-MCP adapter cannot safely
reconstruct which internal branch ran from final geometry alone, and debug
console text is not a durable, typed, candidate-bound audit record.

This characterization stops before implementing that API. Under the current
narrowed capability matrix, no BREP production change is justified.

## Retained state and uncertainty

- All 27 workers retained the already-attributed package `BroadcastChannel`
  and were terminated after reporting.
- The boolean fault injection proves observability gaps and strictness hazards;
  it does not estimate how often real production inputs enter each fallback.
- Tiny-face cleanup success does not expose the number or identity of removed
  faces.
- Boolean tangency/domain behavior, scale envelope, and independent geometry
  oracle remain separate experiments 21.7, 21.8, and 21.14.
- Cross-platform numeric behavior was not measured in this Windows run.

## Validation record

| Command | Result |
| --- | --- |
| `node --check scripts/characterizeImplicitAdjustments.mjs` | passed |
| `pnpm exec eslint scripts/characterizeImplicitAdjustments.mjs` | passed |
| `node scripts/characterizeImplicitAdjustments.mjs --repetitions 3` | passed; 27 fresh processes, nine stable case digests |
| `pnpm typecheck` | passed |
| `pnpm lint` | unchanged baseline failure: `scripts/capture.ts:1149` has `no-unreachable`; seven existing warnings remain |
| `pnpm build:kernel` | unchanged Windows bootstrap failure before Vite: no runnable `cmake`, and `python3` is unavailable |

No generated build, temporary output, log, coverage, or package artifact is
included.

## Next smallest experiment

Run experiment 21.7 for the narrowed primitive/sketch/new-body-extrude surface:
sweep model extents and minimum feature sizes around a proposed closed policy,
and verify repeatable non-empty topology plus bounded independent measurement
error before any numeric limits are advertised.
