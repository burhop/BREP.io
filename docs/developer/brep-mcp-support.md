# Supporting BREP-MCP from the BREP kernel

- Status: integration-branch development guidance
- BREP baseline when created: `d04f4c72c21c880e51f8995e3eeff8dba4dd4f93`
- BREP-MCP protocol target: `brep-mcp/1.0`

## Purpose

This document explains the narrow role of BREP.io in the BREP-MCP project. It
is intentionally scoped to the `burhop/BREP.io` integration branch and may be
excluded from eventual upstream kernel pull requests.

The normative server architecture is maintained in the separate BREP-MCP
repository:

- GitHub: <https://github.com/burhop/BREP-MCP>
- Architecture:
  <https://github.com/burhop/BREP-MCP/blob/main/docs/architecture/BREP.io-MCP-Final-Architecture.md>
- When the repositories are sibling clones, the local copy is usually
  `../BREP-MCP/docs/architecture/BREP.io-MCP-Final-Architecture.md`.

This document summarizes the kernel-facing constraints so an agent can work
safely even when the BREP-MCP repository is not mounted. If this summary and the
normative architecture disagree, stop and reconcile them before implementation.

## Repository responsibilities

### BREP owns

- General-purpose geometry and topology operations.
- `PartHistory` feature execution and serialization behavior.
- Feature registration and authored feature data.
- Standalone sketch solving and kernel-level diagnostics.
- General-purpose geometry/topology queries suitable for any kernel consumer.
- Deterministic kernel export behavior and explicit failure reporting.
- Lifecycle capabilities that a normal headless kernel consumer needs, such as
  cancellation/disposal, only when experiments prove a gap.
- Tests that establish the behavior of the public kernel package.

### BREP-MCP owns

- The canonical MCP feature plan and acceptance contract.
- The exact five-tool protocol and JSON Schemas.
- Preview/commit transactions, immutable candidates, revisions, compare-and-swap,
  idempotency, and persistence.
- Disposable worker orchestration, resource policy, deadlines, and tenancy.
- Independent acceptance validation, evidence, audit records, and artifact
  publication.
- MCP transport, authorization, pagination, error envelopes, and telemetry.
- The adapter that lowers the canonical plan into the pinned BREP API.

BREP must not depend on BREP-MCP. BREP-MCP consumes an immutable BREP package or
commit artifact through one adapter; it must not import a sibling `src/` tree.

## Reliable-v1 context

The server exposes exactly five tools:

1. `brep.model.inspect`
2. `brep.change.preview`
3. `brep.change.commit`
4. `brep.model.validate`
5. `brep.model.export`

This does not imply five BREP APIs. The server builds one transactional pipeline
around a pinned kernel adapter. Commit promotes an already validated immutable
candidate and does not run BREP again.

The canonical asset is a server-owned feature plan plus design-intent
acceptance contract. `PartHistory` is an execution/persistence artifact behind
the adapter, not the public MCP source of truth. Generated faces, edges, and
bodies are target-scoped topology, not durable authored identity.

## Change decision tree

For every requested capability, use this order:

1. **Can the published `brep-io-kernel` package already do it safely?** Use the
   existing public API and make no BREP change.
2. **Can the BREP-MCP adapter derive it without relying on private internals?**
   Implement it in BREP-MCP.
3. **Is a generally useful kernel query or diagnostic missing?** Propose one
   small additive BREP API with focused tests.
4. **Would the change alter existing execution, serialization, topology,
   tolerance, fallback, or browser behavior?** Stop and document compatibility,
   migration, and experiment evidence before editing production code.
5. **Is the request actually server policy or protocol behavior?** Reject it
   from BREP and route it to BREP-MCP.

The burden of proof is on changing BREP, not on preserving it.

## Current observed kernel boundary

The package is named `brep-io-kernel`. Its current public entry point is
`src/index.ts`, built by `vite.config.kernel.ts` into `dist-kernel/`. It exports
`BREP`, `CppSolidCore`, `PartHistory`, the sketch constraint engine, assembly
constraint types, Manifold bindings, and license helpers.

`src/PartHistory.ts` currently owns more than pure feature replay. It creates a
Three.js scene, constructs registries and multiple managers, handles
expressions, serializes authored and application data, and imports some modules
under `src/UI/`. Therefore, "headless" is an experiment result, not an
assumption. Do not begin by moving or deleting those dependencies. Test the
built package in fresh Node processes, record what is loaded and retained, and
then propose the smallest boundary improvement supported by evidence.

Existing behavior worth characterizing before adding anything includes:

- `PartHistory.toSerializable()`, `toJSON()`, and `fromJSON()`;
- full and incremental history execution and queued/concurrent `runHistory()`;
- expression evaluation and configurator state;
- feature IDs, `inputParams`, `persistentData`, and migrations;
- face/edge metadata and current reference snapshots;
- sketch solver status and diagnostics;
- `src/exporters/threeMF.ts`, `step.ts`, and related export paths;
- Node tests in `src/tests/tests.ts` and browser execution in
  `src/tests/browserTests.ts`.

Source internals are useful for investigation but are not an adapter contract.
BREP-MCP must ultimately test the built package and exact pinned artifact.

## Phase 0 experiment program

Phase 0 characterizes the kernel before production MCP handlers. Each result
must record the exact BREP commit/package digest, Node/platform identity,
Manifold build source, input, raw output, normalized output, diagnostics,
measurements, digests, repetition count, and interpretation.

### 21.1 PartHistory isolation

Create and replay independent histories concurrently in fresh processes or
workers. Probe feature registration, expressions, PMI/managers, global Manifold
state, caches, timers, callbacks, and disposal. The target is no cross-history
mutation or ordering dependence over the required interleaving corpus.

Start with a harness and existing APIs. Do not add a lifecycle API until the
harness identifies retained state that cannot be controlled externally.

### 21.2 Replay determinism

Replay small supported golden histories repeatedly in fresh processes. Compare
normalized history, authored IDs, topology-resolution records, geometry
measurements, and evidence digests. Separate meaningful nondeterminism from
timestamps, ordering, formatting, or other normalizable representation noise.

Do not claim byte-for-byte determinism merely because two JSON strings match.

### 21.3 Serialization completeness

Round-trip every field required by the initially supported feature subset, then
edit and replay the restored history. Check IDs, parameters, expressions,
constraints, suppression/current-step behavior, persistent references, and
design-intent data. Do not expand the public serialization contract to unrelated
application managers just because `PartHistory` currently serializes them.

### 21.4 Sketch observability

Exercise valid, under-constrained, over-constrained, contradictory, and
near-degenerate sketches. Determine whether the public solver exposes stable
status, residual, and degree-of-freedom evidence. Prefer existing standalone
solver exports before modifying `PartHistory` or UI sketch code.

### 21.5 Topology-label matrix

For each initially supported feature/edit pair, compare face labels, edge
labels, adjacency, ordinals, geometric class, and authored producing roles.
Record preservation, split, merge, deletion, duplication, and symmetric
ambiguity. A prior face/edge handle may be a cache hint, never the sole identity
decision. Ambiguity must be observable so BREP-MCP can fail closed.

### 21.6 Implicit-adjustment inventory

Instrument tolerances, overlap conditioning, welding, simplification, input
removal, fallback paths, and Manifold behavior. Each implicit adjustment needed
by a supported operation must be disableable, detectable, or deterministically
reported. Do not silently change existing defaults during characterization.

## Initial supported-domain discipline

Do not characterize all of BREP at once. Begin with the smallest creation spine
needed by the architecture: deterministic rectangle/circle/polyline sketch
macros, primitive solids where useful, and extrude. Editing, topology
preservation, boolean variants, and export are admitted only after the earlier
evidence supports them.

The following are explicitly deferred from reliable v1 and should not drive
kernel changes now: arbitrary external import, sweep, loft, fillet, chamfer,
pattern, shell, draft, general constraint sketches, feature delete/reorder,
automatic reference healing, repair tools, raw BREP/mesh protocol operations,
assemblies, configurations, sheet metal, drawings, and PMI.

Existing BREP functionality in these areas is not being removed; it is simply
outside the initial BREP-MCP reliability claim.

## Acceptable BREP changes when evidence proves a gap

Examples of appropriately narrow changes include:

- an additive headless facade over existing public kernel behavior;
- structured, deterministic diagnostics instead of console-only information;
- an explicit read-only query for authored records, geometry measurements, or
  topology signatures that is useful to all kernel clients;
- a serialization option that excludes proven runtime/application state while
  preserving backward-compatible defaults;
- explicit cancellation/disposal checkpoints for expensive kernel execution;
- stable authored feature/entity IDs where generated topology is not mislabeled
  as stable;
- a test-only experiment harness that imports the built package exactly as a
  consumer does.

These are examples, not pre-approved implementation tasks. The experiment must
show the gap first.

## Changes that do not belong in BREP

- MCP request/response types or the five tool names in production source.
- Candidate, revision, tenant, authorization, idempotency, or compare-and-swap
  stores.
- Server-owned tolerance/validation policy or acceptance-contract evaluation.
- Worker pools, queues, audit logs, artifact stores, or transport cancellation.
- Automatic topology rebinding or semantic repair.
- Direct filesystem/network access for MCP exports.
- A second canonical feature model that competes with BREP-MCP's plan.

## Tests and evidence

Use focused tests named for the behavior, not for MCP. A generally useful BREP
capability should have a generally useful kernel test name.

Typical commands:

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test -- <exact_test_function_name>
pnpm test
pnpm build:kernel
```

Run fresh-process/package-consumer harnesses against `dist-kernel/` after
`pnpm build:kernel`. When browser parity matters, run the same registered test
through the browser harness. Record baseline failures separately and do not
refresh committed logs or broad goldens to hide a regression.

Success requires relevant invariants and measurements, not only a plausible
render, file existence, or lack of exceptions.

## Branching and upstream delivery

The local remotes are intentionally asymmetric:

- `upstream`: `mmiscool/BREP.io`, owner-controlled canonical repository.
- `origin`: `burhop/BREP.io`, writable integration fork.

The long-lived `integration/brep-mcp-v1` branch is a demonstration and evidence
branch in the fork. Development uses short-lived `codex/<specific-task>`
branches based on it and focused pull requests back into it.

Do not submit the integration branch wholesale to upstream. When the complete
system is ready for owner review:

1. Fetch and verify current `upstream/master`.
2. Group changes into the smallest independently useful kernel capabilities.
3. Create a clean branch from `upstream/master` for each group.
4. Cherry-pick only its source, test, and necessary documentation commits.
5. Re-run validation against the clean branch.
6. Open upstream pull requests with compatibility and BREP-MCP evidence.

This keeps internal agent guidance, experiments, and unrelated integration
history out of the owner's merge unless explicitly requested.

## Agent handoff checklist

At the end of every task, report:

- the BREP-MCP capability/experiment addressed;
- whether an existing API was sufficient;
- every production file changed and why it was unavoidable;
- tests/harnesses added and commands run;
- exact pass/fail counts and baseline failures;
- compatibility implications for serialization, topology, tolerances, runtime,
  package exports, browser behavior, and the adapter;
- the exact commit/artifact identity BREP-MCP should pin;
- unresolved uncertainty and the next smallest experiment.
