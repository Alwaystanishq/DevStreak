const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { emptyData, validateData, migrateLegacy, applyChanges } = require('./model');

class StaleGenerationError extends Error {
  constructor() {
    super('Activity was cleared or imported in another window. Discard pending activity and refresh storage.');
    this.name = 'StaleGenerationError';
    this.code = 'STALE_GENERATION';
  }
}

function storageError(message, cause) {
  const error = Object.assign(new Error(`${message} Existing activity was not overwritten.`, { cause }), { code: "INVALID_STORAGE" });
  error.code = 'INVALID_STORAGE';
  return error;
}

class ActivityStore {
  /** @param {{directory: string, legacyData?: unknown, lockTimeoutMs?: number}} options */
  constructor({ directory, legacyData, lockTimeoutMs = 5000 }) {
    if (!path.isAbsolute(directory)) throw new TypeError('Storage directory must be absolute.');
    if (!Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 0) throw new TypeError('Lock timeout must be a nonnegative finite number.');
    this.directory = directory;
    this.filePath = path.join(directory, 'activity.json');
    this.lockPath = path.join(directory, 'activity.lock');
    this.legacyData = legacyData;
    this.lockTimeoutMs = lockTimeoutMs;
    this.generation = null;
    this.queue = Promise.resolve();
    this.pendingRelease = null;
  }

  init() {
    return this.enqueue(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      return this.withLock(async () => {
        let stored = await this.load();
        if (!stored) {
          const data = this.legacyData === undefined ? emptyData() : migrateLegacy(this.legacyData);
          stored = { storageVersion: 1, generation: randomUUID(), data: validateData(data) };
          await this.write(stored);
        }
        this.generation = stored.generation;
        return stored.data;
      });
    });
  }

  read() {
    return this.enqueue(() => this.withLock(async () => {
      const stored = await this.loadRequired();
      this.generation = stored.generation;
      return stored.data;
    }));
  }

  /** @param {import('./types').ActivityChange[]} changes */
  append(changes) {
    // Capture BEFORE enqueueing: an earlier queued read must not bless stale deltas.
    const expectedGeneration = this.generation;
    let snapshot;
    try { snapshot = structuredClone(changes); } catch (error) { return Promise.reject(error); }
    return this.enqueue(() => this.withLock(async () => {
      const stored = await this.loadRequired();
      if (expectedGeneration === null) throw new Error('Initialize activity storage before appending.');
      if (stored.generation !== expectedGeneration) throw new StaleGenerationError();
      if (Array.isArray(snapshot) && snapshot.length === 0) return stored.data;
      const data = validateData(applyChanges(stored.data, snapshot));
      await this.write({ ...stored, data });
      return data;
    }));
  }

  /** @param {import('./types').ActivityData} data */
  replace(data) {
    let snapshot;
    try { snapshot = validateData(structuredClone(data)); } catch (error) { return Promise.reject(error); }
    return this.enqueue(() => this.withLock(async () => {
      // Even an explicit replacement must surface corrupt existing storage.
      await this.loadRequired();
      const stored = { storageVersion: 1, generation: randomUUID(), data: snapshot };
      await this.write(stored);
      this.generation = stored.generation;
      return stored.data;
    }));
  }

  clear() {
    return this.replace(emptyData());
  }

  recover(data = emptyData()) {
    let snapshot;
    try { snapshot = validateData(structuredClone(data)); } catch (error) { return Promise.reject(error); }
    return this.enqueue(() => this.withLock(async () => {
      // Never replace healthy history if another window repaired it meanwhile.
      try {
        if (await this.load()) throw new Error('Storage is readable again. Choose Retry loading before replacing history.');
      } catch (error) {
        if (error.code !== 'INVALID_STORAGE') throw error;
        const preserved = path.join(this.directory, `activity.corrupt-${Date.now()}-${randomUUID()}.json`);
        await fs.copyFile(this.filePath, preserved, fs.constants.COPYFILE_EXCL);
        this.lastRecoveryPath = preserved;
      }
      const stored = { storageVersion: 1, generation: randomUUID(), data: snapshot };
      await this.write(stored);
      this.generation = stored.generation;
      return stored.data;
    }));
  }

  enqueue(operation) {
    const pending = this.queue.then(operation);
    this.queue = pending.catch(() => {});
    return pending;
  }

  async load() {
    let text;
    try { text = await fs.readFile(this.filePath, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const stored = JSON.parse(text);
      if (!stored || stored.storageVersion !== 1 || typeof stored.generation !== 'string'
        || !/^[0-9a-f-]{36}$/i.test(stored.generation)) {
        throw new Error('Unrecognized storage format.');
      }
      return { storageVersion: 1, generation: stored.generation, data: validateData(stored.data) };
    } catch (error) {
      throw storageError('Activity storage is corrupt or unsupported.', error);
    }
  }

  async loadRequired() {
    const stored = await this.load();
    if (!stored) throw storageError('Activity storage is missing; initialize it before use.');
    return stored;
  }

  async write(stored) {
    const temporary = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    let handle;
    let failure;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(stored));
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, this.filePath);
    } catch (error) { failure = error; }
    finally {
      if (handle) {
        try { await handle.close(); } catch (error) { failure ||= error; }
      }
      // After rename the write is committed and there is no temporary file.
      // A cleanup failure must not make callers replay already saved activity.
      if (failure) {
        try { await fs.unlink(temporary); }
        catch (error) { if (error.code !== 'ENOENT') failure ||= error; }
      }
    }
    if (failure) throw failure;
  }

  async withLock(operation) {
    if (this.pendingRelease) {
      await this.pendingRelease();
      this.pendingRelease = null;
    }
    const release = await this.acquireLock();
    let value;
    let failure;
    try { value = await operation(); } catch (error) { failure = error; }
    try { await release(); }
    catch (error) {
      this.pendingRelease = release;
      if (failure) failure.cleanupError = error;
      else {
        failure = Object.assign(new Error('Activity storage operation completed, but its lock could not be released.', { cause: error }), { code: 'STORAGE_LOCK_CLEANUP', committedData: value });
        failure.code = 'STORAGE_LOCK_CLEANUP';
        // The caller must acknowledge these deltas instead of replaying them.
        failure.committedData = value;
      }
    }
    if (failure) throw failure;
    return value;
  }

  async acquireLock() {
    const token = `${process.pid}-${randomUUID()}`;
    const ownerName = `${token}.json`;
    const candidate = path.join(this.directory, `.activity-lock-${token}`);
    const candidateOwner = path.join(candidate, ownerName);
    let acquired = false;
    let failure;
    try {
      // Publish a fully populated directory atomically; no ownerless active lock.
      await fs.mkdir(candidate, { mode: 0o700 });
      await fs.writeFile(candidateOwner, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
      const deadline = Date.now() + this.lockTimeoutMs;
      while (true) {
        try {
          await fs.rename(candidate, this.lockPath);
          acquired = true;
          break;
        } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
          await this.reclaimDeadLock();
          if (Date.now() >= deadline) throw new Error('Activity storage is busy in another window; retry shortly.');
          await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 15)));
        }
      }
    } catch (error) { failure = error; }
    finally {
      if (!acquired) {
        try { await fs.unlink(candidateOwner); }
        catch (error) { if (error.code !== 'ENOENT') failure ||= error; }
        try { await fs.rmdir(candidate); }
        catch (error) { if (error.code !== 'ENOENT') failure ||= error; }
      }
    }
    if (failure) throw failure;
    let ownerRemoved = false;
    return async () => {
      // Removing only our own token also prevents stale reclaimers deleting a
      // replacement lock. A new owner can replace the now-empty directory.
      if (!ownerRemoved) {
        try { await fs.unlink(path.join(this.lockPath, ownerName)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        ownerRemoved = true;
      }
      try { await fs.rmdir(this.lockPath); }
      catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    };
  }

  async reclaimDeadLock() {
    let names;
    try { names = await fs.readdir(this.lockPath); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (names.length === 0) {
      // Published locks are never empty while owned. This is an interrupted
      // release (also lets Windows acquire without replacing a directory).
      try { await fs.rmdir(this.lockPath); }
      catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
      return;
    }
    if (names.length !== 1 || !/^\d+-[0-9a-f-]{36}\.json$/i.test(names[0])) return;
    const ownerPath = path.join(this.lockPath, names[0]);
    let owner;
    try { owner = JSON.parse(await fs.readFile(ownerPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return; throw error; }
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || `${owner.token}.json` !== names[0]
      || !owner.token.startsWith(`${owner.pid}-`)) return;
    try { process.kill(owner.pid, 0); return; }
    catch (error) { if (error.code !== 'ESRCH') return; }
    // Only the contender that removes this particular dead owner's token may
    // remove its directory. Others cannot remove a newly acquired lock.
    try { await fs.unlink(ownerPath); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    try { await fs.rmdir(this.lockPath); }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  }
}

module.exports = { ActivityStore, StaleGenerationError };
