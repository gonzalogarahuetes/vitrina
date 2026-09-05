use crate::AlbumKey;
use crate::AssetKey;
use crate::Header;
use crate::ThumbKey;

#[rustfmt::skip]
    pub(crate) const GOLDEN: [u8; 64] = [
        0x56, 0x54, 0x52, 0x4E,                         //  0  magic  VTRN
        0x01,                                           //  4  version
        0x01,                                           //  5  cipher
        0x00, 0x00,                                     //  6  reserved
        0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, //  8  base_nonce
        0xA8, 0xA9, 0xAA, 0xAB, 0xAC, 0xAD, 0xAE, 0xAF,
        0x00, 0x00, 0x04, 0x00,                         // 24  chunk_size       262144
        0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, // 28  plaintext_length 262145
        0xB0, 0xB1, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, // 36  asset_id
        0xB8, 0xB9, 0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00,             // 52  padding
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ];

pub(crate) fn header_with(chunk_size: u32, plaintext_length: u64) -> Header {
    let mut b: [u8; 64] = GOLDEN;
    b[24..28].copy_from_slice(&chunk_size.to_le_bytes());
    b[28..36].copy_from_slice(&plaintext_length.to_le_bytes());
    Header::parse(&b).expect("template with valid sizes")
}

#[rustfmt::skip]
    pub(crate) const K_ALBUM: [u8; 32] = [
        0xC0, 0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7,
        0xC8, 0xC9, 0xCA, 0xCB, 0xCC, 0xCD, 0xCE, 0xCF,
        0xD0, 0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7,
        0xD8, 0xD9, 0xDA, 0xDB, 0xDC, 0xDD, 0xDE, 0xDF,
    ];

#[rustfmt::skip]
    pub(crate) const ASSET_ID: [u8; 16] = [
        0xB0, 0xB1, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7,
        0xB8, 0xB9, 0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF,
    ];

#[rustfmt::skip]
    pub(crate) const PLAINTEXT: &[u8] = b"Sometimes it is useful to have default behavior for some or all of the methods in a trait instead of requiring implementations for all methods on every type.";

/// Mirrors the `printf("%02x", ...)` the .exp files were generated with, so
/// a failure prints something greppable against the source file.
pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b: &u8| format!("{b:02x}")).collect()
}

pub(crate) fn asset_key() -> AssetKey {
    AlbumKey::from_bytes(K_ALBUM).derive_asset(&ASSET_ID)
}

pub(crate) fn thumb_key() -> ThumbKey {
    AlbumKey::from_bytes(K_ALBUM).derive_thumb(&ASSET_ID)
}
