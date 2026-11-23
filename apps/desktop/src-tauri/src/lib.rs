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

/// Root of the runtime (bridge, packages, host, templates): $VCH_ROOT, the repository this crate was built in
/// (development), or the runtime shipped with the app (AppImage), unpacked on the first start.
fn repo_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(root) = env::var("VCH_ROOT") {
        return Ok(PathBuf::from(root));
    }
    // an installed app brings its runtime; `tauri dev` has none and runs from the repository
    if let Some(shipped) = shipped_runtime(app)? {
        return Ok(shipped);
    }
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    crate_dir
        .join("../../..")
        .canonicalize()
        .map_err(|e| format!("Repository not found: {e}"))
}

/// The runtime archive of an installed app (scripts/stage-runtime.ts), unpacked once per version into the app's
/// data directory: an AppImage is read-only, and the archive keeps the symlinks of node_modules.
fn shipped_runtime(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let Ok(resources) = app.path().resource_dir() else { return Ok(None) };
    let archive = resources.join("runtime").join("vch-runtime.tar.gz");
    if !archive.is_file() {
        return Ok(None);
    }
    let version = std::fs::read_to_string(resources.join("runtime").join("VERSION")).unwrap_or_default().trim().to_string();
    let base = app.path().app_local_data_dir().map_err(|e| format!("No data directory: {e}"))?.join("runtime");
    let target = base.join(if version.is_empty() { "current".to_string() } else { version.clone() });
    if target.join("VERSION").is_file() {
        return Ok(Some(target));
    }
    let partial = base.join(".unpacking");
    let _ = std::fs::remove_dir_all(&partial);
    std::fs::create_dir_all(&partial).map_err(|e| format!("Cannot create {}: {e}", partial.display()))?;
    let status = clean_command("tar")
        .arg("-xzf")
        .arg(&archive)
        .arg("-C")
        .arg(&partial)
        .status()
        .map_err(|e| format!("Unpacking the runtime failed (tar not found): {e}"))?;
    if !status.success() {
        return Err("Unpacking the runtime failed (tar)".into());
    }
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&partial, &target).map_err(|e| format!("Cannot move the runtime into place: {e}"))?;
    // links to their final place; without them the runtime is unusable and is unpacked again next time
    if let Err(error) = link_workspace(&target) {
        let _ = std::fs::remove_dir_all(&target);
        return Err(error);
    }
    // older versions are no longer used
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.flatten() {
            if entry.path() != target {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(Some(target))
}

/// The workspace packages in node_modules (LINKS of the runtime, "link target" per line): symlinks on Linux and
/// macOS, directory junctions on Windows, where plain users may not create symlinks.
fn link_workspace(root: &Path) -> Result<(), String> {
    let Ok(list) = std::fs::read_to_string(root.join("LINKS")) else { return Ok(()) };
    for line in list.lines() {
        let mut parts = line.split_whitespace();
        let (Some(link), Some(target)) = (parts.next(), parts.next()) else { continue };
        let link = root.join(link);
        let target = root.join(target);
        if let Some(parent) = link.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).map_err(|e| format!("Cannot link {}: {e}", link.display()))?;
        #[cfg(windows)]
        {
            let status = Command::new("cmd")
                .arg("/C")
                .arg("mklink")
                .arg("/J")
                .arg(&link)
                .arg(&target)
                .stdout(Stdio::null())
                .status()
                .map_err(|e| format!("Cannot link {}: {e}", link.display()))?;
            if !status.success() {
                return Err(format!("Cannot link {}", link.display()));
            }
        }
    }
    Ok(())
}

/// A command without the environment an AppImage sets up for itself: its bundled libraries must not reach the
/// system's compiler, CMake, Wine or the plugin hosts.
fn clean_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    if env::var_os("APPIMAGE").is_some() {
        for key in ["LD_LIBRARY_PATH", "LD_PRELOAD", "GDK_PIXBUF_MODULE_FILE", "GIO_MODULE_DIR", "GTK_PATH", "PYTHONHOME", "PYTHONPATH", "PERLLIB", "GSETTINGS_SCHEMA_DIR", "QT_PLUGIN_PATH"] {
            command.env_remove(key);
        }
    }
    command
}

/// Node.js: $VCH_NODE, PATH, then common install locations (desktop launchers often have a short PATH).
fn find_node(root: &Path) -> Option<PathBuf> {
    if let Ok(node) = env::var("VCH_NODE") {
        return Some(PathBuf::from(node));
    }
    // the Node shipped with the runtime
    let shipped = root.join("node").join("bin").join(if cfg!(windows) { "node.exe" } else { "node" });
    if shipped.is_file() {
        return Some(shipped);
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
    let root = repo_root(app)?;
    let node = find_node(&root).ok_or("Node.js not found (set VCH_NODE)")?;
    let script = root.join("bridge").join("bin").join("bridge.ts");
    if !script.is_file() {
        return Err(format!("Bridge not found: {}", script.display()));
    }

    let mut command = clean_command(&node);
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
        .map_err(|e| format!("Bridge could not be started: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let stdin = child.stdin.take().ok_or("no stdin")?;

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
    let stdin = guard.as_mut().ok_or("Bridge is not running")?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("Sending to the bridge failed: {e}"))
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
