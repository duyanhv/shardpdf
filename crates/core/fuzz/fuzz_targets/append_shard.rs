//! Fuzz the parser boundary named as risk #1 in the design spec: arbitrary
//! bytes into shard parsing + append + finalize must never panic or abort —
//! only Ok or a typed error. Run with:
//!   cargo +nightly fuzz run append_shard -- -max_total_time=300

#![no_main]

use libfuzzer_sys::fuzz_target;
use shardpdf_core::assembler::Assembly;

fuzz_target!(|data: &[u8]| {
    let Ok(doc) = lopdf::Document::load_mem(data) else {
        return;
    };
    let out = std::env::temp_dir().join(format!(
        "shardpdf-fuzz-{}-{}.pdf",
        std::process::id(),
        data.len()
    ));
    if let Ok(mut assembly) = Assembly::new(&out) {
        if assembly.append_shard_doc(doc).is_ok() {
            let _ = assembly.finalize(None);
        }
    }
    let _ = std::fs::remove_file(&out);
});
