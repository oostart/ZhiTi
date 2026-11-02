#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod storage;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            storage::storage_state,
            storage::storage_change_dir,
            storage::storage_size,
            storage::storage_open_dir,
            storage::store_get_all,
            storage::store_get,
            storage::store_put,
            storage::store_remove,
            storage::store_clear,
            storage::file_save,
            storage::file_read,
            storage::file_remove,
            storage::write_file_at
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
