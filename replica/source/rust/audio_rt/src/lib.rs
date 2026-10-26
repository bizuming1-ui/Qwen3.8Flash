//! QTTS real-time audio runtime (std only, C ABI, loaded from Python via ctypes).
//!
//! Responsibilities (all per-chunk, allocation-free in the hot path):
//!  * DC blocking (1-pole high-pass, ~20 Hz)
//!  * Slow speech-gated loudness leveler -> keeps every segment / both GPUs at the
//!    same target RMS (consistency) without pumping
//!  * Soft limiter + float32 -> int16 conversion
//!  * Click-free segment tails (decay of the last sample)
//!  * Breath / air-noise synthesis (fallback when no real breath was recorded)
//!  * RMS / peak measurement helpers

use std::os::raw::c_float;
use std::slice;

pub const ABI_VERSION: u32 = 3;

#[inline]
fn db_to_lin(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

#[inline]
fn lin_to_db(x: f32) -> f32 {
    20.0 * x.max(1e-9).log10()
}

pub struct Leveler {
    sr: f32,
    target: f32,   // linear RMS target
    min_gain: f32, // linear
    max_gain: f32, // linear
    env: f32,      // speech RMS envelope (linear)
    blocks_seen: u64,
    gain: f32,
    // DC blocker state
    dc_x1: f32,
    dc_y1: f32,
    dc_r: f32,
    // fade-in
    fade_left: usize,
    fade_total: usize,
    last_out: f32,
    // block accumulator
    blk_n: usize,
    blk_sum: f32,
    blk_len: usize,
    desired: f32,
    // per-sample smoothing coefficients
    att: f32,
    rel: f32,
}

impl Leveler {
    pub fn new(sr: u32, target_dbfs: f32, max_gain_db: f32, min_gain_db: f32) -> Self {
        let srf = sr.max(8000) as f32;
        let blk_len = ((srf * 0.01) as usize).max(32);
        let t = db_to_lin(target_dbfs.clamp(-40.0, -6.0));
        Leveler {
            sr: srf,
            target: t,
            min_gain: db_to_lin(min_gain_db.clamp(-24.0, 0.0)),
            max_gain: db_to_lin(max_gain_db.clamp(0.0, 18.0)),
            env: t,
            blocks_seen: 0,
            gain: 1.0,
            dc_x1: 0.0,
            dc_y1: 0.0,
            dc_r: 1.0 - (2.0 * std::f32::consts::PI * 20.0 / srf),
            fade_left: 0,
            fade_total: 0,
            last_out: 0.0,
            blk_n: 0,
            blk_sum: 0.0,
            blk_len,
            desired: 1.0,
            att: 1.0 - (-1.0 / (0.030 * srf)).exp(),
            rel: 1.0 - (-1.0 / (0.600 * srf)).exp(),
        }
    }

    pub fn start_segment(&mut self) {
        self.fade_total = ((self.sr * 0.004) as usize).max(8);
        self.fade_left = self.fade_total;
    }

    #[inline]
    fn limit(x: f32) -> f32 {
        const T: f32 = 0.89;
        const K: f32 = 0.10;
        let a = x.abs();
        if a <= T {
            x
        } else {
            let y = T + K * ((a - T) / K).tanh();
            if x < 0.0 {
                -y
            } else {
                y
            }
        }
    }

    /// Process float input into i16 output. `out.len() >= inp.len()`.
    pub fn process(&mut self, inp: &[f32], out: &mut [i16]) {
        let n = inp.len().min(out.len());
        for i in 0..n {
            let x = if inp[i].is_finite() { inp[i] } else { 0.0 };
            // DC blocker
            let y = x - self.dc_x1 + self.dc_r * self.dc_y1;
            self.dc_x1 = x;
            self.dc_y1 = y;

            // block RMS accumulation (post-DC, pre-gain)
            self.blk_sum += y * y;
            self.blk_n += 1;
            if self.blk_n >= self.blk_len {
                let rms = (self.blk_sum / self.blk_n as f32).sqrt();
                self.blk_n = 0;
                self.blk_sum = 0.0;
                // speech gate: only learn from audible blocks
                if lin_to_db(rms) > -46.0 {
                    let a = if self.blocks_seen < 60 { 0.08 } else { 0.012 };
                    self.env += (rms - self.env) * a;
                    self.blocks_seen += 1;
                    let want = self.target / self.env.max(1e-4);
                    self.desired = want.clamp(self.min_gain, self.max_gain);
                }
            }
            // smooth gain toward desired (fast down, slow up)
            let c = if self.desired < self.gain { self.att } else { self.rel };
            self.gain += (self.desired - self.gain) * c;

            let mut v = y * self.gain;
            if self.fade_left > 0 {
                let p = 1.0 - (self.fade_left as f32 / self.fade_total as f32);
                // raised-cosine fade in
                v *= 0.5 - 0.5 * (std::f32::consts::PI * p).cos();
                self.fade_left -= 1;
            }
            let v = Self::limit(v);
            self.last_out = v;
            out[i] = (v * 32767.0).round().clamp(-32768.0, 32767.0) as i16;
        }
    }

    /// Emit a short decay from the last output sample to zero (click-free tail).
    pub fn flush(&mut self, out: &mut [i16]) -> usize {
        let n = out.len();
        if n == 0 {
            return 0;
        }
        let start = self.last_out;
        for (i, o) in out.iter_mut().enumerate() {
            let p = (i + 1) as f32 / n as f32;
            let w = 0.5 + 0.5 * (std::f32::consts::PI * p).cos();
            *o = (start * w * 32767.0).round().clamp(-32768.0, 32767.0) as i16;
        }
        self.last_out = 0.0;
        self.dc_x1 = 0.0;
        self.dc_y1 = 0.0;
        n
    }

    pub fn gain_db(&self) -> f32 {
        lin_to_db(self.gain)
    }
    pub fn env_dbfs(&self) -> f32 {
        lin_to_db(self.env)
    }
}

struct XorShift(u64);
impl XorShift {
    #[inline]
    fn next_f32(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        let r = x.wrapping_mul(0x2545F4914F6CDD1D);
        ((r >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
    }
}

struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}
impl Biquad {
    fn bandpass(sr: f32, f0: f32, q: f32) -> Self {
        let w0 = 2.0 * std::f32::consts::PI * f0 / sr;
        let alpha = w0.sin() / (2.0 * q);
        let a0 = 1.0 + alpha;
        Biquad {
            b0: alpha / a0,
            b1: 0.0,
            b2: -alpha / a0,
            a1: -2.0 * w0.cos() / a0,
            a2: (1.0 - alpha) / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }
    #[inline]
    fn run(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

// ----------------------------------------------------------------------------
// C ABI
// ----------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn rt_version() -> u32 {
    ABI_VERSION
}

#[no_mangle]
pub extern "C" fn rt_leveler_new(sr: u32, target_dbfs: c_float, max_gain_db: c_float, min_gain_db: c_float) -> *mut Leveler {
    Box::into_raw(Box::new(Leveler::new(sr, target_dbfs, max_gain_db, min_gain_db)))
}

/// # Safety
/// `p` must come from `rt_leveler_new` and not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn rt_leveler_free(p: *mut Leveler) {
    if !p.is_null() {
        drop(Box::from_raw(p));
    }
}

/// # Safety
/// `p` must be a valid leveler pointer.
#[no_mangle]
pub unsafe extern "C" fn rt_leveler_start_segment(p: *mut Leveler) {
    if let Some(l) = p.as_mut() {
        l.start_segment();
    }
}

/// # Safety
/// `inp` must point to `n` f32, `out` to `n` i16, `p` valid.
#[no_mangle]
pub unsafe extern "C" fn rt_leveler_process(p: *mut Leveler, inp: *const c_float, n: usize, out: *mut i16) -> i32 {
    if p.is_null() || inp.is_null() || out.is_null() {
        return -1;
    }
    let l = &mut *p;
    let i = slice::from_raw_parts(inp, n);
    let o = slice::from_raw_parts_mut(out, n);
    l.process(i, o);
    n as i32
}

/// # Safety
/// `out` must point to `n` i16.
#[no_mangle]
pub unsafe extern "C" fn rt_leveler_flush(p: *mut Leveler, out: *mut i16, n: usize) -> i32 {
    if p.is_null() || out.is_null() {
        return -1;
    }
    let o = slice::from_raw_parts_mut(out, n);
    (*p).flush(o) as i32
}

/// # Safety
/// `p` must be valid.
#[no_mangle]
pub unsafe extern "C" fn rt_leveler_gain_db(p: *const Leveler) -> c_float {
    if p.is_null() {
        0.0
    } else {
        (*p).gain_db()
    }
}

/// # Safety
/// `p` must be valid.
#[no_mangle]
pub unsafe extern "C" fn rt_leveler_env_dbfs(p: *const Leveler) -> c_float {
    if p.is_null() {
        -90.0
    } else {
        (*p).env_dbfs()
    }
}

/// Breath / air noise: band-limited noise with an inhale-shaped envelope.
/// `level_dbfs` is the RMS level of the loudest part. Output is f32 in [-1, 1].
///
/// # Safety
/// `out` must point to `n` f32.
#[no_mangle]
pub unsafe extern "C" fn rt_breath_synth(out: *mut c_float, n: usize, sr: u32, seed: u64, level_dbfs: c_float) -> i32 {
    if out.is_null() || n == 0 {
        return -1;
    }
    let o = slice::from_raw_parts_mut(out, n);
    let srf = sr.max(8000) as f32;
    let mut rng = XorShift(seed ^ 0x9E3779B97F4A7C15 | 1);
    let mut bp1 = Biquad::bandpass(srf, 1400.0, 0.55);
    let mut bp2 = Biquad::bandpass(srf, 3200.0, 0.8);
    let amp = db_to_lin(level_dbfs.clamp(-60.0, -18.0));
    let rise = (n as f32 * 0.42).max(1.0);
    let mut acc = 0.0f32;
    for (i, v) in o.iter_mut().enumerate() {
        let x = rng.next_f32();
        let y = bp1.run(x) * 1.0 + bp2.run(x) * 0.45;
        let t = i as f32;
        let env = if t < rise {
            let p = t / rise;
            0.5 - 0.5 * (std::f32::consts::PI * p).cos()
        } else {
            let p = (t - rise) / (n as f32 - rise).max(1.0);
            (1.0 - p).powf(1.6)
        };
        // slow irregularity so it doesn't sound like a hiss
        let wob = 1.0 + 0.12 * (2.0 * std::f32::consts::PI * 6.0 * t / srf).sin();
        let s = y * env * wob;
        acc += s * s;
        *v = s;
    }
    // normalise so that loudest-part RMS ~ amp (approx: whole-signal rms * 1.7)
    let rms = (acc / n as f32).sqrt().max(1e-9);
    let g = amp / (rms * 1.7);
    for v in o.iter_mut() {
        *v = (*v * g).clamp(-0.98, 0.98);
    }
    n as i32
}

/// # Safety
/// `inp` must point to `n` f32.
#[no_mangle]
pub unsafe extern "C" fn rt_rms_dbfs(inp: *const c_float, n: usize) -> c_float {
    if inp.is_null() || n == 0 {
        return -90.0;
    }
    let s = slice::from_raw_parts(inp, n);
    let mut acc = 0.0f64;
    for &x in s {
        acc += (x as f64) * (x as f64);
    }
    lin_to_db((acc / n as f64).sqrt() as f32)
}

/// # Safety
/// `inp` must point to `n` f32.
#[no_mangle]
pub unsafe extern "C" fn rt_peak(inp: *const c_float, n: usize) -> c_float {
    if inp.is_null() || n == 0 {
        return 0.0;
    }
    slice::from_raw_parts(inp, n).iter().fold(0.0f32, |m, &x| m.max(x.abs()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(n: usize, amp: f32, sr: f32) -> Vec<f32> {
        (0..n)
            .map(|i| amp * (2.0 * std::f32::consts::PI * 180.0 * i as f32 / sr).sin())
            .collect()
    }

    fn rms_i16(v: &[i16]) -> f32 {
        let s: f64 = v.iter().map(|&x| (x as f64 / 32768.0).powi(2)).sum();
        (s / v.len() as f64).sqrt() as f32
    }

    #[test]
    fn leveler_converges_to_target() {
        let mut l = Leveler::new(24000, -20.0, 12.0, -12.0);
        let x = sine(24000 * 8, 0.05, 24000.0); // quiet: rms ~ -33 dBFS
        let mut o = vec![0i16; x.len()];
        l.start_segment();
        l.process(&x, &mut o);
        let tail = &o[o.len() - 24000..];
        let db = 20.0 * rms_i16(tail).log10();
        assert!((db + 20.0).abs() < 2.0, "tail rms {db}");
    }

    #[test]
    fn leveler_is_silent_safe_and_finite() {
        let mut l = Leveler::new(24000, -20.0, 12.0, -12.0);
        let mut x = vec![0.0f32; 4800];
        x[10] = f32::NAN;
        x[11] = f32::INFINITY;
        let mut o = vec![1i16; x.len()];
        l.process(&x, &mut o);
        assert!(o.iter().all(|&v| v.abs() < 2));
    }

    #[test]
    fn limiter_never_clips_hard() {
        let mut l = Leveler::new(24000, -6.0, 18.0, 0.0);
        let x = sine(24000, 3.0, 24000.0);
        let mut o = vec![0i16; x.len()];
        l.process(&x, &mut o);
        assert!(o.iter().all(|&v| (v as i32).abs() < 32767));
    }

    #[test]
    fn flush_decays_to_zero() {
        let mut l = Leveler::new(24000, -20.0, 6.0, -6.0);
        let x = sine(2400, 0.2, 24000.0);
        let mut o = vec![0i16; x.len()];
        l.process(&x, &mut o);
        let mut t = vec![0i16; 192];
        l.flush(&mut t);
        assert!(t[t.len() - 1].abs() <= 2);
    }

    #[test]
    fn breath_is_bounded_and_nonzero() {
        let mut b = vec![0f32; 24000 / 3];
        unsafe { rt_breath_synth(b.as_mut_ptr(), b.len(), 24000, 7, -38.0) };
        let p = b.iter().fold(0f32, |m, &x| m.max(x.abs()));
        assert!(p > 0.001 && p < 0.5, "peak {p}");
        assert!(b[0].abs() < 0.01 && b[b.len() - 1].abs() < 0.01);
    }
}
