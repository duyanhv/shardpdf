//! napi bindings (feature `node`). All orchestration lives in TypeScript;
//! this file only marshals across the boundary.
//!
//! Every binding is `catch_unwind`: a panic anywhere in the core surfaces as
//! a JavaScript exception instead of aborting the host process.
//!
//! Errors carry a stable `code` property (see [`ErrorCode`]) so callers can
//! branch on the class of failure without matching on message text.
//!
//! All calls are synchronous and run on the JavaScript thread. A 500-page
//! shard blocks the event loop for tens of milliseconds; callers that need
//! liveness should yield between appends (the `assemble()` wrapper does).

use crate::{assembler, extract, outline};
use napi_derive::napi;

/// Stable error codes exposed as `error.code` on the JavaScript side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    /// The shard could not be parsed as a PDF.
    PdfParse,
    /// Filesystem failure reading a shard or writing the output.
    Io,
    /// The shard parsed but violates a structural expectation
    /// (no pages, cyclic parent chain, duplicate destination, bad outline).
    Malformed,
    /// A method was called on an assembly already consumed by
    /// `finalize()` or `abort()`.
    Consumed,
    /// A JavaScript argument was out of range or of the wrong shape.
    InvalidArg,
}

impl AsRef<str> for ErrorCode {
    fn as_ref(&self) -> &str {
        match self {
            ErrorCode::PdfParse => "SHARDPDF_PDF_PARSE",
            ErrorCode::Io => "SHARDPDF_IO",
            ErrorCode::Malformed => "SHARDPDF_MALFORMED",
            ErrorCode::Consumed => "SHARDPDF_CONSUMED",
            ErrorCode::InvalidArg => "SHARDPDF_INVALID_ARG",
        }
    }
}

type Result<T> = napi::Result<T, ErrorCode>;

fn to_napi_err(e: assembler::AssemblyError) -> napi::Error<ErrorCode> {
    let code = match &e {
        assembler::AssemblyError::Pdf(_) => ErrorCode::PdfParse,
        assembler::AssemblyError::Io(_) => ErrorCode::Io,
        assembler::AssemblyError::Malformed(_) => ErrorCode::Malformed,
    };
    napi::Error::new(code, e.to_string())
}

fn consumed() -> napi::Error<ErrorCode> {
    napi::Error::new(ErrorCode::Consumed, "assembly already finalized or aborted")
}

/// `u32` parameters arrive as f64 from JavaScript; napi truncates silently
/// (`1.7` → `1`, `-1` → `4294967295`). Validate here so misuse is loud.
fn page_number(value: f64, name: &str) -> Result<u32> {
    if !value.is_finite() || value.fract() != 0.0 || value < 0.0 || value > u32::MAX as f64 {
        return Err(napi::Error::new(
            ErrorCode::InvalidArg,
            format!("{name} must be a non-negative integer, got {value}"),
        ));
    }
    Ok(value as u32)
}

/// Extract an inclusive, 1-based page range from `inputPath` into
/// `outputPath`, copying only objects the selected pages reach. Returns the
/// extracted page count. v1 drops link annotations, named destinations, and
/// outlines from the result — parity note: a qpdf page slice also loses
/// bookmarks, and keeps links only as silently-dangling targets.
#[napi(catch_unwind)]
pub fn extract_pages(
    input_path: String,
    start_page: f64,
    end_page: f64,
    output_path: String,
) -> Result<u32> {
    let start_page = page_number(start_page, "startPage")?;
    let end_page = page_number(end_page, "endPage")?;
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

#[napi]
pub struct Assembly {
    inner: Option<assembler::Assembly>,
}

#[napi]
impl Assembly {
    #[napi(constructor, catch_unwind)]
    pub fn new(output_path: String) -> Result<Self> {
        Ok(Assembly {
            inner: Some(assembler::Assembly::new(output_path).map_err(to_napi_err)?),
        })
    }

    /// Appends one complete single-shard PDF; returns its page count.
    /// Synchronous: blocks the event loop for the duration of the parse.
    #[napi(catch_unwind)]
    pub fn append_shard(&mut self, shard_path: String) -> Result<u32> {
        self.inner
            .as_mut()
            .ok_or_else(consumed)?
            .append_shard_file(std::path::Path::new(&shard_path))
            .map_err(to_napi_err)
    }

    /// Total pages appended so far.
    #[napi(getter, catch_unwind)]
    pub fn page_count(&self) -> Result<u32> {
        Ok(self.inner.as_ref().ok_or_else(consumed)?.page_count() as u32)
    }

    /// Whether `finalize()` or `abort()` has already consumed this assembly.
    #[napi(getter)]
    pub fn consumed(&self) -> bool {
        self.inner.is_none()
    }

    /// Closes the partial output without finalizing it. Idempotent: calling
    /// it on an already-consumed assembly is a no-op, so `finally` blocks can
    /// call it unconditionally.
    #[napi(catch_unwind)]
    pub fn abort(&mut self) {
        self.inner.take();
    }

    /// Writes the assembled document, with optional bookmarks. Consumed.
    #[napi(catch_unwind)]
    pub fn finalize(&mut self, outline: Option<Vec<OutlineEntry>>) -> Result<()> {
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
            .ok_or_else(consumed)?
            .finalize(entries.as_deref())
            .map_err(to_napi_err)
    }
}
