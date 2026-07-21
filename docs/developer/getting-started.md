# Getting Started

Prerequisites: Node.js 18 or newer and `pnpm` installed.

- Install dependencies: `pnpm install`
- Run the Vite dev server: `pnpm dev`
  - Open the printed URL, usually `http://localhost:5173`
- Run tests: `pnpm test`
  - Run one test: `pnpm test -- test_primitiveCube`
- Live testing while editing (Node): `pnpm liveTesting`

## Windows local compiler bootstrap

The visible browser application builds the local Manifold WebAssembly bundle
before Vite starts. On Windows, the build scripts:

1. use a runnable `cmake` from `PATH`, or a previously bootstrapped copy under
   `%USERPROFILE%\.cache\brep-tools\cmake-venv`;
2. otherwise find Python 3 by trying `python3`, `python`, then `py -3`, rejecting
   non-runnable command aliases, and install CMake into that same tool cache;
3. install and activate the pinned SDK from `vendor/emsdk` (or the directory in
   `EMSDK`) and run compiler commands through `emsdk_env.bat`.

The repository submodules, Node.js, pnpm, Git, and a real Python 3 installation
remain prerequisites. A separate CMake installation and Bash are not required.
The cache, `manifold-plus/dist`, `manifold-plus/build`, `.emscripten_cache`, and
`dist-kernel` are local/generated state and must not be committed.

This changes development-tool startup only. It does not change the published
kernel API, geometry, feature execution, serialization, topology, tolerances,
browser UI, or BREP-MCP protocol boundaries.

See [Testing](./testing.md) for test runner details and single-test selection.

## API Demos
- Demo hub: [https://BREP.io/apiExamples/index.html](https://BREP.io/apiExamples/index.html)
- Full demo list + source links: [API Examples](./embedding/api-examples.md)
