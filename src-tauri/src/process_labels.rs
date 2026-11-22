use serde::Serialize;

#[derive(Default, Serialize)]
pub(crate) struct ProcessLabels {
    pub(crate) owner: Option<String>,
    pub(crate) description: Option<String>,
}

#[cfg(windows)]
pub(crate) mod windows_labels {
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, Prefix};
    use std::sync::{Mutex, OnceLock};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetLengthSid, GetTokenInformation, LookupAccountSidW, SidTypeUnknown, TOKEN_QUERY,
        TOKEN_USER, TokenUser,
    };
    use windows::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
    };
    use windows::Win32::System::Threading::OpenProcessToken;
    use windows::core::{PCWSTR, PWSTR, w};

    use crate::win_process_ffi::{
        FILETIME, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, ScopedHandle,
        filetime_to_unix_secs,
    };

    fn cached<K: Clone + Eq + std::hash::Hash, V: Clone>(
        cache: &Mutex<HashMap<K, V>>,
        key: K,
        limit: usize,
        read: impl FnOnce(&K) -> V,
    ) -> V {
        if let Some(value) = cache.lock().ok().and_then(|cache| cache.get(&key).cloned()) {
            return value;
        }
        let value = read(&key);
        if let Ok(mut cache) = cache.lock() {
            if cache.len() >= limit {
                cache.clear();
            }
            cache.insert(key, value.clone());
        }
        value
    }

    pub(crate) fn owner(pid: u32, start_time: u64) -> Option<String> {
        type AccountCache = Mutex<HashMap<Vec<u8>, Option<String>>>;
        static ACCOUNTS: OnceLock<AccountCache> = OnceLock::new();
        if start_time == 0 {
            return None;
        }
        // Read-only handles are separate from the mutation path and its safety checks.
        let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if raw.is_null() {
            return None;
        }
        let handle = ScopedHandle(raw);
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user_time = FILETIME::default();
        if unsafe {
            GetProcessTimes(
                handle.0,
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user_time,
            )
        } == 0
            || filetime_to_unix_secs(created) != start_time
        {
            return None;
        }
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(HANDLE(handle.0), TOKEN_QUERY, &mut token).ok()?;
            let mut length = 0;
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut length);
            // Use usize storage for the alignment of TOKEN_USER.
            if !(size_of::<TOKEN_USER>() as u32..=65536).contains(&length) {
                let _ = CloseHandle(token);
                return None;
            }
            let mut buffer = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
            let result = GetTokenInformation(
                token,
                TokenUser,
                Some(buffer.as_mut_ptr().cast()),
                length,
                &mut length,
            );
            let _ = CloseHandle(token);
            result.ok()?;
            let sid = (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid;
            let sid_len = GetLengthSid(sid) as usize;
            let bytes = std::slice::from_raw_parts(sid.0.cast::<u8>(), sid_len).to_vec();
            cached(ACCOUNTS.get_or_init(Default::default), bytes, 256, |_| {
                let mut name = [0u16; 256];
                let mut domain = [0u16; 256];
                let mut name_len = name.len() as u32;
                let mut domain_len = domain.len() as u32;
                let mut use_kind = SidTypeUnknown;
                LookupAccountSidW(
                    PCWSTR::null(),
                    sid,
                    Some(PWSTR(name.as_mut_ptr())),
                    &mut name_len,
                    Some(PWSTR(domain.as_mut_ptr())),
                    &mut domain_len,
                    &mut use_kind,
                )
                .ok()?;
                let name = String::from_utf16_lossy(name.get(..name_len as usize)?);
                let domain = String::from_utf16_lossy(domain.get(..domain_len as usize)?);
                Some(if domain.is_empty() {
                    name
                } else {
                    format!("{domain}\\{name}")
                })
            })
        }
    }

    fn resource_words(data: &[u32], value: *const c_void, length: usize) -> Option<&[u16]> {
        let offset = value.addr().checked_sub(data.as_ptr().addr())?;
        let end = offset.checked_add(length.checked_mul(size_of::<u16>())?)?;
        if end > size_of_val(data) || value.addr() % align_of::<u16>() != 0 {
            return None;
        }
        // Version API results are aligned UTF-16 words owned by the supplied buffer.
        Some(unsafe {
            std::slice::from_raw_parts(data.as_ptr().cast::<u8>().add(offset).cast(), length)
        })
    }

    pub(crate) fn description(path: &Path) -> Option<String> {
        type DescriptionCache = Mutex<HashMap<std::path::PathBuf, Option<String>>>;
        static DESCRIPTIONS: OnceLock<DescriptionCache> = OnceLock::new();
        let prefix = match path.components().next()? {
            std::path::Component::Prefix(prefix) => prefix.kind(),
            _ => return None,
        };
        if !path.is_absolute() || !matches!(prefix, Prefix::Disk(_) | Prefix::VerbatimDisk(_)) {
            return None;
        }
        cached(
            DESCRIPTIONS.get_or_init(Default::default),
            path.to_owned(),
            1024,
            |path| {
                let wide: Vec<_> = path.as_os_str().encode_wide().chain([0]).collect();
                let path = PCWSTR(wide.as_ptr());
                unsafe {
                    let size = GetFileVersionInfoSizeW(path, None);
                    if size == 0 || size > 4 * 1024 * 1024 {
                        return None;
                    }
                    let mut data = vec![0u32; (size as usize).div_ceil(size_of::<u32>())];
                    GetFileVersionInfoW(path, None, size, data.as_mut_ptr().cast()).ok()?;
                    let mut translations: *mut c_void = std::ptr::null_mut();
                    let mut length = 0;
                    if !VerQueryValueW(
                        data.as_ptr().cast(),
                        w!(r"\VarFileInfo\Translation"),
                        &mut translations,
                        &mut length,
                    )
                    .as_bool()
                    {
                        return None;
                    }
                    for pair in
                        resource_words(&data, translations, length as usize / 2)?.chunks_exact(2)
                    {
                        let query: Vec<_> = format!(
                            r"\StringFileInfo\{:04x}{:04x}\FileDescription",
                            pair[0], pair[1]
                        )
                        .encode_utf16()
                        .chain([0])
                        .collect();
                        let mut value: *mut c_void = std::ptr::null_mut();
                        let mut length = 0;
                        if VerQueryValueW(
                            data.as_ptr().cast(),
                            PCWSTR(query.as_ptr()),
                            &mut value,
                            &mut length,
                        )
                        .as_bool()
                            && length > 1
                        {
                            let Some(text) = resource_words(&data, value, length as usize) else {
                                continue;
                            };
                            let text = String::from_utf16_lossy(
                                text.split(|&c| c == 0).next().unwrap_or_default(),
                            );
                            if !text.trim().is_empty() {
                                return Some(text);
                            }
                        }
                    }
                    None
                }
            },
        )
    }
}
