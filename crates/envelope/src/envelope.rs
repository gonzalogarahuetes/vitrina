use crate::{
    Header, HeaderError, LayoutError,
    chunk::{ChunkError, encrypt_chunk},
    keys::ChunkKey,
};

#[derive(Debug, PartialEq)]
pub enum EnvelopeError {
    PlaintextLengthMismatch { expected: u64, got: usize },
    ObjectTooShort { expected: u64, got: usize },
    TrailingBytes { expected: u64, got: usize },
    Header(HeaderError),
    Layout(LayoutError),
    AuthenticationFailed,
}

impl From<LayoutError> for EnvelopeError {
    fn from(e: LayoutError) -> Self {
        EnvelopeError::Layout(e)
    }
}

impl From<HeaderError> for EnvelopeError {
    fn from(e: HeaderError) -> Self {
        EnvelopeError::Header(e)
    }
}

impl From<ChunkError> for EnvelopeError {
    /// Exhaustive on purpose. If `ChunkError` ever gains a variant that isn't
    /// an authentication failure, this must fail to compile rather than
    /// silently reporting it as one.
    fn from(e: ChunkError) -> Self {
        match e {
            ChunkError::AuthenticationFailed => EnvelopeError::AuthenticationFailed,
        }
    }
}

/// §3.1: version 1 writers MUST write 262144 (256 KiB). `encrypt` takes no
/// chunk size, so a caller cannot express a non-conforming one.
pub const CHUNK_SIZE: u32 = 262_144;

pub(crate) fn encrypt_with_header<K: ChunkKey>(
    key: &K,
    header: &Header,
    plaintext: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    let plaintext_length: u64 = header.plaintext_length();
    if plaintext.len() as u64 != plaintext_length {
        return Err(EnvelopeError::PlaintextLengthMismatch {
            expected: plaintext_length,
            got: plaintext.len(),
        });
    }
    let total: u64 = header.total_object_size()?;
    let mut out: Vec<u8> = Vec::with_capacity(total as usize);
    out.extend_from_slice(&header.to_bytes());

    for i in 0..header.chunk_count() {
        let cs: usize = header.chunk_size() as usize;
        let i: usize = i as usize;
        let start: usize = i * cs;
        let end: usize = ((i + 1) * cs).min(plaintext.len());

        out.extend_from_slice(&encrypt_chunk(
            key,
            header,
            i as u64,
            &plaintext[start..end],
        ));
    }
    debug_assert_eq!(out.len() as u64, total);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Header;
    use crate::chunk::decrypt_chunk;
    use crate::test_fixtures::{ASSET_ID, BASE_NONCE, asset_key};

    #[test]
    fn encrypts_to_expected_layout() {
        for (chunk_size, plaintext_length, chunk_count) in [
            (64u32, 64u64, 1),
            (64u32, 65u64, 2),
            (64u32, (64u64 * 2), 2),
            (64u32, (64u64 * 2 + 1), 3),
        ] {
            let k: crate::AssetKey = asset_key();
            let plaintext: Vec<u8> = (0..plaintext_length).map(|b| b as u8).collect::<Vec<u8>>();
            let header: Header =
                Header::new(ASSET_ID, BASE_NONCE, chunk_size, plaintext_length).unwrap();

            let out: Vec<u8> = encrypt_with_header(&k, &header, &plaintext).unwrap();

            assert_eq!(header.chunk_count(), chunk_count);
            assert_eq!(out.len() as u64, header.total_object_size().unwrap());
            assert_eq!(out[0..64], header.to_bytes());

            for i in 0..header.chunk_count() {
                let range: std::ops::Range<u64> = header.chunk_range(i).unwrap();
                let chunk: &[u8] = &out[range.start as usize..range.end as usize];
                let got: Vec<u8> = decrypt_chunk(&k, &header, i, chunk).unwrap();

                let cs: usize = chunk_size as usize;
                let i: usize = i as usize;
                let start: usize = i * cs;
                let end: usize = ((i + 1) * cs).min(plaintext.len());

                assert_eq!(got.as_slice(), &plaintext[start..end]);
            }
        }
    }

    #[test]
    fn rejects_plaintext_shorter_than_header() {
        let plaintext_length: u64 = 64u64;
        let k: crate::AssetKey = asset_key();
        let mut plaintext: Vec<u8> = (0..plaintext_length)
            .map(|b: u64| b as u8)
            .collect::<Vec<u8>>();
        plaintext.pop();
        let header: Header =
            Header::new(ASSET_ID, BASE_NONCE, 64u32, plaintext_length as u64).unwrap();
        assert_eq!(
            encrypt_with_header(&k, &header, &plaintext).unwrap_err(),
            EnvelopeError::PlaintextLengthMismatch {
                expected: plaintext_length as u64,
                got: 63
            }
        )
    }

    #[test]
    fn rejects_plaintext_longer_than_header() {
        let plaintext_length: u64 = 64u64;
        let k: crate::AssetKey = asset_key();
        let mut plaintext: Vec<u8> = (0..plaintext_length)
            .map(|b: u64| b as u8)
            .collect::<Vec<u8>>();
        plaintext.push(0);
        let header: Header =
            Header::new(ASSET_ID, BASE_NONCE, 64u32, plaintext_length as u64).unwrap();
        assert_eq!(
            encrypt_with_header(&k, &header, &plaintext).unwrap_err(),
            EnvelopeError::PlaintextLengthMismatch {
                expected: plaintext_length as u64,
                got: 65
            }
        )
    }
}
