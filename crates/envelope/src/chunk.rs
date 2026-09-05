use crate::Header;
use crate::keys::ChunkKey;
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, Payload},
};

fn aead_encrypt(
    cipher: &XChaCha20Poly1305,
    nonce: &[u8; 24],
    aad: &[u8],
    plaintext: &[u8],
) -> Vec<u8> {
    let n: &XNonce = nonce.into();
    cipher
        .encrypt(
            n,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .expect("payload length is within XChaCha20-Poly1305 limits")
}

fn aead_decrypt(
    cipher: &XChaCha20Poly1305,
    nonce: &[u8; 24],
    aad: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, ChunkError> {
    let n: &XNonce = nonce.into();
    cipher
        .decrypt(
            n,
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| ChunkError::AuthenticationFailed)
}

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

    aead_decrypt(&key.cipher(), &nonce, &aad, ciphertext)
}

#[derive(Debug, PartialEq)]
pub(crate) enum ChunkError {
    AuthenticationFailed,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::cipher_for;
    use crate::test_fixtures::{
        ASSET_ID, GOLDEN, PLAINTEXT, asset_key, header_with, hex, thumb_key,
    };
    use proptest::prelude::*;

    /// xchacha-rfc, `draft-irtf-cfrg-xchacha-rfc-03.txt`, A.3.1, AAD —
    #[rustfmt::skip]
    const AAD: [u8; 12] = [
        0x50, 0x51, 0x52, 0x53, 0xc0, 0xc1,
        0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7
    ];

    /// xchacha-rfc, `draft-irtf-cfrg-xchacha-rfc-03.txt`, A.3.1, KEY —
    #[rustfmt::skip]
    const KEY: [u8; 32] = [
        0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
        0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8d, 0x8e, 0x8f,
        0x90, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97,
        0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f
    ];

    /// xchacha-rfc, `draft-irtf-cfrg-xchacha-rfc-03.txt`, A.3.1, IV —
    #[rustfmt::skip]
    const IV: [u8; 24] = [
        0x40, 0x41, 0x42, 0x43, 0x44, 0x45,
        0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b,
        0x4c, 0x4d, 0x4e, 0x4f, 0x50, 0x51,
        0x52, 0x53, 0x54, 0x55, 0x56, 0x57
    ];

    /// xchacha-rfc, `draft-irtf-cfrg-xchacha-rfc-03.txt`, Appendix A, PLAINTEXT —
    #[rustfmt::skip]
    const PLAINTEXT_ANCHOR: &[u8; 114] = b"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";

    /// xchacha-rfc, `draft-irtf-cfrg-xchacha-rfc-03.txt`, A.3.1, CIPHERTEXT AND TAG —
    #[rustfmt::skip]
    const CIPHERTEXT_AND_TAG: [u8; 130] = [
        0xbd, 0x6d, 0x17, 0x9d, 0x3e, 0x83, 0xd4, 0x3b, 0x95, 0x76, 0x57, 0x94, 0x93, 0xc0, 0xe9, 0x39,
        0x57, 0x2a, 0x17, 0x00, 0x25, 0x2b, 0xfa, 0xcc, 0xbe, 0xd2, 0x90, 0x2c, 0x21, 0x39, 0x6c, 0xbb,
        0x73, 0x1c, 0x7f, 0x1b, 0x0b, 0x4a, 0xa6, 0x44, 0x0b, 0xf3, 0xa8, 0x2f, 0x4e, 0xda, 0x7e, 0x39,
        0xae, 0x64, 0xc6, 0x70, 0x8c, 0x54, 0xc2, 0x16, 0xcb, 0x96, 0xb7, 0x2e, 0x12, 0x13, 0xb4, 0x52,
        0x2f, 0x8c, 0x9b, 0xa4, 0x0d, 0xb5, 0xd9, 0x45, 0xb1, 0x1b, 0x69, 0xb9, 0x82, 0xc1, 0xbb, 0x9e,
        0x3f, 0x3f, 0xac, 0x2b, 0xc3, 0x69, 0x48, 0x8f, 0x76, 0xb2, 0x38, 0x35, 0x65, 0xd3, 0xff, 0xf9,
        0x21, 0xf9, 0x66, 0x4c, 0x97, 0x63, 0x7d, 0xa9, 0x76, 0x88, 0x12, 0xf6, 0x15, 0xc6, 0x8b, 0x13,
        0xb5, 0x2e, 0xc0, 0x87, 0x59, 0x24, 0xc1, 0xc7, 0x98, 0x79, 0x47, 0xde, 0xaf, 0xd8, 0x78, 0x0a,
        0xcf, 0x49
    ];

    #[test]
    fn matches_draft3_ciphertext_and_tag_on_encrypt() {
        assert_eq!(
            aead_encrypt(&cipher_for(&KEY), &IV, &AAD, PLAINTEXT_ANCHOR),
            CIPHERTEXT_AND_TAG
        );
    }

    #[test]
    fn matches_draft3_ciphertext_and_tag_on_decrypt() {
        assert_eq!(
            aead_decrypt(&cipher_for(&KEY), &IV, &AAD, &CIPHERTEXT_AND_TAG).unwrap(),
            PLAINTEXT_ANCHOR.as_slice()
        );
    }

    // Round Trip Tests
    // -----------------------------------------------------
    #[test]
    fn different_index_gives_different_ciphertext() {
        let header: Header = header_with(64, 200);
        let k: crate::AssetKey = asset_key();
        let ciphertext_on_zero: Vec<u8> = encrypt_chunk(&k, &header, 0, PLAINTEXT);
        let ciphertext_on_one: Vec<u8> = encrypt_chunk(&k, &header, 1, PLAINTEXT);
        assert_ne!(ciphertext_on_one, ciphertext_on_zero);
    }

    proptest! {
        #[test]
        fn chunk_round_trips(
            i in any::<u64>(),
            p in proptest::collection::vec(any::<u8>(), 1..=1024),
        ) {
            let h: Header = header_with(64, 200);
            let k: crate::AssetKey = asset_key();

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
        let k: crate::AssetKey = asset_key();

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
        let k: crate::AssetKey = asset_key();

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
        let k: crate::AssetKey = asset_key();
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
        let key: crate::AssetKey = asset_key();
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
            ChunkError::AuthenticationFailed
        );
    }

    // §9 Tampering Tests
    // -----------------------------------------------------

    #[test]
    fn rejects_tampered_ciphertext_body() {
        let header: Header = header_with(64, 200);
        let k: crate::AssetKey = asset_key();

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
        let k: crate::AssetKey = asset_key();

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
        let k: crate::AssetKey = asset_key();

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
        let k: crate::AssetKey = asset_key();
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
        let k: crate::AssetKey = asset_key();
        let thumb_k: crate::ThumbKey = thumb_key();

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
