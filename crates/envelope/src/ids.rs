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
