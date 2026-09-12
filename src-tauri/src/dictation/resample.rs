//! Streaming windowed-sinc resampler producing the 16 kHz mono f32 stream
//! whisper expects. Stateless across calls except for the carried tail, so it
//! is safe to run inside the realtime capture callback.

use std::f64::consts::PI;

pub const WHISPER_RATE: u32 = 16_000;

/// Kernel half-width in input samples (kernel spans ±HALF_TAPS).
const HALF_TAPS: usize = 32;
/// Pull the cutoff just under the lower Nyquist so the transition band of a
/// 64-tap kernel has room to roll off.
const CUTOFF_SCALE: f64 = 0.9;

pub struct Resampler {
    /// Input samples per output sample (>1 when downsampling).
    step: f64,
    /// Low-pass cutoff normalized to the input rate (0.5 = input Nyquist).
    cutoff: f64,
    /// Unconsumed input; `pos` is relative to `pending[0]`.
    pending: Vec<f32>,
    /// Fractional input position of the next output sample.
    pos: f64,
    passthrough: bool,
}

impl Resampler {
    pub fn new(input_rate: u32, output_rate: u32) -> Self {
        let input_rate = input_rate.max(1) as f64;
        let output_rate = output_rate.max(1) as f64;
        Self {
            step: input_rate / output_rate,
            cutoff: 0.5 * CUTOFF_SCALE * f64::min(1.0, output_rate / input_rate),
            pending: Vec::new(),
            pos: 0.0,
            passthrough: input_rate == output_rate,
        }
    }

    /// Consume a chunk of mono input; resampled frames append to `out`.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if self.passthrough {
            out.extend_from_slice(input);
            return;
        }
        self.pending.extend_from_slice(input);
        while self.pos + HALF_TAPS as f64 <= self.pending.len() as f64 - 1.0 {
            out.push(self.convolve(self.pos));
            self.pos += self.step;
        }
        // Keep only the samples the kernel still needs plus the unprocessed tail.
        let keep_from = (self.pos.floor() as usize).saturating_sub(HALF_TAPS);
        if keep_from > 0 {
            self.pending.drain(..keep_from.min(self.pending.len()));
            self.pos -= keep_from as f64;
        }
    }

    /// Flush the trailing samples (padded with silence) at end of stream.
    pub fn finish(&mut self, out: &mut Vec<f32>) {
        if self.passthrough {
            return;
        }
        let end = self.pending.len();
        self.pending.resize(end + HALF_TAPS * 2 + 2, 0.0);
        while self.pos < end as f64 {
            out.push(self.convolve(self.pos));
            self.pos += self.step;
        }
        self.pending.clear();
    }

    fn convolve(&self, pos: f64) -> f32 {
        let lo = (pos - HALF_TAPS as f64).ceil().max(0.0) as usize;
        let hi = ((pos + HALF_TAPS as f64).floor() as usize).min(self.pending.len() - 1);
        let mut sum = 0.0f64;
        let mut norm = 0.0f64;
        for k in lo..=hi {
            let t = k as f64 - pos;
            let w = kernel(t, self.cutoff);
            sum += self.pending[k] as f64 * w;
            norm += w;
        }
        if norm.abs() < f64::EPSILON {
            0.0
        } else {
            (sum / norm) as f32
        }
    }
}

fn kernel(t: f64, cutoff: f64) -> f64 {
    if t.abs() > HALF_TAPS as f64 {
        return 0.0;
    }
    sinc(2.0 * cutoff * t) * blackman(t / HALF_TAPS as f64)
}

fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-9 {
        1.0
    } else {
        (PI * x).sin() / (PI * x)
    }
}

fn blackman(u: f64) -> f64 {
    // u in [-1, 1]; 0.42 + 0.5·cos(πu) + 0.08·cos(2πu)
    0.42 + 0.5 * (PI * u).cos() + 0.08 * (2.0 * PI * u).cos()
}

/// Mix an interleaved frame buffer down to mono.
pub fn to_mono(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
    let channels = channels.max(1);
    if channels == 1 {
        out.extend_from_slice(interleaved);
        return;
    }
    let inv = 1.0 / channels as f32;
    for frame in interleaved.chunks(channels) {
        let sum: f32 = frame.iter().sum();
        out.push(sum * inv);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f64, rate: u32, seconds: f64) -> Vec<f32> {
        let n = (rate as f64 * seconds) as usize;
        (0..n)
            .map(|i| (2.0 * PI * freq * i as f64 / rate as f64).sin() as f32)
            .collect()
    }

    fn zero_crossings(samples: &[f32]) -> usize {
        samples
            .windows(2)
            .filter(|w| w[0] <= 0.0 && w[1] > 0.0)
            .count()
    }

    fn rms(samples: &[f32]) -> f64 {
        (samples
            .iter()
            .map(|s| (*s as f64) * (*s as f64))
            .sum::<f64>()
            / samples.len() as f64)
            .sqrt()
    }

    #[test]
    fn downsampling_preserves_pitch_and_length() {
        let input = sine(1_000.0, 48_000, 1.0);
        let mut resampler = Resampler::new(48_000, WHISPER_RATE);
        let mut out = Vec::new();
        // Feed in small chunks like a real capture callback.
        for chunk in input.chunks(480) {
            resampler.process(chunk, &mut out);
        }
        resampler.finish(&mut out);
        assert!((out.len() as f64 - 16_000.0).abs() < 40.0);
        // Steady region: skip filter edges.
        let steady = &out[1600..out.len() - 1600];
        let freq = zero_crossings(steady) as f64 / (steady.len() as f64 / 16_000.0);
        assert!((freq - 1000.0).abs() < 25.0, "freq {freq}");
        assert!(rms(steady) > 0.55, "rms {}", rms(steady));
    }

    #[test]
    fn non_integer_ratio_works() {
        let input = sine(440.0, 44_100, 0.5);
        let mut resampler = Resampler::new(44_100, WHISPER_RATE);
        let mut out = Vec::new();
        resampler.process(&input, &mut out);
        resampler.finish(&mut out);
        assert!((out.len() as f64 - 8_000.0).abs() < 40.0);
        let steady = &out[1600..out.len() - 1600];
        let freq = zero_crossings(steady) as f64 / (steady.len() as f64 / 16_000.0);
        assert!((freq - 440.0).abs() < 15.0, "freq {freq}");
    }

    #[test]
    fn content_above_output_nyquist_is_filtered() {
        // 12 kHz at 48 kHz aliases to 4 kHz without a filter.
        let input = sine(12_000.0, 48_000, 0.5);
        let mut resampler = Resampler::new(48_000, WHISPER_RATE);
        let mut out = Vec::new();
        resampler.process(&input, &mut out);
        resampler.finish(&mut out);
        let steady = &out[1600..out.len() - 1600];
        assert!(rms(steady) < 0.02, "alias rms {}", rms(steady));
    }

    #[test]
    fn same_rate_is_passthrough() {
        let input = sine(500.0, WHISPER_RATE, 0.2);
        let mut resampler = Resampler::new(WHISPER_RATE, WHISPER_RATE);
        let mut out = Vec::new();
        resampler.process(&input, &mut out);
        assert_eq!(out, input);
    }

    #[test]
    fn mono_mixdown_averages_channels() {
        let mut out = Vec::new();
        to_mono(&[0.5, -0.5, 1.0, 1.0], 2, &mut out);
        assert_eq!(out, vec![0.0, 1.0]);
    }
}
