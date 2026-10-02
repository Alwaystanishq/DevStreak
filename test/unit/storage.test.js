const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { ActivityStore, StaleGenerationError } = require('../../src/storage');
const { emptyData, applyChanges, migrateLegacy } = require('../../src/model');

const change = {
  date: '2026-10-02', projectId: 'file:///workspace', projectName: 'Workspace',
  seconds: 1, characters: 2, file: { id: 'file:///workspace/index.js', path: 'index.js' },
};

async function setup(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devstreak-storage-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new ActivityStore({ directory, ...options });
  await store.init();
  return { directory, store };
}

function project(data) {
  return data.days[change.date].projects[change.projectId];
}

function childRun(source, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(errors || `Child exited ${code}`)));
  });
}

test('independent stores merge concurrent writes without losing totals', async (t) => {
  const { directory, store } = await setup(t);
  const other = new ActivityStore({ directory });
  await other.init();
  await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? store : other).append([{ ...change, languageId: i % 2 ? 'python' : 'javascript' }])));
  const data = await store.read();
  assert.equal(project(data).time, 40);
  assert.equal(project(data).characters, 80);
  assert.deepEqual(project(data).languages, { javascript: 20, python: 20 });
  assert.deepEqual(project(data).files, { [change.file.id]: change.file.path });
  assert.deepEqual(await fs.readdir(directory), ['activity.json']);
});

test('separate processes merge changes under the filesystem lock', async (t) => {
  const { directory, store } = await setup(t);
  const source = `
    const { ActivityStore } = require(process.argv[1]);
    (async () => {
      const store = new ActivityStore({ directory: process.argv[2] });
      await store.init();
      for (let i = 0; i < 15; i++) await store.append([JSON.parse(process.argv[3])]);
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const args = [require.resolve('../../src/storage'), directory, JSON.stringify(change)];
  await Promise.all([childRun(source, args), childRun(source, args)]);
  assert.equal(project(await store.read()).time, 30);
});

test('legacy records migrate once, preserve the input, and do not return after clear', async (t) => {
  const legacyData = { '2026-10-01': { time: 60, letters: 7, files: ['index.js'] } };
  const original = structuredClone(legacyData);
  const { directory, store } = await setup(t, { legacyData });
  assert.deepEqual(await store.read(), migrateLegacy(legacyData));
  assert.deepEqual(legacyData, original);
  const second = new ActivityStore({ directory, legacyData: { '2026-10-01': { time: 999, letters: 99, files: [] } } });
  assert.deepEqual(await second.init(), migrateLegacy(original));
  await second.clear();
  assert.deepEqual(await new ActivityStore({ directory, legacyData }).init(), emptyData());
});

test('clear rejects old pending activity even when a refresh was queued first', async (t) => {
  const { directory, store } = await setup(t);
  const other = new ActivityStore({ directory });
  await other.init();
  await other.clear();
  const refresh = store.read();
  const stale = store.append([change]);
  await assert.rejects(stale, StaleGenerationError);
  assert.deepEqual(await refresh, emptyData());
  assert.deepEqual(await other.read(), emptyData());
  await store.append([change]);
  assert.equal(project(await other.read()).time, 1);
});

test('import invalidates append calls queued behind a local replacement', async (t) => {
  const { store } = await setup(t);
  const imported = applyChanges(emptyData(), [{ ...change, seconds: 50 }]);
  const replacing = store.replace(imported);
  const stale = store.append([change]);
  await assert.rejects(stale, StaleGenerationError);
  assert.deepEqual(await replacing, imported);
  assert.deepEqual(await store.read(), imported);
  await store.append([change]);
  assert.equal(project(await store.read()).time, 51);
});

test('another window import rejects old deltas until an explicit read refreshes the generation', async (t) => {
  const { directory, store } = await setup(t);
  const other = new ActivityStore({ directory });
  await other.init();
  await other.replace(applyChanges(emptyData(), [{ ...change, seconds: 25 }]));
  await assert.rejects(store.append([change]), StaleGenerationError);
  await assert.rejects(store.append([change]), StaleGenerationError);
  await store.read();
  await store.append([change]);
  assert.equal(project(await other.read()).time, 26);
});

test('corrupt JSON and invalid schemas surface errors and remain untouched', async (t) => {
  const { store } = await setup(t);
  for (const content of ['{broken', JSON.stringify({ storageVersion: 1, generation: randomUUID(), data: { version: 2, days: { invalid: {} } } })]) {
    await fs.writeFile(store.filePath, content);
    await assert.rejects(store.read(), { code: 'INVALID_STORAGE' });
    await assert.rejects(store.append([change]), { code: 'INVALID_STORAGE' });
    await assert.rejects(store.clear(), { code: 'INVALID_STORAGE' });
    await assert.rejects(store.init(), { code: 'INVALID_STORAGE' });
    assert.equal(await fs.readFile(store.filePath, 'utf8'), content);
  }
});

test('invalid replacement or changes cannot alter valid stored activity', async (t) => {
  const { store } = await setup(t);
  await store.append([change]);
  const before = await fs.readFile(store.filePath, 'utf8');
  await assert.rejects(store.replace({ version: 999, days: {} }));
  await assert.rejects(store.append([{ ...change, seconds: -1 }]));
  assert.equal(await fs.readFile(store.filePath, 'utf8'), before);
  assert.equal(project(await store.read()).time, 1);
});

test('failed atomic replacement preserves data, removes temporary files and releases the lock', async (t) => {
  const { directory, store } = await setup(t);
  const before = await fs.readFile(store.filePath, 'utf8');
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (from.startsWith(`${store.filePath}.tmp-`)) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return rename(from, to);
  };
  try { await assert.rejects(store.append([change]), { code: 'ENOSPC' }); }
  finally { fs.rename = rename; }
  assert.equal(await fs.readFile(store.filePath, 'utf8'), before);
  assert.deepEqual(await fs.readdir(directory), ['activity.json']);
  await store.append([change]);
  assert.equal(project(await store.read()).time, 1);
});

test('a dead owner is reclaimed safely while an old live owner is never stolen', async (t) => {
  const { directory, store } = await setup(t, { lockTimeoutMs: 60 });
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  async function lock(pid) {
    const token = `${pid}-${randomUUID()}`;
    await fs.mkdir(store.lockPath);
    const file = path.join(store.lockPath, `${token}.json`);
    await fs.writeFile(file, JSON.stringify({ pid, token }));
    await fs.utimes(file, new Date(0), new Date(0));
    return file;
  }
  await lock(deadPid);
  await store.append([change]);
  const liveOwner = await lock(process.pid);
  await assert.rejects(store.append([change]), /busy in another window/);
  assert.equal(JSON.parse(await fs.readFile(liveOwner, 'utf8')).pid, process.pid);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['activity.json', 'activity.lock']);
  await fs.unlink(liveOwner);
  await fs.rmdir(store.lockPath);
  assert.equal(project(await store.read()).time, 1);
});

test('lock cleanup failure preserves the original write failure and is surfaced', async (t) => {
  const { store } = await setup(t);
  const writeFailure = Object.assign(new Error('write failed'), { code: 'ENOSPC' });
  store.write = async () => { throw writeFailure; };
  const unlink = fs.unlink;
  fs.unlink = async (file) => {
    if (path.dirname(file) === store.lockPath) throw Object.assign(new Error('cleanup failed'), { code: 'EACCES' });
    return unlink(file);
  };
  try {
    await assert.rejects(store.append([change]), (error) => error === writeFailure && error.cleanupError.code === 'EACCES');
  } finally { fs.unlink = unlink; }
  const owners = await fs.readdir(store.lockPath);
  assert.equal(owners.length, 1);
  assert.deepEqual(await store.read(), emptyData());
  await assert.rejects(fs.stat(store.lockPath), { code: 'ENOENT' });
});

test('caller mutation after enqueue cannot alter an append', async (t) => {
  const { store } = await setup(t);
  const input = structuredClone(change);
  const pending = store.append([input]);
  input.seconds = 900;
  input.file.path = 'changed.js';
  await pending;
  const result = project(await store.read());
  assert.equal(result.time, 1);
  assert.equal(result.files[change.file.id], 'index.js');
});

test('empty appends refresh without rewriting but still reject stale generations', async (t) => {
  const { directory, store } = await setup(t);
  store.write = async () => { throw new Error('An empty append must not write.'); };
  assert.deepEqual(await store.append([]), emptyData());
  const other = new ActivityStore({ directory });
  await other.init();
  await other.clear();
  await assert.rejects(store.append([]), StaleGenerationError);
});

test('cleanup failure after a committed append supplies data so callers cannot replay it', async (t) => {
  const { store } = await setup(t);
  const unlink = fs.unlink;
  fs.unlink = async (file) => {
    if (path.dirname(file) === store.lockPath) throw Object.assign(new Error('cleanup failed'), { code: 'EACCES' });
    return unlink(file);
  };
  try {
    await assert.rejects(store.append([change]), (error) => {
      assert.equal(error.code, 'STORAGE_LOCK_CLEANUP');
      assert.equal(error.cause.code, 'EACCES');
      assert.equal(project(error.committedData).time, 1);
      return true;
    });
  } finally { fs.unlink = unlink; }
  assert.equal(project(await store.read()).time, 1);
  await assert.rejects(fs.stat(store.lockPath), { code: 'ENOENT' });
});

test('version-2 storage preserves old totals and persists language migration on the next append', async (t) => {
  const { directory, store } = await setup(t);
  const stored = JSON.parse(await fs.readFile(store.filePath, 'utf8'));
  stored.data = { version: 2, days: { [change.date]: { projects: {
    [change.projectId]: { name: change.projectName, time: 10, characters: 5, files: { [change.file.id]: change.file.path } },
  } } } };
  await fs.writeFile(store.filePath, JSON.stringify(stored));
  const reopened = new ActivityStore({ directory });
  const initial = await reopened.init();
  assert.equal(initial.version, 3);
  assert.deepEqual(project(initial).languages, { unknown: 10 });
  await reopened.append([{ ...change, languageId: 'javascript' }]);
  const persisted = JSON.parse(await fs.readFile(store.filePath, 'utf8'));
  assert.equal(persisted.generation, stored.generation);
  assert.equal(persisted.data.version, 3);
  assert.equal(project(persisted.data).time, 11);
  assert.deepEqual(project(persisted.data).languages, { unknown: 10, javascript: 1 });
  assert.deepEqual(await new ActivityStore({ directory }).init(), persisted.data);
});
