use std::path::PathBuf;

fn main() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vendor/rubberband");
    let single = root.join("single/RubberBandSingle.cpp");
    println!("cargo:rerun-if-changed={}", single.display());

    let target = std::env::var("TARGET").unwrap();
    let mut build = cc::Build::new();
    build
        .cpp(true)
        .file(&single)
        .include(root.join("rubberband"))
        .flag_if_supported("-std=c++14")
        .flag_if_supported("-Wno-unused-parameter")
        .flag_if_supported("-Wno-unused-but-set-variable")
        .warnings(false)
        .opt_level(2);

    let wasi_sdk = std::env::var("WASI_SDK_PATH").ok().map(PathBuf::from);
    if target.contains("wasm32") {
        // wasi-sdk's libc++ is built without exceptions or threads.
        let sysroot = wasi_sdk.as_ref().expect("WASI_SDK_PATH not set").join("share/wasi-sysroot");
        build
            .cpp_link_stdlib(None)
            .flag(format!("--sysroot={}", sysroot.display()))
            .flag("-fno-exceptions")
            .define("NO_EXCEPTIONS", None)
            .define("_WASI_EMULATED_MMAN", None);
    }

    build.compile("rubberband");

    if target.contains("wasm32") {
        // Link only the C++ runtime from wasi-sdk; libc must come from Rust's own
        // self-contained wasi-libc, so copy the archives rather than adding the
        // whole sysroot to the search path.
        let lib = wasi_sdk.unwrap().join("share/wasi-sysroot/lib").join(&target);
        let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
        for (dir, name) in [("noeh", "c++"), ("noeh", "c++abi"), ("", "wasi-emulated-mman")] {
            let file = format!("lib{name}.a");
            std::fs::copy(lib.join(dir).join(&file), out.join(&file)).unwrap();
            println!("cargo:rustc-link-lib=static={name}");
        }
        println!("cargo:rustc-link-search=native={}", out.display());
    }

    if target.contains("apple") {
        println!("cargo:rustc-link-lib=framework=Accelerate");
    }
}
