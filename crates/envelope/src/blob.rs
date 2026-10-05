use chacha20poly1305::XChaCha20Poly1305;

use crate::{
    AlbumId, AlbumKey, RecipientId,
    aead::{AeadError, aead_decrypt, aead_encrypt},
    keys::cipher_for,
};

const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
const MIN_BLOB_LEN: usize = NONCE_LEN + 1 + TAG_LEN;

#[derive(Debug, PartialEq)]
pub enum BlobError {
    AuthenticationFailed,
    TooShort { got: usize, min: usize },
    EmptyPlaintext,
    InvalidUtf8,
    RandomnessUnavailable,
}

impl From<AeadError> for BlobError {
    /// Exhaustive on purpose: if `AeadError` gains a variant that isn't an
    /// authentication failure, this must fail to compile.
    fn from(e: AeadError) -> Self {
        match e {
            AeadError::AuthenticationFailed => BlobError::AuthenticationFailed,
        }
    }
}

pub(crate) fn encrypt_cipher_with_nonce(
    cipher: &XChaCha20Poly1305,
    nonce: &[u8; NONCE_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, BlobError> {
    if plaintext.is_empty() {
        return Err(BlobError::EmptyPlaintext);
    }

    let mut result: Vec<u8> = Vec::with_capacity(NONCE_LEN + plaintext.len() + TAG_LEN);

    let ciphertext = aead_encrypt(cipher, nonce, &[], plaintext);

    result.extend_from_slice(nonce);
    result.extend_from_slice(&ciphertext);
    Ok(result)
}

fn decrypt_cipher(cipher: &XChaCha20Poly1305, blob: &[u8]) -> Result<String, BlobError> {
    if blob.len() < MIN_BLOB_LEN {
        return Err(BlobError::TooShort {
            got: blob.len(),
            min: MIN_BLOB_LEN,
        });
    }

    let (nonce, ciphertext) = blob.split_at(NONCE_LEN);

    let nonce: &[u8; NONCE_LEN] = nonce.try_into().expect("split_at(24) yields 24 bytes");

    let plaintext = aead_decrypt(cipher, nonce, &[], ciphertext)?;

    String::from_utf8(plaintext).map_err(|_| BlobError::InvalidUtf8)
}

pub fn decrypt_recipient_label(
    album_key: &AlbumKey,
    recipient_id: &RecipientId,
    blob: &[u8],
) -> Result<String, BlobError> {
    let k_label = album_key.derive_label(recipient_id);
    let cipher_label_key = cipher_for(k_label.expose_bytes());

    decrypt_cipher(&cipher_label_key, blob)
}

pub fn decrypt_album_title(
    album_key: &AlbumKey,
    album_id: &AlbumId,
    blob: &[u8],
) -> Result<String, BlobError> {
    let k_title = album_key.derive_title(album_id);
    let cipher_title_key = cipher_for(k_title.expose_bytes());

    decrypt_cipher(&cipher_title_key, blob)
}

pub fn encrypt_album_title(
    album_key: &AlbumKey,
    album_id: &AlbumId,
    plaintext: &str,
) -> Result<Vec<u8>, BlobError> {
    let k_title = album_key.derive_title(album_id);
    let cipher_title_key = cipher_for(k_title.expose_bytes());
    let mut nonce = [0u8; NONCE_LEN];

    getrandom::fill(&mut nonce).map_err(|_| BlobError::RandomnessUnavailable)?;

    encrypt_cipher_with_nonce(&cipher_title_key, &nonce, plaintext.as_bytes())
}

pub fn encrypt_recipient_label(
    album_key: &AlbumKey,
    recipient_id: &RecipientId,
    plaintext: &str,
) -> Result<Vec<u8>, BlobError> {
    let k_label = album_key.derive_label(recipient_id);
    let cipher_label_key = cipher_for(k_label.expose_bytes());
    let mut nonce = [0u8; NONCE_LEN];

    getrandom::fill(&mut nonce).map_err(|_| BlobError::RandomnessUnavailable)?;

    encrypt_cipher_with_nonce(&cipher_label_key, &nonce, plaintext.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::{ALBUM_ID, K_ALBUM, RECIPIENT_ID, album_key};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    /// One byte different from `ALBUM_ID` — a9397813-939b-4e91-9f1e-9b054d86fb7e.
    const OTHER_ALBUM_ID: [u8; 16] = [
        0xa9, 0x39, 0x78, 0x13, 0x93, 0x9b, 0x4e, 0x91, 0x9f, 0x1e, 0x9b, 0x05, 0x4d, 0x86, 0xfb,
        0x7e,
    ];

    /// One byte different from `RECIPIENT_ID` — 3f2a91c7-8b4e-4d16-9f05-c2a7d81e6b35.
    const OTHER_RECIPIENT_ID: [u8; 16] = [
        0x3f, 0x2a, 0x91, 0xc7, 0x8b, 0x4e, 0x4d, 0x16, 0x9f, 0x05, 0xc2, 0xa7, 0xd8, 0x1e, 0x6b,
        0x35,
    ];

    /// Deliberately not WRAP_NONCE, ALBUM_WRAP_NONCE or OWNER_WRAP_NONCE — a
    /// fixture shared between constructions lets a test pass with the wrong one.
    #[rustfmt::skip]
    const BLOB_NONCE: [u8; NONCE_LEN] = [
        0x5a, 0x0e, 0xd3, 0x71, 0x9c, 0x24, 0xb8, 0x46, 0xe1, 0x3f, 0x87, 0x02,
        0xcd, 0x69, 0x15, 0xfa, 0x30, 0xa4, 0x7b, 0xd8, 0x52, 0x9e, 0x0c, 0xe7,
    ];

    const TITLE: &str = "Sofía's first birthday";
    const LABEL: &str = "María";

    fn title_cipher(album_id: [u8; 16]) -> XChaCha20Poly1305 {
        cipher_for(
            album_key()
                .derive_title(&AlbumId::from_bytes(album_id))
                .expose_bytes(),
        )
    }

    fn label_cipher(recipient_id: [u8; 16]) -> XChaCha20Poly1305 {
        cipher_for(
            album_key()
                .derive_label(&RecipientId::from_bytes(recipient_id))
                .expose_bytes(),
        )
    }

    fn title_blob() -> Vec<u8> {
        encrypt_album_title(&album_key(), &AlbumId::from_bytes(ALBUM_ID), TITLE).unwrap()
    }

    fn label_blob() -> Vec<u8> {
        encrypt_recipient_label(&album_key(), &RecipientId::from_bytes(RECIPIENT_ID), LABEL)
            .unwrap()
    }

    fn decrypt_title(blob: &[u8]) -> Result<String, BlobError> {
        decrypt_album_title(&album_key(), &AlbumId::from_bytes(ALBUM_ID), blob)
    }

    fn decrypt_label(blob: &[u8]) -> Result<String, BlobError> {
        decrypt_recipient_label(&album_key(), &RecipientId::from_bytes(RECIPIENT_ID), blob)
    }

    // Round Trip Tests
    // ----------------------------------------------------
    #[test]
    fn round_trips_album_title() {
        assert_eq!(decrypt_title(&title_blob()).unwrap(), TITLE);
    }

    #[test]
    fn round_trips_recipient_label() {
        assert_eq!(decrypt_label(&label_blob()).unwrap(), LABEL);
    }

    /// Guards the two round trips above: they only test multibyte UTF-8 if
    /// the fixtures contain it.
    #[test]
    fn title_and_label_fixtures_are_multibyte() {
        assert!(TITLE.len() > TITLE.chars().count());
        assert!(LABEL.len() > LABEL.chars().count());
    }

    /// A 1-byte title produces exactly the floor — encrypt's smallest output and
    /// decrypt's smallest input are the same number, or one of them is wrong.
    #[test]
    fn one_byte_title_round_trips_at_exactly_the_floor() {
        let blob = encrypt_album_title(&album_key(), &AlbumId::from_bytes(ALBUM_ID), "a").unwrap();
        assert_eq!(blob.len(), MIN_BLOB_LEN);
        assert_eq!(decrypt_title(&blob).unwrap(), "a");
    }

    /// The crate has no ceiling; the relay's 1024 bytes is policy (§2). If this
    /// fails, someone added a ceiling to the format.
    #[test]
    fn round_trips_above_the_relay_ceiling() {
        let long = "a".repeat(2000);
        let blob = encrypt_album_title(&album_key(), &AlbumId::from_bytes(ALBUM_ID), &long).unwrap();
        assert!(blob.len() > 1024);
        assert_eq!(decrypt_title(&blob).unwrap(), long);
    }

    // Layout Tests
    // ----------------------------------------------------
    #[test]
    fn blob_starts_with_the_nonce() {
        let blob =
            encrypt_cipher_with_nonce(&title_cipher(ALBUM_ID), &BLOB_NONCE, TITLE.as_bytes())
                .unwrap();
        assert_eq!(&blob[..NONCE_LEN], &BLOB_NONCE);
    }

    #[test]
    fn blob_length_is_nonce_plus_plaintext_plus_tag() {
        let blob =
            encrypt_cipher_with_nonce(&title_cipher(ALBUM_ID), &BLOB_NONCE, TITLE.as_bytes())
                .unwrap();
        assert_eq!(blob.len(), NONCE_LEN + TITLE.len() + TAG_LEN);
    }

    /// Ties the internal core to the public path: a blob the core made with the
    /// title key is one the public decrypt opens.
    #[test]
    fn fixed_nonce_blob_decrypts_through_public_api() {
        let blob =
            encrypt_cipher_with_nonce(&title_cipher(ALBUM_ID), &BLOB_NONCE, TITLE.as_bytes())
                .unwrap();
        assert_eq!(decrypt_title(&blob).unwrap(), TITLE);
    }

    // Nonce Tests
    // ----------------------------------------------------
    #[test]
    fn title_encryption_uses_a_fresh_nonce() {
        assert_ne!(title_blob()[..NONCE_LEN], title_blob()[..NONCE_LEN]);
    }

    #[test]
    fn label_encryption_uses_a_fresh_nonce() {
        assert_ne!(label_blob()[..NONCE_LEN], label_blob()[..NONCE_LEN]);
    }

    // Binding Tests — the key is the only binding, since the AAD is empty
    // ----------------------------------------------------
    /// Same nonce and plaintext on both sides, so a difference can only come from the id.
    #[test]
    fn title_ciphertext_depends_on_album_id() {
        let a = encrypt_cipher_with_nonce(&title_cipher(ALBUM_ID), &BLOB_NONCE, TITLE.as_bytes());
        let b = encrypt_cipher_with_nonce(
            &title_cipher(OTHER_ALBUM_ID),
            &BLOB_NONCE,
            TITLE.as_bytes(),
        );
        assert_ne!(a.unwrap(), b.unwrap());
    }

    #[test]
    fn label_ciphertext_depends_on_recipient_id() {
        let a =
            encrypt_cipher_with_nonce(&label_cipher(RECIPIENT_ID), &BLOB_NONCE, LABEL.as_bytes());
        let b = encrypt_cipher_with_nonce(
            &label_cipher(OTHER_RECIPIENT_ID),
            &BLOB_NONCE,
            LABEL.as_bytes(),
        );
        assert_ne!(a.unwrap(), b.unwrap());
    }

    #[test]
    fn rejects_title_moved_to_another_album() {
        assert_eq!(
            decrypt_album_title(
                &album_key(),
                &AlbumId::from_bytes(OTHER_ALBUM_ID),
                &title_blob()
            )
            .err(),
            Some(BlobError::AuthenticationFailed)
        );
    }

    #[test]
    fn rejects_label_moved_to_another_recipient() {
        assert_eq!(
            decrypt_recipient_label(
                &album_key(),
                &RecipientId::from_bytes(OTHER_RECIPIENT_ID),
                &label_blob()
            )
            .err(),
            Some(BlobError::AuthenticationFailed)
        );
    }

    #[test]
    fn rejects_title_under_another_album_key() {
        let mut other = K_ALBUM;
        other[0] ^= 1;
        assert_eq!(
            decrypt_album_title(
                &AlbumKey::from_bytes(other),
                &AlbumId::from_bytes(ALBUM_ID),
                &title_blob()
            )
            .err(),
            Some(BlobError::AuthenticationFailed)
        );
    }

    #[test]
    fn rejects_label_under_another_album_key() {
        let mut other = K_ALBUM;
        other[0] ^= 1;
        assert_eq!(
            decrypt_recipient_label(
                &AlbumKey::from_bytes(other),
                &RecipientId::from_bytes(RECIPIENT_ID),
                &label_blob()
            )
            .err(),
            Some(BlobError::AuthenticationFailed)
        );
    }

    /// The derivation must actually happen. Encrypting under raw K_album
    /// round-trips perfectly and only this test or a vector would notice.
    #[test]
    fn title_is_not_encrypted_under_raw_album_key() {
        let raw = cipher_for(album_key().expose_bytes());
        assert_eq!(
            decrypt_cipher(&raw, &title_blob()).err(),
            Some(BlobError::AuthenticationFailed)
        );
    }

    #[test]
    fn label_is_not_encrypted_under_raw_album_key() {
        let raw = cipher_for(album_key().expose_bytes());
        assert_eq!(
            decrypt_cipher(&raw, &label_blob()).err(),
            Some(BlobError::AuthenticationFailed)
        );
    }

    /// Same 16 id bytes on both sides, so only the domain string separates them.
    #[test]
    fn label_blob_does_not_decrypt_as_title() {
        let blob =
            encrypt_recipient_label(&album_key(), &RecipientId::from_bytes(ALBUM_ID), LABEL)
                .unwrap();
        assert_eq!(
            decrypt_title(&blob).err(),
            Some(BlobError::AuthenticationFailed)
        );
    }

    #[test]
    fn title_blob_does_not_decrypt_as_label() {
        let blob =
            encrypt_album_title(&album_key(), &AlbumId::from_bytes(RECIPIENT_ID), TITLE).unwrap();
        assert_eq!(
            decrypt_label(&blob).err(),
            Some(BlobError::AuthenticationFailed)
        );
    }

    // Tamper Tests
    // ----------------------------------------------------
    #[test]
    fn rejects_flipped_byte_in_each_region() {
        let blob = title_blob();
        // nonce, first ciphertext byte, last byte of the tag
        for i in [0, NONCE_LEN, blob.len() - 1] {
            let mut tampered = blob.clone();
            tampered[i] ^= 1;
            assert_eq!(
                decrypt_title(&tampered).err(),
                Some(BlobError::AuthenticationFailed),
                "flipped byte {i}"
            );
        }
    }

    #[test]
    fn rejects_truncated_blob_above_the_floor() {
        let blob = title_blob();
        assert_eq!(
            decrypt_title(&blob[..blob.len() - 1]).err(),
            Some(BlobError::AuthenticationFailed)
        );
    }

    // Floor Tests
    // ----------------------------------------------------
    #[test]
    fn floor_is_nonce_plus_one_byte_plus_tag() {
        assert_eq!(MIN_BLOB_LEN, 41);
    }

    #[test]
    fn rejects_blobs_below_the_floor_as_too_short() {
        for len in [0, NONCE_LEN, MIN_BLOB_LEN - 1] {
            assert_eq!(
                decrypt_title(&vec![0u8; len]).err(),
                Some(BlobError::TooShort {
                    got: len,
                    min: MIN_BLOB_LEN
                }),
                "length {len}"
            );
        }
    }

    /// The pair to the test above. Without it, a floor check of `<= 41` or
    /// `< 42` would pass every TooShort assertion and reject valid 1-byte titles.
    #[test]
    fn garbage_blob_at_the_floor_reaches_authentication() {
        assert_eq!(
            decrypt_title(&[0u8; MIN_BLOB_LEN]).err(),
            Some(BlobError::AuthenticationFailed)
        );
    }

    // Plaintext Validation Tests
    // ----------------------------------------------------
    #[test]
    fn rejects_empty_title() {
        assert_eq!(
            encrypt_album_title(&album_key(), &AlbumId::from_bytes(ALBUM_ID), "").err(),
            Some(BlobError::EmptyPlaintext)
        );
    }

    #[test]
    fn rejects_empty_label() {
        assert_eq!(
            encrypt_recipient_label(&album_key(), &RecipientId::from_bytes(RECIPIENT_ID), "")
                .err(),
            Some(BlobError::EmptyPlaintext)
        );
    }

    /// Authenticates, isn't UTF-8: a broken writer, not tampering. Only
    /// reachable through the core, since the public encrypt takes &str.
    #[test]
    fn authenticated_non_utf8_is_invalid_utf8_not_authentication_failed() {
        let blob = encrypt_cipher_with_nonce(&title_cipher(ALBUM_ID), &BLOB_NONCE, &[0xff])
            .unwrap();
        assert_eq!(decrypt_title(&blob).err(), Some(BlobError::InvalidUtf8));
    }
}
