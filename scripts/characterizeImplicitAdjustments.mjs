import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const RESULT_PREFIX = 'PHASE0_IMPLICIT_ADJUSTMENTS_RESULT ';
const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const repoRoot = resolve(scriptDir, '..');

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function sha256(value) {
  const content = typeof value === 'string' || ArrayBuffer.isView(value)
    ? value
    : JSON.stringify(canonicalize(value));
  return createHash('sha256').update(content).digest('hex');
}

function roundNumber(value) {
  return Number(Number(value).toPrecision(12));
}

function point(id, x, y) {
  return { id, x, y, fixed: false, construction: false, externalReference: false };
}

function rectangleSketch() {
  return {
    points: [
      point(0, 0, 0),
      point(1, 2, 2),
      point(2, 8, 2),
      point(3, 8, 2),
      point(4, 8, 8),
      point(5, 8, 8),
      point(6, 2, 8),
      point(7, 2, 8),
      point(8, 2, 2),
    ],
    geometries: [
      { id: 1, type: 'line', points: [1, 2], construction: false },
      { id: 2, type: 'line', points: [3, 4], construction: false },
      { id: 3, type: 'line', points: [5, 6], construction: false },
      { id: 4, type: 'line', points: [7, 8], construction: false },
    ],
    constraints: [
      { id: 0, type: '⏚', points: [0] },
      { id: 1, type: '≡', points: [2, 3] },
      { id: 2, type: '≡', points: [4, 5] },
      { id: 3, type: '≡', points: [6, 7] },
      { id: 4, type: '≡', points: [8, 1] },
    ],
  };
}

function splitFirstEdge(sketch) {
  const first = sketch.geometries.find((entry) => entry.id === 1);
  first.points = [1, 9];
  sketch.points.push(point(9, 5, 2), point(10, 5, 2));
  sketch.geometries.splice(1, 0, {
    id: 5,
    type: 'line',
    points: [10, 2],
    construction: false,
  });
  sketch.constraints.push({ id: 5, type: '≡', points: [9, 10] });
}

function duplicateFirstEdge(sketch) {
  const first = sketch.geometries.find((entry) => entry.id === 1);
  sketch.geometries.splice(1, 0, { ...structuredClone(first), id: 5 });
}

async function createExtrudeHistory(kernel, operation = 'NONE', sketchMutation = null) {
  const history = new kernel.PartHistory();
  const sketch = await history.newFeature('S');
  Object.assign(sketch.inputParams, { id: 'S1', sketchPlane: null, curveResolution: 32 });
  const data = rectangleSketch();
  sketchMutation?.(data);
  sketch.persistentData = { sketch: data };
  const extrude = await history.newFeature('E');
  Object.assign(extrude.inputParams, {
    id: 'E2',
    profile: 'S1:PROFILE',
    consumeProfileSketch: true,
    distance: 5,
    distanceBack: 0,
    boolean: { targets: [], operation, overlapConditioningEnabled: false },
  });
  return history;
}

function measureSolid(solid, kernel) {
  if (!solid || String(solid.type).toUpperCase() !== 'SOLID') return null;
  solid.updateMatrixWorld?.(true);
  const bounds = new kernel.BREP.THREE.Box3().setFromObject(solid);
  const boundsEmpty = bounds.isEmpty();
  const min = boundsEmpty ? null : bounds.min.toArray().map(roundNumber);
  const max = boundsEmpty ? null : bounds.max.toArray().map(roundNumber);
  return canonicalize({
    name: solid.name,
    bounds: { min, max },
    extents: boundsEmpty
      ? null
      : max.map((value, index) => roundNumber(value - min[index])),
    faceNames: [...solid.getFaceNames()].sort(),
    faceCount: solid.getFaceNames().length,
    volume: roundNumber(solid.volume()),
    surfaceArea: roundNumber(solid.surfaceArea()),
    triangleCount: solid.getTriangleCount(),
  });
}

function diagnosticKeys(value, path = '$', depth = 0, output = []) {
  if (!value || typeof value !== 'object' || depth > 3) return output;
  for (const key of Object.keys(value).sort()) {
    const next = `${path}.${key}`;
    if (/adjust|condition|diagnostic|fallback|nudge|repair|simplif|weld/i.test(key)) {
      output.push(next);
    }
    const entry = value[key];
    if (entry && typeof entry === 'object' && !ArrayBuffer.isView(entry)) {
      diagnosticKeys(entry, next, depth + 1, output);
    }
  }
  return [...new Set(output)].sort();
}

async function extrudeCase(kernel, operation, mutation = null) {
  const history = await createExtrudeHistory(kernel, operation, mutation);
  let error = null;
  try {
    await history.runHistory({ throwOnFeatureError: true });
  } catch (caught) {
    error = String(caught?.message || caught).split(/\r?\n/, 1)[0];
  }
  const solid = history.getObjectByName('E2');
  const serialized = JSON.parse(await history.toJSON());
  return canonicalize({
    error,
    measurement: measureSolid(solid, kernel),
    structuredDiagnosticKeys: diagnosticKeys({ solid, serialized }),
  });
}

async function booleanRemovalCase(kernel) {
  const history = new kernel.PartHistory();
  const target = await history.newFeature('P.CU');
  Object.assign(target.inputParams, {
    id: 'C1',
    sizeX: 10,
    sizeY: 10,
    sizeZ: 10,
    boolean: { targets: [], operation: 'NONE' },
  });
  const tool = await history.newFeature('P.CU');
  Object.assign(tool.inputParams, {
    id: 'C2',
    sizeX: 10,
    sizeY: 10,
    sizeZ: 10,
    transform: {
      position: [5, 0, 0],
      rotationEuler: [0, 0, 0],
      scale: [1, 1, 1],
    },
    boolean: {
      targets: ['C1'],
      operation: 'UNION',
      overlapConditioningEnabled: false,
    },
  });
  await history.runHistory({ throwOnFeatureError: true });
  const solids = history.scene.children.filter((entry) => entry.type === 'SOLID');
  const serialized = JSON.parse(await history.toJSON());
  return canonicalize({
    sceneSolidNames: solids.map((entry) => entry.name).sort(),
    targetResolves: !!history.getObjectByName('C1'),
    toolResolves: !!history.getObjectByName('C2'),
    authoredFeatureIds: serialized.features.map((entry) => entry.inputParams?.id).filter(Boolean),
    result: measureSolid(solids[0], kernel),
    structuredDiagnosticKeys: diagnosticKeys({ solids, serialized }),
  });
}

function stringLog(args) {
  return args.map((entry) => {
    if (typeof entry === 'string') return entry;
    try { return JSON.stringify(canonicalize(entry)); } catch { return String(entry); }
  }).join(' ');
}

async function directBooleanCase(kernel, mode) {
  const base = new kernel.BREP.Cube({ x: 10, y: 10, z: 10, name: 'BASE' });
  const tool = new kernel.BREP.Cube({ x: 6, y: 6, z: 6, name: 'TOOL' });
  tool.bakeTRS({
    position: [7, 2, 2],
    rotationEuler: [0, 0, 0],
    scale: [1, 1, 1],
  });
  const cleanupCalls = [];
  const solidPrototype = kernel.BREP.Solid.prototype;
  const originalCleanup = solidPrototype.cleanupTinyFaceIslands;
  if (typeof originalCleanup === 'function') {
    solidPrototype.cleanupTinyFaceIslands = async function instrumentedCleanup(maxArea) {
      cleanupCalls.push(roundNumber(maxArea));
      return await originalCleanup.call(this, maxArea);
    };
  }

  if (mode === 'forced_union_fallback') base.union = () => {
    throw new Error('phase0 forced primary union failure');
  };
  if (mode === 'forced_subtract_passthrough') {
    base.subtract = () => { throw new Error('phase0 forced subtract failure'); };
    base.clone = () => base;
    tool.clone = () => tool;
  }
  const operation = mode === 'forced_subtract_passthrough'
    ? 'SUBTRACT'
    : mode === 'unknown_operation' ? 'PHASE0_UNKNOWN' : 'UNION';
  const baseSolid = operation === 'SUBTRACT' ? tool : base;
  const targets = operation === 'SUBTRACT' ? [base] : [tool];
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(stringLog(args));
  let effects;
  let error = null;
  try {
    effects = await kernel.BREP.applyBooleanOperation(
      { scene: { getObjectByName() { return null; } } },
      baseSolid,
      { operation, targets, overlapConditioningEnabled: false },
      'PHASE0_BOOLEAN',
    );
  } catch (caught) {
    error = String(caught?.message || caught).split(/\r?\n/, 1)[0];
  } finally {
    console.log = originalLog;
    if (typeof originalCleanup === 'function') {
      solidPrototype.cleanupTinyFaceIslands = originalCleanup;
    }
  }
  const result = effects?.added?.[0] || null;
  try { result?.visualize?.(); } catch { /* measurement remains independently guarded */ }
  return canonicalize({
    error,
    effectKeys: effects ? Object.keys(effects).sort() : [],
    addedCount: effects?.added?.length || 0,
    removedCount: effects?.removed?.length || 0,
    resultIsOriginalBase: result === base,
    resultIsOriginalTool: result === tool,
    result: measureSolid(result, kernel),
    cleanupCalls,
    debugEvents: logs.filter((line) => /BooleanDebug/.test(line)),
    structuredDiagnosticKeys: diagnosticKeys({ effects, result }),
  });
}

function evaluateCase(caseName, observation) {
  if (caseName === 'extrude_none') {
    return observation.error === null
      && observation.measurement?.extents.includes(5)
      && observation.measurement?.volume === 180;
  }
  if (caseName === 'extrude_union_no_targets' || caseName === 'extrude_subtract_no_targets') {
    return observation.error === null
      && observation.measurement?.extents.some((value) => Math.abs(value - 5.00001) < 1e-7)
      && observation.structuredDiagnosticKeys.length === 0;
  }
  if (caseName === 'collinear_split') {
    return observation.error === null
      && observation.measurement?.faceNames.includes('E2:S1:PROFILE_SW')
      && !observation.measurement?.faceNames.includes('E2:S1:G1_SW')
      && observation.measurement?.volume === 180;
  }
  if (caseName === 'duplicate_edge') {
    return observation.error === null
      && observation.measurement?.faceCount === 0
      && observation.measurement?.volume === 0;
  }
  if (caseName === 'boolean_input_removal') {
    return observation.sceneSolidNames.length === 1
      && observation.sceneSolidNames[0] === 'C1'
      && observation.targetResolves
      && !observation.toolResolves
      && observation.authoredFeatureIds.join(',') === 'C1,C2';
  }
  if (caseName === 'forced_union_fallback') {
    return observation.error === null
      && observation.addedCount === 1
      && observation.debugEvents.some((line) => /fallback/i.test(line))
      && observation.cleanupCalls.includes(0.001)
      && observation.structuredDiagnosticKeys.length === 0;
  }
  if (caseName === 'forced_subtract_passthrough') {
    return observation.error === null
      && observation.resultIsOriginalBase
      && observation.debugEvents.some((line) => /passing target through/i.test(line))
      && observation.structuredDiagnosticKeys.length === 0;
  }
  if (caseName === 'unknown_operation') {
    return observation.error === null
      && observation.resultIsOriginalBase
      && observation.removedCount === 0
      && observation.structuredDiagnosticKeys.length === 0;
  }
  return false;
}

async function runCase(kernel, caseName) {
  let observation;
  if (caseName === 'extrude_none') observation = await extrudeCase(kernel, 'NONE');
  else if (caseName === 'extrude_union_no_targets') observation = await extrudeCase(kernel, 'UNION');
  else if (caseName === 'extrude_subtract_no_targets') {
    observation = await extrudeCase(kernel, 'SUBTRACT');
  } else if (caseName === 'collinear_split') {
    observation = await extrudeCase(kernel, 'NONE', splitFirstEdge);
  } else if (caseName === 'duplicate_edge') {
    observation = await extrudeCase(kernel, 'NONE', duplicateFirstEdge);
  } else if (caseName === 'boolean_input_removal') {
    observation = await booleanRemovalCase(kernel);
  } else {
    observation = await directBooleanCase(kernel, caseName);
  }
  return canonicalize({
    caseName,
    observation,
    pass: evaluateCase(caseName, observation),
  });
}

async function workerMain(args) {
  const [caseName] = args;
  const kernel = await import('brep-io-kernel');
  const result = await runCase(kernel, caseName);
  console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
}

function parseRepetitions(args) {
  const index = args.indexOf('--repetitions');
  if (index < 0) return 3;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 2) {
    throw new Error('--repetitions must be an integer of at least 2.');
  }
  return value;
}

async function digestTree(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }
  await visit(root);
  files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(root, file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return { digest: hash.digest('hex'), fileCount: files.length };
}

async function spawnWorker(workerPath, consumerRoot, caseName) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [workerPath, '--worker', caseName], {
      cwd: consumerRoot,
      env: { ...process.env, DEBUG_BOOLEAN: '*' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let result = null;
    let forcedTermination = false;
    let graceTimer = null;
    const hardTimer = setTimeout(() => {
      forcedTermination = true;
      child.kill();
    }, 60_000);
    const findResult = () => {
      if (result) return;
      const marker = stdout.lastIndexOf(RESULT_PREFIX);
      if (marker < 0) return;
      const line = stdout.slice(marker + RESULT_PREFIX.length).split(/\r?\n/, 1)[0];
      try {
        result = JSON.parse(line);
        graceTimer = setTimeout(() => {
          forcedTermination = true;
          child.kill();
        }, 250);
      } catch {
        // Wait for a complete marker line.
      }
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      findResult();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      findResult();
      if (!result) {
        reject(new Error(
          `Adjustment worker produced no result (code=${code}, signal=${signal}).\n${stderr}\n${stdout}`,
        ));
        return;
      }
      resolvePromise({ result, naturalExit: !forcedTermination && code === 0 });
    });
  });
}

async function controllerMain(args) {
  const repetitions = parseRepetitions(args);
  const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const packageEntry = packageJson.exports['.'];
  const entryPath = resolve(repoRoot, packageEntry);
  const entryStats = await stat(entryPath);
  const entryDigest = sha256(await readFile(entryPath));
  const distDigest = await digestTree(join(repoRoot, 'dist-kernel'));
  const tempRoot = await mkdtemp(join(tmpdir(), 'brep-phase0-implicit-adjustments-'));
  try {
    const consumerRoot = join(tempRoot, 'consumer');
    const nodeModules = join(consumerRoot, 'node_modules');
    const workerPath = join(consumerRoot, 'implicitAdjustmentsWorker.mjs');
    await mkdir(nodeModules, { recursive: true });
    await symlink(
      repoRoot,
      join(nodeModules, packageJson.name),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await copyFile(scriptPath, workerPath);
    const caseNames = [
      'extrude_none',
      'extrude_union_no_targets',
      'extrude_subtract_no_targets',
      'collinear_split',
      'duplicate_edge',
      'boolean_input_removal',
      'forced_union_fallback',
      'forced_subtract_passthrough',
      'unknown_operation',
    ];
    const runs = [];
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const ordered = repetition % 2 === 0 ? caseNames : [...caseNames].reverse();
      for (const caseName of ordered) {
        runs.push(await spawnWorker(workerPath, consumerRoot, caseName));
      }
    }
    const grouped = Object.fromEntries(caseNames.map((caseName) => {
      const results = runs.filter((run) => run.result.caseName === caseName);
      const digests = new Set(results.map((run) => sha256(run.result)));
      return [caseName, {
        pass: results.every((run) => run.result.pass) && digests.size === 1,
        repetitions: results.length,
        digestCount: digests.size,
        digest: sha256(results[0].result),
        result: results[0].result,
      }];
    }));
    const summary = canonicalize({
      pass: Object.values(grouped).every((entry) => entry.pass),
      repetitions,
      freshProcesses: runs.length,
      caseExecutions: runs.length,
      forwardCaseOrderRuns: Math.ceil(repetitions / 2),
      reverseCaseOrderRuns: Math.floor(repetitions / 2),
      package: {
        name: packageJson.name,
        version: packageJson.version,
        exportTarget: packageEntry,
        entryByteLength: entryStats.size,
        entrySha256: entryDigest,
        distKernelFileCount: distDigest.fileCount,
        distKernelSha256: distDigest.digest,
      },
      lifecycle: {
        naturalExitCount: runs.filter((run) => run.naturalExit).length,
        forcedTerminationCount: runs.filter((run) => !run.naturalExit).length,
      },
      cases: grouped,
    });
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.pass) process.exitCode = 1;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args[0] === '--worker') await workerMain(args.slice(1));
else await controllerMain(args);
