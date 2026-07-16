import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const RESULT_PREFIX = 'PHASE0_SKETCH_EXTRUDE_RESULT ';
const ORIGINAL_EXPRESSIONS = 'const depth = 10;';
const EDITED_EXPRESSIONS = 'const depth = 14;';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function digest(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(canonicalize(value));
  return createHash('sha256').update(text).digest('hex');
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

function normalizeRuntimeRecord(runtime) {
  const normalized = structuredClone(runtime);
  if (normalized.sketchPersistentData) normalized.sketchPersistentData.lastSketchChanged = null;
  return canonicalize(normalizeDerivedRuntimeFields(normalized));
}

function roundNumber(value) {
  return Number(Number(value).toPrecision(12));
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

function fullConstraintRecords(sketch) {
  return canonicalize((sketch?.constraints || []).map((constraint) => ({
    id: constraint.id,
    type: constraint.type,
    points: constraint.points,
    value: constraint.value ?? null,
    status: constraint.status ?? null,
    error: constraint.error ?? null,
    previousPointValues: constraint.previousPointValues ?? null,
  })));
}

function findFeatures(serializable) {
  const sketch = (serializable.features || []).find((feature) => feature.type === 'S');
  const extrude = (serializable.features || []).find((feature) => feature.type === 'E');
  if (!sketch || !extrude) throw new Error('Expected one sketch and one extrude feature.');
  return { sketch, extrude };
}

function intentRecord(serializable) {
  const { sketch, extrude } = findFeatures(serializable);
  return canonicalize({
    idCounter: serializable.idCounter,
    expressions: serializable.expressions,
    metadata: serializable.metadata,
    activeWorkbench: serializable.activeWorkbench,
    sketch: {
      type: sketch.type,
      id: sketch.inputParams?.id,
      featureID: sketch.inputParams?.featureID,
      sketchPlane: sketch.inputParams?.sketchPlane ?? null,
      curveResolution: sketch.inputParams?.curveResolution,
      authored: authoredSketch(sketch.persistentData?.sketch),
    },
    extrude: {
      type: extrude.type,
      id: extrude.inputParams?.id,
      featureID: extrude.inputParams?.featureID,
      profile: extrude.inputParams?.profile,
      consumeProfileSketch: extrude.inputParams?.consumeProfileSketch,
      distance: extrude.inputParams?.distance,
      distanceBack: extrude.inputParams?.distanceBack,
      expressionBindings: extrude.inputParams?.__expr || {},
      boolean: extrude.inputParams?.boolean,
    },
  });
}

function runtimeRecord(serializable) {
  const { sketch, extrude } = findFeatures(serializable);
  return canonicalize({
    sketchPersistentData: sketch.persistentData,
    extrudePersistentData: extrude.persistentData,
    fullConstraints: fullConstraintRecords(sketch.persistentData?.sketch),
  });
}

function suppressionFields(serializable) {
  const paths = [];
  const pattern = /suppress|disable|enabled/i;
  for (const [index, feature] of (serializable.features || []).entries()) {
    for (const key of Object.keys(feature || {})) {
      if (pattern.test(key)) paths.push(`features[${index}].${key}`);
    }
    for (const key of Object.keys(feature?.inputParams || {})) {
      if (pattern.test(key)) paths.push(`features[${index}].inputParams.${key}`);
    }
  }
  return paths.sort();
}

function measureHistory(history, kernel) {
  const solid = history.getObjectByName('E2');
  if (!solid || String(solid.type).toUpperCase() !== 'SOLID') {
    throw new Error('Expected extrude solid E2 in the scene.');
  }
  solid.updateMatrixWorld?.(true);
  const bounds = new kernel.BREP.THREE.Box3().setFromObject(solid);
  const faceNames = [...solid.getFaceNames()].sort();
  const measurement = canonicalize({
    solidName: solid.name,
    solidType: solid.type,
    volume: roundNumber(solid.volume()),
    surfaceArea: roundNumber(solid.surfaceArea()),
    triangleCount: solid.getTriangleCount(),
    bounds: {
      min: bounds.min.toArray().map(roundNumber),
      max: bounds.max.toArray().map(roundNumber),
    },
    faceNames,
    faceRoles: faceNames.map((name) => name.replace(/^E2:S1:/, '')).sort(),
    sceneObjects: history.scene.children.map((object) => ({
      name: object.name,
      type: object.type,
    })),
  });
  solid.free();
  return measurement;
}

async function createHistory(kernel) {
  const history = new kernel.PartHistory();
  history.expressions = ORIGINAL_EXPRESSIONS;
  history.metadataManager.metadata = {
    phase0Label: 'sketch-extrude-roundtrip',
    intentVersion: 1,
  };

  const sketch = await history.newFeature('S');
  Object.assign(sketch.inputParams, {
    id: 'S1',
    sketchPlane: null,
    curveResolution: 32,
  });
  sketch.persistentData = { sketch: makeRectangleSketch() };

  const extrude = await history.newFeature('E');
  Object.assign(extrude.inputParams, {
    id: 'E2',
    profile: 'S1:PROFILE',
    consumeProfileSketch: true,
    distance: 0,
    distanceBack: 1,
    __expr: { distance: 'depth' },
    boolean: { targets: [], operation: 'NONE' },
  });
  return history;
}

function editRestoredHistory(history) {
  const sketchFeature = history.features.find((feature) => feature.type === 'S');
  const extrudeFeature = history.features.find((feature) => feature.type === 'E');
  if (!sketchFeature || !extrudeFeature) throw new Error('Restored edit requires S and E features.');
  const sketch = sketchFeature.persistentData?.sketch;
  if (!sketch) throw new Error('Restored sketch persistentData is missing.');

  for (const point of sketch.points || []) {
    if ([2, 3, 4, 5].includes(point.id)) point.x = 10;
    if ([4, 5, 6, 7].includes(point.id)) point.y = 9;
  }
  history.expressions = EDITED_EXPRESSIONS;
  extrudeFeature.inputParams.distanceBack = 2;
  history.metadataManager.metadata = {
    phase0Label: 'sketch-extrude-roundtrip',
    intentVersion: 2,
  };
}

async function buildResult(mode, history, serialized, kernel, restoredCurrentHistoryStepId) {
  const parsed = JSON.parse(serialized);
  const normalized = normalizeSerializable(parsed);
  const intent = intentRecord(parsed);
  const runtime = runtimeRecord(parsed);
  const normalizedRuntime = normalizeRuntimeRecord(runtime);
  const measurement = measureHistory(history, kernel);
  return {
    mode,
    package: {
      manifoldBuildSource: kernel.manifoldBuildSource,
      manifoldHasCustomExtensions: kernel.manifoldHasCustomExtensions,
    },
    serializedByteLength: Buffer.byteLength(serialized),
    rawSerializationDigest: digest(serialized),
    canonicalSerializationDigest: digest(canonicalize(parsed)),
    normalizedSerializationDigest: digest(normalized),
    intentDigest: digest(intent),
    rawRuntimeRecordDigest: digest(runtime),
    normalizedRuntimeRecordDigest: digest(normalizedRuntime),
    geometryDigest: digest(measurement),
    intent,
    runtime: {
      constraintCount: runtime.fullConstraints.length,
      constraintsDigest: digest(runtime.fullConstraints),
      constraints: runtime.fullConstraints,
      lastSketchChanged: runtime.sketchPersistentData?.lastSketchChanged ?? null,
      hasLastSketchSignature:
        typeof runtime.sketchPersistentData?.lastSketchSignature === 'string',
      lastProfileDiagnosticsSerialized:
        Object.prototype.hasOwnProperty.call(runtime.extrudePersistentData || {}, 'lastProfileDiagnostics'),
    },
    serializationBoundary: {
      topLevelKeys: Object.keys(parsed).sort(),
      currentHistoryStepFieldPresent:
        Object.prototype.hasOwnProperty.call(parsed, 'currentHistoryStepId'),
      currentHistoryStepBeforeSerialize: history.currentHistoryStepId,
      restoredCurrentHistoryStepId,
      suppressionFields: suppressionFields(parsed),
    },
    measurement,
  };
}

const [mode, inputPath, outputPath] = process.argv.slice(2);
const kernel = await import('brep-io-kernel');
let history;
let restoredCurrentHistoryStepId = null;

if (mode === 'author') {
  history = await createHistory(kernel);
} else {
  const input = await readFile(inputPath, 'utf8');
  history = new kernel.PartHistory();
  await history.fromJSON(input);
  restoredCurrentHistoryStepId = history.currentHistoryStepId;
  if (mode === 'edit') editRestoredHistory(history);
  else if (mode !== 'replay' && mode !== 'replay-edited') {
    throw new Error(`Unknown round-trip worker mode: ${mode}`);
  }
}

await history.runHistory({ throwOnFeatureError: true });
if (mode === 'author' || mode === 'edit') history.currentHistoryStepId = 'E2';
const serialized = await history.toJSON();
await writeFile(outputPath, serialized, 'utf8');
const result = await buildResult(
  mode,
  history,
  serialized,
  kernel,
  restoredCurrentHistoryStepId,
);

await delay(100);
console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
