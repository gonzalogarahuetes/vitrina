use crate::{WrongLength, aead::AeadError, ids::AlbumId};

#[derive(Debug, PartialEq)]
pub enum WrapAlbumError {
    AuthenticationFailed,
    UnexpectedWrappedLength,
    RandomnessUnavailable,
    UnexpectedKeyLength,
}

impl From<AeadError> for WrapAlbumError {
    /// Exhaustive on purpose: if `AeadError` gains a variant that isn't an
    /// authentication failure, this must fail to compile.
    fn from(e: AeadError) -> Self {
        match e {
            AeadError::AuthenticationFailed => WrapAlbumError::AuthenticationFailed,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MasterWrappedKey {
    /// `K_album` (32) plus the Poly1305 tag (16) — §2; the same arithmetic as §6.2's wrap.
    pub wrapped: [u8; 48],
    pub wrap_nonce: [u8; 24],
    // kdf_salt is missing on purpose here: there is no KDF here at all. K_master is given, not derived, so there's nothing to salt.
}

impl MasterWrappedKey {
    pub const WRAPPED_LEN: usize = 48;
    pub const WRAP_NONCE_LEN: usize = 24;

    pub fn try_from_parts(
        wrapped: &[u8],
        wrap_nonce: &[u8],
    ) -> Result<MasterWrappedKey, WrongLength> {
        let wrapped_bytes: [u8; Self::WRAPPED_LEN] =
            wrapped.try_into().map_err(|_| WrongLength {
                expected: Self::WRAPPED_LEN,
                got: wrapped.len(),
            })?;
        let wrap_nonce_bytes: [u8; Self::WRAP_NONCE_LEN] =
            wrap_nonce.try_into().map_err(|_| WrongLength {
                expected: Self::WRAP_NONCE_LEN,
                got: wrap_nonce.len(),
            })?;
        Ok(MasterWrappedKey {
            wrapped: wrapped_bytes,
            wrap_nonce: wrap_nonce_bytes,
        })
    }
}

pub(crate) const ALBUM_WRAP_AAD_LABEL: &[u8; 21] = b"vitrina-album-wrap-v1";

pub(crate) fn album_wrap_aad(album_id: &AlbumId) -> [u8; 37] {
    let mut bytes_aad: [u8; 37] = [0u8; 37];

    bytes_aad[..21].copy_from_slice(ALBUM_WRAP_AAD_LABEL);
    bytes_aad[21..].copy_from_slice(album_id.as_bytes());

    bytes_aad
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        album_wrap::ALBUM_WRAP_AAD_LABEL,
        test_fixtures::{ALBUM_ID, ALBUM_WRAP_AAD},
    };

    #[test]
    fn label_equals_literal_bytes() {
        assert_eq!(ALBUM_WRAP_AAD_LABEL, b"vitrina-album-wrap-v1");
    }

    #[test]
    fn concatenated_album_aad_matches_hex_literal() {
        assert_eq!(
            album_wrap_aad(&AlbumId::from_bytes(ALBUM_ID)),
            ALBUM_WRAP_AAD
        );
    }
}
