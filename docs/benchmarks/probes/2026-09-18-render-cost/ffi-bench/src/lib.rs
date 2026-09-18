//! Minimal napi addon to price a `widthOfString`-shaped FFI round trip
//! honestly: string in, f64 out, trivial body. This is the floor cost a
//! Rust text renderer would pay per measurement query, before doing any work.
#[macro_use]
extern crate napi_derive;

/// String in, f64 out. Shaped exactly like `widthOfString(s)`.
#[napi]
pub fn width_of(s: String) -> f64 {
    s.len() as f64 * 0.5
}

/// Same, but taking a napi string ref to avoid the owned-String allocation.
#[napi]
pub fn width_of_ref(s: napi::JsString) -> napi::Result<f64> {
    Ok(s.into_utf8()?.as_str()?.len() as f64 * 0.5)
}

/// Scalar in, scalar out: the absolute floor of a napi call.
#[napi]
pub fn noop(x: f64) -> f64 { x + 1.0 }
