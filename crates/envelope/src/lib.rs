//! Vitrina encryption envelope.
//!
//! Header layout: encryption spec §3.1. Derived quantities and byte ranges:
//! §3.2, §3.3. Reader validation: §8. The format is permanent — see §0.

mod aead;
mod chunk;
mod envelope;
mod header;
mod ids;
mod keys;
#[cfg(test)]
pub(crate) mod test_fixtures;
// Reads spec/vectors/ from disk, so it has no wasm32 counterpart.
#[cfg(all(test, not(target_arch = "wasm32")))]
mod vectors;
mod wrap;

pub use envelope::{
    CHUNK_SIZE, EnvelopeError, decrypt_asset, decrypt_meta, decrypt_thumb, encrypt_asset,
    encrypt_meta, encrypt_thumb,
};
pub use header::{HeaderError, LayoutError};
pub use ids::{AssetId, RecipientId, Salt, WrongLength};
pub use keys::AlbumKey;
pub use wrap::{WrapError, WrapParams, WrappedKey, unwrap_album_key, wrap_album_key};
