//! Vitrina encryption envelope.
//!
//! Header layout: encryption spec §3.1. Derived quantities and byte ranges:
//! §3.2, §3.3. Reader validation: §8. The format is permanent — see §0.

mod chunk;
mod envelope;
mod header;
mod keys;
#[cfg(test)]
pub(crate) mod test_fixtures;

pub use envelope::{
    CHUNK_SIZE, EnvelopeError, decrypt_asset, decrypt_meta, decrypt_thumb, encrypt_asset,
    encrypt_meta, encrypt_thumb,
};
pub use header::{HeaderError, LayoutError};
pub use keys::AlbumKey;
