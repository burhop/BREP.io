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

const RESULT_PREFIX = 'PHASE0_SKETCH_OBSERVABILITY_RESULT ';
const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const repoRoot = resolve(scriptDir, '..');
const TOLERANCE = 1e-5;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
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

function geometry(id, points) {
  return { id, type: 'line', points, construction: false };
}

function constraint(id, type, points, value) {
  return { id, type, points, ...(value === undefined ? {} : { value }) };
}

function cases() {
  return [
    {
      name: 'valid_fully_constrained',
      expected: 'valid',
      sketch: {
        points: [point(0, 0, 0), point(1, 5, 0)],
        geometries: [geometry(1, [0, 1])],
        constraints: [
          constraint(0, '⏚', [0]),
          constraint(1, '━', [0, 1]),
          constraint(2, '⟺', [0, 1], 5),
        ],
      },
    },
    {
      name: 'under_constrained',
      expected: 'under_constrained',
      sketch: {
        points: [point(0, 0, 0), point(1, 5, 1)],
        geometries: [geometry(1, [0, 1])],
        constraints: [],
      },
    },
    {
      name: 'over_constrained_redundant',
      expected: 'over_constrained',
      sketch: {
        points: [point(0, 0, 0), point(1, 5, 0)],
        geometries: [geometry(1, [0, 1])],
        constraints: [
          constraint(0, '⏚', [0]),
          constraint(1, '━', [0, 1]),
          constraint(2, '⟺', [0, 1], 5),
          constraint(3, '⟺', [0, 1], 5),
        ],
      },
    },
    {
      name: 'contradictory_fixed_distance',
      expected: 'contradictory',
      sketch: {
        points: [point(0, 0, 0), point(1, 1, 0)],
        geometries: [geometry(1, [0, 1])],
        constraints: [
          constraint(0, '⏚', [0]),
          constraint(1, '⏚', [1]),
          constraint(2, '⟺', [0, 1], 2),
        ],
      },
    },
    {
      name: 'near_degenerate_point_line',
      expected: 'near_degenerate',
      sketch: {
        points: [point(0, 0, 0), point(1, 1e-9, 0), point(2, 1, 1)],
        geometries: [geometry(1, [0, 1])],
        constraints: [
          constraint(0, '⏚', [0]),
          constraint(1, '⏚', [1]),
          constraint(2, '↥', [0, 1, 2], 1),
        ],
      },
    },
  ];
}

function clone(value) {
  return structuredClone(value);
}

function pointMap(points) {
  return new Map(points.map((entry) => [entry.id, entry]));
}

function distance(left, right) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function residualVector(authored, solved) {
  const authoredPoints = pointMap(authored.points);
  const solvedPoints = pointMap(solved.points);
  const residuals = [];
  for (const entry of authored.constraints) {
    const points = entry.points.map((id) => solvedPoints.get(id));
    if (entry.type === '⏚') {
      const original = authoredPoints.get(entry.points[0]);
      residuals.push(points[0].x - original.x, points[0].y - original.y);
    } else if (entry.type === '━') {
      residuals.push(points[1].y - points[0].y);
    } else if (entry.type === '│') {
      residuals.push(points[1].x - points[0].x);
    } else if (entry.type === '≡') {
      residuals.push(points[1].x - points[0].x, points[1].y - points[0].y);
    } else if (entry.type === '⟺') {
      residuals.push(distance(points[0], points[1]) - Number(entry.value));
    } else if (entry.type === '↥') {
      const [lineStart, lineEnd, target] = points;
      const dx = lineEnd.x - lineStart.x;
      const dy = lineEnd.y - lineStart.y;
      const length = Math.hypot(dx, dy);
      const lineDistance = length === 0
        ? Number.POSITIVE_INFINITY
        : Math.abs((dx * (lineStart.y - target.y)) - ((lineStart.x - target.x) * dy))
          / length;
      residuals.push(lineDistance - Math.abs(Number(entry.value)));
    }
  }
  return residuals;
}

function withCoordinates(sketch, coordinates) {
  const next = clone(sketch);
  for (let index = 0; index < next.points.length; index += 1) {
    next.points[index].x = coordinates[index * 2];
    next.points[index].y = coordinates[(index * 2) + 1];
  }
  return next;
}

function matrixRank(matrix, threshold = 1e-7) {
  if (!matrix.length || !matrix[0]?.length) return 0;
  const work = matrix.map((row) => row.slice());
  let rank = 0;
  for (let column = 0; column < work[0].length && rank < work.length; column += 1) {
    let pivot = rank;
    for (let row = rank + 1; row < work.length; row += 1) {
      if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) pivot = row;
    }
    if (Math.abs(work[pivot][column]) <= threshold) continue;
    [work[rank], work[pivot]] = [work[pivot], work[rank]];
    const divisor = work[rank][column];
    for (let index = column; index < work[rank].length; index += 1) {
      work[rank][index] /= divisor;
    }
    for (let row = 0; row < work.length; row += 1) {
      if (row === rank) continue;
      const factor = work[row][column];
      for (let index = column; index < work[row].length; index += 1) {
        work[row][index] -= factor * work[rank][index];
      }
    }
    rank += 1;
  }
  return rank;
}

function independentAnalysis(authored, solved) {
  const coordinates = solved.points.flatMap((entry) => [entry.x, entry.y]);
  const base = residualVector(authored, solved);
  const residualsAreFinite = base.every(Number.isFinite);
  const step = 1e-6;
  const jacobian = base.map(() => Array(coordinates.length).fill(0));
  for (let column = 0; column < coordinates.length; column += 1) {
    const perturbed = coordinates.slice();
    perturbed[column] += step;
    const residuals = residualVector(authored, withCoordinates(solved, perturbed));
    for (let row = 0; row < base.length; row += 1) {
      jacobian[row][column] = (residuals[row] - base[row]) / step;
    }
  }
  const rank = residualsAreFinite ? matrixRank(jacobian) : null;
  const maxResidual = base.length
    ? Math.max(...base.map((value) => Math.abs(value)))
    : 0;
  return {
    variableCount: coordinates.length,
    equationCount: base.length,
    rank,
    degreesOfFreedom: rank === null ? null : coordinates.length - rank,
    redundantEquationCount: rank === null ? null : Math.max(0, base.length - rank),
    residuals: base.map((value) => Number.isFinite(value) ? roundNumber(value) : String(value)),
    maxResidual: Number.isFinite(maxResidual) ? roundNumber(maxResidual) : String(maxResidual),
    residualsAreFinite,
    withinTolerance: residualsAreFinite && maxResidual <= TOLERANCE,
  };
}

function publicObservation(solved) {
  const constraints = solved.constraints.map((entry) => ({
    id: entry.id,
    type: entry.type,
    status: entry.status ?? null,
    error: entry.error ?? null,
  }));
  return {
    outputKeys: Object.keys(solved).sort(),
    constraints,
    allConstraintsSaySolved:
      constraints.length > 0 && constraints.every((entry) => entry.status === 'solved'),
    hasConstraintError: constraints.some((entry) => typeof entry.error === 'string'),
    aggregateStatusPresent: Object.prototype.hasOwnProperty.call(solved, 'status'),
    residualPresent: Object.prototype.hasOwnProperty.call(solved, 'residual'),
    degreesOfFreedomPresent:
      Object.prototype.hasOwnProperty.call(solved, 'degreesOfFreedom'),
  };
}

function evaluateCase(definition, solved) {
  const independent = independentAnalysis(definition.sketch, solved);
  const observation = publicObservation(solved);
  let passed = false;
  if (definition.expected === 'valid') {
    passed = independent.withinTolerance
      && independent.degreesOfFreedom === 0
      && independent.redundantEquationCount === 0
      && !observation.hasConstraintError;
  } else if (definition.expected === 'under_constrained') {
    passed = independent.withinTolerance
      && independent.degreesOfFreedom > 0
      && !observation.aggregateStatusPresent
      && !observation.degreesOfFreedomPresent;
  } else if (definition.expected === 'over_constrained') {
    passed = independent.withinTolerance
      && independent.redundantEquationCount > 0
      && !observation.hasConstraintError
      && !observation.aggregateStatusPresent;
  } else if (definition.expected === 'contradictory') {
    passed = !independent.withinTolerance
      && observation.hasConstraintError
      && observation.allConstraintsSaySolved;
  } else if (definition.expected === 'near_degenerate') {
    passed = !independent.withinTolerance
      && !observation.hasConstraintError
      && observation.allConstraintsSaySolved;
  }
  return {
    name: definition.name,
    expected: definition.expected,
    solved: canonicalize(solved),
    publicObservation: observation,
    independent,
    passed,
  };
}

async function workerMain(args) {
  const [orderName] = args;
  const kernel = await import('brep-io-kernel');
  const definitions = cases();
  if (orderName === 'reverse') definitions.reverse();
  const results = definitions.map((definition) => {
    const solved = new kernel.ConstraintEngine(clone(definition.sketch)).solve(2000);
    return evaluateCase(definition, solved);
  }).sort((left, right) => left.name.localeCompare(right.name));
  const result = {
    order: orderName,
    enginePrototypeMethods: Object.getOwnPropertyNames(kernel.ConstraintEngine.prototype).sort(),
    solverAnalysisMethods: Object.getOwnPropertyNames(kernel.ConstraintSolver.prototype)
      .filter((name) => /analy|residual|degree|status/i.test(name))
      .sort(),
    constraintTolerance: kernel.constraints.tolerance,
    cases: results,
    digest: sha256(results),
    pass: results.every((entry) => entry.passed),
  };
  console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
}

function parseRepetitions(args) {
  const index = args.indexOf('--repetitions');
  if (index < 0) return 20;
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

async function spawnWorker(workerPath, consumerRoot, order) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [workerPath, '--worker', order], {
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
        // Wait for the complete marker line.
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
          `Solver worker produced no result (code=${code}, signal=${signal}).\n${stderr}\n${stdout}`,
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
  const tempRoot = await mkdtemp(join(tmpdir(), 'brep-phase0-sketch-observability-'));
  try {
    const consumerRoot = join(tempRoot, 'consumer');
    const nodeModules = join(consumerRoot, 'node_modules');
    const workerPath = join(consumerRoot, 'sketchObservabilityWorker.mjs');
    await mkdir(nodeModules, { recursive: true });
    await symlink(
      repoRoot,
      join(nodeModules, packageJson.name),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await copyFile(scriptPath, workerPath);

    const runs = [];
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      runs.push(await spawnWorker(
        workerPath,
        consumerRoot,
        repetition % 2 === 0 ? 'forward' : 'reverse',
      ));
    }
    const digests = new Set(runs.map((run) => run.result.digest));
    const representative = runs[0].result;
    const summary = {
      pass: representative.pass
        && runs.every((run) => run.result.pass)
        && digests.size === 1,
      repetitions,
      freshProcesses: repetitions,
      caseExecutions: repetitions * representative.cases.length,
      forwardRuns: runs.filter((run) => run.result.order === 'forward').length,
      reverseRuns: runs.filter((run) => run.result.order === 'reverse').length,
      digestCount: digests.size,
      resultDigest: representative.digest,
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
      enginePrototypeMethods: representative.enginePrototypeMethods,
      solverAnalysisMethods: representative.solverAnalysisMethods,
      constraintTolerance: representative.constraintTolerance,
      cases: representative.cases,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.pass) process.exitCode = 1;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (args[0] === '--worker') await workerMain(args.slice(1));
else await controllerMain(args);
