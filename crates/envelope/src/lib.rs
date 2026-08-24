pub const EXPECTED_MAGIC: [u8; 4] = [86, 84, 82, 78];

#[derive(Debug)]
pub struct Header {
    version: u8,
    cipher: u8,
    base_nonce: [u8; 16],
    chunk_size: u32,
    plaintext_length: u64,
    asset_id: [u8; 16],
}

#[derive(Debug)]
pub enum HeaderError {
    BadMagic,
    WrongVersion(u8),
    WrongCipher(u8),
    ReservedNotZero { offset: usize },
    PaddingNotZero { offset: usize },
    PlaintextLengthZero,
    ChunkSizeZero,
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
        let reserved: &[u8] = &bytes[6..8];
        if reserved != [0u8; 2] {
            if bytes[6] != 0 {
                return Err(HeaderError::ReservedNotZero { offset: 6 });
            }
            return Err(HeaderError::ReservedNotZero { offset: 7 });
        }
        let base_nonce: [u8; 16] = bytes[8..24].try_into().expect("length checked above");
        // chunk_size and plaintext must be only validated with from_le_bytes
        let chunk_size: u32 =
            u32::from_le_bytes(bytes[24..28].try_into().expect("length checked above"));
        if chunk_size == 0 {
            return Err(HeaderError::ChunkSizeZero);
        }
        let plaintext_length: u64 =
            u64::from_le_bytes(bytes[28..36].try_into().expect("length checked above"));
        if plaintext_length == 0 {
            return Err(HeaderError::PlaintextLengthZero);
        }
        // padding must be all 0s
        let padding: &[u8] = &bytes[52..64];
        if padding != [0u8; 12] {
            let index = padding.iter().position(|&b| b != 0).unwrap();
            let total_index = index + 52;
            return Err(HeaderError::PaddingNotZero {
                offset: total_index,
            });
        }
        let asset_id: [u8; 16] = bytes[36..52].try_into().expect("length checked above");
        Ok(Header {
            version: bytes[4],
            cipher: bytes[5],
            base_nonce,
            chunk_size,
            plaintext_length,
            asset_id,
        })
    }
    pub fn to_bytes(&self) -> [u8; 64] {
        let mut bytes_header: [u8; 64] = [0u8; 64];

        let chunk_size: [u8; 4] = self.chunk_size.to_le_bytes();
        let plaintext_length: [u8; 8] = self.plaintext_length.to_le_bytes();

        bytes_header[0..4].copy_from_slice(&EXPECTED_MAGIC);
        bytes_header[4] = self.version;
        bytes_header[5] = self.cipher;
        bytes_header[6..8].copy_from_slice(&[0x00, 0x00]);
        bytes_header[8..24].copy_from_slice(&self.base_nonce);
        bytes_header[24..28].copy_from_slice(&chunk_size);
        bytes_header[28..36].copy_from_slice(&plaintext_length);
        bytes_header[36..52].copy_from_slice(&self.asset_id);
        bytes_header[52..64].copy_from_slice(&[0u8; 12]);

        bytes_header
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

    #[rustfmt::skip]
    const GOLDEN: [u8; 64] = [
        0x56, 0x54, 0x52, 0x4E, // 0   magic VTRN
        0x01, // 4   version
        0x01, // 5   cipher
        0x00, 0x00, // 6   reserved
        0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, // 8   base_nonce
        0xA8, 0xA9, 0xAA, 0xAB, 0xAC, 0xAD, 0xAE, 0xAF, 0x00, 0x00, 0x04,
        0x00, // 24  chunk_size 262144
        0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, // 28  plaintext_length 262145
        0xB0, 0xB1, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, // 36  asset_id
        0xB8, 0xB9, 0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, // 52  padding
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ];

    #[test]
    fn parses_a_valid_header() {
        let h: Header = Header::parse(&VALID).unwrap(); // in a test, a panic IS the failure
        assert_eq!(h.version, 1);
        assert_eq!(h.cipher, 1);
    }

    #[test]
    fn parses_golden_header() {
        let h: Header = Header::parse(&GOLDEN).unwrap();
        assert_eq!(h.version, 1);
        assert_eq!(h.cipher, 1);
        assert_eq!(h.chunk_size, 262144);
        assert_eq!(h.plaintext_length, 262145);
        assert_eq!(
            h.base_nonce,
            [
                0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xAB, 0xAC, 0xAD,
                0xAE, 0xAF,
            ]
        );
        assert_eq!(
            h.asset_id,
            [
                0xB0, 0xB1, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xBB, 0xBC, 0xBD,
                0xBE, 0xBF,
            ]
        );
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
        let mut bad: [u8; 64] = VALID;
        bad[0] = 0;
        assert!(matches!(Header::parse(&bad), Err(HeaderError::BadMagic)));
    }

    #[test]
    fn rejects_wrong_version() {
        let mut bad: [u8; 64] = VALID;
        bad[4] = 9;
        assert!(matches!(
            Header::parse(&bad),
            Err(HeaderError::WrongVersion(9))
        ));
    }

    #[test]
    fn rejects_wrong_cipher() {
        let mut bad: [u8; 64] = VALID;
        bad[5] = 9;
        assert!(matches!(
            Header::parse(&bad),
            Err(HeaderError::WrongCipher(9))
        ));
    }

    #[test]
    fn rejects_reserved_non_zero() {
        let mut bad: [u8; 64] = VALID;
        bad[6] = 1;
        assert!(matches!(
            Header::parse(&bad),
            Err(HeaderError::ReservedNotZero { offset: 6 })
        ));
    }

    #[test]
    fn rejects_padding_non_zero() {
        let mut bad: [u8; 64] = VALID;
        bad[63] = 1;
        assert!(matches!(
            Header::parse(&bad),
            Err(HeaderError::PaddingNotZero { offset: 63 })
        ));
    }

    #[test]
    fn rejects_zero_plaintext_length() {
        let mut bad: [u8; 64] = VALID;
        bad[28..36].fill(0);
        assert!(matches!(
            Header::parse(&bad),
            Err(HeaderError::PlaintextLengthZero)
        ));
    }

    #[test]
    fn rejects_zero_chunk_size() {
        let mut bad: [u8; 64] = VALID;
        bad[24..28].fill(0);
        assert!(matches!(
            Header::parse(&bad),
            Err(HeaderError::ChunkSizeZero)
        ));
    }

    #[test]
    fn converts_parsed_header_to_bytes() {
        let h: Header = Header::parse(&GOLDEN).unwrap();
        let bytes: [u8; 64] = Header::to_bytes(&h);
        assert_eq!(bytes, GOLDEN);
    }

    #[test]
    fn ignores_bytes_after_the_header() {
        let mut with_junk: Vec<u8> = GOLDEN.to_vec();
        with_junk.extend_from_slice(&[0xFF; 30]);
        let h: Header = Header::parse(&with_junk).unwrap();
        let bytes: [u8; 64] = Header::to_bytes(&h);
        assert_eq!(bytes, GOLDEN);
    }

    use proptest::prelude::*;
    proptest! {
        #[test]
        fn round_trips_any_valid_header(
            base_nonce: [u8; 16],
            asset_id: [u8; 16],
            chunk_size in 1u32..,
            plaintext_length in 1u64..,
        ) {
            let mut b = GOLDEN;
            b[8..24].copy_from_slice(&base_nonce);
            b[24..28].copy_from_slice(&chunk_size.to_le_bytes());
            b[28..36].copy_from_slice(&plaintext_length.to_le_bytes());
            b[36..52].copy_from_slice(&asset_id);

            let h = Header::parse(&b).unwrap();
            prop_assert_eq!(Header::to_bytes(&h), b);
        }
    }
}
