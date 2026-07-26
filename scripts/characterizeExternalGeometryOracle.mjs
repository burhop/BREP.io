import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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

const RESULT_PREFIX = 'PHASE0_ORACLE_RESULT ';
const scriptPath = fileURLToPath(import.meta.url);

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function round(value) {
  return Number(Number(value).toPrecision(12));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
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
  return point.map((value) => Number(value).toPrecision(15)).join(',');
}

function edgeKey(left, right) {
  const keys = [pointKey(left), pointKey(right)].sort();
  return `${keys[0]}|${keys[1]}`;
}

function parseAsciiStl(data) {
  const vertices = [];
  for (const match of data.matchAll(/^\s*vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s*$/gm)) {
    vertices.push(match.slice(1).map(Number));
  }
  if (vertices.length % 3 !== 0 || vertices.some((point) => point.some((value) => !Number.isFinite(value)))) {
    throw new Error('Invalid ASCII STL vertices.');
  }
  const triangles = [];
  for (let index = 0; index < vertices.length; index += 3) {
    triangles.push(vertices.slice(index, index + 3));
  }
  return triangles;
}

function parseTriangulatedStep(data) {
  const points = new Map();
  for (const match of data.matchAll(/#(\d+)\s*=\s*CARTESIAN_POINT\s*\(\s*''\s*,\s*\(([^)]*)\)\s*\)\s*;/g)) {
    const point = match[2].split(',').map(Number);
    if (point.length === 3 && point.every(Number.isFinite)) points.set(match[1], point);
  }
  const triangles = [];
  for (const match of data.matchAll(/#(\d+)\s*=\s*POLY_LOOP\s*\(\s*''\s*,\s*\(([^)]*)\)\s*\)\s*;/g)) {
    const refs = [...match[2].matchAll(/#(\d+)/g)].map((entry) => entry[1]);
    if (refs.length !== 3) continue;
    const triangle = refs.map((ref) => points.get(ref));
    if (triangle.every(Boolean)) triangles.push(triangle);
  }
  return triangles;
}

function connectedComponentCount(triangles, edgeRecords) {
  if (triangles.length === 0) return 0;
  const adjacency = Array.from({ length: triangles.length }, () => new Set());
  for (const record of edgeRecords.values()) {
    for (let left = 0; left < record.triangles.length; left += 1) {
      for (let right = left + 1; right < record.triangles.length; right += 1) {
        const a = record.triangles[left];
        const b = record.triangles[right];
        adjacency[a].add(b);
        adjacency[b].add(a);
      }
    }
  }
  const visited = new Set();
  let components = 0;
  for (let start = 0; start < triangles.length; start += 1) {
    if (visited.has(start)) continue;
    components += 1;
    const pending = [start];
    visited.add(start);
    while (pending.length > 0) {
      for (const neighbor of adjacency[pending.pop()]) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        pending.push(neighbor);
      }
    }
  }
  return components;
}

function measureTriangles(triangles) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const reference = triangles[0]?.[0] || [0, 0, 0];
  const edgeRecords = new Map();
  const axisCounts = { x: 0, y: 0, z: 0, other: 0 };
  const planeCoordinates = { x: new Set(), y: new Set(), z: new Set() };
  let surfaceArea = 0;
  let signedVolume = 0;

  triangles.forEach((triangle, triangleIndex) => {
    const [a, b, c] = triangle;
    for (const point of triangle) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], point[axis]);
        max[axis] = Math.max(max[axis], point[axis]);
      }
    }
    const normal = cross(subtract(b, a), subtract(c, a));
    const normalLength = Math.hypot(...normal);
    surfaceArea += normalLength / 2;
    signedVolume += dot(
      subtract(a, reference),
      cross(subtract(b, reference), subtract(c, reference)),
    ) / 6;

    const absoluteNormal = normalLength === 0
      ? [0, 0, 0]
      : normal.map((value) => Math.abs(value / normalLength));
    const dominantAxis = absoluteNormal.indexOf(Math.max(...absoluteNormal));
    const axisName = ['x', 'y', 'z'][dominantAxis];
    if (absoluteNormal[dominantAxis] >= 1 - 1e-10) {
      axisCounts[axisName] += 1;
      const values = triangle.map((point) => point[dominantAxis]);
      if (Math.max(...values) - Math.min(...values) <= 1e-9) {
        planeCoordinates[axisName].add(round(values[0]));
      }
    } else {
      axisCounts.other += 1;
    }

    for (const [left, right] of [[a, b], [b, c], [c, a]]) {
      const key = edgeKey(left, right);
      const leftKey = pointKey(left);
      const rightKey = pointKey(right);
      const direction = leftKey < rightKey ? 1 : -1;
      const record = edgeRecords.get(key) || { count: 0, directionSum: 0, triangles: [] };
      record.count += 1;
      record.directionSum += direction;
      record.triangles.push(triangleIndex);
      edgeRecords.set(key, record);
    }
  });

  const manifold = [...edgeRecords.values()].every(
    (record) => record.count === 2 && record.directionSum === 0,
  );
  return canonicalize({
    triangleCount: triangles.length,
    bounds: triangles.length > 0 ? { min: min.map(round), max: max.map(round) } : null,
    surfaceArea: round(surfaceArea),
    volume: round(Math.abs(signedVolume)),
    manifold,
    connectedComponents: connectedComponentCount(triangles, edgeRecords),
    axisCounts,
    planeCoordinates: Object.fromEntries(
      Object.entries(planeCoordinates).map(([axis, values]) => [axis, [...values].sort((a, b) => a - b)]),
    ),
  });
}

function expectedFor(definition) {
  const { origin, size } = definition;
  const min = [origin, -origin / 2, origin / 4];
  const extents = [size, 2 * size, 3 * size];
  const max = min.map((value, index) => value + extents[index]);
  return canonicalize({
    triangleCount: 12,
    bounds: { min: min.map(round), max: max.map(round) },
    surfaceArea: round(22 * size ** 2),
    volume: round(6 * size ** 3),
    manifold: true,
    connectedComponents: 1,
    axisCounts: { x: 4, y: 4, z: 4, other: 0 },
    planeCoordinates: { x: [min[0], max[0]].map(round), y: [min[1], max[1]].map(round), z: [min[2], max[2]].map(round) },
  });
}

function close(actual, expected, absolute, relative) {
  return Math.abs(actual - expected) <= Math.max(absolute, relative * Math.abs(expected));
}

function boundsClose(actual, expected) {
  return actual && expected && ['min', 'max'].every((side) => (
    actual[side].every((value, index) => close(value, expected[side][index], 0.0001, 0.000001))
  ));
}

function planesClose(actual, expected) {
  return ['x', 'y', 'z'].every((axis) => (
    actual?.[axis]?.length === expected?.[axis]?.length
    && actual[axis].every((value, index) => close(value, expected[axis][index], 0.0001, 0.000001))
  ));
}

function evaluate(measurement, expected) {
  const checks = {
    triangleCount: measurement.triangleCount === expected.triangleCount,
    bounds: boundsClose(measurement.bounds, expected.bounds),
    surfaceArea: close(measurement.surfaceArea, expected.surfaceArea, 1e-8, 0.01),
    volume: close(measurement.volume, expected.volume, 1e-10, 0.01),
    manifold: measurement.manifold === true,
    connectedComponents: measurement.connectedComponents === 1,
    axisSemantic: JSON.stringify(measurement.axisCounts) === JSON.stringify(expected.axisCounts)
      && planesClose(measurement.planeCoordinates, expected.planeCoordinates),
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

function injectDefects(triangles, size) {
  const clone = () => structuredClone(triangles);
  const missingTriangle = clone();
  missingTriangle.shift();

  const movedVertex = clone();
  movedVertex[0][0][0] += Math.max(size / 3, 0.001);

  const disconnectedTriangle = clone();
  disconnectedTriangle.push(
    triangles[0].map((point) => [point[0] + 4 * size, point[1] + 4 * size, point[2] + 4 * size]),
  );

  return { missingTriangle, movedVertex, disconnectedTriangle };
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

function activeResources() {
  return typeof process.getActiveResourcesInfo === 'function'
    ? process.getActiveResourcesInfo().filter((name) => !['PipeWrap', 'TTYWrap'].includes(name)).sort()
    : [];
}

async function workerMain(encodedDefinition, stlPath, stepPath) {
  const definition = JSON.parse(Buffer.from(encodedDefinition, 'base64url').toString('utf8'));
  const kernel = await import('brep-io-kernel');
  const history = new kernel.PartHistory();
  const feature = await history.newFeature('P.CU');
  Object.assign(feature.inputParams, {
    id: 'C1',
    sizeX: definition.size,
    sizeY: 2 * definition.size,
    sizeZ: 3 * definition.size,
    transform: {
      position: [definition.origin, -definition.origin / 2, definition.origin / 4],
      rotationEuler: [0, 0, 0],
      scale: [1, 1, 1],
    },
    boolean: { targets: [], operation: 'NONE' },
  });
  await history.runHistory({ throwOnFeatureError: true });
  const solid = history.getObjectByName('C1');
  if (!solid) throw new Error('Expected C1 in the history.');
  solid.updateMatrixWorld?.(true);
  const bounds = new kernel.BREP.THREE.Box3().setFromObject(solid);
  const stl = solid.toSTL('C1', 12);
  const step = solid.toSTEP('C1', {
    precision: 12,
    mergePlanarFaces: false,
    useTessellatedFaces: false,
    exportEdgesAsPolylines: false,
  });
  await Promise.all([writeFile(stlPath, stl, 'utf8'), writeFile(stepPath, step, 'utf8')]);
  await delay(100);
  console.log(`${RESULT_PREFIX}${JSON.stringify({
    definition,
    packageMeasurement: {
      triangleCount: solid.getTriangleCount(),
      bounds: { min: bounds.min.toArray().map(round), max: bounds.max.toArray().map(round) },
      surfaceArea: round(solid.surfaceArea()),
      volume: round(solid.volume()),
      manifold: solid._isCoherentlyOrientedManifold(),
    },
    stlSha256: digest(stl),
    normalizedStepSha256: digest(step.replace(
      /(FILE_NAME\s*\(\s*'[^']*'\s*,\s*')[^']+(')/,
      '$1<NORMALIZED_TIMESTAMP>$2',
    )),
    activeResources: activeResources(),
  })}`);
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
    const hardTimer = setTimeout(() => { forcedTermination = true; child.kill(); }, 120_000);
    const findResult = () => {
      if (result) return;
      const marker = stdout.lastIndexOf(RESULT_PREFIX);
      if (marker < 0) return;
      const line = stdout.slice(marker + RESULT_PREFIX.length).split(/\r?\n/, 1)[0];
      try {
        result = JSON.parse(line);
        graceTimer = setTimeout(() => { forcedTermination = true; child.kill(); }, 750);
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
        reject(new Error(`Oracle worker failed (code=${code}, signal=${signal}).\n${stderr}\n${stdout}`));
        return;
      }
      resolvePromise({ result, forcedTermination, naturalExit: !forcedTermination && code === 0 });
    });
  });
}

function matrixCases() {
  return [
    ...[0.01, 0.1, 1, 10, 100].map((size) => ({ origin: 0, size })),
    ...[0.01, 0.1, 1, 10, 100].map((size) => ({ origin: 100, size })),
    ...[0.01, 0.1, 1, 10, 100].map((size) => ({ origin: 500, size })),
    ...[0.01, 0.1, 1, 10].map((size) => ({ origin: 900, size })),
  ];
}

async function parentMain(args) {
  const repoRoot = resolve(dirname(scriptPath), '..');
  const repetitions = parseIntegerArg(args, '--repetitions', 3);
  const packageRoot = parseStringArg(args, '--package-root', repoRoot);
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const entryPath = resolve(packageRoot, packageJson.exports['.']);
  const entryStats = await stat(entryPath);
  const tempRoot = await mkdtemp(join(tmpdir(), 'brep-phase0-oracle-'));
  try {
    const consumerRoot = join(tempRoot, 'consumer');
    const nodeModules = join(consumerRoot, 'node_modules');
    const workerPath = join(consumerRoot, 'oracleWorker.mjs');
    await mkdir(nodeModules, { recursive: true });
    await symlink(packageRoot, join(nodeModules, packageJson.name), process.platform === 'win32' ? 'junction' : 'dir');
    await copyFile(scriptPath, workerPath);

    const results = [];
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      for (const definition of matrixCases()) {
        const key = `r${repetition}-o${definition.origin}-s${definition.size}`;
        const stlPath = join(tempRoot, `${key}.stl`);
        const stepPath = join(tempRoot, `${key}.step`);
        const encoded = Buffer.from(JSON.stringify(definition)).toString('base64url');
        const processResult = await spawnWorker(workerPath, consumerRoot, [encoded, stlPath, stepPath]);
        const stlTriangles = parseAsciiStl(await readFile(stlPath, 'utf8'));
        const stepTriangles = parseTriangulatedStep(await readFile(stepPath, 'utf8'));
        const expected = expectedFor(definition);
        const stlMeasurement = measureTriangles(stlTriangles);
        const stepMeasurement = measureTriangles(stepTriangles);
        results.push({
          definition,
          processResult,
          expected,
          stlMeasurement,
          stepMeasurement,
          stlGate: evaluate(stlMeasurement, expected),
          stepGate: evaluate(stepMeasurement, expected),
          packageAgreement: {
            bounds: boundsClose(stepMeasurement.bounds, processResult.result.packageMeasurement.bounds),
            surfaceArea: close(stepMeasurement.surfaceArea, processResult.result.packageMeasurement.surfaceArea, 1e-10, 1e-8),
            volume: close(stepMeasurement.volume, processResult.result.packageMeasurement.volume, 1e-12, 1e-8),
            manifold: stepMeasurement.manifold === processResult.result.packageMeasurement.manifold,
          },
        });
      }
    }

    const representative = results.find(({ definition }) => definition.origin === 100 && definition.size === 1);
    const injected = Object.fromEntries(
      Object.entries(injectDefects(parseTriangulatedStep(
        await readFile(join(tempRoot, 'r0-o100-s1.step'), 'utf8'),
      ), 1)).map(([name, triangles]) => {
        const measurement = measureTriangles(triangles);
        return [name, { measurement, gate: evaluate(measurement, representative.expected) }];
      }),
    );
    const processResults = results.map((entry) => entry.processResult);
    const stepGatesPassed = results.every((entry) => entry.stepGate.passed);
    const packageAgreementPassed = results.every((entry) => Object.values(entry.packageAgreement).every(Boolean));
    const stable = matrixCases().every((definition) => {
      const matches = results.filter((entry) => (
        entry.definition.origin === definition.origin && entry.definition.size === definition.size
      ));
      return new Set(matches.map((entry) => entry.processResult.result.normalizedStepSha256)).size === 1
        && new Set(matches.map((entry) => digest(JSON.stringify(entry.stepMeasurement)))).size === 1;
    });
    const injectedRejected = Object.values(injected).every((entry) => !entry.gate.passed);
    const stlGatesPassed = results.every((entry) => entry.stlGate.passed);

    const summary = {
      pass: stepGatesPassed && stlGatesPassed && packageAgreementPassed && stable && injectedRejected,
      repetitions,
      matrixCaseCount: matrixCases().length,
      freshProcessCount: processResults.length,
      environment: { node: process.version, platform: `${process.platform}-${process.arch}` },
      package: {
        name: packageJson.name,
        version: packageJson.version,
        packageRoot,
        exportTarget: packageJson.exports['.'],
        entryByteLength: entryStats.size,
        entrySha256: digest(await readFile(entryPath)),
      },
      tolerances: {
        lengthMm: { absolute: 0.0001, relative: 0.000001 },
        areaMm2: { absolute: 1e-8, relative: 0.01 },
        volumeMm3: { absolute: 1e-10, relative: 0.01 },
        stepDecimalPrecision: 12,
      },
      supportedEnvelope: {
        minimumFeatureMm: 0.01,
        maximumAbsoluteCoordinateMm: 1000,
        originsMm: [...new Set(matrixCases().map((entry) => entry.origin))],
        sizesMm: [...new Set(matrixCases().map((entry) => entry.size))],
      },
      stepOracle: {
        passed: stepGatesPassed,
        packageAgreementPassed,
        repetitionsStable: stable,
        failedCases: results.filter((entry) => !entry.stepGate.passed).map((entry) => ({
          definition: entry.definition,
          checks: entry.stepGate.checks,
          expected: entry.expected,
          measured: entry.stepMeasurement,
        })),
        representative: canonicalize({
          definition: representative.definition,
          expected: representative.expected,
          measured: representative.stepMeasurement,
          packageMeasurement: representative.processResult.result.packageMeasurement,
        }),
      },
      stlWorldTransform: {
        passed: stlGatesPassed,
        translatedCasesPassed: results.filter((entry) => entry.definition.origin !== 0).every((entry) => entry.stlGate.passed),
        failedCases: results.filter((entry) => !entry.stlGate.passed).map((entry) => ({
          definition: entry.definition,
          checks: entry.stlGate.checks,
          expected: entry.expected,
          measured: entry.stlMeasurement,
        })),
        representativeTranslated: canonicalize({
          definition: representative.definition,
          expectedBounds: representative.expected.bounds,
          stlBounds: representative.stlMeasurement.bounds,
          stepBounds: representative.stepMeasurement.bounds,
        }),
      },
      injectedDefects: canonicalize(injected),
      lifecycle: {
        naturalExitCount: processResults.filter((entry) => entry.naturalExit).length,
        forcedTerminationCount: processResults.filter((entry) => entry.forcedTermination).length,
        activeResourceSets: [
          ...new Set(processResults.map((entry) => JSON.stringify(entry.result.activeResources))),
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
if (args[0] === '--worker') await workerMain(...args.slice(1));
else await parentMain(args);
