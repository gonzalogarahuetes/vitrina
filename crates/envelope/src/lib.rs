//! Vitrina encryption envelope.
//!
//! Header layout: encryption spec §3.1. Derived quantities and byte ranges:
//! §3.2, §3.3. Reader validation: §8. The format is permanent — see §0.

mod aead;
mod album_wrap;
mod blob;
mod chunk;
mod envelope;
mod header;
mod ids;
mod invite_wrap;
mod keys;
mod owner_wrap;
#[cfg(test)]
pub(crate) mod test_fixtures;
// Reads spec/vectors/ from disk, so it has no wasm32 counterpart.
#[cfg(all(test, not(target_arch = "wasm32")))]
mod vectors;
mod wrap;

pub use album_wrap::{
    AlbumWrapError, MasterWrappedKey, unwrap_album_key_with_master, wrap_album_key_with_master,
};
pub use blob::{
    BlobError, decrypt_album_title, decrypt_recipient_label, encrypt_album_title,
    encrypt_recipient_label,
};
pub use envelope::{
    CHUNK_SIZE, EnvelopeError, decrypt_asset, decrypt_meta, decrypt_thumb, encrypt_asset,
    encrypt_meta, encrypt_thumb,
};
pub use header::{HeaderError, LayoutError};
pub use ids::{AlbumId, AssetId, RecipientId, Salt, WrongLength};
pub use invite_wrap::{
    InviteWrapError, InviteWrappedKey, unwrap_album_key_with_invite, wrap_album_key_for_invite,
};
pub use keys::{AlbumKey, InviteKey, LoginProof, MasterKey, OwnerKek};
pub use owner_wrap::{
    OwnerWrapError, WrappedMaster, derive_owner_credential, unwrap_master_key, wrap_master_key,
};
pub use wrap::{
    InvalidParams, WrapError, WrapParams, WrappedKey, normalize_passphrase, unwrap_album_key,
    wrap_album_key,
};
