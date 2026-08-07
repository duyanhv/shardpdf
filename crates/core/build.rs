fn main() {
    // Only the napi cdylib needs the Node linker setup; pure-Rust builds
    // (fuzzing, downstream Rust users) must stay free of Node link flags.
    if std::env::var_os("CARGO_FEATURE_NODE").is_some() {
        napi_build::setup();
    }
}
