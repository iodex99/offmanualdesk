//! DPAPI CurrentUser protection for Desk's per-user secrets (the gateway device key;
//! .claude/rules/windows.md: secrets at rest via DPAPI, never plain files).
//! FFI verified against windows-sys 0.61.2 `Win32/Security/Cryptography/mod.rs`.

/// Optional entropy so other apps of the same user can't unprotect our blobs by accident.
const ENTROPY: &[u8] = b"offmanual-desk/v1";

#[cfg(windows)]
#[allow(unsafe_code)]
mod platform {
    use super::ENTROPY;
    use std::ptr;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn blob(data: &[u8]) -> Option<CRYPT_INTEGER_BLOB> {
        Some(CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(data.len()).ok()?,
            // The API takes *mut but only reads input blobs.
            pbData: data.as_ptr().cast_mut(),
        })
    }

    /// Copies the output blob and frees it with LocalFree as the API requires.
    fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        if out.pbData.is_null() {
            return Vec::new();
        }
        // SAFETY: on success the API returns a LocalAlloc'd buffer of cbData bytes.
        let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
        // SAFETY: pbData came from the API's LocalAlloc and is freed exactly once.
        unsafe { LocalFree(out.pbData.cast()) };
        v
    }

    pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
        let input = blob(data)?;
        let entropy = blob(ENTROPY)?;
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        // SAFETY: all pointers are valid for the call; out is written by the API.
        let ok = unsafe {
            CryptProtectData(
                &input,
                ptr::null(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return None;
        }
        Some(take(out))
    }

    pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        let input = blob(data)?;
        let entropy = blob(ENTROPY)?;
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: ptr::null_mut(),
        };
        // SAFETY: as in protect; the description out-pointer is not requested (null).
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return None;
        }
        Some(take(out))
    }
}

#[cfg(not(windows))]
mod platform {
    // Desk only ships on Windows; elsewhere nothing can be protected, so refuse.
    pub fn protect(_: &[u8]) -> Option<Vec<u8>> {
        None
    }
    pub fn unprotect(_: &[u8]) -> Option<Vec<u8>> {
        None
    }
}

/// Encrypts for the current Windows user. None if DPAPI isn't available.
pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
    platform::protect(data)
}

/// Decrypts a blob made by `protect` for the same user.
pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
    platform::unprotect(data)
}

#[cfg(all(test, windows))]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_tamper() {
        let blob = protect(b"secret seed").unwrap();
        assert_ne!(blob.as_slice(), b"secret seed");
        assert_eq!(unprotect(&blob).unwrap(), b"secret seed");
        let mut bad = blob.clone();
        let last = bad.len() - 1;
        bad[last] ^= 0xff;
        assert!(unprotect(&bad).is_none());
    }
}
