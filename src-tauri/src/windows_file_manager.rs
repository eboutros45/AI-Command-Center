use std::{os::windows::ffi::OsStrExt, path::Path, ptr};
use windows_sys::Win32::{
    System::Com::{
        COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize,
    },
    UI::{
        Shell::{ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems, ShellExecuteW},
        WindowsAndMessaging::SW_SHOWNORMAL,
    },
};

pub(crate) fn open_in_file_manager(path: &Path) -> Result<(), String> {
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // The command runs on a blocking worker. Shell APIs need COM on the calling thread.
    let initialized = unsafe {
        CoInitializeEx(
            ptr::null(),
            (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
        )
    };
    // A worker may already be initialized in the other apartment. In that case, leave it intact.
    const RPC_E_CHANGED_MODE: i32 = 0x80010106_u32 as i32;
    if initialized < 0 && initialized != RPC_E_CHANGED_MODE {
        return Err(format!(
            "Could not initialize Windows File Explorer (0x{initialized:08X})."
        ));
    }
    let result = if path.is_dir() {
        let open = [b'o' as u16, b'p' as u16, b'e' as u16, b'n' as u16, 0];
        let result = unsafe {
            ShellExecuteW(
                ptr::null_mut(),
                open.as_ptr(),
                wide.as_ptr(),
                ptr::null(),
                ptr::null(),
                SW_SHOWNORMAL,
            )
        } as isize;
        if result > 32 {
            Ok(())
        } else {
            Err(format!(
                "File Explorer could not open {} (shell error {result}).",
                path.display()
            ))
        }
    } else {
        let item = unsafe { ILCreateFromPathW(wide.as_ptr()) };
        if item.is_null() {
            Err(format!(
                "File Explorer could not locate {}.",
                path.display()
            ))
        } else {
            // With no child list, the shell opens the parent and selects the absolute item.
            let status = unsafe { SHOpenFolderAndSelectItems(item, 0, ptr::null(), 0) };
            unsafe { ILFree(item) };
            if status >= 0 {
                Ok(())
            } else {
                Err(format!(
                    "File Explorer could not select {} (0x{status:08X}).",
                    path.display()
                ))
            }
        }
    };
    if initialized >= 0 {
        unsafe { CoUninitialize() };
    }
    result
}
