// SPDX-License-Identifier: AGPL-3.0-only
//
// WebAssembly exports around signal_fts5_tokenize (Signal-FTS5-Extension).
// The SQL worker registers an FTS5 tokenizer named "signal_tokenizer" whose
// xTokenize copies the text in here, calls `tokenize`, and hands each token
// to FTS5's callback; Database#signalTokenize uses the same function.
//
// Tokens are returned in one buffer, each as four little-endian u32
// (flags, start, end, byte length) followed by the token's UTF-8 bytes.

use core::ffi::{c_char, c_int, c_void};
use signal_tokenizer::{signal_fts5_tokenize, Fts5Tokenizer, SQLITE_OK};

static mut OUTPUT: Vec<u8> = Vec::new();

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr` and `len` must come from `alloc`.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

extern "C" fn on_token(
    ctx: *mut c_void,
    flags: c_int,
    token: *const c_char,
    len: c_int,
    start: c_int,
    end: c_int,
) -> c_int {
    let out = unsafe { &mut *(ctx as *mut Vec<u8>) };
    let bytes = unsafe { core::slice::from_raw_parts(token as *const u8, len as usize) };
    for value in [flags, start, end, len] {
        out.extend_from_slice(&(value as u32).to_le_bytes());
    }
    out.extend_from_slice(bytes);
    SQLITE_OK
}

/// Tokenizes `len` bytes of UTF-8 at `text` with FTS5 `flags`. Returns the
/// SQLite result code; the tokens are in `output_ptr()`/`output_len()`.
///
/// # Safety
/// `text` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn tokenize(text: *const u8, len: usize, flags: c_int) -> c_int {
    let out = &mut *core::ptr::addr_of_mut!(OUTPUT);
    out.clear();
    signal_fts5_tokenize(
        core::ptr::null_mut::<Fts5Tokenizer>(),
        out as *mut Vec<u8> as *mut c_void,
        flags,
        text as *const c_char,
        len as c_int,
        on_token,
    )
}

#[no_mangle]
pub extern "C" fn output_ptr() -> *const u8 {
    unsafe { (*core::ptr::addr_of!(OUTPUT)).as_ptr() }
}

#[no_mangle]
pub extern "C" fn output_len() -> usize {
    unsafe { (*core::ptr::addr_of!(OUTPUT)).len() }
}
