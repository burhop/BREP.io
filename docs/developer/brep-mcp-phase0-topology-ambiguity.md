# Phase 0: topology-label ambiguity characterization

- Date: 2026-07-16
- Experiment: architecture experiment 21.5 for the declared sketch/extrude spine
- Capability: fail-closed persistent face references across supported edits
- Production BREP changes: none

## Identity and boundary

| Item | Evidence |
| --- | --- |
| BREP experiment base | `dffc5a9a131a20fd06e15a6df74f9bedbfc9473f` |
| `origin/integration/brep-mcp-v1` after fetch | `dffc5a9a131a20fd06e15a6df74f9bedbfc9473f` |
| owner-controlled `upstream/master` after fetch | `d04f4c72c21c880e51f8995e3eeff8dba4dd4f93` |
| Node / pnpm | Node `v25.2.0`; pnpm `11.7.0` |
| Platform | Windows x64, `Windows_NT` release `10.0.26200` |
| EMSDK / Manifold submodules | `d223ae73c6998296e3ab27cf81dc2c2c9fd383de` / `ae2dbdb2fb87a424c970e415260165ef0e6041ec` |
| Manifold runtime | repository-local build with custom extensions enabled |
| Package export | `brep-io-kernel` -> `./dist-kernel/brep-kernel.js` |
| Built entry | 227,467 bytes; SHA-256 `e60b7fcc80daff9242851e6851113440c41d06df5de9d8d8f6a3bc5dfdf678c7` |
| `dist-kernel` tree | 380 sorted files; SHA-256 `ab0b930a968279b3a641f5fc4a0f93bb424c73d90e0fae658cd212b8206a0930` |

The branch was created from the clean, fetched integration branch. The owner
baseline was not moved or merged. The self-copying harness runs from a
temporary external consumer and imports only `brep-io-kernel` by package name.

## Model and method

The baseline is a 6 x 6 square sketch extruded by 5. It produces one solid
with volume 180, area 192, 12 triangles, four authored sidewall labels, and two
cap labels. For each face the harness records:

- exact package label and parent solid;
- selected provenance metadata (`sourceFeatureId`, `sourceEdgeName`, and face
  type);
- named boundary adjacency;
- independently measured area, bounds, center, and normal;
- strict signature, role, exact-geometry, and geometric-class digests.

Every edit is applied to serialized history before its fresh-process replay.
This is important: an early harness iteration replayed a restored history
before mutating nested sketch data and observed cached geometry. Those results
were discarded. The final harness does not treat unchanged cache output as an
edit result.

Run:

```powershell
node scripts/characterizeTopologyAmbiguity.mjs --repetitions 3
```

## Results

All seven cases produced one result digest apiece across three repetitions and
alternating case order. The controller used 22 fresh processes (one author plus
21 case executions). Baseline topology digest:
`2b98a2c6d7eacc459e621f67e4938e84340c07ea5bc7fc803df2d75fb197f33b`.

| Edit | Package result | Reference outcome |
| --- | --- | --- |
| Extrude distance 5 -> 7 | labels, roles, and adjacency preserved; volume 180 -> 252 | `G1_SW` is preserved by the declared feature role; strict geometry changes as expected |
| Reverse sketch record order | byte-equivalent topology evidence | `G1_SW` preserved exactly; order is not identity |
| Split `G1` into two collinear authored edges | geometry remains volume 180 / area 192 / 12 triangles; `G1_SW` disappears and one generic `PROFILE_SW` appears | broken exact reference; one exact-geometry replacement proposal, but no automatic rebind |
| Merge those collinear edges | `PROFILE_SW` disappears and `G1_SW` returns | explicit replacement is required; the old label does not survive syntactically |
| Delete `G4` while closing the profile as a triangle | five faces, volume 90, area 138.426406871, eight triangles | `G4_SW` is broken with no exact geometry or role candidate |
| Swap authored geometry IDs `G1` and `G3` | labels and aggregate geometry remain, but strict topology digest changes | `G1_SW` still resolves and retains `sourceEdgeName: S1:G1`, yet now has the old `G3_SW` geometry; semantic signature detects the changed meaning and fails closed |
| Duplicate the authored `G1` edge | no exception; `E2` exists with zero faces, volume, area, and triangles | independent geometry validation rejects the result; every prior face reference is broken |

The square also exposes symmetric candidate ambiguity. For reorder and
renumber cases, all four sidewalls share the same geometric-class signature
(sidewall type, area, sorted extents, and boundary count). After split or
merge, a full absolute geometry signature identifies one proposal, while the
geometric class still has four candidates. A unique numerical resemblance is
therefore not evidence that design intent is unique; replacement must remain
explicit and candidate-scoped.

## Supported preservation matrix

For the currently declared sketch/extrude spine:

- feature-parameter edits may preserve a face only when its exact label,
  source feature, authored role, and expected adjacency remain consistent and
  independent geometry changes match the declared edit;
- record property order and collection order are not identity;
- split, merge, delete, duplicate, or authored-entity renumbering are not
  preservation cases and must invalidate dependent references or the candidate;
- a syntactically surviving name is insufficient when its semantic signature
  changes;
- matching candidates may be returned only as explicit replacement proposals,
  never silently selected.

Primitives, revolve, and boolean-result topology are not promoted by this
slice. They require their own feature/edit matrix; boolean remains additionally
blocked by architecture experiment 21.8. Until those matrices pass, BREP-MCP
must omit those persistent-reference capabilities rather than generalize this
result.

## API decision

The published package exposes enough information for the adapter to implement
this narrow fail-closed contract: exact object lookup, face labels, selected
face provenance metadata, boundary adjacency, face meshes, normals, and solid
measurements. No BREP production change is justified.

The kernel does not classify split, merge, stale meaning, ambiguity, or invalid
zero-geometry output. Those are adapter evidence decisions over the public
queries. The adapter cannot safely claim stable generated topology IDs, heal a
missing label, or accept a returned solid merely because replay did not throw.

## Retained state and uncertainty

- Each case was deterministic in this Windows/package build; no order drift was
  observed in three repetitions.
- All 22 workers retained the already-attributed package `BroadcastChannel`
  and were terminated after reporting.
- The collinear split was geometrically welded into one sidewall and lost the
  authored `G1` provenance. Experiment 21.6 must record that as an implicit
  adjustment.
- The duplicate-edge case returned an empty solid without an error. Commit
  validation must independently reject zero-body/zero-face/zero-volume output.
- This is not evidence for arbitrary profiles, curved faces, booleans, revolve,
  or cross-platform behavior.

## Validation record

| Command | Result |
| --- | --- |
| `node --check scripts/characterizeTopologyAmbiguity.mjs` | passed |
| `pnpm exec eslint scripts/characterizeTopologyAmbiguity.mjs` | passed |
| `node scripts/characterizeTopologyAmbiguity.mjs --repetitions 3` | passed; 22 fresh processes, seven stable case digests |
| `pnpm typecheck` | passed |
| `pnpm lint` | unchanged baseline failure: `scripts/capture.ts:1149` has `no-unreachable`; seven existing warnings remain |
| `pnpm build:kernel` | unchanged Windows bootstrap failure before Vite: no runnable `cmake`, and `python3` is unavailable |

No generated build, temporary JSON, log, coverage, or package artifact is
included.

## Next smallest experiment

Run experiment 21.6 over the published package and inventory the adjustments
observed here plus Manifold tolerance, welding, simplification, boolean input
removal, and feature fallbacks. Every admitted v1 operation must either disable
the adjustment, detect it independently, or report it deterministically.
