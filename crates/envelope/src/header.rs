use std::ops::Range;
const EXPECTED_MAGIC: [u8; 4] = [0x56, 0x54, 0x52, 0x4E];

#[derive(Debug)]
pub struct Header {
    version: u8,
    cipher: u8,
    base_nonce: [u8; 16],
    chunk_size: u32,
    plaintext_length: u64,
    asset_id: [u8; 16],
}

#[derive(Debug, PartialEq)]
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

#[derive(Debug, PartialEq)]
pub enum LayoutError {
    SizeOverflow,
    ChunkIndexOutOfRange { index: u64, chunk_count: u64 },
}

impl Header {
    pub fn parse(bytes: &[u8]) -> Result<Header, HeaderError> {
        // The whole header must always be at least 64 bytes long (it will be followed by the cipher-text)
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
        if let Some(i) = bytes[6..8].iter().position(|&b| b != 0) {
            return Err(HeaderError::ReservedNotZero { offset: 6 + i });
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
        let asset_id: [u8; 16] = bytes[36..52].try_into().expect("length checked above");
        // padding must be all 0s
        if let Some(i) = bytes[52..64].iter().position(|&b| b != 0) {
            return Err(HeaderError::PaddingNotZero { offset: 52 + i });
        }
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

impl Header {
    pub fn ciphertext_chunk_size(&self) -> u64 {
        self.chunk_size as u64 + 16
    }
    pub fn chunk_count(&self) -> u64 {
        self.plaintext_length.div_ceil(self.chunk_size as u64)
    }
    // (chunk_count - 1) × chunk_size is the plaintext held by every chunk before
    // the last. By the definition of ceil it is strictly less than
    // plaintext_length, so the multiply cannot overflow and the subtraction cannot
    // underflow.
    pub fn last_chunk_plaintext(&self) -> u64 {
        self.plaintext_length - (self.chunk_count() - 1) * self.chunk_size as u64
    }
    pub fn total_object_size(&self) -> Result<u64, LayoutError> {
        let total_object_size: u64 = (self.chunk_count() - 1) // chunk_count MUST be at least 1, and it is div_ceil of a non-zero numerator, so it can't underflow
            .checked_mul(self.ciphertext_chunk_size())
            .and_then(|n: u64| n.checked_add(self.last_chunk_plaintext()))
            .and_then(|n: u64| n.checked_add(80)) // 16 + 64
            .ok_or(LayoutError::SizeOverflow)?;
        Ok(total_object_size)
    }
    /// Implements §3.3. Half-open, unlike the spec's inclusive end(i)
    pub fn chunk_range(&self, i: u64) -> Result<Range<u64>, LayoutError> {
        let chunk_count: u64 = self.chunk_count();
        let ciphertext_chunk_size: u64 = self.ciphertext_chunk_size();

        // the index cannot be greater than the length
        if i >= chunk_count {
            return Err(LayoutError::ChunkIndexOutOfRange {
                index: i,
                chunk_count,
            });
        }

        let start: u64 = i
            .checked_mul(ciphertext_chunk_size)
            .and_then(|n: u64| n.checked_add(64))
            .ok_or(LayoutError::SizeOverflow)?;

        let len: u64 = if i == chunk_count - 1 {
            self.last_chunk_plaintext() + 16 // ≤ u32::MAX + 16, cannot overflow
        } else {
            ciphertext_chunk_size
        };

        let end: u64 = start.checked_add(len).ok_or(LayoutError::SizeOverflow)?;

        Ok(start..end)
    }
    /// §4. Infallible: `i` is validated by `chunk_range`, and §4 defines this
    /// unconditionally. Nothing here can overflow.
    /// §4.1's requirement that `base_nonce` be freshly CSPRNG-generated per asset
    /// binds whoever writes the header, not this method — `parse` accepts whatever
    /// 16 bytes it is given. See C.6.
    // Dead until C.5, which is the first code that reads a derived key's bytes.
    // Remove this attribute when encrypt_chunk lands; do not widen its scope.
    #[allow(dead_code)]
    pub(crate) fn nonce(&self, i: u64) -> [u8; 24] {
        let mut bytes_nonce: [u8; 24] = [0u8; 24];

        bytes_nonce[0..16].copy_from_slice(&self.base_nonce);
        bytes_nonce[16..24].copy_from_slice(&i.to_le_bytes());

        bytes_nonce
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use std::io::{Cursor, Read, Seek, SeekFrom};

    #[rustfmt::skip]
    const GOLDEN: [u8; 64] = [
        0x56, 0x54, 0x52, 0x4E,                         //  0  magic  VTRN
        0x01,                                           //  4  version
        0x01,                                           //  5  cipher
        0x00, 0x00,                                     //  6  reserved
        0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, //  8  base_nonce
        0xA8, 0xA9, 0xAA, 0xAB, 0xAC, 0xAD, 0xAE, 0xAF,
        0x00, 0x00, 0x04, 0x00,                         // 24  chunk_size       262144
        0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, // 28  plaintext_length 262145
        0xB0, 0xB1, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, // 36  asset_id
        0xB8, 0xB9, 0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00,             // 52  padding
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ];

    fn header_with(chunk_size: u32, plaintext_length: u64) -> Header {
        let mut b: [u8; 64] = GOLDEN;
        b[24..28].copy_from_slice(&chunk_size.to_le_bytes());
        b[28..36].copy_from_slice(&plaintext_length.to_le_bytes());
        Header::parse(&b).expect("template with valid sizes")
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
            Header::parse(&GOLDEN[0..40]),
            Err(HeaderError::TooShort { .. })
        ));
    }

    #[test]
    fn rejects_bad_magic() {
        let mut bad: [u8; 64] = GOLDEN;
        bad[0] = 0;
        assert!(matches!(Header::parse(&bad), Err(HeaderError::BadMagic)));
    }

    #[test]
    fn rejects_wrong_version() {
        let mut bad: [u8; 64] = GOLDEN;
        bad[4] = 9;
        assert!(matches!(
            Header::parse(&bad),
            Err(HeaderError::WrongVersion(9))
        ));
    }

    #[test]
    fn rejects_wrong_cipher() {
        let mut bad: [u8; 64] = GOLDEN;
        bad[5] = 9;
        assert!(matches!(
            Header::parse(&bad),
            Err(HeaderError::WrongCipher(9))
        ));
    }

    #[test]
    fn rejects_reserved_non_zero_at_any_offset() {
        for offset in 6..8 {
            let mut bad: [u8; 64] = GOLDEN;
            bad[offset] = 1;
            assert!(
                matches!(
                    Header::parse(&bad),
                    Err(HeaderError::ReservedNotZero { offset: o }) if o == offset
                ),
                "byte {offset} was not rejected",
            );
        }
    }

    #[test]
    fn rejects_padding_non_zero_at_any_offset() {
        for offset in 52..64 {
            let mut bad: [u8; 64] = GOLDEN;
            bad[offset] = 1;
            assert!(
                matches!(
                    Header::parse(&bad),
                    Err(HeaderError::PaddingNotZero { offset: o }) if o == offset
                ),
                "byte {offset} was not rejected",
            );
        }
    }

    #[test]
    fn reports_first_non_zero_padding_byte() {
        let mut bad: [u8; 64] = GOLDEN;
        bad[55] = 1;
        bad[60] = 1;
        let err: HeaderError = Header::parse(&bad).unwrap_err();
        assert!(
            matches!(err, HeaderError::PaddingNotZero { offset: 55 }),
            "got {err:?}"
        );
    }

    #[test]
    fn rejects_zero_plaintext_length() {
        let mut bad: [u8; 64] = GOLDEN;
        bad[28..36].fill(0);
        assert!(matches!(
            Header::parse(&bad),
            Err(HeaderError::PlaintextLengthZero)
        ));
    }

    #[test]
    fn rejects_zero_chunk_size() {
        let mut bad: [u8; 64] = GOLDEN;
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

    #[test]
    fn accepts_extreme_but_valid_sizes() {
        for (chunk_size, plaintext_length) in [
            (1u32, 1u64),
            (1, u64::MAX),
            (u32::MAX, 1),
            (u32::MAX, u64::MAX),
        ] {
            let h: Header = header_with(chunk_size, plaintext_length);
            assert_eq!(h.chunk_size, chunk_size);
            assert_eq!(h.plaintext_length, plaintext_length);
        }
    }

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

    // Computing Methods Tests
    // ----------------------------------------------------
    const CS: u64 = 262_144;
    // const CCS: u64 = 262_160;

    /*
     * plaintext_length    |      chunk_count     |     last_chunk_plaintext    |    total_object_size   |
     * ---------------------------------------------------------------------------------------------------
     *       1             |          1           |              1              |           81
     *   chunk_size - 1    |          1           |         chunk_size - 1      |         CS + 79
     *    chunk_size       |          1           |          chunk_size         |         CS + 80
     *   chunk_size + 1    |          2           |              1              |         CS + 97
     *   2 * chunk_size    |          2           |          chunk_size         |       2 * CS + 96
     *  2 * chunk_size + 1 |          3           |              1              |       2 * CS + 113
     * ---------------------------------------------------------------------------------------------------
     */

    #[test]
    fn computes_chunk_count_object_size_and_last_chunk_plaintext_correctly() {
        for (plaintext_length, case, expected_chunk_count, expected_last_chunk_plaintext) in [
            (1, "1", 1, 1),
            (CS - 1, "CS - 1", 1, CS - 1),
            (CS, "CS", 1, CS),
            (CS + 1, "CS + 1", 2, 1),
            (CS * 2, "CS * 2", 2, CS),
            (CS * 2 + 1, "CS * 2 + 1", 3, 1),
        ] {
            let h: Header = header_with(CS as u32, plaintext_length);
            assert_eq!(h.chunk_count(), expected_chunk_count, "case {case}");
            assert_eq!(
                h.last_chunk_plaintext(),
                expected_last_chunk_plaintext,
                "case {case}"
            );
            let expected_count: u64 = plaintext_length / CS + u64::from(plaintext_length % CS != 0);
            assert_eq!(
                h.total_object_size().unwrap(),
                64 + plaintext_length + 16 * expected_count
            );
        }
    }

    #[test]
    fn rejects_object_size_overflow() {
        let h: Header = header_with(1, u64::MAX);
        assert_eq!(h.total_object_size(), Err(LayoutError::SizeOverflow));
    }

    #[test]
    fn rejects_chunk_range_index_equals_chunk_count() {
        let h: Header = header_with(1, 1);
        assert_eq!(
            h.chunk_range(1).unwrap_err(),
            LayoutError::ChunkIndexOutOfRange {
                index: 1,
                chunk_count: 1
            }
        );
    }

    #[test]
    fn rejects_chunk_range_max_index() {
        let h: Header = header_with(1, 1);
        assert_eq!(
            h.chunk_range(u64::MAX).unwrap_err(),
            LayoutError::ChunkIndexOutOfRange {
                index: u64::MAX,
                chunk_count: 1
            }
        );
    }

    #[test]
    fn rejects_chunk_range_beyond_u64() {
        let h: Header = header_with(1, u64::MAX);
        assert!(matches!(
            h.chunk_range(u64::MAX - 1),
            Err(LayoutError::SizeOverflow)
        ));
    }

    #[test]
    // The object as a whole exceeds u64, but chunk 0's range does not; chunk_range checks its own arithmetic and deliberately does not call total_object_size
    fn succeeds_on_not_representable_object() {
        let h: Header = header_with(1, u64::MAX);
        assert_eq!(h.chunk_range(0).unwrap(), 64..81);
    }

    #[test]
    fn computes_chunk_range_correctly() {
        for (plaintext_length, case, expected_chunk_count, expected_last_chunk_plaintext) in [
            (1, "1", 1, 1),
            (CS - 1, "CS - 1", 1, CS - 1),
            (CS, "CS", 1, CS),
            (CS + 1, "CS + 1", 2, 1),
            (CS * 2, "CS * 2", 2, CS),
            (CS * 2 + 1, "CS * 2 + 1", 3, 1),
        ] {
            let h: Header = header_with(CS as u32, plaintext_length);
            assert_eq!(h.chunk_count(), expected_chunk_count, "case {case}");
            assert_eq!(
                h.last_chunk_plaintext(),
                expected_last_chunk_plaintext,
                "case {case}"
            );
            let expected_count: u64 = plaintext_length / CS + u64::from(plaintext_length % CS != 0);
            assert_eq!(
                h.total_object_size().unwrap(),
                64 + plaintext_length + 16 * expected_count
            );
        }
    }

    proptest! {
        #[test]
            fn chunk_ranges_tile_the_object(
                chunk_size in 1u32..=64,
                plaintext_length in 1u64..=1000,
            ) {
                let h = header_with(chunk_size, plaintext_length);
                let chunk_count = h.chunk_count();
                prop_assert_eq!(
                    h.chunk_range(0).unwrap().start,
                    64
                );
                let mut previous_end: u64 = 64;
                for i in 0..chunk_count {
                    let r = h.chunk_range(i).unwrap();
                    // each range starts exactly where the previous ended
                    prop_assert_eq!(
                        r.start,
                        previous_end
                    );
                    previous_end = r.end;
                    // length is ciphertext_chunk_size for every i except the last, and last_chunk_plaintext + 16 for the last
                    let length = r.end - r.start;
                    if i == chunk_count - 1 {
                        prop_assert_eq!(
                            length,
                            h.last_chunk_plaintext() + 16
                        );
                    } else {
                        prop_assert_eq!(
                            length,
                            h.ciphertext_chunk_size()
                        );
                    }
                }
                prop_assert_eq!(
                    h.chunk_range(chunk_count - 1).unwrap().end,
                    h.total_object_size().unwrap()
                );
                prop_assert_eq!(
                    h.chunk_range(chunk_count).unwrap_err(),
                    LayoutError::ChunkIndexOutOfRange {
                        index: chunk_count,
                        chunk_count,
                    }
                );
                let cs = chunk_size as u64;
                prop_assert_eq!(
                    chunk_count,
                    plaintext_length / cs + u64::from(plaintext_length % cs != 0)
                );
            }
    }

    proptest! {
        #[test]
        fn chunk_range_holds_at_any_index(
            chunk_size in 1u32..,
            plaintext_length in 1u64..,
            seed in any::<u64>(),
        ) {
            let h = header_with(chunk_size, plaintext_length);
            let cc = h.chunk_count();
            let i = seed % cc;
            let range_or_err = h.chunk_range(i);
            let next_range_or_err = h.chunk_range(i + 1);
            if let Ok(range_or_err) = &range_or_err {
                let length = range_or_err.end - range_or_err.start;
                let expected = if i == cc - 1 {
                    h.last_chunk_plaintext() + 16
                } else {
                    h.ciphertext_chunk_size()
                };
                prop_assert_eq!(length, expected);
            }
            if i + 1 < cc  && let Ok(range_or_err) = &range_or_err && let Ok(next_range_or_err) = &next_range_or_err {
                prop_assert_eq!(range_or_err.end, next_range_or_err.start);
            }
            if let Err(range_or_err) = range_or_err {
                prop_assert_eq!(
                    range_or_err,
                    LayoutError::SizeOverflow
                );
            }
            prop_assert_eq!(
                h.chunk_range(cc).unwrap_err(),
                LayoutError::ChunkIndexOutOfRange { index: cc, chunk_count: cc }
            );
        }
    }

    #[test]
    fn chunk_ranges_read_back_from_a_seekable_source() {
        let h: Header = header_with(64, 200);
        let chunk_count: u64 = h.chunk_count();
        let total: u64 = h.total_object_size().unwrap();
        let mut src: Cursor<Vec<u8>> = Cursor::new(vec![0u8; total as usize]);
        for i in 0..chunk_count {
            let r: Range<u64> = h.chunk_range(i).unwrap();
            let mut buf: Vec<u8> = vec![0u8; (r.end - r.start) as usize];
            src.seek(SeekFrom::Start(r.start)).unwrap();
            src.read_exact(&mut buf).unwrap();
        }
        assert_eq!(src.position(), total);
    }

    // Nonce Derivation Tests
    // ----------------------------------------------------
    #[test]
    fn nonce_counter_is_little_endian() {
        let h: Header = header_with(1, 1);

        for (i, tail) in [
            (0u64, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
            (1, [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
            (
                0x0807060504030201,
                [0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08],
            ),
        ] {
            let mut expected = [0u8; 24];
            expected[0..16].copy_from_slice(&h.base_nonce);
            expected[16..24].copy_from_slice(&tail);
            assert_eq!(h.nonce(i), expected, "i = {i:#x}");
        }
    }

    #[test]
    fn succeeds_in_derivate_nonce_from_chunk_count() {
        // `nonce` deliberately does not validate `i` — index checking lives in
        // `chunk_range`. This pins that an out-of-range index still yields the
        // §4 nonce rather than a clamped or sentinel value.
        let h: Header = header_with(64, 200); // chunk_count == 4
        let mut expected: [u8; 24] = [0u8; 24];
        expected[0..16].copy_from_slice(&h.base_nonce);
        expected[16..24].copy_from_slice(&4u64.to_le_bytes());
        assert_eq!(h.nonce(h.chunk_count()), expected);
    }

    proptest! {
        #[test]
        fn nonce_is_base_nonce_followed_by_le_counter(i in any::<u64>(), j in any::<u64>()) {
            let h = header_with(64, 200);
            let n = h.nonce(i);

            prop_assert_eq!(&n[0..16], &h.base_nonce[..]);
            prop_assert_eq!(u64::from_le_bytes(n[16..24].try_into().unwrap()), i);

            if i != j {
                prop_assert_ne!(h.nonce(i), h.nonce(j));
            }
        }
    }
}
