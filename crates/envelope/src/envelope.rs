use crate::{
    Header, HeaderError, LayoutError,
    chunk::{ChunkError, decrypt_chunk, encrypt_chunk},
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

pub(crate) fn decrypt<K: ChunkKey>(key: &K, object: &[u8]) -> Result<Vec<u8>, EnvelopeError> {
    let header: Header = Header::parse(object)?;
    let total: u64 = header.total_object_size()?;

    // These two guards MUST run before the allocation below. `plaintext_length`
    // comes from the header, which is attacker-controlled, and a failed
    // allocation aborts the process rather than returning an error. Because the
    // guards establish `object.len() == total`, the capacity requested below is
    // bounded by input the caller already holds in memory.
    if object.len() < total as usize {
        return Err(EnvelopeError::ObjectTooShort {
            expected: total,
            got: object.len(),
        });
    }

    if object.len() > total as usize {
        return Err(EnvelopeError::TrailingBytes {
            expected: total,
            got: object.len(),
        });
    }

    let mut out: Vec<u8> = Vec::with_capacity(header.plaintext_length() as usize);
    for i in 0..header.chunk_count() {
        let r: std::ops::Range<u64> = header.chunk_range(i)?;
        let chunk: &[u8] = &object[r.start as usize..r.end as usize];
        out.extend_from_slice(&decrypt_chunk(key, &header, i, chunk)?);
    }

    debug_assert_eq!(out.len() as u64, header.plaintext_length());
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

    #[test]
    fn decrypts_to_original_plaintext() {
        for (chunk_size, plaintext_length, chunk_count) in [
            (64u32, 64u64, 1),
            (64u32, 65u64, 2),
            (64u32, (64u64 * 2), 2),
            (64u32, (64u64 * 2 + 1), 3),
        ] {
            let k: crate::AssetKey = asset_key();
            let plaintext: Vec<u8> = (0..plaintext_length)
                .map(|b: u64| b as u8)
                .collect::<Vec<u8>>();
            let header: Header =
                Header::new(ASSET_ID, BASE_NONCE, chunk_size, plaintext_length).unwrap();

            let ciphertext: Vec<u8> = encrypt_with_header(&k, &header, &plaintext).unwrap();
            let decrypted: Vec<u8> = decrypt(&k, &ciphertext).unwrap();

            assert_eq!(header.chunk_count(), chunk_count);
            assert_eq!(decrypted.len() as u64, plaintext_length);
            assert_eq!(decrypted, plaintext);
        }
    }

    #[test]
    fn rejects_ciphertext_shorter_than_total_object_size() {
        let plaintext_length: u64 = 64;
        let chunk_size: u32 = 64;
        let k: crate::AssetKey = asset_key();
        let plaintext: Vec<u8> = (0..plaintext_length)
            .map(|b: u64| b as u8)
            .collect::<Vec<u8>>();
        let header: Header =
            Header::new(ASSET_ID, BASE_NONCE, chunk_size, plaintext_length).unwrap();

        let mut ciphertext: Vec<u8> = encrypt_with_header(&k, &header, &plaintext).unwrap();
        ciphertext.pop();

        assert_eq!(
            decrypt(&k, &ciphertext).unwrap_err(),
            EnvelopeError::ObjectTooShort {
                expected: header.total_object_size().unwrap(),
                got: 143
            }
        )
    }

    #[test]
    fn rejects_ciphertext_longer_than_total_object_size() {
        let plaintext_length: u64 = 64;
        let chunk_size: u32 = 64;
        let k: crate::AssetKey = asset_key();
        let plaintext: Vec<u8> = (0..plaintext_length)
            .map(|b: u64| b as u8)
            .collect::<Vec<u8>>();
        let header: Header =
            Header::new(ASSET_ID, BASE_NONCE, chunk_size, plaintext_length).unwrap();

        let mut ciphertext: Vec<u8> = encrypt_with_header(&k, &header, &plaintext).unwrap();
        ciphertext.push(0);

        assert_eq!(
            decrypt(&k, &ciphertext).unwrap_err(),
            EnvelopeError::TrailingBytes {
                expected: header.total_object_size().unwrap(),
                got: 145
            }
        )
    }

    #[test]
    fn rejects_ciphertext_with_swapped_chunks() {
        let plaintext_length: u64 = 128;
        let chunk_size: u32 = 64;
        let k: crate::AssetKey = asset_key();
        let plaintext: Vec<u8> = (0..plaintext_length)
            .map(|b: u64| b as u8)
            .collect::<Vec<u8>>();
        let header: Header =
            Header::new(ASSET_ID, BASE_NONCE, chunk_size, plaintext_length).unwrap();

        let ciphertext: Vec<u8> = encrypt_with_header(&k, &header, &plaintext).unwrap();

        let r0: std::ops::Range<u64> = header.chunk_range(0).unwrap();
        let r1: std::ops::Range<u64> = header.chunk_range(1).unwrap();
        assert_eq!(
            r0.end - r0.start,
            r1.end - r1.start,
            "swap requires equal chunks"
        );

        let mut swapped: Vec<u8> = Vec::with_capacity(ciphertext.len());
        swapped.extend_from_slice(&ciphertext[0..64]); // header, unchanged
        swapped.extend_from_slice(&ciphertext[r1.start as usize..r1.end as usize]); // chunk 1
        swapped.extend_from_slice(&ciphertext[r0.start as usize..r0.end as usize]); // chunk 0

        assert_eq!(
            decrypt(&k, &swapped).unwrap_err(),
            EnvelopeError::AuthenticationFailed
        )
    }

    #[test]
    fn rejects_truncated_object_with_adjusted_length() {
        let plaintext_length: u64 = 128;
        let chunk_size: u32 = 64;
        let k: crate::AssetKey = asset_key();
        let plaintext: Vec<u8> = (0..plaintext_length)
            .map(|b: u64| b as u8)
            .collect::<Vec<u8>>();
        let header: Header =
            Header::new(ASSET_ID, BASE_NONCE, chunk_size, plaintext_length).unwrap();

        let ciphertext: Vec<u8> = encrypt_with_header(&k, &header, &plaintext).unwrap();
        let mut truncated: Vec<u8> = ciphertext[0..144].to_vec();
        truncated[28..36].copy_from_slice(&64u64.to_le_bytes()); // §3.1: plaintext_length

        assert_eq!(
            decrypt(&k, &truncated).unwrap_err(),
            EnvelopeError::AuthenticationFailed
        )
    }
}
