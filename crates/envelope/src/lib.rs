//! Vitrina encryption envelope.
//!
//! Header layout: encryption spec §3.1. Derived quantities and byte ranges:
//! §3.2, §3.3. Reader validation: §8. The format is permanent — see §0.

mod chunks;
mod header;
mod keys;

pub use header::{Header, HeaderError, LayoutError};
pub use keys::{AlbumKey, AssetKey, MetaKey, ThumbKey};
