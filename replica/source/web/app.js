"use strict";
(() => {
  var M = class {
      constructor() {
        this.buf = new Uint8Array(0);
      }
      push(e) {
        if (this.buf.length === 0) this.buf = e;
        else {
          let n = new Uint8Array(this.buf.length + e.length);
          (n.set(this.buf, 0), n.set(e, this.buf.length), (this.buf = n));
        }
        let s = [],
          i = 0;
        for (; this.buf.length - i >= 9; ) {
          let n = new DataView(this.buf.buffer, this.buf.byteOffset + i, 9),
            d = n.getUint8(0),
            l = n.getUint32(1, !0),
            a = n.getUint32(5, !0);
          if (a > 32 * 1024 * 1024) throw new Error("音频协议帧超过32MiB限制");
          if (this.buf.length - i - 9 < a) break;
          (s.push({
            type: d,
            seg: l,
            payload: this.buf.slice(i + 9, i + 9 + a),
          }),
            (i += 9 + a));
        }
        return ((this.buf = i > 0 ? this.buf.slice(i) : this.buf), s);
      }
    },
    Q = new TextDecoder();
  function S(t) {
    return JSON.parse(Q.decode(t));
  }
  var V = `
class QttsRing extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = Math.floor(sampleRate * 180);
    this.buf = new Float32Array(this.cap);
    this.r = 0; this.w = 0; this.fill = 0;
    this.playing = false; this.starved = false;
    this.played = 0; this.underruns = 0; this.dropped = 0;
    this.last = 0; this.fadeIn = 0; this.tick = 0; this.ended = false; this.epoch = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.t === 'reset' && Number.isSafeInteger(m.epoch) && m.epoch >= this.epoch) this.epoch = m.epoch;
      if (m.epoch !== this.epoch) return;
      if (m.t === 'pcm') {
        if (this.ended) return;
        const d = m.d;
        for (let i = 0; i < d.length; i++) {
          if (this.fill >= this.cap) { this.dropped++; continue; }
          this.buf[this.w] = d[i];
          this.w = (this.w + 1) % this.cap; this.fill++;
        }
      } else if (m.t === 'play') {
        if (!this.playing) { this.playing = true; this.starved = false; this.fadeIn = 192; }
      } else if (m.t === 'hold') {
        this.playing = false;
      } else if (m.t === 'end') {
        this.ended = true;
      } else if (m.t === 'reset') {
        this.r = 0; this.w = 0; this.fill = 0; this.playing = false; this.starved = false;
        this.played = 0; this.underruns = 0; this.dropped = 0; this.last = 0; this.ended = false; this.fadeIn = 0;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      if (this.playing && this.fill > 0) {
        let s = this.buf[this.r];
        this.r = (this.r + 1) % this.cap; this.fill--; this.played++;
        if (this.fadeIn > 0) { s *= 1 - this.fadeIn / 192; this.fadeIn--; }
        this.last = s; out[i] = s;
      } else {
        if (this.playing && this.fill === 0 && !this.starved) {
          if (this.ended) { this.playing = false; }
          else { this.starved = true; this.underruns++; this.playing = false; }
        }
        this.last *= 0.94; // click-free tail decay
        out[i] = Math.abs(this.last) < 1e-5 ? 0 : this.last;
      }
    }
    if ((this.tick++ & 7) === 0) {
      this.port.postMessage({ t: 'st', epoch: this.epoch, endAck: this.ended, fill: this.fill, played: this.played, underruns: this.underruns,
        playing: this.playing, starved: this.starved, dropped: this.dropped });
    }
    return true;
  }
}
registerProcessor('qtts-ring', QttsRing);
`,
    X = { low_s: 4.5, high_s: 18, start_s: 2, agg_rtf: 1 },
    R = class {
      constructor() {
        this.events = [];
        this.rate = 0;
        this.var = 0;
        this.lastBin = 0;
        this.binSum = 0;
        this.binStart = 0;
        this.haveRate = !1;
      }
      addArrival(e, s) {
        if (
          (this.events.push({ t: s, s: e }),
          this.binStart === 0 && (this.binStart = s),
          (this.binSum += e),
          s - this.binStart >= 250)
        ) {
          let n = this.binSum / ((s - this.binStart) / 1e3),
            d = 0.25;
          if (!this.haveRate) ((this.rate = n), (this.haveRate = !0));
          else {
            let l = n - this.rate;
            ((this.rate += d * l),
              (this.var = (1 - d) * (this.var + d * l * l)));
          }
          ((this.lastBin = n), (this.binStart = s), (this.binSum = 0));
        }
        let i = s - 4e3;
        for (; this.events.length && this.events[0].t < i; )
          this.events.shift();
      }
      windowRate(e) {
        if (!this.events.length) return 0;
        let s = Math.max(e - this.events[0].t, 1e3);
        return this.events.reduce((i, n) => i + n.s, 0) / (s / 1e3);
      }
      stats(e) {
        let s = this.windowRate(e);
        return {
          rate: this.haveRate ? 0.5 * this.rate + 0.5 * s : s,
          sigma: Math.sqrt(this.var),
        };
      }
      deficit(e, s) {
        let { rate: i, sigma: n } = this.stats(e);
        return Math.max(0, s * (1 - i)) + 1.64 * n * Math.sqrt(s);
      }
      reset() {
        ((this.events = []),
          (this.rate = 0),
          (this.var = 0),
          (this.haveRate = !1),
          (this.binSum = 0),
          (this.binStart = 0),
          (this.lastBin = 0));
      }
    },
    P = class {
      constructor() {
        this.ctx = null;
        this.node = null;
        this.gain = null;
        this.pred = new R();
        this.policy = X;
        this.state = "idle";
        this.st = {
          t: "st",
          fill: 0,
          played: 0,
          underruns: 0,
          playing: !1,
          starved: !1,
          dropped: 0,
        };
        this.ctxRate = 24e3;
        this.resPos = 0;
        this.resLast = 0;
        this.resInputCount = 0;
        this.resOutputCount = 0;
        this.queuedSamples = 0;
        this.streamEpoch = 0;
        this.streamActive = false;
        this.ended = !1;
        this.onState = null;
        this.generationDone = !1;
        this.startedAt = 0;
        this.tStart = 0;
        this.firstPlayedMs = 0;
        this.firstPcmMs = 0;
        this.gapsMs = [];
        this.starvedAt = 0;
        this.lastPcmAt = 0;
        this.minBufferS = 1 / 0;
      }
      init(e) {
        this.onState = e;
        if (!this.initPromise) {
          this.initPromise = this.initializeAudio(e).catch((error) => {
            this.ctx?.close?.();
            this.ctx = null;
            this.node = null;
            this.initPromise = null;
            throw error;
          });
        }
        return this.initPromise.then(async () => {
          if (this.ctx.state === "suspended") await this.ctx.resume();
        });
      }
      async initializeAudio(e) {
        if (((this.onState = e), this.ctx)) {
          this.ctx.state === "suspended" && (await this.ctx.resume());
          return;
        }
        let s = window.AudioContext || window.webkitAudioContext;
        try {
          this.ctx = new s({ sampleRate: 24e3, latencyHint: "interactive" });
        } catch {
          this.ctx = new s({ latencyHint: "interactive" });
        }
        this.ctxRate = this.ctx.sampleRate;
        let i = URL.createObjectURL(
          new Blob([V], { type: "application/javascript" }),
        );
        (await this.ctx.audioWorklet.addModule(i),
          URL.revokeObjectURL(i),
          (this.node = new AudioWorkletNode(this.ctx, "qtts-ring", {
            numberOfInputs: 0,
            outputChannelCount: [1],
          })),
          (this.gain = this.ctx.createGain()),
          this.node.connect(this.gain).connect(this.ctx.destination),
          (this.node.port.onmessage = (n) => {
            n.data && n.data.t === "st" && this.onWorklet(n.data);
          }),
          this.ctx.state === "suspended" && (await this.ctx.resume()));
      }
      beginStream(e) {
        this.streamEpoch++;
        this.streamActive = true;
        this.queuedSamples = 0;
        this.resInputCount = this.resOutputCount = 0;
        (this.node?.port.postMessage({ t: "reset", epoch: this.streamEpoch }),
          this.pred.reset(),
          (this.ended = !1),
          (this.generationDone = !1),
          (this.resPos = 0),
          (this.resLast = 0),
          (this.firstPlayedMs = 0),
          (this.firstConsumedMs = 0),
          (this.firstPcmMs = 0),
          (this.gapsMs = []),
          (this.minBufferS = 1 / 0),
          (this.tStart = e),
          (this.startedAt = performance.now()),
          (this.st = {
            t: "st",
            fill: 0,
            played: 0,
            underruns: 0,
            playing: !1,
            starved: !1,
            dropped: 0,
          }),
          this.setState("buffering"));
      }
      setPolicy(e) {
        this.policy = e;
      }
      postPcm(d) {
        if (!d.length) return;
        this.queuedSamples += d.length;
        this.node.port.postMessage({ t: "pcm", epoch: this.streamEpoch, d }, [d.buffer]);
      }
      pushPcm(e) {
        if (!this.streamActive || !this.node) return;
        if (this.generationDone) throw new Error("PCM received after generation end");
        if (e.length % 2) throw new Error("PCM must contain complete int16 samples");
        if (!e.length) return;
        const size = e.length / 2;
        const view = new DataView(e.buffer, e.byteOffset, e.length);
        const input = new Float32Array(size);
        for (let i = 0; i < size; i++) input[i] = view.getInt16(i * 2, true) / 32768;
        const output = this.ctxRate === 24000 ? input : this.resample(input);
        const now = performance.now();
        this.lastPcmAt = now;
        this.firstPcmMs || (this.firstPcmMs = now - this.tStart);
        this.pred.addArrival(size / 24000, now);
        this.postPcm(output);
        this.tick();
      }
      resample(input, final = false) {
        const rate = this.ctxRate;
        if (!Number.isSafeInteger(rate) || rate <= 0) throw new Error("invalid playback sample rate");
        const start = this.resInputCount;
        const end = start + input.length;
        if (!Number.isSafeInteger(end * rate)) throw new Error("resampler sample budget exceeded");
        const last = input.length ? input[input.length - 1] : this.resLast;
        const output = [];
        let count = this.resOutputCount;
        while (count * 24000 < end * rate) {
          const numerator = count * 24000;
          const index = Math.floor(numerator / rate);
          const remainder = numerator % rate;
          if (!final && index + (remainder ? 1 : 0) >= end) break;
          const left = index < start ? this.resLast : input[index - start];
          const right = index + 1 >= end ? last : input[index + 1 - start];
          output.push(remainder ? left + (right - left) * (remainder / rate) : left);
          count++;
        }
        this.resLast = last;
        this.resInputCount = end;
        this.resOutputCount = count;
        this.resPos = count * 24000 / rate - end; // compatibility diagnostic only
        return Float32Array.from(output);
      }
      markGenerationDone() {
        if (!this.streamActive || this.generationDone) return;
        if (this.ctxRate !== 24000) this.postPcm(this.resample(new Float32Array(0), true));
        this.generationDone = true;
        this.node?.port.postMessage({ t: "end", epoch: this.streamEpoch });
        this.tick();
      }
      stop() {
        const oldEpoch = this.streamEpoch;
        this.streamEpoch++;
        this.streamActive = false;
        this.generationDone = false;
        this.queuedSamples = 0;
        this.resInputCount = this.resOutputCount = 0;
        this.resLast = this.resPos = 0;
        this.node?.port.postMessage({ t: "hold", epoch: oldEpoch });
        this.node?.port.postMessage({ t: "reset", epoch: this.streamEpoch });
        this.st = { t: "st", fill: 0, played: 0, underruns: 0, playing: false, starved: false, dropped: 0 };
        this.setState("idle");
      }
      setState(e) {
        this.state !== e && ((this.state = e), this.onState?.(e));
      }
      onWorklet(e) {
        if (!this.streamActive || e.epoch !== this.streamEpoch) return;
        const previousUnderruns = this.st.underruns;
        this.st = e;
        if (e.played>0 && !this.firstConsumedMs) this.firstConsumedMs=performance.now()-this.tStart;
        if (e.underruns > previousUnderruns) {
          this.starvedAt = performance.now();
          this.setState("starved");
        }
        this.tick();
      }
      pendingSamples() {
        return Math.max(0, this.queuedSamples - this.st.played - this.st.dropped);
      }
      bufferedS() {
        return this.pendingSamples() / this.ctxRate;
      }
      needToStart(e, s) {
        let i = this.policy,
          n = s ? 6 : 5,
          { rate: d } = this.pred.stats(e),
          a = this.pred.deficit(e, n) + (s ? 1 : 0.6),
          c = s ? Math.max(i.start_s, i.low_s) : i.start_s,
          u = s ? Math.max(1.5, i.low_s * 0.6) : 0.7;
        return d <= 0 ? c : Math.min(c, Math.max(u, a));
      }
      tick() {
        if (!this.streamActive) return;
        const now = performance.now();
        const buffered = this.bufferedS();
        if (this.state === "playing") this.minBufferS = Math.min(this.minBufferS, buffered);
        if (this.generationDone && this.st.endAck && this.pendingSamples() === 0) {
          this.ended = true;
          this.streamActive = false;
          this.setState("ended");
          return;
        }
        if (this.state === "buffering" || this.state === "starved") {
          const starved = this.state === "starved";
          const liveReady = buffered >= this.needToStart(now, starved) && buffered > .05;
          if ((this.generationDone && this.pendingSamples() > 0) || liveReady) {
            this.node?.port.postMessage({ t: "play", epoch: this.streamEpoch });
            this.firstPlayedMs || (this.firstPlayedMs = now - this.tStart);
            if (starved && this.starvedAt) this.gapsMs.push(now - this.starvedAt);
            this.setState("playing");
          }
        }
      }
      status() {
        let e = performance.now(),
          s = this.bufferedS(),
          { rate: i } = this.pred.stats(e),
          n = 0;
        if (
          !this.generationDone &&
          (this.state === "playing" || this.state === "buffering")
        ) {
          let d = this.pred.deficit(e, 4);
          ((n = Math.min(2, d / Math.max(s, 0.05))),
            s > this.policy.high_s * 0.8 && (n = 0));
        }
        return (
          this.state === "starved" && (n = 1),
          {
            state: this.state,
            bufferedS: s,
            playedS: this.st.played / this.ctxRate,
            queuedSamples: this.queuedSamples,
            pendingSamples: this.pendingSamples(),
            droppedSamples: this.st.dropped,
            streamEpoch: this.streamEpoch,
            endAcknowledged: Boolean(this.st.endAck),
            underruns: this.st.underruns,
            urgency: Math.min(1, n),
            risk: n,
            prodRate: i,
            startNeedS: this.needToStart(e, this.state === "starved"),
            policy: this.policy,
          }
        );
      }
      get elapsedMs() {
        return performance.now() - this.startedAt;
      }
    };
  var r = (t) => {
    let e = document.getElementById(t);
    if (!e) throw new Error("missing #" + t);
    return e;
  };
  function o(t, e = {}, ...s) {
    let i = document.createElement(t);
    for (let [n, d] of Object.entries(e))
      n === "class" ? (i.className = d) : i.setAttribute(n, d);
    for (let n of s) i.append(n);
    return i;
  }
  var k = "",
    C = (path) => path;
  let accessToken = "",
    accessEpoch = 0,
    accessController = new AbortController();
  function lockAccess(message = "已锁定；播放和请求已停止，私密内容已清空") {
    const returnToLogin =
      r("library-dialog").open ||
      r("diagnostics").open ||
      r("protected-controls").contains(document.activeElement) ||
      document.activeElement === r("btn-lock");
    closeDiagnostics();
    closeLibraryDialog();
    libraryRemembered = "";
    document.body.classList.remove("is-unlocked");
    r("locked-note").hidden = false;
    for (const name of ["speak", "lab", "mon"])
      r("nav-" + name).disabled = true;
    accessEpoch++;
    accessToken = "";
    accessController.abort();
    accessController = new AbortController();
    q();
    diagnosticTrace=null;
    r("diagnostic-live").textContent="私有会话已清空；重新进入后开始新诊断。";
    r("diagnostic-action-status").textContent="会话已退出；不会继续旧导出或回填旧短测。";
    r("btn-diagnostic-pair").disabled=false;
    microphone.cancel();
    clearRecordingDownloads();
    r("rec-download-status").textContent = "退出后已清理本地下载链接。";
    _.length = 0;
    renderRecordings();
    $.length = 0;
    r("files").value = "";
    const keyInput = document.getElementById("dskey");
    if (keyInput) keyInput.value = "";
    r("text").value = "";
    if (r("quality-seed")) r("quality-seed").value = "";
    if (r("quality-capture")) r("quality-capture").checked = false;
    r("preftext").value = "";
    r("pcontext").value = "16";
    r("library-context").value = "16";
    r("pname").value = "";
    r("access-token").value = "";
    r("protected-controls").disabled = true;
    r("protected-controls").hidden = true;
    for (const id of [
      "profile",
      "profiles",
      "llmout",
      "segbody",
      "timeline",
      "workers",
      "runs",
      "jobinfo",
      "mon-stage",
      "mon-agg",
      "errbox",
      "preflight-output",
    ])
      r(id).textContent = "";
    r("btn-create").disabled = false;
    r("btn-rec").disabled = false;
    r("btn-rec").textContent = "● 录音";
    r("access-status").textContent = message;
    r("conn").textContent = "已锁定";
    r("conn").className = "pill";
    if (returnToLogin) r("access-token").focus({ preventScroll: true });
  }
  async function apiFetch(path, options = {}) {
    const url = new URL(path, location.href);
    if (url.origin !== location.origin)
      throw new Error("禁止向外部地址发送访问口令，请直接打开目标网关页面");
    if (!accessToken) throw new Error("请从 Notebook 打开新的私有入口");
    const epoch = accessEpoch;
    const headers = new Headers(options.headers || {});
    if (accessToken !== "@private-cookie") headers.set("Authorization", "Bearer " + accessToken);
    const signal = options.signal
      ? AbortSignal.any([options.signal, accessController.signal])
      : accessController.signal;
    const response = await fetch(url.href, {
      ...options,
      headers,
      signal,
      credentials: accessToken === "@private-cookie" ? "same-origin" : "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (epoch !== accessEpoch) {
      await response.body?.cancel();
      throw new DOMException("stale access session", "AbortError");
    }
    if (response.status === 401) lockAccess("会话已结束，请从 Notebook 打开新的私有入口");
    return response;
  }
  async function m(path, options) {
    const epoch = accessEpoch;
    const response = await apiFetch(path, options),
      text = await response.text();
    if (epoch !== accessEpoch)
      throw new DOMException("stale access session", "AbortError");
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text.slice(0, 200) };
    }
    if (!response.ok) throw new Error(body.error || response.statusText);
    return body;
  }
  async function O() {
    const epoch = accessEpoch;
    try {
      const response = await apiFetch("/api/health", { cache: "no-store" });
      if (epoch !== accessEpoch) return false;
      if (
        response.ok &&
        (response.headers.get("content-type") || "").includes("json")
      ) {
        r("conn").textContent = "已连接 " + location.origin;
        r("conn").className = "pill ok";
        return true;
      }
    } catch {}
    if (epoch === accessEpoch) {
      r("conn").textContent = "未连接网关";
      r("conn").className = "pill bad";
    }
    return false;
  }
  async function unlockAccess(event) {
    event.preventDefault();
    const token = r("access-token").value.trim();
    if (!/^[!-~]{32,256}$/.test(token)) {
      r("access-status").textContent = "口令应为32至256位非空格ASCII字符";
      return;
    }
    lockAccess("正在验证访问口令…");
    accessToken = token;
    const epoch = accessEpoch;
    if (!(await O())) {
      if (epoch === accessEpoch) lockAccess("无法解锁：请核对口令和网关连接");
      return;
    }
    if (epoch !== accessEpoch) return;
    document.body.classList.add("is-unlocked");
    r("locked-note").hidden = true;
    for (const name of ["speak", "lab", "mon"])
      r("nav-" + name).disabled = false;
    r("protected-controls").disabled = false;
    r("protected-controls").hidden = false;
    r("access-status").textContent = "已解锁 · 本页内存凭据，刷新需重输";
    await v();
  }

  async function automaticEntry() {
    const epoch = accessEpoch;
    const hash = new URLSearchParams(location.hash.slice(1));
    const grant = hash.get("qtts-entry");
    // Drop the one-use capability before the first fetch or API call.
    if (hash.has("qtts-entry")) history.replaceState(null, "", location.pathname + location.search);
    if (grant && !/^[A-Za-z0-9_-]{43}$/.test(grant)) {
      r("access-status").textContent = "私有入口格式无效，请从 Notebook 获取新入口";
      return;
    }
    r("access-status").textContent = "正在自动连接私有控制台…";
    try {
      if (grant) {
        const response = await fetch("/api/session/exchange", {
          method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({grant}), credentials: "same-origin",
          cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: accessController.signal,
        });
        if (!response.ok) throw new Error("私有入口已失效或已使用，请从 Notebook 获取新入口");
      }
      const response = await fetch("/api/session/status", {
        credentials: "same-origin", redirect: "error", cache: "no-store",
        referrerPolicy: "no-referrer", signal: accessController.signal,
      });
      if (!response.ok) throw new Error("请从 Notebook 打开私有入口，无需输入口令");
      if (epoch !== accessEpoch) return;
      accessToken = "@private-cookie";
      if (!(await O())) throw new Error("网关暂不可用，请稍后从 Notebook 重新打开");
      if (epoch !== accessEpoch) return;
      document.body.classList.add("is-unlocked");
      r("locked-note").hidden = true;
      for (const name of ["speak", "lab", "mon"]) r("nav-" + name).disabled = false;
      r("protected-controls").disabled = false;
      r("protected-controls").hidden = false;
      r("access-status").textContent = "已自动连接 · 私有会话 · 无需手动解锁";
      await v();
    } catch (error) {
      if (epoch === accessEpoch) lockAccess(error.name === "AbortError" ? "连接已停止" : "自动连接未完成；请从 Notebook 获取新入口，不要重启模型");
    }
  }
  function endPrivateSession() {
    // Clear local audio/private state immediately, then revoke the HttpOnly session.
    lockAccess("已停止并退出；重新使用请从 Notebook 打开新入口");
    return fetch("/api/session/logout", {
      method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store",
      referrerPolicy: "no-referrer", keepalive: true,
    }).then(response => {
      if (!response.ok) r("access-status").textContent = "本页已停止；服务端退出未确认，请清除此站点Cookie或稍后重试退出";
    }).catch(() => {
      r("access-status").textContent = "本页已停止；服务端退出未确认，请清除此站点Cookie或稍后重试退出";
    });
  }

  let activeView = "speak",
    diagnosticEpoch = 0,
    diagnosticTimer = 0,
    diagnosticController = null;
  function closeDiagnostics() {
    diagnosticEpoch++;
    clearTimeout(diagnosticTimer);
    diagnosticController?.abort();
    diagnosticController = null;
    if (r("diagnostics").open) r("diagnostics").close();
  }
  function openDiagnostics() {
    if (!accessToken || r("diagnostics").open) return;
    if (microphone.state === "requesting" || microphone.state === "recording")
      microphone.stop("打开诊断，已停止采集");
    r("preflight-output").textContent = "正在读取探针；尚未验证当前环境。";
    r("mon-agg").textContent = "正在刷新；旧指标不代表当前健康状态。";
    r("diagnostics").showModal();
    const generation = ++diagnosticEpoch;
    diagnosticController = new AbortController();
    const signal = diagnosticController.signal;
    async function poll() {
      await W(generation, signal);
      if (r("diagnostics").open && generation === diagnosticEpoch)
        diagnosticTimer = setTimeout(poll, 2000);
    }
    poll();
  }
  function j(t) {
    if (!["speak", "lab"].includes(t)) return;
    if (t !== activeView) {
      if (t === "lab") q();
      else if (
        microphone.state === "requesting" ||
        microphone.state === "recording"
      )
        microphone.stop("切换到语音对话，已停止采集");
    }
    activeView = t;
    for (const name of ["speak", "lab"]) {
      r("tab-" + name).hidden = name !== t;
      r("nav-" + name).classList.toggle("on", name === t);
      r("nav-" + name).setAttribute("aria-pressed", String(name === t));
    }
    if (t === "lab" && accessToken) v();
  }
  var h = new P(),
    J = null,
    x = "",
    H = 0,
    b = { low_s: 4.5, high_s: 18, start_s: 2, agg_rtf: 1 },
    $ = [],
    U = new Map(),
    A = 0,
    I = 0,
    z = "idle",
    w = !1,
    turnSerial = 0;
  function F(t) {
    z = t;
    let e = {
      idle: "\u7A7A\u95F2",
      buffering: "\u7F13\u51B2\u4E2D",
      playing: "\u64AD\u653E\u4E2D",
      starved: "\u8865\u7F13\u51B2",
      ended: "\u64AD\u653E\u5B8C\u6BD5",
    };
    ((r("pstate").textContent = e[t]),
      (r("pstate").className =
        "pill " + (t === "playing" ? "ok" : t === "starved" ? "bad" : "")));
  }
  function Y() {
    let t = h.status(),
      e = Math.max(b.high_s * 1.15, 6),
      s = r("bufbar");
    ((s.style.width = Math.min(100, (t.bufferedS / e) * 100) + "%"),
      (r("wm-low").style.left = (b.low_s / e) * 100 + "%"),
      (r("wm-high").style.left = (b.high_s / e) * 100 + "%"),
      (r("m-buf").textContent = t.bufferedS.toFixed(1) + " s"),
      (r("m-rate").textContent = t.prodRate.toFixed(2) + "\xD7 \u5B9E\u65F6"),
      (r("m-risk").textContent = (t.risk * 100).toFixed(0) + "%"),
      (r("m-under").textContent = String(t.underruns)),
      (r("m-need").textContent = t.startNeedS.toFixed(1) + " s"),
      (r("m-pol").textContent =
        `\u4F4E ${b.low_s.toFixed(1)} / \u9AD8 ${b.high_s.toFixed(0)} / \u542F\u52A8 ${b.start_s.toFixed(1)} s (\u7CFB\u7EDF ${b.agg_rtf.toFixed(2)}\xD7)`));
  }
  function D() {
    (window.clearInterval(H),
      (H = window.setInterval(() => {
        if ((Y(), !x || !w)) return;
        let t = h.status();
        apiFetch("/api/telemetry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          keepalive: !0,
          body: JSON.stringify({
            session: x,
            played_s: t.playedS,
            buffered_s: t.bufferedS,
            state: t.state,
            urgency: t.urgency,
            underruns: t.underruns,
            first_played_ms: h.firstPlayedMs,
          }),
        }).catch(() => {});
      }, 250)));
  }
  function Z(t) {
    let e = o(
      "tr",
      {},
      o("td", {}, String(t.index)),
      o("td", { class: "txt" }, t.text),
      o(
        "td",
        {},
        t.index === 0
          ? "-"
          : `${t.pause_ms} ms${t.breath ? " + 呼吸未实现（仅静音停顿）" : ""}`,
      ),
      o("td", { id: `sg-${t.index}` }, "\u2026"),
      o("td", { id: `sr-${t.index}` }, ""),
      o("td", { id: `sf-${t.index}` }, ""),
    );
    (U.set(t.index, e), r("segbody").append(e));
  }

  let diagnosticTrace = null;
  function diagnosticStatus() {
    return { ...h.status(), firstPcmMs:h.firstPcmMs, firstPlayedMs:h.firstPlayedMs,
      firstConsumedMs:h.firstConsumedMs, gapsMs:h.gapsMs, minBufferS:h.minBufferS,
      audioContextState:h.ctx?.state,baseLatency:h.ctx?.baseLatency,outputLatency:h.ctx?.outputLatency };
  }
  function renderDiagnostic(data) { r("diagnostic-live").textContent=JSON.stringify(data,null,2); }
  async function exportDiagnosticReport() {
    const epoch=accessEpoch;
    if(!accessToken)return;
    const status=r("diagnostic-action-status");
    status.textContent="正在读取脱敏数据…";
    const report={schema:"qtts-diagnostics-v1",quality_verified:false,physical_speaker_output_verified:false,
      generated_at:new Date().toISOString(),missing_sources:[],
      browser_last_trace:diagnosticTrace?{...diagnosticTrace.payload(),report_failures:diagnosticTrace.reportFailures}:null};
    for(const [name,path] of [["gateway","/api/diagnostics"],["local","/api/prep/diagnostics/snapshot"]]) {
      try {report[name]=await m(path);} catch {report.missing_sources.push(name);}
    }
    if(epoch!==accessEpoch || !accessToken)return;
    const link=document.createElement("a");
    const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:"application/json"}));
    link.href=url;link.download="qtts-diagnostics.json";document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    status.textContent=report.missing_sources.length?"已导出不完整报告；缺失来源已明确列出，不代表通过。":"已导出 qtts-diagnostics.json；可回传此 JSON，不要回传私有入口链接或密钥。";
  }
  async function runDiagnosticPair() {
    const epoch=accessEpoch;
    if(!accessToken)return;
    const button=r("btn-diagnostic-pair"),status=r("diagnostic-action-status");
    if(w||["playing","buffering","starved"].includes(h.state)) {
      status.textContent="请先等待正常合成/播放结束，再做双卡对照。";return;
    }
    const text=r("text").value.trim(),profile=r("profile").value;
    if(!text||Array.from(text).length>200||!profile) {
      status.textContent="请使用已有档案，并自行填写1–200字短测文本；不预填、不截断你的文字。";return;
    }
    button.disabled=true;status.textContent="正在显式执行两卡同文、同参考绑定、同参数和同seed短测；不自动播放测试音频…";
    try {
      const result=await m("/api/prep/diagnostics/pair",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({profile,text,language:r("lang").value==="auto"?"Auto":r("lang").value})});
      if(epoch!==accessEpoch || !accessToken)return;
      renderDiagnostic(result);
      status.textContent="短测回执已记录；数值相似不等于音色/真人一致。请下载脱敏JSON回传。";
    } catch {if(epoch!==accessEpoch)return;status.textContent="双卡对照未完成；保留失败回执，不视为质量通过。请下载诊断JSON。";}
    finally {if(epoch===accessEpoch)button.disabled=false;}
  }

  let qualityCapture = null;
  function clearQualityCapture(message = "未保存合成音频；需先主动勾选") {
    if (qualityCapture) qualityCapture.parts.length = 0;
    qualityCapture = null;
    if (r("btn-quality-wav")) r("btn-quality-wav").disabled = true;
    if (r("quality-capture-status")) r("quality-capture-status").textContent = message;
  }
  function beginQualityCapture() {
    clearQualityCapture();
    if (!r("quality-capture")?.checked) return null;
    qualityCapture = {parts: [], bytes: 0, over: false, policy: r("quality-policy")?.value || "legacy-stream"};
    r("quality-capture-status").textContent = "仅在本页内存保存本次合成PCM，最多30秒；不上传、不自动下载。";
    return qualityCapture;
  }
  function captureQualityPcm(owner, payload) {
    if (!owner || owner !== qualityCapture || owner.over) return;
    if (!r("quality-capture")?.checked) { clearQualityCapture("已撤销本页音频捕获"); return; }
    if (payload.byteLength % 2 || owner.bytes + payload.byteLength > 30 * 24000 * 2) {
      owner.parts.length = 0; owner.bytes = 0; owner.over = true;
      r("quality-capture-status").textContent = "音频超过30秒或PCM格式不符；已丢弃全部捕获，不保存截断WAV，正常播放不受影响。";
      return;
    }
    owner.parts.push(payload.slice()); owner.bytes += payload.byteLength;
  }
  function finishQualityCapture(owner, ok) {
    if (!owner || owner !== qualityCapture) return;
    if (!ok) { clearQualityCapture("本次取消、出错或无完整音频，未保留WAV"); return; }
    if (owner.over || !owner.bytes) return;
    r("btn-quality-wav").disabled = false;
    r("quality-capture-status").textContent = "完整合成PCM已接收，可主动下载WAV；不代表物理播放或音质验收。刷新/停止/退出/下次生成会清空。";
  }
  function downloadQualityWav() {
    const owner = qualityCapture;
    if (!accessToken || !owner || owner.over || !owner.bytes || r("btn-quality-wav").disabled) return;
    const header = new ArrayBuffer(44), view = new DataView(header);
    const ascii = (at, text) => { for (let i=0; i<text.length; i++) view.setUint8(at+i,text.charCodeAt(i)); };
    ascii(0,"RIFF"); view.setUint32(4,36+owner.bytes,true); ascii(8,"WAVE"); ascii(12,"fmt ");
    view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
    view.setUint32(24,24000,true); view.setUint32(28,48000,true); view.setUint16(32,2,true); view.setUint16(34,16,true);
    ascii(36,"data"); view.setUint32(40,owner.bytes,true);
    const url=URL.createObjectURL(new Blob([header,...owner.parts],{type:"audio/wav"}));
    const link=document.createElement("a");link.href=url;link.download="qtts-"+owner.policy+".wav";
    document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function B() {
    if (!accessToken) return;
    let t = r("text").value.trim();
    if (!t) return;
    clearQualityCapture("新生成开始，本页旧捕获已清空");
    const clickAt=performance.now();
    diagnosticTrace?.stop("superseded");
    if (w) q();
    const turn = ++turnSerial;
    try {
      await h.init(F);
    } catch (error) {
      if (turn === turnSerial)
        r("errbox").textContent = "无法启动浏览器音频: " + error.message;
      return;
    }
    if (turn !== turnSerial) return;
    ((J = new AbortController()),
      (w = !0),
      (x = ""),
      (U = new Map()),
      (r("segbody").textContent = ""),
      (r("llmout").textContent = ""),
      (r("timeline").textContent = ""),
      (r("errbox").textContent = ""),
      (r("btn-speak").disabled = !0),
      (A = performance.now()),
      h.beginStream(A),
      D());
    const captureOwner = beginQualityCapture();
    const trace=diagnosticTrace=new window.QttsTrace({startedAt:A,clickAt,status:diagnosticStatus,
      render:renderDiagnostic,send:async payload=>{
        const response=await apiFetch("/api/report",{method:"POST",keepalive:true,headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
        if(!response.ok)throw new Error("diagnostic receipt unavailable");
        const receipt=await response.json();if(!receipt.merged)throw new Error("diagnostic receipt not merged");
      }});
    let e = r("mode").value,
      s = (document.getElementById("dskey")?.value || "").trim();
    // API keys stay in memory only; never persist them to browser storage.
    let i = { "Content-Type": "application/json" };
    s && (i["X-DeepSeek-Key"] = s);
    let n = "",
      d = null;
    try {
      const controller = J;
      let l = await apiFetch("/api/speak", {
        method: "POST",
        headers: i,
        signal: controller.signal,
        body: JSON.stringify({
          text: t,
          mode: e,
          profile: r("profile").value,
          language: r("lang").value,
          quality_policy: r("quality-policy")?.value || "legacy-stream",
          test_seed: r("quality-seed")?.value?.trim() ? Number(r("quality-seed").value) : undefined,
          history: e === "chat" ? $.slice(-12) : [],
        }),
      });
      if (turn !== turnSerial) {
        await l.body?.cancel();
        return;
      }
      if (!l.ok || !l.body) {
        let u = await l.json().catch(() => ({ error: l.statusText }));
        throw new Error(String(u.error ?? l.statusText));
      }
      ((x = l.headers.get("X-Session-Id") ?? ""), (I = performance.now() - A));
      trace.headers(x);
      let a = l.body.getReader(),
        c = new M();
      for (;;) {
        let { done: u, value: g } = await a.read();
        if (turn !== turnSerial) {
          await a.cancel();
          return;
        }
        if (u) break;
        for (let f of c.push(g))
          switch (f.type) {
            case 1:
              captureQualityPcm(captureOwner, f.payload);
              trace.frame(1,f.payload.length);
              h.pushPcm(f.payload);
              break;
            case 2:
              trace.frame(2);
              Z(S(f.payload));
              break;
            case 3: {
              let p = S(f.payload).t;
              trace.frame(3,0,p);
              ((n += p), (r("llmout").textContent = n));
              break;
            }
            case 4: {
              trace.frame(4);
              let p = S(f.payload),
                E = f.seg,
                T = (G, K) => {
                  let N = document.getElementById(G);
                  N && (N.textContent = K);
                };
              (T(`sg-${E}`, "GPU" + String(p.gpu)),
                T(`sr-${E}`, p.rtf != null ? Number(p.rtf).toFixed(3) : "未测"),
                T(
                  `sf-${E}`,
                  `${Math.round(Number(p.first_chunk_ms))} ms${p.anomalies?.length ? " \u26A0" : ""}`,
                ));
              break;
            }
            case 7:
              ((b = S(f.payload)), h.setPolicy(b));
              break;
            case 6: {
              trace.frame(6);
              let p = S(f.payload);
              r("errbox").textContent +=
                `[${String(p.stage ?? "")}] ${String(p.error)}
`;
              break;
            }
            case 5:
              trace.frame(5);
              d = S(f.payload);
              break;
            default:
              break;
          }
      }
      if (c.buf.length) throw new Error("音频协议帧被截断");
      if (!d) throw new Error("音频流未返回结束汇总，可能连接中断");
    } catch (l) {
      if(turn===turnSerial)trace.hasError=true;
      turn === turnSerial &&
        l.name !== "AbortError" &&
        (r("errbox").textContent +=
          String(l.message) +
          `
`);
    } finally {
      if (turn === turnSerial) {
        h.markGenerationDone();
        w = false;
        r("btn-speak").disabled = false;
      }
    }
    if (turn !== turnSerial) return;
    if(e==="chat" && n) {
      $.push({role:"user",content:t},{role:"assistant",content:n});$=$.slice(-16);
    }
    if(d)tt(d);
    finishQualityCapture(captureOwner, Boolean(d) && !trace.hasError && !d?.errors?.length);
    trace.networkDone({endReceived:Boolean(d),hasError:trace.hasError || Boolean(d?.errors?.length)});
  }

  function tt(t) {
    let e = t.timeline_ms ?? {},
      s = Object.entries(e).sort((l, a) => l[1] - a[1]),
      i = r("timeline");
    i.textContent = "";
    let n = (l, a) => {
      i.append(o("div", { class: "kv" }, o("span", {}, l), o("b", {}, a)));
    };
    (n(
      "\u9996\u97F3\u9891\u5230\u8FBE\u6D4F\u89C8\u5668 (PCM)",
      `${Math.round(h.firstPcmMs)} ms`,
    ),
      n(
        "播放指令发出（非物理首声）",
        `${Math.round(h.firstPlayedMs)} ms`,
      ),
      n(
        "\u603B\u4F53\u901F\u5EA6 (\u97F3\u9891/\u5899\u949F)",
        `${String(t.overall_rtf_x)}\xD7 \u5B9E\u65F6`,
      ),
      n(
        "\u97F3\u9891\u603B\u957F / \u5899\u949F",
        `${String(t.audio_s)} s / ${String(t.wall_s)} s`,
      ),
      n(
        "\u6B20\u8F7D\u6B21\u6570 (\u6D4F\u89C8\u5668)",
        String(h.status().underruns),
      ));
    for (let [l, a] of s) n("\xB7 " + l, `${a.toFixed(0)} ms`);
    let d = t.per_gpu ?? {};
    for (let [l, a] of Object.entries(d))
      n(
        l,
        `${a.segments} \u6BB5, ${Number(a.audio_s).toFixed(1)} s, RTF ${a.rtf ?? "未测"} (${a.rtf_x}\xD7), \u9996\u5305 ${a.first_chunk_ms_mean} ms, \u589E\u76CA ${a.gain_db_mean} dB`,
      );
  }
  function q() {
    clearQualityCapture("已停止或退出，本页音频捕获已清空");
    diagnosticTrace?.stop("cancelled");
    turnSerial++;
    (J?.abort(), h.stop(), (w = !1), (r("btn-speak").disabled = !1));
  }
  async function v() {
    const epoch = accessEpoch;
    let t;
    try {
      t = await m("/api/profiles");
    } catch {
      return;
    }
    if (epoch !== accessEpoch) return;
    let e = r("profile"),
      s = e.value || t.active;
    e.textContent = "";
    for (let n of t.profiles)
      e.append(o("option", { value: n.id }, `${n.name} (${n.id})${n.trained_adapter ? " · 训练候选/句级缓冲/未验收" : ""}`));
    s && (e.value = s);
    let i = r("profiles");
    ((i.textContent = ""),
      t.profiles.length ||
        i.append(
          o(
            "p",
            { class: "muted" },
            "\u8FD8\u6CA1\u6709\u58F0\u97F3\u6863\u6848\u3002\u4E0A\u4F20\u53C2\u8003\u97F3\u9891\u5F00\u59CB\u521B\u5EFA\u3002",
          ),
        ));
    for (let n of t.profiles) i.append(et(n, n.id === t.active));
  }
  function et(t, e) {
    let s = o("article", {
      class: "card" + (e ? " active" : ""),
      "aria-label": t.name,
    });
    (s.append(
      o(
        "h3",
        {},
        `${t.name} `,
        o("small", {}, t.id + (e ? " \xB7 \u5F53\u524D\u4F7F\u7528" : "")),
      ),
    ),
      s.append(
        o(
          "div",
          { class: "muted" },
          `${t.language ?? "未识别"} \xB7 \u8BED\u901F ${t.units_per_sec ?? "未测"} \u5B57/\u79D2 \xB7 \u505C\u987F \u9017\u53F7${t.pause_clause_ms ?? "未测"}/\u53E5${t.pause_sentence_ms ?? "未测"} ms \xB7 参考语音呼吸分析 ${t.breath_files.length} 段（不注入生成音频） \xB7 F0 ${t.f0 ? Math.round(t.f0.median) : "?"} Hz \xB7 \u8BF4\u8BDD\u4EBA\u6A21\u578B ${t.speaker_model ?? "未测"}`,
        ),
      ));
    if (t.trained_adapter) s.append(o("p",{class:"muted"},"训练候选 · 官方原生后端 · 句级缓冲（非声学流式） · 音质/重载未验收；固定训练参考，节奏参数为默认值。"));
    let i = o("textarea", {
      rows: "3",
      class: "reftext",
      "aria-label": "参考文本 · " + t.name,
    });
    if (t.trained_adapter) i.readOnly=true;
    ((i.value = t.ref_text),
      s.append(
        o(
          "label",
          {},
          "\u53C2\u8003\u6587\u672C(\u5FC5\u987B\u4E0E\u951A\u70B9\u97F3\u9891\u9010\u5B57\u4E00\u81F4,\u8FD9\u662F\u514B\u9686\u8D28\u91CF\u7684\u5173\u952E)",
        ),
        i,
      ));
    let n = o("pre", { class: "out" }),
      d = (c, u) => {
        let g = o("button", { class: "sm" }, c);
        return (
          g.addEventListener("click", () => {
            ((g.disabled = !0),
              (n.textContent = "\u5904\u7406\u4E2D\u2026"),
              u()
                .catch((f) => {
                  n.textContent = "\u9519\u8BEF: " + f.message;
                })
                .finally(() => {
                  g.disabled = !1;
                }));
          }),
          g
        );
      },
      l = o("div", { class: "row" });
    if (
      (l.append(
        d("\u4FDD\u5B58\u6587\u672C\u5E76\u91CD\u8F7D", async () => {
          let c = await m("/api/prep/profiles/" + t.id + "/text", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ref_text: i.value }),
          });
          n.textContent = "\u5DF2\u91CD\u8F7D: " + JSON.stringify(c.workers);
        }),
        d(
          t.trained_adapter ? "选择此训练版本（双GPU加载，句级缓冲）" : "\u542F\u7528\u6B64\u58F0\u97F3(\u4E24\u5757 GPU \u9884\u70ED\u7F13\u5B58)",
          async () => {
            let c = await m("/api/profiles/activate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: t.id }),
            });
            ((n.textContent =
              "\u5DF2\u542F\u7528: " + JSON.stringify(c.workers)),
              v());
          },
        ),
        d(
          "\u53CC\u5361\u4E00\u81F4\u6027 + \u8D28\u91CF\u68C0\u6D4B",
          async () => {
            let c = await m("/api/prep/consistency", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ profile: t.id }),
            });
            n.textContent = st(c);
          },
        ),
        d("\u5019\u9009\u6821\u51C6(GPU \u5B9E\u6D4B)", async () => {
          let c = await m("/api/prep/profiles/" + t.id + "/calibrate", {
            method: "POST",
          });
          ((n.textContent = JSON.stringify(c, null, 1)), v());
        }),
        d("\u5220\u9664", async () => {
          confirm("\u5220\u9664 " + t.name + " ?") &&
            (await m("/api/prep/profiles/" + t.id, { method: "DELETE" }), v());
        }),
      ),
      t.trained_adapter && [...l.querySelectorAll("button")].forEach((button,index)=>{ if(index===0 || index===3) button.disabled=true; }),
      s.append(l),
      t.candidates?.length)
    ) {
      let c = o(
        "div",
        { class: "cands" },
        o(
          "label",
          {},
          "\u5019\u9009\u951A\u70B9(\u6309\u7EFC\u5408\u5206\u6392\u5E8F,\u53EF\u5207\u6362)",
        ),
      );
      t.candidates.forEach((u, g) => {
        let f = o(
          "button",
          { class: "cand" + (g === (t.anchor_candidate ?? 0) ? " on" : "") },
          `#${g} \u5206\u6570 ${u.score} \xB7 能量跨度代理 ${u.level_spread_proxy_db ?? u.snr_db} dB \xB7 ASR\u7F6E\u4FE1 ${u.asr_conf} \xB7 ${u.end - u.start > 0 ? (u.end - u.start).toFixed(1) : "?"}s \xB7 ${u.text.slice(0, 40)}`,
        );
        (f.addEventListener("click", () => {
          ((n.textContent = "\u5207\u6362\u4E2D\u2026"),
            m("/api/prep/profiles/" + t.id + "/candidate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ index: g }),
            })
              .then(() => v())
              .catch((p) => {
                n.textContent = p.message;
              }));
        }),
          c.append(f));
      });
      const candidateDisclosure = o("details", { class: "candidate-details" },
        o("summary", {}, "高级：内部锚点候选（不是完整转写）"), c);
      s.append(candidateDisclosure);
    }
    if (typeof t.full_transcript === "string" && t.full_transcript) {
      const full = o("textarea", { rows: "6", class: "reftext full-transcript", "aria-label": "完整参考语音转写（全文，不分段显示）" });
      full.value = t.full_transcript; full.readOnly = true;
      const copyFull = o("button", { class: "sm", type: "button" }, "复制完整转写");
      copyFull.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(full.value); n.textContent = "完整参考转写已复制；显示为全文，内部时间戳仅用于对齐。"; }
        catch { full.focus(); full.select(); n.textContent = "浏览器阻止自动复制；全文已选中，请按 Ctrl/⌘+C。"; }
      });
      s.append(o("label", {}, "完整参考语音转写（全文显示）"), full, copyFull);
    }
    if (t.quality?.stage_ms) {
      s.append(o("details", {}, o("summary", {}, `创建阶段耗时 · ${t.quality.build_s ?? "?"} s（不是训练）`),
        o("pre", {class: "out"}, Object.entries(t.quality.stage_ms).map(([key, ms]) => `${key}: ${ms} ms`).join("\n"))));
    }
    let a = t.quality?.files ?? [];
    return (
      a.length &&
        s.append(
          o(
            "details",
            {},
            o(
              "summary",
              {},
              "\u53C2\u8003\u97F3\u9891\u5904\u7406\u51B3\u7B56(\u5B9E\u6D4B)",
            ),
            o(
              "pre",
              { class: "out" },
              a.map(
                (c) =>
                  `${String(c.file)}: 能量跨度代理（非真实 SNR） ${String(c.level_spread_proxy_db ?? c.snr_db)} dB, ${String(c.decision ?? c.skipped)}`,
              ).join(`
`),
            ),
          ),
        ),
      s.append(n),
      s
    );
  }
  function st(t) {
    let e = [];
    (e.push(
      `\u8BF4\u8BDD\u4EBA\u6A21\u578B: ${String(t.speaker_model)}   \u4E24\u5361\u8F93\u51FA\u4E92\u76F8\u76F8\u4F3C\u5EA6: ${String(t.cross_gpu_speaker_sim)}   \u4E00\u81F4\u6027: ${String(t.consistent)}`,
    ),
      e.push(`\u5DEE\u5F02: ${JSON.stringify(t.delta)}`));
    for (let s of t.gpus ?? [])
      e.push(`GPU${s.gpu}: ${JSON.stringify(s.mean)}`);
    return (
      e.push(
        "\u6CE8: \u76F8\u4F3C\u5EA6\u4E3A ECAPA \u4F59\u5F26\u76F8\u4F3C\u5EA6(\u540C\u4E00\u771F\u4EBA\u4E0D\u540C\u53E5\u5B50\u901A\u5E38 0.75-0.90),\u4E0D\u662F\u767E\u5206\u6BD4;fidelity_index \u662F\u5185\u90E8\u7EFC\u5408\u6307\u6570\u3002",
      ),
      e.join(`
`)
    );
  }
  var _ = [],
    recordingDurations = new WeakMap();
  // Download the completed browser recording File, never model anchor/generated PCM.
  // Compatible with an in-flight old index.html during a frontend-only update.
  if (!document.getElementById("rec-download-status")) {
    r("rec-clips").before(o("p", {id:"rec-download-status", class:"muted", role:"status"}, "录制完成后可逐段下载参考语音原文件。"));
  }
  r("rec-download-status").style.margin = "0";
  document.documentElement.dataset.recordingDownloadPatch = "v1";
  var recordingDownloadUrls = new Map();
  function releaseRecordingDownload(file, entry) {
    if (recordingDownloadUrls.get(file) !== entry) return;
    clearTimeout(entry.timer);
    URL.revokeObjectURL(entry.url);
    recordingDownloadUrls.delete(file);
  }
  function clearRecordingDownloads() {
    for (const [file, entry] of recordingDownloadUrls) releaseRecordingDownload(file, entry);
  }
  function downloadRecording(file) {
    if (!accessToken || !_.includes(file) || !recordingDurations.has(file)) return;
    let entry = recordingDownloadUrls.get(file);
    let link;
    try {
      if (!entry) {
        const retained = [...recordingDownloadUrls.keys()].reduce((sum, f) => sum + f.size, 0);
        if (recordingDownloadUrls.size >= 16 || retained + file.size > 127 * 1024 * 1024) {
          r("rec-download-status").textContent = "下载临时预算已满，请稍后重试；原录音仍在列表，没有丢弃。";
          return;
        }
        entry = {url: URL.createObjectURL(file), timer: 0};
        recordingDownloadUrls.set(file, entry);
      }
      clearTimeout(entry.timer);
      link = document.createElement("a");
      link.href = entry.url;
      link.download = file.name;
      link.hidden = true;
      document.body.append(link);
      link.click();
      // Keep the URL alive for browsers that start reading after the click task.
      entry.timer = setTimeout(() => releaseRecordingDownload(file, entry), 60000);
      r("rec-download-status").textContent = "已发起下载：" + file.name + "（录制封装原文件，不转码）；是否保存成功请查看浏览器下载列表。";
    } catch {
      if (entry) releaseRecordingDownload(file, entry);
      r("rec-download-status").textContent = "下载未能发起，原录音仍在列表；请允许浏览器下载后重试。";
    } finally {
      link?.remove();
    }
  }
  function renderRecordings() {
    if (r("library-dialog").open) syncLibraryControls();
    const list = r("rec-clips");
    list.textContent = "";
    for (const file of _) {
      const download = o("button", { type: "button", class: "sm" }, "下载参考语音");
      download.setAttribute("aria-label", "下载参考语音 " + file.name);
      download.addEventListener("click", () => downloadRecording(file));
      const remove = o("button", { type: "button", class: "sm" }, "移除");
      remove.setAttribute("aria-label", "移除录音 " + file.name);
      remove.disabled = r("btn-create").disabled;
      remove.addEventListener("click", () => {
        const index = _.indexOf(file);
        if (index >= 0) _.splice(index, 1);
        renderRecordings();
      });
      list.append(
        o(
          "div",
          { class: "row" },
          o(
            "span",
            {},
            file.name +
              " · 约" +
              (recordingDurations.get(file) / 1000).toFixed(1) +
              "秒 · " +
              (file.size / 1024).toFixed(1) +
              "KiB",
          ),
          download,
          remove,
        ),
      );
    }
  }
  const microphone = new window.QttsMicrophoneRecorder({
    canvas: r("rec-wave"),
    getFiles: () => [..._, ...(r("files").files || [])],
    onStatus: (state, message) => {
      r("rec-status").textContent = message;
      r("btn-rec").textContent =
        state === "requesting"
          ? "取消权限等待"
          : state === "recording"
            ? "■ 停止录音"
            : state === "stopping"
              ? "正在封装…"
              : "● 录音";
    },
    onMeter: ({ rmsDb, peak, elapsedMs }) => {
      r("rec-meter").textContent =
        rmsDb == null
          ? "未采集"
          : `${(elapsedMs / 1000).toFixed(1)}秒 · RMS ${rmsDb.toFixed(1)} dBFS · 峰值 ${peak.toFixed(3)}${peak >= 0.98 ? " · 接近削波，请降低输入增益" : ""}`;
    },
    onClip: (file, duration) => {
      if (!accessToken) return;
      _.push(file);
      recordingDurations.set(file, duration);
      renderRecordings();
      r("rec-clips").scrollTop = r("rec-clips").scrollHeight;
      r("rec-download-status").textContent = "录制完成：" + file.name + "；可点击该段旁的下载参考语音，建议提交前先备份。";
    },
  });
  async function nt() {
    if (accessToken) await microphone.toggle();
  }
  async function it() {
    if (!accessToken) return;
    const epoch = accessEpoch;
    if (microphone.state !== "idle") {
      r("jobinfo").textContent = "请先停止录音，再提交声音档案";
      return;
    }
    let completed = false;
    let t = [...(r("files").files ?? []), ..._];
    if (!t.length) {
      r("jobinfo").textContent =
        "\u8BF7\u5148\u9009\u62E9\u6216\u5F55\u5236\u53C2\u8003\u97F3\u9891";
      return;
    }
    const name = r("pname").value.trim();
    if (!name || Array.from(name).length > 64) {
      r("jobinfo").textContent =
        "请自行填写1至64字符的声音库名称；未上传任何音频";
      r("pname").focus();
      return;
    }
    let e = new FormData();
    (e.append("name", name),
      e.append("language", r("plang").value),
      e.append("ref_text", r("preftext").value),
      e.append("anchor_seconds", r("pcontext").value),
      e.append("calibrate", r("pcal").checked ? "1" : "0"));
    for (let s of t) e.append("files", s, s.name);
    r("btn-rec").disabled = true;
    ((r("btn-create").disabled = !0),
      (r("jobinfo").textContent = "\u4E0A\u4F20\u4E2D\u2026"));
    renderRecordings();
    try {
      let { job: s } = await m("/api/prep/profiles", {
        method: "POST",
        body: e,
      });
      if (epoch !== accessEpoch) return;
      for (;;) {
        await new Promise((n) => setTimeout(n, 1e3));
        if (epoch !== accessEpoch) return;
        let i = await m("/api/prep/jobs/" + s);
        if (epoch !== accessEpoch) return;
        if (
          ((r("jobbar").style.width = i.pct + "%"),
          (r("jobinfo").textContent =
            `${i.pct}% ${i.stage}
` +
            i.log.slice(-6).join(`
`)),
          i.state !== "running")
        ) {
          if (i.state === "error")
            throw new Error(String(i.error || "声音档案创建失败"));
          completed = i.state === "done";
          break;
        }
      }
    } catch (s) {
      if (epoch !== accessEpoch) return;
      r("jobinfo").textContent = "\u9519\u8BEF: " + s.message;
    } finally {
      if (epoch !== accessEpoch) return;
      r("btn-create").disabled = false;
      r("btn-rec").disabled = false;
      if (completed) {
        const submitted = new Set(t);
        _ = _.filter((file) => !submitted.has(file));
        if ([...r("files").files].every((file) => submitted.has(file)))
          r("files").value = "";
      }
      renderRecordings();
      v();
    }
  }
  async function W(generation, signal) {
    if (!accessToken) return;
    const epoch = accessEpoch;
    const current = () =>
      epoch === accessEpoch &&
      generation === diagnosticEpoch &&
      r("diagnostics").open;
    if (!current()) return;
    try {
      try {
        const probe = await m("/api/preflight", { signal });
        if (!current()) return;
        r("preflight-output").textContent =
          JSON.stringify(probe, null, 2) +
          "\n仅为设备/接口探针；不代表模型、训练或性能通过。";
      } catch (error) {
        if (!current()) return;
        r("preflight-output").textContent =
          "探针报告读取失败：" + error.message + "；不能据此判断模型可用。";
      }
      const t = await m("/api/health", { signal });
      if (!current()) return;
      let e = t.workers ?? [],
        s = r("workers");
      s.textContent = "";
      for (let a of e) {
        let c = a.worker ?? {},
          u = c.vram ?? {};
        s.append(
          o(
            "div",
            { class: "card" },
            o(
              "h3",
              {},
              `GPU ${String(a.id)} `,
              o("small", {}, a.healthy ? "\u5065\u5EB7" : "\u4E0D\u53EF\u7528"),
            ),
            o(
              "div",
              { class: "muted" },
              `\u5F15\u64CE ${String(c.engine)} \xB7 dtype ${String(c.dtype)} \xB7 Rust\u8FD0\u884C\u65F6 ${String(c.rt)}${c.model_output_mode === "sentence-buffered" ? " · 句级缓冲，非声学流式" : ""}`,
            ),
            o(
              "div",
              {},
              `速度倍率 ${Number(a.rtf_x ?? 0).toFixed(2)}\xD7 \xB7 \u9996\u5305 ${Math.round(Number(a.first_chunk_ms ?? 0))} ms \xB7 \u5DF2\u5904\u7406 ${String(a.served)} \xB7 \u5931\u8D25 ${String(a.failed)} \xB7 ${a.busy ? "\u5FD9" : "\u95F2"}`,
            ),
            o(
              "div",
              { class: "muted" },
              u.used_mb
                ? `\u663E\u5B58 ${String(u.used_mb)}/${String(u.total_mb)} MB`
                : "",
            ),
            o("div", { class: "muted" }, String(a.last_error ?? "")),
          ),
        );
      }
      r("mon-agg").textContent =
        `\u7CFB\u7EDF\u805A\u5408\u901F\u5EA6 ${Number.isFinite(t.agg_rtf) ? Number(t.agg_rtf).toFixed(2) : "未测"}\xD7 \u5B9E\u65F6 \xB7 LLM\u5BC6\u94A5 ${t.llm_key_set ? "\u5DF2\u8BBE\u7F6E" : "\u672A\u8BBE\u7F6E(\u53EF\u5728\u9875\u9762\u8F93\u5165)"} \xB7 \u6A21\u578B ${String(t.llm_model ?? "未设置")}`;
      const i = await m("/api/metrics", { signal });
      if (!current()) return;
      let n = i.stage_median_ms ?? {};
      r("mon-stage").textContent =
        Object.entries(n)
          .sort((a, c) => a[1] - c[1])
          .map(([a, c]) => `${a.padEnd(24)} ${c.toFixed(0)} ms`).join(`
`) || "\u6682\u65E0\u6570\u636E";
      let d = (i.runs ?? []).slice(-12).reverse(),
        l = r("runs");
      l.textContent = "";
      for (let a of d) {
        let c = a.timeline_ms ?? {},
          u = a.client ?? {};
        l.append(
          o(
            "tr",
            {},
            o("td", {}, String(a.at).slice(11, 19)),
            o("td", {}, String(a.chars)),
            o("td", {}, String(a.segments)),
            o("td", {}, String(a.audio_s)),
            o("td", {}, String(a.overall_rtf_x) + "\xD7"),
            o(
              "td",
              {},
              c.first_seg_worker_audio
                ? c.first_seg_worker_audio.toFixed(0)
                : "-",
            ),
            o("td", {}, String(u.first_played_ms ?? "-")),
            o("td", {}, String(u.underruns ?? a.underruns)),
            o(
              "td",
              {},
              (a.anomalies ?? []).length
                ? "\u26A0 " + String(a.anomalies.length)
                : "ok",
            ),
          ),
        );
      }
    } catch (t) {
      if (!current()) return;
      r("mon-agg").textContent = "\u76D1\u6D4B\u5931\u8D25: " + t.message;
    }
  }
  // Raw-library dialog: never turns an empty library into an inference profile.
  let libraryEpoch = 0, libraryController = null, libraryTimer = 0,
    libraryRows = [], librarySelected = new Set(), libraryPending = false,
    libraryRemembered = "";
  function currentLibrary() {
    return libraryRows.find(row => row.id === r("library-select").value);
  }
  function stopLibraryRequests() {
    libraryEpoch++;
    clearTimeout(libraryTimer);
    libraryController?.abort();
    libraryController = new AbortController();
  }
  function closeLibraryDialog() {
    libraryRemembered = r("library-select").value || libraryRemembered;
    stopLibraryRequests();
    libraryRows = []; librarySelected.clear(); libraryPending = false;
    clearTrainingData();
    for (const id of ["library-select", "library-samples", "library-state", "library-message"])
      r(id).textContent = "";
    for (const id of ["library-name", "library-reftext", "library-files"]) r(id).value = "";
    r("library-language").value = "auto";
    r("library-calibrate").checked = false;
    r("library-delete-options").open = false;
    syncLibraryControls();
    if (r("library-dialog").open) r("library-dialog").close();
  }
  function syncLibraryControls() {
    const row = currentLibrary(), blocked = libraryPending || !row || row.busy;
    for (const id of ["library-name", "library-language", "btn-library-create", "library-select", "btn-library-refresh"])
      r(id).disabled = libraryPending;
    r("library-select").disabled ||= !libraryRows.length;
    for (const id of ["library-files", "btn-library-upload", "btn-library-delete", "library-reftext", "library-calibrate"])
      r(id).disabled = blocked;
    r("btn-library-clips").disabled = blocked || !_.length;
    r("btn-library-clips").textContent = `添加本地录音（${_.length}）`;
    r("btn-library-process").disabled = blocked || !librarySelected.size || r("btn-create").disabled;
    for (const control of r("library-samples").querySelectorAll("input,button")) control.disabled = blocked;
    syncTrainingControls();
  }
  function renderLibrary() {
    const row = currentLibrary();
    const states = {empty:"命名空库，尚无样本", samples_unverified:"原始样本未解码", processing:"正在处理参考，不是训练", interrupted:"上次处理已中断，请核对档案后重试", reference_prepared:"参考已处理；推理未验收、未训练", processing_failed:"参考处理失败，原始样本保留"};
    r("library-state").textContent = row
      ? `${states[row.state] || "状态未确认"} · ${row.samples.length}段 · ${(row.bytes/1048576).toFixed(2)}MiB · 修订${row.revision}${row.prepared_profile ? " · 最近已生成档案："+row.prepared_profile : ""}`
      : "请先命名建空库，或选择已有库。";
    const list = r("library-samples"); list.textContent = "";
    if (row) {
      const present = new Set(row.samples.map(sample => sample.id));
      const retained = new Set([...librarySelected].filter(id => present.has(id)));
      if (retained.size !== librarySelected.size) invalidateTrainingDeclarations();
      librarySelected = retained;
      for (const sample of row.samples) {
        const checkbox = o("input", {type:"checkbox", "aria-label":"选择样本 "+sample.name});
        checkbox.checked = librarySelected.has(sample.id);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) librarySelected.add(sample.id); else librarySelected.delete(sample.id);
          invalidateTrainingDeclarations();renderTrainingInputs();syncLibraryControls();
        });
        const remove = o("button", {type:"button",class:"sm","aria-label":"移除样本 "+sample.name}, "移除");
        remove.addEventListener("click", () => runLibrary(async (signal, request) => {
          const result = await request(`/api/prep/libraries/${row.id}/samples/${sample.id}`, {method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({revision:row.revision})});
          request.assertCurrent();
          adoptLibrary(result.library);
          r("library-message").textContent = "样本已从库中移除；独立声音档案未删除。";
          r("library-select").focus();
        }));
        list.append(o("div", {class:"library-sample-row"}, o("label", {}, checkbox,
          o("span", {}, `${sample.name} · ${(sample.bytes/1024).toFixed(1)}KiB · 原始参考`)), remove));
      }
    } else librarySelected.clear();
    renderTrainingInputs();syncLibraryControls();
  }
  function renderLibraryOptions(id = libraryRemembered) {
    const select = r("library-select"); select.textContent = "";
    for (const row of libraryRows) select.append(o("option", {value:row.id}, row.name+`（${row.samples.length}段）`));
    if (libraryRows.some(row => row.id === id)) select.value = id;
    libraryRemembered = select.value;
    renderLibrary();
  }
  function adoptLibrary(row) {
    const index = libraryRows.findIndex(item => item.id === row.id);
    if (index < 0) libraryRows.unshift(row); else libraryRows[index] = row;
    renderLibraryOptions(row.id);
  }
  function libraryAlive(generation) {
    return !!accessToken && generation === libraryEpoch && r("library-dialog").open;
  }
  async function runLibrary(task) {
    if (!accessToken || !r("library-dialog").open || libraryPending) return;
    stopLibraryRequests();
    const generation = libraryEpoch, signal = libraryController.signal;
    libraryPending = true; syncLibraryControls();
    r("library-message").textContent = "正在请求；尚未确认写入结果…";
    // A task must check its generation after every await, before changing UI.
    const guarded = async (path, options) => {
      const value = await m(path, {...options,signal});
      if (!libraryAlive(generation)) throw new DOMException("stale library dialog", "AbortError");
      return value;
    };
    guarded.assertCurrent = () => {
      if (!libraryAlive(generation)) throw new DOMException("stale library dialog", "AbortError");
    };
    try { await task(signal, guarded); }
    catch (error) {
      if (!libraryAlive(generation)) return;
      r("library-message").textContent = "操作未确认："+error.message+"。参考原件不会因处理失败而删除；请刷新核对已提交结果后重试。";
    } finally {
      if (!libraryAlive(generation)) return;
      libraryPending = false; syncLibraryControls(); scheduleLibraryPoll();
    }
  }
  async function refreshLibraries(signal, request) {
    const result = await request("/api/prep/libraries", {cache:"no-store"});
    request.assertCurrent();
    libraryRows = result.libraries || [];
    renderLibraryOptions();
    await refreshTrainingData(request);request.assertCurrent();
    r("library-message").textContent = "已读取本地库。原始样本不自动进入Dataset备份。";
  }
  function openLibraryDialog() {
    if (!accessToken || r("library-dialog").open) return;
    q(); closeDiagnostics();
    if (["requesting", "recording"].includes(microphone.state)) microphone.stop("打开声音库，已停止采集");
    r("library-dialog").showModal();
    runLibrary(refreshLibraries);
  }
  function scheduleLibraryPoll() {
    clearTimeout(libraryTimer);
    const row = currentLibrary();
    if (!row?.busy || libraryPending) return;
    const generation = libraryEpoch, id = row.id, signal = libraryController.signal;
    libraryTimer = setTimeout(async () => {
      if (!libraryAlive(generation) || currentLibrary()?.id !== id) return;
      try {
        const result = await m(`/api/prep/libraries/${id}`, {cache:"no-store",signal});
        if (!libraryAlive(generation) || currentLibrary()?.id !== id) return;
        const index = libraryRows.findIndex(item => item.id === id);
        if (index >= 0) libraryRows[index] = result.library;
        renderLibrary();
        if (result.library.busy && result.library.last_build?.job) {
          const job = await m("/api/prep/jobs/"+result.library.last_build.job, {cache:"no-store",signal});
          if (!libraryAlive(generation) || currentLibrary()?.id !== id) return;
          r("library-message").textContent = `${job.pct || 0}% ${job.stage || "处理中"}\n${(job.log || []).slice(-4).join("\n")}`;
        } else {
          r("library-message").textContent = "本次处理已结束，请核对库状态；这不是模型训练验收。";
          if (result.library.state === "reference_prepared") v();
        }
      } catch (error) {
        if (!libraryAlive(generation)) return;
        r("library-message").textContent = "读取处理进度失败："+error.message+"；不能据此认定完成，请刷新核对。";
      }
      if (libraryAlive(generation)) scheduleLibraryPoll();
    }, 2000);
  }
  async function addLibraryFiles(files, signal, request) {
    const row = currentLibrary();
    if (!row || !files.length) throw new Error("请先选库并选择文件或录音");
    if (files.length > 16 || files.some(file => !file.size || file.size > 64*1048576) || files.reduce((n,file)=>n+file.size,0) > 127*1048576)
      throw new Error("本地文件超出16段、64MiB/段或127MiB整批限额，或含空文件");
    const form = new FormData(); form.set("revision", String(row.revision));
    for (const file of files) form.append("files",file);
    const result = await request(`/api/prep/libraries/${row.id}/samples`, {method:"POST",body:form});
    request.assertCurrent();
    adoptLibrary(result.library);
    r("library-message").textContent = "原始样本已保存（同内容去重）；请勾选所需参考后再处理。尚未解码或训练。";
  }
  function initializeLibraries() {
    r("btn-libraries").addEventListener("click", openLibraryDialog);
    r("btn-library-close").addEventListener("click", closeLibraryDialog);
    r("btn-library-lock").addEventListener("click", () => endPrivateSession());
    r("library-dialog").addEventListener("cancel", event => {event.preventDefault();closeLibraryDialog();});
    r("library-dialog").addEventListener("close", () => {if (!r("library-dialog").open) closeLibraryDialog();});
    r("btn-library-refresh").addEventListener("click", () => runLibrary(refreshLibraries));
    r("library-select").addEventListener("change", () => {
      libraryRemembered = r("library-select").value; librarySelected.clear();resetTrainingInputs();
      r("library-delete-options").open = false; renderLibrary();
      runLibrary(async (signal, request) => {
        const result = await request("/api/prep/libraries/"+libraryRemembered, {cache:"no-store"});
        request.assertCurrent();
        adoptLibrary(result.library); r("library-message").textContent = "已读取所选库。";
      });
    });
    r("btn-library-create").addEventListener("click", () => runLibrary(async (signal, request) => {
      const name = r("library-name").value.trim();
      if (!name || Array.from(name).length > 64) throw new Error("请自行填写1–64字符库名");
      const result = await request("/api/prep/libraries", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,language:r("library-language").value})});
      request.assertCurrent();
      librarySelected.clear(); resetTrainingInputs();adoptLibrary(result.library); r("library-name").value = "";
      r("library-message").textContent = "命名空库已保存，现在可以添加参考样本。没有加载模型或开始训练。";
    }));
    r("btn-library-upload").addEventListener("click", () => runLibrary(async (signal, request) => {
      await addLibraryFiles([...r("library-files").files],signal,request);
      request.assertCurrent();
      r("library-files").value = "";
    }));
    r("btn-library-clips").addEventListener("click", () => runLibrary(async (signal, request) => {
      const files = [..._];
      await addLibraryFiles(files,signal,request);
      request.assertCurrent();
      const submitted = new Set(files); _ = _.filter(file => !submitted.has(file)); renderRecordings();
    }));
    r("btn-library-process").addEventListener("click", () => runLibrary(async (signal, request) => {
      const row = currentLibrary();
      const result = await request(`/api/prep/libraries/${row.id}/process`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({revision:row.revision,sample_ids:[...librarySelected],ref_text:r("library-reftext").value,anchor_seconds:Number(r("library-context").value),calibrate:r("library-calibrate").checked})});
      request.assertCurrent();
      row.busy = true; row.state = "processing"; row.last_build = {job:result.job,state:"running"}; adoptLibrary(row);
      r("library-message").textContent = "参考处理任务已受理；不是训练，请等待并核对最终结果。";
    }));
    r("btn-library-delete").addEventListener("click", () => runLibrary(async (signal, request) => {
      const row = currentLibrary();
      await request(`/api/prep/libraries/${row.id}`, {method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({revision:row.revision})});
      request.assertCurrent();
      libraryRows = libraryRows.filter(item => item.id !== row.id); librarySelected.clear(); libraryRemembered = "";resetTrainingInputs();
      r("library-delete-options").open = false; renderLibraryOptions();
      r("library-message").textContent = "当前库原始数据已删除；独立声音档案未删除。";
      r("library-select").focus();
    }));
  }

  let trainingTexts = new Map(), trainingReference = "", trainingRows = [], trainingSource = "";
  function invalidateTrainingDeclarations() {
    r("training-rights").checked = false; r("training-single-speaker").checked = false;
  }
  function resetTrainingInputs() {
    trainingTexts.clear(); trainingReference = "";invalidateTrainingDeclarations();
    r("training-transcripts").textContent = ""; r("training-result").textContent = "";
    r("training-options").open = false; r("training-delete-options").open = false;
  }
  function clearTrainingData() {
    resetTrainingInputs(); trainingRows = [];trainingSource = "";r("training-datasets").textContent = "";
  }
  function selectedTrainingDataset() {
    return trainingRows.find(row => row.id === r("training-datasets").value);
  }
  function syncTrainingControls() {
    const row = currentLibrary(), blocked = libraryPending || !row || row.busy;
    for (const control of r("training-transcripts").querySelectorAll("input,textarea")) control.disabled = blocked;
    for (const id of ["training-rights", "training-single-speaker"]) r(id).disabled = blocked;
    r("btn-training-prepare").disabled = blocked || !librarySelected.size || !librarySelected.has(trainingReference) ||
      [...librarySelected].some(id => !trainingTexts.get(id)?.trim()) || !r("training-rights").checked || !r("training-single-speaker").checked;
    r("btn-training-refresh").disabled = libraryPending;
    r("training-datasets").disabled = libraryPending || !trainingRows.length;
    for (const id of ["btn-training-verify", "btn-training-delete"]) r(id).disabled = libraryPending || !selectedTrainingDataset();
  }
  function renderTrainingInputs() {
    const source = currentLibrary()?.id || "";
    if (source !== trainingSource) {
      trainingTexts.clear();trainingReference = "";invalidateTrainingDeclarations();trainingSource = source;
    }
    const list = r("training-transcripts"); list.textContent = "";
    if (!librarySelected.has(trainingReference)) trainingReference = "";
    for (const sample of currentLibrary()?.samples || []) {
      if (!librarySelected.has(sample.id)) continue;
      const input = o("textarea", {rows:"2",maxlength:"4000","aria-label":"训练转写 "+sample.name});
      input.value = trainingTexts.get(sample.id) || "";
      input.addEventListener("input", () => {trainingTexts.set(sample.id,input.value);syncTrainingControls();});
      const reference = o("input", {type:"radio",name:"training-reference","aria-label":"统一参考 "+sample.name});
      reference.checked = trainingReference === sample.id;
      reference.addEventListener("change", () => {trainingReference = sample.id;syncTrainingControls();});
      list.append(o("div", {class:"card"}, o("p", {class:"hint"}, sample.name+" · 对应转写（最多2000字符）"), input,
        o("label", {}, reference, " 设为所有样本统一参考（≤16秒）")));
    }
    syncTrainingControls();
  }
  function renderTrainingDatasets(id = r("training-datasets").value) {
    const select = r("training-datasets"); select.textContent = "";
    for (const row of trainingRows) select.append(o("option", {value:row.id}, `${row.library_name} · ${row.sample_count}段 · ${row.id.slice(0,8)}`));
    if (trainingRows.some(row => row.id === id)) select.value = id;
    syncTrainingControls();
  }
  async function refreshTrainingData(request) {
    const result = await request("/api/prep/training-data", {cache:"no-store"});request.assertCurrent();
    trainingRows = result.datasets || [];renderTrainingDatasets();
    r("training-result").textContent = trainingRows.length ? "已刷新索引，当前文件未重新校验；请按固定哈希校验。" : "";
  }
  function showTrainingResult(row, message) {
    r("training-result").textContent = message+"\n"+JSON.stringify(row,null,2)+"\n这里只准备输入；模型训练和双rank执行均未验收。";
  }
  function initializeTrainingData() {
    for (const id of ["training-rights", "training-single-speaker"]) r(id).addEventListener("change",syncTrainingControls);
    r("training-datasets").addEventListener("change", () => {
      r("training-delete-options").open = false;
      const row = selectedTrainingDataset();if (row) showTrainingResult(row,"快照索引；请重新校验实际文件内容。");
      syncTrainingControls();
    });
    r("btn-training-refresh").addEventListener("click", () => runLibrary(async (signal,request) => {
      await refreshTrainingData(request);request.assertCurrent();r("library-message").textContent = "已读取训练输入列表；尚未启动训练。";
    }));
    r("btn-training-prepare").addEventListener("click", () => runLibrary(async (signal,request) => {
      const row = currentLibrary();
      r("training-result").textContent = "新快照结果尚未确认；这里只准备输入，不执行训练。";
      const result = await request("/api/prep/training-data", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({library_id:row.id,revision:row.revision,
        samples:[...librarySelected].map(id => ({id,text:trainingTexts.get(id) || ""})),reference_sample_id:trainingReference,
        voice_rights_confirmed:r("training-rights").checked,single_speaker_confirmed:r("training-single-speaker").checked})});
      request.assertCurrent();trainingRows.unshift(result.dataset);renderTrainingDatasets(result.dataset.id);
      showTrainingResult(result.dataset,"训练输入快照已生成并校验（不是训练成功）。");
      r("library-message").textContent = "只完成输入准备；未生成声学码或训练模型。";
    }));
    r("btn-training-verify").addEventListener("click", () => runLibrary(async (signal,request) => {
      const row = selectedTrainingDataset();
      r("training-result").textContent = "本次内容尚未校验通过；请等待响应或核对错误信息。";
      const result = await request(`/api/prep/training-data/${row.id}/verify`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({manifest_sha256:row.manifest_sha256})});
      request.assertCurrent();showTrainingResult(result.dataset,"本次内容哈希/逐条索引/分配计划校验通过（不是训练验收）。");
      r("library-message").textContent = "输入校验通过；没有启动训练。";
    }));
    r("btn-training-delete").addEventListener("click", () => runLibrary(async (signal,request) => {
      const row = selectedTrainingDataset();
      await request(`/api/prep/training-data/${row.id}`, {method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({manifest_sha256:row.manifest_sha256})});
      request.assertCurrent();trainingRows = trainingRows.filter(item => item.id !== row.id);renderTrainingDatasets();
      r("training-result").textContent = "输入副本已删除；原始库和声音档案未删除。";
      r("training-delete-options").open = false;r("library-message").textContent = "训练输入副本已删除。";
    }));
  }

  async function rt() {
    initializeLibraries();initializeTrainingData();
    try {
      for (const key of ["qtts_dskey", "qtts_base", "qtts_access_token"])
        localStorage.removeItem(key);
    } catch {}
    ((document.getElementById("dskey") && (document.getElementById("dskey").value = "")), (r("baseurl").value = location.origin));
    r("access-form").addEventListener("submit", unlockAccess);
    r("btn-lock").addEventListener("click", () => endPrivateSession());
    r("btn-reference-options").addEventListener("click", () => {
      const options = r("reference-options");
      options.open = !options.open;
      r("btn-reference-options").setAttribute(
        "aria-expanded",
        String(options.open),
      );
      if (options.open) options.querySelector("summary").focus();
      else options.closest(".scroll").scrollTop = 0;
    });
    r("reference-options").addEventListener("toggle", () =>
      r("btn-reference-options").setAttribute(
        "aria-expanded",
        String(r("reference-options").open),
      ),
    );
    for (let t of ["speak", "lab"]) {
      r("nav-" + t).addEventListener("click", () => j(t));
      r("nav-" + t).addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const target =
          event.key === "Home"
            ? "lab"
            : event.key === "End"
              ? "speak"
              : t === "lab"
                ? "speak"
                : "lab";
        j(target);
        r("nav-" + target).focus();
      });
    }
    r("nav-mon").addEventListener("click", openDiagnostics);
    r("btn-close-diagnostics").addEventListener("click", closeDiagnostics);
    r("btn-lock-dialog").addEventListener("click", () => endPrivateSession());
    r("diagnostics").addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDiagnostics();
    });
    r("diagnostics").addEventListener("close", () => {
      if (!r("diagnostics").open) closeDiagnostics();
    });
    window.addEventListener("pagehide",()=>diagnosticTrace?.stop("interrupted"));
    r("btn-diagnostic-export").addEventListener("click",()=>{exportDiagnosticReport().catch(()=>{r("diagnostic-action-status").textContent="诊断导出失败，未报告通过。";});});
    r("btn-diagnostic-pair").addEventListener("click",()=>{runDiagnosticPair().catch(()=>{r("diagnostic-action-status").textContent="双卡对照未启动。";});});
    r("quality-capture")?.addEventListener("change", () => { if (!r("quality-capture").checked) clearQualityCapture("已撤销本页音频捕获并清空"); });
    r("btn-quality-wav")?.addEventListener("click", downloadQualityWav);
    (r("btn-speak").addEventListener("click", () => {
      B();
    }),
      r("btn-stop").addEventListener("click", q),
      r("btn-create").addEventListener("click", () => {
        it();
      }),
      r("btn-rec").addEventListener("click", () => {
        nt().catch((t) => {
          r("jobinfo").textContent = "\u65E0\u6CD5\u5F55\u97F3: " + t.message;
        });
      }),
      r("btn-connect").addEventListener("click", () => {
        O().then((connected) => {
          if (connected) v();
        });
      }),
      r("text").addEventListener("keydown", (t) => {
        let e = t;
        e.key === "Enter" && (e.ctrlKey || e.metaKey) && B();
      }),
      F("idle"),
      j("speak"),
      lockAccess("正在准备自动连接…"),
      D());
  }
  window.addEventListener("pagehide", () =>
    lockAccess("页面已离开，访问已锁定"),
  );
  rt();
  void automaticEntry();
  // BFCache restores memory after pagehide; reconnect without retaining a credential in JS storage.
  window.addEventListener("pageshow", event => {if (event.persisted) void automaticEntry();});
})();
