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
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const RESULT_PREFIX = 'PHASE0_SIDEWALL_REFERENCE_RESULT ';
const SOURCE_FACE = 'E2:S1:G1_SW';
const SOURCE_FEATURE = 'E2';
const DEPENDENT_SKETCH = 'S3';
const DEPENDENT_FEATURE = 'E4';
const EXPECTED_SOURCE_ROLES = [
  'G1_SW',
  'G2_SW',
  'G3_SW',
  'G4_SW',
  'PROFILE_END',
  'PROFILE_START',
];
const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const repoRoot = resolve(scriptDir, '..');

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

function roundDeep(value) {
  if (Array.isArray(value)) return value.map(roundDeep);
  if (typeof value === 'number') return roundNumber(value);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, roundDeep(entry)]));
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

function makeRectangleSketch() {
  return {
    points: [
      { id: 0, x: 0, y: 0, fixed: true, construction: true, externalReference: false },
      { id: 1, x: 2, y: 2, fixed: false, construction: false, externalReference: false },
      { id: 2, x: 8, y: 2, fixed: false, construction: false, externalReference: false },
      { id: 3, x: 8, y: 2, fixed: false, construction: false, externalReference: false },
      { id: 4, x: 8, y: 8, fixed: false, construction: false, externalReference: false },
      { id: 5, x: 8, y: 8, fixed: false, construction: false, externalReference: false },
      { id: 6, x: 2, y: 8, fixed: false, construction: false, externalReference: false },
      { id: 7, x: 2, y: 8, fixed: false, construction: false, externalReference: false },
      { id: 8, x: 2, y: 2, fixed: false, construction: false, externalReference: false },
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

function makeCircleSketch() {
  return {
    points: [
      { id: 0, x: 0, y: 0, fixed: true, construction: true, externalReference: false },
      { id: 1, x: 1, y: 0, fixed: false, construction: false, externalReference: false },
    ],
    geometries: [
      { id: 1, type: 'circle', points: [0, 1], construction: false },
    ],
    constraints: [
      { id: 0, type: '⏚', points: [0] },
    ],
  };
}

async function createHistory(kernel) {
  const history = new kernel.PartHistory();
  history.metadataManager.metadata = {
    phase0Label: 'sidewall-reference-safety',
    intentVersion: 1,
  };

  const sketch1 = await history.newFeature('S');
  Object.assign(sketch1.inputParams, {
    id: 'S1',
    sketchPlane: null,
    curveResolution: 32,
  });
  sketch1.persistentData = { sketch: makeRectangleSketch() };

  const extrude1 = await history.newFeature('E');
  Object.assign(extrude1.inputParams, {
    id: SOURCE_FEATURE,
    profile: 'S1:PROFILE',
    consumeProfileSketch: true,
    distance: 10,
    distanceBack: 1,
    boolean: { targets: [], operation: 'NONE' },
  });

  const sketch2 = await history.newFeature('S');
  Object.assign(sketch2.inputParams, {
    id: DEPENDENT_SKETCH,
    sketchPlane: SOURCE_FACE,
    curveResolution: 32,
  });
  sketch2.persistentData = { sketch: makeCircleSketch() };

  const extrude2 = await history.newFeature('E');
  Object.assign(extrude2.inputParams, {
    id: DEPENDENT_FEATURE,
    profile: `${DEPENDENT_SKETCH}:PROFILE`,
    consumeProfileSketch: false,
    distance: 2,
    distanceBack: 1,
    boolean: { targets: [], operation: 'NONE' },
  });

  return history;
}

function editSourceSketch(history) {
  const sketchFeature = history.features.find((feature) => feature.type === 'S');
  const sketch = sketchFeature?.persistentData?.sketch;
  if (!sketch) throw new Error('Restored source sketch S1 is missing.');
  for (const point of sketch.points || []) {
    if ([2, 3, 4, 5].includes(point.id)) point.x = 10;
  }
  history.metadataManager.metadata = {
    phase0Label: 'sidewall-reference-safety',
    intentVersion: 2,
  };
}

function findFeature(serializable, id) {
  const feature = (serializable.features || []).find((entry) => entry.inputParams?.id === id);
  if (!feature) throw new Error(`Serialized feature ${id} is missing.`);
  return feature;
}

function authoredSketch(sketch) {
  return canonicalize({
    points: (sketch?.points || []).map((point) => ({
      id: point.id,
      x: roundNumber(point.x),
      y: roundNumber(point.y),
      fixed: !!point.fixed,
      construction: !!point.construction,
      externalReference: !!point.externalReference,
    })),
    geometries: (sketch?.geometries || []).map((geometry) => ({
      id: geometry.id,
      type: geometry.type,
      points: geometry.points,
      construction: !!geometry.construction,
    })),
    constraints: (sketch?.constraints || []).map((constraint) => ({
      id: constraint.id,
      type: constraint.type,
      points: constraint.points,
      value: constraint.value ?? null,
    })),
  });
}

function intentRecord(serializable) {
  const sourceSketch = findFeature(serializable, 'S1');
  const sourceExtrude = findFeature(serializable, SOURCE_FEATURE);
  const dependentSketch = findFeature(serializable, DEPENDENT_SKETCH);
  const dependentExtrude = findFeature(serializable, DEPENDENT_FEATURE);
  return canonicalize({
    idCounter: serializable.idCounter,
    metadata: serializable.metadata,
    sourceSketch: authoredSketch(sourceSketch.persistentData?.sketch),
    sourceExtrude: sourceExtrude.inputParams,
    dependentSketch: {
      inputParams: dependentSketch.inputParams,
      sketch: authoredSketch(dependentSketch.persistentData?.sketch),
    },
    dependentExtrude: dependentExtrude.inputParams,
  });
}

function semanticReferenceSnapshot(serializable) {
  const sketch = findFeature(serializable, DEPENDENT_SKETCH);
  const snapshot = sketch.persistentData?.referenceSnapshots?.sketchPlane?.[SOURCE_FACE];
  if (!snapshot) throw new Error(`Reference snapshot for ${SOURCE_FACE} is missing.`);
  return canonicalize(roundDeep({
    type: snapshot.type,
    edgePositions: snapshot.edgePositions,
    center: snapshot.center,
    normal: snapshot.normal,
    sourceFeatureId: snapshot.sourceFeatureId,
  }));
}

function collectVerticesWorld(object, kernel) {
  const position = object?.geometry?.getAttribute?.('position');
  if (!position || position.itemSize !== 3) return [];
  object.updateWorldMatrix?.(true, true);
  const point = new kernel.BREP.THREE.Vector3();
  const vertices = [];
  for (let index = 0; index < position.count; index += 1) {
    point
      .set(position.getX(index), position.getY(index), position.getZ(index))
      .applyMatrix4(object.matrixWorld);
    vertices.push(point.toArray().map(roundNumber));
  }
  return vertices;
}

function centroid(points) {
  const total = [0, 0, 0];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis += 1) total[axis] += Number(point[axis]);
  }
  return total.map((value) => roundNumber(value / points.length));
}

function polylineLength(points) {
  let length = 0;
  for (let index = 1; index < (points || []).length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    length += Math.hypot(
      Number(current[0]) - Number(previous[0]),
      Number(current[1]) - Number(previous[1]),
      Number(current[2]) - Number(previous[2]),
    );
  }
  return roundNumber(length);
}

function selectedFaceMetadata(solid, faceName) {
  const metadata = solid.getFaceMetadata?.(faceName) || {};
  const selected = {};
  for (const key of [
    'axis',
    'faceRole',
    'faceType',
    'height',
    'radius',
    'sourceEdgeName',
    'sourceFeatureId',
    'type',
  ]) {
    if (metadata[key] !== undefined) selected[key] = roundDeep(metadata[key]);
  }
  return canonicalize(selected);
}

function measureSolid(solid, kernel) {
  solid.updateMatrixWorld?.(true);
  const box = new kernel.BREP.THREE.Box3().setFromObject(solid);
  const faceNames = [...solid.getFaceNames()].sort();
  const boundaries = (solid.getBoundaryEdgePolylines() || []).map((edge) => {
    const faces = [String(edge.faceA), String(edge.faceB)].sort();
    return {
      name: String(edge.name),
      faceA: faces[0],
      faceB: faces[1],
      closedLoop: !!edge.closedLoop,
      length: polylineLength(edge.positions),
    };
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const labels = {
    faces: faceNames.map((name) => ({
      name,
      metadata: selectedFaceMetadata(solid, name),
    })),
    adjacency: boundaries.map(({ name, faceA, faceB, closedLoop }) => ({
      name,
      faceA,
      faceB,
      closedLoop,
    })),
  };
  return canonicalize({
    name: solid.name,
    bounds: {
      min: box.min.toArray().map(roundNumber),
      max: box.max.toArray().map(roundNumber),
      center: box.getCenter(new kernel.BREP.THREE.Vector3()).toArray().map(roundNumber),
    },
    volume: roundNumber(solid.volume()),
    surfaceArea: roundNumber(solid.surfaceArea()),
    triangleCount: solid.getTriangleCount(),
    faceNames,
    boundaries,
    labelDigest: sha256(labels),
    topologyGeometryDigest: sha256({ faces: labels.faces, boundaries }),
  });
}

function measureAttachment(history, serializable, kernel) {
  const sourceFace = history.getObjectByName(SOURCE_FACE);
  const profileFace = history.scene.getObjectByName(`${DEPENDENT_SKETCH}:PROFILE`);
  if (!sourceFace || sourceFace.type !== 'FACE') throw new Error(`Could not resolve ${SOURCE_FACE}.`);
  if (!profileFace || profileFace.type !== 'FACE') {
    throw new Error(`Could not resolve ${DEPENDENT_SKETCH}:PROFILE.`);
  }
  const sourceVertices = collectVerticesWorld(sourceFace, kernel);
  const profileVertices = collectVerticesWorld(profileFace, kernel);
  if (!sourceVertices.length || !profileVertices.length) throw new Error('Attachment vertices are missing.');

  const normalVector = sourceFace.getAverageNormal().clone().normalize();
  const normal = normalVector.toArray().map(roundNumber);
  const sourceCentroid = centroid(sourceVertices);
  const planePoint = new kernel.BREP.THREE.Vector3().fromArray(sourceVertices[0]);
  const boundsCenter = new kernel.BREP.THREE.Box3()
    .setFromObject(sourceFace)
    .getCenter(new kernel.BREP.THREE.Vector3());
  const projectedCenter = boundsCenter.clone().sub(
    normalVector.clone().multiplyScalar(boundsCenter.clone().sub(planePoint).dot(normalVector)),
  );
  const sketchFeature = findFeature(serializable, DEPENDENT_SKETCH);
  const basis = roundDeep(sketchFeature.persistentData?.basis);
  const basisOrigin = new kernel.BREP.THREE.Vector3().fromArray(basis.origin);

  const signedDistances = profileVertices.map((point) => (
    new kernel.BREP.THREE.Vector3().fromArray(point).sub(planePoint).dot(normalVector)
  ));
  const minDistance = Math.min(...signedDistances);
  const maxDistance = Math.max(...signedDistances);
  const meanDistance = signedDistances.reduce((sum, value) => sum + value, 0)
    / signedDistances.length;
  let parentSolid = sourceFace;
  for (let guard = 0; parentSolid && guard < 16; guard += 1) {
    if (String(parentSolid.type).toUpperCase() === 'SOLID') break;
    parentSolid = parentSolid.parentSolid || parentSolid.parent || null;
  }

  return canonicalize({
    resolvedName: sourceFace.name,
    resolvedType: sourceFace.type,
    owningFeatureID: sourceFace.owningFeatureID ?? null,
    parentSolidName: parentSolid?.name ?? null,
    sourceCentroid,
    sourceNormal: normal,
    basis,
    basisToProjectedFaceCenterDistance: roundNumber(basisOrigin.distanceTo(projectedCenter)),
    profilePlaneMeanDistance: roundNumber(meanDistance),
    profilePlaneSpread: roundNumber(maxDistance - minDistance),
  });
}

function vectorDelta(before, after) {
  return before.map((value, index) => roundNumber(after[index] - value));
}

async function workerMain(args) {
  const [mode, inputPath, outputPath] = args;
  const kernel = await import('brep-io-kernel');
  let history;
  if (mode === 'author') {
    history = await createHistory(kernel);
  } else {
    history = new kernel.PartHistory();
    await history.fromJSON(await readFile(inputPath, 'utf8'));
    if (mode === 'edit') editSourceSketch(history);
    else if (mode !== 'replay' && mode !== 'replay-edited') {
      throw new Error(`Unknown worker mode ${mode}.`);
    }
  }

  await history.runHistory({ throwOnFeatureError: true });
  const serialized = await history.toJSON();
  await writeFile(outputPath, serialized, 'utf8');
  const parsed = JSON.parse(serialized);
  const sourceSolid = history.getObjectByName(SOURCE_FEATURE);
  const dependentSolid = history.getObjectByName(DEPENDENT_FEATURE);
  if (!sourceSolid || !dependentSolid) throw new Error('Expected source and dependent solids.');

  const intent = intentRecord(parsed);
  const referenceSnapshot = semanticReferenceSnapshot(parsed);
  const measurement = {
    source: measureSolid(sourceSolid, kernel),
    dependent: measureSolid(dependentSolid, kernel),
    attachment: measureAttachment(history, parsed, kernel),
  };
  const result = {
    mode,
    package: {
      manifoldBuildSource: kernel.manifoldBuildSource,
      manifoldHasCustomExtensions: kernel.manifoldHasCustomExtensions,
    },
    rawSerializationDigest: sha256(serialized),
    normalizedSerializationDigest: sha256(normalizeSerializable(parsed)),
    intentDigest: sha256(intent),
    referenceSnapshotDigest: sha256(referenceSnapshot),
    geometryDigest: sha256(measurement),
    intent,
    referenceSnapshot,
    measurement,
  };

  sourceSolid.free();
  dependentSolid.free();
  await delay(100);
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

async function spawnWorker(workerPath, consumerRoot, mode, inputPath, outputPath) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [workerPath, '--worker', mode, inputPath || '', outputPath],
      { cwd: consumerRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
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
          `Worker ${mode} produced no result (code=${code}, signal=${signal}).\n${stderr}\n${stdout}`,
        ));
        return;
      }
      resolvePromise({ result, naturalExit: !forcedTermination && code === 0 });
    });
  });
}

function sameVector(left, right, tolerance = 1e-9) {
  return left.length === right.length
    && left.every((value, index) => Math.abs(value - right[index]) <= tolerance);
}

function validateStage(result, expectedVolume) {
  const { source, dependent, attachment } = result.measurement;
  return result.package.manifoldBuildSource === 'local'
    && result.package.manifoldHasCustomExtensions === true
    && source.volume === expectedVolume
    && JSON.stringify(source.faceNames.map((name) => name.replace(/^E2:S1:/, '')))
      === JSON.stringify(EXPECTED_SOURCE_ROLES)
    && dependent.volume > 0
    && attachment.resolvedName === SOURCE_FACE
    && attachment.resolvedType === 'FACE'
    && attachment.owningFeatureID === null
    && attachment.parentSolidName === SOURCE_FEATURE
    && attachment.basis.refName === SOURCE_FACE
    && attachment.basisToProjectedFaceCenterDistance <= 1e-3
    && Math.abs(attachment.profilePlaneMeanDistance) <= 1e-3
    && attachment.profilePlaneSpread <= 1e-3
    && result.referenceSnapshot.type === 'FACE'
    && result.referenceSnapshot.sourceFeatureId === SOURCE_FEATURE;
}

function compareChain(chain, serializable) {
  const original = {
    normalizedSerializationEqual:
      chain.author.normalizedSerializationDigest === chain.replay.normalizedSerializationDigest,
    intentEqual: chain.author.intentDigest === chain.replay.intentDigest,
    referenceEqual:
      chain.author.referenceSnapshotDigest === chain.replay.referenceSnapshotDigest,
    geometryEqual: chain.author.geometryDigest === chain.replay.geometryDigest,
  };
  const edited = {
    normalizedSerializationEqual:
      chain.edit.normalizedSerializationDigest === chain.replayEdited.normalizedSerializationDigest,
    intentEqual: chain.edit.intentDigest === chain.replayEdited.intentDigest,
    referenceEqual:
      chain.edit.referenceSnapshotDigest === chain.replayEdited.referenceSnapshotDigest,
    geometryEqual: chain.edit.geometryDigest === chain.replayEdited.geometryDigest,
  };
  const basisDelta = vectorDelta(
    chain.author.measurement.attachment.basis.origin,
    chain.edit.measurement.attachment.basis.origin,
  );
  const faceDelta = vectorDelta(
    chain.author.measurement.attachment.sourceCentroid,
    chain.edit.measurement.attachment.sourceCentroid,
  );
  const dependentDelta = vectorDelta(
    chain.author.measurement.dependent.bounds.center,
    chain.edit.measurement.dependent.bounds.center,
  );
  const edit = {
    changedIntent: chain.author.intentDigest !== chain.edit.intentDigest,
    changedReferenceSnapshot:
      chain.author.referenceSnapshotDigest !== chain.edit.referenceSnapshotDigest,
    changedSourceGeometry:
      chain.author.measurement.source.topologyGeometryDigest
        !== chain.edit.measurement.source.topologyGeometryDigest,
    movedDependentGeometry:
      sha256(chain.author.measurement.dependent)
        !== sha256(chain.edit.measurement.dependent),
    sourceLabelsPreserved:
      chain.author.measurement.source.labelDigest === chain.edit.measurement.source.labelDigest,
    dependentLabelsPreserved:
      chain.author.measurement.dependent.labelDigest
        === chain.edit.measurement.dependent.labelDigest,
    dependentVolumePreserved:
      chain.author.measurement.dependent.volume === chain.edit.measurement.dependent.volume,
    basisDelta,
    faceDelta,
    dependentDelta,
    referenceMotionFollowed:
      !sameVector(basisDelta, [0, 0, 0])
      && sameVector(basisDelta, faceDelta, 1e-6)
      && sameVector(basisDelta, dependentDelta, 1e-6),
  };
  const differencePathRecord = {
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
  const passed = validateStage(chain.author, 396)
    && validateStage(chain.replay, 396)
    && validateStage(chain.edit, 528)
    && validateStage(chain.replayEdited, 528)
    && Object.values(original).every(Boolean)
    && Object.values(edited).every(Boolean)
    && Object.entries(edit)
      .filter(([key]) => !key.endsWith('Delta'))
      .every(([, value]) => value === true)
    && differencePathRecord.originalNormalized.length === 0
    && differencePathRecord.editedNormalized.length === 0;
  return { original, edited, edit, differencePaths: differencePathRecord, passed };
}

function compactStage(result) {
  return {
    mode: result.mode,
    normalizedSerializationDigest: result.normalizedSerializationDigest,
    intentDigest: result.intentDigest,
    referenceSnapshotDigest: result.referenceSnapshotDigest,
    geometryDigest: result.geometryDigest,
  };
}

async function controllerMain(args) {
  const repetitions = parseRepetitions(args);
  const fullOutput = args.includes('--full');
  const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  const packageEntry = packageJson.exports['.'];
  const entryPath = resolve(repoRoot, packageEntry);
  const entryStats = await stat(entryPath);
  const entryDigest = sha256(await readFile(entryPath));
  const distDigest = await digestTree(join(repoRoot, 'dist-kernel'));
  const tempRoot = await mkdtemp(join(tmpdir(), 'brep-phase0-sidewall-reference-'));

  try {
    const consumerRoot = join(tempRoot, 'consumer');
    const nodeModules = join(consumerRoot, 'node_modules');
    const workerPath = join(consumerRoot, 'sidewallReferenceWorker.mjs');
    await mkdir(nodeModules, { recursive: true });
    await symlink(
      repoRoot,
      join(nodeModules, packageJson.name),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await copyFile(scriptPath, workerPath);

    const chains = [];
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const authorPath = join(consumerRoot, `author-${repetition}.json`);
      const replayPath = join(consumerRoot, `replay-${repetition}.json`);
      const editPath = join(consumerRoot, `edit-${repetition}.json`);
      const replayEditedPath = join(consumerRoot, `replay-edited-${repetition}.json`);
      const author = await spawnWorker(workerPath, consumerRoot, 'author', null, authorPath);
      const replay = await spawnWorker(workerPath, consumerRoot, 'replay', authorPath, replayPath);
      const edit = await spawnWorker(workerPath, consumerRoot, 'edit', replayPath, editPath);
      const replayEdited = await spawnWorker(
        workerPath,
        consumerRoot,
        'replay-edited',
        editPath,
        replayEditedPath,
      );
      const serializable = {
        author: JSON.parse(await readFile(authorPath, 'utf8')),
        replay: JSON.parse(await readFile(replayPath, 'utf8')),
        edit: JSON.parse(await readFile(editPath, 'utf8')),
        replayEdited: JSON.parse(await readFile(replayEditedPath, 'utf8')),
      };
      const chain = {
        author: author.result,
        replay: replay.result,
        edit: edit.result,
        replayEdited: replayEdited.result,
        naturalExit: {
          author: author.naturalExit,
          replay: replay.naturalExit,
          edit: edit.naturalExit,
          replayEdited: replayEdited.naturalExit,
        },
      };
      chain.comparison = compareChain(chain, serializable);
      chains.push(chain);
    }

    const stageNames = ['author', 'replay', 'edit', 'replayEdited'];
    const crossRepetition = Object.fromEntries(stageNames.map((stage) => [stage, {
      normalizedSerializationDigestCount: new Set(
        chains.map((chain) => chain[stage].normalizedSerializationDigest),
      ).size,
      intentDigestCount: new Set(chains.map((chain) => chain[stage].intentDigest)).size,
      referenceSnapshotDigestCount: new Set(
        chains.map((chain) => chain[stage].referenceSnapshotDigest),
      ).size,
      geometryDigestCount: new Set(chains.map((chain) => chain[stage].geometryDigest)).size,
    }]));
    const crossRepetitionPassed = Object.values(crossRepetition).every((stage) => (
      Object.values(stage).every((count) => count === 1)
    ));
    const summary = {
      pass: chains.every((chain) => chain.comparison.passed) && crossRepetitionPassed,
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
        'object property order',
      ],
      crossRepetition,
      lifecycle: {
        naturalExitByChain: chains.map((chain) => chain.naturalExit),
        allWorkersRequiredForcedTermination: chains.every((chain) => (
          Object.values(chain.naturalExit).every((naturalExit) => !naturalExit)
        )),
      },
      representative: {
        originalIntent: chains[0].author.intent,
        editedIntent: chains[0].edit.intent,
        originalReferenceSnapshot: chains[0].author.referenceSnapshot,
        editedReferenceSnapshot: chains[0].edit.referenceSnapshot,
        originalMeasurement: chains[0].author.measurement,
        editedMeasurement: chains[0].edit.measurement,
      },
      chains: chains.map((chain) => ({
        author: fullOutput ? chain.author : compactStage(chain.author),
        replay: fullOutput ? chain.replay : compactStage(chain.replay),
        edit: fullOutput ? chain.edit : compactStage(chain.edit),
        replayEdited: fullOutput ? chain.replayEdited : compactStage(chain.replayEdited),
        comparison: chain.comparison,
      })),
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
