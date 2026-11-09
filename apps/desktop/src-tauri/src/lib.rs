//! Desktop shell: starts the Node bridge (bridge/bin/bridge.ts) and relays JSON lines
//! between the web frontend and the bridge.

use std::env;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

#[derive(Default)]
struct Bridge {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
}

/// Repository root: $VCH_ROOT, otherwise relative to this crate (development layout).
fn repo_root() -> PathBuf {
    if let Ok(root) = env::var("VCH_ROOT") {
        return PathBuf::from(root);
    }
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    crate_dir
        .join("../../..")
        .canonicalize()
        .unwrap_or_else(|_| crate_dir.to_path_buf())
}

/// Node.js: $VCH_NODE, PATH, then common install locations (desktop launchers often have a short PATH).
fn find_node() -> Option<PathBuf> {
    if let Ok(node) = env::var("VCH_NODE") {
        return Some(PathBuf::from(node));
    }
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    if let Some(paths) = env::var_os("PATH") {
        for dir in env::split_paths(&paths) {
            let candidate = dir.join(exe);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let mut fallbacks: Vec<PathBuf> = Vec::new();
    if let Some(home) = env::var_os("HOME") {
        let home = PathBuf::from(home);
        fallbacks.push(home.join(".local/bin/node"));
        fallbacks.push(home.join(".volta/bin/node"));
    }
    fallbacks.push(PathBuf::from("/usr/local/bin/node"));
    fallbacks.push(PathBuf::from("/usr/bin/node"));
    if cfg!(windows) {
        fallbacks.push(PathBuf::from(r"C:\Program Files\nodejs\node.exe"));
    }
    fallbacks.into_iter().find(|p| p.is_file())
}

fn start_bridge(app: &AppHandle, bridge: &Bridge) -> Result<(), String> {
    let node = find_node().ok_or("Node.js wurde nicht gefunden (VCH_NODE setzen)")?;
    let root = repo_root();
    let script = root.join("bridge").join("bin").join("bridge.ts");
    if !script.is_file() {
        return Err(format!("Bridge nicht gefunden: {}", script.display()));
    }

    let mut command = Command::new(&node);
    command
        .arg(&script)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("Bridge konnte nicht gestartet werden: {e}"))?;

    let stdout = child.stdout.take().ok_or("kein stdout")?;
    let stderr = child.stderr.take().ok_or("kein stderr")?;
    let stdin = child.stdin.take().ok_or("kein stdin")?;

    let out_handle = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = out_handle.emit("bridge", line);
        }
        let _ = out_handle.emit("bridge-exit", ());
    });

    let err_handle = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = err_handle.emit("bridge-stderr", line);
        }
    });

    *bridge.stdin.lock().unwrap() = Some(stdin);
    *bridge.child.lock().unwrap() = Some(child);
    Ok(())
}

fn stop_bridge(bridge: &Bridge) {
    bridge.stdin.lock().unwrap().take();
    if let Some(mut child) = bridge.child.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[tauri::command]
fn bridge_send(bridge: State<'_, Bridge>, line: String) -> Result<(), String> {
    let mut guard = bridge.stdin.lock().unwrap();
    let stdin = guard.as_mut().ok_or("Bridge läuft nicht")?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("Senden an die Bridge fehlgeschlagen: {e}"))
}

#[tauri::command]
fn bridge_restart(app: AppHandle, bridge: State<'_, Bridge>) -> Result<(), String> {
    stop_bridge(&bridge);
    start_bridge(&app, &bridge)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Bridge::default())
        .invoke_handler(tauri::generate_handler![bridge_send, bridge_restart])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(error) = start_bridge(&handle, &app.state::<Bridge>()) {
                let _ = handle.emit("bridge-error", error);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop_bridge(&handle.state::<Bridge>());
        }
    });
}
