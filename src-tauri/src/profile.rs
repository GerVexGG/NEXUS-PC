use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

/// General preferences belong to each product. Windows-wide timer and network
/// rollback records have a single owner on disk and retain their existing paths.
pub fn file(name: &str) -> Result<PathBuf, String> {
    let (legacy, current) = match std::env::var_os("APPDATA").filter(|p| !p.is_empty()) {
        Some(base) => (
            PathBuf::from(&base).join("nexus"),
            PathBuf::from(base).join("AURORA"),
        ),
        None => (PathBuf::from("nexus-data"), PathBuf::from("aurora-data")),
    };
    import_once(&legacy, &current, name)
        .map_err(|err| format!("Не удалось открыть профиль AURORA ({name}): {err}"))
}

fn import_once(legacy: &Path, current: &Path, name: &str) -> io::Result<PathBuf> {
    let target = current.join(name);
    if target.try_exists()? {
        return Ok(target);
    }
    let mut source = match fs::File::open(legacy.join(name)) {
        Ok(source) => source,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(target),
        Err(err) => return Err(err),
    };
    fs::create_dir_all(current)?;
    let mut temp = tempfile::NamedTempFile::new_in(current)?;
    io::copy(&mut source, temp.as_file_mut())?;
    temp.as_file().sync_all()?;
    match temp.persist_noclobber(&target) {
        Ok(_) => Ok(target),
        Err(err) if err.error.kind() == ErrorKind::AlreadyExists => Ok(target),
        Err(err) => Err(err.error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_exact_bytes_once_and_preserves_both_profiles() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("nexus");
        let to = dir.path().join("AURORA");
        fs::create_dir(&from).unwrap();
        assert_eq!(
            import_once(&from, &to, "settings.json").unwrap(),
            to.join("settings.json")
        );
        assert!(!to.exists());
        let raw = b"corrupt or unknown format";
        fs::write(from.join("scripts.json"), raw).unwrap();
        let imported = import_once(&from, &to, "scripts.json").unwrap();
        assert_eq!(fs::read(&imported).unwrap(), raw);
        fs::write(&imported, b"new profile").unwrap();
        import_once(&from, &to, "scripts.json").unwrap();
        assert_eq!(fs::read(&imported).unwrap(), b"new profile");
        assert_eq!(fs::read(from.join("scripts.json")).unwrap(), raw);
    }
}
