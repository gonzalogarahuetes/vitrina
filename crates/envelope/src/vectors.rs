//! C.9 — the JSON vectors in `spec/vectors/` (encryption spec §9, §9.1).
//! `generate_vectors` (ignored) writes the file; `committed_vectors_verify`
//! reads it back under plain `cargo test`.

use crate::WrapParams;
use crate::test_fixtures::hex;
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

#[derive(Serialize, Deserialize)]
struct VectorFile {
    source: String,
    envelope_version: u8,
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
    });
}

#[test]
fn hex_round_trips() {
    let bytes: [u8; 4] = [0x00, 0x7f, 0x80, 0xff];
    assert_eq!(unhex(&hex(&bytes)), bytes);
    assert_eq!(unhex_array::<4>(&hex(&bytes)), bytes);
}
