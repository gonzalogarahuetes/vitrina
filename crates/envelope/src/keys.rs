use blake2::Blake2bMac;
use blake2::digest::{FixedOutput, KeyInit, Update, consts::U32};
use zeroize::Zeroizing;

const ASSET_LABEL: &[u8; 16] = b"vitrina-asset-v1";
const THUMB_LABEL: &[u8; 16] = b"vitrina-thumb-v1";
const META_LABEL: &[u8; 15] = b"vitrina-meta-v1";

/// keyed BLAKE2b, 32-byte key, 32-byte output, RFC 7693
fn keyed_blake2b_256(key: &[u8; 32], msg: &[u8]) -> [u8; 32] {
    let mut hasher = Blake2bMac::<U32>::new_from_slice(key)
        .expect("key is 32 bytes by type; BLAKE2b accepts up to 64");
    hasher.update(msg);
    hasher.finalize_fixed().into()
}

pub struct AlbumKey(Zeroizing<[u8; 32]>);
// Dead until C.5, which is the first code that reads a derived key's bytes.
// Remove this attribute when encrypt_chunk lands; do not widen its scope.
#[allow(dead_code)]
pub struct AssetKey(Zeroizing<[u8; 32]>);
#[allow(dead_code)]
pub struct ThumbKey(Zeroizing<[u8; 32]>);
#[allow(dead_code)]
pub struct MetaKey(Zeroizing<[u8; 32]>);

impl AlbumKey {
    /// [u8; 32] is Copy, so the caller still has their own copy on the stack and that one isn't wiped. Zeroizing protects the copy the key owns, nothing more
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        AlbumKey(Zeroizing::new(bytes))
    }
    pub(crate) fn expose_bytes(&self) -> &[u8; 32] {
        &self.0
    }
    pub fn derive_asset(&self, asset_id: &[u8; 16]) -> AssetKey {
        AssetKey(Zeroizing::new(self.derive(ASSET_LABEL, asset_id)))
    }
    pub fn derive_thumb(&self, asset_id: &[u8; 16]) -> ThumbKey {
        ThumbKey(Zeroizing::new(self.derive(THUMB_LABEL, asset_id)))
    }
    pub fn derive_meta(&self, asset_id: &[u8; 16]) -> MetaKey {
        MetaKey(Zeroizing::new(self.derive(META_LABEL, asset_id)))
    }
    fn derive(&self, label: &[u8], asset_id: &[u8; 16]) -> [u8; 32] {
        let mut buf: [u8; 32] = [0u8; 32];
        let n: usize = label.len();
        buf[..n].copy_from_slice(label);
        buf[n..n + 16].copy_from_slice(asset_id);
        keyed_blake2b_256(self.expose_bytes(), &buf[..n + 16])
    }
}

#[allow(dead_code)]
impl AssetKey {
    pub(crate) fn expose_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

#[allow(dead_code)]
impl ThumbKey {
    pub(crate) fn expose_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

#[allow(dead_code)]
impl MetaKey {
    pub(crate) fn expose_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

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

    // Key Creation and Derivation Tests
    // ----------------------------------------------------
    #[rustfmt::skip]
    const K_ALBUM: [u8; 32] = [
        0xC0, 0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7,
        0xC8, 0xC9, 0xCA, 0xCB, 0xCC, 0xCD, 0xCE, 0xCF,
        0xD0, 0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7,
        0xD8, 0xD9, 0xDA, 0xDB, 0xDC, 0xDD, 0xDE, 0xDF,
    ];

    #[rustfmt::skip]
    const ASSET_ID: [u8; 16] = [
        0xB0, 0xB1, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7,
        0xB8, 0xB9, 0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF,
    ];

    /// Derived by this implementation from K_ALBUM ‖ ASSET_ID above. Self-generated
    /// is sound here because category 6 anchors the primitive externally (§9.2).
    /// These pin the three domain strings in §2 — changing a label changes these.
    const K_ASSET_EXPECTED: &str =
        "ee01f1e9ceb261ba0267781177c5a76aa47152739b460786986599ce3a9c4936";
    const K_THUMB_EXPECTED: &str =
        "0be27b741ef3546f40926f75a5b309ecfa930f3be69777a1ca085f2dc73caa44";
    const K_META_EXPECTED: &str =
        "0b9b93a0679c2ef5a2d02dac49d8dc00304c636bcf518ba012d891f866ca6ce1";

    fn derive_keys_from_bytes(
        album_bytes: [u8; 32],
        asset_id_bytes: [u8; 16],
    ) -> (AssetKey, ThumbKey, MetaKey) {
        let k_album: AlbumKey = AlbumKey::from_bytes(album_bytes);

        let k_asset: AssetKey = k_album.derive_asset(&asset_id_bytes);
        let k_thumb: ThumbKey = k_album.derive_thumb(&asset_id_bytes);
        let k_meta: MetaKey = k_album.derive_meta(&asset_id_bytes);
        (k_asset, k_thumb, k_meta)
    }

    #[test]
    fn catches_label_change() {
        let (k_asset, k_thumb, k_meta) = derive_keys_from_bytes(K_ALBUM, ASSET_ID);

        assert_eq!(hex(k_asset.expose_bytes()), K_ASSET_EXPECTED);
        assert_eq!(hex(k_thumb.expose_bytes()), K_THUMB_EXPECTED);
        assert_eq!(hex(k_meta.expose_bytes()), K_META_EXPECTED);
    }

    #[test]
    fn derives_different_keys_from_same_album_key() {
        let (k_asset, k_thumb, k_meta) = derive_keys_from_bytes(K_ALBUM, ASSET_ID);

        assert_ne!(k_asset.expose_bytes(), k_meta.expose_bytes());
        assert_ne!(k_asset.expose_bytes(), k_thumb.expose_bytes());
        assert_ne!(k_meta.expose_bytes(), k_thumb.expose_bytes());
    }

    #[test]
    fn derives_keys_unequal_to_album_key() {
        let (k_asset, k_thumb, k_meta) = derive_keys_from_bytes(K_ALBUM, ASSET_ID);

        assert_ne!(k_asset.expose_bytes(), &K_ALBUM);
        assert_ne!(k_thumb.expose_bytes(), &K_ALBUM);
        assert_ne!(k_meta.expose_bytes(), &K_ALBUM);
    }

    #[test]
    fn flipping_asset_id_derives_different_keys() {
        let mut other: [u8; 16] = ASSET_ID;
        other[0] ^= 1;

        let (k_asset, k_thumb, k_meta) = derive_keys_from_bytes(K_ALBUM, ASSET_ID);
        let (other_k_asset, other_k_thumb, other_k_meta) = derive_keys_from_bytes(K_ALBUM, other);

        assert_ne!(k_asset.expose_bytes(), other_k_asset.expose_bytes());
        assert_ne!(k_thumb.expose_bytes(), other_k_thumb.expose_bytes());
        assert_ne!(k_meta.expose_bytes(), other_k_meta.expose_bytes());
    }

    #[test]
    fn flipping_k_album_derives_different_keys() {
        let mut other: [u8; 32] = K_ALBUM;
        other[0] ^= 1;

        let (k_asset, k_thumb, k_meta) = derive_keys_from_bytes(K_ALBUM, ASSET_ID);
        let (other_k_asset, other_k_thumb, other_k_meta) = derive_keys_from_bytes(other, ASSET_ID);

        assert_ne!(k_asset.expose_bytes(), other_k_asset.expose_bytes());
        assert_ne!(k_thumb.expose_bytes(), other_k_thumb.expose_bytes());
        assert_ne!(k_meta.expose_bytes(), other_k_meta.expose_bytes());
    }
}
