//! Pinned whisper.cpp GGML model catalog.
//!
//! URLs resolve to the ggerganov/whisper.cpp Hugging Face repo. `sha256` is the
//! LFS object id from the repo tree API — the file digest verified after every
//! download. All listed models are multilingual; English-only distilled
//! variants are intentionally absent.

pub struct ModelSpec {
    /// Stable identifier used by commands and settings.
    pub id: &'static str,
    /// File name inside the models directory and on the server.
    pub file: &'static str,
    /// Short user-facing label.
    pub label: &'static str,
    /// Rough speed/quality positioning for the picker.
    pub tier: &'static str,
    /// Expected download size, used for progress and resume checks.
    pub size_bytes: u64,
    /// SHA-256 of the file, lowercase hex.
    pub sha256: &'static str,
    /// Whether the model performs the translate-to-English task. Turbo was
    /// fine-tuned on transcription data only and silently emits the source
    /// language (ggerganov/whisper.cpp#2476).
    pub supports_translate: bool,
}

impl ModelSpec {
    pub fn url(&self) -> String {
        format!(
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}",
            self.file
        )
    }
}

pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "base",
        file: "ggml-base.bin",
        label: "Base",
        tier: "fast",
        size_bytes: 147_951_465,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        supports_translate: true,
    },
    ModelSpec {
        id: "small",
        file: "ggml-small.bin",
        label: "Small",
        tier: "balanced",
        size_bytes: 487_601_967,
        sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        supports_translate: true,
    },
    ModelSpec {
        id: "medium",
        file: "ggml-medium.bin",
        label: "Medium",
        tier: "quality",
        size_bytes: 1_533_763_059,
        sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
        supports_translate: true,
    },
    ModelSpec {
        id: "large-v3-turbo",
        file: "ggml-large-v3-turbo.bin",
        label: "Large v3 Turbo",
        tier: "quality",
        size_bytes: 1_624_555_275,
        sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
        supports_translate: false,
    },
];

pub fn find(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|model| model.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_pinned_and_unique() {
        let mut ids = std::collections::HashSet::new();
        for model in MODELS {
            assert!(ids.insert(model.id), "duplicate id {}", model.id);
            assert!(model.url().starts_with("https://huggingface.co/"));
            assert_eq!(model.sha256.len(), 64);
            // The digest compare is case-sensitive — pins must be lowercase.
            assert!(model
                .sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
            assert!(model.size_bytes > 0);
            assert!(!model.file.contains(".en."));
        }
    }

    #[test]
    fn find_resolves_known_ids() {
        assert!(find("small").is_some());
        assert!(find("large-v3-turbo").is_some());
        assert!(find("tiny").is_none());
    }
}
