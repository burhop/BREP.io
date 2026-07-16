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

const RESULT_PREFIX = 'PHASE0_SKETCH_EXTRUDE_RESULT ';
const EXPECTED_TOP_LEVEL_KEYS = [
  'activeWorkbench',
  'assemblyConstraintIdCounter',
  'assemblyConstraints',
  'cam',
  'configurator',
  'expressions',
  'features',
  'idCounter',
  'metadata',
  'pmiViews',
  'sheets2D',
  'simulation',
  'wireHarness',
];
const EXPECTED_FACE_ROLES = [
  'G1_SW',
  'G2_SW',
  'G3_SW',
  'G4_SW',
  'PROFILE_END',
  'PROFILE_START',
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const workerSource = join(
  scriptDir,
  'fixtures',
  'headlessSketchExtrudeRoundTripWorker.mjs',
);

function parseRepetitions(args) {
  const index = args.indexOf('--repetitions');
  if (index < 0) return 3;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 2) {
    throw new Error('--repetitions must be an integer of at least 2.');
  }
  return value;
}

function parsePackageRoot(args) {
  const index = args.indexOf('--package-root');
  if (index < 0) return repoRoot;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('--package-root requires a package directory path.');
  }
  return resolve(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function normalizeDerivedRuntimeFields(value, insideReferenceSnapshots = false) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeDerivedRuntimeFields(entry, insideReferenceSnapshots));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    const insideSnapshots = insideReferenceSnapshots || key === 'referenceSnapshots';
    if (insideSnapshots && (key === 'sourceUuid' || key === 'sourceTimestamp')) {
      return [key, null];
    }
    return [key, normalizeDerivedRuntimeFields(entry, insideSnapshots)];
  }));
}

function normalizeSerializable(serializable) {
  const normalized = structuredClone(serializable);
  for (const feature of normalized.features || []) {
    feature.timestamp = null;
    if (feature.type === 'S' && feature.persistentData) {
      feature.persistentData.lastSketchChanged = null;
    }
  }
  return canonicalize(normalizeDerivedRuntimeFields(normalized));
}

function differencePaths(left, right, path = '$', output = []) {
  if (Object.is(left, right)) return output;
  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      differencePaths(left[index], right[index], `${path}[${index}]`, output);
    }
    return output;
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) {
      differencePaths(left[key], right[key], `${path}.${key}`, output);
    }
    return output;
  }
  output.push(path);
  return output;
}

function stableStageSignature(result) {
  return JSON.stringify({
    mode: result.mode,
    normalizedSerializationDigest: result.normalizedSerializationDigest,
    intentDigest: result.intentDigest,
    normalizedRuntimeRecordDigest: result.normalizedRuntimeRecordDigest,
    geometryDigest: result.geometryDigest,
    intent: result.intent,
    runtime: result.runtime,
    serializationBoundary: result.serializationBoundary,
    measurement: result.measurement,
  });
}

function stageSummary(result) {
  const {
    constraints: _constraints,
    ...runtimeSummary
  } = result.runtime;
  return {
    mode: result.mode,
    serializedByteLength: result.serializedByteLength,
    rawSerializationDigest: result.rawSerializationDigest,
    normalizedSerializationDigest: result.normalizedSerializationDigest,
    intentDigest: result.intentDigest,
    rawRuntimeRecordDigest: result.rawRuntimeRecordDigest,
    normalizedRuntimeRecordDigest: result.normalizedRuntimeRecordDigest,
    geometryDigest: result.geometryDigest,
    runtime: runtimeSummary,
    serializationBoundary: result.serializationBoundary,
    measurement: result.measurement,
  };
}

function validateStage(result, expected) {
  const intent = result.intent;
  const measurement = result.measurement;
  const boundary = result.serializationBoundary;
  return intent.idCounter === 2
    && intent.expressions === expected.expressions
    && intent.metadata?.intentVersion === expected.intentVersion
    && intent.sketch.id === 'S1'
    && intent.extrude.id === 'E2'
    && intent.extrude.profile === 'S1:PROFILE'
    && intent.extrude.consumeProfileSketch === true
    && intent.extrude.distance === 0
    && intent.extrude.distanceBack === expected.distanceBack
    && intent.extrude.expressionBindings?.distance === 'depth'
    && intent.extrude.boolean?.operation === 'NONE'
    && Array.isArray(intent.extrude.boolean?.targets)
    && intent.extrude.boolean.targets.length === 0
    && intent.sketch.authored.constraints.length === 5
    && result.runtime.constraintCount === 5
    && result.runtime.hasLastSketchSignature === true
    && result.runtime.lastProfileDiagnosticsSerialized === false
    && measurement.volume === expected.volume
    && measurement.triangleCount === 12
    && JSON.stringify(measurement.faceRoles) === JSON.stringify(EXPECTED_FACE_ROLES)
    && boundary.currentHistoryStepFieldPresent === false
    && boundary.suppressionFields.length === 0
    && EXPECTED_TOP_LEVEL_KEYS.every((key) => boundary.topLevelKeys.includes(key));
}

function chainComparisons(chain) {
  return {
    original: {
      rawSerializationEqual:
        chain.author.rawSerializationDigest === chain.replay.rawSerializationDigest,
      normalizedSerializationEqual:
        chain.author.normalizedSerializationDigest
          === chain.replay.normalizedSerializationDigest,
      intentEqual: chain.author.intentDigest === chain.replay.intentDigest,
      rawRuntimeRecordEqual:
        chain.author.rawRuntimeRecordDigest === chain.replay.rawRuntimeRecordDigest,
      normalizedRuntimeRecordEqual:
        chain.author.normalizedRuntimeRecordDigest
          === chain.replay.normalizedRuntimeRecordDigest,
      geometryEqual: chain.author.geometryDigest === chain.replay.geometryDigest,
    },
    edited: {
      rawSerializationEqual:
        chain.edit.rawSerializationDigest === chain.replayEdited.rawSerializationDigest,
      normalizedSerializationEqual:
        chain.edit.normalizedSerializationDigest
          === chain.replayEdited.normalizedSerializationDigest,
      intentEqual: chain.edit.intentDigest === chain.replayEdited.intentDigest,
      rawRuntimeRecordEqual:
        chain.edit.rawRuntimeRecordDigest === chain.replayEdited.rawRuntimeRecordDigest,
      normalizedRuntimeRecordEqual:
        chain.edit.normalizedRuntimeRecordDigest
          === chain.replayEdited.normalizedRuntimeRecordDigest,
      geometryEqual: chain.edit.geometryDigest === chain.replayEdited.geometryDigest,
    },
    editChangedIntent: chain.author.intentDigest !== chain.edit.intentDigest,
    editChangedGeometry: chain.author.geometryDigest !== chain.edit.geometryDigest,
  };
}

function validateChain(chain) {
  const comparisons = chainComparisons(chain);
  const stableReplay = ({
    normalizedSerializationEqual,
    intentEqual,
    normalizedRuntimeRecordEqual,
    geometryEqual,
  }) => normalizedSerializationEqual
    && intentEqual
    && normalizedRuntimeRecordEqual
    && geometryEqual;
  const originalStagesPass = validateStage(chain.author, {
    expressions: 'const depth = 10;',
    intentVersion: 1,
    distanceBack: 1,
    volume: 396,
  }) && validateStage(chain.replay, {
    expressions: 'const depth = 10;',
    intentVersion: 1,
    distanceBack: 1,
    volume: 396,
  });
  const editedStagesPass = validateStage(chain.edit, {
    expressions: 'const depth = 14;',
    intentVersion: 2,
    distanceBack: 2,
    volume: 896,
  }) && validateStage(chain.replayEdited, {
    expressions: 'const depth = 14;',
    intentVersion: 2,
    distanceBack: 2,
    volume: 896,
  });
  const currentStepBehavior = chain.author.serializationBoundary.currentHistoryStepBeforeSerialize === 'E2'
    && chain.edit.serializationBoundary.currentHistoryStepBeforeSerialize === 'E2'
    && chain.replay.serializationBoundary.restoredCurrentHistoryStepId === null
    && chain.replayEdited.serializationBoundary.restoredCurrentHistoryStepId === null;
  return originalStagesPass
    && editedStagesPass
    && stableReplay(comparisons.original)
    && stableReplay(comparisons.edited)
    && comparisons.editChangedIntent
    && comparisons.editChangedGeometry
    && currentStepBehavior;
}

async function spawnWorker(workerPath, consumerRoot, mode, inputPath, outputPath) {
  return await new Promise((resolvePromise, reject) => {
    const args = [workerPath, mode, inputPath || '', outputPath];
    const child = spawn(process.execPath, args, {
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
        }, 1_250);
      } catch {
        // Wait for a complete result line.
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
          `Round-trip worker ${mode} produced no result (code=${code}, signal=${signal}).\n${stderr}\n${stdout}`,
        ));
        return;
      }
      resolvePromise({
        result,
        naturalExit: !forcedTermination && code === 0,
        forcedTermination,
        stderr: stderr.trim(),
      });
    });
  });
}

const args = process.argv.slice(2);
const repetitions = parseRepetitions(args);
const fullOutput = args.includes('--full');
const packageRoot = parsePackageRoot(args);
const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const packageEntry = packageJson.exports['.'];
const entryPath = resolve(packageRoot, packageEntry);
const entryStats = await stat(entryPath);
const entryDigest = sha256(await readFile(entryPath));
const distDigest = await digestTree(join(packageRoot, 'dist-kernel'));
const tempRoot = await mkdtemp(join(tmpdir(), 'brep-phase0-sketch-extrude-'));

try {
  const consumerRoot = join(tempRoot, 'consumer');
  const nodeModules = join(consumerRoot, 'node_modules');
  const workerPath = join(consumerRoot, 'headlessSketchExtrudeRoundTripWorker.mjs');
  await mkdir(nodeModules, { recursive: true });
  await symlink(
    packageRoot,
    join(nodeModules, packageJson.name),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await copyFile(workerSource, workerPath);

  const chains = [];
  const serializableFiles = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const authorPath = join(consumerRoot, `author-${repetition}.json`);
    const replayPath = join(consumerRoot, `replay-${repetition}.json`);
    const editedPath = join(consumerRoot, `edited-${repetition}.json`);
    const editedReplayPath = join(consumerRoot, `edited-replay-${repetition}.json`);

    const author = await spawnWorker(workerPath, consumerRoot, 'author', null, authorPath);
    const replay = await spawnWorker(workerPath, consumerRoot, 'replay', authorPath, replayPath);
    const edit = await spawnWorker(workerPath, consumerRoot, 'edit', replayPath, editedPath);
    const replayEdited = await spawnWorker(
      workerPath,
      consumerRoot,
      'replay-edited',
      editedPath,
      editedReplayPath,
    );
    const chain = {
      author: author.result,
      replay: replay.result,
      edit: edit.result,
      replayEdited: replayEdited.result,
      processExit: {
        author: author.naturalExit,
        replay: replay.naturalExit,
        edit: edit.naturalExit,
        replayEdited: replayEdited.naturalExit,
      },
    };
    chain.comparisons = chainComparisons(chain);
    chain.passed = validateChain(chain);
    const serializable = {
      author: JSON.parse(await readFile(authorPath, 'utf8')),
      replay: JSON.parse(await readFile(replayPath, 'utf8')),
      edit: JSON.parse(await readFile(editedPath, 'utf8')),
      replayEdited: JSON.parse(await readFile(editedReplayPath, 'utf8')),
    };
    chain.differencePaths = {
      originalRaw: differencePaths(serializable.author, serializable.replay),
      originalNormalized: differencePaths(
        normalizeSerializable(serializable.author),
        normalizeSerializable(serializable.replay),
      ),
      editedRaw: differencePaths(serializable.edit, serializable.replayEdited),
      editedNormalized: differencePaths(
        normalizeSerializable(serializable.edit),
        normalizeSerializable(serializable.replayEdited),
      ),
    };
    chains.push(chain);
    serializableFiles.push(serializable);
  }

  const authorResults = chains.map((chain) => chain.author);
  const replayResults = chains.map((chain) => chain.replay);
  const editResults = chains.map((chain) => chain.edit);
  const editedReplayResults = chains.map((chain) => chain.replayEdited);
  const rawAuthorDifferencePaths = repetitions > 1
    ? differencePaths(serializableFiles[0].author, serializableFiles[1].author)
    : [];
  const normalizedAuthorDifferencePaths = repetitions > 1
    ? differencePaths(
      normalizeSerializable(serializableFiles[0].author),
      normalizeSerializable(serializableFiles[1].author),
    )
    : [];

  const crossRepetition = {
    author: {
      rawDigestCount: new Set(authorResults.map((result) => result.rawSerializationDigest)).size,
      normalizedDigestCount:
        new Set(authorResults.map((result) => result.normalizedSerializationDigest)).size,
      intentDigestCount: new Set(authorResults.map((result) => result.intentDigest)).size,
      runtimeRecordDigestCount:
        new Set(authorResults.map((result) => result.rawRuntimeRecordDigest)).size,
      normalizedRuntimeRecordDigestCount:
        new Set(authorResults.map((result) => result.normalizedRuntimeRecordDigest)).size,
      geometryDigestCount: new Set(authorResults.map((result) => result.geometryDigest)).size,
    },
    replay: {
      normalizedDigestCount:
        new Set(replayResults.map((result) => result.normalizedSerializationDigest)).size,
      stableStageCount: new Set(replayResults.map(stableStageSignature)).size,
    },
    edit: {
      rawDigestCount: new Set(editResults.map((result) => result.rawSerializationDigest)).size,
      normalizedDigestCount:
        new Set(editResults.map((result) => result.normalizedSerializationDigest)).size,
      intentDigestCount: new Set(editResults.map((result) => result.intentDigest)).size,
      runtimeRecordDigestCount:
        new Set(editResults.map((result) => result.rawRuntimeRecordDigest)).size,
      normalizedRuntimeRecordDigestCount:
        new Set(editResults.map((result) => result.normalizedRuntimeRecordDigest)).size,
      geometryDigestCount: new Set(editResults.map((result) => result.geometryDigest)).size,
    },
    replayEdited: {
      normalizedDigestCount:
        new Set(editedReplayResults.map((result) => result.normalizedSerializationDigest)).size,
      stableStageCount: new Set(editedReplayResults.map(stableStageSignature)).size,
    },
    rawAuthorDifferencePaths,
    normalizedAuthorDifferencePaths,
  };

  const crossRepetitionPassed = crossRepetition.author.normalizedDigestCount === 1
    && crossRepetition.author.intentDigestCount === 1
    && crossRepetition.author.normalizedRuntimeRecordDigestCount === 1
    && crossRepetition.author.geometryDigestCount === 1
    && crossRepetition.replay.normalizedDigestCount === 1
    && crossRepetition.replay.stableStageCount === 1
    && crossRepetition.edit.normalizedDigestCount === 1
    && crossRepetition.edit.intentDigestCount === 1
    && crossRepetition.edit.normalizedRuntimeRecordDigestCount === 1
    && crossRepetition.edit.geometryDigestCount === 1
    && crossRepetition.replayEdited.normalizedDigestCount === 1
    && crossRepetition.replayEdited.stableStageCount === 1
    && crossRepetition.normalizedAuthorDifferencePaths.length === 0;

  const summary = {
    pass: chains.every((chain) => chain.passed) && crossRepetitionPassed,
    repetitions,
    freshProcesses: repetitions * 4,
    package: {
      name: packageJson.name,
      version: packageJson.version,
      exportTarget: packageEntry,
      entryByteLength: entryStats.size,
      entrySha256: entryDigest,
      distKernelFileCount: distDigest.fileCount,
      distKernelSha256: distDigest.digest,
    },
    normalizationRules: [
      'features[*].timestamp',
      'features[type=S].persistentData.lastSketchChanged',
      'referenceSnapshots.*.sourceUuid',
      'referenceSnapshots.*.sourceTimestamp',
    ],
    crossRepetition,
    lifecycle: {
      naturalExitByChain: chains.map((chain) => chain.processExit),
      allWorkersRequiredForcedTermination: chains.every((chain) => (
        Object.values(chain.processExit).every((naturalExit) => !naturalExit)
      )),
    },
    representativeRecords: {
      originalIntent: chains[0].author.intent,
      editedIntent: chains[0].edit.intent,
      originalConstraints: chains[0].author.runtime.constraints,
      editedConstraints: chains[0].edit.runtime.constraints,
      originalMeasurement: chains[0].author.measurement,
      editedMeasurement: chains[0].edit.measurement,
    },
    chains: fullOutput ? chains : chains.map((chain) => ({
      author: stageSummary(chain.author),
      replay: stageSummary(chain.replay),
      edit: stageSummary(chain.edit),
      replayEdited: stageSummary(chain.replayEdited),
      comparisons: chain.comparisons,
      differencePaths: chain.differencePaths,
      passed: chain.passed,
    })),
  };

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.pass) process.exitCode = 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
