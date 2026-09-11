use crate::aead::{AeadError, aead_encrypt};
use crate::keys::ChunkKey;
use crate::{aead::aead_decrypt, header::Header};

/// Encrypts one chunk with XChaCha20-Poly1305 (§1), returning
/// `plaintext.len() + 16` bytes: the ciphertext followed by its Poly1305 tag.
///
/// The nonce is §4's `base_nonce ‖ u64_le(i)`; the AAD is §5's
/// `header ‖ u64_le(i)`. Together they bind the chunk to this exact header at
/// this exact index, so decryption fails if either differs — see §5's table for
/// which header field defeats which attack.
///
/// Neither `i` nor `plaintext.len()` is checked here. Index range is
/// `chunk_range`'s job, and §3.2's requirement that every chunk but the last
/// holds exactly `chunk_size` bytes is enforced by the envelope writer (C.6),
/// which is the only caller that knows the whole plaintext.
pub(crate) fn encrypt_chunk<K: ChunkKey>(
    key: &K,
    header: &Header,
    i: u64,
    plaintext: &[u8],
) -> Vec<u8> {
    let nonce: [u8; 24] = header.nonce(i);
    let aad: [u8; 72] = header.aad(i);

    aead_encrypt(&key.cipher(), &nonce, &aad, plaintext)
}

impl From<AeadError> for ChunkError {
    fn from(e: AeadError) -> Self {
        match e {
            AeadError::AuthenticationFailed => ChunkError::AuthenticationFailed,
        }
    }
}

/// Returns `ChunkError::AuthenticationFailed` and no plaintext if the tag does
/// not verify. The error deliberately carries no detail: which part failed is
/// information an attacker submitting ciphertexts would use.
pub(crate) fn decrypt_chunk<K: ChunkKey>(
    key: &K,
    header: &Header,
    i: u64,
    ciphertext: &[u8],
) -> Result<Vec<u8>, ChunkError> {
    let nonce: [u8; 24] = header.nonce(i);
    let aad: [u8; 72] = header.aad(i);

    Ok(aead_decrypt(&key.cipher(), &nonce, &aad, ciphertext)?)
}

#[derive(Debug, PartialEq)]
pub(crate) enum ChunkError {
    AuthenticationFailed,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aead::aead_decrypt;
    use crate::keys::{AssetKey, ThumbKey};
    use crate::test_fixtures::{
        ASSET_ID, GOLDEN, PLAINTEXT, asset_key, header_with, hex, thumb_key,
    };
    #[cfg(not(target_arch = "wasm32"))]
    use proptest::prelude::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    // Round Trip Tests
    // -----------------------------------------------------
    #[test]
    fn different_index_gives_different_ciphertext() {
        let header: Header = header_with(64, 200);
        let k: AssetKey = asset_key();
        let ciphertext_on_zero: Vec<u8> = encrypt_chunk(&k, &header, 0, PLAINTEXT);
        let ciphertext_on_one: Vec<u8> = encrypt_chunk(&k, &header, 1, PLAINTEXT);
        assert_ne!(ciphertext_on_one, ciphertext_on_zero);
    }

    #[cfg(not(target_arch = "wasm32"))]
    proptest! {
        #[cfg(not(target_arch = "wasm32"))]
        #[test]
        fn chunk_round_trips(
            i in any::<u64>(),
            p in proptest::collection::vec(any::<u8>(), 1..=1024),
        ) {
            let h: Header = header_with(64, 200);
            let k: AssetKey = asset_key();

            let ct = encrypt_chunk(&k, &h, i, &p);
            prop_assert_eq!(ct.len(), p.len() + 16);
            prop_assert_eq!(decrypt_chunk(&k, &h, i, &ct).unwrap(), p);
        }
    }

    // §5 rows Tests
    // -----------------------------------------------------

    #[test]
    fn rejects_decrypt_with_different_i() {
        let header: Header = header_with(64, 200);
        let k: AssetKey = asset_key();

        let ciphertext: Vec<u8> = encrypt_chunk(&k, &header, 0, PLAINTEXT);
        assert_eq!(
            decrypt_chunk(&k, &header, 1, &ciphertext).unwrap_err(),
            ChunkError::AuthenticationFailed
        );
    }

    #[test]
    fn rejects_decrypt_with_different_plaintext_length() {
        let header: Header = header_with(64, 200);
        let header_2: Header = header_with(64, 180);
        let k: AssetKey = asset_key();

        let ciphertext: Vec<u8> = encrypt_chunk(&k, &header, 0, PLAINTEXT);
        assert_eq!(
            decrypt_chunk(&k, &header_2, 0, &ciphertext).unwrap_err(),
            ChunkError::AuthenticationFailed
        );
    }

    #[test]
    fn rejects_decrypt_with_different_asset_id() {
        let mut other: [u8; 16] = ASSET_ID;
        other[0] ^= 1;
        let k: AssetKey = asset_key();
        let ct: Vec<u8> = encrypt_chunk(&k, &Header::parse(&GOLDEN).unwrap(), 0, PLAINTEXT);

        let mut bytes: [u8; 64] = GOLDEN;
        bytes[36..52].copy_from_slice(&other);
        let spliced = Header::parse(&bytes).unwrap();

        assert_eq!(
            decrypt_chunk(&k, &spliced, 0, &ct).unwrap_err(),
            ChunkError::AuthenticationFailed
        );
    }

    #[test]
    fn rejects_decryption_on_version_downgrade() {
        // §5's version row cannot be exercised through `decrypt_chunk`: §8 makes
        // `parse` reject a bad version byte, so no `Header` with one can exist.
        // The AAD is the backstop against an attacker who bypasses the parser,
        // so the test bypasses it too.
        let key: AssetKey = asset_key();
        let header: Header = Header::parse(&GOLDEN).unwrap();
        let i: u64 = 0u64;

        let ciphertext: Vec<u8> = encrypt_chunk(&key, &header, i, PLAINTEXT);

        let mut tampered: [u8; 64] = GOLDEN;
        tampered[4] = 0x02;

        let mut bad_aad: [u8; 72] = [0u8; 72];
        bad_aad[0..64].copy_from_slice(&tampered);
        bad_aad[64..72].copy_from_slice(&i.to_le_bytes());

        assert_eq!(
            aead_decrypt(&key.cipher(), &header.nonce(i), &bad_aad, &ciphertext).unwrap_err(),
            AeadError::AuthenticationFailed
        );
    }

    // §9 Tampering Tests
    // -----------------------------------------------------

    #[test]
    fn rejects_tampered_ciphertext_body() {
        let header: Header = header_with(64, 200);
        let k: AssetKey = asset_key();

        let mut ct: Vec<u8> = encrypt_chunk(&k, &header, 1, PLAINTEXT);
        ct[0] ^= 1;
        assert_eq!(
            decrypt_chunk(&k, &header, 1, &ct).unwrap_err(),
            ChunkError::AuthenticationFailed
        );
    }

    #[test]
    fn rejects_forged_tag() {
        let header: Header = header_with(64, 200);
        let k: AssetKey = asset_key();

        let mut ct: Vec<u8> = encrypt_chunk(&k, &header, 1, PLAINTEXT);
        // the last 16 bytes are the tag, and a forged tag must not verify.
        let n: usize = ct.len();
        ct[n - 1] ^= 1;
        assert_eq!(
            decrypt_chunk(&k, &header, 1, &ct).unwrap_err(),
            ChunkError::AuthenticationFailed
        );
    }

    #[test]
    fn rejects_truncated_ciphertext() {
        let header: Header = header_with(64, 200);
        let k: AssetKey = asset_key();

        let mut ct: Vec<u8> = encrypt_chunk(&k, &header, 1, PLAINTEXT);
        ct.pop();
        assert_eq!(
            decrypt_chunk(&k, &header, 1, &ct).unwrap_err(),
            ChunkError::AuthenticationFailed
        );
    }

    #[test]
    // the input comes from an untrusted relay and a panic would be a denial of service
    fn rejects_ciphertext_shorter_than_tag() {
        let header: Header = header_with(64, 200);
        let k: AssetKey = asset_key();
        assert_eq!(
            decrypt_chunk(&k, &header, 0, &[0u8; 5]).unwrap_err(),
            ChunkError::AuthenticationFailed
        );
    }

    // -----------------------------------------------------
    // §9 Key Separation Test
    #[test]
    fn rejects_decrypt_with_sibling_key() {
        let header: Header = header_with(64, 200);
        let k: AssetKey = asset_key();
        let thumb_k: ThumbKey = thumb_key();

        let ciphertext: Vec<u8> = encrypt_chunk(&k, &header, 1, PLAINTEXT);
        assert_eq!(
            decrypt_chunk(&thumb_k, &header, 1, &ciphertext).unwrap_err(),
            ChunkError::AuthenticationFailed
        );
    }

    /// Self-generated, and sound because the draft-03 anchor above pins the
    /// primitive (§9.2). Pins the composition: that `encrypt_chunk` feeds
    /// `nonce(i)` and `aad(i)` for *this* `i`, which nothing else checks.
    const CHUNK_AT_INDEX_ZERO: &str = "c1ed6e84ec4be6c043a588754148f4b3a98b1a0a6c44cf7be9fa57b8e5c5330dd02545f8a84ac85aff1cec46c49064b0019d7f48855aadf83e4a96f4eadde13b7f3927af6855c6e07ab6e8ae8adede772522b1d8f8959333454f0ee14ed13b83a0fbe737d655cdb3be2bc229547cecf7341e8ee06492b18a409c4cbf847ad3699581fc25b16422ee4fadbf56230c61196ce90ada1ed00f10353536ad1719000a5c589f0f5a06f9391177bb7e8a";

    #[test]
    fn matches_known_answer_chunk() {
        let k = asset_key();
        let h = Header::parse(&GOLDEN).unwrap();
        assert_eq!(
            hex(&encrypt_chunk(&k, &h, 0, PLAINTEXT)),
            CHUNK_AT_INDEX_ZERO
        );
    }
}
