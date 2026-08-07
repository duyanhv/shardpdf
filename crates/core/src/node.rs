//! napi bindings (feature `node`). All orchestration lives in TypeScript;
//! this file only marshals across the boundary.

use crate::{assembler, outline};
use napi_derive::napi;

/// One bookmark in the document outline (flat preorder list; `level` gives
/// nesting — a child is exactly one level deeper than its parent).
#[napi(object)]
pub struct OutlineEntry {
    pub title: String,
    /// 0-based absolute page index in the assembled document.
    pub page_index: u32,
    pub level: u32,
}

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
    pub fn new(output_path: String) -> napi::Result<Self> {
        Ok(Assembly {
            inner: Some(assembler::Assembly::new(output_path).map_err(to_napi_err)?),
        })
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

    /// Writes the assembled document, with optional bookmarks. Consumed.
    #[napi]
    pub fn finalize(&mut self, outline: Option<Vec<OutlineEntry>>) -> napi::Result<()> {
        let entries: Option<Vec<outline::OutlineEntry>> = outline.map(|list| {
            list.into_iter()
                .map(|e| outline::OutlineEntry {
                    title: e.title,
                    page_index: e.page_index,
                    level: e.level,
                })
                .collect()
        });
        self.inner
            .take()
            .ok_or_else(|| napi::Error::from_reason("assembly already finalized"))?
            .finalize(entries.as_deref())
            .map_err(to_napi_err)
    }
}
