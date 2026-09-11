//! wasm-bindgen binding for `vitrina-envelope` (phase-0 plan §7, C.10).
//! Every fixed-size input is validated here; the crate computes the lengths and
//! this crate adds the JavaScript parameter name.

mod error;

use error::{Failure, wrong_length};
use vitrina_envelope as envelope;
use wasm_bindgen::prelude::*;

/// `K_album` as an opaque handle. It crosses the boundary inward only (§2.2):
/// there is deliberately no method returning its bytes.
#[wasm_bindgen]
pub struct AlbumKey(envelope::AlbumKey);

#[wasm_bindgen]
impl AlbumKey {
    #[wasm_bindgen(js_name = fromBytes)]
    pub fn from_bytes(album_key: &[u8]) -> Result<AlbumKey, JsValue> {
        envelope::AlbumKey::try_from_slice(album_key)
            .map(AlbumKey)
            .map_err(|e| wrong_length("albumKey", e).into())
    }
}

fn asset_id(bytes: &[u8]) -> Result<envelope::AssetId, JsValue> {
    envelope::AssetId::try_from_slice(bytes).map_err(|e| wrong_length("assetId", e).into())
}

fn envelope_result(r: Result<Vec<u8>, envelope::EnvelopeError>) -> Result<Vec<u8>, JsValue> {
    r.map_err(|e| Failure::from(e).into())
}

#[wasm_bindgen(js_name = encryptAsset)]
pub fn encrypt_asset(
    album: &AlbumKey,
    asset_id: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, JsValue> {
    envelope_result(envelope::encrypt_asset(
        &album.0,
        self::asset_id(asset_id)?,
        plaintext,
    ))
}

#[wasm_bindgen(js_name = encryptThumb)]
pub fn encrypt_thumb(
    album: &AlbumKey,
    asset_id: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, JsValue> {
    envelope_result(envelope::encrypt_thumb(
        &album.0,
        self::asset_id(asset_id)?,
        plaintext,
    ))
}

#[wasm_bindgen(js_name = encryptMeta)]
pub fn encrypt_meta(
    album: &AlbumKey,
    asset_id: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, JsValue> {
    envelope_result(envelope::encrypt_meta(
        &album.0,
        self::asset_id(asset_id)?,
        plaintext,
    ))
}

#[wasm_bindgen(js_name = decryptAsset)]
pub fn decrypt_asset(album: &AlbumKey, asset_id: &[u8], object: &[u8]) -> Result<Vec<u8>, JsValue> {
    envelope_result(envelope::decrypt_asset(
        &album.0,
        &self::asset_id(asset_id)?,
        object,
    ))
}

#[wasm_bindgen(js_name = decryptThumb)]
pub fn decrypt_thumb(album: &AlbumKey, asset_id: &[u8], object: &[u8]) -> Result<Vec<u8>, JsValue> {
    envelope_result(envelope::decrypt_thumb(
        &album.0,
        &self::asset_id(asset_id)?,
        object,
    ))
}

#[wasm_bindgen(js_name = decryptMeta)]
pub fn decrypt_meta(album: &AlbumKey, asset_id: &[u8], object: &[u8]) -> Result<Vec<u8>, JsValue> {
    envelope_result(envelope::decrypt_meta(
        &album.0,
        &self::asset_id(asset_id)?,
        object,
    ))
}

// wasm-bindgen cannot export constants, so the crate's lengths are functions.

#[wasm_bindgen(js_name = chunkSize)]
pub fn chunk_size() -> u32 {
    envelope::CHUNK_SIZE
}

#[wasm_bindgen(js_name = albumKeyLen)]
pub fn album_key_len() -> u32 {
    envelope::AlbumKey::LEN as u32
}

#[wasm_bindgen(js_name = assetIdLen)]
pub fn asset_id_len() -> u32 {
    envelope::AssetId::LEN as u32
}
