/* Observes browser transport and Worklet receipts; cannot hear a physical speaker. */
(function (root) {
  "use strict";
  class QttsTrace {
    constructor({ now, status, send, render, startedAt, clickAt, interval = true }) {
      this.now = now || (() => performance.now());
      this.status = status; this.send = send; this.render = render || (() => {});
      this.startedAt = startedAt; this.clickAt = clickAt;
      this.session = ""; this.stopped = false; this.networkEnded = false;
      this.endReceived = false; this.hasError = false; this.completed = false;
      this.events = []; this.marks = {};
      this.counts = { audio_bytes: 0, text_deltas: 0, text_chars: 0, received_segments: 0, stats_frames: 0 };
      this.sequence = 0; this.lastUpload = -Infinity; this.reportFailures = 0; this.timer = null;
      this.phase = "running";
      this.event("request");
      if (interval) this.timer = setInterval(() => this.tick(), 250);
    }
    elapsed() { return Math.max(0, this.now() - this.startedAt); }
    event(name) {
      if (this.stopped || Object.prototype.hasOwnProperty.call(this.marks, name)) return;
      this.marks[name] = this.elapsed();
      if (this.events.length < 32) this.events.push({ event: name, at_ms: this.marks[name] });
    }
    headers(id) {
      if (typeof id === "string" && /^[0-9a-f]{12,64}$/.test(id)) this.session = id;
      this.event("headers");
    }
    frame(type, bytes, text) {
      if (this.stopped) return;
      if (type === 1) { this.counts.audio_bytes += bytes; this.event("pcm"); }
      if (type === 2) { this.counts.received_segments++; this.event("segment_received"); }
      if (type === 3) { this.counts.text_deltas++; this.counts.text_chars += typeof text === "string" ? Array.from(text).length : 0; this.event("text_delta"); }
      if (type === 4) { this.counts.stats_frames++; this.event("stats"); }
      if (type === 5) this.endReceived = true;
      if (type === 6) this.hasError = true;
    }
    networkDone({ endReceived = this.endReceived, hasError = false } = {}) {
      if (this.stopped) return;
      this.networkEnded = true; this.endReceived = endReceived;
      this.hasError = this.hasError || hasError || !endReceived || this.counts.audio_bytes === 0;
      this.phase = this.hasError ? "error" : "generation_received";
      this.event("network_end"); this.upload(); this.tick();
    }
    payload() {
      const s = this.status();
      const finite = (v) => Number.isFinite(v) && v >= 0 ? v : null;
      return {
        session: this.session, phase: this.phase, clock_origin: "browser_request_start",
        elapsed_ms: this.elapsed(), ui_initialization_ms: finite(this.startedAt - this.clickAt),
        first_byte_ms: finite(this.marks.headers), response_headers_ms: finite(this.marks.headers), first_pcm_ms: s.firstPcmMs > 0 ? finite(s.firstPcmMs) : null,
        // Legacy first_played_ms is a command timestamp, NOT physical acoustic onset.
        first_played_ms: s.firstPlayedMs > 0 ? finite(s.firstPlayedMs) : null, play_command_ms: s.firstPlayedMs > 0 ? finite(s.firstPlayedMs) : null,
        first_consumed_ms: s.firstConsumedMs > 0 ? finite(s.firstConsumedMs) : null,
        generation_received_ms: finite(this.marks.network_end),
        playback_completed_ms: finite(this.marks.playback_drained),
        end_to_end_click_completed_ms: this.completed ? finite(this.startedAt + this.marks.playback_drained - this.clickAt) : null,
        underruns: finite(s.underruns), gaps_ms: (s.gapsMs || []).filter(Number.isFinite).slice(-64),
        min_buffer_s: finite(s.minBufferS), played_s: finite(s.playedS), buffered_s: finite(s.bufferedS),
        pending_samples: finite(s.pendingSamples), end_acknowledged: s.endAcknowledged === true,
        stream_epoch: finite(s.streamEpoch), audio_context_state: s.audioContextState,
        base_latency_s: finite(s.baseLatency), output_latency_s: finite(s.outputLatency),
        end_received: this.endReceived, has_error: this.hasError,
        speaker_heard: false, client_untrusted: true, ...this.counts, events: this.events.slice(),
      };
    }
    upload() {
      if (!this.session) return;
      this.lastUpload = this.elapsed();
      // A receipt failure is visible locally; it never disrupts audio or leaks a raw exception.
      const payload = { ...this.payload(), report_sequence: ++this.sequence };
      Promise.resolve().then(() => this.send(payload)).catch(() => { this.reportFailures++; });
    }
    tick() {
      if (this.stopped) return;
      const s = this.status();
      if (s.firstConsumedMs > 0) this.event("worklet_first_consumed");
      const drained = this.networkEnded && this.endReceived && s.state === "ended" &&
        s.endAcknowledged === true && s.pendingSamples === 0 && s.playedS > 0 && this.counts.audio_bytes > 0;
      if (drained) {
        if (!this.hasError) {
          this.completed = true; this.phase = "playback_completed"; this.event("playback_drained");
        } else this.phase = "error";
        this.upload(); this.render({ ...this.payload(), report_failures: this.reportFailures });
        this.close(); return;
      }
      if (this.networkEnded && this.hasError && s.state === "ended") {
        this.phase = "error"; this.upload(); this.render(this.payload()); this.close(); return;
      }
      if (!this.networkEnded && s.state === "playing") this.phase = "playing";
      if (this.elapsed() - this.lastUpload >= 2000) this.upload();
      this.render({ ...this.payload(), report_failures: this.reportFailures });
    }
    stop(reason = "cancelled") {
      if (this.stopped) return;
      this.phase = ["cancelled", "superseded", "interrupted", "error"].includes(reason) ? reason : "interrupted";
      this.completed = false; this.event(this.phase + "_event"); this.upload();
      this.render(this.payload()); this.close();
    }
    close() { this.stopped = true; if (this.timer !== null) clearInterval(this.timer); this.timer = null; }
  }
  root.QttsTrace = QttsTrace;
  if (typeof module !== "undefined" && module.exports) module.exports = { QttsTrace };
})(typeof window !== "undefined" ? window : globalThis);
