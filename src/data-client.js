(() => {
  'use strict';

  const DB_NAME = 'EssayFlowDB';
  const STORE_NAME = 'library';

  function readLegacyLocalStorage() {
    const snapshot = {};
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith('essay_')) continue;
      snapshot[key] = localStorage.getItem(key);
    }
    return snapshot;
  }

  function readLegacyIndexedDbLibrary() {
    return new Promise(resolve => {
      if (!window.indexedDB) {
        resolve([]);
        return;
      }
      const request = indexedDB.open(DB_NAME, 1);
      request.onerror = () => resolve([]);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.close();
          resolve([]);
          return;
        }
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const recordsRequest = transaction.objectStore(STORE_NAME).getAll();
        recordsRequest.onerror = () => {
          database.close();
          resolve([]);
        };
        recordsRequest.onsuccess = () => {
          const records = Array.isArray(recordsRequest.result) ? recordsRequest.result : [];
          database.close();
          resolve(records);
        };
      };
    });
  }

  const state = {
    ready: false,
    bootstrap: null,
    settings: {},
    library: { revision: 0, items: [], collections: [] },
    error: null
  };
  window.essayflowDataState = state;

  window.essayflowDataReady = (async () => {
    if (!window.electronAPI?.workspaceBootstrap) {
      state.ready = true;
      return state;
    }
    try {
      const [localStorageSnapshot, indexedDbLibrary] = await Promise.all([
        Promise.resolve(readLegacyLocalStorage()),
        readLegacyIndexedDbLibrary()
      ]);
      const bootstrap = await window.electronAPI.workspaceBootstrap({
        localStorage: localStorageSnapshot,
        indexedDbLibrary
      });
      state.bootstrap = bootstrap;
      state.settings = bootstrap?.settings || {};
      state.library = bootstrap?.library || state.library;
      state.ready = true;
      window.dispatchEvent(new CustomEvent('essayflow-data-ready', { detail: state }));
      return state;
    } catch (error) {
      state.error = error;
      console.error('[data-client] 工作区初始化失败:', error);
      throw error;
    }
  })();
})();
