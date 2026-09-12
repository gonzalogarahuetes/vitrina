//! C.9 — the JSON vectors in `spec/vectors/` (encryption spec §9, §9.1).
//! `generate_vectors` (ignored) writes the file; `committed_vectors_verify`
//! reads it back under plain `cargo test`.

use crate::aead::aead_encrypt;
use crate::chunk::decrypt_chunk;
use crate::envelope::encrypt_with_header;
use crate::header::{Header, HeaderError};
use crate::keys::{cipher_for, keyed_blake2b_256};
use crate::test_fixtures::{ASSET_ID, BASE_NONCE, K_ALBUM, album_key, hex};
use crate::wrap::{derive_kek, normalize_passphrase, wrap_aad, wrap_with_salt_and_nonce};
use crate::{
    AlbumKey, AssetId, CHUNK_SIZE, EnvelopeError, RecipientId, Salt, WrapError, WrapParams,
    WrappedKey, decrypt_asset, unwrap_album_key,
};
use argon2::{Algorithm, Argon2, AssociatedData, ParamsBuilder, Version};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../spec/vectors/vitrina-vectors.json"
);

fn unhex(s: &str) -> Vec<u8> {
    assert!(s.len().is_multiple_of(2), "odd-length hex: {s}");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex digit"))
        .collect()
}

fn unhex_array<const N: usize>(s: &str) -> [u8; N] {
    unhex(s)
        .try_into()
        .unwrap_or_else(|v: Vec<u8>| panic!("expected {N} bytes, got {}", v.len()))
}

/// Argon2id parameters as stored per recipient (§6.2). `WrapParams` keeps its
/// fields private, so the file carries its own copy and the generator asserts
/// `V1` agrees with `WrapParams::V1`.
#[derive(Serialize, Deserialize, Debug, PartialEq, Clone, Copy)]
struct Params {
    m_cost_kib: u32,
    t_cost: u32,
    p_cost: u32,
}

impl Params {
    const V1: Params = Params {
        m_cost_kib: 65_536,
        t_cost: 3,
        p_cost: 1,
    };
    const LOW: Params = Params {
        m_cost_kib: 8,
        t_cost: 1,
        p_cost: 1,
    };

    fn wrap_params(self) -> WrapParams {
        WrapParams::new(self.m_cost_kib, self.t_cost, self.p_cost).expect("valid Argon2id params")
    }
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum Expect {
    Accept,
    Reject,
}

#[derive(Serialize, Deserialize)]
struct VectorFile {
    source: String,
    envelope_version: u8,
    envelope: Vec<EnvelopeVector>,
    envelope_negative: Vec<NegativeVector>,
    key_derivation: Vec<KeyDerivationVector>,
    anchors: Anchors,
    wrap: Vec<WrapVector>,
    protocol: Protocol,
}

/// §9 categories 1–4. Inputs per §9's list; `object` is the full envelope.
#[derive(Serialize, Deserialize)]
struct EnvelopeVector {
    category: u8,
    name: String,
    k_album: String,
    asset_id: String,
    base_nonce: String,
    chunk_size: u32,
    plaintext: String,
    object: String,
    expect: Expect,
}

/// §9 categories 10–14. The mutated bytes are stored, never the mutation,
/// so no implementation has to interpret an instruction (§9.1).
#[derive(Serialize, Deserialize)]
struct NegativeVector {
    category: u8,
    name: String,
    k_album: String,
    asset_id: String,
    object: String,
    expect: Expect,
}

/// §9 category 5, pinning §2's three domain strings.
#[derive(Serialize, Deserialize)]
struct KeyDerivationVector {
    category: u8,
    name: String,
    k_album: String,
    asset_id: String,
    k_asset: String,
    k_thumb: String,
    k_meta: String,
}

/// §9 category 9. Two parameter sets, because one cannot tell a reader that
/// honours per-recipient parameters (§6.2) from one that hardcodes them.
#[derive(Serialize, Deserialize)]
struct WrapVector {
    category: u8,
    name: String,
    k_album: String,
    passphrase: String,
    salt: String,
    params: Params,
    recipient_id: String,
    wrap_nonce: String,
    wrapped: String,
}

/// §9.1's required protocol vectors, keyed by name in §9.1's order.
#[derive(Serialize, Deserialize)]
struct Protocol {
    token: TokenVector,
    token_noncanonical: TokenSpellingVector,
    passphrase_empty: Vec<EmptyPassphraseVector>,
    passphrase_normalisation: PassphraseVector,
    wrap_aad: WrapAadVector,
    wrap_salt_length: Vec<SaltLengthVector>,
}

/// vitrina-schema.md §6: the hash is over the 32 raw bytes, never the string.
#[derive(Serialize, Deserialize)]
struct TokenVector {
    vector: u8,
    token_raw: String,
    token_base64url: String,
    sha256: String,
    expect: Expect,
}

/// Same 32 bytes, non-canonical spelling: the spare two bits of the final
/// character are non-zero. Schema §6 rule 3 rejects it at the boundary.
#[derive(Serialize, Deserialize)]
struct TokenSpellingVector {
    vector: u8,
    token_base64url: String,
    expect: Expect,
}

/// §6.3: empty after normalisation is rejected before Argon2id runs, so there
/// is no `kek` field. Two inputs because they fail at different steps.
#[derive(Serialize, Deserialize)]
struct EmptyPassphraseVector {
    vector: u8,
    name: String,
    passphrase: String,
    normalized: String,
    salt: String,
    params: Params,
    expect: Expect,
}

#[derive(Serialize, Deserialize)]
struct PassphraseVector {
    vector: u8,
    passphrase: String,
    normalized: String,
    salt: String,
    params: Params,
    kek: String,
}

#[derive(Serialize, Deserialize)]
struct WrapAadVector {
    vector: u8,
    recipient_id: String,
    aad: String,
}

/// `wrapped` is absent on the reject case: nothing is computed there.
#[derive(Serialize, Deserialize)]
struct SaltLengthVector {
    vector: u8,
    name: String,
    k_album: String,
    passphrase: String,
    salt: String,
    params: Params,
    recipient_id: String,
    wrap_nonce: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    wrapped: Option<String>,
    expect: Expect,
}

/// §9 categories 6–8: one external anchor per §1 primitive, keyed by name.
#[derive(Serialize, Deserialize)]
struct Anchors {
    blake2b_keyed: Blake2bAnchor,
    xchacha20poly1305: XChaChaAnchor,
    argon2id: Argon2idAnchor,
}

#[derive(Serialize, Deserialize)]
struct Blake2bAnchor {
    category: u8,
    source: String,
    key: String,
    message: String,
    digest: String,
}

#[derive(Serialize, Deserialize)]
struct XChaChaAnchor {
    category: u8,
    source: String,
    key: String,
    nonce: String,
    aad: String,
    plaintext: String,
    ciphertext_and_tag: String,
}

#[derive(Serialize, Deserialize)]
struct Argon2idAnchor {
    category: u8,
    source: String,
    password: String,
    salt: String,
    secret: String,
    associated_data: String,
    params: Params,
    tag: String,
}

// External anchor values, copied from their sources rather than computed.
// ---------------------------------------------------------------------------

/// libsodium 1.0.20, test/default/generichash2.exp line 32 — loop i = 31:
/// key 0x00..=0x1f, message 0x00..0x1e fed three times, 32-byte digest.
const GENERICHASH2_I31: &str = "0e5625d74ada70b8a3b23ca76894e9a0f9dee88f5e3e370e27ad25061ea9dd6f";

/// draft-irtf-cfrg-xchacha-03, Appendix A.3.1.
const XCHACHA_AAD: [u8; 12] = [
    0x50, 0x51, 0x52, 0x53, 0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
];
const XCHACHA_KEY: [u8; 32] = [
    0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8d, 0x8e, 0x8f,
    0x90, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f,
];
const XCHACHA_IV: [u8; 24] = [
    0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f,
    0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57,
];
const XCHACHA_PLAINTEXT: &[u8; 114] = b"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";
const XCHACHA_CIPHERTEXT_AND_TAG: &str = "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52ec0875924c1c7987947deafd8780acf49";

/// RFC 9106 §5.3, Argon2id.
const RFC_9106_ARGON2ID_TAG: &str =
    "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659";

/// Each anchor is recomputed and asserted here, so the generator cannot emit
/// a self-generated vector on top of a primitive that fails its anchor (§9.2).
fn anchors() -> Anchors {
    let key: [u8; 32] = std::array::from_fn(|h| h as u8);
    let message: Vec<u8> = ascending(31).repeat(3);
    let digest: [u8; 32] = keyed_blake2b_256(&key, &message);
    assert_eq!(hex(&digest), GENERICHASH2_I31);

    let ciphertext_and_tag: Vec<u8> = aead_encrypt(
        &cipher_for(&XCHACHA_KEY),
        &XCHACHA_IV,
        &XCHACHA_AAD,
        XCHACHA_PLAINTEXT,
    );
    assert_eq!(hex(&ciphertext_and_tag), XCHACHA_CIPHERTEXT_AND_TAG);

    let (password, salt, secret, associated_data) =
        ([0x01u8; 32], [0x02u8; 16], [0x03u8; 8], [0x04u8; 12]);
    let params = Params {
        m_cost_kib: 32,
        t_cost: 3,
        p_cost: 4,
    };
    let tag: [u8; 32] = rfc9106_argon2id(&password, &salt, &secret, &associated_data, params);
    assert_eq!(hex(&tag), RFC_9106_ARGON2ID_TAG);

    Anchors {
        blake2b_keyed: Blake2bAnchor {
            category: 6,
            source: "libsodium 1.0.20 test/default/generichash2.exp line 32 (i = 31)".to_string(),
            key: hex(&key),
            message: hex(&message),
            digest: hex(&digest),
        },
        xchacha20poly1305: XChaChaAnchor {
            category: 7,
            source: "draft-irtf-cfrg-xchacha-03 Appendix A.3.1".to_string(),
            key: hex(&XCHACHA_KEY),
            nonce: hex(&XCHACHA_IV),
            aad: hex(&XCHACHA_AAD),
            plaintext: hex(XCHACHA_PLAINTEXT),
            ciphertext_and_tag: hex(&ciphertext_and_tag),
        },
        argon2id: Argon2idAnchor {
            category: 8,
            source: "RFC 9106 §5.3".to_string(),
            password: hex(&password),
            salt: hex(&salt),
            secret: hex(&secret),
            associated_data: hex(&associated_data),
            params,
            tag: hex(&tag),
        },
    }
}

/// The RFC vector carries a secret and associated data, which `derive_kek`
/// deliberately cannot supply (§6.2), so the anchor calls the primitive directly.
fn rfc9106_argon2id(
    password: &[u8],
    salt: &[u8],
    secret: &[u8],
    associated_data: &[u8],
    params: Params,
) -> [u8; 32] {
    let mut b = ParamsBuilder::new();
    b.m_cost(params.m_cost_kib)
        .t_cost(params.t_cost)
        .p_cost(params.p_cost)
        .output_len(32)
        .data(AssociatedData::new(associated_data).unwrap());
    let argon = Argon2::new_with_secret(
        secret,
        Algorithm::Argon2id,
        Version::V0x13,
        b.build().unwrap(),
    )
    .unwrap();
    let mut out = [0u8; 32];
    argon.hash_password_into(password, salt, &mut out).unwrap();
    out
}

// Wrap fixtures, shared with wrap.rs's tests so category 9 at low parameters
// coincides with KNOWN_ANSWER_WRAPPED there.
// ---------------------------------------------------------------------------

const SALT: [u8; 16] = [
    0x8f, 0x2c, 0x41, 0xd7, 0x05, 0xba, 0x63, 0x19, 0xe4, 0x7a, 0x2f, 0x90, 0xc8, 0x11, 0x5d, 0x36,
];
/// UUIDv4 3f2a91c7-8b4e-4d16-9f05-c2a7d81e6b34.
const RECIPIENT_ID: [u8; 16] = [
    0x3f, 0x2a, 0x91, 0xc7, 0x8b, 0x4e, 0x4d, 0x16, 0x9f, 0x05, 0xc2, 0xa7, 0xd8, 0x1e, 0x6b, 0x34,
];
const WRAP_NONCE: [u8; 24] = [
    0x6d, 0xc4, 0x1a, 0x83, 0x2f, 0x0b, 0x97, 0x5e, 0xa1, 0x38, 0xd6, 0x72, 0x4c, 0xe9, 0x05, 0xbf,
    0x81, 0x27, 0x9a, 0x60, 0xf3, 0x4d, 0xcb, 0x16,
];
const PASSPHRASE: &str = "Café Roble";
/// Diacritics, mixed case, leading, doubled, tab and trailing whitespace.
const MESSY_PASSPHRASE: &str = "  Café  ROBLE\tÑandú ";

fn wrapped_for(passphrase: &str, params: Params) -> [u8; 48] {
    wrap_with_salt_and_nonce(
        &album_key(),
        passphrase,
        Salt::from_bytes(SALT),
        params.wrap_params(),
        &RecipientId::from_bytes(RECIPIENT_ID),
        &WRAP_NONCE,
    )
    .unwrap()
}

fn wrap_vector(name: &str, params: Params) -> WrapVector {
    WrapVector {
        category: 9,
        name: name.to_string(),
        k_album: hex(&K_ALBUM),
        passphrase: PASSPHRASE.to_string(),
        salt: hex(&SALT),
        params,
        recipient_id: hex(&RECIPIENT_ID),
        wrap_nonce: hex(&WRAP_NONCE),
        wrapped: hex(&wrapped_for(PASSPHRASE, params)),
    }
}

fn wrap_vectors() -> Vec<WrapVector> {
    vec![
        wrap_vector("v1 parameters (§6.2)", Params::V1),
        wrap_vector("low parameters", Params::LOW),
    ]
}

fn salt_length_vector(
    name: &str,
    salt: &[u8],
    wrapped: Option<[u8; 48]>,
    expect: Expect,
) -> SaltLengthVector {
    SaltLengthVector {
        vector: 6,
        name: name.to_string(),
        k_album: hex(&K_ALBUM),
        passphrase: PASSPHRASE.to_string(),
        salt: hex(salt),
        params: Params::LOW,
        recipient_id: hex(&RECIPIENT_ID),
        wrap_nonce: hex(&WRAP_NONCE),
        wrapped: wrapped.map(|w| hex(&w)),
        expect,
    }
}

const TOKEN_RAW: [u8; 32] = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
    0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f,
];
const BASE64URL_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Schema §6 rule 3, in full: 43 characters, decodes to 32 bytes, and
/// re-encodes to the same string.
fn strict_decode_token(s: &str) -> Option<[u8; 32]> {
    if s.len() != 43 {
        return None;
    }
    let bytes: [u8; 32] = URL_SAFE_NO_PAD.decode(s).ok()?.try_into().ok()?;
    (URL_SAFE_NO_PAD.encode(bytes) == s).then_some(bytes)
}

fn token_vectors() -> (TokenVector, TokenSpellingVector) {
    let canonical: String = URL_SAFE_NO_PAD.encode(TOKEN_RAW);
    assert_eq!(strict_decode_token(&canonical), Some(TOKEN_RAW));

    let mut spelling: Vec<u8> = canonical.clone().into_bytes();
    let last: usize = BASE64URL_ALPHABET
        .iter()
        .position(|&c| c == spelling[42])
        .unwrap();
    assert_eq!(last & 0b11, 0, "canonical spelling has zero spare bits");
    spelling[42] = BASE64URL_ALPHABET[last | 0b01];
    let noncanonical: String = String::from_utf8(spelling).unwrap();
    assert_eq!(strict_decode_token(&noncanonical), None);

    (
        TokenVector {
            vector: 1,
            token_raw: hex(&TOKEN_RAW),
            token_base64url: canonical,
            sha256: hex(&Sha256::digest(TOKEN_RAW)),
            expect: Expect::Accept,
        },
        TokenSpellingVector {
            vector: 2,
            token_base64url: noncanonical,
            expect: Expect::Reject,
        },
    )
}

fn empty_passphrase_vector(name: &str, passphrase: &str) -> EmptyPassphraseVector {
    let normalized: String = normalize_passphrase(passphrase);
    assert_eq!(normalized, "");
    assert_eq!(
        derive_kek(
            passphrase,
            Params::LOW.wrap_params(),
            Salt::from_bytes(SALT)
        )
        .err(),
        Some(WrapError::EmptyPassphrase)
    );
    EmptyPassphraseVector {
        vector: 3,
        name: name.to_string(),
        passphrase: passphrase.to_string(),
        normalized,
        salt: hex(&SALT),
        params: Params::LOW,
        expect: Expect::Reject,
    }
}

fn protocol() -> Protocol {
    let (token, token_noncanonical) = token_vectors();
    let normalized: String = normalize_passphrase(MESSY_PASSPHRASE);
    assert_eq!(normalized, "cafe roble nandu");
    let kek = derive_kek(
        MESSY_PASSPHRASE,
        Params::LOW.wrap_params(),
        Salt::from_bytes(SALT),
    )
    .unwrap();

    Protocol {
        token,
        token_noncanonical,
        passphrase_empty: vec![
            empty_passphrase_vector("already empty", ""),
            empty_passphrase_vector("whitespace only", " "),
        ],
        passphrase_normalisation: PassphraseVector {
            vector: 4,
            passphrase: MESSY_PASSPHRASE.to_string(),
            normalized,
            salt: hex(&SALT),
            params: Params::LOW,
            kek: hex(kek.expose_bytes()),
        },
        wrap_aad: WrapAadVector {
            vector: 5,
            recipient_id: hex(&RECIPIENT_ID),
            aad: hex(&wrap_aad(&RecipientId::from_bytes(RECIPIENT_ID))),
        },
        wrap_salt_length: vec![
            salt_length_vector(
                "16-byte salt",
                &SALT,
                Some(wrapped_for(PASSPHRASE, Params::LOW)),
                Expect::Accept,
            ),
            salt_length_vector("32-byte salt", &SALT.repeat(2), None, Expect::Reject),
        ],
    }
}

fn ascending(len: u64) -> Vec<u8> {
    (0..len).map(|b| b as u8).collect()
}

/// §4.1: a base_nonce is never reused, so each length case gets its own.
/// Category 3 keeps the fixture nonce so it coincides with the crate's
/// KNOWN_ANSWER_ENVELOPE.
fn base_nonce_for(category: u8) -> [u8; 16] {
    let mut n: [u8; 16] = BASE_NONCE;
    n[15] = 0xAC + category;
    n
}

fn envelope_vector(
    category: u8,
    name: &str,
    chunk_size: u32,
    plaintext_length: u64,
) -> EnvelopeVector {
    let base_nonce: [u8; 16] = base_nonce_for(category);
    let plaintext: Vec<u8> = ascending(plaintext_length);
    let header: Header = Header::new(
        AssetId::from_bytes(ASSET_ID),
        base_nonce,
        chunk_size,
        plaintext_length,
    )
    .unwrap();
    let object: Vec<u8> = encrypt_with_header(
        &album_key().derive_asset(&AssetId::from_bytes(ASSET_ID)),
        &header,
        &plaintext,
    )
    .unwrap();
    EnvelopeVector {
        category,
        name: name.to_string(),
        k_album: hex(&K_ALBUM),
        asset_id: hex(&ASSET_ID),
        base_nonce: hex(&base_nonce),
        chunk_size,
        plaintext: hex(&plaintext),
        object: hex(&object),
        expect: Expect::Accept,
    }
}

/// Category 1 uses the v1 production chunk size (§3.1); 2–4 use 64 so the
/// multi-chunk cases stay small enough to read.
fn envelope_vectors() -> Vec<EnvelopeVector> {
    vec![
        envelope_vector(
            1,
            "single chunk, plaintext shorter than chunk_size",
            CHUNK_SIZE,
            100,
        ),
        envelope_vector(2, "plaintext exactly chunk_size", 64, 64),
        envelope_vector(3, "plaintext exactly chunk_size + 1", 64, 65),
        envelope_vector(4, "three full chunks plus an 8-byte final chunk", 64, 200),
    ]
}

fn negative_vector(category: u8, name: &str, object: Vec<u8>) -> NegativeVector {
    NegativeVector {
        category,
        name: name.to_string(),
        k_album: hex(&K_ALBUM),
        asset_id: hex(&ASSET_ID),
        object: hex(&object),
        expect: Expect::Reject,
    }
}

/// All five derive from category 4: 200 bytes at chunk_size 64, so chunks 0
/// and 1 are both 80 ciphertext bytes and the final chunk is 8 + 16.
fn negative_vectors(source: &EnvelopeVector) -> Vec<NegativeVector> {
    assert_eq!(source.category, 4);
    let object: Vec<u8> = unhex(&source.object);
    let header: Header = Header::parse(&object).unwrap();
    let r0 = header.chunk_range(0).unwrap();
    let r1 = header.chunk_range(1).unwrap();
    let last = header.chunk_range(header.chunk_count() - 1).unwrap();
    let (r0, r1) = (
        r0.start as usize..r0.end as usize,
        r1.start as usize..r1.end as usize,
    );

    let mut tampered: Vec<u8> = object.clone();
    tampered[r1.start + 5] ^= 0x01;

    let mut swapped: Vec<u8> = object[..64].to_vec();
    swapped.extend_from_slice(&object[r1.clone()]);
    swapped.extend_from_slice(&object[r0]);
    swapped.extend_from_slice(&object[r1.end..]);

    let mut truncated: Vec<u8> = object[..last.start as usize].to_vec();
    let shortened: u64 = header.plaintext_length() - header.last_chunk_plaintext();
    truncated[28..36].copy_from_slice(&shortened.to_le_bytes());

    let mut downgraded: Vec<u8> = object.clone();
    downgraded[4] = 0x02;

    let mut wrong_cipher: Vec<u8> = object.clone();
    wrong_cipher[5] = 0x02;

    vec![
        negative_vector(10, "tampered ciphertext byte in chunk 1", tampered),
        negative_vector(11, "chunks 0 and 1 swapped", swapped),
        negative_vector(
            12,
            "final chunk removed and plaintext_length adjusted",
            truncated,
        ),
        negative_vector(13, "version byte altered", downgraded),
        negative_vector(
            14,
            "cipher byte set to an unimplemented value",
            wrong_cipher,
        ),
    ]
}

fn key_derivation_vectors() -> Vec<KeyDerivationVector> {
    let album: AlbumKey = album_key();
    vec![KeyDerivationVector {
        category: 5,
        name: "K_album + asset_id -> K_asset, K_thumb, K_meta".to_string(),
        k_album: hex(&K_ALBUM),
        asset_id: hex(&ASSET_ID),
        k_asset: hex(album
            .derive_asset(&AssetId::from_bytes(ASSET_ID))
            .expose_bytes()),
        k_thumb: hex(album
            .derive_thumb(&AssetId::from_bytes(ASSET_ID))
            .expose_bytes()),
        k_meta: hex(album
            .derive_meta(&AssetId::from_bytes(ASSET_ID))
            .expose_bytes()),
    }]
}

fn to_json(file: &VectorFile) -> String {
    let mut json = serde_json::to_string_pretty(file).expect("serialisable");
    json.push('\n');
    json
}

fn write_file(file: &VectorFile) {
    fs::write(PATH, to_json(file)).expect("write spec/vectors");
}

fn read_committed() -> String {
    fs::read_to_string(PATH).expect("spec/vectors/vitrina-vectors.json is committed")
}

fn build() -> VectorFile {
    assert_eq!(Params::V1.wrap_params(), WrapParams::V1);
    assert_eq!(
        base_nonce_for(3),
        BASE_NONCE,
        "category 3 keeps the fixture nonce"
    );
    let anchors: Anchors = anchors();
    let envelope: Vec<EnvelopeVector> = envelope_vectors();
    let envelope_negative: Vec<NegativeVector> = negative_vectors(&envelope[3]);
    VectorFile {
        source: "spec/vitrina-encryption-spec.md §9 and §9.1".to_string(),
        envelope_version: 1,
        envelope,
        envelope_negative,
        key_derivation: key_derivation_vectors(),
        anchors,
        wrap: wrap_vectors(),
        protocol: protocol(),
    }
}

/// Run on demand: `cargo test -p vitrina-envelope generate_vectors -- --ignored`.
/// Output is deterministic; a second run must produce no diff.
#[test]
#[ignore]
fn generate_vectors() {
    write_file(&build());
}

/// Any drift between generator and file — a value, a field, the order — fails
/// here rather than waiting for the next regeneration.
#[test]
fn generator_reproduces_committed_file() {
    assert_eq!(to_json(&build()), read_committed());
}

// Verification: the committed file, read back through the crate's reader paths.
// ---------------------------------------------------------------------------

fn album_from(v: &str) -> AlbumKey {
    AlbumKey::from_bytes(unhex_array(v))
}

fn verify_envelope(v: &EnvelopeVector) {
    assert_eq!(v.expect, Expect::Accept, "category {}", v.category);
    let album: AlbumKey = album_from(&v.k_album);
    let asset_id: AssetId = AssetId::from_bytes(unhex_array(&v.asset_id));
    let plaintext: Vec<u8> = unhex(&v.plaintext);
    let object: Vec<u8> = unhex(&v.object);

    let header: Header = Header::new(
        asset_id,
        unhex_array(&v.base_nonce),
        v.chunk_size,
        plaintext.len() as u64,
    )
    .unwrap();
    let key = album.derive_asset(&asset_id);
    assert_eq!(
        hex(&encrypt_with_header(&key, &header, &plaintext).unwrap()),
        v.object,
        "category {}: encrypt",
        v.category
    );
    assert_eq!(
        decrypt_asset(&album, &asset_id, &object).unwrap(),
        plaintext,
        "category {}: decrypt",
        v.category
    );

    // §3.3: every chunk from the header and that chunk's bytes alone.
    let parsed: Header = Header::parse(&object).unwrap();
    assert_eq!(parsed.chunk_size(), v.chunk_size);
    let cs: usize = v.chunk_size as usize;
    for i in 0..parsed.chunk_count() {
        let r = parsed.chunk_range(i).unwrap();
        let chunk: &[u8] = &object[r.start as usize..r.end as usize];
        let (start, end) = (
            i as usize * cs,
            ((i as usize + 1) * cs).min(plaintext.len()),
        );
        assert_eq!(
            decrypt_chunk(&key, &parsed, i, chunk).unwrap(),
            &plaintext[start..end],
            "category {}: chunk {i}",
            v.category
        );
    }
}

fn verify_negative(v: &NegativeVector) {
    assert_eq!(v.expect, Expect::Reject, "category {}", v.category);
    let album: AlbumKey = album_from(&v.k_album);
    let asset_id: AssetId = AssetId::from_bytes(unhex_array(&v.asset_id));
    let object: Vec<u8> = unhex(&v.object);
    let err: EnvelopeError = decrypt_asset(&album, &asset_id, &object)
        .err()
        .unwrap_or_else(|| panic!("category {}: accepted a rejected object", v.category));
    // §8 lists `cipher` as its own rejection condition, distinct from `version`
    // and from any AEAD failure — so 14 must fail there and nowhere else.
    if v.category == 14 {
        assert_eq!(
            err,
            EnvelopeError::Header(HeaderError::WrongCipher(object[5]))
        );
    }
}

fn verify_key_derivation(v: &KeyDerivationVector) {
    let album: AlbumKey = album_from(&v.k_album);
    let asset_id: AssetId = AssetId::from_bytes(unhex_array(&v.asset_id));
    assert_eq!(hex(album.derive_asset(&asset_id).expose_bytes()), v.k_asset);
    assert_eq!(hex(album.derive_thumb(&asset_id).expose_bytes()), v.k_thumb);
    assert_eq!(hex(album.derive_meta(&asset_id).expose_bytes()), v.k_meta);
}

fn verify_anchors(a: &Anchors) {
    assert_eq!(
        (
            a.blake2b_keyed.category,
            a.xchacha20poly1305.category,
            a.argon2id.category
        ),
        (6, 7, 8)
    );
    assert_eq!(
        hex(&keyed_blake2b_256(
            &unhex_array(&a.blake2b_keyed.key),
            &unhex(&a.blake2b_keyed.message)
        )),
        a.blake2b_keyed.digest
    );
    let x = &a.xchacha20poly1305;
    assert_eq!(
        hex(&aead_encrypt(
            &cipher_for(&unhex_array(&x.key)),
            &unhex_array(&x.nonce),
            &unhex(&x.aad),
            &unhex(&x.plaintext),
        )),
        x.ciphertext_and_tag
    );
    let r = &a.argon2id;
    assert_eq!(
        hex(&rfc9106_argon2id(
            &unhex(&r.password),
            &unhex(&r.salt),
            &unhex(&r.secret),
            &unhex(&r.associated_data),
            r.params,
        )),
        r.tag
    );
}

fn verify_wrap(
    k_album: &str,
    passphrase: &str,
    salt: &str,
    params: Params,
    recipient_id: &str,
    wrap_nonce: &str,
    wrapped: &str,
) {
    let album: AlbumKey = album_from(k_album);
    let salt: Salt = Salt::from_bytes(unhex_array(salt));
    let recipient: RecipientId = RecipientId::from_bytes(unhex_array(recipient_id));
    let wrap_nonce: [u8; 24] = unhex_array(wrap_nonce);
    let got: [u8; 48] = wrap_with_salt_and_nonce(
        &album,
        passphrase,
        salt,
        params.wrap_params(),
        &recipient,
        &wrap_nonce,
    )
    .unwrap();
    assert_eq!(hex(&got), wrapped);

    let stored = WrappedKey {
        wrapped: got,
        wrap_nonce,
        kdf_salt: salt,
    };
    let unwrapped: AlbumKey =
        unwrap_album_key(passphrase, params.wrap_params(), recipient, &stored).unwrap();
    assert_eq!(unwrapped.expose_bytes(), album.expose_bytes());
}

fn verify_protocol(p: &Protocol) {
    let t = &p.token;
    assert_eq!((t.vector, t.expect), (1, Expect::Accept));
    let raw: [u8; 32] = unhex_array(&t.token_raw);
    assert_eq!(hex(&Sha256::digest(raw)), t.sha256);
    assert_eq!(URL_SAFE_NO_PAD.encode(raw), t.token_base64url);
    assert_eq!(strict_decode_token(&t.token_base64url), Some(raw));

    let n = &p.token_noncanonical;
    assert_eq!((n.vector, n.expect), (2, Expect::Reject));
    assert_ne!(n.token_base64url, t.token_base64url);
    assert_eq!(strict_decode_token(&n.token_base64url), None);

    // §9.1 vector 3: the empty form fails the emptiness test as typed, the
    // whitespace form only after normalisation. Neither reaches Argon2id.
    assert_eq!(p.passphrase_empty.len(), 2);
    assert!(p.passphrase_empty[0].passphrase.is_empty());
    assert!(!p.passphrase_empty[1].passphrase.is_empty());
    for v in &p.passphrase_empty {
        assert_eq!((v.vector, v.expect), (3, Expect::Reject));
        assert_eq!(v.normalized, "");
        assert_eq!(normalize_passphrase(&v.passphrase), v.normalized);
        let salt: Salt = Salt::from_bytes(unhex_array(&v.salt));
        assert_eq!(
            derive_kek(&v.passphrase, v.params.wrap_params(), salt).err(),
            Some(WrapError::EmptyPassphrase)
        );
    }

    let pn = &p.passphrase_normalisation;
    assert_eq!(pn.vector, 4);
    assert_eq!(normalize_passphrase(&pn.passphrase), pn.normalized);
    let salt: Salt = Salt::from_bytes(unhex_array(&pn.salt));
    let kek = derive_kek(&pn.passphrase, pn.params.wrap_params(), salt).unwrap();
    assert_eq!(hex(kek.expose_bytes()), pn.kek);
    let kek_from_normalized = derive_kek(&pn.normalized, pn.params.wrap_params(), salt).unwrap();
    assert_eq!(kek_from_normalized.expose_bytes(), kek.expose_bytes());

    let a = &p.wrap_aad;
    assert_eq!(a.vector, 5);
    assert_eq!(
        hex(&wrap_aad(&RecipientId::from_bytes(unhex_array(
            &a.recipient_id
        )))),
        a.aad
    );

    assert_eq!(p.wrap_salt_length.len(), 2);
    for v in &p.wrap_salt_length {
        assert_eq!(v.vector, 6);
        match (v.expect, unhex(&v.salt).len(), &v.wrapped) {
            (Expect::Accept, 16, Some(wrapped)) => verify_wrap(
                &v.k_album,
                &v.passphrase,
                &v.salt,
                v.params,
                &v.recipient_id,
                &v.wrap_nonce,
                wrapped,
            ),
            // Salt is [u8; 16]: a 32-byte salt is unrepresentable here, so this
            // case polices non-Rust implementations and is skipped, not checked.
            (Expect::Reject, 32, None) => {}
            other => panic!("unexpected salt-length vector shape: {other:?}"),
        }
    }
}

#[test]
fn committed_vectors_verify() {
    let file: VectorFile =
        serde_json::from_str(&read_committed()).expect("well-formed vector file");
    assert_eq!(file.envelope_version, 1);

    let categories: Vec<u8> = file.envelope.iter().map(|v| v.category).collect();
    assert_eq!(categories, [1, 2, 3, 4]);
    file.envelope.iter().for_each(verify_envelope);

    let categories: Vec<u8> = file.envelope_negative.iter().map(|v| v.category).collect();
    assert_eq!(categories, [10, 11, 12, 13, 14]);
    file.envelope_negative.iter().for_each(verify_negative);

    assert_eq!(file.key_derivation.len(), 1);
    assert_eq!(file.key_derivation[0].category, 5);
    verify_key_derivation(&file.key_derivation[0]);

    verify_anchors(&file.anchors);

    let params: Vec<Params> = file.wrap.iter().map(|v| v.params).collect();
    assert_eq!(params, [Params::V1, Params::LOW]);
    for v in &file.wrap {
        assert_eq!(v.category, 9);
        verify_wrap(
            &v.k_album,
            &v.passphrase,
            &v.salt,
            v.params,
            &v.recipient_id,
            &v.wrap_nonce,
            &v.wrapped,
        );
    }

    verify_protocol(&file.protocol);
}

#[test]
fn hex_round_trips() {
    let bytes: [u8; 4] = [0x00, 0x7f, 0x80, 0xff];
    assert_eq!(unhex(&hex(&bytes)), bytes);
    assert_eq!(unhex_array::<4>(&hex(&bytes)), bytes);
}
