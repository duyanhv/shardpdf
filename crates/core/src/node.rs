//! napi bindings (feature `node`). All orchestration lives in TypeScript;
//! this file only marshals across the boundary.

use crate::{assembler, extract, inspect, outline};
use napi_derive::napi;

/// Extract an inclusive, 1-based page range from `inputPath` into
/// `outputPath`, copying only objects the selected pages reach. Returns the
/// extracted page count. v1 drops link annotations, named destinations, and
/// outlines from the result — parity note: a qpdf page slice also loses
/// bookmarks, and keeps links only as silently-dangling targets.
#[napi]
pub fn extract_pages(
    input_path: String,
    start_page: u32,
    end_page: u32,
    output_path: String,
) -> napi::Result<u32> {
    extract::extract_pages(
        std::path::Path::new(&input_path),
        start_page,
        end_page,
        std::path::Path::new(&output_path),
    )
    .map_err(to_napi_err)
}

/// One bookmark in the document outline (flat preorder list; `level` gives
/// nesting — a child is exactly one level deeper than its parent).
#[napi(object)]
pub struct OutlineEntry {
    pub title: String,
    /// 0-based absolute page index in the assembled document.
    pub page_index: u32,
    pub level: u32,
}

/// Errors cross the boundary as `[CODE] message`; the JS wrapper parses the
/// prefix into `ShardPdfError.code`. Codes are API — see AssemblyError::code.
fn to_napi_err(e: assembler::AssemblyError) -> napi::Error {
    napi::Error::from_reason(format!("[{}] {}", e.code(), e))
}

fn already_finalized() -> napi::Error {
    napi::Error::from_reason("[ALREADY_FINALIZED] assembly already finalized")
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
            .ok_or_else(already_finalized)?
            .append_shard_file(std::path::Path::new(&shard_path))
            .map_err(to_napi_err)
    }

    /// Total pages appended so far.
    #[napi(getter)]
    pub fn page_count(&self) -> napi::Result<u32> {
        Ok(self
            .inner
            .as_ref()
            .ok_or_else(already_finalized)?
            .page_count() as u32)
    }

    /// Closes the partial output without finalizing it. Consumed.
    #[napi]
    pub fn abort(&mut self) -> napi::Result<()> {
        self.inner.take().ok_or_else(already_finalized)?;
        Ok(())
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
            .ok_or_else(already_finalized)?
            .finalize(entries.as_deref())
            .map_err(to_napi_err)
    }
}

/// One inclusive, 1-based page range for multi-slice extraction.
#[napi(object)]
pub struct ExtractRangeSpec {
    pub start_page: u32,
    pub end_page: u32,
    pub output_path: String,
}

/// Structural validation summary.
#[napi(object)]
pub struct ValidationReport {
    pub page_count: u32,
    pub named_destinations: u32,
}

/// Parses a source PDF once and serves any number of page-range extractions
/// from it — the multi-slice selective-download pattern.
#[napi]
pub struct Extractor {
    inner: extract::Extractor,
}

#[napi]
impl Extractor {
    #[napi(constructor)]
    pub fn new(input_path: String) -> napi::Result<Self> {
        Ok(Extractor {
            inner: extract::Extractor::open(std::path::Path::new(&input_path))
                .map_err(to_napi_err)?,
        })
    }

    /// Total pages in the parsed source.
    #[napi(getter)]
    pub fn page_count(&self) -> u32 {
        self.inner.page_count()
    }

    /// Extracts one inclusive, 1-based range; returns the slice's page count.
    #[napi]
    pub fn extract_range(
        &self,
        start_page: u32,
        end_page: u32,
        output_path: String,
    ) -> napi::Result<u32> {
        self.inner
            .extract_range(start_page, end_page, std::path::Path::new(&output_path))
            .map_err(to_napi_err)
    }
}

/// Parses the document and returns its page count.
#[napi]
pub fn page_count(input_path: String) -> napi::Result<u32> {
    inspect::page_count(std::path::Path::new(&input_path)).map_err(to_napi_err)
}

/// Structural validation: parses, resolves every page, and verifies every
/// named destination targets a live page (the corruption qpdf --check misses).
#[napi]
pub fn validate(input_path: String) -> napi::Result<ValidationReport> {
    let report = inspect::validate(std::path::Path::new(&input_path)).map_err(to_napi_err)?;
    Ok(ValidationReport {
        page_count: report.page_count,
        named_destinations: report.named_destinations,
    })
}
