import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const RESULT_PREFIX = 'PHASE0_RESULT ';

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

function normalizeSerializable(serializable) {
  const normalized = structuredClone(serializable);
  for (const feature of normalized.features || []) {
    feature.timestamp = null;
  }
  return canonicalize(normalized);
}

function authoredRecords(serializable) {
  return canonicalize({
    features: (serializable.features || []).map((feature) => ({
      type: feature.type,
      inputParams: feature.inputParams,
      persistentData: feature.persistentData,
    })),
    idCounter: serializable.idCounter,
    expressions: serializable.expressions,
    configurator: serializable.configurator,
    activeWorkbench: serializable.activeWorkbench,
  });
}

function roundNumber(value) {
  return Number(Number(value).toPrecision(12));
}

function measureHistory(history, featureId, BREP) {
  const solid = history.scene.getObjectByName(featureId);
  if (!solid) throw new Error(`Expected solid ${featureId} in the scene.`);

  solid.updateMatrixWorld?.(true);
  const bounds = new BREP.THREE.Box3().setFromObject(solid);
  const min = bounds.min.toArray().map(roundNumber);
  const max = bounds.max.toArray().map(roundNumber);

  return canonicalize({
    featureId,
    solidName: solid.name,
    solidType: solid.type,
    volume: roundNumber(solid.volume()),
    surfaceArea: roundNumber(solid.surfaceArea()),
    triangleCount: solid.getTriangleCount(),
    faceNames: [...solid.getFaceNames()].sort(),
    bounds: { min, max },
  });
}

function activeResources() {
  return typeof process.getActiveResourcesInfo === 'function'
    ? process.getActiveResourcesInfo()
      .filter((resource) => resource !== 'PipeWrap' && resource !== 'TTYWrap')
      .sort()
    : [];
}

async function createCubeHistory(PartHistory, dimensions, label) {
  const history = new PartHistory();
  const feature = await history.newFeature('P.CU');
  feature.inputParams.sizeX = dimensions.x;
  feature.inputParams.sizeY = dimensions.y;
  feature.inputParams.sizeZ = dimensions.z;
  if (label) history.metadataManager.metadata = { phase0Label: label };
  await history.runHistory({ throwOnFeatureError: true });
  return { history, featureId: String(feature.inputParams.id) };
}

function buildResult(serialized, history, featureId, kernel) {
  const parsed = JSON.parse(serialized);
  const normalized = normalizeSerializable(parsed);
  const authored = authoredRecords(parsed);
  return {
    package: {
      manifoldBuildSource: kernel.manifoldBuildSource,
      manifoldHasCustomExtensions: kernel.manifoldHasCustomExtensions,
      manifoldPlusSumType: typeof kernel.manifoldPlusSum,
    },
    featureId,
    serializedByteLength: Buffer.byteLength(serialized),
    rawSerializationDigest: digest(serialized),
    normalizedSerializationDigest: digest(normalized),
    authoredRecordsDigest: digest(authored),
    authoredRecords: authored,
    measurements: measureHistory(history, featureId, kernel.BREP),
  };
}

async function author(kernel, outputPath, label) {
  const { history, featureId } = await createCubeHistory(
    kernel.PartHistory,
    { x: 5, y: 10, z: 15 },
    label,
  );
  const serialized = await history.toJSON();
  await writeFile(outputPath, serialized, 'utf8');
  return { mode: 'author', ...buildResult(serialized, history, featureId, kernel) };
}

async function replay(kernel, inputPath, outputPath) {
  const input = await readFile(inputPath, 'utf8');
  const history = new kernel.PartHistory();
  await history.fromJSON(input);
  await history.runHistory({ throwOnFeatureError: true });
  const serialized = await history.toJSON();
  await writeFile(outputPath, serialized, 'utf8');
  const featureId = String(history.features[0]?.inputParams?.id || '');
  return { mode: 'replay', ...buildResult(serialized, history, featureId, kernel) };
}

async function concurrent(kernel) {
  const historyA = new kernel.PartHistory();
  const historyB = new kernel.PartHistory();
  const eventsA = [];
  const eventsB = [];

  historyA.expressions = 'const width = 2;';
  historyB.expressions = 'const width = 5;';
  historyA.metadataManager.metadata = { phase0Label: 'concurrent-a' };
  historyB.metadataManager.metadata = { phase0Label: 'concurrent-b' };
  historyA.callbacks.run = async (featureId) => eventsA.push(`run:${featureId}`);
  historyB.callbacks.run = async (featureId) => eventsB.push(`run:${featureId}`);
  historyA.callbacks.afterRunHistory = async () => eventsA.push('after');
  historyB.callbacks.afterRunHistory = async () => eventsB.push('after');

  const featureA = await historyA.newFeature('P.CU');
  featureA.inputParams.sizeX = 0;
  featureA.inputParams.sizeY = 3;
  featureA.inputParams.sizeZ = 4;
  featureA.inputParams.__expr = { sizeX: 'width' };

  const featureB = await historyB.newFeature('P.CU');
  featureB.inputParams.sizeX = 0;
  featureB.inputParams.sizeY = 6;
  featureB.inputParams.sizeZ = 7;
  featureB.inputParams.__expr = { sizeX: 'width' };

  await Promise.all([
    historyA.runHistory({ throwOnFeatureError: true }),
    historyB.runHistory({ throwOnFeatureError: true }),
  ]);

  const serializedA = historyA.toSerializable();
  const serializedB = historyB.toSerializable();
  const measurementsA = measureHistory(historyA, featureA.inputParams.id, kernel.BREP);
  const measurementsB = measureHistory(historyB, featureB.inputParams.id, kernel.BREP);

  return {
    mode: 'concurrent',
    package: {
      manifoldBuildSource: kernel.manifoldBuildSource,
      manifoldHasCustomExtensions: kernel.manifoldHasCustomExtensions,
    },
    identity: {
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
      primitiveFeatureClassShared:
        historyA.featureRegistry.getSafe('P.CU') === historyB.featureRegistry.getSafe('P.CU'),
    },
    historyA: {
      events: eventsA,
      expressions: serializedA.expressions,
      metadata: serializedA.metadata,
      measurements: measurementsA,
    },
    historyB: {
      events: eventsB,
      expressions: serializedB.expressions,
      metadata: serializedB.metadata,
      measurements: measurementsB,
    },
  };
}

const [mode, inputPath, outputPath, label] = process.argv.slice(2);
const kernel = await import('brep-io-kernel');

let result;
if (mode === 'author') result = await author(kernel, outputPath, label);
else if (mode === 'replay') result = await replay(kernel, inputPath, outputPath);
else if (mode === 'concurrent') result = await concurrent(kernel);
else throw new Error(`Unknown worker mode: ${mode}`);

await delay(100);
result.activeResources = activeResources();
console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
