use crate::WrongLength;

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
