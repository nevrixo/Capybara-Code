//! Race-safe filesystem operations rooted at a trusted workspace directory.
//!
//! A validated absolute pathname is not a capability: another process can swap
//! one of its parents before the caller opens it.  These helpers keep the
//! authority anchored to the workspace object.  Unix uses component-by-component
//! directory-fd traversal and `*at` syscalls; Windows pins every normal directory
//! handle without delete sharing and rejects reparse points.

use std::ffi::OsString;
use std::fs::{File, Metadata};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::atomic::{hash_bytes, hashes_match, FsError, WriteIntent, WriteOutcome};

fn invalid_relative(root: &Path, relative: &Path, detail: &str) -> FsError {
    FsError::Io {
        path: root.join(relative).display().to_string(),
        message: format!("unsafe workspace-relative path: {detail}"),
    }
}

fn relative_parts(root: &Path, relative: &Path) -> Result<Vec<OsString>, FsError> {
    if relative.is_absolute() {
        return Err(invalid_relative(
            root,
            relative,
            "absolute paths are not allowed",
        ));
    }
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_os_string()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(invalid_relative(
                    root,
                    relative,
                    "parent, root, and prefix components are not allowed",
                ));
            }
        }
    }
    if parts.is_empty() {
        return Err(invalid_relative(root, relative, "a file name is required"));
    }
    Ok(parts)
}

fn decode_text(path: &Path, bytes: Vec<u8>) -> Result<(String, String), FsError> {
    let hash = hash_bytes(&bytes);
    match String::from_utf8(bytes) {
        Ok(text) => Ok((text, hash)),
        Err(error) => Err(FsError::UnsupportedEncoding {
            path: path.display().to_string(),
            detail: format!(
                "not valid UTF-8 at byte {}",
                error.utf8_error().valid_up_to()
            ),
        }),
    }
}

fn hash_reader(mut reader: impl Read, path: &Path) -> Result<String, FsError> {
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| map_io(path, error))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// The result of a bounded text range read.
///
/// Exact reads hash and validate the complete file but retain only the selected
/// lines. Preview reads stop after the selected range and therefore do not have
/// a content checksum or a complete line count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextRangeRead {
    pub text: String,
    pub checksum: Option<String>,
    pub revision_token: String,
    pub start_line: usize,
    pub end_line: usize,
    pub total_lines: Option<usize>,
    pub end_of_file: bool,
    pub truncated_by_bytes: bool,
    /// Bytes consumed from the opened file. For preview this is the range
    /// prefix; for exact it is the complete file.
    pub bytes: u64,
    /// Number of complete source lines represented by the selected range.
    pub selected_lines: usize,
}

/// Return a stable-enough token for validating a preview before promoting it to
/// an exact read. It is deliberately metadata based: a preview must not scan a
/// whole file merely to produce a cache/revision key.
pub fn revision_token_beneath(root: &Path, relative: &Path) -> Result<String, FsError> {
    let (file, metadata) = platform::open_read(root, relative)?;
    Ok(metadata_revision_token(&metadata, Some(&file)))
}

/// Read an exact line range while streaming the complete file hash.
pub fn read_text_range_beneath(
    root: &Path,
    relative: &Path,
    start_line: usize,
    max_lines: usize,
    max_output_bytes: u64,
) -> Result<TextRangeRead, FsError> {
    read_text_range(
        root,
        relative,
        start_line,
        max_lines,
        max_output_bytes,
        false,
    )
}

/// Read only the requested prefix/range. The returned revision token is based
/// on the opened file metadata and is never authoritative for a write.
pub fn preview_text_range_beneath(
    root: &Path,
    relative: &Path,
    start_line: usize,
    max_lines: usize,
    max_output_bytes: u64,
) -> Result<TextRangeRead, FsError> {
    read_text_range(
        root,
        relative,
        start_line,
        max_lines,
        max_output_bytes,
        true,
    )
}

fn read_text_range(
    root: &Path,
    relative: &Path,
    start_line: usize,
    max_lines: usize,
    max_output_bytes: u64,
    preview: bool,
) -> Result<TextRangeRead, FsError> {
    if start_line == 0 || max_lines == 0 {
        return Err(FsError::Io {
            path: root.join(relative).display().to_string(),
            message: "line range must start at one and contain at least one line".into(),
        });
    }

    let path = root.join(relative);
    let (file, metadata) = platform::open_read(root, relative)?;
    let metadata_token = metadata_revision_token(&metadata, Some(&file));
    let range = read_range_from_reader(
        file,
        &path,
        metadata.len(),
        &metadata_token,
        start_line,
        max_lines,
        max_output_bytes,
        preview,
    )?;
    Ok(range)
}

fn metadata_revision_token(metadata: &Metadata, _file: Option<&File>) -> String {
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| format!("{}:{}", duration.as_secs(), duration.subsec_nanos()))
        .unwrap_or_else(|| "unknown".into());
    let identity = {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            format!(
                "dev={};ino={};ctime={}:{}",
                metadata.dev(),
                metadata.ino(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            )
        }
        #[cfg(windows)]
        {
            // `MetadataExt::{volume_serial_number,file_index}` is still an
            // unstable standard-library API on the supported Windows toolchains.
            // Read the same stable file identity through the Win32 handle API
            // instead; this keeps preview revisions resistant to a replacement
            // file with identical size and timestamps.
            _file.and_then(platform::file_identity)
                .unwrap_or_else(|| "identity=unknown".to_string())
        }
        #[cfg(not(any(unix, windows)))]
        {
            "unknown".to_string()
        }
    };
    let created = metadata
        .created()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| format!("{}:{}", duration.as_secs(), duration.subsec_nanos()))
        .unwrap_or_else(|| "unknown".into());
    let material = format!(
        "{identity};len={};modified={modified};created={created};readonly={}",
        metadata.len(),
        metadata.permissions().readonly(),
    );
    format!("revision:{}", hash_bytes(material.as_bytes()))
}

struct Utf8Validator {
    pending: Vec<u8>,
    offset: u64,
}

impl Utf8Validator {
    fn new() -> Self {
        Self {
            pending: Vec::new(),
            offset: 0,
        }
    }

    fn feed(&mut self, bytes: &[u8], path: &Path) -> Result<(), FsError> {
        let pending_len = self.pending.len();
        let base = self.offset.saturating_sub(pending_len as u64);
        let mut combined = Vec::with_capacity(pending_len + bytes.len());
        combined.extend_from_slice(&self.pending);
        combined.extend_from_slice(bytes);
        match std::str::from_utf8(&combined) {
            Ok(_) => self.pending.clear(),
            Err(error) => {
                let valid = error.valid_up_to();
                if error.error_len().is_none() {
                    self.pending = combined[valid..].to_vec();
                    debug_assert!(self.pending.len() <= 3);
                } else {
                    return Err(FsError::UnsupportedEncoding {
                        path: path.display().to_string(),
                        detail: format!("not valid UTF-8 at byte {}", base + valid as u64),
                    });
                }
            }
        }
        self.offset = self.offset.saturating_add(bytes.len() as u64);
        Ok(())
    }

    fn finish(self, path: &Path) -> Result<(), FsError> {
        if self.pending.is_empty() {
            Ok(())
        } else {
            Err(FsError::UnsupportedEncoding {
                path: path.display().to_string(),
                detail: format!(
                    "not valid UTF-8 at byte {}",
                    self.offset - self.pending.len() as u64
                ),
            })
        }
    }
}

fn selected_line(line: usize, start_line: usize, max_lines: usize) -> bool {
    line >= start_line && line < start_line.saturating_add(max_lines)
}

fn retain_line_byte(line: &mut Vec<u8>, truncated: &mut bool, byte: u8, max_bytes: usize) {
    if line.len() < max_bytes {
        line.push(byte);
    } else {
        *truncated = true;
    }
}

fn append_line(
    output: &mut Vec<u8>,
    line: &mut Vec<u8>,
    selected_count: usize,
    line_truncated: bool,
    max_output_bytes: usize,
    truncated: &mut bool,
) {
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    if selected_count > 0 {
        if output.len() < max_output_bytes {
            output.push(b'\n');
        } else {
            *truncated = true;
        }
    }
    let available = max_output_bytes.saturating_sub(output.len());
    let take = line.len().min(available);
    let valid_take = match std::str::from_utf8(&line[..take]) {
        Ok(_) => take,
        Err(error) => error.valid_up_to(),
    };
    output.extend_from_slice(&line[..valid_take]);
    if valid_take < line.len() || line_truncated {
        *truncated = true;
    }
    line.clear();
}

fn read_range_from_reader(
    mut reader: impl Read,
    path: &Path,
    file_len: u64,
    metadata_token: &str,
    start_line: usize,
    max_lines: usize,
    max_output_bytes: u64,
    preview: bool,
) -> Result<TextRangeRead, FsError> {
    let max_output_bytes = usize::try_from(max_output_bytes).unwrap_or(usize::MAX);
    let selection_end = start_line.saturating_add(max_lines);
    let mut hasher = Sha256::new();
    let mut validator = Utf8Validator::new();
    let mut output = Vec::new();
    let mut line = Vec::new();
    let mut line_truncated = false;
    let mut current_line = 1usize;
    let mut total_lines = 0usize;
    let mut selected_lines = 0usize;
    let mut line_has_bytes = false;
    let mut truncated_by_bytes = false;
    let mut bytes = 0u64;
    let mut range_end_offset = None;
    let mut stopped_at_range = false;
    let mut buffer = [0u8; 64 * 1024];

    'read: loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| map_io(path, error))?;
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        if !preview {
            hasher.update(chunk);
            validator.feed(chunk, path)?;
        }

        let mut processed = 0usize;
        for (index, &byte) in chunk.iter().enumerate() {
            processed = index + 1;
            let byte_offset = bytes;
            bytes = bytes.saturating_add(1);
            if byte != b'\n' {
                line_has_bytes = true;
                if selected_line(current_line, start_line, max_lines) {
                    retain_line_byte(&mut line, &mut line_truncated, byte, max_output_bytes);
                }
                continue;
            }

            if selected_line(current_line, start_line, max_lines) {
                append_line(
                    &mut output,
                    &mut line,
                    selected_lines,
                    line_truncated,
                    max_output_bytes,
                    &mut truncated_by_bytes,
                );
                selected_lines += 1;
            }
            total_lines += 1;
            let completed_line = current_line;
            current_line = current_line.saturating_add(1);
            line_has_bytes = false;
            line_truncated = false;

            if preview
                && completed_line >= start_line
                && completed_line.saturating_add(1) >= selection_end
            {
                range_end_offset = Some(byte_offset.saturating_add(1));
                stopped_at_range = true;
                break;
            }
        }

        if preview {
            // Only validate bytes up to the requested line boundary. The OS may
            // have filled the remainder of this chunk, but preview must not make
            // content after the requested range authoritative or fail on it.
            validator.feed(&chunk[..processed], path)?;
        }
        if stopped_at_range {
            break 'read;
        }
    }

    if !stopped_at_range {
        if line_has_bytes {
            if selected_line(current_line, start_line, max_lines) {
                append_line(
                    &mut output,
                    &mut line,
                    selected_lines,
                    line_truncated,
                    max_output_bytes,
                    &mut truncated_by_bytes,
                );
                selected_lines += 1;
            }
            total_lines += 1;
        }
        validator.finish(path)?;
    }

    let actual_start = if total_lines == 0 {
        1
    } else {
        start_line.min(total_lines.saturating_add(1))
    };
    let end_line = if selected_lines == 0 {
        actual_start
    } else {
        actual_start.saturating_add(selected_lines.saturating_sub(1))
    };
    let end_of_file = if stopped_at_range {
        range_end_offset.unwrap_or(bytes) >= file_len
    } else if total_lines == 0 {
        true
    } else {
        end_line >= total_lines
    };
    let total_lines = if stopped_at_range {
        None
    } else {
        Some(total_lines)
    };
    let checksum = if preview {
        None
    } else {
        Some(format!("{:x}", hasher.finalize()))
    };
    let revision_token = checksum
        .clone()
        .unwrap_or_else(|| metadata_token.to_string());

    Ok(TextRangeRead {
        text: String::from_utf8(output).map_err(|error| FsError::UnsupportedEncoding {
            path: path.display().to_string(),
            detail: format!(
                "not valid UTF-8 at byte {}",
                error.utf8_error().valid_up_to()
            ),
        })?,
        checksum,
        revision_token,
        start_line: actual_start,
        end_line,
        total_lines,
        end_of_file,
        truncated_by_bytes,
        bytes,
        selected_lines,
    })
}

fn map_io(path: &Path, error: io::Error) -> FsError {
    match error.kind() {
        io::ErrorKind::NotFound => FsError::NotFound {
            path: path.display().to_string(),
        },
        io::ErrorKind::AlreadyExists => FsError::AlreadyExists {
            path: path.display().to_string(),
        },
        _ => FsError::Io {
            path: path.display().to_string(),
            message: error.to_string(),
        },
    }
}

pub fn path_exists_beneath(root: &Path, relative: &Path) -> Result<bool, FsError> {
    platform::path_exists(root, relative)
}

pub fn hash_file_beneath(root: &Path, relative: &Path) -> Result<String, FsError> {
    platform::hash_file(root, relative)
}

pub fn file_len_beneath(root: &Path, relative: &Path) -> Result<u64, FsError> {
    platform::file_len(root, relative)
}

pub fn read_text_beneath(
    root: &Path,
    relative: &Path,
    max_bytes: u64,
) -> Result<(String, String), FsError> {
    let path = root.join(relative);
    let bytes = platform::read_bytes(root, relative, max_bytes)?;
    decode_text(&path, bytes)
}

pub fn is_probably_binary_beneath(root: &Path, relative: &Path) -> Result<bool, FsError> {
    let bytes = platform::read_prefix(root, relative, 8_000)?;
    if bytes.is_empty() {
        return Ok(false);
    }
    if bytes.contains(&0) {
        return Ok(true);
    }
    let non_text = bytes
        .iter()
        .filter(|&&byte| byte < 0x09 || (byte > 0x0d && byte < 0x20))
        .count();
    Ok(non_text * 100 / bytes.len() > 5)
}

pub fn atomic_write_beneath(
    root: &Path,
    relative: &Path,
    content: &[u8],
    intent: WriteIntent,
    expected_hash: Option<&str>,
) -> Result<WriteOutcome, FsError> {
    platform::atomic_write(root, relative, content, intent, expected_hash)
}

pub fn delete_path_beneath(root: &Path, relative: &Path, recursive: bool) -> Result<u64, FsError> {
    platform::delete_path(root, relative, recursive)
}

pub fn move_path_beneath(
    root: &Path,
    from_relative: &Path,
    to_relative: &Path,
) -> Result<(), FsError> {
    platform::move_path(root, from_relative, to_relative)
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::ffi::{CStr, CString};
    use std::fs::File;
    use std::io::Write;
    use std::os::fd::{AsRawFd, FromRawFd, RawFd};
    use std::os::unix::ffi::OsStrExt;

    struct ParentFd {
        directory: File,
        leaf: CString,
        display: PathBuf,
    }

    fn cstring(path: &Path, bytes: &[u8]) -> Result<CString, FsError> {
        CString::new(bytes).map_err(|_| FsError::Io {
            path: path.display().to_string(),
            message: "path contains NUL".into(),
        })
    }

    fn open_directory_at(parent: RawFd, name: &CStr) -> io::Result<File> {
        let fd = unsafe {
            libc::openat(
                parent,
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { File::from_raw_fd(fd) })
        }
    }

    fn open_parent(root: &Path, relative: &Path, create: bool) -> Result<ParentFd, FsError> {
        let parts = relative_parts(root, relative)?;
        let display = root.join(relative);
        let root_name = cstring(root, root.as_os_str().as_bytes())?;
        let root_fd = unsafe {
            libc::open(
                root_name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if root_fd < 0 {
            return Err(map_io(root, io::Error::last_os_error()));
        }
        let mut directory = unsafe { File::from_raw_fd(root_fd) };

        for part in &parts[..parts.len() - 1] {
            let name = cstring(&display, part.as_bytes())?;
            match open_directory_at(directory.as_raw_fd(), &name) {
                Ok(next) => directory = next,
                Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                    let created =
                        unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) };
                    if created != 0 {
                        let mkdir_error = io::Error::last_os_error();
                        if mkdir_error.kind() != io::ErrorKind::AlreadyExists {
                            return Err(map_io(&display, mkdir_error));
                        }
                    }
                    directory = open_directory_at(directory.as_raw_fd(), &name)
                        .map_err(|error| map_io(&display, error))?;
                }
                Err(error) => return Err(map_io(&display, error)),
            }
        }

        let leaf = cstring(&display, parts.last().expect("non-empty parts").as_bytes())?;
        Ok(ParentFd {
            directory,
            leaf,
            display,
        })
    }

    fn stat_at(parent: &ParentFd) -> Result<Option<libc::stat>, FsError> {
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::fstatat(
                parent.directory.as_raw_fd(),
                parent.leaf.as_ptr(),
                &mut stat,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if result == 0 {
            let kind = stat.st_mode & libc::S_IFMT;
            if kind == libc::S_IFLNK {
                return Err(FsError::Io {
                    path: parent.display.display().to_string(),
                    message: "refusing to follow a symlink during workspace access".into(),
                });
            }
            Ok(Some(stat))
        } else {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::NotFound {
                Ok(None)
            } else {
                Err(map_io(&parent.display, error))
            }
        }
    }

    fn open_file(parent: &ParentFd) -> Result<File, FsError> {
        let fd = unsafe {
            libc::openat(
                parent.directory.as_raw_fd(),
                parent.leaf.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(map_io(&parent.display, io::Error::last_os_error()));
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file
            .metadata()
            .map_err(|error| map_io(&parent.display, error))?;
        if metadata.is_dir() {
            return Err(FsError::IsDirectory {
                path: parent.display.display().to_string(),
            });
        }
        if !metadata.is_file() {
            return Err(FsError::Io {
                path: parent.display.display().to_string(),
                message: "refusing to open a non-regular file".into(),
            });
        }
        Ok(file)
    }

    pub(super) fn open_read(root: &Path, relative: &Path) -> Result<(File, Metadata), FsError> {
        let parent = open_parent(root, relative, false)?;
        let file = open_file(&parent)?;
        let metadata = file
            .metadata()
            .map_err(|error| map_io(&parent.display, error))?;
        Ok((file, metadata))
    }

    pub(super) fn path_exists(root: &Path, relative: &Path) -> Result<bool, FsError> {
        let parent = open_parent(root, relative, false)?;
        Ok(stat_at(&parent)?.is_some())
    }

    pub(super) fn hash_file(root: &Path, relative: &Path) -> Result<String, FsError> {
        let parent = open_parent(root, relative, false)?;
        let file = open_file(&parent)?;
        hash_reader(file, &parent.display)
    }

    pub(super) fn file_len(root: &Path, relative: &Path) -> Result<u64, FsError> {
        let parent = open_parent(root, relative, false)?;
        let file = open_file(&parent)?;
        Ok(file
            .metadata()
            .map_err(|error| map_io(&parent.display, error))?
            .len())
    }

    pub(super) fn read_prefix(
        root: &Path,
        relative: &Path,
        max_bytes: u64,
    ) -> Result<Vec<u8>, FsError> {
        let parent = open_parent(root, relative, false)?;
        let mut file = open_file(&parent)?;
        let mut bytes = Vec::with_capacity(max_bytes as usize);
        Read::by_ref(&mut file)
            .take(max_bytes)
            .read_to_end(&mut bytes)
            .map_err(|error| map_io(&parent.display, error))?;
        Ok(bytes)
    }

    pub(super) fn read_bytes(
        root: &Path,
        relative: &Path,
        max_bytes: u64,
    ) -> Result<Vec<u8>, FsError> {
        let parent = open_parent(root, relative, false)?;
        let mut file = open_file(&parent)?;
        let length = file
            .metadata()
            .map_err(|error| map_io(&parent.display, error))?
            .len();
        if length > max_bytes {
            return Err(FsError::TooLarge {
                path: parent.display.display().to_string(),
                bytes: length,
                max: max_bytes,
            });
        }
        let mut bytes = Vec::with_capacity(length as usize);
        Read::by_ref(&mut file)
            .take(max_bytes.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|error| map_io(&parent.display, error))?;
        if bytes.len() as u64 > max_bytes {
            return Err(FsError::TooLarge {
                path: parent.display.display().to_string(),
                bytes: bytes.len() as u64,
                max: max_bytes,
            });
        }
        Ok(bytes)
    }

    fn temp_name() -> CString {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        CString::new(format!(".cbc-tmp-{}-{nanos}", std::process::id()))
            .expect("generated temp name has no NUL")
    }

    fn rename_noreplace(
        from_dir: RawFd,
        from: &CStr,
        to_dir: RawFd,
        to: &CStr,
        display: &Path,
    ) -> Result<(), FsError> {
        #[cfg(any(target_os = "linux", target_os = "android"))]
        {
            let result = unsafe {
                libc::syscall(
                    libc::SYS_renameat2,
                    from_dir,
                    from.as_ptr(),
                    to_dir,
                    to.as_ptr(),
                    1u32, // RENAME_NOREPLACE
                )
            };
            if result == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if !matches!(
                error.raw_os_error(),
                Some(libc::ENOSYS) | Some(libc::EINVAL)
            ) {
                return Err(map_io(display, error));
            }
        }

        let mut target: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatat(to_dir, to.as_ptr(), &mut target, libc::AT_SYMLINK_NOFOLLOW) }
            == 0
        {
            return Err(FsError::AlreadyExists {
                path: display.display().to_string(),
            });
        }
        let result = unsafe { libc::renameat(from_dir, from.as_ptr(), to_dir, to.as_ptr()) };
        if result == 0 {
            Ok(())
        } else {
            Err(map_io(display, io::Error::last_os_error()))
        }
    }

    pub(super) fn atomic_write(
        root: &Path,
        relative: &Path,
        content: &[u8],
        intent: WriteIntent,
        expected_hash: Option<&str>,
    ) -> Result<WriteOutcome, FsError> {
        let parent = open_parent(root, relative, true)?;
        let state = stat_at(&parent)?;
        let exists = state.is_some();
        if state
            .as_ref()
            .is_some_and(|stat| stat.st_mode & libc::S_IFMT == libc::S_IFDIR)
        {
            return Err(FsError::IsDirectory {
                path: parent.display.display().to_string(),
            });
        }
        match intent {
            WriteIntent::Create if exists => {
                return Err(FsError::AlreadyExists {
                    path: parent.display.display().to_string(),
                })
            }
            WriteIntent::Replace if !exists => {
                return Err(FsError::NotFound {
                    path: parent.display.display().to_string(),
                })
            }
            _ => {}
        }

        let pre_hash = if exists {
            Some(hash_reader(open_file(&parent)?, &parent.display)?)
        } else {
            None
        };
        if let Some(expected) = expected_hash {
            let actual = pre_hash.clone().unwrap_or_default();
            if !hashes_match(&actual, expected) {
                return Err(FsError::HashMismatch {
                    path: parent.display.display().to_string(),
                    expected: expected.into(),
                    actual: if actual.is_empty() {
                        "<absent>".into()
                    } else {
                        actual
                    },
                });
            }
        }

        let temp = temp_name();
        let fd = unsafe {
            libc::openat(
                parent.directory.as_raw_fd(),
                temp.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                crate::atomic::DEFAULT_NEW_FILE_MODE,
            )
        };
        if fd < 0 {
            return Err(map_io(&parent.display, io::Error::last_os_error()));
        }
        let mut temp_file = unsafe { File::from_raw_fd(fd) };
        let write_result = (|| {
            temp_file
                .write_all(content)
                .map_err(|error| map_io(&parent.display, error))?;
            temp_file
                .flush()
                .map_err(|error| map_io(&parent.display, error))?;
            temp_file
                .sync_all()
                .map_err(|error| map_io(&parent.display, error))?;
            if let Some(stat) = state.as_ref() {
                let mode = stat.st_mode & 0o7777;
                if unsafe { libc::fchmod(temp_file.as_raw_fd(), mode) } != 0 {
                    return Err(map_io(&parent.display, io::Error::last_os_error()));
                }
            }
            Ok(())
        })();
        drop(temp_file);
        if let Err(error) = write_result {
            unsafe {
                libc::unlinkat(parent.directory.as_raw_fd(), temp.as_ptr(), 0);
            }
            return Err(error);
        }

        let rename_result = if matches!(intent, WriteIntent::Create) {
            rename_noreplace(
                parent.directory.as_raw_fd(),
                &temp,
                parent.directory.as_raw_fd(),
                &parent.leaf,
                &parent.display,
            )
        } else {
            let result = unsafe {
                libc::renameat(
                    parent.directory.as_raw_fd(),
                    temp.as_ptr(),
                    parent.directory.as_raw_fd(),
                    parent.leaf.as_ptr(),
                )
            };
            if result == 0 {
                Ok(())
            } else {
                Err(map_io(&parent.display, io::Error::last_os_error()))
            }
        };
        if let Err(error) = rename_result {
            unsafe {
                libc::unlinkat(parent.directory.as_raw_fd(), temp.as_ptr(), 0);
            }
            return Err(error);
        }
        let _ = parent.directory.sync_all();
        Ok(WriteOutcome {
            pre_hash,
            post_hash: hash_bytes(content),
            bytes_written: content.len() as u64,
            created: !exists,
        })
    }

    pub(super) fn delete_path(
        root: &Path,
        relative: &Path,
        recursive: bool,
    ) -> Result<u64, FsError> {
        let parent = open_parent(root, relative, false)?;
        let stat = stat_at(&parent)?.ok_or_else(|| FsError::NotFound {
            path: parent.display.display().to_string(),
        })?;
        let is_dir = stat.st_mode & libc::S_IFMT == libc::S_IFDIR;
        if recursive {
            return Err(FsError::Io {
                path: parent.display.display().to_string(),
                message: "recursive deletion is not supported by race-safe workspace operations"
                    .into(),
            });
        }
        let flags = if is_dir { libc::AT_REMOVEDIR } else { 0 };
        let result =
            unsafe { libc::unlinkat(parent.directory.as_raw_fd(), parent.leaf.as_ptr(), flags) };
        if result != 0 {
            return Err(map_io(&parent.display, io::Error::last_os_error()));
        }
        let _ = parent.directory.sync_all();
        Ok(1)
    }

    pub(super) fn move_path(
        root: &Path,
        from_relative: &Path,
        to_relative: &Path,
    ) -> Result<(), FsError> {
        let from = open_parent(root, from_relative, false)?;
        if stat_at(&from)?.is_none() {
            return Err(FsError::NotFound {
                path: from.display.display().to_string(),
            });
        }
        let to = open_parent(root, to_relative, true)?;
        if stat_at(&to)?.is_some() {
            return Err(FsError::AlreadyExists {
                path: to.display.display().to_string(),
            });
        }
        rename_noreplace(
            from.directory.as_raw_fd(),
            &from.leaf,
            to.directory.as_raw_fd(),
            &to.leaf,
            &to.display,
        )?;
        let _ = from.directory.sync_all();
        let _ = to.directory.sync_all();
        Ok(())
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::fs::{self, File, OpenOptions};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::os::windows::io::{AsRawHandle, RawHandle};

    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    const REPLACEFILE_WRITE_THROUGH: u32 = 0x0000_0001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;

    #[link(name = "Kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(
            file: RawHandle,
            information: *mut ByHandleFileInformation,
        ) -> i32;
        fn ReplaceFileW(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: *mut std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
        ) -> i32;
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    #[repr(C)]
    struct ByHandleFileInformation {
        _file_attributes: u32,
        _creation_time: [u32; 2],
        _last_access_time: [u32; 2],
        _last_write_time: [u32; 2],
        volume_serial_number: u32,
        _file_size_high: u32,
        _file_size_low: u32,
        _number_of_links: u32,
        file_index_high: u32,
        file_index_low: u32,
    }

    pub(super) fn file_identity(file: &File) -> Option<String> {
        let mut information = ByHandleFileInformation {
            _file_attributes: 0,
            _creation_time: [0; 2],
            _last_access_time: [0; 2],
            _last_write_time: [0; 2],
            volume_serial_number: 0,
            _file_size_high: 0,
            _file_size_low: 0,
            _number_of_links: 0,
            file_index_high: 0,
            file_index_low: 0,
        };
        // SAFETY: `information` is a valid writable buffer of the exact C
        // structure shape expected by GetFileInformationByHandle, and the
        // handle is borrowed from an open File for the duration of the call.
        let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) };
        if ok == 0 {
            return None;
        }
        let index =
            (u64::from(information.file_index_high) << 32) | u64::from(information.file_index_low);
        Some(format!(
            "volume={};index={}",
            information.volume_serial_number, index
        ))
    }

    struct PinnedParent {
        _directories: Vec<File>,
        target: PathBuf,
    }

    fn open_directory(path: &Path) -> Result<File, FsError> {
        let file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|error| map_io(path, error))?;
        let metadata = file.metadata().map_err(|error| map_io(path, error))?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(FsError::Io {
                path: path.display().to_string(),
                message: "refusing to traverse a Windows reparse point".into(),
            });
        }
        if !metadata.is_dir() {
            return Err(FsError::NotDirectory {
                path: path.display().to_string(),
            });
        }
        Ok(file)
    }

    fn open_parent(root: &Path, relative: &Path, create: bool) -> Result<PinnedParent, FsError> {
        let parts = relative_parts(root, relative)?;
        let mut directories = vec![open_directory(root)?];
        let mut current = root.to_path_buf();
        for part in &parts[..parts.len() - 1] {
            current.push(part);
            match open_directory(&current) {
                Ok(handle) => directories.push(handle),
                Err(FsError::NotFound { .. }) if create => {
                    match fs::create_dir(&current) {
                        Ok(()) => {}
                        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                        Err(error) => return Err(map_io(&current, error)),
                    }
                    directories.push(open_directory(&current)?);
                }
                Err(error) => return Err(error),
            }
        }
        current.push(parts.last().expect("non-empty parts"));
        Ok(PinnedParent {
            _directories: directories,
            target: current,
        })
    }

    fn open_file_optional(path: &Path) -> Result<Option<File>, FsError> {
        let result = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path);
        let file = match result {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(map_io(path, error)),
        };
        let metadata = file.metadata().map_err(|error| map_io(path, error))?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(FsError::Io {
                path: path.display().to_string(),
                message: "refusing to follow a Windows reparse point".into(),
            });
        }
        if metadata.is_dir() {
            return Err(FsError::IsDirectory {
                path: path.display().to_string(),
            });
        }
        if !metadata.is_file() {
            return Err(FsError::Io {
                path: path.display().to_string(),
                message: "refusing to open a non-regular file".into(),
            });
        }
        Ok(Some(file))
    }

    pub(super) fn open_read(root: &Path, relative: &Path) -> Result<(File, Metadata), FsError> {
        let parent = open_parent(root, relative, false)?;
        let file = open_file_optional(&parent.target)?.ok_or_else(|| FsError::NotFound {
            path: parent.target.display().to_string(),
        })?;
        let metadata = file
            .metadata()
            .map_err(|error| map_io(&parent.target, error))?;
        Ok((file, metadata))
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn replace_or_move(temp: &Path, target: &Path, target_exists: bool) -> io::Result<()> {
        let temp_wide = wide(temp);
        let target_wide = wide(target);
        let result = unsafe {
            if target_exists {
                ReplaceFileW(
                    target_wide.as_ptr(),
                    temp_wide.as_ptr(),
                    std::ptr::null(),
                    REPLACEFILE_WRITE_THROUGH,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            } else {
                MoveFileExW(
                    temp_wide.as_ptr(),
                    target_wide.as_ptr(),
                    MOVEFILE_WRITE_THROUGH,
                )
            }
        };
        if result == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    pub(super) fn path_exists(root: &Path, relative: &Path) -> Result<bool, FsError> {
        let parent = open_parent(root, relative, false)?;
        match fs::symlink_metadata(&parent.target) {
            Ok(metadata) => {
                if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                    return Err(FsError::Io {
                        path: parent.target.display().to_string(),
                        message: "refusing to inspect a Windows reparse point".into(),
                    });
                }
                Ok(true)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(map_io(&parent.target, error)),
        }
    }

    pub(super) fn hash_file(root: &Path, relative: &Path) -> Result<String, FsError> {
        let parent = open_parent(root, relative, false)?;
        let file = open_file_optional(&parent.target)?.ok_or_else(|| FsError::NotFound {
            path: parent.target.display().to_string(),
        })?;
        hash_reader(file, &parent.target)
    }

    pub(super) fn file_len(root: &Path, relative: &Path) -> Result<u64, FsError> {
        let parent = open_parent(root, relative, false)?;
        let file = open_file_optional(&parent.target)?.ok_or_else(|| FsError::NotFound {
            path: parent.target.display().to_string(),
        })?;
        Ok(file
            .metadata()
            .map_err(|error| map_io(&parent.target, error))?
            .len())
    }

    pub(super) fn read_prefix(
        root: &Path,
        relative: &Path,
        max_bytes: u64,
    ) -> Result<Vec<u8>, FsError> {
        let parent = open_parent(root, relative, false)?;
        let mut file = open_file_optional(&parent.target)?.ok_or_else(|| FsError::NotFound {
            path: parent.target.display().to_string(),
        })?;
        let mut bytes = Vec::with_capacity(max_bytes as usize);
        Read::by_ref(&mut file)
            .take(max_bytes)
            .read_to_end(&mut bytes)
            .map_err(|error| map_io(&parent.target, error))?;
        Ok(bytes)
    }

    pub(super) fn read_bytes(
        root: &Path,
        relative: &Path,
        max_bytes: u64,
    ) -> Result<Vec<u8>, FsError> {
        let parent = open_parent(root, relative, false)?;
        let mut file = open_file_optional(&parent.target)?.ok_or_else(|| FsError::NotFound {
            path: parent.target.display().to_string(),
        })?;
        let length = file
            .metadata()
            .map_err(|error| map_io(&parent.target, error))?
            .len();
        if length > max_bytes {
            return Err(FsError::TooLarge {
                path: parent.target.display().to_string(),
                bytes: length,
                max: max_bytes,
            });
        }
        let mut bytes = Vec::with_capacity(length as usize);
        Read::by_ref(&mut file)
            .take(max_bytes.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|error| map_io(&parent.target, error))?;
        if bytes.len() as u64 > max_bytes {
            return Err(FsError::TooLarge {
                path: parent.target.display().to_string(),
                bytes: bytes.len() as u64,
                max: max_bytes,
            });
        }
        Ok(bytes)
    }

    pub(super) fn atomic_write(
        root: &Path,
        relative: &Path,
        content: &[u8],
        intent: WriteIntent,
        expected_hash: Option<&str>,
    ) -> Result<WriteOutcome, FsError> {
        let parent = open_parent(root, relative, true)?;
        let current = open_file_optional(&parent.target)?;
        let exists = current.is_some();
        match intent {
            WriteIntent::Create if exists => {
                return Err(FsError::AlreadyExists {
                    path: parent.target.display().to_string(),
                })
            }
            WriteIntent::Replace if !exists => {
                return Err(FsError::NotFound {
                    path: parent.target.display().to_string(),
                })
            }
            _ => {}
        }
        let pre_hash = match current {
            Some(file) => Some(hash_reader(file, &parent.target)?),
            None => None,
        };
        if let Some(expected) = expected_hash {
            let actual = pre_hash.clone().unwrap_or_default();
            if !hashes_match(&actual, expected) {
                return Err(FsError::HashMismatch {
                    path: parent.target.display().to_string(),
                    expected: expected.into(),
                    actual: if actual.is_empty() {
                        "<absent>".into()
                    } else {
                        actual
                    },
                });
            }
        }

        let temp = crate::atomic::temp_sibling(&parent.target);
        if let Err(error) = crate::atomic::write_and_sync(&temp, content, &parent.target, exists) {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
        if let Err(error) = replace_or_move(&temp, &parent.target, exists) {
            let _ = fs::remove_file(&temp);
            return Err(map_io(&parent.target, error));
        }
        Ok(WriteOutcome {
            pre_hash,
            post_hash: hash_bytes(content),
            bytes_written: content.len() as u64,
            created: !exists,
        })
    }

    pub(super) fn delete_path(
        root: &Path,
        relative: &Path,
        recursive: bool,
    ) -> Result<u64, FsError> {
        let parent = open_parent(root, relative, false)?;
        let file = open_file_optional(&parent.target)?.ok_or_else(|| FsError::NotFound {
            path: parent.target.display().to_string(),
        })?;
        drop(file);
        if recursive {
            return Err(FsError::Io {
                path: parent.target.display().to_string(),
                message: "recursive deletion is not supported by race-safe workspace operations"
                    .into(),
            });
        }
        fs::remove_file(&parent.target).map_err(|error| map_io(&parent.target, error))?;
        Ok(1)
    }

    pub(super) fn move_path(
        root: &Path,
        from_relative: &Path,
        to_relative: &Path,
    ) -> Result<(), FsError> {
        let from = open_parent(root, from_relative, false)?;
        let source = open_file_optional(&from.target)?.ok_or_else(|| FsError::NotFound {
            path: from.target.display().to_string(),
        })?;
        let to = open_parent(root, to_relative, true)?;
        if open_file_optional(&to.target)?.is_some() {
            return Err(FsError::AlreadyExists {
                path: to.target.display().to_string(),
            });
        }
        drop(source);
        fs::rename(&from.target, &to.target).map_err(|error| map_io(&from.target, error))
    }
}

#[cfg(not(any(unix, windows)))]
compile_error!("race-safe workspace filesystem operations require Unix or Windows");

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn reads_replaces_moves_and_deletes_beneath_root() {
        let root = TempDir::new().expect("root");
        let first = Path::new("nested/first.txt");
        let second = Path::new("nested/second.txt");

        let created = atomic_write_beneath(root.path(), first, b"first", WriteIntent::Create, None)
            .expect("create");
        let replaced = atomic_write_beneath(
            root.path(),
            first,
            b"second",
            WriteIntent::Replace,
            Some(&created.post_hash),
        )
        .expect("replace");
        assert_eq!(
            replaced.pre_hash.as_deref(),
            Some(created.post_hash.as_str())
        );
        assert_eq!(
            read_text_beneath(root.path(), first, 1024).unwrap().0,
            "second"
        );

        move_path_beneath(root.path(), first, second).expect("move");
        assert!(!path_exists_beneath(root.path(), first).unwrap());
        assert!(path_exists_beneath(root.path(), second).unwrap());
        delete_path_beneath(root.path(), second, false).expect("delete");
        assert!(!path_exists_beneath(root.path(), second).unwrap());
    }

    #[test]
    fn parent_swap_after_validation_cannot_escape_workspace() {
        let root = TempDir::new().expect("root");
        let outside = TempDir::new().expect("outside");
        let parent = root.path().join("parent");
        std::fs::create_dir(&parent).expect("parent");
        let workspace = cbc_workspace::Workspace::open(root.path()).expect("workspace");
        let resolved = workspace
            .resolve_write("parent/file.txt")
            .expect("validate");

        std::fs::rename(&parent, root.path().join("original-parent")).expect("move parent");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), &parent).expect("swap symlink");
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir(outside.path(), &parent).is_err() {
            // Windows requires Developer Mode or the symlink privilege. CI hosts
            // without either cannot construct the hostile reparse point.
            return;
        }

        let result = atomic_write_beneath(
            workspace.root(),
            Path::new(&resolved.relative),
            b"escape",
            WriteIntent::Create,
            None,
        );
        assert!(result.is_err(), "swapped parent must be rejected");
        assert!(
            !outside.path().join("file.txt").exists(),
            "write escaped the workspace"
        );
    }

    #[test]
    fn exact_range_hashes_the_whole_file_but_retains_only_requested_lines() {
        let root = TempDir::new().expect("root");
        let content = (1..=1_000)
            .map(|line| format!("line {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        let path = root.path().join("large.txt");
        std::fs::write(&path, &content).expect("write fixture");

        let read = read_text_range_beneath(root.path(), Path::new("large.txt"), 401, 3, 1024)
            .expect("exact range");
        assert_eq!(read.text, "line 401\nline 402\nline 403");
        assert_eq!(read.start_line, 401);
        assert_eq!(read.end_line, 403);
        assert_eq!(read.total_lines, Some(1_000));
        assert!(!read.end_of_file);
        assert!(!read.truncated_by_bytes);
        assert_eq!(read.bytes, content.len() as u64);
        assert_eq!(
            read.checksum.as_deref(),
            Some(hash_bytes(content.as_bytes()).as_str())
        );
        assert_eq!(read.revision_token, read.checksum.clone().unwrap());
    }

    #[test]
    fn preview_stops_at_the_requested_range_and_returns_a_revision_token() {
        let root = TempDir::new().expect("root");
        let content = "one\ntwo\nthree\nfour\n";
        std::fs::write(root.path().join("preview.txt"), content).expect("write fixture");

        let read = preview_text_range_beneath(root.path(), Path::new("preview.txt"), 2, 1, 1024)
            .expect("preview range");
        assert_eq!(read.text, "two");
        assert_eq!(read.start_line, 2);
        assert_eq!(read.end_line, 2);
        assert_eq!(read.total_lines, None);
        assert!(!read.end_of_file);
        assert!(read.checksum.is_none());
        assert!(!read.revision_token.is_empty());
        assert!(read.bytes < content.len() as u64);
    }

    #[test]
    fn preview_does_not_validate_bytes_after_the_requested_range() {
        let root = TempDir::new().expect("root");
        std::fs::write(
            root.path().join("preview-invalid.txt"),
            [b'o', b'k', b'\n', 0xff],
        )
        .expect("write fixture");

        let read =
            preview_text_range_beneath(root.path(), Path::new("preview-invalid.txt"), 1, 1, 1024)
                .expect("preview only validates the requested prefix");
        assert_eq!(read.text, "ok");
        assert!(!read.end_of_file);
        assert!(read.checksum.is_none());
    }

    #[test]
    fn exact_range_validates_utf8_after_the_requested_range() {
        let root = TempDir::new().expect("root");
        std::fs::write(root.path().join("invalid.txt"), [b'o', b'k', b'\n', 0xff])
            .expect("write fixture");

        let error = read_text_range_beneath(root.path(), Path::new("invalid.txt"), 1, 1, 1024)
            .expect_err("the complete exact read must validate the complete file");
        assert!(matches!(error, FsError::UnsupportedEncoding { .. }));
    }

    #[test]
    fn range_output_reports_byte_truncation_without_shortening_the_hash_scan() {
        let root = TempDir::new().expect("root");
        let content = "0123456789\nsecond line\n";
        std::fs::write(root.path().join("bounded.txt"), content).expect("write fixture");

        let read = read_text_range_beneath(root.path(), Path::new("bounded.txt"), 1, 2, 5)
            .expect("bounded range");
        assert_eq!(read.text, "01234");
        assert!(read.truncated_by_bytes);
        assert_eq!(read.bytes, content.len() as u64);
        assert_eq!(
            read.checksum.as_deref(),
            Some(hash_bytes(content.as_bytes()).as_str())
        );
    }
}
