use zeroize::Zeroizing;

use crate::{
    AlbumKey, WrongLength,
    aead::{AeadError, aead_decrypt, aead_encrypt},
    ids::AlbumId,
    keys::{MasterKey, cipher_for},
};

#[derive(Debug, PartialEq)]
pub enum AlbumWrapError {
    AuthenticationFailed,
    UnexpectedWrappedLength,
    RandomnessUnavailable,
    UnexpectedKeyLength,
}

impl From<AeadError> for AlbumWrapError {
    /// Exhaustive on purpose: if `AeadError` gains a variant that isn't an
    /// authentication failure, this must fail to compile.
    fn from(e: AeadError) -> Self {
        match e {
            AeadError::AuthenticationFailed => AlbumWrapError::AuthenticationFailed,
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

pub(crate) fn wrap_with_nonce(
    album_key: &AlbumKey,
    master_key: &MasterKey,
    album_id: &AlbumId,
    wrap_nonce: &[u8; 24],
) -> Result<[u8; 48], AlbumWrapError> {
    let cipher_master_key = cipher_for(master_key.expose_bytes());
    let aad: [u8; 37] = album_wrap_aad(album_id);

    aead_encrypt(
        &cipher_master_key,
        wrap_nonce,
        &aad,
        album_key.expose_bytes(),
    )
    .try_into()
    .map_err(|_| AlbumWrapError::UnexpectedWrappedLength)
}

pub fn wrap_album_key_with_master(
    album_key: &AlbumKey,
    master_key: &MasterKey,
    album_id: &AlbumId,
) -> Result<MasterWrappedKey, AlbumWrapError> {
    let mut wrap_nonce = [0u8; 24];

    getrandom::fill(&mut wrap_nonce).map_err(|_| AlbumWrapError::RandomnessUnavailable)?;

    let wrapped: [u8; 48] = wrap_with_nonce(album_key, master_key, album_id, &wrap_nonce)?;
    Ok(MasterWrappedKey {
        wrapped,
        wrap_nonce,
    })
}

pub fn unwrap_album_key_with_master(
    wrapped: &MasterWrappedKey,
    master_key: &MasterKey,
    album_id: &AlbumId,
) -> Result<AlbumKey, AlbumWrapError> {
    let aad: [u8; 37] = album_wrap_aad(album_id);
    let cipher_master_key = cipher_for(master_key.expose_bytes());

    let plaintext: Zeroizing<Vec<u8>> = Zeroizing::new(aead_decrypt(
        &cipher_master_key,
        &wrapped.wrap_nonce,
        &aad,
        &wrapped.wrapped,
    )?);
    let bytes: [u8; 32] = plaintext[..]
        .try_into()
        .map_err(|_| AlbumWrapError::UnexpectedKeyLength)?;

    Ok(AlbumKey::from_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::{
        ALBUM_ID, ALBUM_WRAP_AAD, ALBUM_WRAP_NONCE, album_key, hex, master_key,
    };
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn wrapped_of_valid_length() -> [u8; MasterWrappedKey::WRAPPED_LEN] {
        std::array::from_fn(|i| i as u8)
    }

    /// One byte different from `ALBUM_ID` — a9397813-939b-4e91-9f1e-9b054d86fb7f.
    /// Still a valid UUIDv4: the version nibble and variant bits are untouched.
    const OTHER_ALBUM_ID: [u8; 16] = [
        0xa9, 0x39, 0x78, 0x13, 0x93, 0x9b, 0x4e, 0x91, 0x9f, 0x1e, 0x9b, 0x05, 0x4d, 0x86, 0xfb,
        0x7e,
    ];

    /// A second master key, for the negative unwrap. Distinct from K_MASTER,
    /// K_ALBUM and every other 32-byte fixture, so a test that unwraps with the
    /// wrong key fails because the key is wrong and not by coincidence.
    #[rustfmt::skip]
    const OTHER_K_MASTER: [u8; 32] = [
        0x73, 0x95, 0x01, 0x85, 0x4c, 0x7f, 0xb4, 0x06, 0xc9, 0xb0, 0xfd, 0xc4, 0xc0, 0x90, 0x98, 0xca,
        0xb1, 0x0b, 0x21, 0x82, 0x51, 0x78, 0x0d, 0x30, 0x67, 0x9a, 0xc1, 0x8b, 0x1c, 0x95, 0xc1, 0x70,
    ];

    /// Self-generated — see §9.2 on what that can and cannot
    /// catch. It pins the composition so a later refactor cannot silently
    /// change the bytes.
    const KNOWN_ANSWER_WRAPPED: &str = "940643c00f8692b602146b14b1dc7c70245230628ef840b1342c97e0b272c718df385349d9ce16c4953eaf6ad50a2c11";

    fn wrapped_for(album_id: [u8; 16]) -> [u8; 48] {
        wrap_with_nonce(
            &album_key(),
            &master_key(),
            &AlbumId::from_bytes(album_id),
            &ALBUM_WRAP_NONCE,
        )
        .unwrap()
    }

    // Album Wrap AAD Tests
    // ----------------------------------------------------

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

    // Wrap With Nonce Tests
    // ----------------------------------------------------
    #[test]
    fn matches_known_answer_wrapped() {
        assert_eq!(hex(&wrapped_for(ALBUM_ID)), KNOWN_ANSWER_WRAPPED);
    }

    #[test]
    fn creates_different_answer_wrapped_with_different_album_ids() {
        assert_ne!(&wrapped_for(ALBUM_ID), &wrapped_for(OTHER_ALBUM_ID));
    }

    // Wrap Album Key With Master Tests
    // ----------------------------------------------------
    #[test]
    fn wraps_and_unwraps_correctly() {
        let wrapped =
            wrap_album_key_with_master(&album_key(), &master_key(), &AlbumId::from_bytes(ALBUM_ID))
                .unwrap();

        let unwrapped =
            unwrap_album_key_with_master(&wrapped, &master_key(), &AlbumId::from_bytes(ALBUM_ID))
                .unwrap();

        assert_eq!(album_key().expose_bytes(), unwrapped.expose_bytes())
    }

    #[test]
    fn generates_fresh_nonce_every_time() {
        let wrapped_one =
            wrap_album_key_with_master(&album_key(), &master_key(), &AlbumId::from_bytes(ALBUM_ID))
                .unwrap();

        let wrapped_two =
            wrap_album_key_with_master(&album_key(), &master_key(), &AlbumId::from_bytes(ALBUM_ID))
                .unwrap();
        assert_ne!(wrapped_one.wrap_nonce, wrapped_two.wrap_nonce);
    }

    #[test]
    fn rejects_unwrap_with_wrong_album_id() {
        let wrapped =
            wrap_album_key_with_master(&album_key(), &master_key(), &AlbumId::from_bytes(ALBUM_ID))
                .unwrap();

        assert_eq!(
            unwrap_album_key_with_master(
                &wrapped,
                &master_key(),
                &AlbumId::from_bytes(OTHER_ALBUM_ID)
            )
            .err(),
            Some(AlbumWrapError::AuthenticationFailed)
        );
    }

    #[test]
    fn rejects_unwrap_with_wrong_master_key() {
        let wrapped =
            wrap_album_key_with_master(&album_key(), &master_key(), &AlbumId::from_bytes(ALBUM_ID))
                .unwrap();

        assert_eq!(
            unwrap_album_key_with_master(
                &wrapped,
                &MasterKey::from_bytes(OTHER_K_MASTER),
                &AlbumId::from_bytes(ALBUM_ID)
            )
            .err(),
            Some(AlbumWrapError::AuthenticationFailed)
        );
    }

    #[test]
    fn rejects_unwrap_with_flipped_wrapped() {
        let wrapped =
            wrap_album_key_with_master(&album_key(), &master_key(), &AlbumId::from_bytes(ALBUM_ID))
                .unwrap();

        let mut tampered = wrapped.clone();
        tampered.wrapped[0] ^= 1;

        assert_eq!(
            unwrap_album_key_with_master(&tampered, &master_key(), &AlbumId::from_bytes(ALBUM_ID))
                .err(),
            Some(AlbumWrapError::AuthenticationFailed)
        );
    }
    #[test]
    fn rejects_unwrap_with_flipped_nonce() {
        let wrapped =
            wrap_album_key_with_master(&album_key(), &master_key(), &AlbumId::from_bytes(ALBUM_ID))
                .unwrap();

        let mut tampered = wrapped.clone();
        tampered.wrap_nonce[0] ^= 1;

        assert_eq!(
            unwrap_album_key_with_master(&tampered, &master_key(), &AlbumId::from_bytes(ALBUM_ID))
                .err(),
            Some(AlbumWrapError::AuthenticationFailed)
        );
    }

    // MasterWrappedKey Length Tests
    // ----------------------------------------------------
    #[test]
    fn builds_master_wrapped_key_from_valid_parts() {
        let bytes: [u8; MasterWrappedKey::WRAPPED_LEN] = std::array::from_fn(|i| i as u8);
        assert_eq!(
            MasterWrappedKey::try_from_parts(&bytes, &ALBUM_WRAP_NONCE).unwrap(),
            MasterWrappedKey {
                wrapped: bytes,
                wrap_nonce: ALBUM_WRAP_NONCE,
            }
        );
    }

    #[test]
    fn rejects_short_wrapped() {
        let bytes: [u8; 40] = std::array::from_fn(|i| i as u8);
        assert_eq!(
            MasterWrappedKey::try_from_parts(&bytes, &ALBUM_WRAP_NONCE).err(),
            Some(WrongLength {
                got: 40,
                expected: 48
            })
        );
    }

    #[test]
    fn rejects_long_wrapped() {
        let bytes: [u8; 50] = std::array::from_fn(|i| i as u8);
        assert_eq!(
            MasterWrappedKey::try_from_parts(&bytes, &ALBUM_WRAP_NONCE).err(),
            Some(WrongLength {
                got: 50,
                expected: 48
            })
        );
    }

    #[test]
    fn rejects_empty_wrapped() {
        assert_eq!(
            MasterWrappedKey::try_from_parts(&[], &ALBUM_WRAP_NONCE).err(),
            Some(WrongLength {
                got: 0,
                expected: 48
            })
        );
    }

    #[test]
    fn rejects_short_wrap_nonce() {
        let bytes: [u8; 20] = std::array::from_fn(|i| i as u8);
        assert_eq!(
            MasterWrappedKey::try_from_parts(&wrapped_of_valid_length(), &bytes,).err(),
            Some(WrongLength {
                got: 20,
                expected: 24
            })
        );
    }

    #[test]
    fn rejects_long_wrap_nonce() {
        let bytes: [u8; 50] = std::array::from_fn(|i| i as u8);
        assert_eq!(
            MasterWrappedKey::try_from_parts(&wrapped_of_valid_length(), &bytes).err(),
            Some(WrongLength {
                got: 50,
                expected: 24
            })
        );
    }

    #[test]
    fn rejects_empty_wrap_nonce() {
        assert_eq!(
            MasterWrappedKey::try_from_parts(&wrapped_of_valid_length(), &[]).err(),
            Some(WrongLength {
                got: 0,
                expected: 24
            })
        );
    }
}
