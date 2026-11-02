use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const STORES: [&str; 5] = ["papers", "questions", "knowledge", "settings", "files"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageState {
    pub data_dir: String,
    pub default_dir: String,
    pub configured: bool,
    pub exists: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRecord {
    pub paper_id: i64,
    pub name: String,
    pub data: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct StorageConfig {
    data_dir: String,
}

fn error(message: impl std::fmt::Display) -> String {
    message.to_string()
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(error)?;
    fs::create_dir_all(&dir).map_err(error)?;
    Ok(dir.join("storage.json"))
}

fn default_data_dir(app: &AppHandle) -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            return parent.join("StudySI数据");
        }
    }
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("StudySI数据"))
        .unwrap_or_else(|_| PathBuf::from("StudySI数据"))
}

fn configured_dir(app: &AppHandle) -> Option<PathBuf> {
    let path = config_path(app).ok()?;
    let text = fs::read_to_string(path).ok()?;
    let config: StorageConfig = serde_json::from_str(&text).ok()?;
    if config.data_dir.trim().is_empty() {
        return None;
    }
    Some(PathBuf::from(config.data_dir))
}

fn resolve_dir(app: &AppHandle) -> PathBuf {
    configured_dir(app).unwrap_or_else(|| default_data_dir(app))
}

fn ensure_layout(dir: &Path) -> Result<(), String> {
    for store in STORES {
        fs::create_dir_all(dir.join(store)).map_err(|e| format!("创建数据目录失败：{e}"))?;
    }
    Ok(())
}

fn write_config(app: &AppHandle, dir: &Path) -> Result<(), String> {
    let config = StorageConfig {
        data_dir: dir.to_string_lossy().to_string(),
    };
    let text = serde_json::to_string_pretty(&config).map_err(error)?;
    let path = config_path(app)?;
    write_text_atomic(&path, &text)
}

fn write_text_atomic(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("写入文件失败：{e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("替换文件失败：{e}"))
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(error)?;
    write_text_atomic(path, &text)
}

fn validate_store(store: &str) -> Result<(), String> {
    if STORES.contains(&store) {
        Ok(())
    } else {
        Err(format!("未知的数据表：{store}"))
    }
}

fn store_dir(app: &AppHandle, store: &str) -> Result<PathBuf, String> {
    validate_store(store)?;
    let dir = resolve_dir(app).join(store);
    fs::create_dir_all(&dir).map_err(|e| format!("创建数据表目录失败：{e}"))?;
    Ok(dir)
}

fn key_text(key: &Value) -> Result<String, String> {
    match key {
        Value::String(value) => Ok(value.clone()),
        Value::Number(value) => Ok(value.to_string()),
        _ => Err("非法的记录标识".to_string()),
    }
}

fn json_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
                .collect()
        })
        .unwrap_or_default();
    files.sort_by_key(|path| {
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .and_then(|stem| stem.parse::<i64>().ok())
            .unwrap_or(i64::MAX)
    });
    files
}

fn next_id(dir: &Path) -> i64 {
    json_files(dir)
        .iter()
        .filter_map(|path| path.file_stem()?.to_str()?.parse::<i64>().ok())
        .max()
        .unwrap_or(0)
        + 1
}

fn has_data(dir: &Path) -> bool {
    ["papers", "questions", "knowledge"].iter().any(|store| {
        let path = dir.join(store);
        fs::read_dir(path)
            .map(|entries| entries.filter_map(|e| e.ok()).any(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json")))
            .unwrap_or(false)
    })
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(error)?;
    let entries = fs::read_dir(src).map_err(error)?;
    for entry in entries {
        let entry = entry.map_err(error)?;
        let path = entry.path();
        let target = dst.join(entry.file_name());
        if entry.file_type().map_err(error)?.is_dir() {
            copy_dir_all(&path, &target)?;
        } else {
            fs::copy(&path, &target).map_err(error)?;
        }
    }
    Ok(())
}

fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0;
    for entry in entries.filter_map(|entry| entry.ok()) {
        let path = entry.path();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            total += dir_size(&path);
        } else {
            total += entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        }
    }
    total
}

fn state_of(app: &AppHandle) -> StorageState {
    let default_dir = default_data_dir(app);
    let configured = configured_dir(app);
    let data_dir = configured.clone().unwrap_or_else(|| default_dir.clone());
    StorageState {
        data_dir: data_dir.to_string_lossy().to_string(),
        default_dir: default_dir.to_string_lossy().to_string(),
        configured: configured.is_some(),
        exists: data_dir.exists(),
    }
}

#[tauri::command]
pub fn storage_state(app: AppHandle) -> StorageState {
    state_of(&app)
}

#[tauri::command]
pub fn storage_change_dir(app: AppHandle, new_dir: String) -> Result<StorageState, String> {
    let target = PathBuf::from(new_dir.trim());
    if target.as_os_str().is_empty() {
        return Err("请选择有效的存储目录".to_string());
    }

    let current = configured_dir(&app);
    if current.as_ref() != Some(&target) {
        if !has_data(&target) {
            if let Some(source) = current.as_ref().filter(|dir| dir.exists()) {
                let source_canon = source.canonicalize().unwrap_or_else(|_| source.clone());
                let target_canon = target.canonicalize().unwrap_or_else(|_| target.clone());
                if target_canon.starts_with(&source_canon) || source_canon.starts_with(&target_canon) {
                    return Err("新目录不能与当前数据目录互相包含".to_string());
                }
                copy_dir_all(source, &target)?;
            }
        }
        ensure_layout(&target)?;
        write_config(&app, &target)?;
    } else {
        ensure_layout(&target)?;
    }

    Ok(state_of(&app))
}

#[tauri::command]
pub fn storage_size(app: AppHandle) -> u64 {
    dir_size(&resolve_dir(&app))
}

#[tauri::command]
pub fn storage_open_dir(app: AppHandle) -> Result<(), String> {
    let dir = resolve_dir(&app);
    ensure_layout(&dir)?;

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("打开目录失败：{e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("打开目录失败：{e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("打开目录失败：{e}"))?;
    }

    Ok(())
}

#[tauri::command]
pub fn store_get_all(app: AppHandle, store: String) -> Result<Vec<Value>, String> {
    let dir = store_dir(&app, &store)?;
    let mut rows = Vec::new();
    for path in json_files(&dir) {
        let text = fs::read_to_string(&path).map_err(error)?;
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            rows.push(value);
        }
    }
    Ok(rows)
}

#[tauri::command]
pub fn store_get(app: AppHandle, store: String, key: Value) -> Result<Option<Value>, String> {
    let dir = store_dir(&app, &store)?;
    let path = dir.join(format!("{}.json", key_text(&key)?));
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(error)?;
    Ok(serde_json::from_str(&text).ok())
}

#[tauri::command]
pub fn store_put(app: AppHandle, store: String, value: Value) -> Result<i64, String> {
    let dir = store_dir(&app, &store)?;
    let mut row = value;
    let Some(object) = row.as_object_mut() else {
        return Err("数据格式不正确".to_string());
    };

    if store == "settings" {
        let key = object
            .get("key")
            .and_then(|value| value.as_str())
            .ok_or_else(|| "设置缺少 key".to_string())?
            .to_string();
        write_json_atomic(&dir.join(format!("{key}.json")), &row)?;
        return Ok(0);
    }

    let mut id = object.get("id").and_then(|value| value.as_i64()).unwrap_or(0);
    if id <= 0 {
        id = next_id(&dir);
    }
    object.insert("id".to_string(), json!(id));
    write_json_atomic(&dir.join(format!("{id}.json")), &row)?;
    Ok(id)
}

#[tauri::command]
pub fn store_remove(app: AppHandle, store: String, key: Value) -> Result<(), String> {
    let dir = store_dir(&app, &store)?;
    let path = dir.join(format!("{}.json", key_text(&key)?));
    if path.exists() {
        fs::remove_file(path).map_err(error)?;
    }
    Ok(())
}

#[tauri::command]
pub fn store_clear(app: AppHandle, store: String) -> Result<(), String> {
    let dir = store_dir(&app, &store)?;
    for path in json_files(&dir) {
        fs::remove_file(path).map_err(error)?;
    }
    if store == "files" {
        for entry in fs::read_dir(&dir).map_err(error)?.filter_map(|entry| entry.ok()) {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) == Some("pdf") {
                fs::remove_file(path).map_err(error)?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn file_save(app: AppHandle, paper_id: i64, name: String, data_base64: String) -> Result<(), String> {
    let dir = store_dir(&app, "files")?;
    let bytes = STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("PDF 数据解码失败：{e}"))?;
    let pdf_path = dir.join(format!("{paper_id}.pdf"));
    let tmp = dir.join(format!("{paper_id}.pdf.tmp"));
    fs::write(&tmp, &bytes).map_err(error)?;
    fs::rename(&tmp, &pdf_path).map_err(error)?;
    write_json_atomic(
        &dir.join(format!("{paper_id}.json")),
        &json!({ "paper_id": paper_id, "name": name }),
    )
}

#[tauri::command]
pub fn file_read(app: AppHandle, paper_id: i64) -> Result<Option<FileRecord>, String> {
    let dir = store_dir(&app, "files")?;
    let pdf_path = dir.join(format!("{paper_id}.pdf"));
    if !pdf_path.exists() {
        return Ok(None);
    }
    let metadata_path = dir.join(format!("{paper_id}.json"));
    let name = fs::read_to_string(&metadata_path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.get("name").and_then(|name| name.as_str()).map(str::to_string))
        .unwrap_or_else(|| format!("试卷{paper_id}.pdf"));
    let bytes = fs::read(&pdf_path).map_err(error)?;
    Ok(Some(FileRecord {
        paper_id,
        name,
        data: STANDARD.encode(bytes),
    }))
}

#[tauri::command]
pub fn file_remove(app: AppHandle, paper_id: i64) -> Result<(), String> {
    let dir = store_dir(&app, "files")?;
    for path in [
        dir.join(format!("{paper_id}.pdf")),
        dir.join(format!("{paper_id}.json")),
    ] {
        if path.exists() {
            fs::remove_file(path).map_err(error)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn write_file_at(path: String, data_base64: String) -> Result<(), String> {
    let target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err("未选择保存路径".to_string());
    }
    let bytes = STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| format!("文件数据解码失败：{e}"))?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(error)?;
    }
    fs::write(&target, bytes).map_err(|e| format!("写入文件失败：{e}"))
}
