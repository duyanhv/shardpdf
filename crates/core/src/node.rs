//! napi bindings (feature `node`). All orchestration lives in TypeScript;
//! this file only marshals across the boundary.
//!
//! Every binding is `catch_unwind`: an unwinding panic anywhere in the core
//! surfaces as a JavaScript exception instead of aborting the host process.
//! Process-aborting failures (stack overflow, allocator OOM abort,
//! `process::abort`) are outside what `catch_unwind` can intercept.
//!
//! Errors carry a stable `code` property (see [`ErrorCode`]) so callers can
//! branch on the class of failure without matching on message text.
//!
//! All calls are synchronous and run on the JavaScript thread. A 500-page
//! shard blocks the event loop for tens of milliseconds; callers that need
//! liveness should yield between appends (the `assemble()` wrapper does).

use crate::assembler::ShardLoadOptions;
use crate::{assembler, extract, outline};
use napi::bindgen_prelude::{FromNapiValue, JsObjectValue, JsValue, Object, Unknown};
use napi::ValueType;
use napi_derive::napi;

/// Stable error codes exposed as `error.code` on the JavaScript side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    /// The input exists but could not be parsed as a PDF.
    PdfParse,
    /// Filesystem failure: input missing or unreadable, output unwritable.
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

/// Build information for the loaded native module. Benchmarks record this
/// so a debug binary can never be mistaken for a release measurement.
#[napi(object)]
pub struct BuildInfo {
    /// `"release"` or `"debug"` (Cargo profile the binding was compiled with).
    pub profile: String,
    /// Crate version from Cargo.toml.
    pub version: String,
}

#[napi]
pub fn build_info() -> BuildInfo {
    BuildInfo {
        profile: if cfg!(debug_assertions) {
            "debug".into()
        } else {
            "release".into()
        },
        version: env!("CARGO_PKG_VERSION").into(),
    }
}

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

fn invalid_arg(name: &str, expected: &str, value: &Unknown) -> napi::Error<ErrorCode> {
    let got = value
        .get_type()
        .map(|t| format!("{t:?}").to_lowercase())
        .unwrap_or_else(|_| "unknown".into());
    napi::Error::new(
        ErrorCode::InvalidArg,
        format!("{name} must be {expected}, got {got}"),
    )
}

/// napi's own coercion would throw its `StringExpected` status for a wrong
/// type. Take the raw value instead so every argument failure reports
/// `SHARDPDF_INVALID_ARG`.
fn string_arg(value: Unknown, name: &str) -> Result<String> {
    match value.get_type() {
        Ok(ValueType::String) => String::from_unknown(value)
            .map_err(|e| napi::Error::new(ErrorCode::InvalidArg, e.reason)),
        _ => Err(invalid_arg(name, "a string", &value)),
    }
}

fn path_arg(value: Unknown, name: &str) -> Result<String> {
    let s = string_arg(value, name)?;
    if s.is_empty() {
        return Err(napi::Error::new(
            ErrorCode::InvalidArg,
            format!("{name} must be a non-empty path"),
        ));
    }
    Ok(s)
}

/// `u32` parameters arrive as f64 from JavaScript; napi truncates silently
/// (`1.7` → `1`, `-1` → `4294967295`). Validate here so misuse is loud.
fn page_number(value: Unknown, name: &str) -> Result<u32> {
    let n = match value.get_type() {
        Ok(ValueType::Number) => f64::from_unknown(value)
            .map_err(|e| napi::Error::new(ErrorCode::InvalidArg, e.reason))?,
        _ => return Err(invalid_arg(name, "a non-negative integer", &value)),
    };
    if !n.is_finite() || n.fract() != 0.0 || n < 0.0 || n > u32::MAX as f64 {
        return Err(napi::Error::new(
            ErrorCode::InvalidArg,
            format!("{name} must be a non-negative integer, got {n}"),
        ));
    }
    Ok(n as u32)
}

fn type_name(value: &Unknown) -> String {
    value
        .get_type()
        .map(|t| format!("{t:?}").to_lowercase())
        .unwrap_or_else(|_| "unknown".into())
}

fn bad_arg(msg: String) -> napi::Error<ErrorCode> {
    napi::Error::new(ErrorCode::InvalidArg, msg)
}

fn field<'e>(entry: &Object<'e>, index: u32, name: &str) -> Result<Unknown<'e>> {
    entry
        .get_named_property_unchecked::<Unknown>(name)
        .map_err(|e| bad_arg(format!("outline[{index}].{name}: {}", e.reason)))
}

fn u32_field(entry: &Object<'_>, index: u32, name: &str) -> Result<u32> {
    let raw = field(entry, index, name)?;
    let value = match raw.get_type() {
        Ok(ValueType::Number) => f64::from_unknown(raw).map_err(|e| bad_arg(e.reason))?,
        _ => {
            return Err(bad_arg(format!(
                "outline[{index}].{name} must be a non-negative integer, got {}",
                type_name(&raw)
            )))
        }
    };
    if !value.is_finite() || value.fract() != 0.0 || value < 0.0 || value > u32::MAX as f64 {
        return Err(bad_arg(format!(
            "outline[{index}].{name} must be a non-negative integer, got {value}"
        )));
    }
    Ok(value as u32)
}

/// Parses `finalize()`'s optional outline argument with explicit checks, so
/// a wrong shape reports `SHARDPDF_INVALID_ARG` naming the entry and field
/// instead of a napi conversion status, and fractional or negative numbers
/// are rejected rather than silently truncated or wrapped.
fn outline_arg(value: Option<Unknown>) -> Result<Option<Vec<outline::OutlineEntry>>> {
    let Some(value) = value else {
        return Ok(None);
    };
    match value.get_type() {
        Ok(ValueType::Undefined) | Ok(ValueType::Null) => return Ok(None),
        Ok(ValueType::Object) => {}
        _ => {
            return Err(bad_arg(format!(
                "outline must be an array, got {}",
                type_name(&value)
            )))
        }
    }
    let array = Object::from_unknown(value).map_err(|e| bad_arg(e.reason))?;
    if !array.is_array().unwrap_or(false) {
        return Err(bad_arg("outline must be an array, got object".into()));
    }
    let len = array.get_array_length().map_err(|e| bad_arg(e.reason))?;
    let mut entries = Vec::with_capacity(len as usize);
    for index in 0..len {
        let raw: Unknown = array
            .get_element(index)
            .map_err(|e| bad_arg(format!("outline[{index}]: {}", e.reason)))?;
        if !matches!(raw.get_type(), Ok(ValueType::Object)) {
            return Err(bad_arg(format!(
                "outline[{index}] must be an object, got {}",
                type_name(&raw)
            )));
        }
        let entry = Object::from_unknown(raw).map_err(|e| bad_arg(e.reason))?;
        let title_raw = field(&entry, index, "title")?;
        let title = match title_raw.get_type() {
            Ok(ValueType::String) => {
                String::from_unknown(title_raw).map_err(|e| bad_arg(e.reason))?
            }
            _ => {
                return Err(bad_arg(format!(
                    "outline[{index}].title must be a string, got {}",
                    type_name(&title_raw)
                )))
            }
        };
        let page_index = u32_field(&entry, index, "pageIndex")?;
        // `level` is optional at the JS wrapper level (defaults to 0).
        let level_raw = field(&entry, index, "level")?;
        let level = match level_raw.get_type() {
            Ok(ValueType::Undefined) | Ok(ValueType::Null) => 0,
            _ => u32_field(&entry, index, "level")?,
        };
        entries.push(outline::OutlineEntry {
            title,
            page_index,
            level,
        });
    }
    Ok(Some(entries))
}

/// Optional resource limits for parsing shards.
///
/// `maxDecompressedBytes` bounds how far any one compressed stream may
/// inflate while a shard is parsed. Shards you rendered yourself do not
/// need it; set it whenever a path or upload from outside your process can
/// reach `appendShard` or `extractPages`, because a 250 KB file can
/// otherwise allocate gigabytes before the core sees a single page. An
/// over-budget object stream is skipped by the parser, so the shard then
/// fails as `SHARDPDF_MALFORMED` (typically "shard has no pages") or, if
/// only a content stream was oversized, `SHARDPDF_PDF_PARSE`.
#[napi(object)]
#[derive(Default)]
pub struct LoadOptions {
    pub max_decompressed_bytes: Option<u32>,
}

fn load_options_arg(value: Option<Unknown>) -> Result<ShardLoadOptions> {
    let Some(value) = value else {
        return Ok(ShardLoadOptions::default());
    };
    match value.get_type() {
        Ok(ValueType::Undefined) | Ok(ValueType::Null) => return Ok(ShardLoadOptions::default()),
        Ok(ValueType::Object) => {}
        _ => {
            return Err(bad_arg(format!(
                "options must be an object, got {}",
                type_name(&value)
            )))
        }
    }
    let object = Object::from_unknown(value).map_err(|e| bad_arg(e.reason))?;
    let raw: Unknown = object
        .get_named_property_unchecked("maxDecompressedBytes")
        .map_err(|e| bad_arg(format!("options.maxDecompressedBytes: {}", e.reason)))?;
    let max_decompressed_bytes = match raw.get_type() {
        Ok(ValueType::Undefined) | Ok(ValueType::Null) => None,
        Ok(ValueType::Number) => {
            let n = f64::from_unknown(raw).map_err(|e| bad_arg(e.reason))?;
            if !n.is_finite() || n.fract() != 0.0 || n < 1.0 || n > usize::MAX as f64 {
                return Err(bad_arg(format!(
                    "options.maxDecompressedBytes must be a positive integer, got {n}"
                )));
            }
            Some(n as usize)
        }
        _ => {
            return Err(bad_arg(format!(
                "options.maxDecompressedBytes must be a positive integer, got {}",
                type_name(&raw)
            )))
        }
    };
    Ok(ShardLoadOptions {
        max_decompressed_bytes,
    })
}

/// Extract an inclusive, 1-based page range from `inputPath` into
/// `outputPath`, copying only objects the selected pages reach. Returns the
/// extracted page count. v1 drops ALL annotations (links, widgets, and any
/// other /Annots entries), named destinations, and outlines from the result.
/// Parity note: a qpdf page slice also loses bookmarks, but keeps
/// annotations, with links to pages outside the range left dangling.
#[napi(
    catch_unwind,
    ts_args_type = "inputPath: string, startPage: number, endPage: number, outputPath: string, options?: LoadOptions | undefined | null"
)]
pub fn extract_pages(
    input_path: Unknown,
    start_page: Unknown,
    end_page: Unknown,
    output_path: Unknown,
    options: Option<Unknown>,
) -> Result<u32> {
    let input_path = path_arg(input_path, "inputPath")?;
    let start_page = page_number(start_page, "startPage")?;
    let end_page = page_number(end_page, "endPage")?;
    let output_path = path_arg(output_path, "outputPath")?;
    let load_options = load_options_arg(options)?;
    extract::extract_pages_with_options(
        std::path::Path::new(&input_path),
        start_page,
        end_page,
        std::path::Path::new(&output_path),
        &load_options,
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
    /// Nesting depth; defaults to 0 when omitted.
    pub level: Option<u32>,
}

#[napi]
pub struct Assembly {
    inner: Option<assembler::Assembly>,
}

#[napi]
impl Assembly {
    #[napi(
        constructor,
        catch_unwind,
        ts_args_type = "outputPath: string, options?: LoadOptions | undefined | null"
    )]
    pub fn new(output_path: Unknown, options: Option<Unknown>) -> Result<Self> {
        let output_path = path_arg(output_path, "outputPath")?;
        let load_options = load_options_arg(options)?;
        Ok(Assembly {
            inner: Some(
                assembler::Assembly::with_options(output_path, load_options)
                    .map_err(to_napi_err)?,
            ),
        })
    }

    /// Appends one complete single-shard PDF; returns its page count.
    /// Synchronous: blocks the event loop for the duration of the parse.
    #[napi(catch_unwind, ts_args_type = "shardPath: string")]
    pub fn append_shard(&mut self, shard_path: Unknown) -> Result<u32> {
        let shard_path = path_arg(shard_path, "shardPath")?;
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
    /// `level` may be omitted per entry (defaults to 0).
    #[napi(
        catch_unwind,
        ts_args_type = "outline?: Array<OutlineEntry> | undefined | null"
    )]
    pub fn finalize(&mut self, outline: Option<Unknown>) -> Result<()> {
        let entries = outline_arg(outline)?;
        self.inner
            .take()
            .ok_or_else(consumed)?
            .finalize(entries.as_deref())
            .map_err(to_napi_err)
    }
}
