//! napi bindings (feature `node`). All orchestration lives in TypeScript;
//! this file only marshals across the boundary.
//!
//! Every binding body runs under [`guard`], a `catch_unwind` that maps an
//! unwinding panic anywhere in the core to a `SHARDPDF_PANIC` error instead
//! of aborting the host process. napi's own `catch_unwind` attribute is kept
//! as an outer layer (it also covers napi's argument marshalling) but it
//! produces a code-less `GenericFailure`, so the coded mapping lives here.
//! Process-aborting failures (stack overflow, allocator OOM abort,
//! `process::abort`) are outside what `catch_unwind` can intercept.
//!
//! Errors carry a stable `code` property (see [`ErrorCode`]) so callers can
//! branch on the class of failure without matching on message text.
//!
//! Two families of entrypoints are exported:
//!
//! - Synchronous calls (`pageCount`, `extractSelection`, `extractPages`,
//!   `Assembly#appendShard`/`appendShardBytes`/`finalize`) run on the
//!   JavaScript thread. A 500-page shard blocks the event loop for tens of
//!   milliseconds; hosts that already run in a dedicated child process use
//!   these directly.
//! - `*Async` variants (`pageCountAsync`, `extractSelectionAsync`,
//!   `Assembly#appendShardAsync`/`appendShardBytesAsync`/`finalizeAsync`)
//!   return a Promise and run the parse and write on the libuv threadpool
//!   through napi's [`Task`]. Argument validation happens on the JS thread
//!   but every failure, including a caught panic, is delivered as a
//!   rejection carrying the same `SHARDPDF_*` code.
//!
//! Byte inputs to async calls are copied into the task before it is queued,
//! so the worker never reads a JavaScript buffer that the caller may mutate
//! or that the garbage collector may move or release.
//!
//! An `Assembly` owns one output writer. At most one operation may run on it
//! at a time: while an async call is in flight the assembly is "busy", and
//! any other call (sync or async) fails with `SHARDPDF_INVALID_ARG` until
//! the in-flight promise settles.

use crate::assembler::{PdfSource, ShardLoadOptions};
use crate::{assembler, extract, inspect, outline};
use napi::bindgen_prelude::{
    AsyncTask, FromNapiValue, JsObjectValue, JsValue, Object, Uint8Array, Undefined, Unknown,
};
use napi::{Env, JsError, Task, ValueType};
use napi_derive::napi;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

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
    /// The native core panicked (a bug in shardpdf, not in the input). The
    /// panic was caught at the binding boundary; the process is intact but
    /// any in-progress `Assembly` should be aborted.
    Panic,
    /// Two shards contributed the same named destination. A narrower
    /// `Malformed`: reported separately so callers can single out the name
    /// collision without parsing the message.
    DuplicateDestination,
    /// A named destination points at a page absent from the assembled
    /// document. A narrower `Malformed`, reported separately for the same
    /// reason.
    DanglingDestination,
}

impl AsRef<str> for ErrorCode {
    fn as_ref(&self) -> &str {
        match self {
            ErrorCode::PdfParse => "SHARDPDF_PDF_PARSE",
            ErrorCode::Io => "SHARDPDF_IO",
            ErrorCode::Malformed => "SHARDPDF_MALFORMED",
            ErrorCode::Consumed => "SHARDPDF_CONSUMED",
            ErrorCode::InvalidArg => "SHARDPDF_INVALID_ARG",
            ErrorCode::Panic => "SHARDPDF_PANIC",
            ErrorCode::DuplicateDestination => "SHARDPDF_DUPLICATE_DESTINATION",
            ErrorCode::DanglingDestination => "SHARDPDF_DANGLING_DESTINATION",
        }
    }
}

type Result<T> = napi::Result<T, ErrorCode>;

/// A coded result that has crossed back to the JavaScript thread from a
/// worker. `napi::Error` is `Send`, so this can be a `Task::Output`.
type Coded<T> = std::result::Result<T, napi::Error<ErrorCode>>;

/// Runs a binding body, converting an unwinding panic into a coded error.
/// `AssertUnwindSafe` is sound here because every binding either returns a
/// value or leaves state that the caller must discard (`Assembly` is meant
/// to be aborted after any error).
fn guard<T>(body: impl FnOnce() -> Result<T>) -> Result<T> {
    match catch_unwind(AssertUnwindSafe(body)) {
        Ok(result) => result,
        Err(payload) => {
            let message = if let Some(s) = payload.downcast_ref::<String>() {
                s.clone()
            } else if let Some(s) = payload.downcast_ref::<&str>() {
                (*s).to_string()
            } else {
                "panic from Rust code".to_string()
            };
            Err(napi::Error::new(
                ErrorCode::Panic,
                format!("native panic: {message}"),
            ))
        }
    }
}

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
        assembler::AssemblyError::InvalidSelection(_) => ErrorCode::InvalidArg,
        assembler::AssemblyError::InvalidOutline(_) => ErrorCode::InvalidArg,
        assembler::AssemblyError::DuplicateDestination(_) => ErrorCode::DuplicateDestination,
        assembler::AssemblyError::DanglingDestination(_) => ErrorCode::DanglingDestination,
    };
    napi::Error::new(code, e.to_string())
}

fn consumed() -> napi::Error<ErrorCode> {
    napi::Error::new(ErrorCode::Consumed, "assembly already finalized or aborted")
}

fn busy() -> napi::Error<ErrorCode> {
    napi::Error::new(
        ErrorCode::InvalidArg,
        "assembly is busy: an async operation is in flight; await it before calling another method",
    )
}

/// Converts a worker-side coded error into the JS error object the promise
/// will reject with. napi's `Task::Output` path only carries a
/// `napi::Error<Status>`, whose `code` would be `GenericFailure`, so the
/// coded error is materialised as a JS `Error` (with `code` set from
/// [`ErrorCode`]) on the JS thread and handed back by reference; napi then
/// rejects the promise with that exact object.
fn finish<T>(env: Env, output: Coded<T>) -> napi::Result<T> {
    output.map_err(|e| napi::Error::from(JsError::from(e).into_unknown(env)))
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

/// A PDF source: a non-empty path string or a `Uint8Array` (Buffer works
/// through inheritance). Any other shape is `SHARDPDF_INVALID_ARG`.
enum InputArg {
    Path(String),
    Bytes(Uint8Array),
}

impl InputArg {
    fn as_source(&self) -> PdfSource<'_> {
        match self {
            InputArg::Path(p) => PdfSource::Path(std::path::Path::new(p)),
            InputArg::Bytes(b) => PdfSource::Bytes(b.as_ref()),
        }
    }
}

fn input_arg(value: Unknown, name: &str) -> Result<InputArg> {
    match value.get_type() {
        Ok(ValueType::String) => path_arg(value, name).map(InputArg::Path),
        Ok(ValueType::Object) if value.is_typedarray().unwrap_or(false) => {
            Uint8Array::from_unknown(value)
                .map(InputArg::Bytes)
                .map_err(|e| bad_arg(format!("{name} must be a Uint8Array: {}", e.reason)))
        }
        _ => Err(invalid_arg(name, "a path string or a Uint8Array", &value)),
    }
}

/// A PDF source owned by an async task: the path string or a private copy of
/// the caller's bytes. Copying keeps the worker independent of the
/// JavaScript heap for the lifetime of the task.
enum OwnedInput {
    Path(String),
    Bytes(Vec<u8>),
}

impl OwnedInput {
    fn from_arg(arg: InputArg) -> Self {
        match arg {
            InputArg::Path(p) => OwnedInput::Path(p),
            InputArg::Bytes(b) => OwnedInput::Bytes(b.to_vec()),
        }
    }

    fn as_source(&self) -> PdfSource<'_> {
        match self {
            OwnedInput::Path(p) => PdfSource::Path(std::path::Path::new(p)),
            OwnedInput::Bytes(b) => PdfSource::Bytes(b.as_slice()),
        }
    }
}

fn bytes_arg(value: Unknown, name: &str) -> Result<Uint8Array> {
    match value.get_type() {
        Ok(ValueType::Object) if value.is_typedarray().unwrap_or(false) => {
            Uint8Array::from_unknown(value)
                .map_err(|e| bad_arg(format!("{name} must be a Uint8Array: {}", e.reason)))
        }
        _ => Err(invalid_arg(name, "a Uint8Array", &value)),
    }
}

/// Zero-based page indices for `extractSelection`. Shape and per-element
/// checks happen here so misuse reports `SHARDPDF_INVALID_ARG`; emptiness,
/// duplicates, and range are checked by the core against the parsed
/// document and map to the same code.
fn pages_arg(value: Unknown) -> Result<Vec<usize>> {
    if !matches!(value.get_type(), Ok(ValueType::Object)) || !value.is_array().unwrap_or(false) {
        return Err(bad_arg(format!(
            "pages must be an array of page indices, got {}",
            type_name(&value)
        )));
    }
    let array = Object::from_unknown(value).map_err(|e| bad_arg(e.reason))?;
    let len = array
        .get_array_length()
        .map_err(|e| bad_arg(format!("pages: {}", e.reason)))?;
    if len == 0 {
        return Err(bad_arg("pages must contain at least one index".into()));
    }
    let mut pages = Vec::with_capacity(len as usize);
    for index in 0..len {
        let raw: Unknown = array
            .get_element(index)
            .map_err(|e| bad_arg(format!("pages[{index}]: {}", e.reason)))?;
        let n = match raw.get_type() {
            Ok(ValueType::Number) => f64::from_unknown(raw).map_err(|e| bad_arg(e.reason))?,
            _ => {
                return Err(bad_arg(format!(
                    "pages[{index}] must be a non-negative integer, got {}",
                    type_name(&raw)
                )))
            }
        };
        if !n.is_finite() || n.fract() != 0.0 || n < 0.0 || n > u32::MAX as f64 {
            return Err(bad_arg(format!(
                "pages[{index}] must be a non-negative integer, got {n}"
            )));
        }
        pages.push(n as usize);
    }
    Ok(pages)
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
    guard(|| {
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
    })
}

/// Extract zero-based page indices from `input` (a path or PDF bytes) into
/// `outputPath`, in the order given. The source is parsed exactly once.
/// Returns the extracted page count. Same object-copy semantics as
/// `extractPages`: all annotations, named destinations, and outlines are
/// dropped. An empty array, a duplicate, a non-integer, a negative, or an
/// out-of-range index is `SHARDPDF_INVALID_ARG`.
#[napi(
    catch_unwind,
    ts_args_type = "input: string | Uint8Array, pages: Array<number>, outputPath: string, options?: LoadOptions | undefined | null"
)]
pub fn extract_selection(
    input: Unknown,
    pages: Unknown,
    output_path: Unknown,
    options: Option<Unknown>,
) -> Result<u32> {
    guard(|| {
        let input = input_arg(input, "input")?;
        let pages = pages_arg(pages)?;
        let output_path = path_arg(output_path, "outputPath")?;
        let load_options = load_options_arg(options)?;
        extract::extract_selection(
            input.as_source(),
            &pages,
            std::path::Path::new(&output_path),
            &load_options,
        )
        .map_err(to_napi_err)
    })
}

/// Parses a source PDF once and serves any number of page-range extractions
/// from it — the multi-slice selective-download pattern. The source is left
/// intact between calls, so ranges may overlap and repeat.
#[napi]
pub struct Extractor {
    inner: extract::Extractor,
}

#[napi]
impl Extractor {
    #[napi(constructor, ts_args_type = "inputPath: string")]
    pub fn new(input_path: Unknown) -> Result<Self> {
        guard(|| {
            let input_path = path_arg(input_path, "inputPath")?;
            Ok(Extractor {
                inner: extract::Extractor::open(std::path::Path::new(&input_path))
                    .map_err(to_napi_err)?,
            })
        })
    }

    /// Total pages in the parsed source.
    #[napi(getter)]
    pub fn page_count(&self) -> u32 {
        self.inner.page_count()
    }

    /// Extracts one inclusive, 1-based range; returns the slice's page count.
    /// `SHARDPDF_INVALID_ARG` if the range is empty or past the last page.
    #[napi(
        catch_unwind,
        ts_args_type = "startPage: number, endPage: number, outputPath: string"
    )]
    pub fn extract_range(
        &self,
        start_page: u32,
        end_page: u32,
        output_path: Unknown,
    ) -> Result<u32> {
        guard(|| {
            let output_path = path_arg(output_path, "outputPath")?;
            self.inner
                .extract_range(start_page, end_page, std::path::Path::new(&output_path))
                .map_err(to_napi_err)
        })
    }
}

/// The result of [`validate`]: what the document contains once every page
/// and destination has been resolved.
#[napi(object)]
pub struct ValidationReport {
    /// Pages that resolved to a page dictionary.
    pub page_count: u32,
    /// Named destinations that resolved to a live page.
    pub named_destinations: u32,
}

/// Structural validation: parses `inputPath`, resolves every page, and
/// verifies every named destination targets a live page — the corruption
/// `qpdf --check` accepts silently. `SHARDPDF_DANGLING_DESTINATION` if a
/// destination points outside the document.
#[napi(catch_unwind, ts_args_type = "inputPath: string")]
pub fn validate(input_path: Unknown) -> Result<ValidationReport> {
    guard(|| {
        let input_path = path_arg(input_path, "inputPath")?;
        let report =
            inspect::validate(std::path::Path::new(&input_path)).map_err(to_napi_err)?;
        Ok(ValidationReport {
            page_count: report.page_count,
            named_destinations: report.named_destinations,
        })
    })
}

/// Parse `input` (a path or PDF bytes) and return its page count. Nothing
/// is written. Synchronous: the whole document is parsed on the JS thread.
#[napi(
    catch_unwind,
    ts_args_type = "input: string | Uint8Array, options?: LoadOptions | undefined | null"
)]
pub fn page_count(input: Unknown, options: Option<Unknown>) -> Result<u32> {
    guard(|| {
        let input = input_arg(input, "input")?;
        let load_options = load_options_arg(options)?;
        count_pages(input.as_source(), &load_options)
    })
}

fn count_pages(source: PdfSource<'_>, load_options: &ShardLoadOptions) -> Result<u32> {
    let count = assembler::page_count(source, load_options).map_err(to_napi_err)?;
    u32::try_from(count).map_err(|_| {
        napi::Error::new(
            ErrorCode::Malformed,
            format!("page count {count} exceeds u32"),
        )
    })
}

/// Off-thread `pageCount`. Argument problems are captured on the JS thread
/// and delivered as a rejection so the call always returns a Promise.
pub struct PageCountTask {
    job: Option<Coded<(OwnedInput, ShardLoadOptions)>>,
}

#[napi]
impl Task for PageCountTask {
    type Output = Coded<u32>;
    type JsValue = u32;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let job = self.job.take();
        Ok(guard(|| {
            let (input, load_options) = job.expect("compute runs once")?;
            count_pages(input.as_source(), &load_options)
        }))
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        finish(env, output)
    }
}

/// Parse `input` (a path or a `Uint8Array`, which is copied) on the libuv
/// threadpool and resolve with its page count. Rejections carry the same
/// `SHARDPDF_*` codes as `pageCount`, including `SHARDPDF_PANIC`.
#[napi(
    catch_unwind,
    ts_args_type = "input: string | Uint8Array, options?: LoadOptions | undefined | null",
    ts_return_type = "Promise<number>"
)]
pub fn page_count_async(input: Unknown, options: Option<Unknown>) -> AsyncTask<PageCountTask> {
    let job = guard(|| {
        let input = OwnedInput::from_arg(input_arg(input, "input")?);
        let load_options = load_options_arg(options)?;
        Ok((input, load_options))
    });
    AsyncTask::new(PageCountTask { job: Some(job) })
}

/// Off-thread `extractSelection`.
pub struct ExtractSelectionTask {
    job: Option<Coded<ExtractJob>>,
}

struct ExtractJob {
    input: OwnedInput,
    pages: Vec<usize>,
    output_path: String,
    load_options: ShardLoadOptions,
}

#[napi]
impl Task for ExtractSelectionTask {
    type Output = Coded<u32>;
    type JsValue = u32;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let job = self.job.take();
        Ok(guard(|| {
            let ExtractJob {
                input,
                pages,
                output_path,
                load_options,
            } = job.expect("compute runs once")?;
            extract::extract_selection(
                input.as_source(),
                &pages,
                std::path::Path::new(&output_path),
                &load_options,
            )
            .map_err(to_napi_err)
        }))
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        finish(env, output)
    }
}

/// `extractSelection` on the libuv threadpool. Same arguments, semantics,
/// and error codes; byte input is copied before the task is queued. Resolves
/// with the extracted page count.
#[napi(
    catch_unwind,
    ts_args_type = "input: string | Uint8Array, pages: Array<number>, outputPath: string, options?: LoadOptions | undefined | null",
    ts_return_type = "Promise<number>"
)]
pub fn extract_selection_async(
    input: Unknown,
    pages: Unknown,
    output_path: Unknown,
    options: Option<Unknown>,
) -> AsyncTask<ExtractSelectionTask> {
    let job = guard(|| {
        let input = OwnedInput::from_arg(input_arg(input, "input")?);
        let pages = pages_arg(pages)?;
        let output_path = path_arg(output_path, "outputPath")?;
        let load_options = load_options_arg(options)?;
        Ok(ExtractJob {
            input,
            pages,
            output_path,
            load_options,
        })
    });
    AsyncTask::new(ExtractSelectionTask { job: Some(job) })
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

/// Ownership state of an `Assembly`'s writer.
enum Slot {
    /// Idle on the JS thread; sync and async methods may take it.
    Ready(assembler::Assembly),
    /// Moved into an async task; every other call is rejected until the
    /// task's `finally` hands it back (or drops it after `abort()`).
    Busy,
    /// `finalize()`/`abort()` ran (or `abort()` was called while busy).
    Consumed,
}

type SharedSlot = Arc<Mutex<Slot>>;

/// The mutex is only ever locked on the JS thread (worker tasks own the
/// writer outright while they run), so contention is impossible; poisoning
/// after a caught panic is tolerated because the slot's enum state is
/// always coherent.
fn lock_slot(slot: &SharedSlot) -> MutexGuard<'_, Slot> {
    slot.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Moves the writer out for an async task, leaving the slot `Busy`.
fn take_ready(slot: &SharedSlot) -> Result<assembler::Assembly> {
    let mut guard = lock_slot(slot);
    match &*guard {
        Slot::Ready(_) => {}
        Slot::Busy => return Err(busy()),
        Slot::Consumed => return Err(consumed()),
    }
    match std::mem::replace(&mut *guard, Slot::Busy) {
        Slot::Ready(inner) => Ok(inner),
        _ => unreachable!("checked above"),
    }
}

/// Returns a writer borrowed by an async append; drops it if `abort()` ran
/// while the task was in flight.
fn give_back(slot: &SharedSlot, inner: assembler::Assembly) {
    let mut guard = lock_slot(slot);
    if matches!(*guard, Slot::Busy) {
        *guard = Slot::Ready(inner);
    }
}

enum AppendInput {
    Path(String),
    Bytes(Vec<u8>),
}

/// Off-thread `appendShard`/`appendShardBytes`. Owns the writer for the
/// duration of the task and returns it in `finally`, which napi runs on the
/// JS thread after the promise settles, whether or not `compute` ran.
pub struct AppendShardTask {
    slot: SharedSlot,
    job: Option<Coded<AppendInput>>,
    inner: Option<assembler::Assembly>,
}

#[napi]
impl Task for AppendShardTask {
    type Output = Coded<u32>;
    type JsValue = u32;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let job = self.job.take();
        let inner = &mut self.inner;
        Ok(guard(|| {
            let input = job.expect("compute runs once")?;
            let inner = inner.as_mut().ok_or_else(consumed)?;
            match input {
                AppendInput::Path(p) => inner.append_shard_file(std::path::Path::new(&p)),
                AppendInput::Bytes(b) => inner.append_shard_bytes(&b),
            }
            .map_err(to_napi_err)
        }))
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        finish(env, output)
    }

    fn finally(self, _env: Env) -> napi::Result<()> {
        if let Some(inner) = self.inner {
            give_back(&self.slot, inner);
        }
        Ok(())
    }
}

/// Off-thread `finalize`. The writer is consumed whether or not the write
/// succeeds, exactly like the sync method.
pub struct FinalizeTask {
    slot: SharedSlot,
    job: Option<Coded<Option<Vec<outline::OutlineEntry>>>>,
    inner: Option<assembler::Assembly>,
    owns_slot: bool,
}

#[napi]
impl Task for FinalizeTask {
    type Output = Coded<()>;
    type JsValue = Undefined;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let job = self.job.take();
        let inner = self.inner.take();
        Ok(guard(|| {
            let entries = job.expect("compute runs once")?;
            inner
                .ok_or_else(consumed)?
                .finalize(entries.as_deref())
                .map_err(to_napi_err)
        }))
    }

    fn resolve(&mut self, env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        finish(env, output)
    }

    fn finally(self, _env: Env) -> napi::Result<()> {
        if self.owns_slot {
            let mut guard = lock_slot(&self.slot);
            if matches!(*guard, Slot::Busy) {
                *guard = Slot::Consumed;
            }
        }
        Ok(())
    }
}

#[napi]
pub struct Assembly {
    slot: SharedSlot,
}

impl Assembly {
    /// Runs `body` against the idle writer on the JS thread.
    fn with_ready<T>(&self, body: impl FnOnce(&mut assembler::Assembly) -> Result<T>) -> Result<T> {
        let mut guard = lock_slot(&self.slot);
        match &mut *guard {
            Slot::Ready(inner) => body(inner),
            Slot::Busy => Err(busy()),
            Slot::Consumed => Err(consumed()),
        }
    }
}

#[napi]
impl Assembly {
    #[napi(
        constructor,
        catch_unwind,
        ts_args_type = "outputPath: string, options?: LoadOptions | undefined | null"
    )]
    pub fn new(output_path: Unknown, options: Option<Unknown>) -> Result<Self> {
        guard(|| {
            let output_path = path_arg(output_path, "outputPath")?;
            let load_options = load_options_arg(options)?;
            Ok(Assembly {
                slot: Arc::new(Mutex::new(Slot::Ready(
                    assembler::Assembly::with_options(output_path, load_options)
                        .map_err(to_napi_err)?,
                ))),
            })
        })
    }

    /// Appends one complete single-shard PDF; returns its page count.
    /// Synchronous: blocks the event loop for the duration of the parse.
    /// `SHARDPDF_INVALID_ARG` if an async call on this assembly is in flight.
    #[napi(catch_unwind, ts_args_type = "shardPath: string")]
    pub fn append_shard(&self, shard_path: Unknown) -> Result<u32> {
        guard(|| {
            let shard_path = path_arg(shard_path, "shardPath")?;
            self.with_ready(|inner| {
                inner
                    .append_shard_file(std::path::Path::new(&shard_path))
                    .map_err(to_napi_err)
            })
        })
    }

    /// Appends one complete single-shard PDF held in memory; returns its
    /// page count. The buffer is parsed synchronously and not retained.
    /// `SHARDPDF_INVALID_ARG` if an async call on this assembly is in flight.
    #[napi(catch_unwind, ts_args_type = "bytes: Uint8Array")]
    pub fn append_shard_bytes(&self, bytes: Unknown) -> Result<u32> {
        guard(|| {
            let bytes = bytes_arg(bytes, "bytes")?;
            self.with_ready(|inner| {
                inner
                    .append_shard_bytes(bytes.as_ref())
                    .map_err(to_napi_err)
            })
        })
    }

    /// `appendShard` on the libuv threadpool. Resolves with the shard's page
    /// count. The assembly is busy until the promise settles: any other call
    /// in the meantime fails with `SHARDPDF_INVALID_ARG`.
    #[napi(
        catch_unwind,
        ts_args_type = "shardPath: string",
        ts_return_type = "Promise<number>"
    )]
    pub fn append_shard_async(&self, shard_path: Unknown) -> AsyncTask<AppendShardTask> {
        self.spawn_append(guard(|| {
            path_arg(shard_path, "shardPath").map(AppendInput::Path)
        }))
    }

    /// `appendShardBytes` on the libuv threadpool. The bytes are copied
    /// before the task is queued, so the caller may reuse the buffer as soon
    /// as this returns. Same busy rule as `appendShardAsync`.
    #[napi(
        catch_unwind,
        ts_args_type = "bytes: Uint8Array",
        ts_return_type = "Promise<number>"
    )]
    pub fn append_shard_bytes_async(&self, bytes: Unknown) -> AsyncTask<AppendShardTask> {
        self.spawn_append(guard(|| {
            bytes_arg(bytes, "bytes").map(|b| AppendInput::Bytes(b.to_vec()))
        }))
    }

    /// Total pages appended so far. `SHARDPDF_INVALID_ARG` while an async
    /// call is in flight.
    #[napi(getter, catch_unwind)]
    pub fn page_count(&self) -> Result<u32> {
        guard(|| self.with_ready(|inner| Ok(inner.page_count() as u32)))
    }

    /// Whether `finalize()` or `abort()` has already consumed this assembly.
    #[napi(getter)]
    pub fn consumed(&self) -> bool {
        matches!(*lock_slot(&self.slot), Slot::Consumed)
    }

    /// Whether an async call on this assembly is in flight.
    #[napi(getter)]
    pub fn busy(&self) -> bool {
        matches!(*lock_slot(&self.slot), Slot::Busy)
    }

    /// Closes the partial output without finalizing it. Idempotent: calling
    /// it on an already-consumed assembly is a no-op, so `finally` blocks can
    /// call it unconditionally. If an async call is in flight the writer is
    /// closed as soon as that task settles; the task's own promise still
    /// reports its result.
    #[napi(catch_unwind)]
    pub fn abort(&self) {
        *lock_slot(&self.slot) = Slot::Consumed;
    }

    /// Writes the assembled document, with optional bookmarks. Consumed.
    /// `level` may be omitted per entry (defaults to 0).
    /// `SHARDPDF_INVALID_ARG` if an async call on this assembly is in flight.
    #[napi(
        catch_unwind,
        ts_args_type = "outline?: Array<OutlineEntry> | undefined | null"
    )]
    pub fn finalize(&self, outline: Option<Unknown>) -> Result<()> {
        guard(|| {
            let entries = outline_arg(outline)?;
            let inner = take_ready(&self.slot)?;
            *lock_slot(&self.slot) = Slot::Consumed;
            inner.finalize(entries.as_deref()).map_err(to_napi_err)
        })
    }

    /// `finalize` on the libuv threadpool. The assembly is consumed once the
    /// promise settles, whether it resolved or rejected. Same busy rule as
    /// `appendShardAsync`.
    #[napi(
        catch_unwind,
        ts_args_type = "outline?: Array<OutlineEntry> | undefined | null",
        ts_return_type = "Promise<void>"
    )]
    pub fn finalize_async(&self, outline: Option<Unknown>) -> AsyncTask<FinalizeTask> {
        let job = guard(|| outline_arg(outline));
        let (inner, owns_slot, job) = match job {
            Ok(entries) => match take_ready(&self.slot) {
                Ok(inner) => (Some(inner), true, Ok(entries)),
                Err(e) => (None, false, Err(e)),
            },
            Err(e) => (None, false, Err(e)),
        };
        AsyncTask::new(FinalizeTask {
            slot: self.slot.clone(),
            job: Some(job),
            inner,
            owns_slot,
        })
    }
}

impl Assembly {
    fn spawn_append(&self, job: Coded<AppendInput>) -> AsyncTask<AppendShardTask> {
        // Only take the writer once the argument is valid, so a bad argument
        // never leaves the assembly busy.
        let (inner, job) = match job {
            Ok(input) => match take_ready(&self.slot) {
                Ok(inner) => (Some(inner), Ok(input)),
                Err(e) => (None, Err(e)),
            },
            Err(e) => (None, Err(e)),
        };
        AsyncTask::new(AppendShardTask {
            slot: self.slot.clone(),
            job: Some(job),
            inner,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_maps_panics_to_coded_error() {
        let err = guard::<()>(|| panic!("boom {}", 42)).unwrap_err();
        assert_eq!(err.status, ErrorCode::Panic);
        assert_eq!(ErrorCode::Panic.as_ref(), "SHARDPDF_PANIC");
        assert_eq!(err.reason, "native panic: boom 42");

        let err = guard::<()>(|| std::panic::panic_any(7u8)).unwrap_err();
        assert_eq!(err.status, ErrorCode::Panic);
        assert_eq!(err.reason, "native panic: panic from Rust code");
    }

    #[test]
    fn guard_passes_results_through() {
        assert_eq!(guard(|| Ok(3)).unwrap(), 3);
        let err = guard::<()>(|| Err(consumed())).unwrap_err();
        assert_eq!(err.status, ErrorCode::Consumed);
    }

    #[test]
    fn slot_enforces_exclusive_access() {
        let dir = std::env::temp_dir().join(format!("shardpdf-slot-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("out.pdf");
        let slot: SharedSlot = Arc::new(Mutex::new(Slot::Ready(
            assembler::Assembly::new(&out).unwrap(),
        )));

        let inner = take_ready(&slot).unwrap();
        assert!(matches!(*lock_slot(&slot), Slot::Busy));
        assert_eq!(
            take_ready(&slot).err().map(|e| e.status),
            Some(ErrorCode::InvalidArg)
        );

        give_back(&slot, inner);
        assert!(matches!(*lock_slot(&slot), Slot::Ready(_)));

        // abort() while busy wins: the returned writer is dropped.
        let inner = take_ready(&slot).unwrap();
        *lock_slot(&slot) = Slot::Consumed;
        give_back(&slot, inner);
        assert!(matches!(*lock_slot(&slot), Slot::Consumed));
        assert_eq!(
            take_ready(&slot).err().map(|e| e.status),
            Some(ErrorCode::Consumed)
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
