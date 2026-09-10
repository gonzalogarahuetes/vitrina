//! C.9 — the JSON vectors in `spec/vectors/` (encryption spec §9, §9.1).
//! `generate_vectors` (ignored) writes the file; `committed_vectors_verify`
//! reads it back under plain `cargo test`.

use crate::envelope::encrypt_with_header;
use crate::header::Header;
use crate::test_fixtures::{ASSET_ID, BASE_NONCE, K_ALBUM, album_key, hex};
use crate::{AlbumKey, CHUNK_SIZE, WrapParams};
use serde::{Deserialize, Serialize};
use std::fs;

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
    key_derivation: Vec<KeyDerivationVector>,
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
    let header: Header = Header::new(ASSET_ID, base_nonce, chunk_size, plaintext_length).unwrap();
    let object: Vec<u8> =
        encrypt_with_header(&album_key().derive_asset(&ASSET_ID), &header, &plaintext).unwrap();
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

fn key_derivation_vectors() -> Vec<KeyDerivationVector> {
    let album: AlbumKey = album_key();
    vec![KeyDerivationVector {
        category: 5,
        name: "K_album + asset_id -> K_asset, K_thumb, K_meta".to_string(),
        k_album: hex(&K_ALBUM),
        asset_id: hex(&ASSET_ID),
        k_asset: hex(album.derive_asset(&ASSET_ID).expose_bytes()),
        k_thumb: hex(album.derive_thumb(&ASSET_ID).expose_bytes()),
        k_meta: hex(album.derive_meta(&ASSET_ID).expose_bytes()),
    }]
}

fn write_file(file: &VectorFile) {
    let mut json = serde_json::to_string_pretty(file).expect("serialisable");
    json.push('\n');
    fs::write(PATH, json).expect("write spec/vectors");
}

/// Run on demand: `cargo test -p vitrina-envelope generate_vectors -- --ignored`.
/// Output is deterministic; a second run must produce no diff.
#[test]
#[ignore]
fn generate_vectors() {
    assert_eq!(Params::V1.wrap_params(), WrapParams::V1);
    write_file(&VectorFile {
        source: "spec/vitrina-encryption-spec.md §9 and §9.1".to_string(),
        envelope_version: 1,
        envelope: envelope_vectors(),
        key_derivation: key_derivation_vectors(),
    });
}

#[test]
fn hex_round_trips() {
    let bytes: [u8; 4] = [0x00, 0x7f, 0x80, 0xff];
    assert_eq!(unhex(&hex(&bytes)), bytes);
    assert_eq!(unhex_array::<4>(&hex(&bytes)), bytes);
}
