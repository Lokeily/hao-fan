(() => {
  const createEventTarget = () => {
    const listeners = new Set();
    return {
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); },
      emit(...args) { listeners.forEach((listener) => listener(...args)); },
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
  const memory = {
    disabledSites: disabledFromQuery ? [location.host] : [],
    ...(imageResultFromQuery
      ? {
        'imageJob:test': {
          image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          segments: [{
            text: 'Hello',
            translation: '你好',
            x: 0.08,
            y: 0.1,
            w: 0.36,
            h: 0.2,
          }],
        },
      }
      : {}),
  };
  const area = {
    onChanged: storageEvents,
    async get(keys) {
      if (configDelayFromQuery && keys === 'config') {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (policyMessageRaceFromQuery && !policyRaceTriggered && keys === 'disabledSites') {
        policyRaceTriggered = true;
        const snapshot = memory.disabledSites;
        setTimeout(() => runtimeEvents.emit({
          type: 'SITE_POLICY_CHANGED',
          payload: { disabled: true },
        }), 0);
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
      if (typeof keys === 'string') return { [keys]: memory[keys] };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, memory[key]]));
      }
      return { ...memory };
    },
    async set(values) {
      const changes = {};
      Object.entries(values).forEach(([key, value]) => {
        changes[key] = { oldValue: memory[key], newValue: value };
        memory[key] = value;
      });
      storageEvents.emit(changes);
    },
    async remove(keys) {
      for (const key of [keys].flat()) delete memory[key];
    },
    async clear() {
      Object.keys(memory).forEach((key) => delete memory[key]);
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
          root.dataset.maxActiveSingles = String(Math.max(
            active,
            Number(root.dataset.maxActiveSingles || '0'),
          ));
          const singleDelay = Number(root.dataset.singleDelay) || 20;
          await new Promise((resolve) => setTimeout(resolve, singleDelay));
          root.dataset.activeSingles = String(Math.max(
            0,
            Number(root.dataset.activeSingles || '0') - 1,
          ));
          if (cancelledJobs.has(message.payload?.jobId)) {
            return { ok: false, error: '翻译任务已取消' };
          }
          return {
            ok: true,
            translation: text === 'Enable two-factor authentication'
              ? '启用双重身份验证'
              : `译文：${text}`,
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
          root.dataset.batchCompletions = String(
            Number(root.dataset.batchCompletions || '0') + 1,
          );
          return {
            ok: true,
            translations: root.dataset.batchMode === 'mismatch'
              ? []
              : texts.map((text) => `译文：${text}`),
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
