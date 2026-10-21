#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
pub fn hide_std_window(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;

    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_std_window(_command: &mut std::process::Command) {}

/// tokio/mio sockets are inheritable on Windows. A child started with piped
/// stdio would inherit every open connection, and its exit can abort them.
#[cfg(windows)]
pub fn disable_socket_inheritance(socket: &impl std::os::windows::io::AsRawSocket) {
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
    unsafe {
        SetHandleInformation(socket.as_raw_socket() as _, HANDLE_FLAG_INHERIT, 0);
    }
}

#[cfg(not(windows))]
pub fn disable_socket_inheritance<T>(_socket: &T) {}

#[cfg(windows)]
pub fn hide_tokio_window(command: &mut tokio::process::Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_tokio_window(_command: &mut tokio::process::Command) {}
