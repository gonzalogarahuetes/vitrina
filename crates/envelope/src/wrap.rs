use argon2::{Params, ParamsBuilder};

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
enum WrapError {
    InvalidParams {
        t_cost: u32,
        p_cost: u32,
        m_cost: u32,
    },
}

// pub fn wrap(params: WrapParams) {}

#[cfg(test)]
mod tests {
    use crate::{
        test_fixtures::hex,
        wrap::{WrapError, WrapParams},
    };
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
}
