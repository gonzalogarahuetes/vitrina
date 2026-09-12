use crate::{
    AlbumKey, WrongLength,
    aead::{AeadError, aead_decrypt, aead_encrypt},
    ids::{RecipientId, Salt},
    keys::{Kek, cipher_for},
};
use argon2::{Algorithm, Argon2, Params, Version};
use unicode_normalization::{UnicodeNormalization, char::canonical_combining_class};
use zeroize::{Zeroize, Zeroizing};
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WrapParams {
    t_cost: u32,
    p_cost: u32,
    m_cost_kib: u32,
}

const KEK_LEN: usize = 32;

impl WrapParams {
    pub const V1: WrapParams = WrapParams {
        m_cost_kib: 65_536,
        t_cost: 3,
        p_cost: 1,
    };
    fn argon2_params(&self) -> Result<Params, WrapError> {
        Params::new(self.m_cost_kib, self.t_cost, self.p_cost, Some(KEK_LEN)).map_err(|_| {
            WrapError::InvalidParams {
                t_cost: self.t_cost,
                p_cost: self.p_cost,
                m_cost: self.m_cost_kib,
            }
        })
    }
    pub fn new(m_cost_kib: u32, t_cost: u32, p_cost: u32) -> Result<Self, WrapError> {
        let candidate = WrapParams {
            t_cost,
            m_cost_kib,
            p_cost,
        };
        candidate.argon2_params()?;
        Ok(candidate)
    }
}

#[derive(Debug, PartialEq)]
pub enum WrapError {
    InvalidParams {
        t_cost: u32,
        p_cost: u32,
        m_cost: u32,
    },
    HashingFailed,
    UnexpectedWrappedLength,
    RandomnessUnavailable,
    UnexpectedKeyLength,
    AuthenticationFailed,
    EmptyPassphrase,
}

impl From<AeadError> for WrapError {
    /// Exhaustive on purpose: if `AeadError` gains a variant that isn't an
    /// authentication failure, this must fail to compile.
    fn from(e: AeadError) -> Self {
        match e {
            AeadError::AuthenticationFailed => WrapError::AuthenticationFailed,
        }
    }
}

pub(crate) fn normalize_passphrase(s: &str) -> String {
    let folded: String = s
        .nfkd()
        // Canonical_Combining_Class, not is_combining_mark: that one is
        // General_Category=M and also strips Indic vowel signs, which have CCC 0
        // and are vowels rather than decoration. §6.3.
        .filter(|c| canonical_combining_class(*c) == 0)
        .flat_map(|c| c.to_lowercase())
        .collect();
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn derive_kek(
    passphrase: &str,
    params: WrapParams,
    salt: Salt,
) -> Result<Kek, WrapError> {
    let pwd = normalize_passphrase(passphrase);
    if pwd.is_empty() {
        return Err(WrapError::EmptyPassphrase);
    }

    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params.argon2_params()?);

    let mut out = Zeroizing::new([0u8; KEK_LEN]);

    argon2
        .hash_password_into(pwd.as_bytes(), salt.as_bytes(), &mut out[..])
        .map_err(|_| WrapError::HashingFailed)?;

    Ok(Kek::from_bytes(out))
}

const WRAP_AAD_LABEL: &[u8; 15] = b"vitrina-wrap-v1";

pub(crate) fn wrap_aad(recipient_id: &RecipientId) -> [u8; 31] {
    let mut bytes_aad: [u8; 31] = [0u8; 31];

    bytes_aad[..15].copy_from_slice(WRAP_AAD_LABEL);
    bytes_aad[15..].copy_from_slice(recipient_id.as_bytes());

    bytes_aad
}

#[derive(Debug, Clone, PartialEq)]
pub struct WrappedKey {
    /// `K_album` (32) plus the Poly1305 tag (16) — §6.2's lengths table.
    pub wrapped: [u8; 48],
    pub wrap_nonce: [u8; 24],
    pub kdf_salt: Salt,
    // The Argon2id parameters are the fourth thing the server stores, and
    // they are deliberately absent: the caller passed them in, so it
    // already has them.
}

impl WrappedKey {
    pub const WRAPPED_LEN: usize = 48;
    pub const WRAP_NONCE_LEN: usize = 24;

    pub fn try_from_parts(
        wrapped: &[u8],
        wrap_nonce: &[u8],
        kdf_salt: Salt,
    ) -> Result<WrappedKey, WrongLength> {
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
        Ok(WrappedKey {
            wrapped: wrapped_bytes,
            wrap_nonce: wrap_nonce_bytes,
            kdf_salt,
        })
    }
}

pub(crate) fn wrap_with_salt_and_nonce(
    album_key: &AlbumKey,
    passphrase: &str,
    salt: Salt,
    params: WrapParams,
    recipient_id: &RecipientId,
    wrap_nonce: &[u8; 24],
) -> Result<[u8; 48], WrapError> {
    let kek = derive_kek(passphrase, params, salt)?;
    let aad: [u8; 31] = wrap_aad(recipient_id);
    let cipher_kek = cipher_for(kek.expose_bytes());
    aead_encrypt(&cipher_kek, wrap_nonce, &aad, album_key.expose_bytes())
        .try_into()
        .map_err(|_| WrapError::UnexpectedWrappedLength)
}

pub fn wrap_album_key(
    album_key: &AlbumKey,
    passphrase: &str,
    params: WrapParams,
    recipient_id: RecipientId,
) -> Result<WrappedKey, WrapError> {
    let mut salt_bytes = [0u8; 16];
    let mut wrap_nonce = [0u8; 24];

    getrandom::fill(&mut salt_bytes).map_err(|_| WrapError::RandomnessUnavailable)?;
    getrandom::fill(&mut wrap_nonce).map_err(|_| WrapError::RandomnessUnavailable)?;

    let salt = Salt::from_bytes(salt_bytes);
    let wrapped: [u8; 48] = wrap_with_salt_and_nonce(
        album_key,
        passphrase,
        salt,
        params,
        &recipient_id,
        &wrap_nonce,
    )?;

    Ok(WrappedKey {
        wrap_nonce,
        wrapped,
        kdf_salt: salt,
    })
}

pub fn unwrap_album_key(
    passphrase: &str,
    params: WrapParams,
    recipient_id: RecipientId,
    wrapped: &WrappedKey,
) -> Result<AlbumKey, WrapError> {
    let kek = derive_kek(passphrase, params, wrapped.kdf_salt)?;
    let aad: [u8; 31] = wrap_aad(&recipient_id);
    let cipher_kek = cipher_for(kek.expose_bytes());

    let mut plaintext = aead_decrypt(&cipher_kek, &wrapped.wrap_nonce, &aad, &wrapped.wrapped)?;
    let bytes: [u8; 32] = plaintext[..]
        .try_into()
        .map_err(|_| WrapError::UnexpectedKeyLength)?;
    plaintext.zeroize();

    Ok(AlbumKey::from_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use crate::test_fixtures::{RECIPIENT_ID, SALT, WRAP_NONCE, album_key};
    use crate::wrap::{
        RecipientId, Salt, derive_kek, normalize_passphrase, unwrap_album_key, wrap_aad,
        wrap_album_key, wrap_with_salt_and_nonce,
    };
    use crate::{WrappedKey, WrongLength};
    use crate::{
        test_fixtures::hex,
        wrap::{WrapError, WrapParams},
    };
    use argon2::{Algorithm, Argon2, AssociatedData, ParamsBuilder, Version};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;
    use zeroize::Zeroizing;

    const RFC_9106_ARGON2ID_TAG: &str =
        "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659";

    const OTHER_SALT: [u8; 16] = [
        0x8f, 0x2c, 0x41, 0xd7, 0x05, 0xba, 0x63, 0x19, 0xe4, 0x7a, 0x2f, 0x90, 0xc8, 0x11, 0x5d,
        0x37,
    ];

    fn low_params() -> WrapParams {
        WrapParams::new(8, 1, 1).unwrap()
    }

    /// One byte different from `RECIPIENT_ID` — 3f2a91c7-8b4e-4d16-9f05-c2a7d81e6b35.
    /// Still a valid UUIDv4: the version nibble and variant bits are untouched.
    const OTHER_RECIPIENT_ID: [u8; 16] = [
        0x3f, 0x2a, 0x91, 0xc7, 0x8b, 0x4e, 0x4d, 0x16, 0x9f, 0x05, 0xc2, 0xa7, 0xd8, 0x1e, 0x6b,
        0x35,
    ];

    /// §6.2's AAD for RECIPIENT_ID: the 15 ASCII bytes of "vitrina-wrap-v1"
    /// with no terminator and no length prefix, then the 16 raw UUID bytes.
    /// The first 30 hex characters are the label; everything after is the id.
    const WRAP_AAD: &str = "76697472696e612d777261702d76313f2a91c78b4e4d169f05c2a7d81e6b34";

    /// §9 category 7. Self-generated — see §9.2 on what that can and cannot
    /// catch. It pins the composition so a later refactor cannot silently
    /// change the bytes.
    const KNOWN_ANSWER_WRAPPED: &str = "2b2b3d1289ac7c793735f7bd2ac86824f0b44878ba75b8865acdf827ab812da67f076808904b46b8600a535b6754ba61";

    fn wrapped_for(recipient_id: [u8; 16]) -> [u8; 48] {
        wrap_with_salt_and_nonce(
            &album_key(),
            "Café Roble",
            Salt::from_bytes(SALT),
            low_params(),
            &RecipientId::from_bytes(recipient_id),
            &WRAP_NONCE,
        )
        .unwrap()
    }

    fn wrapped_of_valid_length() -> [u8; WrappedKey::WRAPPED_LEN] {
        std::array::from_fn(|i| i as u8)
    }

    #[test]
    fn matches_rfc9106_argon2id_vector() {
        let password: [u8; 32] = [0x01; 32];
        let salt = [0x02; 16];
        let secret: [u8; 8] = [0x03; 8];

        let associated_data = AssociatedData::new(&[0x04; 12]).unwrap();

        let mut b = ParamsBuilder::new();
        b.m_cost(32)
            .t_cost(3)
            .p_cost(4)
            .output_len(32)
            .data(associated_data);
        let params = b.build().unwrap();

        let argon =
            Argon2::new_with_secret(&secret, Algorithm::Argon2id, Version::V0x13, params).unwrap();

        let mut out = [0u8; 32];
        argon
            .hash_password_into(&password, &salt, &mut out)
            .unwrap();

        assert_eq!(hex(&out), RFC_9106_ARGON2ID_TAG);
    }

    #[test]
    fn v1_memory_cost_is_64_mib() {
        assert_eq!(WrapParams::V1.m_cost_kib, 64 * 1024)
    }

    #[test]
    fn v1_params_are_accepted_by_argon2() {
        assert!(WrapParams::V1.argon2_params().is_ok())
    }

    #[test]
    fn new_accepts_v1_values() {
        let params = WrapParams::new(
            WrapParams::V1.m_cost_kib,
            WrapParams::V1.t_cost,
            WrapParams::V1.p_cost,
        );
        assert!(params.is_ok());
        assert_eq!(params.unwrap(), WrapParams::V1);
    }

    #[test]
    fn rejects_m_cost_below_eight_times_p_cost() {
        assert_eq!(
            WrapParams::new(8, 3, 4).unwrap_err(),
            WrapError::InvalidParams {
                t_cost: 3,
                p_cost: 4,
                m_cost: 8
            }
        );
    }

    #[test]
    fn normalizes_passphrase_to_expected_values() {
        for (input, expected_output) in [
            ("Café  Roble ", "cafe roble"), // 	§6.3's own example, all four steps at once
            ("\u{FB01}n", "fin"), // NFKD, not NFD. NFD leaves ﬁ intact; this is the only test that distinguishes them
            ("a\u{00A0}b", "a b"), // NFKD maps NBSP to a plain space, which then collapses
            ("\u{1D2C}", "a"),    // the step order itself; fails if you lowercase first
            ("a\t\nb", "a b"),    // tabs and newlines are whitespace too
            ("\u{0915}\u{093E}", "\u{0915}\u{093E}"), // That's का: Devanagari KA plus vowel sign AA, Mc with CCC 0
        ] {
            assert_eq!(normalize_passphrase(input), expected_output);
        }
    }

    #[test]
    fn decompose_and_precompose_agree() {
        assert_eq!(
            normalize_passphrase("cafe"),
            normalize_passphrase("caf\u{00E9}")
        )
    }

    #[test]
    fn folds_diacritics_to_base_letters() {
        assert_eq!(normalize_passphrase("pap\u{00E1}"), "papa")
    }

    #[test]
    fn normalizes_with_idempotence() {
        assert_eq!(
            normalize_passphrase(&normalize_passphrase("Café  Roble ")),
            normalize_passphrase("Café  Roble ")
        );
        assert_eq!(normalize_passphrase("cafe roble"), "cafe roble")
    }

    // KEK Derivation Tests
    // ----------------------------------------------------

    #[test]
    fn creates_same_kek_with_same_inputs() {
        assert_eq!(
            derive_kek("Café Roble", low_params(), Salt::from_bytes(SALT))
                .unwrap()
                .expose_bytes(),
            derive_kek("Café Roble", low_params(), Salt::from_bytes(SALT))
                .unwrap()
                .expose_bytes()
        );
    }

    #[test]
    fn creates_same_kek_with_normalized_passphrase() {
        assert_eq!(
            derive_kek("Café Roble ", low_params(), Salt::from_bytes(SALT))
                .unwrap()
                .expose_bytes(),
            derive_kek("cafe roble", low_params(), Salt::from_bytes(SALT))
                .unwrap()
                .expose_bytes()
        );
    }

    #[test]
    fn derives_kek_at_v1_params() {
        assert!(derive_kek("Café Roble", WrapParams::V1, Salt::from_bytes(SALT)).is_ok());
    }

    #[test]
    fn creates_different_kek_with_different_salt() {
        assert_ne!(
            derive_kek("Café Roble", low_params(), Salt::from_bytes(SALT))
                .unwrap()
                .expose_bytes(),
            derive_kek("Café Roble", low_params(), Salt::from_bytes(OTHER_SALT))
                .unwrap()
                .expose_bytes()
        );
    }

    #[test]
    fn creates_different_kek_with_different_passphrase() {
        assert_ne!(
            derive_kek("Café Roble", low_params(), Salt::from_bytes(SALT))
                .unwrap()
                .expose_bytes(),
            derive_kek("Café Sauce", low_params(), Salt::from_bytes(SALT))
                .unwrap()
                .expose_bytes()
        );
    }

    #[test]
    fn creates_different_kek_with_different_params() {
        assert_ne!(
            derive_kek("Café Roble", low_params(), Salt::from_bytes(SALT))
                .unwrap()
                .expose_bytes(),
            derive_kek(
                "Café Roble",
                WrapParams::new(16, 1, 1).unwrap(),
                Salt::from_bytes(SALT)
            )
            .unwrap()
            .expose_bytes()
        );
    }

    #[test]
    fn derive_kek_uses_argon2id() {
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
            .hash_password_into("cafe roble".as_bytes(), &SALT, &mut out_argon2id[..])
            .unwrap();

        let mut out_argon2i = Zeroizing::new([0u8; 32]);
        argon2i
            .hash_password_into("cafe roble".as_bytes(), &SALT, &mut out_argon2i[..])
            .unwrap();

        // Argon2id and Argon2i genuinely differ at these inputs, so the
        // equality below cannot pass vacuously.
        assert_ne!(&out_argon2id[..], &out_argon2i[..]);

        // derive_kek's output IS the Argon2id computation — this is what pins
        // the algorithm, the version, the params and the normalisation at once.
        assert_eq!(
            derive_kek("Café Roble", low_params(), Salt::from_bytes(SALT))
                .unwrap()
                .expose_bytes(),
            &*out_argon2id
        );
    }

    #[test]
    fn rejects_with_empty_passphrase() {
        assert_eq!(
            derive_kek("", low_params(), Salt::from_bytes(SALT)).err(),
            Some(WrapError::EmptyPassphrase)
        );
    }

    #[test]
    fn rejects_whitespace_only_passphrase() {
        assert_eq!(
            derive_kek("   ", low_params(), Salt::from_bytes(SALT)).err(),
            Some(WrapError::EmptyPassphrase)
        );
    }

    #[test]
    fn rejects_passphrase_that_normalizes_to_empty() {
        assert_eq!(
            derive_kek("\u{0301}", low_params(), Salt::from_bytes(SALT)).err(),
            Some(WrapError::EmptyPassphrase)
        );
    }

    // AAD Concatenation Tests
    // ----------------------------------------------------
    #[test]
    fn concatenated_aad_matches_hex_literal() {
        assert_eq!(
            hex(&wrap_aad(&RecipientId::from_bytes(RECIPIENT_ID))),
            WRAP_AAD
        );
    }

    #[test]
    fn concatenated_aad_length_matches_expected() {
        assert_eq!(wrap_aad(&RecipientId::from_bytes(RECIPIENT_ID)).len(), 31)
    }

    // Wrap With Salt and Nonce Tests
    // ----------------------------------------------------
    #[test]
    fn matches_known_answer_wrapped() {
        assert_eq!(hex(&wrapped_for(RECIPIENT_ID)), KNOWN_ANSWER_WRAPPED);
    }

    #[test]
    fn creates_different_answer_wrapped_with_different_recipient_ids() {
        assert_ne!(&wrapped_for(RECIPIENT_ID), &wrapped_for(OTHER_RECIPIENT_ID));
    }

    // Wrap Album Key Tests
    // ----------------------------------------------------
    #[test]
    fn wraps_and_unwraps_correctly() {
        let passphrase = "Café Roble";
        let wrapped = wrap_album_key(
            &album_key(),
            passphrase,
            low_params(),
            RecipientId::from_bytes(RECIPIENT_ID),
        )
        .unwrap();

        let unwrapped = unwrap_album_key(
            passphrase,
            low_params(),
            RecipientId::from_bytes(RECIPIENT_ID),
            &wrapped,
        )
        .unwrap();

        assert_eq!(&album_key().expose_bytes(), &unwrapped.expose_bytes())
    }

    #[test]
    fn generates_fresh_salt_and_nonce_every_time() {
        let passphrase = "Café Roble";
        let wrapped_one = wrap_album_key(
            &album_key(),
            passphrase,
            low_params(),
            RecipientId::from_bytes(RECIPIENT_ID),
        )
        .unwrap();

        let wrapped_two = wrap_album_key(
            &album_key(),
            passphrase,
            low_params(),
            RecipientId::from_bytes(RECIPIENT_ID),
        )
        .unwrap();
        assert_ne!(wrapped_one.wrap_nonce, wrapped_two.wrap_nonce);
        assert_ne!(wrapped_one.kdf_salt, wrapped_two.kdf_salt);
    }

    #[test]
    fn wraps_and_unwraps_with_normalized_passphrase() {
        let wrapped = wrap_album_key(
            &album_key(),
            "Café Roble ",
            low_params(),
            RecipientId::from_bytes(RECIPIENT_ID),
        )
        .unwrap();

        let wrapped_low = unwrap_album_key(
            "cafe roble",
            low_params(),
            RecipientId::from_bytes(RECIPIENT_ID),
            &wrapped,
        )
        .unwrap();

        assert_eq!(&album_key().expose_bytes(), &wrapped_low.expose_bytes());
    }

    #[test]
    fn rejects_wraps_with_passphrase_that_normalizes_to_empty() {
        assert_eq!(
            wrap_album_key(
                &album_key(),
                "\u{0301}",
                low_params(),
                RecipientId::from_bytes(RECIPIENT_ID),
            )
            .err(),
            Some(WrapError::EmptyPassphrase)
        );
    }

    #[test]
    fn rejects_unwraps_with_passphrase_that_normalize_to_empty() {
        let wrapped = wrap_album_key(
            &album_key(),
            "Café Roble ",
            low_params(),
            RecipientId::from_bytes(RECIPIENT_ID),
        )
        .unwrap();

        assert_eq!(
            unwrap_album_key(
                "    ",
                low_params(),
                RecipientId::from_bytes(RECIPIENT_ID),
                &wrapped
            )
            .err(),
            Some(WrapError::EmptyPassphrase)
        );
    }

    #[test]
    fn rejects_unwrap_with_wrong_passphrase() {
        let wrapped = wrap_album_key(
            &album_key(),
            "Café Roble",
            low_params(),
            RecipientId::from_bytes(RECIPIENT_ID),
        )
        .unwrap();

        assert_eq!(
            unwrap_album_key(
                "Café Sauce",
                low_params(),
                RecipientId::from_bytes(RECIPIENT_ID),
                &wrapped
            )
            .err(),
            Some(WrapError::AuthenticationFailed)
        );
    }

    #[test]
    fn rejects_unwrap_with_wrong_salt() {
        let passphrase = "Café Roble";
        let wrapped = wrap_album_key(
            &album_key(),
            passphrase,
            low_params(),
            RecipientId::from_bytes(RECIPIENT_ID),
        )
        .unwrap();

        let mut tampered = wrapped.clone();
        let mut salt_bytes = *wrapped.kdf_salt.as_bytes();
        salt_bytes[0] ^= 1;
        tampered.kdf_salt = Salt::from_bytes(salt_bytes);

        assert_eq!(
            unwrap_album_key(
                passphrase,
                low_params(),
                RecipientId::from_bytes(RECIPIENT_ID),
                &tampered
            )
            .err(),
            Some(WrapError::AuthenticationFailed)
        );
    }

    #[test]
    fn rejects_unwrap_with_wrong_recipient_id() {
        let passphrase = "Café Roble";

        let wrapped = wrap_album_key(
            &album_key(),
            passphrase,
            low_params(),
            RecipientId::from_bytes(RECIPIENT_ID),
        )
        .unwrap();

        assert_eq!(
            unwrap_album_key(
                passphrase,
                low_params(),
                RecipientId::from_bytes(OTHER_RECIPIENT_ID),
                &wrapped
            )
            .err(),
            Some(WrapError::AuthenticationFailed)
        );
    }

    #[test]
    fn rejects_unwrap_with_wrong_params() {
        let passphrase = "Café Roble";

        let wrapped = wrap_album_key(
            &album_key(),
            passphrase,
            low_params(),
            RecipientId::from_bytes(RECIPIENT_ID),
        )
        .unwrap();

        assert_eq!(
            unwrap_album_key(
                passphrase,
                WrapParams::new(16, 1, 1).unwrap(),
                RecipientId::from_bytes(RECIPIENT_ID),
                &wrapped
            )
            .err(),
            Some(WrapError::AuthenticationFailed)
        );
    }

    #[test]
    fn rejects_unwrap_with_flipped_wrapped() {
        let passphrase = "Café Roble";

        let wrapped = wrap_album_key(
            &album_key(),
            passphrase,
            low_params(),
            RecipientId::from_bytes(RECIPIENT_ID),
        )
        .unwrap();

        let mut tampered = wrapped.clone();
        tampered.wrapped[0] ^= 1;

        assert_eq!(
            unwrap_album_key(
                passphrase,
                low_params(),
                RecipientId::from_bytes(RECIPIENT_ID),
                &tampered
            )
            .err(),
            Some(WrapError::AuthenticationFailed)
        );
    }
    #[test]
    fn rejects_unwrap_with_flipped_nonce() {
        let passphrase = "Café Roble";

        let wrapped = wrap_album_key(
            &album_key(),
            passphrase,
            low_params(),
            RecipientId::from_bytes(RECIPIENT_ID),
        )
        .unwrap();

        let mut tampered = wrapped.clone();
        tampered.wrap_nonce[0] ^= 1;

        assert_eq!(
            unwrap_album_key(
                passphrase,
                low_params(),
                RecipientId::from_bytes(RECIPIENT_ID),
                &tampered
            )
            .err(),
            Some(WrapError::AuthenticationFailed)
        );
    }

    // Wrapped Key Length Tests
    // ----------------------------------------------------
    #[test]
    fn builds_wrapped_key_from_valid_parts() {
        let bytes: [u8; WrappedKey::WRAPPED_LEN] = std::array::from_fn(|i| i as u8);
        let salt = Salt::from_bytes(SALT);
        assert_eq!(
            WrappedKey::try_from_parts(&bytes, &WRAP_NONCE, salt).unwrap(),
            WrappedKey {
                wrapped: bytes,
                wrap_nonce: WRAP_NONCE,
                kdf_salt: salt
            }
        );
    }

    #[test]
    fn rejects_short_wrapped() {
        let bytes: [u8; 40] = std::array::from_fn(|i| i as u8);
        assert_eq!(
            WrappedKey::try_from_parts(&bytes, &WRAP_NONCE, Salt::from_bytes(SALT)).err(),
            Some(WrongLength {
                got: 40,
                expected: WrappedKey::WRAPPED_LEN
            })
        );
    }

    #[test]
    fn rejects_long_wrapped() {
        let bytes: [u8; 50] = std::array::from_fn(|i| i as u8);
        assert_eq!(
            WrappedKey::try_from_parts(&bytes, &WRAP_NONCE, Salt::from_bytes(SALT)).err(),
            Some(WrongLength {
                got: 50,
                expected: WrappedKey::WRAPPED_LEN
            })
        );
    }

    #[test]
    fn rejects_empty_wrapped() {
        assert_eq!(
            WrappedKey::try_from_parts(&[], &WRAP_NONCE, Salt::from_bytes(SALT)).err(),
            Some(WrongLength {
                got: 0,
                expected: WrappedKey::WRAPPED_LEN
            })
        );
    }

    #[test]
    fn rejects_short_wrap_nonce() {
        let bytes: [u8; 20] = std::array::from_fn(|i| i as u8);
        assert_eq!(
            WrappedKey::try_from_parts(&wrapped_of_valid_length(), &bytes, Salt::from_bytes(SALT))
                .err(),
            Some(WrongLength {
                got: 20,
                expected: WrappedKey::WRAP_NONCE_LEN
            })
        );
    }

    #[test]
    fn rejects_long_wrap_nonce() {
        let bytes: [u8; 50] = std::array::from_fn(|i| i as u8);
        assert_eq!(
            WrappedKey::try_from_parts(&wrapped_of_valid_length(), &bytes, Salt::from_bytes(SALT))
                .err(),
            Some(WrongLength {
                got: 50,
                expected: WrappedKey::WRAP_NONCE_LEN
            })
        );
    }

    #[test]
    fn rejects_empty_wrap_nonce() {
        assert_eq!(
            WrappedKey::try_from_parts(&wrapped_of_valid_length(), &[], Salt::from_bytes(SALT))
                .err(),
            Some(WrongLength {
                got: 0,
                expected: WrappedKey::WRAP_NONCE_LEN
            })
        );
    }
}
