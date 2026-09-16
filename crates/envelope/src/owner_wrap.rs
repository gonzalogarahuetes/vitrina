//! Owner key wrapping — §6.6.2: `K_master` under a password-derived KEK.
//! Third wrap, third module: §6.2 binds `recipient_id`, §2 binds `album_id`,
//! this binds nothing. Own length constants, so one construction can't move another.

use argon2::{Algorithm, Argon2, Version};
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

use crate::{
    MasterKey, Salt, WrapParams, WrongLength,
    aead::{AeadError, aead_decrypt, aead_encrypt},
    keys::{LoginProof, OwnerKek, cipher_for, keyed_blake2b_256},
    wrap::InvalidParams,
};

// §2's convention: ASCII, no terminator, no length prefix. The labels are all
// that keeps KEK and proof independent (§6.6), so changing one is a format change.
pub(crate) const OWNER_KEK_LABEL: &[u8; 20] = b"vitrina-owner-kek-v1";
pub(crate) const OWNER_PROOF_LABEL: &[u8; 22] = b"vitrina-owner-proof-v1";

// Domain string alone, no id: an owner id is server-assigned and doesn't exist
// at signup (§6.6.2; brief §9.3). Nothing to concatenate, so no `*_aad()` fn.
pub(crate) const MASTER_WRAP_AAD: &[u8; 22] = b"vitrina-master-wrap-v1";

#[derive(Debug, PartialEq)]
pub enum OwnerWrapError {
    InvalidParams(InvalidParams),
    HashingFailed,
    EmptyPassword,
    UnexpectedWrappedLength,
    RandomnessUnavailable,
    UnexpectedKeyLength,
    AuthenticationFailed,
}

impl From<AeadError> for OwnerWrapError {
    /// Exhaustive on purpose: if `AeadError` gains a variant that isn't an
    /// authentication failure, this must fail to compile.
    fn from(e: AeadError) -> Self {
        match e {
            AeadError::AuthenticationFailed => OwnerWrapError::AuthenticationFailed,
        }
    }
}

impl From<InvalidParams> for OwnerWrapError {
    fn from(e: InvalidParams) -> Self {
        OwnerWrapError::InvalidParams(e)
    }
}

/// The `owner_keys` password row minus salt and parameters (§6.6.2).
/// Both parts are ciphertext or public.
#[derive(Debug, Clone, PartialEq)]
pub struct WrappedMaster {
    /// `K_master` (32) plus the Poly1305 tag (16).
    pub wrapped: [u8; 48],
    pub wrap_nonce: [u8; 24],
    // No `kdf_salt`, unlike `WrappedKey`: the KDF ran in `derive_owner_credential`,
    // a round trip before this struct exists. The salt travels on its own row.
}

impl WrappedMaster {
    pub const WRAPPED_LEN: usize = 48;
    pub const WRAP_NONCE_LEN: usize = 24;

    pub fn try_from_parts(wrapped: &[u8], wrap_nonce: &[u8]) -> Result<WrappedMaster, WrongLength> {
        let wrapped_bytes: [u8; Self::WRAPPED_LEN] =
            wrapped.try_into().map_err(|_| WrongLength {
                expected: Self::WRAPPED_LEN,
                got: wrapped.len(),
            })?;
        let wrap_nonce_bytes: [u8; Self::WRAP_NONCE_LEN] =
            wrap_nonce.try_into().map_err(|_| WrongLength {
                expected: Self::WRAP_NONCE_LEN,
                got: wrap_nonce.len(),
            })?;
        Ok(WrappedMaster {
            wrapped: wrapped_bytes,
            wrap_nonce: wrap_nonce_bytes,
        })
    }
}

/// One Argon2id run, two outputs with two lifetimes (§6.6.2): the proof leaves at
/// `POST /login`; the KEK must outlive it until `GET /owner/key` (api-sketch §8.4).
/// The password is read once, here. A keyed-hash output does not yield its key (§6.6).
pub fn derive_owner_credential(
    password: &str,
    params: WrapParams,
    salt: Salt,
) -> Result<(OwnerKek, LoginProof), OwnerWrapError> {
    // §6.6.2: the empty string and nothing else — "   " is legal, unlike §6.3.
    // Checked before NFC: NFC never empties a non-empty string, and this skips an alloc.
    if password.is_empty() {
        return Err(OwnerWrapError::EmptyPassword);
    }

    // NFC only, never `normalize_passphrase` — folding discards entropy the owner
    // chose (§6.6.2).
    let mut s = String::with_capacity(password.len());
    s.extend(password.nfc());
    let nfc_password = Zeroizing::new(s);

    // Early return: nothing secret exists yet except `nfc_password`, which zeroizes.
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params.argon2_params()?);

    let mut root = Zeroizing::new([0u8; 32]);

    // Early return: `root` may be half-written on failure; Zeroizing wipes it either way.
    argon2
        .hash_password_into(nfc_password.as_bytes(), salt.as_bytes(), &mut root[..])
        .map_err(|_| OwnerWrapError::HashingFailed)?;

    // Wrapped at the call, not bound as a plain `[u8; 32]` first: no unzeroized
    // `Copy` left on the stack. Root is dropped once both exist (§6.6.2), not at scope end.
    let kek = Zeroizing::new(keyed_blake2b_256(&root, OWNER_KEK_LABEL));
    let proof = Zeroizing::new(keyed_blake2b_256(&root, OWNER_PROOF_LABEL));
    drop(root);

    Ok((OwnerKek::from_bytes(kek), LoginProof::from_bytes(proof)))
}

/// Crate-private so the known-answer test and vector generator can fix the nonce.
/// No public entry point accepts one (§4.1's rule for wraps; §9.3 depends on it).
pub(crate) fn wrap_master_key_with_nonce(
    kek: &OwnerKek,
    master_key: &MasterKey,
    wrap_nonce: &[u8; 24],
) -> Result<[u8; 48], OwnerWrapError> {
    let cipher = cipher_for(kek.expose_bytes());

    aead_encrypt(
        &cipher,
        wrap_nonce,
        MASTER_WRAP_AAD,
        master_key.expose_bytes(),
    )
    .try_into()
    .map_err(|_| OwnerWrapError::UnexpectedWrappedLength)
}

/// Signup, and a future password change (api-sketch §8.5). Fresh CSPRNG nonce per call.
pub fn wrap_master_key(
    kek: &OwnerKek,
    master_key: &MasterKey,
) -> Result<WrappedMaster, OwnerWrapError> {
    let mut wrap_nonce = [0u8; 24];

    getrandom::fill(&mut wrap_nonce).map_err(|_| OwnerWrapError::RandomnessUnavailable)?;

    let wrapped: [u8; 48] = wrap_master_key_with_nonce(kek, master_key, &wrap_nonce)?;

    Ok(WrappedMaster {
        wrapped,
        wrap_nonce,
    })
}

/// Login step 4 (api-sketch §8.4): the KEK meets `wrapped_master` from `GET /owner/key`.
/// A wrong password fails here as `AuthenticationFailed`, not at derivation — though
/// the relay already rejected its proof, so in practice this catches a bad blob.
pub fn unwrap_master_key(
    kek: &OwnerKek,
    wrapped: &WrappedMaster,
) -> Result<MasterKey, OwnerWrapError> {
    let cipher = cipher_for(kek.expose_bytes());
    // Zeroizing covers the `try_into` error path below — the gap the other two wraps had.
    let plaintext: Zeroizing<Vec<u8>> = Zeroizing::new(aead_decrypt(
        &cipher,
        &wrapped.wrap_nonce,
        MASTER_WRAP_AAD,
        &wrapped.wrapped,
    )?);
    let bytes: [u8; 32] = plaintext[..]
        .try_into()
        .map_err(|_| OwnerWrapError::UnexpectedKeyLength)?;

    Ok(MasterKey::from_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use argon2::{Algorithm, Argon2, Version};
    use zeroize::Zeroizing;

    use crate::keys::{OwnerKek, keyed_blake2b_256};
    use crate::owner_wrap::{
        MASTER_WRAP_AAD, OWNER_KEK_LABEL, OWNER_PROOF_LABEL, OwnerWrapError, WrappedMaster,
        unwrap_master_key, wrap_master_key,
    };
    use crate::test_fixtures::{
        OWNER_PASSWORD, OWNER_SALT, OWNER_WRAP_NONCE, SALT, hex, low_params, master_key,
    };
    use crate::{MasterKey, WrapParams, WrongLength};
    use crate::{
        Salt,
        owner_wrap::{derive_owner_credential, wrap_master_key_with_nonce},
    };
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn owner_kek() -> OwnerKek {
        let (kek, _proof) =
            derive_owner_credential(OWNER_PASSWORD, low_params(), Salt::from_bytes(OWNER_SALT))
                .unwrap();
        kek
    }

    fn wrapped() -> [u8; 48] {
        wrap_master_key_with_nonce(&owner_kek(), &master_key(), &OWNER_WRAP_NONCE).unwrap()
    }

    fn wrapped_of_valid_length() -> [u8; WrappedMaster::WRAPPED_LEN] {
        std::array::from_fn(|i| i as u8)
    }

    /// Self-generated — see §9.2 on what that can and cannot
    /// catch. It pins the composition so a later refactor cannot silently
    /// change the bytes.
    const KNOWN_ANSWER_WRAPPED: &str = "45ae0e8bbf67890dba039c3b730a7a3cc58ba6ede2a1c58446b5ba34532d5e7dbbcfa52bc6e9083d208ade8203c19ec8";

    // Labels Tests
    // ----------------------------------------------------
    #[test]
    fn owner_kek_label_equals_literal_bytes() {
        assert_eq!(OWNER_KEK_LABEL, b"vitrina-owner-kek-v1");
    }

    #[test]
    fn owner_proof_label_equals_literal_bytes() {
        assert_eq!(OWNER_PROOF_LABEL, b"vitrina-owner-proof-v1");
    }

    #[test]
    fn master_wrap_aad_equals_literal_bytes() {
        assert_eq!(MASTER_WRAP_AAD, b"vitrina-master-wrap-v1");
    }

    // Master Key Tests
    // ----------------------------------------------------

    #[test]
    fn generates_unique_master_keys() {
        assert_ne!(
            MasterKey::generate().unwrap().expose_bytes(),
            MasterKey::generate().unwrap().expose_bytes()
        );
    }

    // Owner KEK Derivation Tests
    // ----------------------------------------------------

    #[test]
    fn creates_same_owner_kek_and_proof_with_same_inputs() {
        let (kek, proof) =
            derive_owner_credential(OWNER_PASSWORD, low_params(), Salt::from_bytes(OWNER_SALT))
                .unwrap();
        let (kek2, proof2) =
            derive_owner_credential(OWNER_PASSWORD, low_params(), Salt::from_bytes(OWNER_SALT))
                .unwrap();
        assert_eq!(kek.expose_bytes(), kek2.expose_bytes());
        assert_eq!(proof.as_bytes(), proof2.as_bytes());
    }

    #[test]
    fn owner_kek_and_login_proof_are_different() {
        let (kek, proof) =
            derive_owner_credential(OWNER_PASSWORD, low_params(), Salt::from_bytes(OWNER_SALT))
                .unwrap();
        assert_ne!(kek.expose_bytes(), proof.as_bytes());
    }

    #[test]
    fn case_and_marks_change_the_kek() {
        let (kek, _proof) =
            derive_owner_credential("Tr3s Pájaros!", low_params(), Salt::from_bytes(OWNER_SALT))
                .unwrap();
        let (kek2, _proof2) =
            derive_owner_credential("tres pajaros!", low_params(), Salt::from_bytes(OWNER_SALT))
                .unwrap();
        assert_ne!(kek.expose_bytes(), kek2.expose_bytes());
    }

    #[test]
    fn trailing_space_change_the_kek() {
        let (kek, _proof) =
            derive_owner_credential("Tr3s Pájaros!", low_params(), Salt::from_bytes(OWNER_SALT))
                .unwrap();
        let (kek2, _proof2) =
            derive_owner_credential("Tr3s Pájaros! ", low_params(), Salt::from_bytes(OWNER_SALT))
                .unwrap();
        assert_ne!(kek.expose_bytes(), kek2.expose_bytes());
    }

    #[test]
    fn double_interior_space_change_the_kek() {
        let (kek, _proof) =
            derive_owner_credential("Tr3s Pájaros!", low_params(), Salt::from_bytes(OWNER_SALT))
                .unwrap();
        let (kek2, _proof2) =
            derive_owner_credential("Tr3s  Pájaros!", low_params(), Salt::from_bytes(OWNER_SALT))
                .unwrap();
        assert_ne!(kek.expose_bytes(), kek2.expose_bytes());
    }

    #[test]
    fn creates_same_owner_kek_with_nfd_password() {
        let (kek, _proof) =
            derive_owner_credential("Tr3s Pájaros!", low_params(), Salt::from_bytes(OWNER_SALT))
                .unwrap();
        let (kek2, _proof2) = derive_owner_credential(
            "Tr3s Pa\u{0301}jaros!",
            low_params(),
            Salt::from_bytes(OWNER_SALT),
        )
        .unwrap();
        assert_eq!(kek.expose_bytes(), kek2.expose_bytes());
    }

    #[test]
    fn derives_owner_kek_at_v1_params() {
        assert!(
            derive_owner_credential(
                "Tr3s Pájaros!",
                WrapParams::V1,
                Salt::from_bytes(OWNER_SALT)
            )
            .is_ok()
        );
    }

    #[test]
    fn creates_different_owner_kek_with_different_salt() {
        let (kek2, _proof2) =
            derive_owner_credential(OWNER_PASSWORD, low_params(), Salt::from_bytes(SALT)).unwrap();
        assert_ne!(owner_kek().expose_bytes(), kek2.expose_bytes());
    }

    #[test]
    fn creates_different_owner_kek_with_different_password() {
        let (kek2, _proof2) =
            derive_owner_credential("Cu4tro Árboles", low_params(), Salt::from_bytes(OWNER_SALT))
                .unwrap();
        assert_ne!(owner_kek().expose_bytes(), kek2.expose_bytes());
    }

    #[test]
    fn creates_different_owner_kek_with_different_params() {
        let (kek2, _proof2) = derive_owner_credential(
            OWNER_PASSWORD,
            WrapParams::new(16, 1, 1).unwrap(),
            Salt::from_bytes(OWNER_SALT),
        )
        .unwrap();
        assert_ne!(owner_kek().expose_bytes(), kek2.expose_bytes());
    }

    #[test]
    fn derive_owner_kek_uses_argon2id() {
        let argon2id = Argon2::new(
            Algorithm::Argon2id,
            Version::V0x13,
            low_params().argon2_params().unwrap(),
        );

        let argon2i = Argon2::new(
            Algorithm::Argon2i,
            Version::V0x13,
            low_params().argon2_params().unwrap(),
        );

        let mut out_argon2id = Zeroizing::new([0u8; 32]);

        argon2id
            .hash_password_into(
                OWNER_PASSWORD.as_bytes(),
                &OWNER_SALT,
                &mut out_argon2id[..],
            )
            .unwrap();

        let mut out_argon2i = Zeroizing::new([0u8; 32]);
        argon2i
            .hash_password_into(OWNER_PASSWORD.as_bytes(), &OWNER_SALT, &mut out_argon2i[..])
            .unwrap();

        // Argon2id and Argon2i genuinely differ at these inputs, so the
        // equality below cannot pass vacuously.
        assert_ne!(&out_argon2id[..], &out_argon2i[..]);

        let (kek, proof) =
            derive_owner_credential(OWNER_PASSWORD, low_params(), Salt::from_bytes(OWNER_SALT))
                .unwrap();

        // derive_owner_credential's output IS the Argon2id computation — this is what pins
        // the algorithm, the version, the params and the normalisation at once.
        assert_eq!(
            kek.expose_bytes(),
            &keyed_blake2b_256(&out_argon2id, OWNER_KEK_LABEL)
        );

        assert_eq!(
            proof.as_bytes(),
            &keyed_blake2b_256(&out_argon2id, OWNER_PROOF_LABEL)
        )
    }

    #[test]
    fn rejects_with_empty_password() {
        assert_eq!(
            derive_owner_credential("", low_params(), Salt::from_bytes(OWNER_SALT)).err(),
            Some(OwnerWrapError::EmptyPassword)
        );
    }

    #[test]
    fn accepts_whitespace_only_password() {
        assert!(derive_owner_credential("   ", low_params(), Salt::from_bytes(OWNER_SALT)).is_ok());
    }

    #[test]
    fn accepts_lone_combining_mark() {
        assert!(
            derive_owner_credential("\u{0301}", low_params(), Salt::from_bytes(OWNER_SALT)).is_ok()
        );
    }

    // Wrap With Nonce Tests
    // ----------------------------------------------------
    #[test]
    fn matches_known_answer_wrapped() {
        assert_eq!(hex(&wrapped()), KNOWN_ANSWER_WRAPPED);
    }

    // Wrap Master Key Tests
    // ----------------------------------------------------
    #[test]
    fn wraps_and_unwraps_correctly() {
        let wrapped = wrap_master_key(&owner_kek(), &master_key()).unwrap();

        let unwrapped = unwrap_master_key(&owner_kek(), &wrapped).unwrap();

        assert_eq!(&master_key().expose_bytes(), &unwrapped.expose_bytes())
    }

    #[test]
    fn generates_fresh_nonce_every_time() {
        let wrapped_one = wrap_master_key(&owner_kek(), &master_key()).unwrap();

        let wrapped_two = wrap_master_key(&owner_kek(), &master_key()).unwrap();
        assert_ne!(wrapped_one.wrap_nonce, wrapped_two.wrap_nonce);
    }

    #[test]
    fn rejects_unwrap_with_wrong_password() {
        let (kek, _proof) =
            derive_owner_credential(OWNER_PASSWORD, low_params(), Salt::from_bytes(OWNER_SALT))
                .unwrap();

        let wrapped = wrap_master_key(&kek, &master_key()).unwrap();

        let (kek2, _proof2) =
            derive_owner_credential("Cu4tro Árboles", low_params(), Salt::from_bytes(OWNER_SALT))
                .unwrap();

        assert_eq!(
            unwrap_master_key(&kek2, &wrapped).err(),
            Some(OwnerWrapError::AuthenticationFailed)
        );
    }

    #[test]
    fn rejects_unwrap_with_wrong_salt() {
        let (kek, _proof) =
            derive_owner_credential(OWNER_PASSWORD, low_params(), Salt::from_bytes(OWNER_SALT))
                .unwrap();
        let wrapped = wrap_master_key(&kek, &master_key()).unwrap();

        let (kek2, _proof2) =
            derive_owner_credential(OWNER_PASSWORD, low_params(), Salt::from_bytes(SALT)).unwrap();

        assert_eq!(
            unwrap_master_key(&kek2, &wrapped).err(),
            Some(OwnerWrapError::AuthenticationFailed)
        );
    }

    #[test]
    fn rejects_unwrap_with_wrong_params() {
        let (kek, _proof) =
            derive_owner_credential(OWNER_PASSWORD, low_params(), Salt::from_bytes(OWNER_SALT))
                .unwrap();
        let wrapped = wrap_master_key(&kek, &master_key()).unwrap();

        let (kek2, _proof2) = derive_owner_credential(
            OWNER_PASSWORD,
            WrapParams::new(16, 1, 1).unwrap(),
            Salt::from_bytes(OWNER_SALT),
        )
        .unwrap();

        assert_eq!(
            unwrap_master_key(&kek2, &wrapped).err(),
            Some(OwnerWrapError::AuthenticationFailed)
        );
    }

    #[test]
    fn rejects_unwrap_with_flipped_wrapped() {
        let (kek, _proof) =
            derive_owner_credential(OWNER_PASSWORD, low_params(), Salt::from_bytes(OWNER_SALT))
                .unwrap();
        let wrapped = wrap_master_key(&kek, &master_key()).unwrap();

        let mut tampered = wrapped.clone();
        tampered.wrapped[0] ^= 1;

        let (kek2, _proof2) =
            derive_owner_credential(OWNER_PASSWORD, low_params(), Salt::from_bytes(OWNER_SALT))
                .unwrap();

        assert_eq!(
            unwrap_master_key(&kek2, &tampered).err(),
            Some(OwnerWrapError::AuthenticationFailed)
        );
    }

    #[test]
    fn rejects_unwrap_with_flipped_nonce() {
        let (kek, _proof) =
            derive_owner_credential(OWNER_PASSWORD, low_params(), Salt::from_bytes(OWNER_SALT))
                .unwrap();
        let wrapped = wrap_master_key(&kek, &master_key()).unwrap();

        let mut tampered = wrapped.clone();
        tampered.wrap_nonce[0] ^= 1;

        let (kek2, _proof2) =
            derive_owner_credential(OWNER_PASSWORD, low_params(), Salt::from_bytes(OWNER_SALT))
                .unwrap();

        assert_eq!(
            unwrap_master_key(&kek2, &tampered).err(),
            Some(OwnerWrapError::AuthenticationFailed)
        );
    }

    // Wrapped Master Length Tests
    // ----------------------------------------------------
    #[test]
    fn builds_wrapped_key_from_valid_parts() {
        let bytes: [u8; WrappedMaster::WRAPPED_LEN] = std::array::from_fn(|i| i as u8);
        assert_eq!(
            WrappedMaster::try_from_parts(&bytes, &OWNER_WRAP_NONCE).unwrap(),
            WrappedMaster {
                wrapped: bytes,
                wrap_nonce: OWNER_WRAP_NONCE,
            }
        );
    }

    #[test]
    fn rejects_short_wrapped() {
        let bytes: [u8; 40] = std::array::from_fn(|i| i as u8);
        assert_eq!(
            WrappedMaster::try_from_parts(&bytes, &OWNER_WRAP_NONCE).err(),
            Some(WrongLength {
                got: 40,
                expected: WrappedMaster::WRAPPED_LEN
            })
        );
    }

    #[test]
    fn rejects_long_wrapped() {
        let bytes: [u8; 50] = std::array::from_fn(|i| i as u8);
        assert_eq!(
            WrappedMaster::try_from_parts(&bytes, &OWNER_WRAP_NONCE).err(),
            Some(WrongLength {
                got: 50,
                expected: WrappedMaster::WRAPPED_LEN
            })
        );
    }

    #[test]
    fn rejects_empty_wrapped() {
        assert_eq!(
            WrappedMaster::try_from_parts(&[], &OWNER_WRAP_NONCE).err(),
            Some(WrongLength {
                got: 0,
                expected: WrappedMaster::WRAPPED_LEN
            })
        );
    }

    #[test]
    fn rejects_short_wrap_nonce() {
        let bytes: [u8; 20] = std::array::from_fn(|i| i as u8);
        assert_eq!(
            WrappedMaster::try_from_parts(&wrapped_of_valid_length(), &bytes).err(),
            Some(WrongLength {
                got: 20,
                expected: WrappedMaster::WRAP_NONCE_LEN
            })
        );
    }

    #[test]
    fn rejects_long_wrap_nonce() {
        let bytes: [u8; 50] = std::array::from_fn(|i| i as u8);
        assert_eq!(
            WrappedMaster::try_from_parts(&wrapped_of_valid_length(), &bytes).err(),
            Some(WrongLength {
                got: 50,
                expected: WrappedMaster::WRAP_NONCE_LEN
            })
        );
    }

    #[test]
    fn rejects_empty_wrap_nonce() {
        assert_eq!(
            WrappedMaster::try_from_parts(&wrapped_of_valid_length(), &[]).err(),
            Some(WrongLength {
                got: 0,
                expected: WrappedMaster::WRAP_NONCE_LEN
            })
        );
    }
}
