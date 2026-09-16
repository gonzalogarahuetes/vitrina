//! wasm-bindgen binding for `vitrina-envelope` (phase-0 plan §7, C.10).
//! Every fixed-size input is validated here; the crate computes the lengths and
//! this crate adds the JavaScript parameter name.

mod error;

use error::{Failure, u32_param, wrong_length};
use vitrina_envelope as envelope;
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

/// `K_album` as an opaque handle. It crosses the boundary inward only (§2.2):
/// there is deliberately no method returning its bytes.
#[wasm_bindgen]
pub struct AlbumKey(envelope::AlbumKey);

#[wasm_bindgen]
impl AlbumKey {
    #[wasm_bindgen(js_name = fromBytes)]
    pub fn from_bytes(
        #[wasm_bindgen(js_name = albumKey)] album_key: &[u8],
    ) -> Result<AlbumKey, JsValue> {
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
    #[wasm_bindgen(js_name = assetId)] asset_id: &[u8],
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
    #[wasm_bindgen(js_name = assetId)] asset_id: &[u8],
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
    #[wasm_bindgen(js_name = assetId)] asset_id: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, JsValue> {
    envelope_result(envelope::encrypt_meta(
        &album.0,
        self::asset_id(asset_id)?,
        plaintext,
    ))
}

#[wasm_bindgen(js_name = decryptAsset)]
pub fn decrypt_asset(
    album: &AlbumKey,
    #[wasm_bindgen(js_name = assetId)] asset_id: &[u8],
    object: &[u8],
) -> Result<Vec<u8>, JsValue> {
    envelope_result(envelope::decrypt_asset(
        &album.0,
        &self::asset_id(asset_id)?,
        object,
    ))
}

#[wasm_bindgen(js_name = decryptThumb)]
pub fn decrypt_thumb(
    album: &AlbumKey,
    #[wasm_bindgen(js_name = assetId)] asset_id: &[u8],
    object: &[u8],
) -> Result<Vec<u8>, JsValue> {
    envelope_result(envelope::decrypt_thumb(
        &album.0,
        &self::asset_id(asset_id)?,
        object,
    ))
}

#[wasm_bindgen(js_name = decryptMeta)]
pub fn decrypt_meta(
    album: &AlbumKey,
    #[wasm_bindgen(js_name = assetId)] asset_id: &[u8],
    object: &[u8],
) -> Result<Vec<u8>, JsValue> {
    envelope_result(envelope::decrypt_meta(
        &album.0,
        &self::asset_id(asset_id)?,
        object,
    ))
}

fn recipient_id(bytes: &[u8]) -> Result<envelope::RecipientId, JsValue> {
    envelope::RecipientId::try_from_slice(bytes).map_err(|e| wrong_length("recipientId", e).into())
}

/// A 16-byte Argon2id salt (§6.2). Not secret: the relay stores it.
#[wasm_bindgen]
pub struct Salt(envelope::Salt);

#[wasm_bindgen]
impl Salt {
    #[wasm_bindgen(js_name = fromBytes)]
    pub fn from_bytes(salt: &[u8]) -> Result<Salt, JsValue> {
        envelope::Salt::try_from_slice(salt)
            .map(Salt)
            .map_err(|e| wrong_length("salt", e).into())
    }

    #[wasm_bindgen(getter)]
    pub fn bytes(&self) -> Vec<u8> {
        self.0.as_bytes().to_vec()
    }
}

/// Argon2id parameters, stored per recipient (§6.2). The three inputs are
/// checked as JavaScript values before any integer conversion, because ToInt32
/// would fold 2**32 + 8 into 8 and the crate could never tell.
#[wasm_bindgen]
pub struct WrapParams(envelope::WrapParams);

#[wasm_bindgen]
impl WrapParams {
    #[wasm_bindgen(constructor)]
    pub fn new(
        #[wasm_bindgen(js_name = mCostKib, unchecked_param_type = "number")] m_cost_kib: JsValue,
        #[wasm_bindgen(js_name = tCost, unchecked_param_type = "number")] t_cost: JsValue,
        #[wasm_bindgen(js_name = pCost, unchecked_param_type = "number")] p_cost: JsValue,
    ) -> Result<WrapParams, JsValue> {
        let m_cost_kib: u32 = u32_param(&m_cost_kib, "mCostKib")?;
        let t_cost: u32 = u32_param(&t_cost, "tCost")?;
        let p_cost: u32 = u32_param(&p_cost, "pCost")?;
        envelope::WrapParams::new(m_cost_kib, t_cost, p_cost)
            .map(WrapParams)
            .map_err(|e| Failure::from(e).into())
    }

    /// §6.2's version 1 parameters: 64 MiB, t = 3, p = 1.
    pub fn v1() -> WrapParams {
        WrapParams(envelope::WrapParams::V1)
    }
}

/// What the relay stores for a passphrase recipient, minus the parameters
/// (§6.2). All three parts are ciphertext or public values.
#[wasm_bindgen]
pub struct WrappedKey(envelope::WrappedKey);

#[wasm_bindgen]
impl WrappedKey {
    #[wasm_bindgen(js_name = fromParts)]
    pub fn from_parts(
        wrapped: &[u8],
        #[wasm_bindgen(js_name = wrapNonce)] wrap_nonce: &[u8],
        #[wasm_bindgen(js_name = kdfSalt)] kdf_salt: &[u8],
    ) -> Result<WrappedKey, JsValue> {
        let salt: envelope::Salt =
            envelope::Salt::try_from_slice(kdf_salt).map_err(|e| wrong_length("kdfSalt", e))?;
        // try_from_parts checks `wrapped` first, then `wrap_nonce`, and reports
        // the first mismatch; the expected length tells the caller which.
        envelope::WrappedKey::try_from_parts(wrapped, wrap_nonce, salt)
            .map(WrappedKey)
            .map_err(|e| {
                let param = if e.expected == envelope::WrappedKey::WRAPPED_LEN {
                    "wrapped"
                } else {
                    "wrapNonce"
                };
                wrong_length(param, e).into()
            })
    }

    #[wasm_bindgen(getter)]
    pub fn wrapped(&self) -> Vec<u8> {
        self.0.wrapped.to_vec()
    }

    #[wasm_bindgen(getter, js_name = wrapNonce)]
    pub fn wrap_nonce(&self) -> Vec<u8> {
        self.0.wrap_nonce.to_vec()
    }

    #[wasm_bindgen(getter, js_name = kdfSalt)]
    pub fn kdf_salt(&self) -> Vec<u8> {
        self.0.kdf_salt.as_bytes().to_vec()
    }
}

#[wasm_bindgen(js_name = wrapAlbumKey)]
pub fn wrap_album_key(
    album: &AlbumKey,
    passphrase: &str,
    params: &WrapParams,
    #[wasm_bindgen(js_name = recipientId)] recipient_id: &[u8],
) -> Result<WrappedKey, JsValue> {
    envelope::wrap_album_key(
        &album.0,
        passphrase,
        params.0,
        self::recipient_id(recipient_id)?,
    )
    .map(WrappedKey)
    .map_err(|e| Failure::from(e).into())
}

#[wasm_bindgen(js_name = unwrapAlbumKey)]
pub fn unwrap_album_key(
    passphrase: &str,
    params: &WrapParams,
    #[wasm_bindgen(js_name = recipientId)] recipient_id: &[u8],
    wrapped: &WrappedKey,
) -> Result<AlbumKey, JsValue> {
    envelope::unwrap_album_key(
        passphrase,
        params.0,
        self::recipient_id(recipient_id)?,
        &wrapped.0,
    )
    .map(AlbumKey)
    .map_err(|e| Failure::from(e).into())
}

fn album_id(bytes: &[u8]) -> Result<envelope::AlbumId, JsValue> {
    envelope::AlbumId::try_from_slice(bytes).map_err(|e| wrong_length("albumId", e).into())
}

/// `K_master` as an opaque handle (§2, §6.6). It unwraps every album in the
/// account, so like `AlbumKey` it crosses the boundary inward only (§2.2):
/// there is deliberately no method returning its bytes.
#[wasm_bindgen]
pub struct MasterKey(envelope::MasterKey);

#[wasm_bindgen]
impl MasterKey {
    #[wasm_bindgen(js_name = fromBytes)]
    pub fn from_bytes(
        #[wasm_bindgen(js_name = masterKey)] master_key: &[u8],
    ) -> Result<MasterKey, JsValue> {
        envelope::MasterKey::try_from_slice(master_key)
            .map(MasterKey)
            .map_err(|e| wrong_length("masterKey", e).into())
    }

    /// Signup (§6.6.2): `K_master` is drawn inside the module and never
    /// exists as JavaScript bytes.
    pub fn generate() -> Result<MasterKey, JsValue> {
        envelope::MasterKey::generate()
            .map(MasterKey)
            .map_err(|e| Failure::from(e).into())
    }
}

/// What the relay stores for an album wrapped under `K_master` (§2). No salt:
/// there is no KDF, `K_master` is given rather than derived. Both parts are
/// ciphertext or public values.
#[wasm_bindgen]
pub struct MasterWrappedKey(envelope::MasterWrappedKey);

#[wasm_bindgen]
impl MasterWrappedKey {
    #[wasm_bindgen(js_name = fromParts)]
    pub fn from_parts(
        wrapped: &[u8],
        #[wasm_bindgen(js_name = wrapNonce)] wrap_nonce: &[u8],
    ) -> Result<MasterWrappedKey, JsValue> {
        // try_from_parts checks `wrapped` first, then `wrap_nonce`, and reports
        // the first mismatch; the expected length tells the caller which.
        envelope::MasterWrappedKey::try_from_parts(wrapped, wrap_nonce)
            .map(MasterWrappedKey)
            .map_err(|e| {
                let param = if e.expected == envelope::MasterWrappedKey::WRAPPED_LEN {
                    "wrapped"
                } else {
                    "wrapNonce"
                };
                wrong_length(param, e).into()
            })
    }

    #[wasm_bindgen(getter)]
    pub fn wrapped(&self) -> Vec<u8> {
        self.0.wrapped.to_vec()
    }

    #[wasm_bindgen(getter, js_name = wrapNonce)]
    pub fn wrap_nonce(&self) -> Vec<u8> {
        self.0.wrap_nonce.to_vec()
    }
}

#[wasm_bindgen(js_name = wrapAlbumKeyWithMaster)]
pub fn wrap_album_key_with_master(
    album: &AlbumKey,
    master: &MasterKey,
    #[wasm_bindgen(js_name = albumId)] album_id: &[u8],
) -> Result<MasterWrappedKey, JsValue> {
    envelope::wrap_album_key_with_master(&album.0, &master.0, &self::album_id(album_id)?)
        .map(MasterWrappedKey)
        .map_err(|e| Failure::from(e).into())
}

#[wasm_bindgen(js_name = unwrapAlbumKeyWithMaster)]
pub fn unwrap_album_key_with_master(
    wrapped: &MasterWrappedKey,
    master: &MasterKey,
    #[wasm_bindgen(js_name = albumId)] album_id: &[u8],
) -> Result<AlbumKey, JsValue> {
    envelope::unwrap_album_key_with_master(&wrapped.0, &master.0, &self::album_id(album_id)?)
        .map(AlbumKey)
        .map_err(|e| Failure::from(e).into())
}

/// The owner KEK (§6.6.2) as an opaque handle. It outlives one network round
/// trip — derived before `POST /login`, used after `GET /owner/key` — which is
/// why it is a handle and not a value inside one call. No constructor and no
/// accessor: `deriveOwnerCredential` is its only source (§2.2).
#[wasm_bindgen]
pub struct OwnerKek(envelope::OwnerKek);

/// What one password derivation yields (§6.6.2). `proof` is bytes because it
/// is sent to the relay; the KEK is taken out once with `intoKek`, which
/// consumes this object — a second call throws.
#[wasm_bindgen]
pub struct OwnerCredential {
    kek: envelope::OwnerKek,
    proof: envelope::LoginProof,
}

#[wasm_bindgen]
impl OwnerCredential {
    /// The login proof, 32 bytes. The caller should zero the array after it
    /// has been sent — a proof is a replayable credential.
    #[wasm_bindgen(getter)]
    pub fn proof(&self) -> Vec<u8> {
        self.proof.as_bytes().to_vec()
    }

    /// Consumes the credential. wasm-bindgen nulls the JavaScript handle, so
    /// the KEK can be extracted exactly once.
    #[wasm_bindgen(js_name = intoKek)]
    pub fn into_kek(self) -> OwnerKek {
        OwnerKek(self.kek)
    }
}

/// §6.6.2: one Argon2id run over the NFC password, two keyed-hash outputs.
///
/// `password` is taken by value so the copy wasm-bindgen makes into linear
/// memory can be wiped. The JavaScript string it came from cannot be; that is
/// a property of the platform, not of this binding.
#[wasm_bindgen(js_name = deriveOwnerCredential)]
pub fn derive_owner_credential(
    password: String,
    salt: &[u8],
    params: &WrapParams,
) -> Result<OwnerCredential, JsValue> {
    let password = Zeroizing::new(password);
    let salt = envelope::Salt::try_from_slice(salt).map_err(|e| wrong_length("salt", e))?;
    envelope::derive_owner_credential(password.as_str(), params.0, salt)
        .map(|(kek, proof)| OwnerCredential { kek, proof })
        .map_err(|e| Failure::from(e).into())
}

/// What the relay stores in `owner_keys` for the password credential, minus
/// the salt and parameters (§6.6.2). Both parts are ciphertext or public.
#[wasm_bindgen]
pub struct WrappedMaster(envelope::WrappedMaster);

#[wasm_bindgen]
impl WrappedMaster {
    #[wasm_bindgen(js_name = fromParts)]
    pub fn from_parts(
        wrapped: &[u8],
        #[wasm_bindgen(js_name = wrapNonce)] wrap_nonce: &[u8],
    ) -> Result<WrappedMaster, JsValue> {
        // try_from_parts checks `wrapped` first, then `wrap_nonce`, and reports
        // the first mismatch; the expected length tells the caller which.
        envelope::WrappedMaster::try_from_parts(wrapped, wrap_nonce)
            .map(WrappedMaster)
            .map_err(|e| {
                let param = if e.expected == envelope::WrappedMaster::WRAPPED_LEN {
                    "wrapped"
                } else {
                    "wrapNonce"
                };
                wrong_length(param, e).into()
            })
    }

    #[wasm_bindgen(getter)]
    pub fn wrapped(&self) -> Vec<u8> {
        self.0.wrapped.to_vec()
    }

    #[wasm_bindgen(getter, js_name = wrapNonce)]
    pub fn wrap_nonce(&self) -> Vec<u8> {
        self.0.wrap_nonce.to_vec()
    }
}

#[wasm_bindgen(js_name = wrapMasterKey)]
pub fn wrap_master_key(kek: &OwnerKek, master: &MasterKey) -> Result<WrappedMaster, JsValue> {
    envelope::wrap_master_key(&kek.0, &master.0)
        .map(WrappedMaster)
        .map_err(|e| Failure::from(e).into())
}

#[wasm_bindgen(js_name = unwrapMasterKey)]
pub fn unwrap_master_key(kek: &OwnerKek, wrapped: &WrappedMaster) -> Result<MasterKey, JsValue> {
    envelope::unwrap_master_key(&kek.0, &wrapped.0)
        .map(MasterKey)
        .map_err(|e| Failure::from(e).into())
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

#[wasm_bindgen(js_name = saltLen)]
pub fn salt_len() -> u32 {
    envelope::Salt::LEN as u32
}

#[wasm_bindgen(js_name = recipientIdLen)]
pub fn recipient_id_len() -> u32 {
    envelope::RecipientId::LEN as u32
}

#[wasm_bindgen(js_name = wrappedLen)]
pub fn wrapped_len() -> u32 {
    envelope::WrappedKey::WRAPPED_LEN as u32
}

#[wasm_bindgen(js_name = wrapNonceLen)]
pub fn wrap_nonce_len() -> u32 {
    envelope::WrappedKey::WRAP_NONCE_LEN as u32
}

#[wasm_bindgen(js_name = albumIdLen)]
pub fn album_id_len() -> u32 {
    envelope::AlbumId::LEN as u32
}

#[wasm_bindgen(js_name = masterKeyLen)]
pub fn master_key_len() -> u32 {
    envelope::MasterKey::LEN as u32
}

// §2's album wrap and §6.2's passphrase wrap are independent constructions
// whose lengths currently agree; each reads its own constant.
#[wasm_bindgen(js_name = masterWrappedLen)]
pub fn master_wrapped_len() -> u32 {
    envelope::MasterWrappedKey::WRAPPED_LEN as u32
}

#[wasm_bindgen(js_name = masterWrapNonceLen)]
pub fn master_wrap_nonce_len() -> u32 {
    envelope::MasterWrappedKey::WRAP_NONCE_LEN as u32
}

// §6.6.2's lengths table — the third construction, reading its own constants.
#[wasm_bindgen(js_name = ownerWrappedLen)]
pub fn owner_wrapped_len() -> u32 {
    envelope::WrappedMaster::WRAPPED_LEN as u32
}

#[wasm_bindgen(js_name = ownerWrapNonceLen)]
pub fn owner_wrap_nonce_len() -> u32 {
    envelope::WrappedMaster::WRAP_NONCE_LEN as u32
}

#[wasm_bindgen(js_name = loginProofLen)]
pub fn login_proof_len() -> u32 {
    envelope::LoginProof::LEN as u32
}
