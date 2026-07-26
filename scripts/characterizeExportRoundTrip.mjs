import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const RESULT_PREFIX = 'PHASE0_EXPORT_RESULT ';
const scriptPath = fileURLToPath(import.meta.url);

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function normalizedHistoryDigest(serialized) {
  const value = JSON.parse(serialized);
  for (const feature of value.features || []) feature.timestamp = null;
  return digest(JSON.stringify(canonicalize(value)));
}

function round(value) {
  return Number(Number(value).toPrecision(12));
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function pointKey(point) {
  return point.map((value) => round(value)).join(',');
}

function measureTriangles(triangles) {
  let surfaceArea = 0;
  let signedVolume = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const edgeCounts = new Map();

  for (const triangle of triangles) {
    for (const point of triangle) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], point[axis]);
        max[axis] = Math.max(max[axis], point[axis]);
      }
    }
    const [a, b, c] = triangle;
    surfaceArea += Math.hypot(...cross(subtract(b, a), subtract(c, a))) / 2;
    signedVolume += dot(a, cross(b, c)) / 6;
    for (const [left, right] of [[a, b], [b, c], [c, a]]) {
      const keys = [pointKey(left), pointKey(right)].sort();
      const key = `${keys[0]}|${keys[1]}`;
      edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
    }
  }

  return {
    triangleCount: triangles.length,
    surfaceArea: round(surfaceArea),
    volume: round(Math.abs(signedVolume)),
    bounds: triangles.length > 0
      ? { min: min.map(round), max: max.map(round) }
      : null,
    edgeCount: edgeCounts.size,
    nonManifoldEdgeCounts: [...edgeCounts.values()].filter((count) => count !== 2).sort(),
  };
}

function parseAsciiStl(data) {
  const vertices = [];
  for (const match of data.matchAll(/^\s*vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s*$/gm)) {
    vertices.push(match.slice(1).map(Number));
  }
  if (vertices.some((point) => point.some((value) => !Number.isFinite(value)))) {
    throw new Error('STL contained a non-finite vertex.');
  }
  if (vertices.length % 3 !== 0) throw new Error('STL vertex count was not divisible by three.');
  const triangles = [];
  for (let index = 0; index < vertices.length; index += 3) {
    triangles.push(vertices.slice(index, index + 3));
  }
  return {
    ...measureTriangles(triangles),
    solidStartCount: (data.match(/^solid\b/gm) || []).length,
    solidEndCount: (data.match(/^endsolid\b/gm) || []).length,
  };
}

function parseTriangulatedStep(data) {
  const points = new Map();
  for (const match of data.matchAll(/#(\d+)\s*=\s*CARTESIAN_POINT\s*\(\s*''\s*,\s*\(([^)]*)\)\s*\)\s*;/g)) {
    const point = match[2].split(',').map(Number);
    if (point.length === 3 && point.every(Number.isFinite)) points.set(match[1], point);
  }

  const triangles = [];
  for (const match of data.matchAll(/#(\d+)\s*=\s*POLY_LOOP\s*\(\s*''\s*,\s*\(([^)]*)\)\s*\)\s*;/g)) {
    const refs = [...match[2].matchAll(/#(\d+)/g)].map((ref) => ref[1]);
    if (refs.length !== 3) continue;
    const triangle = refs.map((ref) => points.get(ref));
    if (triangle.every(Boolean)) triangles.push(triangle);
  }

  return {
    ...measureTriangles(triangles),
    cartesianPointCount: points.size,
    polyLoopCount: (data.match(/=\s*POLY_LOOP\s*\(/g) || []).length,
    advancedFaceCount: (data.match(/=\s*ADVANCED_FACE\s*\(/g) || []).length,
    closedShellCount: (data.match(/=\s*CLOSED_SHELL\s*\(/g) || []).length,
    facetedBrepCount: (data.match(/=\s*FACETED_BREP\s*\(/g) || []).length,
  };
}

function inspectStep(data) {
  return {
    byteLength: Buffer.byteLength(data),
    advancedFaceCount: (data.match(/=\s*ADVANCED_FACE\s*\(/g) || []).length,
    tessellatedFaceCount: (data.match(/=\s*TESSELLATED_FACE_SET\s*\(/g) || []).length,
    closedShellCount: (data.match(/=\s*CLOSED_SHELL\s*\(/g) || []).length,
    facetedBrepCount: (data.match(/=\s*FACETED_BREP\s*\(/g) || []).length,
  };
}

function normalizeStep(data) {
  return data.replace(
    /(FILE_NAME\s*\(\s*'[^']*'\s*,\s*')[^']+(')/,
    '$1<NORMALIZED_TIMESTAMP>$2',
  );
}

function activeResources() {
  return typeof process.getActiveResourcesInfo === 'function'
    ? process.getActiveResourcesInfo().filter((name) => !['PipeWrap', 'TTYWrap'].includes(name)).sort()
    : [];
}

function observeCall(callback) {
  try {
    return { value: callback(), error: null };
  } catch (error) {
    return {
      value: null,
      error: {
        name: error?.name || null,
        code: error?.code || null,
        message: String(error?.message || error),
      },
    };
  }
}

async function createCubeHistory(kernel, dimensions, count = 1) {
  const history = new kernel.PartHistory();
  const featureIds = [];
  for (let index = 0; index < count; index += 1) {
    const feature = await history.newFeature('P.CU');
    feature.inputParams.sizeX = dimensions.x + index;
    feature.inputParams.sizeY = dimensions.y + index;
    feature.inputParams.sizeZ = dimensions.z + index;
    featureIds.push(String(feature.inputParams.id));
  }
  await history.runHistory({ throwOnFeatureError: true });
  return { history, featureIds };
}

async function createScaleCornerHistory(kernel) {
  const history = new kernel.PartHistory();
  const feature = await history.newFeature('P.CU');
  Object.assign(feature.inputParams, {
    id: 'C1',
    sizeX: 0.00001,
    sizeY: 0.00002,
    sizeZ: 0.00003,
    transform: {
      position: [1_000_000, -500_000, 250_000],
      rotationEuler: [0, 0, 0],
      scale: [1, 1, 1],
    },
    boolean: { targets: [], operation: 'NONE' },
  });
  await history.runHistory({ throwOnFeatureError: true });
  return { history, featureId: 'C1' };
}

function publicBoundary(kernel, solid) {
  return {
    rootExportKeys: Object.keys(kernel).sort(),
    hasGenerateStep: typeof kernel.generateSTEP === 'function',
    hasGenerate3mf: typeof kernel.generate3MF === 'function',
    solidHasToStl: typeof solid?.toSTL === 'function',
    solidHasToStep: typeof solid?.toSTEP === 'function',
    solidHasTo3mf: typeof solid?.to3MF === 'function',
  };
}

async function deepImportObservation(specifier) {
  try {
    await import(specifier);
    return { imported: true, code: null, message: null };
  } catch (error) {
    return {
      imported: false,
      code: error?.code || null,
      message: String(error?.message || error).split(/\r?\n/, 1)[0],
    };
  }
}

function exportSolid(solid) {
  const stl = solid.toSTL('phase0_cube', 9);
  const defaultStep = solid.toSTEP('phase0_cube', { precision: 9 });
  const triangleStep = solid.toSTEP('phase0_cube', {
    precision: 9,
    mergePlanarFaces: false,
    useTessellatedFaces: false,
    exportEdgesAsPolylines: false,
  });
  return {
    stl: {
      byteLength: Buffer.byteLength(stl),
      sha256: digest(stl),
      measurements: parseAsciiStl(stl),
    },
    defaultStep: {
      ...inspectStep(defaultStep),
      rawSha256: digest(defaultStep),
      normalizedSha256: digest(normalizeStep(defaultStep)),
      hasTimestamp: /FILE_NAME\s*\([^,]+,'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'/.test(defaultStep),
    },
    triangleStep: {
      byteLength: Buffer.byteLength(triangleStep),
      rawSha256: digest(triangleStep),
      normalizedSha256: digest(normalizeStep(triangleStep)),
      measurements: parseTriangulatedStep(triangleStep),
    },
  };
}

async function workerMain(args) {
  const [mode, historyPath] = args;
  const kernel = await import('brep-io-kernel');
  let result;

  if (mode === 'author' || mode === 'replay') {
    let history;
    let featureId;
    if (mode === 'author') {
      const created = await createCubeHistory(kernel, { x: 5, y: 10, z: 15 });
      history = created.history;
      [featureId] = created.featureIds;
      await writeFile(historyPath, await history.toJSON(), 'utf8');
    } else {
      history = new kernel.PartHistory();
      await history.fromJSON(await readFile(historyPath, 'utf8'));
      await history.runHistory({ throwOnFeatureError: true });
      featureId = String(history.features[0]?.inputParams?.id || '');
    }
    const solid = history.scene.getObjectByName(featureId);
    if (!solid) throw new Error(`Expected ${featureId} in the scene.`);
    const serialized = await history.toJSON();
    result = {
      mode,
      historySha256: digest(serialized),
      normalizedHistorySha256: normalizedHistoryDigest(serialized),
      publicBoundary: publicBoundary(kernel, solid),
      exports: exportSolid(solid),
    };
  } else if (mode === 'empty') {
    let runError = null;
    let history;
    let featureId;
    try {
      const created = await createScaleCornerHistory(kernel);
      history = created.history;
      featureId = created.featureId;
    } catch (error) {
      runError = { name: error?.name || null, message: String(error?.message || error) };
    }
    const solid = history?.scene.getObjectByName(featureId);
    let exports = null;
    let exportError = null;
    if (solid) {
      try {
        exports = exportSolid(solid);
      } catch (error) {
        exportError = { name: error?.name || null, message: String(error?.message || error) };
      }
    }
    result = {
      mode,
      runError,
      solidPresent: Boolean(solid),
      triangleCount: solid ? observeCall(() => solid.getTriangleCount()) : null,
      volume: solid ? observeCall(() => round(solid.volume())) : null,
      exportError,
      exports,
    };
  } else if (mode === 'two-body') {
    const { history, featureIds } = await createCubeHistory(kernel, { x: 5, y: 10, z: 15 }, 2);
    const solids = featureIds.map((featureId) => history.scene.getObjectByName(featureId));
    result = {
      mode,
      featureIds,
      solidCount: solids.filter(Boolean).length,
      publicBoundary: publicBoundary(kernel, solids[0]),
      perSolidStepByteLengths: solids.map((solid) => solid.toSTEP(solid.name).length),
      perSolidStlMeasurements: solids.map((solid) => parseAsciiStl(solid.toSTL(solid.name, 9))),
      deepImports: {
        step: await deepImportObservation('brep-io-kernel/src/exporters/step.js'),
        threeMf: await deepImportObservation('brep-io-kernel/src/exporters/threeMF.js'),
      },
    };
  } else {
    throw new Error(`Unknown worker mode: ${mode}`);
  }

  await delay(100);
  result.activeResources = activeResources();
  console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
}

function parseIntegerArg(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 2) throw new Error(`${name} must be an integer of at least 2.`);
  return value;
}

function parseStringArg(args, name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : resolve(args[index + 1]);
}

async function spawnWorker(workerPath, consumerRoot, args) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [workerPath, '--worker', ...args], {
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
    }, 120_000);

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
        }, 750);
      } catch {
        // Wait for a complete result line.
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
        reject(new Error(`Worker ${args[0]} failed (code=${code}, signal=${signal}).\n${stderr}\n${stdout}`));
        return;
      }
      resolvePromise({
        result,
        naturalExit: !forcedTermination && code === 0,
        forcedTermination,
        exitCode: code,
        signal,
        stderr: stderr.trim(),
      });
    });
  });
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function parentMain(args) {
  const scriptDir = dirname(scriptPath);
  const repoRoot = resolve(scriptDir, '..');
  const repetitions = parseIntegerArg(args, '--repetitions', 5);
  const packageRoot = parseStringArg(args, '--package-root', repoRoot);
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const entryPath = resolve(packageRoot, packageJson.exports['.']);
  const entryStats = await stat(entryPath);
  const entrySha256 = digest(await readFile(entryPath));
  const tempRoot = await mkdtemp(join(tmpdir(), 'brep-phase0-export-'));

  try {
    const consumerRoot = join(tempRoot, 'consumer');
    const nodeModules = join(consumerRoot, 'node_modules');
    const packageLink = join(nodeModules, packageJson.name);
    const workerPath = join(consumerRoot, 'exportWorker.mjs');
    await mkdir(nodeModules, { recursive: true });
    await symlink(packageRoot, packageLink, process.platform === 'win32' ? 'junction' : 'dir');
    await copyFile(scriptPath, workerPath);

    const runs = [];
    for (let index = 0; index < repetitions; index += 1) {
      const historyPath = join(tempRoot, `history-${index}.json`);
      const author = await spawnWorker(workerPath, consumerRoot, ['author', historyPath]);
      const replay = await spawnWorker(workerPath, consumerRoot, ['replay', historyPath]);
      const empty = await spawnWorker(workerPath, consumerRoot, ['empty', '']);
      runs.push({ author, replay, empty });
    }
    const twoBody = await spawnWorker(workerPath, consumerRoot, ['two-body', '']);

    const expectedMeasurements = {
      triangleCount: 12,
      surfaceArea: 550,
      volume: 750,
      bounds: { min: [0, 0, 0], max: [5, 10, 15] },
      edgeCount: 18,
      nonManifoldEdgeCounts: [],
    };
    const authored = runs.map((run) => run.author.result);
    const replayed = runs.map((run) => run.replay.result);
    const processes = [...runs.flatMap((run) => [run.author, run.replay, run.empty]), twoBody];
    const exportPairsStable = runs.every((run) => (
      run.author.result.exports.stl.sha256 === run.replay.result.exports.stl.sha256
      && run.author.result.exports.defaultStep.normalizedSha256
        === run.replay.result.exports.defaultStep.normalizedSha256
      && run.author.result.exports.triangleStep.normalizedSha256
        === run.replay.result.exports.triangleStep.normalizedSha256
    ));
    const repetitionsStable = ['stl', 'defaultStep', 'triangleStep'].every((format) => {
      const values = authored.map((result) => {
        if (format === 'stl') return result.exports.stl.sha256;
        return result.exports[format].normalizedSha256;
      });
      return new Set(values).size === 1;
    });
    const measurementsPass = [...authored, ...replayed].every((result) => (
      equal(result.exports.stl.measurements, {
        ...expectedMeasurements,
        solidStartCount: 1,
        solidEndCount: 1,
      })
      && equal(result.exports.triangleStep.measurements, {
        ...expectedMeasurements,
        cartesianPointCount: 8,
        polyLoopCount: 12,
        advancedFaceCount: 12,
        closedShellCount: 1,
        facetedBrepCount: 1,
      })
      && result.exports.defaultStep.byteLength > 0
      && result.exports.defaultStep.facetedBrepCount === 1
    ));
    const boundary = authored[0].publicBoundary;
    const packageBoundaryPass = !boundary.hasGenerateStep
      && !boundary.hasGenerate3mf
      && boundary.solidHasToStl
      && boundary.solidHasToStep
      && !boundary.solidHasTo3mf
      && twoBody.result.deepImports.step.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
      && twoBody.result.deepImports.threeMf.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';

    const summary = {
      pass: exportPairsStable && repetitionsStable && measurementsPass && packageBoundaryPass,
      repetitions,
      freshProcessCount: processes.length,
      environment: {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
      },
      package: {
        name: packageJson.name,
        version: packageJson.version,
        packageRoot,
        exportTarget: packageJson.exports['.'],
        entryByteLength: entryStats.size,
        entrySha256,
        publicBoundary,
        deepImports: twoBody.result.deepImports,
      },
      roundTrip: {
        passed: exportPairsStable,
        repetitionsStable,
        measurementsPassed: measurementsPass,
        authoredHistorySha256: [...new Set(authored.map((result) => result.historySha256))],
        replayedHistorySha256: [...new Set(replayed.map((result) => result.historySha256))],
        normalizedHistorySha256: [
          ...new Set([...authored, ...replayed].map((result) => result.normalizedHistorySha256)),
        ],
        stlSha256: [...new Set(authored.map((result) => result.exports.stl.sha256))],
        defaultStepRawSha256: [...new Set(authored.map((result) => result.exports.defaultStep.rawSha256))],
        defaultStepNormalizedSha256: [
          ...new Set(authored.map((result) => result.exports.defaultStep.normalizedSha256)),
        ],
        triangleStepRawSha256: [...new Set(authored.map((result) => result.exports.triangleStep.rawSha256))],
        triangleStepNormalizedSha256: [
          ...new Set(authored.map((result) => result.exports.triangleStep.normalizedSha256)),
        ],
        stl: authored[0].exports.stl,
        defaultStep: authored[0].exports.defaultStep,
        triangleStep: authored[0].exports.triangleStep,
        normalization: {
          stepFileNameTimestampReplaced: true,
          noOtherStepContentChanged: true,
          stlNormalization: false,
        },
      },
      emptyGeometry: runs[0].empty.result,
      twoBody: twoBody.result,
      lifecycle: {
        naturalExitCount: processes.filter((entry) => entry.naturalExit).length,
        forcedTerminationCount: processes.filter((entry) => entry.forcedTermination).length,
        activeResourceSets: [
          ...new Set(processes.map((entry) => JSON.stringify(entry.result.activeResources))),
        ].map(JSON.parse),
      },
    };

    console.log(JSON.stringify(summary, null, 2));
    if (!summary.pass) process.exitCode = 1;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args[0] === '--worker') await workerMain(args.slice(1));
else await parentMain(args);
