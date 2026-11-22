use std::cmp::Ordering;
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Default)]
pub(crate) struct ScannedFolder {
    pub(crate) name: Box<OsStr>,
    pub(crate) bytes: u64,
    pub(crate) file_count: u64,
    pub(crate) folder_count: u64,
    pub(crate) readable: bool,
    pub(crate) folders: Box<[ScannedFolder]>,
    pub(crate) files: Box<[ScannedFile]>,
}

pub(crate) struct ScannedFile {
    pub(crate) name: Box<OsStr>,
    pub(crate) bytes: u64,
}

pub(crate) struct StorageIndex {
    pub(crate) path: PathBuf,
    pub(crate) root: ScannedFolder,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SortBy {
    Name,
    Size,
    Files,
    Folders,
}

#[derive(Serialize)]
pub(crate) struct DirectoryEntry {
    id: String,
    path: String,
    name: String,
    size_bytes: u64,
    parent_bytes: u64,
    file_count: u64,
    folder_count: u64,
    is_directory: bool,
    has_entries: bool,
    readable: bool,
}

#[derive(Serialize)]
pub(crate) struct DirectoryPage {
    path: String,
    name: String,
    breadcrumbs: Vec<(String, String)>,
    entries: Vec<DirectoryEntry>,
    next_offset: Option<usize>,
    total: usize,
    readable: bool,
}

enum EntryRef<'a> {
    Folder(usize, &'a ScannedFolder),
    File(usize, &'a ScannedFile),
}

impl EntryRef<'_> {
    fn name(&self) -> &std::ffi::OsStr {
        match self {
            Self::Folder(_, entry) => &entry.name,
            Self::File(_, entry) => &entry.name,
        }
    }
    fn value(&self, by: SortBy) -> u64 {
        match (self, by) {
            (Self::Folder(_, x), SortBy::Size) => x.bytes,
            (Self::File(_, x), SortBy::Size) => x.bytes,
            (Self::Folder(_, x), SortBy::Files) => x.file_count,
            (Self::Folder(_, x), SortBy::Folders) => x.folder_count,
            _ => 0,
        }
    }
}

fn child_id(id: &str, index: usize) -> String {
    if id.is_empty() {
        index.to_string()
    } else {
        format!("{id}.{index}")
    }
}

impl StorageIndex {
    pub(crate) fn locate_file(&self, path: &Path) -> Option<(String, String)> {
        let relative = path.strip_prefix(&self.path).ok()?;
        let mut components = relative.components();
        let Component::Normal(name) = components.next_back()? else {
            return None;
        };
        let mut folder = &self.root;
        let mut id = String::new();
        for component in components {
            let Component::Normal(name) = component else {
                return None;
            };
            let (index, subfolder) = folder
                .folders
                .iter()
                .enumerate()
                .find(|(_, sub)| sub.name.as_ref() == name)?;
            id = child_id(&id, index);
            folder = subfolder;
        }
        let index = folder
            .files
            .iter()
            .position(|file| file.name.as_ref() == name)?;
        let file_id = format!("{id}/f{index}");
        Some((id, file_id))
    }

    pub(crate) fn page(
        &self,
        id: &str,
        offset: usize,
        by: SortBy,
        descending: bool,
    ) -> Result<DirectoryPage, String> {
        if id.len() > 32768 {
            return Err("Слишком длинный идентификатор каталога".into());
        }
        let mut folder = &self.root;
        let mut path = self.path.clone();
        let mut current_id = String::new();
        let root_label = path.to_string_lossy().into_owned();
        let mut breadcrumbs = vec![(String::new(), root_label.clone())];
        if !id.is_empty() {
            for segment in id.split('.') {
                let index = segment
                    .parse::<usize>()
                    .map_err(|_| "Неверный идентификатор каталога")?;
                folder = folder
                    .folders
                    .get(index)
                    .ok_or("Каталог отсутствует в снимке")?;
                path.push(folder.name.as_ref());
                current_id = child_id(&current_id, index);
                breadcrumbs.push((
                    current_id.clone(),
                    folder.name.to_string_lossy().into_owned(),
                ));
            }
        }
        let mut children: Vec<_> = folder
            .folders
            .iter()
            .enumerate()
            .map(|(i, row)| EntryRef::Folder(i, row))
            .chain(
                folder
                    .files
                    .iter()
                    .enumerate()
                    .map(|(i, row)| EntryRef::File(i, row)),
            )
            .collect();
        children.sort_unstable_by(|a, b| {
            let cmp = match by {
                SortBy::Name => a.name().cmp(b.name()),
                _ => a.value(by).cmp(&b.value(by)),
            };
            let order = if descending { cmp.reverse() } else { cmp };
            order
                .then_with(|| a.name().cmp(b.name()))
                .then_with(|| match (a, b) {
                    (EntryRef::Folder(_, _), EntryRef::File(_, _)) => Ordering::Less,
                    (EntryRef::File(_, _), EntryRef::Folder(_, _)) => Ordering::Greater,
                    _ => Ordering::Equal,
                })
        });
        let total = children.len();
        let entries: Vec<_> =
            children
                .into_iter()
                .skip(offset)
                .take(160)
                .map(|entry| {
                    let entry_path = path.join(entry.name()).to_string_lossy().into_owned();
                    let name = entry.name().to_string_lossy().into_owned();
                    let (
                        id,
                        size_bytes,
                        file_count,
                        folder_count,
                        is_directory,
                        has_entries,
                        readable,
                    ) = match entry {
                        EntryRef::Folder(i, directory) => (
                            child_id(id, i),
                            directory.bytes,
                            directory.file_count,
                            directory.folder_count,
                            true,
                            !directory.files.is_empty() || !directory.folders.is_empty(),
                            directory.readable,
                        ),
                        EntryRef::File(i, file) => {
                            (format!("{id}/f{i}"), file.bytes, 0, 0, false, false, true)
                        }
                    };
                    DirectoryEntry {
                        id,
                        path: entry_path,
                        name,
                        size_bytes,
                        parent_bytes: folder.bytes,
                        file_count,
                        folder_count,
                        is_directory,
                        has_entries,
                        readable,
                    }
                })
                .collect();
        let loaded = offset.saturating_add(entries.len());
        Ok(DirectoryPage {
            path: path.to_string_lossy().into_owned(),
            name: breadcrumbs
                .last()
                .map(|(_, label)| label.clone())
                .unwrap_or(root_label),
            breadcrumbs,
            entries,
            next_offset: (loaded < total).then_some(loaded),
            total,
            readable: folder.readable,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: impl AsRef<OsStr>, bytes: u64) -> ScannedFile {
        ScannedFile {
            name: Box::from(name.as_ref()),
            bytes,
        }
    }

    #[test]
    fn pages_sort_the_full_snapshot_with_stable_ids_and_valid_paths() {
        let index = StorageIndex {
            path: PathBuf::from("root"),
            root: ScannedFolder {
                readable: true,
                bytes: 499,
                folders: vec![
                    ScannedFolder {
                        name: Box::from(OsStr::new("a")),
                        readable: true,
                        bytes: 99,
                        file_count: 1,
                        folders: Box::new([ScannedFolder {
                            name: Box::from(OsStr::new("empty")),
                            readable: true,
                            ..Default::default()
                        }]),
                        folder_count: 1,
                        files: Box::new([file("файл.dat", 99)]),
                    },
                    ScannedFolder {
                        name: Box::from(OsStr::new("denied")),
                        ..Default::default()
                    },
                ]
                .into_boxed_slice(),
                files: (0..200).map(|i| file(format!("x{i:03}.bin"), 2)).collect(),
                ..Default::default()
            },
        };
        let first = index.page("", 0, SortBy::Size, true).unwrap();
        assert_eq!(first.total, 202);
        assert_eq!(first.entries[0].name, "a");
        assert_eq!(first.entries[0].parent_bytes, 499);
        assert_eq!(first.entries[0].folder_count, 1);
        assert_eq!(first.next_offset, Some(160));
        let last = index.page("", 160, SortBy::Size, true).unwrap();
        assert_eq!(last.entries.len(), 42);
        assert_eq!(last.next_offset, None);
        assert_ne!(first.entries[159].id, last.entries[0].id);
        assert!(!last.entries.last().unwrap().readable);
        assert!(
            index
                .page("0.0", 0, SortBy::Name, false)
                .unwrap()
                .entries
                .is_empty()
        );
        let folder = index.page("0", 0, SortBy::Size, true).unwrap();
        assert_eq!(folder.entries[0].size_bytes, 99);
        assert_eq!(folder.entries[0].parent_bytes, 99);
        assert_eq!(folder.breadcrumbs[1], ("0".to_owned(), "a".to_owned()));
        let path = Path::new("root").join("a").join("файл.dat");
        assert_eq!(index.locate_file(&path), Some(("0".into(), "0/f0".into())));
        assert!(index.locate_file(Path::new("root/../outside")).is_none());
        assert!(index.page("0.0.0", 0, SortBy::Name, false).is_err());
    }
}
