fn main() {
    // generate_context! embeds icons; cargo ignores them unless we watch here.
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=macos/Assets.car");
    // GNU ld exports every symbol from the Tauri cdylib and blows past the
    // 65535 PE ordinal limit. Hide them; the desktop exe links the rlib.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu")
    {
        println!("cargo::rustc-link-arg-cdylib=-Wl,--exclude-libs=ALL,--exclude-all-symbols");
    }
    let attributes = tauri_build::Attributes::new();
    #[cfg(windows)]
    let attributes = {
        add_windows_manifest();
        attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
    };
    tauri_build::try_build(attributes).unwrap();
}

#[cfg(windows)]
fn add_windows_manifest() {
    let manifest = std::env::current_dir()
        .unwrap()
        .join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    println!("cargo:rustc-link-arg=/WX");
}
