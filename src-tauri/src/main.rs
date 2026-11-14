// CoilEdit native side: file I/O with encoding detection, a stat call used for change
// polling, small JSON config files, and folder reads for the Recoil docs / handler
// call-in importers. Everything else (menus, dialogs, window state, single instance)
// comes from Tauri and its official plugins.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{Emitter, Manager};

const MAX_FILE: u64 = 64 * 1024 * 1024;

/// Files passed on the command line (or via macOS "open with") before the UI asked for them.
struct Pending(Mutex<Vec<String>>);

#[derive(Serialize)]
struct TextFile {
    path: String,
    text: String,
}

fn files_from_args<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(&a);
            if p.is_absolute() { p } else { cwd.join(p) }
        })
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

fn err_json(e: std::io::Error) -> Value {
    let code = match e.kind() {
        ErrorKind::NotFound => "ENOENT",
        ErrorKind::PermissionDenied => "EACCES",
        _ => "EIO",
    };
    json!({ "error": e.to_string(), "code": code })
}

fn decode(buf: &[u8]) -> Value {
    if buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return json!({ "enc": "utf8bom", "text": String::from_utf8_lossy(&buf[3..]) });
    }
    if buf.starts_with(&[0xFF, 0xFE]) {
        let (text, _) = encoding_rs::UTF_16LE.decode_without_bom_handling(&buf[2..]);
        return json!({ "enc": "utf16le", "text": text });
    }
    if buf[..buf.len().min(8000)].contains(&0) {
        return json!({ "binary": true });
    }
    match std::str::from_utf8(buf) {
        Ok(text) => json!({ "enc": "utf8", "text": text }),
        Err(_) => {
            let (text, _) = encoding_rs::WINDOWS_1252.decode_without_bom_handling(buf);
            json!({ "enc": "latin1", "text": text })
        }
    }
}

#[tauri::command]
fn read_text(path: String) -> Value {
    let meta = match fs::metadata(&path) {
        Ok(m) => m,
        Err(e) => return err_json(e),
    };
    if !meta.is_file() {
        return json!({ "error": "Not a file" });
    }
    if meta.len() > MAX_FILE {
        return json!({ "error": "File is larger than 64 MB." });
    }
    match fs::read(&path) {
        Ok(buf) => decode(&buf),
        Err(e) => err_json(e),
    }
}

#[tauri::command]
fn write_text(path: String, text: String, enc: String) -> Result<(), String> {
    let bytes: Vec<u8> = match enc.as_str() {
        "utf8bom" => {
            let mut v = vec![0xEF, 0xBB, 0xBF];
            v.extend_from_slice(text.as_bytes());
            v
        }
        "utf16le" => {
            let mut v = vec![0xFF, 0xFE];
            for unit in text.encode_utf16() {
                v.extend_from_slice(&unit.to_le_bytes());
            }
            v
        }
        "latin1" => {
            let (bytes, _, _) = encoding_rs::WINDOWS_1252.encode(&text);
            bytes.into_owned()
        }
        _ => text.into_bytes(),
    };
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

/// [mtime in ms, size] per path, or null if it can't be read. Polled to detect outside edits.
#[tauri::command]
fn stat_files(paths: Vec<String>) -> Vec<Option<(f64, u64)>> {
    paths
        .iter()
        .map(|p| {
            fs::metadata(p).ok().map(|m| {
                let t = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs_f64() * 1000.0)
                    .unwrap_or(0.0);
                (t, m.len())
            })
        })
        .collect()
}

/// Debug builds only: COILEDIT_CONFIG_DIR points the app at a throwaway config folder.
fn test_config_dir() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        std::env::var_os("COILEDIT_CONFIG_DIR").map(PathBuf::from)
    } else {
        None
    }
}

fn config_file(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains(['/', '\\']) || name.contains("..") {
        return Err("invalid config name".into());
    }
    let dir = match test_config_dir() {
        Some(d) => d,
        None => app.path().app_config_dir().map_err(|e| e.to_string())?,
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(name))
}

#[tauri::command]
fn load_json(app: tauri::AppHandle, name: String) -> Result<Option<Value>, String> {
    let file = config_file(&app, &name)?;
    Ok(fs::read_to_string(file).ok().and_then(|s| serde_json::from_str(&s).ok()))
}

#[tauri::command]
fn save_json(app: tauri::AppHandle, name: String, data: Value) -> Result<(), String> {
    let file = config_file(&app, &name)?;
    let tmp = file.with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec(&data).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_json(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let file = config_file(&app, &name)?;
    match fs::remove_file(file) {
        Err(e) if e.kind() != ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[tauri::command]
fn initial_paths(state: tauri::State<Pending>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

fn rel(base: &Path, p: &Path) -> String {
    p.strip_prefix(base).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

fn walk_lua(base: &Path, dir: &Path, out: &mut Vec<TextFile>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for ent in entries.flatten() {
        let p = ent.path();
        let name = ent.file_name().to_string_lossy().into_owned();
        if p.is_dir() {
            if !name.starts_with('.') {
                walk_lua(base, &p, out);
            }
        } else if name.ends_with(".lua") {
            if let Ok(buf) = fs::read(&p) {
                out.push(TextFile { path: rel(base, &p), text: String::from_utf8_lossy(&buf).into_owned() });
            }
        }
    }
}

/// All .lua files of a recoil-lua-library checkout (its library/ folder if present).
#[tauri::command]
fn read_lua_tree(dir: String) -> Result<Vec<TextFile>, String> {
    let d = PathBuf::from(&dir);
    let lib = if d.join("library").is_dir() { d.join("library") } else { d };
    let mut out = Vec::new();
    walk_lua(&lib, &lib, &mut out);
    if out.is_empty() {
        return Err("No .lua files found in that folder.".into());
    }
    Ok(out)
}

/// Top-level .lua files in a game folder and its luaui/ and luarules/ that look like
/// widget/gadget handlers (they declare a callInLists table).
#[tauri::command]
fn read_handler_files(dir: String) -> Vec<TextFile> {
    let base = PathBuf::from(&dir);
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for sub in ["", "luaui", "LuaUI", "luarules", "LuaRules"] {
        let d = if sub.is_empty() { base.clone() } else { base.join(sub) };
        let Ok(entries) = fs::read_dir(&d) else { continue };
        for ent in entries.flatten() {
            let p = ent.path();
            if !p.is_file() || !p.to_string_lossy().to_lowercase().ends_with(".lua") {
                continue;
            }
            let key = fs::canonicalize(&p).unwrap_or(p.clone()).to_string_lossy().to_lowercase();
            if !seen.insert(key) {
                continue;
            }
            let Ok(buf) = fs::read(&p) else { continue };
            let text = String::from_utf8_lossy(&buf).into_owned();
            let lower = text.to_lowercase();
            if lower.contains("callinlists") || lower.contains("callinslist") {
                out.push(TextFile { path: rel(&base, &p), text });
            }
        }
    }
    out
}

/// Carry tabs and settings over from the Electron builds ("CoilEdit" / "Slate").
fn migrate_from_electron(app: &tauri::AppHandle) {
    let (Ok(dst), Ok(base)) = (app.path().app_config_dir(), app.path().config_dir()) else { return };
    if dst.join("session.json").exists() {
        return;
    }
    for old in ["CoilEdit", "Slate"] {
        let src = base.join(old);
        if src.join("session.json").exists() {
            let _ = fs::create_dir_all(&dst);
            for f in ["session.json", "recoil-api.json", "handler-callins.json"] {
                if src.join(f).exists() {
                    let _ = fs::copy(src.join(f), dst.join(f));
                }
            }
            break;
        }
    }
}

fn main() {
    let cwd = std::env::current_dir().unwrap_or_default();
    let initial = files_from_args(std::env::args().skip(1), &cwd);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let files = files_from_args(argv.into_iter().skip(1), Path::new(&cwd));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if !files.is_empty() {
                let _ = app.emit("open-paths", files);
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Pending(Mutex::new(initial)))
        .setup(|app| {
            if test_config_dir().is_none() {
                migrate_from_electron(app.handle());
            }
            // Debug builds only: run a test script in the page (used for automated screenshots).
            #[cfg(debug_assertions)]
            if let Ok(script) = std::env::var("COILEDIT_SMOKE_JS") {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    if let (Some(w), Ok(js)) = (handle.get_webview_window("main"), fs::read_to_string(script)) {
                        let _ = w.eval(&js);
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_text,
            write_text,
            stat_files,
            load_json,
            save_json,
            delete_json,
            initial_paths,
            read_lua_tree,
            read_handler_files
        ])
        .build(tauri::generate_context!())
        .expect("error while starting CoilEdit");

    app.run(|_app, _event| {
        // macOS delivers "Open With" files as an event instead of argv.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            let files: Vec<String> = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            if let Some(state) = _app.try_state::<Pending>() {
                state.0.lock().unwrap().extend(files.iter().cloned());
            }
            let _ = _app.emit("open-paths", files);
        }
    });
}
