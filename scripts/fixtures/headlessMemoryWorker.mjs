import { createHook } from 'node:async_hooks';
import process from 'node:process';
import { setImmediate as scheduleImmediate } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';

const RESULT_PREFIX = 'PHASE0_MEMORY_RESULT ';
const STORAGE_CHANNEL_NAME = '__BREP_STORAGE_BC__';
const timerMetadata = new WeakMap();
const trackedTimers = new Map();

const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = function tracedSetTimeout(callback, timeout, ...args) {
  const handle = originalSetTimeout(callback, timeout, ...args);
  timerMetadata.set(handle, Number(timeout) || 0);
  return handle;
};

const hook = createHook({
  init(asyncId, type, _triggerAsyncId, resource) {
    if (type !== 'Timeout') return;
    trackedTimers.set(asyncId, new WeakRef(resource));
  },
  destroy(asyncId) {
    trackedTimers.delete(asyncId);
  },
});
hook.enable();

function referencedCleanupTimerCount() {
  let count = 0;
  for (const reference of trackedTimers.values()) {
    const resource = reference.deref();
    if (!resource || resource._destroyed === true) continue;
    if (timerMetadata.get(resource) !== 60_000) continue;
    if (typeof resource.hasRef === 'function' && !resource.hasRef()) continue;
    count += 1;
  }
  return count;
}

function activeResources() {
  if (typeof process.getActiveResourcesInfo !== 'function') return [];
  return process.getActiveResourcesInfo()
    .filter((name) => !['PipeWrap', 'TTYWrap'].includes(name))
    .sort();
}

async function collectGarbage() {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Memory worker must run with --expose-gc.');
  }
  globalThis.gc();
  await new Promise((resolve) => scheduleImmediate(resolve));
  globalThis.gc();
}

function countLiveInheritedInstances(manifold) {
  try {
    const instances = manifold.getLiveInheritedInstances?.();
    return Array.isArray(instances) ? instances.length : null;
  } catch {
    return null;
  }
}

async function memorySnapshot(label, kernel) {
  await collectGarbage();
  const usage = process.memoryUsage();
  return {
    label,
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    manifoldHeapBytes: kernel.manifold.HEAP8?.buffer?.byteLength ?? null,
    inheritedInstanceCount: kernel.manifold.getInheritedInstanceCount?.() ?? null,
    liveInheritedInstanceCount: countLiveInheritedInstances(kernel.manifold),
    emvalHandleCount: kernel.manifold.count_emval_handles?.() ?? null,
    cleanupTimers: referencedCleanupTimerCount(),
    activeResources: activeResources(),
  };
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
    constraints: [],
  };
}

function collectSceneSolids(history) {
  const solids = new Set();
  history.scene?.traverse?.((object) => {
    if (String(object?.type || '').toUpperCase() === 'SOLID'
      && typeof object.free === 'function') {
      solids.add(object);
    }
  });
  return [...solids];
}

async function freeSceneSolids(history) {
  const solids = collectSceneSolids(history);
  for (const solid of solids) solid.free();
  return solids.length;
}

function measureHistory(history) {
  const solids = collectSceneSolids(history);
  return {
    solidCount: solids.length,
    volumes: solids.map((solid) => Number(solid.volume().toPrecision(12))),
    triangleCounts: solids.map((solid) => solid.getTriangleCount()),
    faceNames: solids.map((solid) => [...solid.getFaceNames()].sort()),
  };
}

async function createCubeHistory(kernel) {
  const history = new kernel.PartHistory();
  const feature = await history.newFeature('P.CU');
  feature.inputParams.sizeX = 5;
  feature.inputParams.sizeY = 10;
  feature.inputParams.sizeZ = 15;
  return {
    history,
    edit(cycle) {
      feature.inputParams.sizeX = 5 + (cycle % 4);
    },
    expectedVolumes: [750, 900, 1050, 1200],
  };
}

async function createExtrudeHistory(kernel) {
  const history = new kernel.PartHistory();
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
    distance: 10,
    distanceBack: 1,
    boolean: { targets: [], operation: 'NONE' },
  });

  return {
    history,
    edit(cycle) {
      extrude.inputParams.distance = 10 + (cycle % 4);
    },
    expectedVolumes: [396, 432, 468, 504],
  };
}

async function createHistory(kernel, kind) {
  if (kind === 'cube') return await createCubeHistory(kernel);
  if (kind === 'extrude') return await createExtrudeHistory(kernel);
  throw new Error(`Unknown history kind: ${kind}`);
}

function assertMeasurement(measurement, expectedVolumes, cycle, kind) {
  if (measurement.solidCount !== 1) {
    throw new Error(`${kind} cycle ${cycle}: expected one scene solid, got ${measurement.solidCount}.`);
  }
  const expected = expectedVolumes[cycle % expectedVolumes.length];
  const actual = measurement.volumes[0];
  if (Math.abs(actual - expected) > 1e-8) {
    throw new Error(`${kind} cycle ${cycle}: expected volume ${expected}, got ${actual}.`);
  }
  if (!(measurement.triangleCounts[0] > 0)) {
    throw new Error(`${kind} cycle ${cycle}: expected a positive triangle count.`);
  }
}

function sampledCycle(cycle, cycles) {
  return cycle === 0
    || cycle === cycles - 1
    || (cycle + 1) % Math.max(1, Math.floor(cycles / 4)) === 0;
}

async function warmModel(model, kind) {
  model.edit(0);
  await model.history.runHistory({ throwOnFeatureError: true });
  const measurement = measureHistory(model.history);
  assertMeasurement(measurement, model.expectedVolumes, 0, kind);
  const freed = await freeSceneSolids(model.history);
  if (freed !== 1) throw new Error(`${kind} warm-up: expected to free one scene solid, got ${freed}.`);
}

async function runReplayCase(kernel, { kind, cleanup, cycles, automaticWaitMs }) {
  const model = await createHistory(kernel, kind);
  await warmModel(model, kind);
  const snapshots = [await memorySnapshot('baseline-after-warmup', kernel)];
  const samples = [];
  let freedSolids = 0;

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    if (cycle > 0 && cleanup === 'explicit') {
      freedSolids += await freeSceneSolids(model.history);
    }
    model.edit(cycle);
    await model.history.runHistory({ throwOnFeatureError: true });
    const measurement = measureHistory(model.history);
    assertMeasurement(measurement, model.expectedVolumes, cycle, kind);
    if (sampledCycle(cycle, cycles)) {
      samples.push({ cycle, measurement });
      snapshots.push(await memorySnapshot(`cycle-${cycle + 1}`, kernel));
    }
  }

  snapshots.push(await memorySnapshot('before-final-cleanup', kernel));
  if (cleanup === 'explicit') {
    freedSolids += await freeSceneSolids(model.history);
    snapshots.push(await memorySnapshot('after-explicit-cleanup', kernel));
  } else if (cleanup === 'automatic') {
    await delay(automaticWaitMs);
    snapshots.push(await memorySnapshot('after-automatic-cleanup', kernel));
  }

  return {
    mode: 'replay',
    kind,
    cleanup,
    cyclesExecuted: cycles,
    freedSolids,
    samples,
    snapshots,
  };
}

async function runConcurrentCase(kernel, cycles) {
  const models = [
    await createCubeHistory(kernel),
    await createExtrudeHistory(kernel),
  ];
  await warmModel(models[0], 'cube');
  await warmModel(models[1], 'extrude');
  const snapshots = [await memorySnapshot('baseline-after-warmup', kernel)];
  const samples = [];
  let freedSolids = 0;

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    if (cycle > 0) {
      freedSolids += await freeSceneSolids(models[0].history);
      freedSolids += await freeSceneSolids(models[1].history);
    }
    models.forEach((model) => model.edit(cycle));
    await Promise.all(models.map((model) => (
      model.history.runHistory({ throwOnFeatureError: true })
    )));
    const measurements = models.map((model, index) => {
      const measurement = measureHistory(model.history);
      assertMeasurement(measurement, model.expectedVolumes, cycle, index === 0 ? 'cube' : 'extrude');
      return measurement;
    });
    if (sampledCycle(cycle, cycles)) {
      samples.push({ cycle, measurements });
      snapshots.push(await memorySnapshot(`cycle-${cycle + 1}`, kernel));
    }
  }

  snapshots.push(await memorySnapshot('before-final-cleanup', kernel));
  freedSolids += await freeSceneSolids(models[0].history);
  freedSolids += await freeSceneSolids(models[1].history);
  snapshots.push(await memorySnapshot('after-explicit-cleanup', kernel));

  return {
    mode: 'concurrent',
    cyclesExecuted: cycles,
    freedSolids,
    historiesIndependent: {
      scene: models[0].history.scene !== models[1].history.scene,
      featureRegistry: models[0].history.featureRegistry !== models[1].history.featureRegistry,
      metadataManager: models[0].history.metadataManager !== models[1].history.metadataManager,
    },
    samples,
    snapshots,
  };
}

async function runImportCase(caseName) {
  const NativeBroadcastChannel = globalThis.BroadcastChannel;
  const trackedChannels = [];
  if (caseName === 'import_unref') {
    globalThis.BroadcastChannel = class UnrefBroadcastChannel extends NativeBroadcastChannel {
      constructor(...args) {
        super(...args);
        this.unref?.();
        trackedChannels.push(this);
      }
    };
  }

  const kernel = await import('brep-io-kernel');
  await delay(150);
  const result = {
    mode: 'import',
    caseName,
    packageChannelCount: trackedChannels.length,
    messaging: null,
    snapshot: await memorySnapshot('after-import', kernel),
  };

  if (caseName === 'import_unref') {
    const packageChannel = trackedChannels[0];
    if (!packageChannel) throw new Error('Expected the package to construct a BroadcastChannel.');
    const peer = new NativeBroadcastChannel(STORAGE_CHANNEL_NAME);
    peer.unref?.();
    let packageReceived = null;
    let peerReceived = null;
    const packageHandler = packageChannel.onmessage;
    packageChannel.onmessage = (event) => {
      packageReceived = event.data;
      packageHandler?.call(packageChannel, event);
    };
    peer.onmessage = (event) => {
      peerReceived = event.data;
    };
    peer.postMessage({ type: 'set', key: '__phase0_unref_probe__', newValue: 'peer-to-package' });
    await delay(100);
    packageChannel.postMessage({ type: 'phase0-probe', value: 'package-to-peer' });
    await delay(100);
    result.messaging = {
      packageReceived: packageReceived?.newValue === 'peer-to-package',
      peerReceived: peerReceived?.value === 'package-to-peer',
    };
    peer.close();
    globalThis.BroadcastChannel = NativeBroadcastChannel;
    result.snapshot = await memorySnapshot('after-messaging', kernel);
  }
  return result;
}

const [caseName, cyclesText, automaticWaitText] = process.argv.slice(2);
const cycles = Number(cyclesText);
const automaticWaitMs = Number(automaticWaitText);
let result;

if (caseName === 'import_default' || caseName === 'import_unref') {
  result = await runImportCase(caseName);
} else {
  const kernel = await import('brep-io-kernel');
  await delay(150);
  if (caseName === 'cube_no_cleanup') {
    result = await runReplayCase(kernel, { kind: 'cube', cleanup: 'none', cycles, automaticWaitMs });
  } else if (caseName === 'cube_explicit_cleanup') {
    result = await runReplayCase(kernel, { kind: 'cube', cleanup: 'explicit', cycles, automaticWaitMs });
  } else if (caseName === 'extrude_no_cleanup') {
    result = await runReplayCase(kernel, { kind: 'extrude', cleanup: 'none', cycles, automaticWaitMs });
  } else if (caseName === 'extrude_explicit_cleanup') {
    result = await runReplayCase(kernel, { kind: 'extrude', cleanup: 'explicit', cycles, automaticWaitMs });
  } else if (caseName === 'cube_automatic_cleanup') {
    result = await runReplayCase(kernel, {
      kind: 'cube',
      cleanup: 'automatic',
      cycles: Math.min(cycles, 8),
      automaticWaitMs,
    });
  } else if (caseName === 'concurrent_explicit_cleanup') {
    result = await runConcurrentCase(kernel, cycles);
  } else {
    throw new Error(`Unknown memory case: ${caseName}`);
  }
}

result.caseName = caseName;
result.activeResourcesAtReport = activeResources();
console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
