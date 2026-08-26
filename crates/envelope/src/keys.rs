use blake2::Blake2bMac;
use blake2::digest::{FixedOutput, KeyInit, Update, consts::U32};
use zeroize::Zeroize;

// K_asset = keyed_hash(key = K_album, message = "vitrina-asset-v1" ‖ asset_id)
/// keyed BLAKE2b, 32-byte key, 32-byte output, RFC 7693
fn keyed_blake2b_256(key: &[u8; 32], msg: &[u8]) -> [u8; 32] {
    let mut hasher = Blake2bMac::<U32>::new_from_slice(key)
        .expect("key is 32 bytes by type; BLAKE2b accepts up to 64");
    hasher.update(msg);
    hasher.finalize_fixed().into()
}

// K_asset(id) = BLAKE2b-256(key = K_album, msg = "vitrina-asset-v1" ‖ asset_id)
// K_thumb(id) = BLAKE2b-256(key = K_album, msg = "vitrina-thumb-v1" ‖ asset_id)
// K_meta(id)  = BLAKE2b-256(key = K_album, msg = "vitrina-meta-v1"  ‖ asset_id)

#[cfg(test)]
mod tests {
    use super::*;

    const I: usize = 31;

    /// libsodium 1.0.20, `test/default/generichash.exp`, line 32 —
    /// 32-byte key, message fed once, 32-byte digest.
    const GENERICHASH_I31: &str =
        "a9f51bb7f6a3e9cdb96ce652c07d177962a348a9cced1b92f948187e59b44463";

    /// libsodium 1.0.20, `test/default/generichash2.exp`, line 32 — loop
    /// iteration i = 31: same key and message, fed three times, 32-byte digest.
    const GENERICHASH2_I31: &str =
        "0e5625d74ada70b8a3b23ca76894e9a0f9dee88f5e3e370e27ad25061ea9dd6f";

    fn libsodium_loop_case(i: usize) -> ([u8; 32], Vec<u8>) {
        let key: [u8; 32] = (0..=i)
            .map(|h: usize| h as u8)
            .collect::<Vec<u8>>()
            .try_into()
            .expect("only i = 31 yields the 32-byte key this helper accepts");
        let input: Vec<u8> = (0..i).map(|b: usize| b as u8).collect();
        (key, input)
    }

    /// Mirrors the `printf("%02x", ...)` the .exp files were generated with, so
    /// a failure prints something greppable against the source file.
    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b: &u8| format!("{b:02x}")).collect()
    }

    #[test]
    fn matches_libsodium_generichash_iteration_31() {
        let (key, input) = libsodium_loop_case(I);
        assert_eq!(hex(&keyed_blake2b_256(&key, &input)), GENERICHASH_I31);
    }

    #[test]
    fn matches_libsodium_generichash2_iteration_31() {
        let (key, input) = libsodium_loop_case(I);
        let message = input.repeat(3);
        assert_eq!(hex(&keyed_blake2b_256(&key, &message)), GENERICHASH2_I31);
    }
}
