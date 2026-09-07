use crate::{
    AlbumKey, HeaderError, LayoutError,
    chunk::{ChunkError, decrypt_chunk, encrypt_chunk},
    header::Header,
    keys::ChunkKey,
};
use std::io::{Read, Seek, SeekFrom};

#[derive(Debug, PartialEq)]
pub enum EnvelopeError {
    PlaintextLengthMismatch { expected: u64, got: usize },
    ObjectTooShort { expected: u64, got: usize },
    TrailingBytes { expected: u64, got: usize },
    Header(HeaderError),
    Layout(LayoutError),
    AuthenticationFailed,
    RandomnessUnavailable,
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

pub(crate) fn encrypt_object<K: ChunkKey>(
    key: &K,
    asset_id: &[u8; 16],
    plaintext: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    let mut base_nonce: [u8; 16] = [0u8; 16];
    getrandom::fill(&mut base_nonce).map_err(|_| EnvelopeError::RandomnessUnavailable)?;

    let header: Header = Header::new(*asset_id, base_nonce, CHUNK_SIZE, plaintext.len() as u64)?;

    encrypt_with_header(key, &header, plaintext)
}

pub fn encrypt_asset(
    album: &AlbumKey,
    asset_id: &[u8; 16],
    plaintext: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    encrypt_object(&album.derive_asset(asset_id), asset_id, plaintext)
}

pub fn encrypt_thumb(
    album: &AlbumKey,
    asset_id: &[u8; 16],
    plaintext: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    encrypt_object(&album.derive_thumb(asset_id), asset_id, plaintext)
}

pub fn encrypt_meta(
    album: &AlbumKey,
    asset_id: &[u8; 16],
    plaintext: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    encrypt_object(&album.derive_meta(asset_id), asset_id, plaintext)
}

pub fn decrypt_asset(
    album: &AlbumKey,
    asset_id: &[u8; 16],
    object: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    decrypt(&album.derive_asset(asset_id), object)
}

pub fn decrypt_thumb(
    album: &AlbumKey,
    asset_id: &[u8; 16],
    object: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    decrypt(&album.derive_thumb(asset_id), object)
}

pub fn decrypt_meta(
    album: &AlbumKey,
    asset_id: &[u8; 16],
    object: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    decrypt(&album.derive_meta(asset_id), object)
}

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

struct CountingReader<R> {
    inner: R,
    bytes_read: usize,
}

impl<R> CountingReader<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            bytes_read: 0,
        }
    }
    fn bytes_read(&self) -> usize {
        self.bytes_read
    }
}

impl<R: Read> Read for CountingReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.bytes_read += n;
        Ok(n)
    }
}

impl<R: Seek> Seek for CountingReader<R> {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(pos)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::decrypt_chunk;
    use crate::header::Header;
    use crate::test_fixtures::{
        ASSET_ID, BASE_NONCE, PLAINTEXT, PLAINTEXT_65, album_key, asset_key, hex,
    };
    use std::fs::File;
    use std::io::{Read, SeekFrom, Write};
    use tempfile::NamedTempFile;

    /// Self-generated. Sound per §9.2 because the primitives beneath it are
    /// externally anchored — category 6 (BLAKE2b, keys.rs) and category 7
    /// (XChaCha20-Poly1305, chunk.rs). Pins §3's layout, §4's nonce derivation and
    /// §5's AAD composition as one value. This is C.9's category 1 vector.
    #[rustfmt::skip]
    const KNOWN_ANSWER_ENVELOPE: &str = "5654524e01010000a0a1a2a3a4a5a6a7a8a9aaabacadaeaf400000004100000000000000b0b1b2b3b4b5b6b7b8b9babbbcbdbebf000000000000000000000000928301e29c278da2388ceb0a6d2c899ccce96d7f0d3df9189ec325c28fbd0d76956206aee01bce1fb25da71b81d238bf57c33f5bc200f6aa261cdeefb78cb32494cc419c54159c0b002af3c4a06aa116cf2d8e418d74bff9feb72b43ea4a9e2324";

    #[test]
    fn encrypts_to_expected_layout() {
        for (chunk_size, plaintext_length, chunk_count) in [
            (64u32, 64u64, 1),
            (64u32, 65u64, 2),
            (64u32, (64u64 * 2), 2),
            (64u32, (64u64 * 2 + 1), 3),
        ] {
            let k: crate::keys::AssetKey = asset_key();
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
        let k: crate::keys::AssetKey = asset_key();
        let mut plaintext: Vec<u8> = (0..plaintext_length)
            .map(|b: u64| b as u8)
            .collect::<Vec<u8>>();
        plaintext.pop();
        let header: Header = Header::new(ASSET_ID, BASE_NONCE, 64u32, plaintext_length).unwrap();
        assert_eq!(
            encrypt_with_header(&k, &header, &plaintext).unwrap_err(),
            EnvelopeError::PlaintextLengthMismatch {
                expected: plaintext_length,
                got: 63
            }
        )
    }

    #[test]
    fn rejects_plaintext_longer_than_header() {
        let plaintext_length: u64 = 64u64;
        let k: crate::keys::AssetKey = asset_key();
        let mut plaintext: Vec<u8> = (0..plaintext_length)
            .map(|b: u64| b as u8)
            .collect::<Vec<u8>>();
        plaintext.push(0);
        let header: Header = Header::new(ASSET_ID, BASE_NONCE, 64u32, plaintext_length).unwrap();
        assert_eq!(
            encrypt_with_header(&k, &header, &plaintext).unwrap_err(),
            EnvelopeError::PlaintextLengthMismatch {
                expected: plaintext_length,
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
            let k: crate::keys::AssetKey = asset_key();
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
        let k: crate::keys::AssetKey = asset_key();
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
        let k: crate::keys::AssetKey = asset_key();
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
        let k: crate::keys::AssetKey = asset_key();
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
        let k: crate::keys::AssetKey = asset_key();
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

    // Public API Tests
    // -----------------------------------------------------

    #[test]
    fn encrypts_and_decrypts_an_asset() {
        let album: AlbumKey = album_key();
        let object: Vec<u8> = encrypt_asset(&album, &ASSET_ID, PLAINTEXT).unwrap();
        let plaintext: Vec<u8> = decrypt_asset(&album, &ASSET_ID, &object).unwrap();
        assert_eq!(plaintext, PLAINTEXT);
    }

    #[test]
    fn encrypts_and_decrypts_a_thumbnail() {
        let album: AlbumKey = album_key();
        let object: Vec<u8> = encrypt_thumb(&album, &ASSET_ID, PLAINTEXT).unwrap();
        let plaintext: Vec<u8> = decrypt_thumb(&album, &ASSET_ID, &object).unwrap();
        assert_eq!(plaintext, PLAINTEXT);
    }

    #[test]
    fn encrypts_and_decrypts_metadata() {
        let album: AlbumKey = album_key();
        let object: Vec<u8> = encrypt_meta(&album, &ASSET_ID, PLAINTEXT).unwrap();
        let plaintext: Vec<u8> = decrypt_meta(&album, &ASSET_ID, &object).unwrap();
        assert_eq!(plaintext, PLAINTEXT);
    }

    #[test]
    fn rejects_asset_object_decrypted_as_thumb() {
        let album: AlbumKey = album_key();
        let object: Vec<u8> = encrypt_asset(&album, &ASSET_ID, PLAINTEXT).unwrap();
        assert_eq!(
            decrypt_thumb(&album, &ASSET_ID, &object).unwrap_err(),
            EnvelopeError::AuthenticationFailed
        );
    }

    #[test]
    fn rejects_thumb_object_decrypted_as_meta() {
        let album: AlbumKey = album_key();
        let object: Vec<u8> = encrypt_thumb(&album, &ASSET_ID, PLAINTEXT).unwrap();
        assert_eq!(
            decrypt_meta(&album, &ASSET_ID, &object).unwrap_err(),
            EnvelopeError::AuthenticationFailed
        );
    }

    #[test]
    fn rejects_meta_object_decrypted_as_asset() {
        let album: AlbumKey = album_key();
        let object: Vec<u8> = encrypt_meta(&album, &ASSET_ID, PLAINTEXT).unwrap();
        assert_eq!(
            decrypt_asset(&album, &ASSET_ID, &object).unwrap_err(),
            EnvelopeError::AuthenticationFailed
        );
    }

    #[test]
    fn creates_new_base_nonce_for_every_encryption() {
        let album: AlbumKey = album_key();
        let a: Vec<u8> = encrypt_asset(&album, &ASSET_ID, PLAINTEXT).unwrap();
        let b: Vec<u8> = encrypt_asset(&album, &ASSET_ID, PLAINTEXT).unwrap();
        assert_ne!(a[8..24], b[8..24]);
    }

    #[test]
    fn matches_known_answer_envelope() {
        let header = Header::new(ASSET_ID, BASE_NONCE, 64, 65).unwrap();
        let object = encrypt_with_header(&asset_key(), &header, PLAINTEXT_65).unwrap();

        assert_eq!(Header::parse(&object).unwrap().chunk_size(), 64);
        assert_eq!(hex(&object), KNOWN_ANSWER_ENVELOPE);
    }

    // C.7 Tests
    // -----------------------------------------------------
    #[test]
    fn decrypts_chunk_i_given_only_k_asset() {
        // Build the object in memory first — that part isn't what's being tested.
        let header = Header::new(ASSET_ID, BASE_NONCE, 64, 300).unwrap(); // 5 chunks, last is 44 bytes
        let plaintext: Vec<u8> = (0..300u64).map(|b| b as u8).collect();
        let object = encrypt_with_header(&asset_key(), &header, &plaintext).unwrap();

        let mut tmp = NamedTempFile::new().unwrap();
        tmp.write_all(&object).unwrap();

        for i in [0u64, 2, header.chunk_count() - 1] {
            // Fresh handle per index, so the counter sees only this iteration's reads.
            let mut file = CountingReader::new(File::open(tmp.path()).unwrap());

            let mut header_buf = [0u8; 64];
            file.read_exact(&mut header_buf).unwrap();
            let parsed = Header::parse(&header_buf).unwrap();

            let range = parsed.chunk_range(i).unwrap();
            let len = (range.end - range.start) as usize;
            let mut chunk = vec![0u8; len];
            file.seek(SeekFrom::Start(range.start)).unwrap();
            file.read_exact(&mut chunk).unwrap();

            let got = decrypt_chunk(&asset_key(), &parsed, i, &chunk).unwrap();

            let cs = parsed.chunk_size() as usize;
            let start = i as usize * cs;
            let end = ((i as usize + 1) * cs).min(plaintext.len());

            assert_eq!(got.as_slice(), &plaintext[start..end]);
            assert_eq!(file.bytes_read(), 64 + len);
        }
    }
}
