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

const RESULT_PREFIX = 'PHASE0_MEMORY_RESULT ';
const DEFAULT_CASES = [
  'import_default',
  'import_unref',
  'cube_no_cleanup',
  'cube_explicit_cleanup',
  'extrude_no_cleanup',
  'extrude_explicit_cleanup',
  'concurrent_explicit_cleanup',
  'cube_automatic_cleanup',
];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const workerSource = join(scriptDir, 'fixtures', 'headlessMemoryWorker.mjs');

function optionValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}

function parsePositiveInteger(value, name, minimum = 1) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}.`);
  }
  return parsed;
}

function parseOptions(args) {
  const repetitions = parsePositiveInteger(optionValue(args, '--repetitions', '2'), '--repetitions', 2);
  const cycles = parsePositiveInteger(optionValue(args, '--cycles', '40'), '--cycles', 4);
  const automaticWaitMs = parsePositiveInteger(
    optionValue(args, '--automatic-wait-ms', '61250'),
    '--automatic-wait-ms',
    60_100,
  );
  const cases = String(optionValue(args, '--cases', DEFAULT_CASES.join(',')))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const unknown = cases.filter((caseName) => !DEFAULT_CASES.includes(caseName));
  if (unknown.length) throw new Error(`Unknown cases: ${unknown.join(', ')}`);
  return { repetitions, cycles, automaticWaitMs, cases, summaryOnly: args.includes('--summary-only') };
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

function snapshotByLabel(result, label) {
  return result.snapshots?.find((snapshot) => snapshot.label === label) || null;
}

function finalSnapshot(result) {
  return result.snapshots?.at(-1) || result.snapshot || null;
}

function memoryDelta(start, end) {
  if (!start || !end) return null;
  return {
    rss: end.rss - start.rss,
    heapUsed: end.heapUsed - start.heapUsed,
    external: end.external - start.external,
    arrayBuffers: end.arrayBuffers - start.arrayBuffers,
    manifoldHeapBytes: end.manifoldHeapBytes - start.manifoldHeapBytes,
  };
}

function timerSequence(result) {
  return result.snapshots?.map((snapshot) => ({
    label: snapshot.label,
    cleanupTimers: snapshot.cleanupTimers,
  })) || [];
}

function memorySeries(result) {
  return result.snapshots?.map((snapshot) => ({
    label: snapshot.label,
    rss: snapshot.rss,
    heapUsed: snapshot.heapUsed,
    external: snapshot.external,
    arrayBuffers: snapshot.arrayBuffers,
    manifoldHeapBytes: snapshot.manifoldHeapBytes,
  })) || [];
}

function sampleResult(result) {
  const { snapshots: _snapshots, snapshot: _snapshot, ...sample } = result;
  return sample;
}

function stableSignature(run) {
  const result = run.result;
  return JSON.stringify({
    caseName: result.caseName,
    mode: result.mode,
    kind: result.kind,
    cleanup: result.cleanup,
    cyclesExecuted: result.cyclesExecuted,
    freedSolids: result.freedSolids,
    historiesIndependent: result.historiesIndependent,
    samples: result.samples,
    messaging: result.messaging,
    packageChannelCount: result.packageChannelCount,
    timers: timerSequence(result),
    naturalExit: run.naturalExit,
  });
}

function validateRun(caseName, run) {
  const result = run.result;
  if (caseName === 'import_default') {
    return !run.naturalExit
      && result.snapshot.cleanupTimers === 0
      && result.snapshot.activeResources.includes('MessagePort');
  }
  if (caseName === 'import_unref') {
    return run.naturalExit
      && result.packageChannelCount === 1
      && result.messaging?.packageReceived === true
      && result.messaging?.peerReceived === true
      && !result.snapshot.activeResources.includes('MessagePort');
  }

  const before = snapshotByLabel(result, 'before-final-cleanup');
  const after = finalSnapshot(result);
  const cycles = result.cyclesExecuted;
  if (!before || !after || !Number.isInteger(cycles)) return false;

  if (caseName.endsWith('_no_cleanup')) {
    return before.cleanupTimers === cycles
      && after.cleanupTimers === cycles
      && result.freedSolids === 0
      && !run.naturalExit;
  }
  if (caseName === 'cube_automatic_cleanup') {
    return before.cleanupTimers === cycles
      && after.cleanupTimers === 0
      && result.freedSolids === 0
      && !run.naturalExit;
  }
  if (caseName === 'concurrent_explicit_cleanup') {
    return before.cleanupTimers === 2
      && after.cleanupTimers === 0
      && result.freedSolids === cycles * 2
      && Object.values(result.historiesIndependent || {}).every(Boolean)
      && !run.naturalExit;
  }
  return before.cleanupTimers === 1
    && after.cleanupTimers === 0
    && result.freedSolids === cycles
    && !run.naturalExit;
}

async function spawnWorker(workerPath, consumerRoot, caseName, options) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [
      '--expose-gc',
      workerPath,
      caseName,
      String(options.cycles),
      String(options.automaticWaitMs),
    ], {
      cwd: consumerRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let result = null;
    let forcedTermination = false;
    let graceTimer = null;
    const hardTimeoutMs = options.automaticWaitMs + 90_000;
    const hardTimer = setTimeout(() => {
      forcedTermination = true;
      child.kill();
    }, hardTimeoutMs);

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
        }, 1_500);
      } catch {
        // Wait for a complete JSON result line.
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
          `Memory worker ${caseName} produced no result (code=${code}, signal=${signal}).\n${stderr}\n${stdout}`,
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

const options = parseOptions(process.argv.slice(2));
const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
const packageEntry = packageJson.exports['.'];
const entryPath = resolve(repoRoot, packageEntry);
const entryStats = await stat(entryPath);
const entryDigest = sha256(await readFile(entryPath));
const distDigest = await digestTree(join(repoRoot, 'dist-kernel'));
const tempRoot = await mkdtemp(join(tmpdir(), 'brep-phase0-memory-'));

try {
  const consumerRoot = join(tempRoot, 'consumer');
  const nodeModules = join(consumerRoot, 'node_modules');
  const workerPath = join(consumerRoot, 'headlessMemoryWorker.mjs');
  await mkdir(nodeModules, { recursive: true });
  await symlink(
    repoRoot,
    join(nodeModules, packageJson.name),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await copyFile(workerSource, workerPath);

  const cases = {};
  for (const caseName of options.cases) {
    const runs = caseName === 'cube_automatic_cleanup'
      ? await Promise.all(Array.from(
        { length: options.repetitions },
        () => spawnWorker(workerPath, consumerRoot, caseName, options),
      ))
      : [];
    if (caseName !== 'cube_automatic_cleanup') {
      for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
        runs.push(await spawnWorker(workerPath, consumerRoot, caseName, options));
      }
    }

    const passed = runs.every((run) => validateRun(caseName, run));
    cases[caseName] = {
      passed,
      stableInvariantsAcrossRepetitions: new Set(runs.map(stableSignature)).size === 1,
      repetitions: runs.map((run) => {
        const baseline = run.result.snapshots?.[0] || run.result.snapshot;
        const final = finalSnapshot(run.result);
        return {
          naturalExit: run.naturalExit,
          forcedTermination: run.forcedTermination,
          cyclesExecuted: run.result.cyclesExecuted ?? null,
          freedSolids: run.result.freedSolids ?? null,
          timerSequence: timerSequence(run.result),
          memorySeries: memorySeries(run.result),
          memoryDelta: memoryDelta(baseline, final),
          baseline,
          final,
        };
      }),
      sample: sampleResult(runs[0].result),
    };
  }

  const summary = {
    pass: Object.values(cases).every((entry) => (
      entry.passed && entry.stableInvariantsAcrossRepetitions
    )),
    options,
    package: {
      name: packageJson.name,
      version: packageJson.version,
      exportTarget: packageEntry,
      entryByteLength: entryStats.size,
      entrySha256: entryDigest,
      distKernelFileCount: distDigest.fileCount,
      distKernelSha256: distDigest.digest,
    },
    interpretationLimits: {
      manifoldHeapBytesIsCapacityNotLiveAllocation: true,
      inheritedInstanceDiagnosticsCoverOnlyInheritedEmbindClasses: true,
      processMemoryIsAllocatorAndGcSensitive: true,
    },
    evidence: Object.fromEntries(Object.entries(cases).map(([caseName, entry]) => [
      caseName,
      {
        passed: entry.passed,
        stableInvariantsAcrossRepetitions: entry.stableInvariantsAcrossRepetitions,
        runs: entry.repetitions.map((repetition) => ({
          naturalExit: repetition.naturalExit,
          cyclesExecuted: repetition.cyclesExecuted,
          freedSolids: repetition.freedSolids,
          initialCleanupTimers: repetition.timerSequence[0]?.cleanupTimers
            ?? repetition.baseline?.cleanupTimers
            ?? null,
          peakCleanupTimers: repetition.timerSequence.length
            ? Math.max(...repetition.timerSequence.map((snapshot) => snapshot.cleanupTimers))
            : repetition.final?.cleanupTimers ?? null,
          finalCleanupTimers: repetition.timerSequence.at(-1)?.cleanupTimers
            ?? repetition.final?.cleanupTimers
            ?? null,
          memoryDelta: repetition.memoryDelta,
          initialManifoldHeapBytes: repetition.baseline?.manifoldHeapBytes ?? null,
          finalManifoldHeapBytes: repetition.final?.manifoldHeapBytes ?? null,
        })),
      },
    ])),
    cases,
  };

  if (options.summaryOnly) {
    const { cases: _caseDetails, ...compactSummary } = summary;
    console.log(JSON.stringify(compactSummary, null, 2));
  } else {
    console.log(JSON.stringify(summary, null, 2));
  }
  if (!summary.pass) process.exitCode = 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
