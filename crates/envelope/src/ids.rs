#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RecipientId([u8; 16]);

impl RecipientId {
    pub fn from_bytes(bytes: [u8; 16]) -> Self {
        RecipientId(bytes)
    }
    pub fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Salt([u8; 16]);

impl Salt {
    pub fn from_bytes(bytes: [u8; 16]) -> Self {
        Salt(bytes)
    }
    pub fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AssetId([u8; 16]);

impl AssetId {
    pub fn from_bytes(bytes: [u8; 16]) -> Self {
        AssetId(bytes)
    }
    pub fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

#[derive(Debug, PartialEq)]
pub struct WrongLength {
    pub expected: usize,
    pub got: usize,
}

impl AssetId {
    pub const LEN: usize = 16;

    pub fn try_from_slice(bytes: &[u8]) -> Result<AssetId, WrongLength> {
        let bytes: [u8; Self::LEN] = bytes.try_into().map_err(|_| WrongLength {
            expected: Self::LEN,
            got: bytes.len(),
        })?;
        Ok(AssetId::from_bytes(bytes))
    }
}

impl Salt {
    pub const LEN: usize = 16;

    pub fn try_from_slice(bytes: &[u8]) -> Result<Salt, WrongLength> {
        let bytes: [u8; Self::LEN] = bytes.try_into().map_err(|_| WrongLength {
            expected: Self::LEN,
            got: bytes.len(),
        })?;
        Ok(Salt::from_bytes(bytes))
    }
}

impl RecipientId {
    pub const LEN: usize = 16;

    pub fn try_from_slice(bytes: &[u8]) -> Result<RecipientId, WrongLength> {
        let bytes: [u8; Self::LEN] = bytes.try_into().map_err(|_| WrongLength {
            expected: Self::LEN,
            got: bytes.len(),
        })?;
        Ok(RecipientId::from_bytes(bytes))
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        AlbumKey, AssetId, RecipientId, Salt, WrappedKey, WrongLength,
        test_fixtures::{ASSET_ID, RECIPIENT_ID, SALT},
    };

    // Recipient ID Length Tests
    // ----------------------------------------------------
    #[test]
    fn rejects_short_recipient_id() {
        assert_eq!(
            RecipientId::try_from_slice(&[0u8; 15]).err(),
            Some(WrongLength {
                got: 15,
                expected: RecipientId::LEN
            })
        );
    }

    #[test]
    fn accepts_recipient_id_exact_length_and_preserves_bytes() {
        assert_eq!(
            RecipientId::try_from_slice(&RECIPIENT_ID).unwrap(),
            RecipientId::from_bytes(RECIPIENT_ID)
        );
    }

    #[test]
    fn rejects_long_recipient_id() {
        assert_eq!(
            RecipientId::try_from_slice(&[0u8; 20]).err(),
            Some(WrongLength {
                got: 20,
                expected: RecipientId::LEN
            })
        );
    }

    #[test]
    fn rejects_empty_recipient_id() {
        assert_eq!(
            RecipientId::try_from_slice(&[]).err(),
            Some(WrongLength {
                got: 0,
                expected: RecipientId::LEN
            })
        );
    }

    // Salt Length Tests
    // ----------------------------------------------------
    #[test]
    fn accepts_salt_exact_length_and_preserves_bytes() {
        assert_eq!(Salt::try_from_slice(&SALT).unwrap(), Salt::from_bytes(SALT));
    }

    #[test]
    fn rejects_short_salt() {
        assert_eq!(
            Salt::try_from_slice(&[0u8; 15]).err(),
            Some(WrongLength {
                got: 15,
                expected: Salt::LEN
            })
        );
    }

    #[test]
    fn rejects_long_salt() {
        assert_eq!(
            Salt::try_from_slice(&[0u8; 20]).err(),
            Some(WrongLength {
                got: 20,
                expected: Salt::LEN
            })
        );
    }

    #[test]
    fn rejects_empty_salt() {
        assert_eq!(
            Salt::try_from_slice(&[]).err(),
            Some(WrongLength {
                got: 0,
                expected: RecipientId::LEN
            })
        );
    }

    // Asset ID Length Tests
    // ----------------------------------------------------
    #[test]
    fn accepts_asset_id_exact_length_and_preserves_bytes() {
        assert_eq!(
            AssetId::try_from_slice(&ASSET_ID).unwrap(),
            AssetId::from_bytes(ASSET_ID)
        );
    }

    #[test]
    fn rejects_short_asset_id() {
        assert_eq!(
            AssetId::try_from_slice(&[0u8; 15]).err(),
            Some(WrongLength {
                got: 15,
                expected: AssetId::LEN
            })
        );
    }

    #[test]
    fn rejects_long_asset_id() {
        assert_eq!(
            AssetId::try_from_slice(&[0u8; 20]).err(),
            Some(WrongLength {
                got: 20,
                expected: AssetId::LEN
            })
        );
    }

    #[test]
    fn rejects_empty_asset_id() {
        assert_eq!(
            AssetId::try_from_slice(&[]).err(),
            Some(WrongLength {
                got: 0,
                expected: RecipientId::LEN
            })
        );
    }

    // Asset ID Length Tests
    // ----------------------------------------------------
    #[test]
    fn all_lengths_match_expected_values() {
        assert_eq!(AlbumKey::LEN, 32); // §2
        assert_eq!(AssetId::LEN, 16); // §3.1
        assert_eq!(Salt::LEN, 16); // §6.2's lengths table
        assert_eq!(RecipientId::LEN, 16); // §6.2
        assert_eq!(WrappedKey::WRAPPED_LEN, 48); // §6.2 — K_album + tag
        assert_eq!(WrappedKey::WRAP_NONCE_LEN, 24); // §6.2
    }
}
