use blake2::Blake2bMac;
use blake2::digest::{FixedOutput, KeyInit, Update, consts::U32};
use chacha20poly1305::KeyInit as _;
use chacha20poly1305::XChaCha20Poly1305;
use zeroize::Zeroizing;

use crate::owner_wrap::OwnerWrapError;
use crate::{AlbumId, AssetId, RecipientId, WrongLength};

const TITLE_DOMAIN: &[u8; 16] = b"vitrina-title-v1";
const LABEL_DOMAIN: &[u8; 16] = b"vitrina-label-v1";

const ASSET_DOMAIN: &[u8; 16] = b"vitrina-asset-v1";
const THUMB_DOMAIN: &[u8; 16] = b"vitrina-thumb-v1";
const META_DOMAIN: &[u8; 15] = b"vitrina-meta-v1";
/// keyed BLAKE2b, 32-byte key, 32-byte output, RFC 7693
pub(crate) fn keyed_blake2b_256(key: &[u8; 32], msg: &[u8]) -> [u8; 32] {
    let mut hasher = Blake2bMac::<U32>::new_from_slice(key)
        .expect("key is 32 bytes by type; BLAKE2b accepts up to 64");
    hasher.update(msg);
    hasher.finalize_fixed().into()
}

pub(crate) fn cipher_for(key: &[u8; 32]) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new_from_slice(key).expect("key is 32 bytes by type")
}

pub struct AlbumKey(Zeroizing<[u8; 32]>);

pub struct AssetKey(Zeroizing<[u8; 32]>);
pub struct ThumbKey(Zeroizing<[u8; 32]>);
pub struct MetaKey(Zeroizing<[u8; 32]>);
pub struct TitleKey(Zeroizing<[u8; 32]>);
pub struct LabelKey(Zeroizing<[u8; 32]>);

pub struct MasterKey(Zeroizing<[u8; 32]>);

pub(crate) trait ChunkKey {
    fn cipher(&self) -> XChaCha20Poly1305;
}

pub(crate) struct Kek(Zeroizing<[u8; 32]>);

pub struct OwnerKek(Zeroizing<[u8; 32]>);

pub struct LoginProof(Zeroizing<[u8; 32]>);

impl ChunkKey for AssetKey {
    fn cipher(&self) -> XChaCha20Poly1305 {
        cipher_for(self.expose_bytes())
    }
}

impl ChunkKey for ThumbKey {
    fn cipher(&self) -> XChaCha20Poly1305 {
        cipher_for(self.expose_bytes())
    }
}

impl ChunkKey for MetaKey {
    fn cipher(&self) -> XChaCha20Poly1305 {
        cipher_for(self.expose_bytes())
    }
}

impl AlbumKey {
    pub const LEN: usize = 32;

    /// [u8; 32] is Copy, so the caller still has their own copy on the stack and that one isn't wiped. Zeroizing protects the copy the key owns, nothing more
    pub fn from_bytes(bytes: [u8; Self::LEN]) -> Self {
        AlbumKey(Zeroizing::new(bytes))
    }
    pub(crate) fn expose_bytes(&self) -> &[u8; Self::LEN] {
        &self.0
    }
    pub(crate) fn derive_asset(&self, asset_id: &AssetId) -> AssetKey {
        AssetKey(Zeroizing::new(
            self.derive(ASSET_DOMAIN, asset_id.as_bytes()),
        ))
    }
    pub(crate) fn derive_thumb(&self, asset_id: &AssetId) -> ThumbKey {
        ThumbKey(Zeroizing::new(
            self.derive(THUMB_DOMAIN, asset_id.as_bytes()),
        ))
    }
    pub(crate) fn derive_meta(&self, asset_id: &AssetId) -> MetaKey {
        MetaKey(Zeroizing::new(
            self.derive(META_DOMAIN, asset_id.as_bytes()),
        ))
    }
    pub(crate) fn derive_title(&self, album_id: &AlbumId) -> TitleKey {
        TitleKey(Zeroizing::new(
            self.derive(TITLE_DOMAIN, album_id.as_bytes()),
        ))
    }
    pub(crate) fn derive_label(&self, recipient_id: &RecipientId) -> LabelKey {
        LabelKey(Zeroizing::new(
            self.derive(LABEL_DOMAIN, recipient_id.as_bytes()),
        ))
    }
    fn derive(&self, domain: &[u8], id: &[u8; 16]) -> [u8; Self::LEN] {
        let mut buf: [u8; 32] = [0u8; 32];
        let n: usize = domain.len();
        buf[..n].copy_from_slice(domain);
        buf[n..n + 16].copy_from_slice(id);
        keyed_blake2b_256(self.expose_bytes(), &buf[..n + 16])
    }
    pub fn try_from_slice(bytes: &[u8]) -> Result<AlbumKey, WrongLength> {
        let bytes: [u8; Self::LEN] = bytes.try_into().map_err(|_| WrongLength {
            expected: Self::LEN,
            got: bytes.len(),
        })?;
        Ok(AlbumKey::from_bytes(bytes))
    }
}

impl AssetKey {
    pub(crate) fn expose_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl ThumbKey {
    pub(crate) fn expose_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl MetaKey {
    pub(crate) fn expose_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl Kek {
    pub(crate) fn expose_bytes(&self) -> &[u8; 32] {
        &self.0
    }
    pub(crate) fn from_bytes(bytes: Zeroizing<[u8; 32]>) -> Kek {
        Kek(bytes)
    }
}

impl OwnerKek {
    pub(crate) fn expose_bytes(&self) -> &[u8; 32] {
        &self.0
    }
    pub(crate) fn from_bytes(bytes: Zeroizing<[u8; 32]>) -> OwnerKek {
        OwnerKek(bytes)
    }
}

// MasterKey has no derive_* methods on purpose. §2: K_album is wrapped by K_master, never derived from it,
// because a derived key can't be re-wrapped and that kills rotation and recovery.
impl MasterKey {
    pub const LEN: usize = 32;

    pub fn from_bytes(bytes: [u8; Self::LEN]) -> Self {
        MasterKey(Zeroizing::new(bytes))
    }

    pub fn try_from_slice(bytes: &[u8]) -> Result<MasterKey, WrongLength> {
        let bytes: [u8; Self::LEN] = bytes.try_into().map_err(|_| WrongLength {
            expected: Self::LEN,
            got: bytes.len(),
        })?;
        Ok(MasterKey::from_bytes(bytes))
    }

    pub(crate) fn expose_bytes(&self) -> &[u8; Self::LEN] {
        &self.0
    }

    pub fn generate() -> Result<MasterKey, OwnerWrapError> {
        let mut key_bytes = Zeroizing::new([0u8; Self::LEN]);

        getrandom::fill(&mut key_bytes[..]).map_err(|_| OwnerWrapError::RandomnessUnavailable)?;
        Ok(MasterKey(key_bytes))
    }
}

impl LoginProof {
    pub const LEN: usize = 32;

    pub fn as_bytes(&self) -> &[u8; Self::LEN] {
        &self.0
    }

    pub(crate) fn from_bytes(bytes: Zeroizing<[u8; Self::LEN]>) -> LoginProof {
        LoginProof(bytes)
    }
}

impl TitleKey {
    pub(crate) fn expose_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl LabelKey {
    pub(crate) fn expose_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::{ASSET_ID, K_ALBUM, hex};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

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

        let k_asset: AssetKey = k_album.derive_asset(&AssetId::from_bytes(asset_id_bytes));
        let k_thumb: ThumbKey = k_album.derive_thumb(&AssetId::from_bytes(asset_id_bytes));
        let k_meta: MetaKey = k_album.derive_meta(&AssetId::from_bytes(asset_id_bytes));
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

    // Title and Label Derivation Tests
    // ----------------------------------------------------

    fn derive_title_and_label(album_bytes: [u8; 32], id_bytes: [u8; 16]) -> (TitleKey, LabelKey) {
        let k_album: AlbumKey = AlbumKey::from_bytes(album_bytes);

        let k_title: TitleKey = k_album.derive_title(&AlbumId::from_bytes(id_bytes));
        let k_label: LabelKey = k_album.derive_label(&RecipientId::from_bytes(id_bytes));
        (k_title, k_label)
    }

    /// §2 written out by hand: BLAKE2b-256(key = K_album, msg = domain ‖ id), with
    /// the domain typed here as a literal rather than read from the constant. Pins
    /// the domain strings and the message layout; the primitive is pinned above.
    #[test]
    fn title_and_label_match_section_2_construction() {
        let (k_title, k_label) = derive_title_and_label(K_ALBUM, ASSET_ID);

        let title_msg: Vec<u8> = [b"vitrina-title-v1".as_slice(), &ASSET_ID].concat();
        let label_msg: Vec<u8> = [b"vitrina-label-v1".as_slice(), &ASSET_ID].concat();

        assert_eq!(k_title.expose_bytes(), &keyed_blake2b_256(&K_ALBUM, &title_msg));
        assert_eq!(k_label.expose_bytes(), &keyed_blake2b_256(&K_ALBUM, &label_msg));
    }

    /// The collision argument as a test: the same 16 id bytes fed to all five
    /// derivations give five different keys, so an `album_id` that happens to equal
    /// an `asset_id` or a `recipient_id` cannot yield a shared key.
    #[test]
    fn all_five_derivations_differ_for_the_same_id_bytes() {
        let (k_asset, k_thumb, k_meta) = derive_keys_from_bytes(K_ALBUM, ASSET_ID);
        let (k_title, k_label) = derive_title_and_label(K_ALBUM, ASSET_ID);

        let keys: [(&str, &[u8; 32]); 5] = [
            ("asset", k_asset.expose_bytes()),
            ("thumb", k_thumb.expose_bytes()),
            ("meta", k_meta.expose_bytes()),
            ("title", k_title.expose_bytes()),
            ("label", k_label.expose_bytes()),
        ];

        for (i, (name_a, a)) in keys.iter().enumerate() {
            for (name_b, b) in &keys[i + 1..] {
                assert_ne!(a, b, "K_{name_a} == K_{name_b}");
            }
        }
    }

    #[test]
    fn title_and_label_unequal_to_album_key() {
        let (k_title, k_label) = derive_title_and_label(K_ALBUM, ASSET_ID);

        assert_ne!(k_title.expose_bytes(), &K_ALBUM);
        assert_ne!(k_label.expose_bytes(), &K_ALBUM);
    }

    #[test]
    fn flipping_id_derives_different_title_and_label_keys() {
        let mut other: [u8; 16] = ASSET_ID;
        other[0] ^= 1;

        let (k_title, k_label) = derive_title_and_label(K_ALBUM, ASSET_ID);
        let (other_k_title, other_k_label) = derive_title_and_label(K_ALBUM, other);

        assert_ne!(k_title.expose_bytes(), other_k_title.expose_bytes());
        assert_ne!(k_label.expose_bytes(), other_k_label.expose_bytes());
    }

    #[test]
    fn flipping_k_album_derives_different_title_and_label_keys() {
        let mut other: [u8; 32] = K_ALBUM;
        other[0] ^= 1;

        let (k_title, k_label) = derive_title_and_label(K_ALBUM, ASSET_ID);
        let (other_k_title, other_k_label) = derive_title_and_label(other, ASSET_ID);

        assert_ne!(k_title.expose_bytes(), other_k_title.expose_bytes());
        assert_ne!(k_label.expose_bytes(), other_k_label.expose_bytes());
    }

    // Album Key Length Tests
    // ----------------------------------------------------
    #[test]
    fn accepts_album_key_exact_length_and_preserves_bytes() {
        assert_eq!(
            AlbumKey::try_from_slice(&K_ALBUM).unwrap().expose_bytes(),
            &K_ALBUM
        );
    }

    #[test]
    fn rejects_empty_album_key() {
        assert_eq!(
            AlbumKey::try_from_slice(&[]).err(),
            Some(WrongLength {
                got: 0,
                expected: AlbumKey::LEN
            })
        );
    }

    #[test]
    fn rejects_short_album_key() {
        assert_eq!(
            AlbumKey::try_from_slice(&[0u8; 15]).err(),
            Some(WrongLength {
                got: 15,
                expected: AlbumKey::LEN
            })
        );
    }

    #[test]
    fn rejects_long_album_key() {
        assert_eq!(
            AlbumKey::try_from_slice(&[0u8; 35]).err(),
            Some(WrongLength {
                got: 35,
                expected: AlbumKey::LEN
            })
        );
    }
}
