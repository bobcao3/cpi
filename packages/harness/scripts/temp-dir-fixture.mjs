import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import {
  list_temp_directories,
  release_temp_directory,
} from "../src/lib/storage/temp-dirs.ts";

export const supported = {
  skip: process.platform !== "linux",
  timeout: 60000,
  concurrency: false,
};
export const ids = (directories) => directories.map(({ id }) => id).sort();
export async function inventory(owner) {
  const current = await list_temp_directories(owner);
  assert.deepEqual(current.issues, []);
  return current.alive;
}
export async function release_all(owner) {
  for (const directory of await inventory(owner))
    await release_temp_directory(owner, directory.id);
  assert.deepEqual(await inventory(owner), []);
}

export function late_writer(path) {
  const source = `
import { parentPort, workerData } from 'node:worker_threads';
import { writeFile } from 'node:fs/promises';
const timer = setTimeout(() => { throw new Error('late writer timed out'); }, 30000);
parentPort.once('message', async () => {
  await writeFile(workerData.path, 'late writer joined');
  clearTimeout(timer);
  parentPort.close();
});
parentPort.postMessage('ready');
`;
  const worker = new Worker(
    new URL(`data:text/javascript,${encodeURIComponent(source)}`),
    {
      execArgv: [],
      workerData: { path },
    },
  );
  const closed = once(worker, "exit").then(([code]) => code);
  closed.catch(() => {});
  return { worker, ready: once(worker, "message"), closed };
}

export async function allocate_workers(owner, counts, release_batches = []) {
  const source = `
import assert from 'node:assert/strict';
import { parentPort, workerData } from 'node:worker_threads';
import { inheritedSessionOwner } from ${JSON.stringify(new URL("../src/lib/storage/owner.ts", import.meta.url).href)};
import { create_temp_directory, release_temp_directory } from ${JSON.stringify(new URL("../src/lib/storage/temp-dirs.ts", import.meta.url).href)};
const owner = inheritedSessionOwner();
assert.deepEqual(owner, workerData.expectedOwner);
assert.ok(Object.isFrozen(owner));
assert.equal(Reflect.set(workerData, 'storageOwner', { session_id: workerData.sessionId }), false);
assert.equal(Reflect.set(owner, 'session_id', workerData.sessionId), false);
parentPort.once('message', async () => {
  const results = [];
  for (let index = 0; index < workerData.count; index++) {
    try {
      const release_id = workerData.releaseIds[index];
      if (release_id) await release_temp_directory(owner, release_id);
      results.push({ directory: await create_temp_directory(owner, 'scratch', 'worker') });
    }
    catch (error) { results.push({ error: error.message }); }
  }
  parentPort.postMessage({ results });
  parentPort.close();
});
parentPort.postMessage({ ready: true });
`;
  const workers = [];
  let timer;
  try {
    const states = counts.map((count, index) => {
      const worker = new Worker(
        new URL(`data:text/javascript,${encodeURIComponent(source)}`),
        {
          execArgv: [],
          workerData: {
            storageOwner: owner,
            expectedOwner: owner,
            sessionId: `child-${index}`,
            count,
            releaseIds: release_batches[index] ?? [],
          },
        },
      );
      workers.push(worker);
      let ready, reject_ready, finished, reject_finished, results;
      const readiness = new Promise((resolve, reject) => {
        ready = resolve;
        reject_ready = reject;
      });
      const completion = new Promise((resolve, reject) => {
        finished = resolve;
        reject_finished = reject;
      });
      worker.on("message", (message) => {
        if (message.ready) ready();
        else results = message.results;
      });
      worker.on("error", (error) => {
        reject_ready(error);
        reject_finished(error);
      });
      worker.once("exit", (code) => {
        const error = new Error(
          `allocation worker exited ${code} without a complete batch`,
        );
        reject_ready(error);
        if (code === 0 && results) finished(results);
        else reject_finished(error);
      });
      return { readiness, completion };
    });
    const completed = Promise.all(states.map(({ completion }) => completion));
    completed.catch(() => {});
    const work = async () => {
      await Promise.all(states.map(({ readiness }) => readiness));
      for (const worker of workers) worker.postMessage("allocate");
      return (await completed).flat();
    };
    return await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("allocation workers timed out")),
          20000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}
