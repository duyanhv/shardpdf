//! napi surface — deliberately tiny (design spec §Architecture):
//! createAssembly → appendShard → finalize. Byte-level work only; all
//! orchestration lives in TypeScript. Calls are synchronous in v0; async
//! task variants come with the streaming writer.

#![deny(clippy::all)]

pub mod assembler;

use napi_derive::napi;

fn to_napi_err(e: assembler::AssemblyError) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}

#[napi]
pub struct Assembly {
    inner: Option<assembler::Assembly>,
}

#[napi]
impl Assembly {
    #[napi(constructor)]
    pub fn new(output_path: String) -> Self {
        Assembly {
            inner: Some(assembler::Assembly::new(output_path)),
        }
    }

    /// Appends one complete single-shard PDF; returns its page count.
    #[napi]
    pub fn append_shard(&mut self, shard_path: String) -> napi::Result<u32> {
        self.inner
            .as_mut()
            .ok_or_else(|| napi::Error::from_reason("assembly already finalized"))?
            .append_shard_file(std::path::Path::new(&shard_path))
            .map_err(to_napi_err)
    }

    /// Total pages appended so far.
    #[napi(getter)]
    pub fn page_count(&self) -> napi::Result<u32> {
        Ok(self
            .inner
            .as_ref()
            .ok_or_else(|| napi::Error::from_reason("assembly already finalized"))?
            .page_count() as u32)
    }

    /// Writes the assembled document. The assembly is consumed.
    #[napi]
    pub fn finalize(&mut self) -> napi::Result<()> {
        self.inner
            .take()
            .ok_or_else(|| napi::Error::from_reason("assembly already finalized"))?
            .finalize()
            .map_err(to_napi_err)
    }
}
