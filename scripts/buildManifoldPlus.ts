import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { spawnSync } from "child_process";
import os from "os";
import {
  createEmscriptenCommandPlan,
  formatProbeAttempts,
  getCmakeCandidates,
  getPythonCandidates,
  selectFirstWorkingCommand,
} from "./buildManifoldPlusTools.js";

const rootDir = process.cwd();
const sourceDir = path.join(rootDir, "manifold-plus");
const buildDir = path.join(sourceDir, "build");
const distDir = path.join(sourceDir, "dist");
const isWindows = process.platform === "win32";
const emsdkDir = process.env.EMSDK || path.join(rootDir, "vendor", "emsdk");
const emsdkLauncher = path.join(emsdkDir, isWindows ? "emsdk.bat" : "emsdk");
const emsdkEnvScript = path.join(emsdkDir, isWindows ? "emsdk_env.bat" : "emsdk_env.sh");
const emsdkVersion = "3.1.64";
const emCacheDir = path.join(rootDir, ".emscripten_cache");
const cmakeVenvDir = path.join(os.homedir(), ".cache", "brep-tools", "cmake-venv");
const cmakeBinDir = isWindows
  ? path.join(cmakeVenvDir, "Scripts")
  : path.join(cmakeVenvDir, "bin");
const cmakeBinary = isWindows
  ? path.join(cmakeBinDir, "cmake.exe")
  : path.join(cmakeBinDir, "cmake");
const cmakeVenvPython = isWindows
  ? path.join(cmakeBinDir, "python.exe")
  : path.join(cmakeBinDir, "python");
let selectedPython = null;

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.error?.code === "ENOENT") {
    if (command === "emcmake" || command === "emcc" || command === "cmake") {
      throw new Error(
        `Missing required command '${command}'. Install/activate Emscripten so emcmake/emcc are available, or install EMSDK at '${emsdkDir}'.`
      );
    }
    throw new Error(`Missing required command '${command}'.`);
  }

  if (result.status !== 0) {
    const commandText = [command, ...args].join(" ");
    throw new Error(`Command failed: ${commandText}`);
  }
};

const prependToPath = (dir) => {
  const currentPath = process.env.PATH || "";
  const segments = currentPath.split(path.delimiter).filter(Boolean);
  if (segments.includes(dir)) return;
  process.env.PATH = [dir, ...segments].join(path.delimiter);
};

const summarizeProbeFailure = (result) => {
  if (result.error?.code === "ENOENT") return "not found";
  if (result.error) return result.error.message;
  const output = `${result.stderr || ""}\n${result.stdout || ""}`.trim().replaceAll(/\s+/g, " ");
  const status = result.status == null ? "no exit status" : `exit ${result.status}`;
  return output ? `${status}: ${output.slice(0, 240)}` : status;
};

const probeCandidate = (candidate, args) => {
  const result = spawnSync(candidate.command, [...candidate.args, ...args], {
    cwd: rootDir,
    encoding: "utf8",
    shell: false,
  });

  if (result.status !== 0) {
    return { ok: false, detail: summarizeProbeFailure(result) };
  }

  const output = String(result.stdout || "").trim();
  return {
    ok: true,
    detail: output.split(/\r?\n/, 1)[0] || "runnable",
    output,
  };
};

const discoverPython = (priorAttempts = []) => {
  if (selectedPython) return selectedPython;

  const discovery = selectFirstWorkingCommand(
    getPythonCandidates(process.platform),
    (candidate) => {
      const result = probeCandidate(candidate, [
        "-c",
        "import platform, sys; print(sys.executable); print(platform.python_version())",
      ]);
      if (!result.ok) return result;
      const [executable, version] = result.output.split(/\r?\n/);
      if (!executable || !version) {
        return { ok: false, detail: "probe returned incomplete interpreter details" };
      }
      return {
        ok: true,
        detail: `Python ${version} at ${executable}`,
        output: executable,
      };
    }
  );

  if (!discovery.selected) {
    throw new Error(
      [
        "No usable Python 3 interpreter was found.",
        "Attempted CMake/Python options:",
        formatProbeAttempts([...priorAttempts, ...discovery.attempts]),
      ].join("\n")
    );
  }

  const selectedAttempt = discovery.attempts.at(-1);
  selectedPython = {
    candidate: discovery.selected,
    executable: selectedAttempt?.output,
    detail: selectedAttempt?.detail,
    attempts: discovery.attempts,
  };
  if (selectedPython.executable) {
    prependToPath(path.dirname(selectedPython.executable));
  }
  console.log(
    `[build:manifoldPlus] Using Python '${selectedPython.executable}' via '${selectedPython.candidate.label}'.`
  );
  return selectedPython;
};

const ensureSubmodules = () => {
  const paths = ["vendor/manifold3d"];
  if (!process.env.EMSDK) paths.push("vendor/emsdk");
  run("git", ["submodule", "update", "--init", "--recursive", "--", ...paths]);
};

const runWithEmscripten = (command, args) => {
  const plan = createEmscriptenCommandPlan({
    platform: process.platform,
    rootDir,
    emsdkDir,
    emsdkLauncher,
    emsdkEnvScript,
    emsdkVersion,
    emCacheDir,
    command,
    args,
    commandInterpreter: isWindows ? process.env.ComSpec || "cmd.exe" : undefined,
  });
  run(plan.command, plan.args);
};

const runEmscriptenCommand = (command, args) => {
  const missingEmsdkFiles = [emsdkLauncher, emsdkEnvScript].filter((file) => !existsSync(file));
  if (missingEmsdkFiles.length > 0) {
    const location = process.env.EMSDK ? emsdkDir : path.relative(rootDir, emsdkDir);
    throw new Error(
      `EMSDK checkout at '${location}' is missing: ${missingEmsdkFiles.join(", ")}. Run 'git submodule update --init --recursive' and retry.`
    );
  }

  runWithEmscripten(command, args);
};

const ensureCmakeAvailable = () => {
  const cmakeDiscovery = selectFirstWorkingCommand(
    getCmakeCandidates(cmakeBinary),
    (candidate) => probeCandidate(candidate, ["--version"])
  );
  if (cmakeDiscovery.selected) {
    if (cmakeDiscovery.selected.command === cmakeBinary) {
      prependToPath(cmakeBinDir);
    }
    const selectedAttempt = cmakeDiscovery.attempts.at(-1);
    console.log(
      `[build:manifoldPlus] Using ${selectedAttempt?.detail || cmakeDiscovery.selected.label}.`
    );
    return;
  }

  const python = discoverPython(cmakeDiscovery.attempts);
  try {
    run(python.candidate.command, [
      ...python.candidate.args,
      "-m",
      "venv",
      cmakeVenvDir,
    ]);
    run(cmakeVenvPython, ["-m", "pip", "install", "--quiet", "cmake"]);
    prependToPath(cmakeBinDir);
  } catch (error) {
    throw new Error(
      [
        error?.message || error,
        "Attempted CMake/Python options:",
        formatProbeAttempts([...cmakeDiscovery.attempts, ...python.attempts]),
      ].join("\n")
    );
  }

  const venvProbe = probeCandidate(
    { command: cmakeBinary, args: [], label: `bootstrapped cmake (${cmakeBinary})` },
    ["--version"]
  );
  if (!venvProbe.ok) {
    throw new Error(
      [
        "Bootstrapped the CMake virtual environment, but its cmake executable is not runnable.",
        "Attempted CMake/Python options:",
        formatProbeAttempts([
          ...cmakeDiscovery.attempts,
          ...python.attempts,
          {
            candidate: {
              command: cmakeBinary,
              args: [],
              label: `bootstrapped cmake (${cmakeBinary})`,
            },
            ...venvProbe,
          },
        ]),
      ].join("\n")
    );
  }
  console.log(`[build:manifoldPlus] Using ${venvProbe.detail}.`);
};

const resolveBuiltArtifact = (buildDir, filename) => {
  const candidates = [
    path.join(buildDir, "vendor", "manifold3d", "bindings", "wasm", filename),
    path.join(buildDir, "bindings", "wasm", filename),
    path.join(buildDir, filename),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

const applyBrowserEmbindDestructorGuard = (jsPath) => {
  const source = readFileSync(jsPath, "utf8");
  const original =
    "runDestructors=destructors=>{while(destructors.length){var ptr=destructors.pop();var del=destructors.pop();del(ptr)}};";
  const replacement =
    "runDestructors=destructors=>{if(!destructors)return;while(destructors.length){var ptr=destructors.pop();var del=destructors.pop();del(ptr)}};";
  if (!source.includes(original)) return;
  writeFileSync(jsPath, source.replace(original, replacement));
};

try {
  ensureSubmodules();

  if (!existsSync(path.join(rootDir, "vendor", "manifold3d", "CMakeLists.txt"))) {
    throw new Error(
      "Missing manifold3d submodule after automatic initialization."
    );
  }

  ensureCmakeAvailable();
  if (isWindows) {
    discoverPython();
  }
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(emCacheDir, { recursive: true });
  console.log(
    `[build:manifoldPlus] Using EMSDK '${emsdkDir}' with Emscripten ${emsdkVersion}.`
  );

  runEmscriptenCommand("emcmake", [
    "cmake",
    "-S",
    sourceDir,
    "-B",
    buildDir,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DMANIFOLD_PAR=OFF",
    "-DMANIFOLD_USE_BUILTIN_TBB=ON",
    "-DMANIFOLD_DEBUG=OFF",
    "-DMANIFOLD_ASSERT=OFF",
  ]);

  runEmscriptenCommand("cmake", ["--build", buildDir, "--target", "manifoldjs"]);

  const builtJsPath = resolveBuiltArtifact(buildDir, "manifold.js");
  const builtWasmPath = resolveBuiltArtifact(buildDir, "manifold.wasm");
  if (!builtJsPath || !builtWasmPath) {
    throw new Error("Expected manifold.js and manifold.wasm were not produced.");
  }

  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });
  const distJsPath = path.join(distDir, "manifold.js");
  cpSync(builtJsPath, distJsPath, { force: true });
  cpSync(builtWasmPath, path.join(distDir, "manifold.wasm"), { force: true });
  applyBrowserEmbindDestructorGuard(distJsPath);

  console.log(`[build:manifoldPlus] Wrote ${path.relative(rootDir, distDir)}/manifold.js`);
  console.log(`[build:manifoldPlus] Wrote ${path.relative(rootDir, distDir)}/manifold.wasm`);
} catch (error) {
  console.error("[build:manifoldPlus] Failed.");
  console.error(error?.message ?? error);
  process.exit(1);
}
