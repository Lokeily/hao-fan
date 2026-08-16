(() => {
  const createEventTarget = () => {
    const listeners = new Set();
    return {
      addListener(listener) {
        listeners.add(listener);
      },
      removeListener(listener) {
        listeners.delete(listener);
      },
      emit(...args) {
        listeners.forEach((listener) => listener(...args));
      },
    };
  };
  const runtimeEvents = createEventTarget();
  const storageEvents = createEventTarget();
  const query = new URL(location.href).searchParams;
  const disabledFromQuery = query.get('disabled') === '1';
  const policyRaceFromQuery = query.get('policyRace') === '1';
  const policyMessageRaceFromQuery = query.get('policyMessageRace') === '1';
  const configDelayFromQuery = query.get('configDelay') === '1';
  const imageResultFromQuery = query.get('imageResult') === '1';
  let policyRaceTriggered = false;
  const cancelledJobs = new Set();
  // storage mock 后端用真实 localStorage：内容脚本的持久化行为（如工具栏拖拽位置）
  // 跨刷新仍能验证；每个测试用例独立 context，天然隔离。
  const memCache = {
    disabledSites: disabledFromQuery ? [location.host] : [],
    // 测试环境默认不自动翻译（生产默认全开）；auto-translate 用例自行设置
    autoSites: [],
  };
  const memRead = (key) => {
    try {
      const raw = localStorage.getItem(`mock-storage:${key}`);
      if (raw !== null) return JSON.parse(raw);
    } catch {
      /* 解析失败回退内存 */
    }
    return memCache[key];
  };
  const memWrite = (key, value) => {
    memCache[key] = value;
    try {
      localStorage.setItem(`mock-storage:${key}`, JSON.stringify(value));
    } catch {
      /* localStorage 不可用时仅内存 */
    }
  };
  const memory = {
    get disabledSites() {
      return memRead('disabledSites');
    },
    set disabledSites(v) {
      memWrite('disabledSites', v);
    },
  };
  // ===== IndexedDB 最小 mock =====
  // 图片翻译任务已从 storage.local 迁移到 IndexedDB（见 utils/image-job-store.ts），
  // 因此这里提供内存版 indexedDB，并在 imageResult=1 时预置一份 'test' 任务。
  const idbDatabases = new Map();
  const idbQueued = (fn) => setTimeout(fn, 0);

  function createIdbRequest() {
    return { onsuccess: null, onerror: null, result: undefined, error: null };
  }
  function completeIdbRequest(request, value) {
    request.result = value;
    idbQueued(() => request.onsuccess && request.onsuccess({ target: request }));
  }

  function createIdbStore() {
    const data = new Map();
    return {
      data,
      put(value, key) {
        const request = createIdbRequest();
        data.set(String(key), value);
        completeIdbRequest(request);
        return request;
      },
      get(key) {
        const request = createIdbRequest();
        completeIdbRequest(request, data.get(String(key)));
        return request;
      },
      delete(key) {
        const request = createIdbRequest();
        data.delete(String(key));
        completeIdbRequest(request);
        return request;
      },
    };
  }

  function createIdbDb(name) {
    const stores = new Map();
    return {
      name,
      objectStoreNames: { contains: (storeName) => stores.has(storeName) },
      createObjectStore(storeName) {
        const store = createIdbStore();
        stores.set(storeName, store);
        return store;
      },
      transaction(storeName) {
        const store = stores.get(storeName);
        const tx = {
          objectStore: (requested) => (requested === storeName ? store : null),
          oncomplete: null,
          onerror: null,
          error: null,
        };
        idbQueued(() => tx.oncomplete && tx.oncomplete({}));
        return tx;
      },
    };
  }

  globalThis.indexedDB = {
    open(name) {
      const request = createIdbRequest();
      let db = idbDatabases.get(name);
      if (!db) {
        db = createIdbDb(name);
        idbDatabases.set(name, db);
        request.result = db;
        idbQueued(() => request.onupgradeneeded && request.onupgradeneeded({ target: request }));
      } else {
        request.result = db;
      }
      idbQueued(() => request.onsuccess && request.onsuccess({ target: request }));
      return request;
    },
  };

  if (imageResultFromQuery) {
    const seed = indexedDB.open('haofan-image-jobs');
    seed.onupgradeneeded = () => {
      if (!seed.result.objectStoreNames.contains('jobs')) seed.result.createObjectStore('jobs');
    };
    seed.onsuccess = () => {
      const tx = seed.result.transaction('jobs', 'readwrite');
      tx.objectStore('jobs').put(
        {
          image:
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          segments: [
            {
              text: 'Hello',
              translation: '你好',
              x: 0.08,
              y: 0.1,
              w: 0.36,
              h: 0.2,
            },
          ],
        },
        'test',
      );
    };
  }
  const area = {
    onChanged: storageEvents,
    async get(keys) {
      if (configDelayFromQuery && keys === 'config') {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (policyMessageRaceFromQuery && !policyRaceTriggered && keys === 'disabledSites') {
        policyRaceTriggered = true;
        const snapshot = memory.disabledSites;
        setTimeout(
          () =>
            runtimeEvents.emit({
              type: 'SITE_POLICY_CHANGED',
              payload: { disabled: true },
            }),
          0,
        );
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { disabledSites: snapshot };
      }
      if (policyRaceFromQuery && !policyRaceTriggered && keys === 'disabledSites') {
        policyRaceTriggered = true;
        const snapshot = memory.disabledSites;
        setTimeout(() => void area.set({ disabledSites: [location.host] }), 0);
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { disabledSites: snapshot };
      }
      const read = (key) => memRead(key);
      if (typeof keys === 'string') return { [keys]: read(keys) };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, read(key)]));
      }
      const all = {};
      for (const key of Object.keys(memCache)) all[key] = read(key);
      return all;
    },
    async set(values) {
      const changes = {};
      Object.entries(values).forEach(([key, value]) => {
        changes[key] = { oldValue: memRead(key), newValue: value };
        memWrite(key, value);
      });
      storageEvents.emit(changes);
    },
    async remove(keys) {
      for (const key of [keys].flat()) {
        try {
          localStorage.removeItem(`mock-storage:${key}`);
        } catch {
          /* ignore */
        }
        delete memCache[key];
      }
    },
    async clear() {
      for (const key of Object.keys(memCache)) {
        try {
          localStorage.removeItem(`mock-storage:${key}`);
        } catch {
          /* ignore */
        }
        delete memCache[key];
      }
    },
  };
  const root = document.documentElement;
  root.dataset.translationCalls = '0';
  root.dataset.singleRequests = '0';
  root.dataset.activeSingles = '0';
  root.dataset.maxActiveSingles = '0';
  root.dataset.batchRequests = '0';
  root.dataset.batchCompletions = '0';
  root.dataset.cancelRequests = '0';
  root.dataset.requestedTexts = '[]';

  const recordTexts = (texts) => {
    const recorded = JSON.parse(root.dataset.requestedTexts || '[]');
    root.dataset.requestedTexts = JSON.stringify([...recorded, ...texts]);
  };

  globalThis.chrome = {
    runtime: {
      id: 'haofan-browser-regression',
      onMessage: runtimeEvents,
      getURL(path) {
        return path === '/icon-128.png' ? '/public/icon-128.png' : path;
      },
      async sendMessage(message) {
        root.dataset.translationCalls = String(Number(root.dataset.translationCalls || '0') + 1);
        if (message?.type === 'CANCEL_TRANSLATION') {
          const jobId = message.payload?.jobId;
          if (jobId) cancelledJobs.add(jobId);
          root.dataset.cancelRequests = String(Number(root.dataset.cancelRequests || '0') + 1);
          return { ok: true };
        }
        if (message?.type === 'TRANSLATE_ONE') {
          const text = message.payload.text;
          recordTexts([text]);
          root.dataset.singleRequests = String(Number(root.dataset.singleRequests || '0') + 1);
          const active = Number(root.dataset.activeSingles || '0') + 1;
          root.dataset.activeSingles = String(active);
          root.dataset.maxActiveSingles = String(
            Math.max(active, Number(root.dataset.maxActiveSingles || '0')),
          );
          const singleDelay = Number(root.dataset.singleDelay) || 20;
          await new Promise((resolve) => setTimeout(resolve, singleDelay));
          root.dataset.activeSingles = String(
            Math.max(0, Number(root.dataset.activeSingles || '0') - 1),
          );
          if (cancelledJobs.has(message.payload?.jobId)) {
            return { ok: false, error: '翻译任务已取消' };
          }
          return {
            ok: true,
            translation:
              text === 'Enable two-factor authentication' ? '启用双重身份验证' : `译文：${text}`,
            stats: {},
          };
        }
        if (message?.type === 'TRANSLATE_BATCH') {
          const texts = message.payload.texts;
          recordTexts(texts);
          const requestIndex = Number(root.dataset.batchRequests || '0');
          root.dataset.batchRequests = String(requestIndex + 1);
          const delays = JSON.parse(root.dataset.batchDelays || '[]');
          const delay = Number(delays[requestIndex]) || 0;
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
          root.dataset.batchCompletions = String(Number(root.dataset.batchCompletions || '0') + 1);
          return {
            ok: true,
            translations:
              root.dataset.batchMode === 'mismatch' ? [] : texts.map((text) => `译文：${text}`),
            stats: {},
          };
        }
        return { ok: true };
      },
    },
    storage: {
      local: area,
      session: area,
      sync: area,
      managed: area,
      onChanged: storageEvents,
    },
    tabs: {
      async query() {
        return [{ id: 7, url: root.dataset.activeUrl || location.href }];
      },
      async sendMessage() {
        return { ok: true };
      },
    },
    scripting: {
      async executeScript() {},
    },
  };
  globalThis.__setHaofanDisabledSites = (sites) => area.set({ disabledSites: sites });
})();
