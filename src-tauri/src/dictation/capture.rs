//! Microphone capture via cpal (CoreAudio on macOS, WASAPI on Windows) and
//! the macOS runtime permission check. Everything funnels into a shared
//! 16 kHz mono f32 buffer the inference worker reads.

use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SizedSample};

use super::resample::{Resampler, WHISPER_RATE};

/// Keep at most this much captured audio; older audio is dropped so a long
/// session cannot grow memory without bound.
const MAX_BUFFER_SAMPLES: usize = WHISPER_RATE as usize * 60 * 10;

/// Shared capture output. `samples[0]` is absolute sample index `base`.
#[derive(Default)]
pub struct AudioBuffer {
    samples: Vec<f32>,
    base: u64,
    error: Option<String>,
}

impl AudioBuffer {
    pub fn shared() -> Arc<Mutex<Self>> {
        Arc::new(Mutex::new(Self::default()))
    }

    fn push(&mut self, data: &[f32]) {
        self.samples.extend_from_slice(data);
        if self.samples.len() > MAX_BUFFER_SAMPLES {
            let drop = self.samples.len() - MAX_BUFFER_SAMPLES;
            self.samples.drain(..drop);
            self.base += drop as u64;
        }
    }

    fn fail(&mut self, error: String) {
        self.error = Some(error);
    }

    /// (absolute index of samples[0], samples). Window access without copying
    /// is impossible through the lock, so callers clone the tail they need.
    pub fn snapshot(&self) -> BufferSnapshot {
        BufferSnapshot {
            base: self.base,
            samples: self.samples.clone(),
            error: self.error.clone(),
        }
    }

    /// Clone only the trailing `max_samples` for a partial window pass.
    pub fn tail(&self, max_samples: usize) -> BufferSnapshot {
        let keep = self.samples.len().min(max_samples);
        BufferSnapshot {
            base: self.base + (self.samples.len() - keep) as u64,
            samples: self.samples[self.samples.len() - keep..].to_vec(),
            error: self.error.clone(),
        }
    }
}

pub struct BufferSnapshot {
    /// Absolute 16 kHz sample index of `samples[0]`.
    pub base: u64,
    pub samples: Vec<f32>,
    pub error: Option<String>,
}

impl BufferSnapshot {
    /// Absolute position one past the last captured sample.
    pub fn end(&self) -> u64 {
        self.base + self.samples.len() as u64
    }
}

pub struct Capture {
    stream: cpal::Stream,
    device_name: String,
}

impl Capture {
    pub fn device_name(&self) -> &str {
        &self.device_name
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        // Dropping the stream stops the OS tap.
        let _ = &self.stream;
    }
}

/// Open the default input device and start pushing 16 kHz mono audio into
/// `sink`. The OS-level capture thread belongs to cpal; the returned handle
/// must stay alive for capture to continue.
pub fn start(sink: Arc<Mutex<AudioBuffer>>) -> Result<Capture, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("No microphone found — connect an input device and retry")?;
    let device_name = device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| "microphone".into());
    let supported = device
        .default_input_config()
        .map_err(|error| format!("Cannot read microphone config on {device_name}: {error}"))?;
    let channels = supported.channels() as usize;
    let input_rate = supported.sample_rate();
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();

    let stream = match format {
        cpal::SampleFormat::F32 => build::<f32>(&device, &config, &sink, channels, input_rate)?,
        cpal::SampleFormat::I16 => build::<i16>(&device, &config, &sink, channels, input_rate)?,
        cpal::SampleFormat::U16 => build::<u16>(&device, &config, &sink, channels, input_rate)?,
        cpal::SampleFormat::I32 => build::<i32>(&device, &config, &sink, channels, input_rate)?,
        cpal::SampleFormat::F64 => build::<f64>(&device, &config, &sink, channels, input_rate)?,
        other => return Err(format!("Unsupported microphone sample format {other}")),
    };
    stream
        .play()
        .map_err(|error| format!("Cannot start microphone on {device_name}: {error}"))?;
    Ok(Capture {
        stream,
        device_name,
    })
}

fn build<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sink: &Arc<Mutex<AudioBuffer>>,
    channels: usize,
    input_rate: u32,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + Sample,
    f32: cpal::FromSample<T>,
{
    let sink_data = Arc::clone(sink);
    let sink_err = Arc::clone(sink);
    let mut resampler = Resampler::new(input_rate, WHISPER_RATE);
    let mut mono = Vec::new();
    let mut resampled = Vec::new();
    device
        .build_input_stream(
            *config,
            move |data: &[T], _| {
                mono.clear();
                resampled.clear();
                for frame in data.chunks(channels) {
                    let mut sum = 0.0f32;
                    for sample in frame {
                        sum += (*sample).to_sample::<f32>();
                    }
                    mono.push(sum / channels as f32);
                }
                resampler.process(&mono, &mut resampled);
                sink_data.lock().unwrap().push(&resampled);
            },
            move |error: cpal::Error| {
                sink_err
                    .lock()
                    .unwrap()
                    .fail(format!("Microphone stream failed: {error}"));
            },
            None,
        )
        .map_err(|error| format!("Cannot open microphone stream: {error}"))
}

// ── macOS microphone permission ────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MicPermission {
    /// Platform does not gate capture, or state could not be determined.
    Unknown,
    NotDetermined,
    Restricted,
    Denied,
    Authorized,
}

/// Current microphone authorization without prompting.
pub fn mic_permission() -> MicPermission {
    #[cfg(target_os = "macos")]
    {
        macos::authorization_status()
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Windows/Linux desktop builds access the mic without a runtime
        // prompt; failures surface as capture errors instead.
        MicPermission::Unknown
    }
}

/// Ask the OS for mic access (shows the system prompt when undetermined).
/// Returns the resulting permission.
#[cfg(target_os = "macos")]
pub fn request_mic_permission() -> MicPermission {
    macos::request_access()
}

#[cfg(not(target_os = "macos"))]
pub fn request_mic_permission() -> MicPermission {
    MicPermission::Unknown
}

#[cfg(target_os = "macos")]
mod macos {
    use super::MicPermission;
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    // Pull in AVFoundation so AVCaptureDevice resolves.
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    /// AVAuthorizationStatus for AVMediaTypeAudio ("soun").
    pub fn authorization_status() -> MicPermission {
        unsafe {
            let media = NSString::from_str("soun");
            let status: i64 =
                msg_send![class!(AVCaptureDevice), authorizationStatusForMediaType: &*media];
            match status {
                0 => MicPermission::NotDetermined,
                1 => MicPermission::Restricted,
                2 => MicPermission::Denied,
                3 => MicPermission::Authorized,
                _ => MicPermission::Unknown,
            }
        }
    }

    /// `+[AVCaptureDevice requestAccessForMediaType:completionHandler:]`.
    /// The completion block runs on an OS queue; wait for it on the caller.
    pub fn request_access() -> MicPermission {
        let (tx, rx) = std::sync::mpsc::channel();
        let handler = RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        unsafe {
            let media = NSString::from_str("soun");
            let () = msg_send![class!(AVCaptureDevice),
                requestAccessForMediaType: &*media,
                completionHandler: &*handler];
        }
        let _ = rx.recv();
        authorization_status()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffer_caps_and_tracks_base() {
        let mut buffer = AudioBuffer::default();
        buffer.push(&vec![1.0; MAX_BUFFER_SAMPLES]);
        buffer.push(&[2.0; 100]);
        assert_eq!(buffer.samples.len(), MAX_BUFFER_SAMPLES);
        assert_eq!(buffer.base, 100);
        let snap = buffer.tail(50);
        assert_eq!(snap.base, 100 + MAX_BUFFER_SAMPLES as u64 - 50);
        assert_eq!(snap.samples.len(), 50);
    }
}
