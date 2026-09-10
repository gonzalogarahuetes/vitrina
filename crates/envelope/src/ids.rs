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
