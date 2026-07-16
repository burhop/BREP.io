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

const RESULT_PREFIX = 'PHASE0_LIFECYCLE_RESULT ';
const CASES = [
  'control',
  'import_only',
  'construct',
  'run_once',
  'measure_once',
  'measure_reset',
  'measure_free_reset',
  'remeasure_edits',
  'remeasure_free_between',
  'two_histories_measure',
];
const EXPECTED = {
  control: { messagePorts: 0, timeouts: 0, naturalExit: true },
  import_only: { messagePorts: 1, timeouts: 0, naturalExit: false },
  construct: { messagePorts: 1, timeouts: 0, naturalExit: false },
  run_once: { messagePorts: 1, timeouts: 0, naturalExit: false },
  measure_once: { messagePorts: 1, timeouts: 1, naturalExit: false },
  measure_reset: { messagePorts: 1, timeouts: 1, naturalExit: false },
  measure_free_reset: { messagePorts: 1, timeouts: 0, naturalExit: false },
  remeasure_edits: { messagePorts: 1, timeouts: 4, naturalExit: false },
  remeasure_free_between: { messagePorts: 1, timeouts: 1, naturalExit: false },
  two_histories_measure: { messagePorts: 1, timeouts: 2, naturalExit: false },
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const workerSource = join(scriptDir, 'fixtures', 'headlessLifecycleWorker.mjs');

function parseRepetitions(args) {
  const index = args.indexOf('--repetitions');
  if (index < 0) return 3;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 2) {
    throw new Error('--repetitions must be an integer of at least 2.');
  }
  return value;
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

function normalizeText(value, tempRoot) {
  return value
    .replaceAll('\\', '/')
    .replaceAll(repoRoot.replaceAll('\\', '/'), '<repo>')
    .replaceAll(tempRoot.replaceAll('\\', '/'), '<temp>');
}

function normalizeResult(value, tempRoot) {
  if (Array.isArray(value)) return value.map((item) => normalizeResult(item, tempRoot));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !['asyncId', 'triggerAsyncId'].includes(key))
        .map(([key, item]) => [key, normalizeResult(item, tempRoot)]),
    );
  }
  return typeof value === 'string' ? normalizeText(value, tempRoot) : value;
}

function resourceCounts(result) {
  return {
    messagePorts: result.resources.filter((resource) => resource.type === 'MESSAGEPORT').length,
    timeouts: result.resources.filter((resource) => resource.type === 'Timeout').length,
    timeoutDelays: result.resources
      .filter((resource) => resource.type === 'Timeout')
      .map((resource) => resource.requestedDelayMs)
      .sort((left, right) => left - right),
  };
}

function stableSignature(run) {
  return JSON.stringify({
    result: run.result,
    naturalExit: run.naturalExit,
    forcedTermination: run.forcedTermination,
  });
}

async function spawnWorker(workerPath, consumerRoot, caseName, tempRoot) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [workerPath, caseName], {
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
        result = normalizeResult(JSON.parse(line), tempRoot);
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
          `Lifecycle worker ${caseName} produced no result (code=${code}, signal=${signal}).\n${stderr}\n${stdout}`,
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

const repetitions = parseRepetitions(process.argv.slice(2));
const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
const packageEntry = packageJson.exports['.'];
const entryPath = resolve(repoRoot, packageEntry);
const entryStats = await stat(entryPath);
const entryDigest = sha256(await readFile(entryPath));
const distDigest = await digestTree(join(repoRoot, 'dist-kernel'));
const tempRoot = await mkdtemp(join(tmpdir(), 'brep-phase0-lifecycle-'));

try {
  const consumerRoot = join(tempRoot, 'consumer');
  const nodeModules = join(consumerRoot, 'node_modules');
  const workerPath = join(consumerRoot, 'headlessLifecycleWorker.mjs');
  await mkdir(nodeModules, { recursive: true });
  await symlink(
    repoRoot,
    join(nodeModules, packageJson.name),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await copyFile(workerSource, workerPath);

  const cases = {};
  for (const caseName of CASES) {
    const runs = [];
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      runs.push(await spawnWorker(workerPath, consumerRoot, caseName, tempRoot));
    }
    const expected = EXPECTED[caseName];
    const observed = runs.map((run) => ({
      ...resourceCounts(run.result),
      naturalExit: run.naturalExit,
      forcedTermination: run.forcedTermination,
    }));
    const passed = observed.every((item) => (
      item.messagePorts === expected.messagePorts
      && item.timeouts === expected.timeouts
      && item.naturalExit === expected.naturalExit
      && item.timeoutDelays.every((delayMs) => delayMs === 60_000)
    ));
    cases[caseName] = {
      passed,
      expected,
      observed,
      stableAcrossRepetitions: new Set(runs.map(stableSignature)).size === 1,
      sample: runs[0].result,
    };
  }

  const publicLifecycleMethods = cases.import_only.sample.publicLifecycleMethods;
  const summary = {
    pass: Object.values(cases).every((entry) => entry.passed && entry.stableAcrossRepetitions)
      && publicLifecycleMethods.includes('reset')
      && publicLifecycleMethods.includes('resetHistoryUndo')
      && !publicLifecycleMethods.includes('dispose'),
    repetitions,
    package: {
      name: packageJson.name,
      version: packageJson.version,
      exportTarget: packageEntry,
      entryByteLength: entryStats.size,
      entrySha256: entryDigest,
      distKernelFileCount: distDigest.fileCount,
      distKernelSha256: distDigest.digest,
    },
    publicLifecycleMethods,
    cases,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.pass) process.exitCode = 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
