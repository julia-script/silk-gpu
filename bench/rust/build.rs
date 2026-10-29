use std::{env, path::PathBuf, process::Command};
fn main() {
    println!("cargo:rerun-if-changed=markers.c");
    println!("cargo:rerun-if-env-changed=BENCH_CALLGRIND");
    println!("cargo:rerun-if-env-changed=CC");
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let mut cc = Command::new(env::var("CC").unwrap_or_else(|_| "cc".into()));
    cc.args(["-O3", "-c", "markers.c", "-o"]).arg(out.join("markers.o"));
    if env::var_os("BENCH_CALLGRIND").is_some() { cc.arg("-DBENCH_CALLGRIND"); }
    assert!(cc.status().unwrap().success());
    assert!(Command::new("ar").arg("crs").arg(out.join("libbench_markers.a")).arg(out.join("markers.o")).status().unwrap().success());
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=bench_markers");
}
