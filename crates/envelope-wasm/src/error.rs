//! Every failure crosses the boundary as a JavaScript `Error` named
//! `EnvelopeError` with a `code` string and, where useful, structured fields.
//! Messages carry lengths, offsets and parameter names — never key material (§2.2).

use js_sys::{Error, Reflect};
use vitrina_envelope::{EnvelopeError, HeaderError, LayoutError, WrapError, WrongLength};
use wasm_bindgen::JsValue;

pub(crate) struct Failure {
    code: &'static str,
    message: String,
    fields: Vec<(&'static str, JsValue)>,
}

impl Failure {
    fn new(code: &'static str, message: impl Into<String>) -> Failure {
        Failure {
            code,
            message: message.into(),
            fields: Vec::new(),
        }
    }

    fn with(mut self, key: &'static str, value: impl Into<JsValue>) -> Failure {
        self.fields.push((key, value.into()));
        self
    }
}

impl From<Failure> for JsValue {
    fn from(f: Failure) -> JsValue {
        let err = Error::new(&f.message);
        err.set_name("EnvelopeError");
        let target: &JsValue = err.as_ref();
        // Reflect::set only fails on frozen objects; a fresh Error is not one.
        let _ = Reflect::set(target, &"code".into(), &f.code.into());
        for (key, value) in f.fields {
            let _ = Reflect::set(target, &key.into(), &value);
        }
        err.into()
    }
}

/// The crate computes `expected` and `got`; only the binding knows the
/// JavaScript parameter name.
pub(crate) fn wrong_length(param: &'static str, e: WrongLength) -> Failure {
    Failure::new(
        "WrongLength",
        format!("{param}: expected {} bytes, got {}", e.expected, e.got),
    )
    .with("param", param)
    .with("expected", e.expected as f64)
    .with("got", e.got as f64)
}

impl From<EnvelopeError> for Failure {
    fn from(e: EnvelopeError) -> Failure {
        match e {
            EnvelopeError::PlaintextLengthMismatch { expected, got } => Failure::new(
                "PlaintextLengthMismatch",
                format!("plaintext length mismatch: expected {expected} bytes, got {got}"),
            )
            .with("expected", expected as f64)
            .with("got", got as f64),
            EnvelopeError::ObjectTooShort { expected, got } => Failure::new(
                "ObjectTooShort",
                format!("object too short: expected {expected} bytes, got {got}"),
            )
            .with("expected", expected as f64)
            .with("got", got as f64),
            EnvelopeError::TrailingBytes { expected, got } => Failure::new(
                "TrailingBytes",
                format!("object has trailing bytes: expected {expected} bytes, got {got}"),
            )
            .with("expected", expected as f64)
            .with("got", got as f64),
            EnvelopeError::Header(h) => header(h),
            EnvelopeError::Layout(l) => layout(l),
            EnvelopeError::AuthenticationFailed => {
                Failure::new("AuthenticationFailed", "authentication failed")
            }
            EnvelopeError::RandomnessUnavailable => {
                Failure::new("RandomnessUnavailable", "no CSPRNG available")
            }
        }
    }
}

/// §8: a reader MUST refuse and surface a clear error. `reason` names the row.
fn header(h: HeaderError) -> Failure {
    let base = |reason: &'static str, message: String| {
        Failure::new("Header", message).with("reason", reason)
    };
    match h {
        HeaderError::BadMagic => base("BadMagic", "not a Vitrina envelope: bad magic".into()),
        HeaderError::WrongVersion(v) => {
            base("WrongVersion", format!("unsupported envelope version {v}")).with("version", v)
        }
        HeaderError::WrongCipher(c) => {
            base("WrongCipher", format!("unsupported cipher {c}")).with("cipher", c)
        }
        HeaderError::ReservedNotZero { offset } => base(
            "ReservedNotZero",
            format!("reserved byte at offset {offset} is not zero"),
        )
        .with("offset", offset as f64),
        HeaderError::PaddingNotZero { offset } => base(
            "PaddingNotZero",
            format!("padding byte at offset {offset} is not zero"),
        )
        .with("offset", offset as f64),
        HeaderError::PlaintextLengthZero => {
            base("PlaintextLengthZero", "plaintext_length is zero".into())
        }
        HeaderError::ChunkSizeZero => base("ChunkSizeZero", "chunk_size is zero".into()),
        HeaderError::TooShort { expected, got } => base(
            "TooShort",
            format!("header too short: expected {expected} bytes, got {got}"),
        )
        .with("expected", expected as f64)
        .with("got", got as f64),
    }
}

fn layout(l: LayoutError) -> Failure {
    let base = |reason: &'static str, message: String| {
        Failure::new("Layout", message).with("reason", reason)
    };
    match l {
        LayoutError::SizeOverflow => base("SizeOverflow", "object size overflows 64 bits".into()),
        LayoutError::ChunkIndexOutOfRange { index, chunk_count } => base(
            "ChunkIndexOutOfRange",
            format!("chunk index {index} out of range for {chunk_count} chunks"),
        )
        .with("index", index as f64)
        .with("chunkCount", chunk_count as f64),
    }
}

impl From<WrapError> for Failure {
    fn from(e: WrapError) -> Failure {
        match e {
            WrapError::InvalidParams {
                t_cost,
                p_cost,
                m_cost,
            } => Failure::new(
                "InvalidParams",
                format!(
                    "Argon2id rejected the parameters: mCostKib={m_cost}, tCost={t_cost}, pCost={p_cost}"
                ),
            )
            .with("mCostKib", m_cost)
            .with("tCost", t_cost)
            .with("pCost", p_cost),
            WrapError::HashingFailed => Failure::new("HashingFailed", "Argon2id hashing failed"),
            WrapError::UnexpectedWrappedLength => Failure::new(
                "UnexpectedWrappedLength",
                "wrapped key has an unexpected length",
            ),
            WrapError::RandomnessUnavailable => {
                Failure::new("RandomnessUnavailable", "no CSPRNG available")
            }
            WrapError::UnexpectedKeyLength => {
                Failure::new("UnexpectedKeyLength", "unwrapped key has an unexpected length")
            }
            WrapError::AuthenticationFailed => {
                Failure::new("AuthenticationFailed", "unwrap failed: authentication failed")
            }
            WrapError::EmptyPassphrase => Failure::new(
                "EmptyPassphrase",
                "passphrase is empty after normalisation",
            ),
        }
    }
}
