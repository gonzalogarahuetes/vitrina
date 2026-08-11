pub const EXPECTED_MAGIC: [u8; 4] = [86, 84, 82, 78];

#[derive(Debug)]
pub struct Header {
    version: u8,
    cipher: u8,
    base_nonce: [u8; 16],
    chunk_size: u32,
    plaintext: u64,
    asset_id: [u8; 16],
}

#[derive(Debug)]
pub enum HeaderError {
    BadMagic,
    WrongVersion(u8),
    WrongCipher(u8),
    ReservedNotZero { offset: usize },
    PaddingNotZero { offset: usize },
    TooShort { expected: usize, got: usize },
}

impl Header {
    pub fn parse(bytes: &[u8]) -> Result<Header, HeaderError> {
        // The whole header must always be at least 64 chars long (it will be followed by the cipher-text)
        if bytes.len() < 64 {
            return Err(HeaderError::TooShort {
                expected: 64,
                got: bytes.len(),
            });
        }
        // The first chunk of 4 bytes must be an ASCII code
        if bytes[0..4] != EXPECTED_MAGIC {
            return Err(HeaderError::BadMagic);
        }
        // Version is the fifth byte and must be 1
        if bytes[4] != 1 {
            return Err(HeaderError::WrongVersion(bytes[4]));
        }
        // Cipher (version of the algorithm) must be 1
        if bytes[5] != 1 {
            return Err(HeaderError::WrongCipher(bytes[5]));
        }
        // Two reserved bytes that must be 0 for now
        let reserved = &bytes[6..8];
        if reserved != [0u8; 2] {
            if bytes[6] != 0 {
                return Err(HeaderError::ReservedNotZero { offset: 6 });
            }
            return Err(HeaderError::ReservedNotZero { offset: 7 });
        }
        let base_nonce: [u8; 16] = bytes[8..24].try_into().expect("length checked above");
        // chunk_size and plaintext must be only validated with from_le_bytes
        let chunk_size =
            u32::from_le_bytes(bytes[24..28].try_into().expect("length checked above"));
        let plaintext = u64::from_le_bytes(bytes[28..36].try_into().expect("length checked above"));
        // padding must be all 0s
        let padding = &bytes[52..64];
        if padding != [0u8; 12] {
            let index = padding.iter().position(|&b| b != 0).unwrap();
            let total_index = index + 52;
            return Err(HeaderError::PaddingNotZero {
                offset: total_index,
            });
        }
        let asset_id = bytes[36..52].try_into().expect("length checked above");
        Ok(Header {
            version: bytes[4],
            cipher: bytes[5],
            base_nonce,
            chunk_size,
            plaintext,
            asset_id,
        })
    }
}

#[cfg(test)] // compile this block ONLY during `cargo test` — zero cost in a real build
mod tests {
    // a submodule literally named `tests`
    use super::*; // pull the parent module's items (Header, HeaderError, ...) into scope

    const VALID: [u8; 64] = [
        86, 84, 82, 78, 1, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 0, 0, 1,
        0, 0, 0, 80, 0, 0, 0, 0, 0, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ];

    #[test]
    fn parses_a_valid_header() {
        let h = Header::parse(&VALID).unwrap(); // in a test, a panic IS the failure
        assert_eq!(h.version, 1);
        assert_eq!(h.cipher, 1);
    }

    #[test]
    fn rejects_short_input() {
        assert!(matches!(
            Header::parse(&VALID[0..40]),
            Err(HeaderError::TooShort { .. })
        ));
    }

    #[test]
    fn rejects_bad_magic() {
        let mut bad = VALID;
        bad[0] = 0;
        assert!(matches!(Header::parse(&bad), Err(HeaderError::BadMagic)));
    }

    #[test]
    fn rejects_wrong_version() {
        let mut bad = VALID;
        bad[4] = 9;
        assert!(matches!(
            Header::parse(&bad),
            Err(HeaderError::WrongVersion(9))
        ));
    }

    #[test]
    fn rejects_wrong_cipher() {
        let mut bad = VALID;
        bad[5] = 9;
        assert!(matches!(
            Header::parse(&bad),
            Err(HeaderError::WrongCipher(9))
        ));
    }

    #[test]
    fn rejects_reserved_non_zero() {
        let mut bad = VALID;
        bad[6] = 1;
        assert!(matches!(
            Header::parse(&bad),
            Err(HeaderError::ReservedNotZero { offset: 6 })
        ));
    }

    #[test]
    fn rejects_padding_non_zero() {
        let mut bad = VALID;
        bad[63] = 1;
        assert!(matches!(
            Header::parse(&bad),
            Err(HeaderError::PaddingNotZero { offset: 63 })
        ));
    }
}
