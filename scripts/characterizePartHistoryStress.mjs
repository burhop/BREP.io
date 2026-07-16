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

const RESULT_PREFIX = 'PHASE0_PART_HISTORY_STRESS_RESULT ';
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

function nearlyEqual(actual, expected) {
  return Number.isFinite(actual)
    && Math.abs(actual - expected) <= Math.max(1e-6, Math.abs(expected) * 1e-7);
}

function optionInteger(args, name, fallback, minimum, maximum) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function optionPackageRoot(args) {
  const index = args.indexOf('--package-root');
  if (index < 0) return repoRoot;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('--package-root requires a package directory path.');
  }
  return resolve(value);
}

function managerIdentity(historyA, historyB) {
  return canonicalize({
    sceneShared: historyA.scene === historyB.scene,
    featureRegistryShared: historyA.featureRegistry === historyB.featureRegistry,
    assemblyConstraintRegistryShared:
      historyA.assemblyConstraintRegistry === historyB.assemblyConstraintRegistry,
    pmiViewsManagerShared: historyA.pmiViewsManager === historyB.pmiViewsManager,
    simulationStateManagerShared:
      historyA.simulationStateManager === historyB.simulationStateManager,
    camPlanManagerShared: historyA.camPlanManager === historyB.camPlanManager,
    sheet2DManagerShared: historyA.sheet2DManager === historyB.sheet2DManager,
    wireHarnessManagerShared:
      historyA.wireHarnessManager === historyB.wireHarnessManager,
    metadataManagerShared: historyA.metadataManager === historyB.metadataManager,
    callbacksShared: historyA.callbacks === historyB.callbacks,
    primitiveFeatureClassShared:
      historyA.featureRegistry.getSafe('P.CU') === historyB.featureRegistry.getSafe('P.CU'),
  });
}

function identityPass(identity) {
  return !identity.sceneShared
    && !identity.featureRegistryShared
    && !identity.assemblyConstraintRegistryShared
    && !identity.pmiViewsManagerShared
    && !identity.simulationStateManagerShared
    && !identity.camPlanManagerShared
    && !identity.sheet2DManagerShared
    && !identity.wireHarnessManagerShared
    && !identity.metadataManagerShared
    && !identity.callbacksShared
    && identity.primitiveFeatureClassShared;
}

function measure(history, id, kernel) {
  const solid = history.getObjectByName(id);
  if (!solid || String(solid.type).toUpperCase() !== 'SOLID') return null;
  solid.updateMatrixWorld?.(true);
  const bounds = new kernel.BREP.THREE.Box3().setFromObject(solid);
  return canonicalize({
    sceneSolidCount: history.scene.children.filter((entry) => entry.type === 'SOLID').length,
    name: solid.name,
    bounds: {
      min: bounds.min.toArray().map(roundNumber),
      max: bounds.max.toArray().map(roundNumber),
    },
    volume: roundNumber(solid.volume()),
    surfaceArea: roundNumber(solid.surfaceArea()),
    triangleCount: solid.getTriangleCount(),
    faceNames: [...solid.getFaceNames()].sort(),
  });
}

async function createPair(kernel, index) {
  const historyA = new kernel.PartHistory();
  const historyB = new kernel.PartHistory();
  const widthA = roundNumber(2 + ((index % 7) / 10));
  const widthB = roundNumber(5 + ((index % 11) / 10));
  const eventsA = [];
  const eventsB = [];
  historyA.expressions = `const width = ${widthA};`;
  historyB.expressions = `const width = ${widthB};`;
  historyA.metadataManager.metadata = { phase0Label: `stress-a-${index}`, index };
  historyB.metadataManager.metadata = { phase0Label: `stress-b-${index}`, index };
  historyA.callbacks.run = async (featureId) => eventsA.push(`run:${featureId}`);
  historyB.callbacks.run = async (featureId) => eventsB.push(`run:${featureId}`);
  historyA.callbacks.afterRunHistory = async () => eventsA.push('after');
  historyB.callbacks.afterRunHistory = async () => eventsB.push('after');

  let featureA;
  let featureB;
  if (index % 2 === 0) {
    featureA = await historyA.newFeature('P.CU');
    featureB = await historyB.newFeature('P.CU');
  } else {
    featureB = await historyB.newFeature('P.CU');
    featureA = await historyA.newFeature('P.CU');
  }
  Object.assign(featureA.inputParams, {
    id: 'A1',
    sizeX: 0,
    sizeY: 3,
    sizeZ: 4,
    __expr: { sizeX: 'width' },
  });
  Object.assign(featureB.inputParams, {
    id: 'B1',
    sizeX: 0,
    sizeY: 6,
    sizeZ: 7,
    __expr: { sizeX: 'width' },
  });

  const runs = index % 2 === 0
    ? [
      historyA.runHistory({ throwOnFeatureError: true }),
      historyB.runHistory({ throwOnFeatureError: true }),
    ]
    : [
      historyB.runHistory({ throwOnFeatureError: true }),
      historyA.runHistory({ throwOnFeatureError: true }),
    ];
  await Promise.all(runs);

  const serializedA = historyA.toSerializable();
  const serializedB = historyB.toSerializable();
  const measurementA = measure(historyA, 'A1', kernel);
  const measurementB = measure(historyB, 'B1', kernel);
  const identity = managerIdentity(historyA, historyB);
  const expectedVolumeA = roundNumber(widthA * 3 * 4);
  const expectedVolumeB = roundNumber(widthB * 6 * 7);
  const pass = identityPass(identity)
    && JSON.stringify(eventsA) === JSON.stringify(['run:A1', 'after'])
    && JSON.stringify(eventsB) === JSON.stringify(['run:B1', 'after'])
    && serializedA.expressions === `const width = ${widthA};`
    && serializedB.expressions === `const width = ${widthB};`
    && serializedA.metadata.phase0Label === `stress-a-${index}`
    && serializedB.metadata.phase0Label === `stress-b-${index}`
    && measurementA?.name === 'A1'
    && measurementB?.name === 'B1'
    && measurementA?.sceneSolidCount === 1
    && measurementB?.sceneSolidCount === 1
    && nearlyEqual(measurementA?.bounds?.max?.[0], widthA)
    && nearlyEqual(measurementB?.bounds?.max?.[0], widthB)
    && nearlyEqual(measurementA?.volume, expectedVolumeA)
    && nearlyEqual(measurementB?.volume, expectedVolumeB)
    && !historyA.getObjectByName('B1')
    && !historyB.getObjectByName('A1');

  return canonicalize({
    index,
    order: index % 2 === 0 ? 'a-first' : 'b-first',
    pass,
    widthA,
    widthB,
    expectedVolumeA,
    expectedVolumeB,
    eventsA,
    eventsB,
    expressionsA: serializedA.expressions,
    expressionsB: serializedB.expressions,
    metadataA: serializedA.metadata,
    metadataB: serializedB.metadata,
    measurementA,
    measurementB,
    identity,
  });
}

async function workerMain(args) {
  const start = Number(args[0]);
  const count = Number(args[1]);
  if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 1) {
    throw new Error('Worker requires a non-negative start and positive count.');
  }
  const kernel = await import('brep-io-kernel');
  const records = [];
  for (let offset = 0; offset < count; offset += 1) {
    records.push(await createPair(kernel, start + offset));
  }
  const result = canonicalize({
    start,
    count,
    pass: records.every((entry) => entry.pass),
    failureIndexes: records.filter((entry) => !entry.pass).map((entry) => entry.index),
    records,
    digest: sha256(records),
  });
  console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
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

async function spawnWorker(workerPath, consumerRoot, start, count) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [workerPath, '--worker', String(start), String(count)], {
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
    }, 300_000);
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
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      findResult();
      if (!result) {
        reject(new Error(
          `Stress worker ${start}+${count} produced no result (code=${code}, signal=${signal}).\n${stderr}\n${stdout}`,
        ));
        return;
      }
      resolvePromise({ result, naturalExit: !forcedTermination && code === 0 });
    });
  });
}

async function controllerMain(args) {
  const interleavings = optionInteger(args, '--interleavings', 1000, 2, 100_000);
  const workerCount = optionInteger(args, '--workers', 10, 1, 50);
  const packageRoot = optionPackageRoot(args);
  if (workerCount > interleavings) throw new Error('--workers cannot exceed --interleavings.');
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const packageEntry = packageJson.exports['.'];
  const entryPath = resolve(packageRoot, packageEntry);
  const entryStats = await stat(entryPath);
  const entryDigest = sha256(await readFile(entryPath));
  const distDigest = await digestTree(join(packageRoot, 'dist-kernel'));
  const tempRoot = await mkdtemp(join(tmpdir(), 'brep-phase0-part-history-stress-'));
  try {
    const consumerRoot = join(tempRoot, 'consumer');
    const nodeModules = join(consumerRoot, 'node_modules');
    const workerPath = join(consumerRoot, 'partHistoryStressWorker.mjs');
    await mkdir(nodeModules, { recursive: true });
    await symlink(
      packageRoot,
      join(nodeModules, packageJson.name),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await copyFile(scriptPath, workerPath);

    const allocations = [];
    let cursor = 0;
    for (let worker = 0; worker < workerCount; worker += 1) {
      const count = Math.floor(interleavings / workerCount)
        + (worker < interleavings % workerCount ? 1 : 0);
      allocations.push({ start: cursor, count });
      cursor += count;
    }
    const runs = await Promise.all(
      allocations.map(({ start, count }) => spawnWorker(workerPath, consumerRoot, start, count)),
    );
    const records = runs.flatMap((run) => run.result.records)
      .sort((left, right) => left.index - right.index);
    const failures = records.filter((entry) => !entry.pass).map((entry) => entry.index);
    const identityDigests = [...new Set(records.map((entry) => sha256(entry.identity)))];
    const summary = canonicalize({
      pass: failures.length === 0
        && records.length === interleavings
        && identityDigests.length === 1,
      interleavings,
      workerCount,
      aFirstCount: records.filter((entry) => entry.order === 'a-first').length,
      bFirstCount: records.filter((entry) => entry.order === 'b-first').length,
      failureCount: failures.length,
      failureIndexes: failures,
      failureDetails: records.filter((entry) => !entry.pass).slice(0, 10),
      recordsDigest: sha256(records),
      identityDigestCount: identityDigests.length,
      identityDigest: identityDigests[0],
      representativeIdentity: records[0]?.identity || null,
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
      workerDigests: runs.map((run) => ({
        start: run.result.start,
        count: run.result.count,
        digest: run.result.digest,
      })),
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
