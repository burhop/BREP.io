import { createHook } from 'node:async_hooks';
import process from 'node:process';
import { setImmediate as scheduleImmediate } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';

const RESULT_PREFIX = 'PHASE0_LIFECYCLE_RESULT ';
const timerMetadata = new WeakMap();
const trackedResources = new Map();

function captureStack() {
  return String(new Error().stack || '')
    .split(/\r?\n/)
    .slice(2, 14);
}

const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = function tracedSetTimeout(callback, timeout, ...args) {
  const metadata = {
    kind: 'timeout',
    delayMs: Number(timeout) || 0,
    stack: captureStack(),
  };
  const handle = originalSetTimeout(callback, timeout, ...args);
  timerMetadata.set(handle, metadata);
  return handle;
};

const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = function tracedSetInterval(callback, timeout, ...args) {
  const metadata = {
    kind: 'interval',
    delayMs: Number(timeout) || 0,
    stack: captureStack(),
  };
  const handle = originalSetInterval(callback, timeout, ...args);
  timerMetadata.set(handle, metadata);
  return handle;
};

const hook = createHook({
  init(asyncId, type, triggerAsyncId, resource) {
    if (type !== 'MESSAGEPORT' && type !== 'Timeout') return;
    trackedResources.set(asyncId, {
      asyncId,
      type,
      triggerAsyncId,
      resource: new WeakRef(resource),
      initStack: captureStack(),
    });
  },
  destroy(asyncId) {
    trackedResources.delete(asyncId);
  },
});
hook.enable();

function activeResourceNames() {
  if (typeof process.getActiveResourcesInfo !== 'function') return [];
  return process.getActiveResourcesInfo()
    .filter((name) => !['PipeWrap', 'TTYWrap'].includes(name))
    .sort();
}

function resourceSnapshot() {
  const resources = [];
  for (const entry of trackedResources.values()) {
    const resource = entry.resource.deref();
    if (!resource || resource._destroyed === true) continue;
    const hasRef = typeof resource.hasRef === 'function' ? resource.hasRef() : null;
    if (hasRef === false) continue;
    const timer = timerMetadata.get(resource) || null;
    if (entry.type === 'Timeout' && !timer) continue;
    resources.push({
      type: entry.type,
      hasRef,
      constructorName: resource.constructor?.name || null,
      idleTimeoutMs: Number.isFinite(Number(resource._idleTimeout))
        ? Number(resource._idleTimeout)
        : null,
      timerKind: timer?.kind || null,
      requestedDelayMs: timer?.delayMs ?? null,
      stack: timer?.stack || entry.initStack,
    });
  }
  return resources.sort((left, right) => (
    `${left.type}:${left.requestedDelayMs}`.localeCompare(`${right.type}:${right.requestedDelayMs}`)
  ));
}

function lifecycleMethods(PartHistory) {
  return Object.getOwnPropertyNames(PartHistory.prototype)
    .filter((name) => /dispose|destroy|close|free|reset|clear|cancel|stop/i.test(name))
    .sort();
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
  for (const solid of solids) await solid.free();
  return solids.length;
}

async function addCube(history, sizeX = 5) {
  const feature = await history.newFeature('P.CU');
  feature.inputParams.sizeX = sizeX;
  feature.inputParams.sizeY = 10;
  feature.inputParams.sizeZ = 15;
  return feature;
}

async function runHistory(history) {
  await history.runHistory({ throwOnFeatureError: true });
}

function measureSceneSolids(history) {
  return collectSceneSolids(history).map((solid) => solid.volume());
}

async function executeCase(caseName) {
  if (caseName === 'control') {
    return {
      imported: false,
      historyCount: 0,
      publicLifecycleMethods: [],
      details: {},
    };
  }

  const kernel = await import('brep-io-kernel');
  const methods = lifecycleMethods(kernel.PartHistory);
  if (caseName === 'import_only') {
    return {
      imported: true,
      historyCount: 0,
      publicLifecycleMethods: methods,
      details: {},
    };
  }

  if (caseName === 'construct') {
    const history = new kernel.PartHistory();
    return {
      imported: true,
      historyCount: 1,
      publicLifecycleMethods: methods,
      details: { sceneChildren: history.scene.children.length },
    };
  }

  if (caseName === 'two_histories_measure') {
    const histories = [new kernel.PartHistory(), new kernel.PartHistory()];
    for (const history of histories) {
      await addCube(history);
    }
    await Promise.all(histories.map(runHistory));
    const volumes = histories.map(measureSceneSolids);
    return {
      imported: true,
      historyCount: histories.length,
      publicLifecycleMethods: methods,
      details: {
        sceneChildren: histories.map((history) => history.scene.children.length),
        sceneSolidCounts: histories.map((history) => collectSceneSolids(history).length),
        volumes,
      },
    };
  }

  const history = new kernel.PartHistory();
  const feature = await addCube(history);
  if (caseName === 'run_once') {
    await runHistory(history);
  } else if (caseName === 'measure_once') {
    await runHistory(history);
    const volumes = measureSceneSolids(history);
    return {
      imported: true,
      historyCount: 1,
      publicLifecycleMethods: methods,
      details: { volumes },
    };
  } else if (caseName === 'measure_reset') {
    await runHistory(history);
    const volumes = measureSceneSolids(history);
    await history.reset();
    return {
      imported: true,
      historyCount: 1,
      publicLifecycleMethods: methods,
      details: { volumes, sceneChildren: history.scene.children.length },
    };
  } else if (caseName === 'measure_free_reset') {
    await runHistory(history);
    const volumes = measureSceneSolids(history);
    const freed = await freeSceneSolids(history);
    await history.reset();
    return {
      imported: true,
      historyCount: 1,
      publicLifecycleMethods: methods,
      details: { volumes, freed, sceneChildren: history.scene.children.length },
    };
  } else if (caseName === 'remeasure_edits' || caseName === 'remeasure_free_between') {
    const freedBeforeRuns = [];
    const volumes = [];
    for (let index = 0; index < 4; index += 1) {
      if (index > 0 && caseName === 'remeasure_free_between') {
        freedBeforeRuns.push(await freeSceneSolids(history));
      }
      feature.inputParams.sizeX = 5 + index;
      await runHistory(history);
      volumes.push(measureSceneSolids(history));
    }
    return {
      imported: true,
      historyCount: 1,
      publicLifecycleMethods: methods,
      details: {
        reruns: 4,
        freedBeforeRuns,
        volumes,
        sceneChildren: history.scene.children.length,
        sceneSolidCount: collectSceneSolids(history).length,
      },
    };
  } else {
    throw new Error(`Unknown lifecycle case: ${caseName}`);
  }

  return {
    imported: true,
    historyCount: 1,
    publicLifecycleMethods: methods,
    details: {
      sceneChildren: history.scene.children.length,
      sceneSolidCount: collectSceneSolids(history).length,
    },
  };
}

const caseName = process.argv[2];
const result = await executeCase(caseName);
await delay(100);
await new Promise((resolve) => scheduleImmediate(resolve));
result.caseName = caseName;
result.activeResourceNames = activeResourceNames();
result.resources = resourceSnapshot();
console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
