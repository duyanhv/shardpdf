//! shardpdf core: streaming shard assembler. The `node` feature (default)
//! adds the napi surface — deliberately tiny (design spec §Architecture):
//! createAssembly → appendShard → finalize. Built without default features
//! the crate is pure Rust, which is how the fuzz harness consumes it.

#![deny(clippy::all)]

pub mod assembler;
pub mod outline;
pub mod serializer;

#[cfg(feature = "node")]
mod node;
#[cfg(feature = "node")]
pub use node::*;
