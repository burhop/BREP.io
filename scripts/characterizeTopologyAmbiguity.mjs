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
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const RESULT_PREFIX = 'PHASE0_TOPOLOGY_AMBIGUITY_RESULT ';
const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const repoRoot = resolve(scriptDir, '..');
const SIDEWALL_PREFIX = 'E2:S1:';

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

function roundVector(vector) {
  return vector.toArray().map(roundNumber);
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

async function createHistory(kernel) {
  const history = new kernel.PartHistory();
  history.metadataManager.metadata = {
    phase0Label: 'topology-ambiguity',
    intentVersion: 1,
  };
  const sketch = await history.newFeature('S');
  Object.assign(sketch.inputParams, {
    id: 'S1',
    sketchPlane: null,
    curveResolution: 32,
  });
  sketch.persistentData = { sketch: rectangleSketch() };

  const extrude = await history.newFeature('E');
  Object.assign(extrude.inputParams, {
    id: 'E2',
    profile: 'S1:PROFILE',
    consumeProfileSketch: true,
    distance: 5,
    distanceBack: 0,
    boolean: { targets: [], operation: 'NONE' },
  });
  return history;
}

function feature(history, id) {
  const found = history.features.find((entry) => entry.inputParams?.id === id);
  if (!found) throw new Error(`Feature ${id} is missing.`);
  return found;
}

function sketchData(history) {
  const sketch = feature(history, 'S1').persistentData?.sketch;
  if (!sketch) throw new Error('Sketch S1 data is missing.');
  return sketch;
}

function applySplit(history) {
  const sketch = sketchData(history);
  const first = sketch.geometries.find((entry) => entry.id === 1);
  first.points = [1, 9];
  sketch.points.push(point(9, 5, 2), point(10, 5, 2));
  const index = sketch.geometries.indexOf(first);
  sketch.geometries.splice(index + 1, 0, {
    id: 5,
    type: 'line',
    points: [10, 2],
    construction: false,
  });
  sketch.constraints.push({ id: 5, type: '≡', points: [9, 10] });
}

function applyMerge(history) {
  const sketch = sketchData(history);
  const first = sketch.geometries.find((entry) => entry.id === 1);
  first.points = [1, 2];
  sketch.geometries = sketch.geometries.filter((entry) => entry.id !== 5);
  sketch.constraints = sketch.constraints.filter((entry) => entry.id !== 5);
  sketch.points = sketch.points.filter((entry) => ![9, 10].includes(entry.id));
}

function applyEdit(history, caseName) {
  const sketch = sketchData(history);
  if (caseName === 'distance_only') {
    feature(history, 'E2').inputParams.distance = 7;
  } else if (caseName === 'record_reorder') {
    sketch.geometries.reverse();
    sketch.constraints.reverse();
  } else if (caseName === 'split_edge') {
    applySplit(history);
  } else if (caseName === 'delete_edge') {
    const diagonal = sketch.geometries.find((entry) => entry.id === 3);
    diagonal.points = [5, 8];
    sketch.geometries = sketch.geometries.filter((entry) => entry.id !== 4);
    sketch.constraints = sketch.constraints.filter((entry) => entry.id !== 3);
  } else if (caseName === 'renumber_edges') {
    const first = sketch.geometries.find((entry) => entry.id === 1);
    const third = sketch.geometries.find((entry) => entry.id === 3);
    first.id = 3;
    third.id = 1;
  } else if (caseName === 'duplicate_edge') {
    const first = sketch.geometries.find((entry) => entry.id === 1);
    sketch.geometries.splice(1, 0, { ...structuredClone(first), id: 5 });
  } else {
    throw new Error(`Unknown edit case ${caseName}.`);
  }
  history.metadataManager.metadata = {
    phase0Label: 'topology-ambiguity',
    intentVersion: 2,
    editCase: caseName,
  };
}

function parentSolidName(object) {
  let cursor = object;
  for (let guard = 0; cursor && guard < 32; guard += 1) {
    if (String(cursor.type).toUpperCase() === 'SOLID') return cursor.name || null;
    cursor = cursor.parentSolid || cursor.parent || null;
  }
  return null;
}

function faceArea(face, kernel) {
  const position = face?.geometry?.getAttribute?.('position');
  if (!position || position.itemSize !== 3) return null;
  face.updateWorldMatrix?.(true, false);
  const index = face.geometry.getIndex?.();
  const count = index ? index.count : position.count;
  const a = new kernel.BREP.THREE.Vector3();
  const b = new kernel.BREP.THREE.Vector3();
  const c = new kernel.BREP.THREE.Vector3();
  const ab = new kernel.BREP.THREE.Vector3();
  const ac = new kernel.BREP.THREE.Vector3();
  let area = 0;
  for (let offset = 0; offset + 2 < count; offset += 3) {
    const ids = index
      ? [index.getX(offset), index.getX(offset + 1), index.getX(offset + 2)]
      : [offset, offset + 1, offset + 2];
    a.set(position.getX(ids[0]), position.getY(ids[0]), position.getZ(ids[0]))
      .applyMatrix4(face.matrixWorld);
    b.set(position.getX(ids[1]), position.getY(ids[1]), position.getZ(ids[1]))
      .applyMatrix4(face.matrixWorld);
    c.set(position.getX(ids[2]), position.getY(ids[2]), position.getZ(ids[2]))
      .applyMatrix4(face.matrixWorld);
    area += ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2;
  }
  return roundNumber(area);
}

function selectedMetadata(solid, name) {
  const metadata = solid.getFaceMetadata?.(name) || {};
  const selected = {};
  for (const key of ['faceRole', 'faceType', 'sourceEdgeName', 'sourceFeatureId', 'type']) {
    if (metadata[key] !== undefined) selected[key] = metadata[key];
  }
  return canonicalize(selected);
}

function faceSnapshot(history, solid, name, kernel) {
  const face = history.getObjectByName(name);
  if (!face || String(face.type).toUpperCase() !== 'FACE') return null;
  face.updateWorldMatrix?.(true, false);
  const bounds = new kernel.BREP.THREE.Box3().setFromObject(face);
  const normal = face.getAverageNormal?.()?.clone?.() || new kernel.BREP.THREE.Vector3();
  const neighbors = [];
  for (const edge of solid.getBoundaryEdgePolylines?.() || []) {
    if (edge.faceA === name && edge.faceB) neighbors.push(String(edge.faceB));
    else if (edge.faceB === name && edge.faceA) neighbors.push(String(edge.faceA));
  }
  neighbors.sort();
  const metadata = selectedMetadata(solid, name);
  const geometry = canonicalize({
    area: faceArea(face, kernel),
    bounds: { min: roundVector(bounds.min), max: roundVector(bounds.max) },
    center: roundVector(bounds.getCenter(new kernel.BREP.THREE.Vector3())),
    normal: roundVector(normal.normalize()),
  });
  const extents = geometry.bounds.max
    .map((value, index) => roundNumber(value - geometry.bounds.min[index]))
    .sort((left, right) => left - right);
  const geometricClass = canonicalize({
    faceType: metadata.faceType || null,
    area: geometry.area,
    extents,
    boundaryCount: neighbors.length,
  });
  const adjacencyRoles = neighbors.map((neighbor) => neighbor.split(':').at(-1)).sort();
  return canonicalize({
    name,
    type: String(face.type).toUpperCase(),
    parentSolidName: parentSolidName(face),
    metadata,
    neighbors,
    adjacencyRoles,
    geometry,
    geometryDigest: sha256(geometry),
    geometricClass,
    geometricClassDigest: sha256(geometricClass),
    roleDigest: sha256({
      type: String(face.type).toUpperCase(),
      parentSolidName: parentSolidName(face),
      metadata,
    }),
    signatureDigest: sha256({
      type: String(face.type).toUpperCase(),
      parentSolidName: parentSolidName(face),
      metadata,
      adjacencyRoles,
      geometry,
    }),
  });
}

function topologySnapshot(history, kernel) {
  const solid = history.getObjectByName('E2');
  if (!solid || String(solid.type).toUpperCase() !== 'SOLID') return null;
  const faceNames = [...solid.getFaceNames()].sort();
  const faces = faceNames.map((name) => faceSnapshot(history, solid, name, kernel));
  return canonicalize({
    solidName: solid.name,
    faceNames,
    faces,
    faceCount: faces.length,
    volume: roundNumber(solid.volume()),
    surfaceArea: roundNumber(solid.surfaceArea()),
    triangleCount: solid.getTriangleCount(),
    digest: sha256(faces),
  });
}

function faceByName(snapshot, name) {
  return snapshot?.faces?.find((entry) => entry.name === name) || null;
}

function compareReference(before, after, name, declaredRolePreservation = false) {
  const expected = faceByName(before, name);
  if (!expected) throw new Error(`Baseline reference ${name} is missing.`);
  const exact = faceByName(after, name);
  const geometryCandidates = (after?.faces || [])
    .filter((entry) => entry.geometryDigest === expected.geometryDigest)
    .map((entry) => entry.name)
    .sort();
  const roleCandidates = (after?.faces || [])
    .filter((entry) => entry.roleDigest === expected.roleDigest)
    .map((entry) => entry.name)
    .sort();
  const geometricClassCandidates = (after?.faces || [])
    .filter((entry) => entry.geometricClassDigest === expected.geometricClassDigest)
    .map((entry) => entry.name)
    .sort();
  let outcome;
  if (exact?.signatureDigest === expected.signatureDigest) outcome = 'preserved_exact';
  else if (declaredRolePreservation && exact?.roleDigest === expected.roleDigest) {
    outcome = 'preserved_declared_role';
  } else if (exact) outcome = 'changed_fail_closed';
  else if (geometryCandidates.length > 1 || roleCandidates.length > 1) outcome = 'ambiguous';
  else if (geometryCandidates.length === 1 || roleCandidates.length === 1) {
    outcome = 'explicit_rebind_required';
  } else outcome = 'broken';
  return canonicalize({
    reference: name,
    outcome,
    exactNameResolved: !!exact,
    signaturePreserved: exact?.signatureDigest === expected.signatureDigest,
    rolePreserved: exact?.roleDigest === expected.roleDigest,
    geometryCandidates,
    geometricClassCandidates,
    roleCandidates,
    before: expected,
    after: exact,
  });
}

function resultPass(caseName, comparison, topology, error) {
  if (caseName === 'distance_only') {
    return !error && comparison.outcome === 'preserved_declared_role';
  }
  if (caseName === 'record_reorder') {
    return !error && comparison.outcome === 'preserved_exact';
  }
  if (caseName === 'split_edge') {
    return !error
      && ['broken', 'explicit_rebind_required', 'ambiguous'].includes(comparison.outcome)
      && topology.faceNames.includes(`${SIDEWALL_PREFIX}PROFILE_SW`)
      && !topology.faceNames.includes(`${SIDEWALL_PREFIX}G1_SW`);
  }
  if (caseName === 'renumber_edges') {
    return !error && comparison.outcome === 'changed_fail_closed';
  }
  if (caseName === 'merge_edge') {
    return !error
      && ['broken', 'explicit_rebind_required', 'ambiguous'].includes(comparison.outcome)
      && !topology.faceNames.includes(`${SIDEWALL_PREFIX}PROFILE_SW`)
      && topology.faceNames.includes(`${SIDEWALL_PREFIX}G1_SW`);
  }
  if (caseName === 'delete_edge') {
    return !error && ['broken', 'explicit_rebind_required', 'ambiguous'].includes(comparison.outcome);
  }
  if (caseName === 'duplicate_edge') {
    return !!error || !topology || topology.faceCount === 0 || topology.volume === 0;
  }
  return false;
}

function compactTopology(topology) {
  return topology && ({
    digest: topology.digest,
    faceCount: topology.faceCount,
    faceNames: topology.faceNames,
    volume: topology.volume,
    surfaceArea: topology.surfaceArea,
    triangleCount: topology.triangleCount,
  });
}

function compactCaseResult(result) {
  const comparison = result.comparison && ({
    reference: result.comparison.reference,
    outcome: result.comparison.outcome,
    exactNameResolved: result.comparison.exactNameResolved,
    signaturePreserved: result.comparison.signaturePreserved,
    rolePreserved: result.comparison.rolePreserved,
    geometryCandidates: result.comparison.geometryCandidates,
    geometricClassCandidates: result.comparison.geometricClassCandidates,
    roleCandidates: result.comparison.roleCandidates,
    beforeSignatureDigest: result.comparison.before?.signatureDigest || null,
    afterSignatureDigest: result.comparison.after?.signatureDigest || null,
  });
  return canonicalize({
    caseName: result.caseName,
    error: result.error,
    reference: result.reference,
    before: compactTopology(result.before),
    after: compactTopology(result.after),
    comparison,
    pass: result.pass,
  });
}

async function runEditedCase(history, kernel, caseName, baselineTopology) {
  let before = baselineTopology;
  let reference;
  if (caseName === 'merge_edge') {
    applySplit(history);
    await history.runHistory({ throwOnFeatureError: true });
    before = topologySnapshot(history, kernel);
    reference = before.faces.find((entry) => entry.metadata?.sourceEdgeName === 'S1:G1')?.name
      || before.faceNames.find((name) => name.includes(':G1_SW'))
      || before.faceNames.find((name) => name.endsWith(':PROFILE_SW'));
    if (!reference) {
      throw new Error(`Split topology has no face attributable to S1:G1: ${before.faceNames.join(', ')}`);
    }
    const splitSerialization = await history.toJSON();
    history = new kernel.PartHistory();
    await history.fromJSON(splitSerialization);
    applyMerge(history);
  } else {
    reference = caseName === 'delete_edge'
      ? `${SIDEWALL_PREFIX}G4_SW`
      : `${SIDEWALL_PREFIX}G1_SW`;
    applyEdit(history, caseName);
  }

  let error = null;
  try {
    await history.runHistory({ throwOnFeatureError: true });
  } catch (caught) {
    error = String(caught?.message || caught).split(/\r?\n/, 1)[0];
  }
  const after = topologySnapshot(history, kernel);
  const comparison = after
    ? compareReference(before, after, reference, caseName === 'distance_only')
    : null;
  const pass = resultPass(caseName, comparison, after, error);
  return canonicalize({
    caseName,
    error,
    reference,
    before,
    after,
    comparison,
    pass,
  });
}

async function workerMain(args) {
  const [mode, inputPath, outputPath, baselineTopologyPath] = args;
  const kernel = await import('brep-io-kernel');
  if (mode === 'author') {
    const history = await createHistory(kernel);
    await history.runHistory({ throwOnFeatureError: true });
    const serialized = await history.toJSON();
    await writeFile(outputPath, serialized, 'utf8');
    const result = {
      mode,
      topology: topologySnapshot(history, kernel),
      pass: true,
    };
    console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
    return;
  }
  const history = new kernel.PartHistory();
  await history.fromJSON(await readFile(inputPath, 'utf8'));
  const baselineTopology = JSON.parse(await readFile(baselineTopologyPath, 'utf8'));
  const result = await runEditedCase(history, kernel, mode, baselineTopology);
  await writeFile(outputPath, await history.toJSON(), 'utf8');
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
          `Topology worker produced no result (code=${code}, signal=${signal}).\n${stderr}\n${stdout}`,
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
  const tempRoot = await mkdtemp(join(tmpdir(), 'brep-phase0-topology-ambiguity-'));
  try {
    const consumerRoot = join(tempRoot, 'consumer');
    const nodeModules = join(consumerRoot, 'node_modules');
    const workerPath = join(consumerRoot, 'topologyAmbiguityWorker.mjs');
    const baselinePath = join(consumerRoot, 'baseline.json');
    const baselineTopologyPath = join(consumerRoot, 'baseline-topology.json');
    await mkdir(nodeModules, { recursive: true });
    await symlink(
      repoRoot,
      join(nodeModules, packageJson.name),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await copyFile(scriptPath, workerPath);
    const author = await spawnWorker(workerPath, consumerRoot, [
      'author',
      baselinePath,
      baselinePath,
      baselineTopologyPath,
    ]);
    await writeFile(baselineTopologyPath, JSON.stringify(author.result.topology), 'utf8');
    const caseNames = [
      'distance_only',
      'record_reorder',
      'split_edge',
      'merge_edge',
      'delete_edge',
      'renumber_edges',
      'duplicate_edge',
    ];
    const runs = [];
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const ordered = repetition % 2 === 0 ? caseNames : [...caseNames].reverse();
      for (const caseName of ordered) {
        const outputPath = join(consumerRoot, `${caseName}-${repetition}.json`);
        runs.push(await spawnWorker(workerPath, consumerRoot, [
          caseName,
          baselinePath,
          outputPath,
          baselineTopologyPath,
        ]));
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
        result: compactCaseResult(results[0].result),
      }];
    }));
    const allRuns = [author, ...runs];
    const summary = canonicalize({
      pass: Object.values(grouped).every((entry) => entry.pass),
      repetitions,
      freshProcesses: allRuns.length,
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
        naturalExitCount: allRuns.filter((run) => run.naturalExit).length,
        forcedTerminationCount: allRuns.filter((run) => !run.naturalExit).length,
      },
      baseline: compactTopology(author.result.topology),
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
