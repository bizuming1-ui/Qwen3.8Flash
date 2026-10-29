(() => {
  const fieldNames = ['productionOrder', 'product', 'productionTotal', 'currentProduction', 'now'];
  const fieldLabels = {
    productionOrder: '生产单',
    product: '产品',
    productionTotal: '生产总数',
    currentProduction: '当前生产数',
    now: '现在',
  };
  const inputs = Object.fromEntries(fieldNames.map((name) => [
    name,
    document.querySelector(`[name="${name}"]`),
  ]));
  const form = document.getElementById('production-form');
  const confirmButton = document.getElementById('confirm');
  const statusElement = document.getElementById('status');
  const qrImage = document.getElementById('share-qr');
  const shareAddress = document.getElementById('share-address');
  const trackers = Object.fromEntries(fieldNames.map((name) => [name, {
    dirty: false,
    conflict: false,
    problem: '',
    paused: false,
    composing: false,
    baseVersion: 0,
    sequence: 0,
    timer: null,
    inFlight: null,
    retryDelay: 0,
  }]));

  let state = null;
  let connected = false;
  let confirming = false;
  let notice = '';
  let noticeTimer = null;
  let shareWarning = '';
  let shareSetupInFlight = false;
  let shareReady = false;
  let shareRetryTimer = null;

  function renderStatus() {
    let text = '';
    if (!state) text = '正在连接，请稍候。';
    else if (!connected) text = '连接已中断，正在自动重连；未保存的输入会保留。';
    else {
      const conflict = fieldNames.find((name) => trackers[name].conflict);
      text = notice || (conflict ? trackers[conflict].problem : '') || shareWarning;
    }
    statusElement.textContent = text;
    statusElement.hidden = !text;
  }

  function setNotice(text, persistent = false) {
    clearTimeout(noticeTimer);
    notice = text;
    renderStatus();
    if (!persistent) {
      noticeTimer = setTimeout(() => {
        if (notice === text) notice = '';
        renderStatus();
      }, 6000);
    }
  }

  function clearNotice() {
    clearTimeout(noticeTimer);
    notice = '';
    renderStatus();
  }

  function renderField(name) {
    const tracker = trackers[name];
    if (!state || tracker.dirty || tracker.paused) return;
    const input = inputs[name];
    if (input.value !== state.values[name]) input.value = state.values[name];
    tracker.baseVersion = state.versions[name];
    input.removeAttribute('aria-invalid');
  }

  function applyState(next) {
    if (!next || !Number.isSafeInteger(next.revision) || !next.values || !next.versions ||
        fieldNames.some((name) => typeof next.values[name] !== 'string' ||
          !Number.isSafeInteger(next.versions[name]))) return;
    if (state && next.revision < state.revision) return;

    const firstState = state === null;
    state = next;
    for (const name of fieldNames) renderField(name);
    if (firstState) {
      for (const input of Object.values(inputs)) input.disabled = false;
      confirmButton.disabled = false;
    }
    renderStatus();
  }

  async function requestJson(path, method, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: controller.signal,
      });
      const data = await response.json();
      return { ok: response.ok, status: response.status, data };
    } finally {
      clearTimeout(timeout);
    }
  }

  function scheduleSave(name, delay = 120) {
    const tracker = trackers[name];
    if (!state || !tracker.dirty || tracker.conflict || tracker.paused || tracker.composing) return;
    clearTimeout(tracker.timer);
    tracker.timer = setTimeout(() => {
      tracker.timer = null;
      void saveField(name);
    }, delay);
  }

  function markConflict(name, message) {
    const tracker = trackers[name];
    tracker.dirty = true;
    tracker.conflict = true;
    tracker.problem = message || `“${fieldLabels[name]}”已被其他设备修改，请检查并重新编辑该项。`;
    inputs[name].setAttribute('aria-invalid', 'true');
    setNotice(tracker.problem, true);
  }

  function saveField(name) {
    const tracker = trackers[name];
    if (!state || !tracker.dirty || tracker.conflict || tracker.paused || tracker.composing || tracker.inFlight) {
      return tracker.inFlight || Promise.resolve();
    }
    const sentSequence = tracker.sequence;
    const sentValue = inputs[name].value;
    const expectedVersion = tracker.baseVersion;

    const operation = (async () => {
      let retry = false;
      try {
        const response = await requestJson('/api/state', 'PATCH', {
          field: name,
          value: sentValue,
          expectedVersion,
        });
        if (response.status === 409 && response.data.state) {
          applyState(response.data.state);
          markConflict(name);
          return;
        }
        if (response.status >= 500 || response.status === 429) throw new Error('temporary server error');
        if (!response.ok || !response.data.state) {
          markConflict(name, response.data.message || `“${fieldLabels[name]}”保存失败，请重新编辑。`);
          return;
        }

        // Use this operation's version for subsequent unsaved typing, even if
        // a newer event from a different device arrived before the response.
        tracker.baseVersion = response.data.state.versions[name];
        tracker.retryDelay = 0;
        applyState(response.data.state);
        if (tracker.sequence === sentSequence) {
          tracker.dirty = false;
          renderField(name);
        }
        if (notice === '保存暂时失败，正在自动重试。') clearNotice();
      } catch {
        retry = true;
        tracker.retryDelay = tracker.retryDelay ? Math.min(tracker.retryDelay * 2, 5000) : 1000;
        setNotice('保存暂时失败，正在自动重试。', true);
      } finally {
        tracker.inFlight = null;
        if (tracker.dirty && !tracker.conflict && !tracker.paused && !tracker.composing) {
          scheduleSave(name, retry ? tracker.retryDelay : 0);
        }
      }
    })();
    tracker.inFlight = operation;
    return operation;
  }

  for (const name of fieldNames) {
    const input = inputs[name];
    const tracker = trackers[name];
    input.addEventListener('input', () => {
      if (!state) return;
      if (!tracker.dirty || tracker.conflict) {
        tracker.baseVersion = state.versions[name];
        tracker.dirty = true;
        tracker.conflict = false;
        tracker.problem = '';
      }
      tracker.sequence += 1;
      input.removeAttribute('aria-invalid');
      clearNotice();
      scheduleSave(name);
    });
    input.addEventListener('compositionstart', () => {
      tracker.composing = true;
      clearTimeout(tracker.timer);
      tracker.timer = null;
    });
    input.addEventListener('compositionend', () => {
      tracker.composing = false;
      scheduleSave(name);
    });
    input.addEventListener('blur', () => scheduleSave(name, 0));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && tracker.conflict) {
        tracker.dirty = false;
        tracker.conflict = false;
        tracker.problem = '';
        renderField(name);
        clearNotice();
      }
    });
  }

  const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function newRequestId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  async function requestConfirmation(body) {
    let retryDelay = 500;
    while (true) {
      try {
        const response = await requestJson('/api/confirm', 'POST', body);
        if (response.status >= 500 || response.status === 429) throw new Error('temporary server error');
        return response;
      } catch {
        // The server stores this request id, so a retry cannot clear new input
        // if the first confirmation succeeded but its response was lost.
        setNotice('确认结果暂未收到，正在自动重试，请勿重复操作。', true);
        await delay(retryDelay);
        retryDelay = Math.min(retryDelay * 2, 5000);
      }
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state || confirming) return;
    const nowInput = inputs.now;
    const nowTracker = trackers.now;
    const currentTracker = trackers.currentProduction;
    const value = nowInput.value;

    if (nowTracker.composing || !numberPattern.test(value)) {
      nowInput.setAttribute('aria-invalid', 'true');
      setNotice('请在“现在”输入有效数字。');
      nowInput.focus();
      return;
    }
    if (nowTracker.conflict) {
      setNotice('“现在”已被其他设备修改，请检查并重新编辑后再确认。', true);
      nowInput.focus();
      return;
    }

    confirming = true;
    confirmButton.disabled = true;
    const pausedNames = ['now', 'currentProduction'];
    for (const name of pausedNames) {
      const tracker = trackers[name];
      tracker.paused = true;
      clearTimeout(tracker.timer);
      tracker.timer = null;
      inputs[name].readOnly = true;
    }

    let confirmed = false;
    try {
      // Finish older writes from this browser before the atomic confirmation;
      // otherwise an old edit could arrive after it and restore a cleared value.
      await Promise.all(pausedNames.map((name) => trackers[name].inFlight).filter(Boolean));
      if (nowTracker.conflict) {
        setNotice('“现在”已被其他设备修改，请检查并重新编辑后再确认。', true);
        return;
      }

      const response = await requestConfirmation({
        id: newRequestId(),
        value,
        expectedVersion: nowTracker.baseVersion,
      });
      if (response.status === 409 && response.data.error === 'CONFLICT' && response.data.state) {
        applyState(response.data.state);
        nowInput.value = value;
        markConflict('now', '“现在”已被其他设备修改，请检查并重新编辑后再确认。');
        return;
      }
      if (!response.ok || !response.data.state) {
        setNotice(response.data.message || '确认失败，请检查后重试。', true);
        return;
      }

      // Confirmation deliberately replaces the local current-production draft.
      for (const name of pausedNames) {
        trackers[name].dirty = false;
        trackers[name].conflict = false;
        trackers[name].problem = '';
        trackers[name].retryDelay = 0;
        inputs[name].removeAttribute('aria-invalid');
      }
      applyState(response.data.state);
      confirmed = true;
      clearNotice();
    } finally {
      for (const name of pausedNames) {
        const tracker = trackers[name];
        tracker.paused = false;
        inputs[name].readOnly = false;
        if (confirmed || !tracker.dirty) renderField(name);
        else scheduleSave(name, 0);
      }
      confirming = false;
      confirmButton.disabled = false;
    }
  });

  function scheduleShareRetry() {
    clearTimeout(shareRetryTimer);
    shareRetryTimer = setTimeout(() => void setupShare(), 2000);
  }

  async function setupShare() {
    if (shareSetupInFlight || shareReady) return;
    clearTimeout(shareRetryTimer);
    shareSetupInFlight = true;
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      if (!response.ok) throw new Error('configuration unavailable');
      const config = await response.json();
      const url = config.publicUrl ? new URL(config.publicUrl) : new URL('/', window.location.href);
      const loopback = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'].includes(url.hostname);
      shareWarning = '';
      if (!config.publicUrl && loopback) {
        if (config.lanAddress) url.hostname = config.lanAddress;
        else shareWarning = '当前是本机地址，其他设备需使用可访问的局域网地址或配置 PUBLIC_URL。';
      }
      shareAddress.textContent = `分享地址：${url.href}`;
      qrImage.title = `扫描打开：${url.href}`;
      qrImage.src = `/api/qr?url=${encodeURIComponent(url.href)}`;
      shareReady = true;
      renderStatus();
    } catch {
      shareWarning = '二维码暂时不可用，正在自动重试。';
      renderStatus();
      scheduleShareRetry();
    } finally {
      shareSetupInFlight = false;
    }
  }

  qrImage.addEventListener('error', () => {
    shareReady = false;
    shareWarning = '二维码暂时不可用，正在自动重试。';
    renderStatus();
    scheduleShareRetry();
  });

  const events = new EventSource('/api/events');
  events.addEventListener('state', (event) => {
    try {
      applyState(JSON.parse(event.data));
    } catch {
      setNotice('接收到的数据无效，正在等待下一次同步。');
    }
  });
  events.onopen = () => {
    connected = true;
    renderStatus();
    void setupShare();
    for (const name of fieldNames) scheduleSave(name, 0);
  };
  events.onerror = () => {
    connected = false;
    renderStatus();
  };

  // Best effort for a last edit when the tab is closed before its debounce.
  window.addEventListener('pagehide', () => {
    for (const name of fieldNames) {
      const tracker = trackers[name];
      if (!tracker.dirty || tracker.conflict || tracker.paused || tracker.composing || tracker.inFlight) continue;
      fetch('/api/state', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: name, value: inputs[name].value, expectedVersion: tracker.baseVersion }),
        keepalive: true,
      }).catch(() => {});
    }
  });

  renderStatus();
})();
