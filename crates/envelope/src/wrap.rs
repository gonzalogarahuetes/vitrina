#[cfg(test)]
mod tests {
    use crate::test_fixtures::hex;
    use argon2::{Algorithm, Argon2, AssociatedData, ParamsBuilder, Version};

    const RFC_9106_ARGON2ID_TAG: &str =
        "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659";

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
}
