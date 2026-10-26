"use strict";
// Waveforms come exclusively from AnalyserNode input samples. No random/synthetic UI signal.
(() => {
  class MicrophoneRecorder {
    constructor({
      canvas,
      onStatus,
      onMeter,
      onClip,
      getFiles = () => [],
      maxDurationMs = 1199000,
      maxClipBytes = 64 * 1024 * 1024,
      maxTotalBytes = 127 * 1024 * 1024,
      maxFiles = 16,
      maxChunks = 8192,
      minDurationMs = 1500,
    }) {
      Object.assign(this, {
        canvas,
        onStatus,
        onMeter,
        onClip,
        getFiles,
        maxDurationMs,
        maxClipBytes,
        maxTotalBytes,
        maxFiles,
        maxChunks,
        minDurationMs,
      });
      this.epoch = 0;
      this.session = null;
      this.state = "idle";
      this.sequence = 0;
    }
    status(state, message) {
      this.state = state;
      this.onStatus?.(state, message);
    }
    owns(session) {
      return this.session === session && session.epoch === this.epoch;
    }
    clearCanvas() {
      const context = this.canvas?.getContext("2d");
      context?.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.onMeter?.({ rmsDb: null, peak: 0, elapsedMs: 0 });
    }
    cleanup(session) {
      // A permission promise may return a stream after cancel() already cleaned the session.
      session.stream?.getTracks().forEach((track) => track.stop());
      if (session.cleaned) return;
      session.cleaned = true;
      cancelAnimationFrame(session.frame);
      clearTimeout(session.timer);
      clearTimeout(session.finishTimer);
      try {
        session.source?.disconnect();
      } catch {}
      try {
        session.analyser?.disconnect();
      } catch {}
      try {
        const closing = session.context?.close();
        closing?.catch(() => {});
      } catch {}
      if (this.session === session) this.session = null;
    }
    async toggle() {
      if (this.state === "requesting") {
        this.cancel();
        return;
      }
      if (this.state === "recording") {
        this.stop();
        return;
      }
      if (this.state === "stopping") return;
      await this.start();
    }
    async start() {
      if (this.session) return;
      if (this.pendingPermission) {
        this.status(
          "idle",
          "上一次麦克风权限请求尚未返回；返回后会释放设备，请稍后重试",
        );
        return;
      }
      const files = this.getFiles();
      if (
        files.length >= this.maxFiles ||
        files.reduce((n, file) => n + file.size, 0) >= this.maxTotalBytes
      ) {
        this.status(
          "idle",
          "本地片段数量或总字节预算已满，请移除片段或分批提交",
        );
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        this.status(
          "idle",
          "浏览器不支持录音；请使用HTTPS及支持MediaRecorder的浏览器，或直接上传音频",
        );
        return;
      }
      const session = {
        epoch: ++this.epoch,
        chunks: [],
        bytes: 0,
        discard: false,
        startedAt: 0,
      };
      this.session = session;
      this.status("requesting", "等待麦克风权限；再次点击可取消等待");
      try {
        let stream;
        this.pendingPermission = true;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
          });
        } finally {
          this.pendingPermission = false;
        }
        session.stream = stream;
        if (!this.owns(session)) {
          this.cleanup(session);
          return;
        }
        const Audio = window.AudioContext || window.webkitAudioContext;
        session.context = new Audio({ latencyHint: "interactive" });
        await session.context.resume();
        if (!this.owns(session)) {
          this.cleanup(session);
          return;
        }
        session.source = session.context.createMediaStreamSource(stream);
        session.analyser = session.context.createAnalyser();
        session.analyser.fftSize = 2048;
        session.source.connect(session.analyser); // deliberately NOT connected to speakers
        session.samples = new Float32Array(session.analyser.fftSize);
        const mime = [
          "audio/webm;codecs=opus",
          "audio/ogg;codecs=opus",
          "audio/mp4",
        ].find((type) => window.MediaRecorder.isTypeSupported?.(type));
        session.recorder = mime
          ? new MediaRecorder(stream, { mimeType: mime })
          : new MediaRecorder(stream);
        session.recorder.ondataavailable = (event) => {
          if (!this.owns(session) || session.discard || !event.data.size)
            return;
          const existing = this.getFiles().reduce(
            (sum, file) => sum + file.size,
            0,
          );
          if (session.chunks.length >= this.maxChunks) {
            session.discard = true;
            session.chunks.length = 0;
            session.message = "录音分块数量超过预算，本段已丢弃";
            this.stop(session.message);
            return;
          }
          session.bytes += event.data.size;
          if (
            session.bytes > this.maxClipBytes ||
            existing + session.bytes > this.maxTotalBytes
          ) {
            session.discard = true;
            session.chunks.length = 0;
            session.message = "录音超过字节预算，本段已丢弃；请缩短后重录";
            this.stop(session.message);
            return;
          }
          session.chunks.push(event.data);
        };
        session.recorder.onerror = () => {
          session.discard = true;
          this.stop("录音器失败，本段未保存；可改用文件上传");
        };
        session.recorder.onstop = () => this.finish(session);
        for (const track of stream.getTracks())
          track.addEventListener(
            "ended",
            () => {
              if (this.owns(session) && this.state === "recording")
                this.stop("麦克风已断开；已停止采集，保存已有有效数据");
            },
            { once: true },
          );
        session.startedAt = performance.now();
        session.recorder.start(250);
        this.status("recording", "正在采集真实麦克风波形；不播放麦克风回声");
        session.timer = setTimeout(
          () =>
            this.stop("达到本地录音时长预算，已自动停止；服务端仍会复核时长"),
          this.maxDurationMs,
        );
        this.draw(session);
      } catch (error) {
        const current = this.owns(session);
        session.discard = true;
        this.cleanup(session);
        if (current) {
          this.clearCanvas();
          this.status(
            "idle",
            error.name === "NotAllowedError"
              ? "麦克风权限被拒绝；仍可上传已有音频"
              : "录音初始化失败（" + error.name + "）；仍可上传已有音频",
          );
        }
      }
    }
    draw(session) {
      if (!this.owns(session) || this.state !== "recording") return;
      session.analyser.getFloatTimeDomainData(session.samples);
      let square = 0,
        peak = 0;
      for (const sample of session.samples) {
        square += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
      }
      this.onMeter?.({
        rmsDb:
          20 *
          Math.log10(
            Math.max(Math.sqrt(square / session.samples.length), 1e-6),
          ),
        peak,
        elapsedMs: performance.now() - session.startedAt,
      });
      const canvas = this.canvas,
        context = canvas?.getContext("2d");
      if (context) {
        const width = Math.min(
          2048,
          Math.max(1, Math.round(canvas.clientWidth || 600)),
        );
        const ratio = Math.min(devicePixelRatio || 1, 2);
        if (canvas.width !== Math.round(width * ratio)) {
          canvas.width = Math.round(width * ratio);
          canvas.height = Math.round(96 * ratio);
        }
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.strokeStyle = peak >= 0.98 ? "#f85149" : "#58a6ff";
        context.lineWidth = ratio;
        context.beginPath();
        for (let i = 0; i < session.samples.length; i++) {
          const x = (i / (session.samples.length - 1)) * canvas.width;
          const y =
            ((1 - Math.max(-1, Math.min(1, session.samples[i]))) *
              canvas.height) /
            2;
          if (!i) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.stroke();
      }
      session.frame = requestAnimationFrame(() => this.draw(session));
    }
    stop(message = "已停止采集") {
      const session = this.session;
      if (!session || !this.owns(session)) return;
      if (this.state === "requesting") {
        this.cancel();
        return;
      }
      if (this.state !== "recording") return;
      session.message = message;
      session.durationMs = performance.now() - session.startedAt;
      this.status("stopping", message + "；正在封装片段…");
      cancelAnimationFrame(session.frame);
      clearTimeout(session.timer);
      session.finishTimer = setTimeout(() => {
        if (!this.owns(session)) return;
        session.discard = true;
        session.message = "录音封装超时，本段已丢弃";
        this.finish(session);
      }, 2000);
      try {
        // Native auto-stop can make state inactive before the track-ended handler.
        // Keep ownership for the queued final data/stop events rather than discarding.
        if (session.recorder.state !== "inactive") session.recorder.stop();
      } catch {
        session.discard = true;
        this.finish(session);
      }
      session.stream.getTracks().forEach((track) => track.stop());
    }
    finish(session) {
      const current = this.owns(session);
      this.cleanup(session);
      if (!current) {
        session.chunks.length = 0;
        return;
      }
      if (session.durationMs == null)
        session.durationMs = performance.now() - session.startedAt;
      let message = session.message || "录音器已结束采集";
      const files = this.getFiles();
      if (
        files.length >= this.maxFiles ||
        files.reduce((sum, file) => sum + file.size, 0) + session.bytes >
          this.maxTotalBytes
      )
        session.discard = true;
      if (
        !session.discard &&
        session.bytes &&
        session.durationMs >= this.minDurationMs
      ) {
        const type =
          session.recorder.mimeType ||
          session.chunks[0]?.type ||
          "application/octet-stream";
        const extension = type.includes("mp4")
          ? "m4a"
          : type.includes("ogg")
            ? "ogg"
            : type.includes("webm")
              ? "webm"
              : "bin";
        const file = new File(
          session.chunks,
          `rec_${++this.sequence}.${extension}`,
          { type },
        );
        this.onClip?.(file, session.durationMs);
        message += "；已保存至本地待提交列表";
      } else if (!session.discard)
        message = "录音为空或不足1.5秒，本段未保存；请重录";
      else message += "；本段未保存";
      session.chunks.length = 0;
      this.status("idle", message);
    }
    cancel() {
      const session = this.session;
      this.epoch++;
      if (session) {
        session.discard = true;
        session.chunks.length = 0;
        try {
          if (session.recorder?.state === "recording") session.recorder.stop();
        } catch {}
        this.cleanup(session);
      }
      this.clearCanvas();
      this.status("idle", "未采集；录音已取消并释放设备");
    }
  }
  window.QttsMicrophoneRecorder = MicrophoneRecorder;
})();
