import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
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

const RESULT_PREFIX = 'PHASE0_SCALE_TOLERANCE_RESULT ';
const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const repoRoot = resolve(scriptDir, '..');

const numericProfile = Object.freeze({
  profileId: 'numeric-v1/default-provisional',
  coordinateEnvelopeMm: 1_000_000,
  modelingMm: 0.00001,
  comparisonAbsoluteMm: 0.0001,
  comparisonRelative: 0.000001,
  tinyAreaMm2: 1e-8,
  tinyVolumeMm3: 1e-10,
});

const fidelityRelativeLimit = 0.01;
const matrixOrigins = [0, 100, 1_000, 10_000, 100_000, 1_000_000];
const matrixSizes = [0.00001, 0.0001, 0.001, 0.01, 0.1, 1];

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
  if (!Number.isFinite(value)) return value;
  return Number(value.toPrecision(15));
}

function point(id, x, y) {
  return { id, x, y, fixed: false, construction: false, externalReference: false };
}

function rectangleSketch(origin, size) {
  const x0 = origin;
  const y0 = -origin / 2;
  const x1 = x0 + size;
  const y1 = y0 + 2 * size;
  return {
    points: [
      point(0, 0, 0),
      point(1, x0, y0),
      point(2, x1, y0),
      point(3, x1, y0),
      point(4, x1, y1),
      point(5, x1, y1),
      point(6, x0, y1),
      point(7, x0, y1),
      point(8, x0, y0),
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

function caseKey(caseDefinition) {
  return `${caseDefinition.kind}:origin=${caseDefinition.origin}:size=${caseDefinition.size}`;
}

function buildCases() {
  const cases = [];
  for (const origin of matrixOrigins) {
    for (const size of matrixSizes) cases.push({ kind: 'cube', origin, size });
  }
  for (const size of [10, 1_000, 1_000_000]) {
    cases.push({ kind: 'cube', origin: 0, size });
  }
  cases.push(
    { kind: 'extrude', origin: 0, size: 0.00001 },
    { kind: 'extrude', origin: 0, size: 0.0001 },
    { kind: 'extrude', origin: 0, size: 0.001 },
    { kind: 'extrude', origin: 100, size: 0.001 },
    { kind: 'extrude', origin: 1_000, size: 0.001 },
    { kind: 'extrude', origin: 1_000, size: 0.01 },
    { kind: 'extrude', origin: 10_000, size: 0.1 },
    { kind: 'extrude', origin: 100_000, size: 1 },
    { kind: 'extrude', origin: 1_000_000, size: 1 },
  );
  return cases;
}

async function createHistory(kernel, caseDefinition) {
  const { kind, origin, size } = caseDefinition;
  const history = new kernel.PartHistory();
  if (kind === 'cube') {
    const cube = await history.newFeature('P.CU');
    Object.assign(cube.inputParams, {
      id: 'C1',
      sizeX: size,
      sizeY: 2 * size,
      sizeZ: 3 * size,
      transform: {
        position: [origin, -origin / 2, origin / 4],
        rotationEuler: [0, 0, 0],
        scale: [1, 1, 1],
      },
      boolean: { targets: [], operation: 'NONE' },
    });
    return { history, solidName: 'C1' };
  }

  const sketch = await history.newFeature('S');
  Object.assign(sketch.inputParams, { id: 'S1', sketchPlane: null, curveResolution: 32 });
  sketch.persistentData = { sketch: rectangleSketch(origin, size) };
  const extrude = await history.newFeature('E');
  Object.assign(extrude.inputParams, {
    id: 'E2',
    profile: 'S1:PROFILE',
    consumeProfileSketch: true,
    distance: 3 * size,
    distanceBack: 0,
    boolean: { targets: [], operation: 'NONE', overlapConditioningEnabled: false },
  });
  return { history, solidName: 'E2' };
}

function expectedMeasurement(caseDefinition) {
  const { kind, origin, size } = caseDefinition;
  const min = kind === 'cube'
    ? [origin, -origin / 2, origin / 4]
    : [origin, -origin / 2, -3 * size];
  const extents = [size, 2 * size, 3 * size];
  return {
    min,
    max: kind === 'cube'
      ? min.map((entry, index) => entry + extents[index])
      : [origin + size, -origin / 2 + 2 * size, 0],
    extents,
    volume: 6 * size ** 3,
    surfaceArea: 22 * size ** 2,
    faceCount: 6,
    triangleCount: 12,
  };
}

function attempt(callback) {
  try {
    return { value: callback(), error: null };
  } catch (error) {
    return { value: null, error: String(error?.message || error).split(/\r?\n/, 1)[0] };
  }
}

function measureSolid(history, solidName, kernel) {
  const solid = history.getObjectByName(solidName);
  if (!solid) return { error: `Solid ${solidName} was not observable.`, solid: null };
  solid.updateMatrixWorld?.(true);
  const boundsResult = attempt(() => new kernel.BREP.THREE.Box3().setFromObject(solid));
  const bounds = boundsResult.value;
  const min = bounds && !bounds.isEmpty() ? bounds.min.toArray().map(roundNumber) : null;
  const max = bounds && !bounds.isEmpty() ? bounds.max.toArray().map(roundNumber) : null;
  const volume = attempt(() => roundNumber(solid.volume()));
  const surfaceArea = attempt(() => roundNumber(solid.surfaceArea()));
  const triangleCount = attempt(() => solid.getTriangleCount());
  const faceNames = attempt(() => [...solid.getFaceNames()].sort());
  const manifold = attempt(() => solid._isCoherentlyOrientedManifold());
  return canonicalize({
    error: null,
    solid: {
      bounds: { error: boundsResult.error, min, max },
      extents: min && max
        ? max.map((entry, index) => roundNumber(entry - min[index]))
        : null,
      volume,
      surfaceArea,
      triangleCount,
      faceNames,
      manifold,
    },
  });
}

function absoluteError(actual, expected) {
  return Number.isFinite(actual) ? Math.abs(actual - expected) : Infinity;
}

function relativeError(actual, expected) {
  if (!Number.isFinite(actual)) return Infinity;
  if (expected === 0) return actual === 0 ? 0 : Infinity;
  return Math.abs(actual - expected) / Math.abs(expected);
}

function compareLength(actual, expected) {
  return absoluteError(actual, expected) <= Math.max(
    numericProfile.comparisonAbsoluteMm,
    numericProfile.comparisonRelative * Math.abs(expected),
  );
}

function evaluateMeasurement(measurement, expected) {
  const solid = measurement.solid;
  if (!solid) {
    return {
      admitted: false,
      finite: false,
      fidelityPass: false,
      numericThresholdPass: false,
      profilePass: false,
      profileMasksFidelityFailure: false,
      topologyPass: false,
    };
  }
  const actualExtents = solid.extents || [NaN, NaN, NaN];
  const actualMin = solid.bounds.min || [NaN, NaN, NaN];
  const actualMax = solid.bounds.max || [NaN, NaN, NaN];
  const volume = solid.volume.value;
  const surfaceArea = solid.surfaceArea.value;
  const allNumbers = [...actualExtents, ...actualMin, ...actualMax, volume, surfaceArea];
  const finite = allNumbers.every(Number.isFinite);
  const extentAbsoluteErrors = actualExtents.map((entry, index) => roundNumber(
    absoluteError(entry, expected.extents[index]),
  ));
  const extentRelativeErrors = actualExtents.map((entry, index) => roundNumber(
    relativeError(entry, expected.extents[index]),
  ));
  const minAbsoluteErrors = actualMin.map((entry, index) => roundNumber(
    absoluteError(entry, expected.min[index]),
  ));
  const maxAbsoluteErrors = actualMax.map((entry, index) => roundNumber(
    absoluteError(entry, expected.max[index]),
  ));
  const volumeAbsoluteError = roundNumber(absoluteError(volume, expected.volume));
  const volumeRelativeError = roundNumber(relativeError(volume, expected.volume));
  const areaAbsoluteError = roundNumber(absoluteError(surfaceArea, expected.surfaceArea));
  const areaRelativeError = roundNumber(relativeError(surfaceArea, expected.surfaceArea));
  const topologyPass = solid.manifold.value === true
    && solid.faceNames.value?.length === expected.faceCount
    && solid.triangleCount.value === expected.triangleCount
    && actualExtents.every((entry) => entry > 0);
  const profilePass = finite
    && actualMin.every((entry, index) => compareLength(entry, expected.min[index]))
    && actualMax.every((entry, index) => compareLength(entry, expected.max[index]))
    && actualExtents.every((entry, index) => compareLength(entry, expected.extents[index]));
  const numericThresholdPass = surfaceArea >= numericProfile.tinyAreaMm2
    && volume >= numericProfile.tinyVolumeMm3;
  const fidelityPass = finite
    && topologyPass
    && extentRelativeErrors.every((entry) => entry <= fidelityRelativeLimit)
    && areaRelativeError <= fidelityRelativeLimit
    && volumeRelativeError <= fidelityRelativeLimit;
  return canonicalize({
    admitted: profilePass && fidelityPass && numericThresholdPass,
    finite,
    fidelityPass,
    numericThresholdPass,
    profilePass,
    profileMasksFidelityFailure: profilePass && (!fidelityPass || !numericThresholdPass),
    topologyPass,
    errors: {
      extentAbsolute: extentAbsoluteErrors,
      extentRelative: extentRelativeErrors,
      minAbsolute: minAbsoluteErrors,
      maxAbsolute: maxAbsoluteErrors,
      volumeAbsolute: volumeAbsoluteError,
      volumeRelative: volumeRelativeError,
      surfaceAreaAbsolute: areaAbsoluteError,
      surfaceAreaRelative: areaRelativeError,
    },
  });
}

async function executeCase(kernel, caseDefinition) {
  let authorError = null;
  let replayError = null;
  let authorMeasurement = null;
  let replayMeasurement = null;
  let serialized = null;
  const expected = expectedMeasurement(caseDefinition);
  try {
    const authored = await createHistory(kernel, caseDefinition);
    await authored.history.runHistory({ throwOnFeatureError: true });
    authorMeasurement = measureSolid(authored.history, authored.solidName, kernel);
    serialized = await authored.history.toJSON();
    const replay = new kernel.PartHistory();
    await replay.fromJSON(serialized);
    await replay.runHistory({ throwOnFeatureError: true });
    replayMeasurement = measureSolid(replay, authored.solidName, kernel);
  } catch (error) {
    const message = String(error?.message || error).split(/\r?\n/, 1)[0];
    if (serialized === null) authorError = message;
    else replayError = message;
  }
  const authorEvaluation = evaluateMeasurement(authorMeasurement || {}, expected);
  const replayEvaluation = evaluateMeasurement(replayMeasurement || {}, expected);
  const pass = authorError === null
    && replayError === null
    && authorEvaluation.admitted
    && replayEvaluation.admitted
    && sha256(authorMeasurement) === sha256(replayMeasurement);
  return canonicalize({
    case: caseDefinition,
    caseKey: caseKey(caseDefinition),
    pass,
    authorError,
    replayError,
    expected,
    author: { evaluation: authorEvaluation, measurement: authorMeasurement },
    replay: { evaluation: replayEvaluation, measurement: replayMeasurement },
    replayMatchesAuthor: sha256(authorMeasurement) === sha256(replayMeasurement),
  });
}

async function workerMain(args) {
  const caseDefinition = JSON.parse(Buffer.from(args[0], 'base64url').toString('utf8'));
  const kernel = await import('brep-io-kernel');
  const result = await executeCase(kernel, caseDefinition);
  console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
}

function optionInteger(args, option, defaultValue, minimum, maximum) {
  const index = args.indexOf(option);
  if (index < 0) return defaultValue;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${option} must be an integer from ${minimum} through ${maximum}.`);
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

async function spawnWorker(workerPath, consumerRoot, caseDefinition) {
  const encoded = Buffer.from(JSON.stringify(caseDefinition)).toString('base64url');
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [workerPath, '--worker', encoded], {
      cwd: consumerRoot,
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
        // Wait for the complete result line.
      }
    };
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); findResult(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      findResult();
      if (!result) {
        resolvePromise({
          result: null,
          naturalExit: !forcedTermination && code === 0,
          workerFailure: {
            code,
            signal,
            stderr: stderr.split(/\r?\n/).filter(Boolean).slice(0, 3),
            stdout: stdout.split(/\r?\n/).filter(Boolean).slice(0, 3),
          },
        });
        return;
      }
      resolvePromise({
        result,
        naturalExit: !forcedTermination && code === 0,
        workerFailure: null,
      });
    });
  });
}

function summarizeFrontier(grouped, kind) {
  const relevant = Object.values(grouped).filter((entry) => entry.case.kind === kind);
  const origins = [...new Set(relevant.map((entry) => entry.case.origin))].sort((a, b) => a - b);
  return origins.map((origin) => {
    const entries = relevant.filter((entry) => entry.case.origin === origin)
      .sort((left, right) => left.case.size - right.case.size);
    const admittedSizes = entries.filter((entry) => entry.admitted).map((entry) => entry.case.size);
    const rejectedSizes = entries.filter((entry) => !entry.admitted).map((entry) => entry.case.size);
    return {
      origin,
      admittedSizes,
      minimumAdmittedSize: admittedSizes[0] ?? null,
      rejectedSizes,
    };
  });
}

async function controllerMain(args) {
  const repetitions = optionInteger(args, '--repetitions', 3, 2, 20);
  const summaryOnly = args.includes('--summary-only');
  const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const packageEntry = packageJson.exports['.'];
  const entryPath = resolve(repoRoot, packageEntry);
  const entryStats = await stat(entryPath);
  const entryDigest = sha256(await readFile(entryPath));
  const distDigest = await digestTree(join(repoRoot, 'dist-kernel'));
  const cases = buildCases();
  const tempRoot = await mkdtemp(join(tmpdir(), 'brep-phase0-scale-tolerance-'));
  try {
    const consumerRoot = join(tempRoot, 'consumer');
    const nodeModules = join(consumerRoot, 'node_modules');
    const workerPath = join(consumerRoot, 'scaleToleranceWorker.mjs');
    await mkdir(nodeModules, { recursive: true });
    await symlink(
      repoRoot,
      join(nodeModules, packageJson.name),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await copyFile(scriptPath, workerPath);

    const runs = [];
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const orderedCases = repetition % 2 === 0 ? cases : [...cases].reverse();
      for (const caseDefinition of orderedCases) {
        const run = await spawnWorker(workerPath, consumerRoot, caseDefinition);
        runs.push({ ...run, case: caseDefinition, repetition });
      }
    }

    const grouped = Object.fromEntries(cases.map((caseDefinition) => {
      const matching = runs.filter((run) => caseKey(run.case) === caseKey(caseDefinition));
      const completed = matching.filter((run) => run.result);
      const digests = [...new Set(completed.map((run) => sha256(run.result)))];
      const representative = completed[0]?.result || null;
      return [caseKey(caseDefinition), canonicalize({
        case: caseDefinition,
        admitted: matching.length === repetitions
          && completed.length === repetitions
          && digests.length === 1
          && completed.every((run) => run.result.pass),
        digest: digests[0] || null,
        digestCount: digests.length,
        repetitions: matching.length,
        stable: completed.length === repetitions && digests.length === 1,
        workerFailures: matching.filter((run) => run.workerFailure).map((run) => ({
          repetition: run.repetition,
          ...run.workerFailure,
        })),
        representative,
      })];
    }));

    const reference = grouped[caseKey({ kind: 'cube', origin: 0, size: 1 })];
    const provisionalCorner = grouped[
      caseKey({ kind: 'cube', origin: numericProfile.coordinateEnvelopeMm, size: 0.00001 })
    ];
    const stable = Object.values(grouped).every((entry) => entry.stable);
    const compactObservations = Object.values(grouped).map((entry) => {
      const author = entry.representative?.author;
      return canonicalize({
        ...entry.case,
        admitted: entry.admitted,
        stable: entry.stable,
        profilePass: author?.evaluation?.profilePass ?? false,
        numericThresholdPass: author?.evaluation?.numericThresholdPass ?? false,
        fidelityPass: author?.evaluation?.fidelityPass ?? false,
        topologyPass: author?.evaluation?.topologyPass ?? false,
        profileMasksFidelityFailure:
          author?.evaluation?.profileMasksFidelityFailure ?? false,
        extents: author?.measurement?.solid?.extents ?? null,
        extentRelativeErrors: author?.evaluation?.errors?.extentRelative ?? null,
        surfaceAreaRelativeError: author?.evaluation?.errors?.surfaceAreaRelative ?? null,
        volumeRelativeError: author?.evaluation?.errors?.volumeRelative ?? null,
        faceCount: author?.measurement?.solid?.faceNames?.value?.length ?? null,
        triangleCount: author?.measurement?.solid?.triangleCount?.value ?? null,
        manifold: author?.measurement?.solid?.manifold?.value ?? null,
        authorError: entry.representative?.authorError ?? null,
        replayError: entry.representative?.replayError ?? null,
      });
    });
    const summary = canonicalize({
      pass: stable && reference?.admitted === true && provisionalCorner?.admitted === false,
      repetitions,
      freshProcesses: runs.length,
      caseCount: cases.length,
      forwardOrderRuns: Math.ceil(repetitions / 2),
      reverseOrderRuns: Math.floor(repetitions / 2),
      fidelityRelativeLimit,
      numericProfile,
      compactObservations,
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
      stable,
      admittedCaseCount: Object.values(grouped).filter((entry) => entry.admitted).length,
      rejectedCaseCount: Object.values(grouped).filter((entry) => !entry.admitted).length,
      profileMaskedFailureCount: Object.values(grouped).filter((entry) => (
        entry.representative?.author?.evaluation?.profileMasksFidelityFailure
      )).length,
      cubeFrontier: summarizeFrontier(grouped, 'cube'),
      extrudeFrontier: summarizeFrontier(grouped, 'extrude'),
      referenceCase: reference,
      provisionalCornerCase: provisionalCorner,
      cases: grouped,
    });
    const output = summaryOnly ? { ...summary, cases: undefined } : summary;
    console.log(JSON.stringify(output, null, 2));
    if (!summary.pass) process.exitCode = 1;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args[0] === '--worker') await workerMain(args.slice(1));
else await controllerMain(args);
