# BREP-MCP kernel support guidance

These instructions apply to the BREP-MCP integration work maintained in the
`burhop/BREP.io` fork. Read this file, `CONTRIBUTING.md`, and
`docs/developer/brep-mcp-support.md` before changing code.

## Mission

BREP-MCP is the product. This repository is its geometry-kernel dependency.
Make the smallest general-purpose BREP kernel changes needed to support a
reliable BREP-MCP adapter. Do not turn BREP into an MCP server.

Before proposing a BREP change, prove that the requirement cannot be met safely
through the existing published `brep-io-kernel` API and a BREP-MCP-side adapter.
If the public API is sufficient, make no BREP production-code change.

## Hard boundaries

- Do not add the MCP SDK, MCP tool handlers, wire schemas, server storage,
  authorization, transport, audit storage, or orchestration to BREP.
- Do not add BREP-MCP protocol concepts to production kernel types. Kernel APIs
  must remain useful to non-MCP consumers.
- Do not introduce ambient active-model state, arbitrary code execution, hidden
  geometry repair, or claims that generated topology IDs are stable.
- Do not import BREP-MCP or depend on a sibling checkout. Dependency direction
  is BREP kernel package -> BREP-MCP adapter.
- Do not broaden work into UI, editor, scene, workbench, CAM, PMI, assembly,
  sheet-metal, or rendering changes unless a recorded kernel experiment proves
  that a supported v1 capability requires it.

## Minimal-diff rules

- Prefer no change, then an adapter-only change in BREP-MCP, then a small
  additive BREP API. Modifying existing kernel behavior is the last option.
- Prefer isolated public facades, queries, diagnostics, and tests over rewrites
  of `PartHistory` or geometry internals.
- Preserve existing APIs, defaults, serialized data, feature behavior, and
  browser behavior unless the task explicitly documents a compatibility change.
- Do not reformat, rename, reorganize, modernize, or clean up unrelated code.
- Do not upgrade or add dependencies without explicit approval.
- Do not edit generated assets, build output, test logs, or unrelated goldens.
- Keep source and test commits atomic so they can be cherry-picked onto a clean
  branch based on the owner's `upstream/master`.

## Required work sequence

1. State the exact BREP-MCP capability or experiment being supported.
2. Inspect the published kernel entry point and existing behavior first.
3. Add or run a focused characterization test/harness before production edits.
4. Record whether the solution belongs in BREP-MCP or BREP, with evidence.
5. If BREP must change, define the smallest additive, headless API and its
   compatibility impact before implementing it.
6. Add regression/contract coverage and run proportionate validation.
7. Report changed files, commands, results, baseline failures, and remaining
   uncertainty. Never convert uncertainty into a success claim.

## Current priority

The next work is Phase 0 characterization, not MCP tool implementation. Focus on
the built package's real headless boundary and architecture experiments 21.1
through 21.6: `PartHistory` isolation, replay determinism, serialization
completeness, sketch observability, topology-label behavior, and implicit
geometry adjustments.

The fact that a BREP method returned without throwing is not evidence that a
model is geometrically valid, semantically correct, reference-safe,
deterministic, or editable.

## Code routing

Start with these locations, but do not assume they need modification:

- `package.json`, `src/index.ts`, and `vite.config.kernel.ts`: published package
  and build boundary.
- `src/PartHistory.ts`: feature history, replay, expressions, serialization,
  registries, scene, and managers.
- `src/FeatureRegistry.ts` and `src/features/`: feature registration/execution.
- `src/BREP/`: geometry, topology metadata, Manifold integration, and queries.
- `src/features/sketch/sketchSolver2D/`: standalone sketch solver.
- `src/exporters/`: current export implementations.
- `src/tests/tests.ts` and `src/tests/browserTests.ts`: Node/browser harnesses.

## Validation

Use the repository's existing pnpm toolchain and initialize submodules when a
fresh clone requires them.

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test -- <exact_test_function_name>
pnpm test
pnpm build:kernel
```

Run the narrowest relevant test first. Tests for kernel behavior should run in
Node and, where the same path is supported there, in the browser. Establish and
report the unmodified baseline before attributing an unrelated full-suite
failure to the current change. Never fix unrelated failures as part of an MCP
support task.

## Branch and delivery model

- `upstream/master` is the owner's canonical baseline.
- `integration/brep-mcp-v1` in `burhop/BREP.io` assembles the complete proven
  integration.
- Work on short-lived `codex/<specific-task>` branches based on the integration
  branch and merge them back through focused pull requests.
- Do not open an upstream pull request until the integrated BREP-MCP system is
  ready for owner review.
- For upstream delivery, create clean branches from current `upstream/master`
  and cherry-pick only the relevant kernel/test commits. Integration-only agent
  guidance and unrelated history should not be included unless requested.

## Definition of done

A BREP support change is done only when it is evidence-driven, general-purpose,
additive where practical, covered by focused tests, validated in the applicable
runtimes, documented in the compatibility record, free of unrelated diffs, and
small enough for the BREP owner to review independently.
