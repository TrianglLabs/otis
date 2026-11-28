//! A release build carries the Otis runtime inside it: `OTIS_RUNTIME_PAYLOAD` names the compiled
//! runtime (scripts/build.ts sets it), which the binary embeds and unpacks on first run, so a
//! release still ships one `otis` file. Without it, the binary runs the TypeScript source.

use std::hash::Hasher;

fn main() {
    println!("cargo::rustc-check-cfg=cfg(embedded_runtime)");
    println!("cargo::rerun-if-env-changed=OTIS_RUNTIME_PAYLOAD");
    let Some(payload) = std::env::var_os("OTIS_RUNTIME_PAYLOAD") else { return };
    println!("cargo::rerun-if-changed={}", payload.to_string_lossy());
    let bytes = std::fs::read(&payload).expect("OTIS_RUNTIME_PAYLOAD names a readable file");
    // Names the unpacked copy, so a new runtime never runs an old one left in the cache.
    let mut hasher = std::hash::DefaultHasher::new();
    hasher.write(&bytes);
    println!("cargo::rustc-cfg=embedded_runtime");
    println!("cargo::rustc-env=OTIS_RUNTIME_PAYLOAD={}", payload.to_string_lossy());
    println!("cargo::rustc-env=OTIS_RUNTIME_DIGEST={:016x}", hasher.finish());
}
