import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmscriptenCommandPlan,
  formatProbeAttempts,
  getCmakeCandidates,
  getNinjaCandidates,
  getPythonCandidates,
  selectFirstWorkingCommand,
} from "./buildManifoldPlusTools.js";

test("Windows Python discovery uses portable launcher order", () => {
  assert.deepEqual(
    getPythonCandidates("win32").map(({ label }) => label),
    ["python3", "python", "py -3"]
  );
  assert.deepEqual(
    getPythonCandidates("linux").map(({ label }) => label),
    ["python3", "python"]
  );
});

test("command discovery rejects a failed Store placeholder and selects real Python", () => {
  const candidates = getPythonCandidates("win32");
  const discovery = selectFirstWorkingCommand(candidates, ({ label }) => {
    if (label === "python3") {
      return { ok: false, detail: "exit 9009: Microsoft Store alias" };
    }
    return { ok: true, detail: "Python 3.13.5", output: "C:\\Python313\\python.exe" };
  });

  assert.equal(discovery.selected?.label, "python");
  assert.deepEqual(
    discovery.attempts.map(({ candidate }) => candidate.label),
    ["python3", "python"]
  );
});

test("Windows Python discovery falls back to py -3", () => {
  const discovery = selectFirstWorkingCommand(getPythonCandidates("win32"), ({ label }) => ({
    ok: label === "py -3",
    detail: label === "py -3" ? "Python 3.13.5" : "not runnable",
  }));

  assert.equal(discovery.selected?.command, "py");
  assert.deepEqual(discovery.selected?.args, ["-3"]);
});

test("failed discovery diagnostics include every attempted build-tool and Python option", () => {
  const cmake = selectFirstWorkingCommand(
    getCmakeCandidates("C:\\tools\\cmake-venv\\Scripts\\cmake.exe"),
    () => ({ ok: false, detail: "not runnable" })
  );
  const python = selectFirstWorkingCommand(getPythonCandidates("win32"), () => ({
    ok: false,
    detail: "not runnable",
  }));
  const ninja = selectFirstWorkingCommand(
    getNinjaCandidates("C:\\tools\\cmake-venv\\Scripts\\ninja.exe"),
    () => ({ ok: false, detail: "not runnable" })
  );
  const diagnostics = formatProbeAttempts([
    ...cmake.attempts,
    ...ninja.attempts,
    ...python.attempts,
  ]);

  for (const option of [
    "cmake on PATH",
    "cached cmake",
    "ninja on PATH",
    "cached ninja",
    "python3",
    "python",
    "py -3",
  ]) {
    assert.ok(diagnostics.includes(option), `missing diagnostic for ${option}`);
  }
});

test("Windows EMSDK plan activates the batch environment before invoking emcmake", () => {
  const plan = createEmscriptenCommandPlan({
    platform: "win32",
    rootDir: "C:\\work tree\\BREP",
    emsdkDir: "C:\\work tree\\BREP\\vendor\\emsdk",
    emsdkLauncher: "C:\\work tree\\BREP\\vendor\\emsdk\\emsdk.bat",
    emsdkEnvScript: "C:\\work tree\\BREP\\vendor\\emsdk\\emsdk_env.bat",
    emsdkVersion: "3.1.64",
    emCacheDir: "C:\\work tree\\BREP\\.emscripten_cache",
    command: "emcmake",
    args: ["cmake", "-S", "C:\\work tree\\BREP\\manifold-plus"],
    commandInterpreter: "C:\\Windows\\System32\\cmd.exe",
  });
  const commandText = plan.args.at(-1) || "";

  assert.equal(plan.command, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(plan.windowsVerbatimArguments, true);
  assert.ok(commandText.includes('set "EMSDK_QUIET=1"'));
  assert.ok(commandText.includes("emsdk.bat\" install 3.1.64"));
  assert.ok(commandText.includes("emsdk.bat\" activate 3.1.64"));
  assert.ok(commandText.includes("emsdk_env.bat\" >nul"));
  assert.ok(commandText.includes('set "EM_CACHE=C:\\work tree\\BREP\\.emscripten_cache"'));
  assert.ok(commandText.includes('cd /d "C:\\work tree\\BREP"'));
  assert.ok(commandText.includes('call emcmake cmake -S "C:\\work tree\\BREP\\manifold-plus"'));
  assert.ok(commandText.indexOf("emsdk_env.bat") < commandText.indexOf("call emcmake"));
});

test("Unix EMSDK plan retains bash activation behavior", () => {
  const plan = createEmscriptenCommandPlan({
    platform: "linux",
    rootDir: "/work/BREP",
    emsdkDir: "/work/BREP/vendor/emsdk",
    emsdkLauncher: "/work/BREP/vendor/emsdk/emsdk",
    emsdkEnvScript: "/work/BREP/vendor/emsdk/emsdk_env.sh",
    emsdkVersion: "3.1.64",
    emCacheDir: "/work/BREP/.emscripten_cache",
    command: "cmake",
    args: ["--build", "/work/BREP/manifold-plus/build"],
  });
  const commandText = plan.args.at(-1) || "";

  assert.equal(plan.command, "bash");
  assert.ok(commandText.includes("source '/work/BREP/vendor/emsdk/emsdk_env.sh'"));
  assert.ok(commandText.includes("'cmake' '--build' '/work/BREP/manifold-plus/build'"));
});
