use crate::keys::Kek;
use argon2::{Algorithm, Argon2, Params, Version};
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};
use zeroize::Zeroizing;
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
pub(crate) enum WrapError {
    InvalidParams {
        t_cost: u32,
        p_cost: u32,
        m_cost: u32,
    },
    HashingFailed,
}

pub(crate) fn normalize_passphrase(s: &str) -> String {
    let folded: String = s
        .nfkd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(|c| c.to_lowercase())
        .collect();
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(crate) fn derive_kek(
    passphrase: &str,
    params: WrapParams,
    salt: &[u8; 16],
) -> Result<Kek, WrapError> {
    let pwd = normalize_passphrase(passphrase);
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params.argon2_params()?);

    let mut out = Zeroizing::new([0u8; KEK_LEN]);

    argon2
        .hash_password_into(pwd.as_bytes(), salt, &mut out[..])
        .map_err(|_| WrapError::HashingFailed)?;

    Ok(Kek::from_bytes(out))
}

const WRAP_AAD_LABEL: &[u8; 15] = b"vitrina-wrap-v1";

pub(crate) fn wrap_aad(recipient_id: &[u8; 16]) -> [u8; 31] {
    let mut bytes_aad: [u8; 31] = [0u8; 31];

    bytes_aad[..15].copy_from_slice(WRAP_AAD_LABEL);
    bytes_aad[15..].copy_from_slice(recipient_id);

    bytes_aad
}

#[cfg(test)]
mod tests {
    use crate::wrap::{derive_kek, normalize_passphrase, wrap_aad};
    use crate::{
        test_fixtures::hex,
        wrap::{WrapError, WrapParams},
    };
    use argon2::{Algorithm, Argon2, AssociatedData, ParamsBuilder, Version};
    use zeroize::Zeroizing;

    const RFC_9106_ARGON2ID_TAG: &str =
        "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659";

    const SALT: [u8; 16] = [
        0x8f, 0x2c, 0x41, 0xd7, 0x05, 0xba, 0x63, 0x19, 0xe4, 0x7a, 0x2f, 0x90, 0xc8, 0x11, 0x5d,
        0x36,
    ];
    const OTHER_SALT: [u8; 16] = [
        0x8f, 0x2c, 0x41, 0xd7, 0x05, 0xba, 0x63, 0x19, 0xe4, 0x7a, 0x2f, 0x90, 0xc8, 0x11, 0x5d,
        0x37,
    ];

    fn low_params() -> WrapParams {
        WrapParams::new(8, 1, 1).unwrap()
    }

    /// `recipient_id` for the AAD fixture. A real UUIDv4 —
    /// 3f2a91c7-8b4e-4d16-9f05-c2a7d81e6b34 — so the version nibble (4)
    /// and variant bits (10xx) are where §2 says they are.
    const RECIPIENT_ID: [u8; 16] = [
        0x3f, 0x2a, 0x91, 0xc7, 0x8b, 0x4e, 0x4d, 0x16, 0x9f, 0x05, 0xc2, 0xa7, 0xd8, 0x1e, 0x6b,
        0x34,
    ];

    /// §6.2's AAD for RECIPIENT_ID: the 15 ASCII bytes of "vitrina-wrap-v1"
    /// with no terminator and no length prefix, then the 16 raw UUID bytes.
    /// The first 30 hex characters are the label; everything after is the id.
    const WRAP_AAD: &str = "76697472696e612d777261702d76313f2a91c78b4e4d169f05c2a7d81e6b34";

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
            derive_kek("Café Roble", low_params(), &SALT)
                .unwrap()
                .expose_bytes(),
            derive_kek("Café Roble", low_params(), &SALT)
                .unwrap()
                .expose_bytes()
        );
    }

    #[test]
    fn creates_same_kek_with_normalized_passphrase() {
        assert_eq!(
            derive_kek("Café Roble ", low_params(), &SALT)
                .unwrap()
                .expose_bytes(),
            derive_kek("cafe roble", low_params(), &SALT)
                .unwrap()
                .expose_bytes()
        );
    }

    #[test]
    fn derives_kek_at_v1_params() {
        assert!(derive_kek("Café Roble", WrapParams::V1, &SALT).is_ok());
    }

    #[test]
    fn creates_different_kek_with_different_salt() {
        assert_ne!(
            derive_kek("Café Roble", low_params(), &SALT)
                .unwrap()
                .expose_bytes(),
            derive_kek("Café Roble", low_params(), &OTHER_SALT)
                .unwrap()
                .expose_bytes()
        );
    }

    #[test]
    fn creates_different_kek_with_different_passphrase() {
        assert_ne!(
            derive_kek("Café Roble", low_params(), &SALT)
                .unwrap()
                .expose_bytes(),
            derive_kek("Café Sauce", low_params(), &SALT)
                .unwrap()
                .expose_bytes()
        );
    }

    #[test]
    fn creates_different_kek_with_different_params() {
        assert_ne!(
            derive_kek("Café Roble", low_params(), &SALT)
                .unwrap()
                .expose_bytes(),
            derive_kek("Café Roble", WrapParams::new(16, 1, 1).unwrap(), &SALT)
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
            derive_kek("Café Roble", low_params(), &SALT)
                .unwrap()
                .expose_bytes(),
            &*out_argon2id
        );
    }

    // AAD Concatenation Tests
    // ----------------------------------------------------
    #[test]
    fn concatenated_aad_matches_hex_literal() {
        assert_eq!(hex(&wrap_aad(&RECIPIENT_ID)), WRAP_AAD);
    }

    #[test]
    fn concatenated_aad_length_matches_expected() {
        assert_eq!(wrap_aad(&RECIPIENT_ID).len(), 31)
    }
}
