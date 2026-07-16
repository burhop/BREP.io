import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
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

const RESULT_PREFIX = 'PHASE0_RESULT ';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const workerSource = join(scriptDir, 'fixtures', 'headlessPackageWorker.mjs');

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
  files.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));

  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(root, file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return { digest: hash.digest('hex'), fileCount: files.length };
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

function unique(values) {
  return [...new Set(values)];
}

async function spawnWorker(workerPath, consumerRoot, args) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [workerPath, ...args], {
      cwd: consumerRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let result = null;
    let forcedTermination = false;
    let graceTimer = null;
    let hardTimer = null;

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
        // Wait for the rest of a split stdout chunk.
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
    hardTimer = setTimeout(() => {
      forcedTermination = true;
      child.kill();
    }, 120_000);
    child.on('close', (code, signal) => {
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      findResult();
      if (!result) {
        reject(new Error(
          `Worker ${args[0]} did not produce a result (code=${code}, signal=${signal}).\n${stderr}\n${stdout}`,
        ));
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

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const repetitions = parseRepetitions(process.argv.slice(2));
const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
const packageEntry = packageJson.exports['.'];
const entryPath = resolve(repoRoot, packageEntry);
const entryStats = await stat(entryPath);
const entryDigest = sha256(await readFile(entryPath));
const distDigest = await digestTree(join(repoRoot, 'dist-kernel'));

const tempRoot = await mkdtemp(join(tmpdir(), 'brep-phase0-headless-'));
try {
  const consumerRoot = join(tempRoot, 'consumer');
  const nodeModules = join(consumerRoot, 'node_modules');
  const packageLink = join(nodeModules, packageJson.name);
  const workerPath = join(consumerRoot, 'headlessPackageWorker.mjs');
  await mkdir(nodeModules, { recursive: true });
  await symlink(repoRoot, packageLink, process.platform === 'win32' ? 'junction' : 'dir');
  await copyFile(workerSource, workerPath);

  const runs = [];
  for (let index = 0; index < repetitions; index += 1) {
    const authoredPath = join(tempRoot, `authored-${index}.json`);
    const replayedPath = join(tempRoot, `replayed-${index}.json`);
    const authored = await spawnWorker(workerPath, consumerRoot, [
      'author',
      '',
      authoredPath,
      'repeat',
    ]);
    const replayed = await spawnWorker(workerPath, consumerRoot, [
      'replay',
      authoredPath,
      replayedPath,
      '',
    ]);
    runs.push({ authored, replayed });
  }

  const concurrent = await spawnWorker(workerPath, consumerRoot, ['concurrent', '', '', '']);
  const firstAuthored = runs[0].authored.result;
  const authoredNormalizedDigests = runs.map(
    (run) => run.authored.result.normalizedSerializationDigest,
  );
  const replayedNormalizedDigests = runs.map(
    (run) => run.replayed.result.normalizedSerializationDigest,
  );
  const authoredRecordDigests = runs.flatMap((run) => [
    run.authored.result.authoredRecordsDigest,
    run.replayed.result.authoredRecordsDigest,
  ]);
  const measurementRecords = runs.flatMap((run) => [
    run.authored.result.measurements,
    run.replayed.result.measurements,
  ]);
  const allProcesses = [
    ...runs.flatMap((run) => [run.authored, run.replayed]),
    concurrent,
  ];
  const identity = concurrent.result.identity;
  const isolationPassed = [
    identity.sceneShared,
    identity.featureRegistryShared,
    identity.assemblyConstraintRegistryShared,
    identity.pmiViewsManagerShared,
    identity.simulationStateManagerShared,
    identity.camPlanManagerShared,
    identity.sheet2DManagerShared,
    identity.wireHarnessManagerShared,
    identity.metadataManagerShared,
  ].every((value) => value === false)
    && identity.primitiveFeatureClassShared === true
    && concurrent.result.historyA.measurements.volume === 24
    && concurrent.result.historyB.measurements.volume === 210
    && sameJson(concurrent.result.historyA.events, ['run:P.CU1', 'after'])
    && sameJson(concurrent.result.historyB.events, ['run:P.CU1', 'after'])
    && concurrent.result.historyA.metadata.phase0Label === 'concurrent-a'
    && concurrent.result.historyB.metadata.phase0Label === 'concurrent-b';
  const roundTripsPassed = runs.every((run) => (
    run.authored.result.normalizedSerializationDigest
      === run.replayed.result.normalizedSerializationDigest
    && run.authored.result.authoredRecordsDigest === run.replayed.result.authoredRecordsDigest
    && sameJson(run.authored.result.measurements, run.replayed.result.measurements)
  ));
  const repetitionsPassed = unique(authoredNormalizedDigests).length === 1
    && unique(replayedNormalizedDigests).length === 1
    && unique(authoredRecordDigests).length === 1
    && measurementRecords.every((record) => sameJson(record, firstAuthored.measurements));

  const summary = {
    pass: roundTripsPassed && repetitionsPassed && isolationPassed,
    repetitions,
    package: {
      name: packageJson.name,
      version: packageJson.version,
      exportSpecifier: packageJson.name,
      exportTarget: packageEntry,
      entryByteLength: entryStats.size,
      entrySha256: entryDigest,
      distKernelFileCount: distDigest.fileCount,
      distKernelSha256: distDigest.digest,
      manifoldBuildSource: firstAuthored.package.manifoldBuildSource,
      manifoldHasCustomExtensions: firstAuthored.package.manifoldHasCustomExtensions,
    },
    roundTrip: {
      passed: roundTripsPassed,
      rawSerializationDigests: runs.flatMap((run) => [
        run.authored.result.rawSerializationDigest,
        run.replayed.result.rawSerializationDigest,
      ]),
      normalizedSerializationDigests: unique([
        ...authoredNormalizedDigests,
        ...replayedNormalizedDigests,
      ]),
      authoredRecordsDigests: unique(authoredRecordDigests),
      measurements: firstAuthored.measurements,
    },
    repetition: {
      passed: repetitionsPassed,
      authoredProcesses: repetitions,
      replayProcesses: repetitions,
    },
    concurrency: {
      passed: isolationPassed,
      ...concurrent.result,
    },
    lifecycle: {
      naturalExitCount: allProcesses.filter((processResult) => processResult.naturalExit).length,
      forcedTerminationCount: allProcesses.filter(
        (processResult) => processResult.forcedTermination,
      ).length,
      activeResourceSets: unique(
        allProcesses.map((processResult) => JSON.stringify(processResult.result.activeResources)),
      ).map(JSON.parse),
    },
    normalization: {
      canonicalPropertyOrder: true,
      featureTimestampReplacedWithNull: true,
      noOtherFieldsRemoved: true,
    },
  };

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.pass) process.exitCode = 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
