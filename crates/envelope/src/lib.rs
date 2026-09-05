//! Vitrina encryption envelope.
//!
//! Header layout: encryption spec §3.1. Derived quantities and byte ranges:
//! §3.2, §3.3. Reader validation: §8. The format is permanent — see §0.

// The whole module is unreachable from the library until C.6 gives the crate a
// public envelope API. Remove this when that lands — do not widen it further.
#[allow(dead_code)]
mod chunk;
mod header;
mod keys;
#[cfg(test)]
pub(crate) mod test_fixtures;

pub use header::{Header, HeaderError, LayoutError};
pub use keys::{AlbumKey, AssetKey, MetaKey, ThumbKey};
