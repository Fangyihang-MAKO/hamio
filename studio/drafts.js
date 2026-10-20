/** One local IndexedDB draft. No requests, localStorage image copies, or fallback cache. */
import { normalizeDraft } from './project.js?v=workflow-1';

export const DRAFT_DATABASE_NAME = 'hamio-studio-drafts';
const STORE = 'drafts';
const KEY = 'current';
const queues = new WeakMap();

function storageError(error, code = 'DRAFT_STORAGE_FAILED') {
  if (error?.code?.startsWith?.('DRAFT_STORAGE_')) return error;
  const quota = error?.name === 'QuotaExceededError';
  const result = new Error(quota
    ? '浏览器本地存储空间不足，草稿未保存；请导出项目或减少图片后重试'
    : `无法访问本地草稿${error?.message ? `：${error.message}` : '，请检查浏览器存储权限'}`);
  result.name = 'DraftStorageError';
  result.code = quota ? 'DRAFT_STORAGE_QUOTA' : code;
  if (error) result.cause = error;
  return result;
}

function openDatabase(factory, databaseName) {
  return new Promise((resolve, reject) => {
    if (!factory || typeof factory.open !== 'function') {
      reject(storageError(new Error('此浏览器不支持 IndexedDB'), 'DRAFT_STORAGE_UNAVAILABLE'));
      return;
    }
    let request;
    let settled = false;
    try { request = factory.open(databaseName, 1); }
    catch (error) { reject(storageError(error)); return; }
    const fail = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(error);
    };
    const timer = setTimeout(() => fail(storageError(new Error('本地草稿读取超时，请重试'), 'DRAFT_STORAGE_TIMEOUT')), 6000);
    request.onupgradeneeded = () => {
      if (settled) { request.transaction?.abort(); return; }
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
    };
    request.onerror = () => {
      fail(storageError(request.error));
    };
    request.onblocked = () => {
      fail(storageError(new Error('另一个页面正在使用旧版草稿，请关闭它后重试'), 'DRAFT_STORAGE_BLOCKED'));
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) { database.close(); return; }
      settled = true; clearTimeout(timer);
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

async function transact(factory, databaseName, operation, snapshot) {
  const database = await openDatabase(factory, databaseName);
  try {
    return await new Promise((resolve, reject) => {
      let transaction;
      let result;
      let requestError;
      let timer;
      try {
        transaction = database.transaction(STORE, operation === 'load' ? 'readonly' : 'readwrite');
        const store = transaction.objectStore(STORE);
        const request = operation === 'save' ? store.put(snapshot, KEY)
          : operation === 'clear' ? store.delete(KEY) : store.get(KEY);
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => { requestError = request.error; };
        // A request succeeding is not enough: only a committed transaction counts as saved.
        transaction.oncomplete = () => { clearTimeout(timer); resolve(operation === 'load' ? result : undefined); };
        transaction.onabort = () => { clearTimeout(timer); reject(storageError(requestError || transaction.error)); };
        transaction.onerror = () => { requestError ||= transaction.error; };
        timer = setTimeout(() => {
          requestError = storageError(new Error('本地草稿操作超时，请重试'), 'DRAFT_STORAGE_TIMEOUT');
          // Reject only after an actual abort. Rejecting while a write is still live could
          // report failure and then silently commit it after the user clears or retries.
          try { transaction.abort(); } catch { /* A finished commit still reports oncomplete. */ }
        }, 10000);
      } catch (error) {
        clearTimeout(timer);
        try { transaction?.abort(); } catch { /* An already-complete transaction has nothing to abort. */ }
        reject(storageError(error));
      }
    });
  } finally { database.close(); }
}

/**
 * load() -> Promise<normalized draft | null>
 * save(wrapper) -> Promise<normalized saved draft>; savedAt is supplied by the caller.
 * clear() -> Promise<void>
 * Each call is ordered with all earlier calls for this database in this page. Failures reject
 * to the UI and never read from a stale cache. Validation and snapshotting happen at save().
 * The optional factory/name allow isolated browser tests without touching the user's draft.
 */
export function createDraftStore({ indexedDB = globalThis.indexedDB, databaseName = DRAFT_DATABASE_NAME } = {}) {
  let coordinator = { tail: Promise.resolve() };
  if (indexedDB && (typeof indexedDB === 'object' || typeof indexedDB === 'function')) {
    if (!queues.has(indexedDB)) queues.set(indexedDB, new Map());
    const names = queues.get(indexedDB);
    if (!names.has(databaseName)) names.set(databaseName, coordinator);
    coordinator = names.get(databaseName);
  }
  function enqueue(action) {
    const pending = coordinator.tail.then(action);
    // Keep a failed operation from permanently poisoning the queue; its caller still receives
    // the rejection. No rejected writes are retried later, especially after an explicit clear.
    coordinator.tail = pending.catch(() => {});
    return pending;
  }
  return Object.freeze({
    load() {
      return enqueue(async () => {
        const value = await transact(indexedDB, databaseName, 'load');
        return value === undefined ? null : normalizeDraft(value);
      });
    },
    save(value) {
      let snapshot;
      try { snapshot = normalizeDraft(value); }
      catch (error) { return Promise.reject(error); }
      return enqueue(async () => {
        await transact(indexedDB, databaseName, 'save', snapshot);
        return snapshot;
      });
    },
    clear() { return enqueue(() => transact(indexedDB, databaseName, 'clear')); },
  });
}
