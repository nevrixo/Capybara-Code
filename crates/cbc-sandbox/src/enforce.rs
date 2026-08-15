//! Real sandbox enforcement — PRD §14.4, §24.5, RT-006, P0-04.
//!
//! `crate::detect` reports capabilities; this module *applies* them. The two are
//! kept in the same crate so the report and the enforcement cannot drift: a
//! backend appears in `SandboxCapabilities::backends` only when the probe in this
//! module says the backend can actually be applied on this host (§24.5).
//!
//! Linux is the enforced tier: Landlock for the filesystem allowlist, a new
//! network namespace for `network = deny`. On other platforms every enforcement
//! entry point reports unavailability, and the caller is expected to refuse the
//! spawn rather than run unenforced — "cannot enforce" must never silently
//! become "runs anyway" (P0-04).
//!
//! The `apply_*` functions are `unsafe` because they are designed to run inside
//! a forked child between `fork` and `exec` (a `CommandExt::pre_exec` closure):
//! single-threaded, async-signal-safe calls only, no allocation on the error
//! path. They are equally valid when called from a single-threaded test process.

use std::sync::OnceLock;

/// Test hooks. The probes consult these so a regression test can prove the
/// fail-closed path (spawn refused) on a host where the backend exists. They
/// are never consulted by production configuration.
const DISABLE_NETNS_ENV: &str = "CBC_TEST_DISABLE_NETNS";
const DISABLE_SECCOMP_ENV: &str = "CBC_TEST_DISABLE_SECCOMP";
const DISABLE_LANDLOCK_ENV: &str = "CBC_TEST_DISABLE_LANDLOCK";

#[cfg(target_os = "linux")]
mod linux {
    pub const SYS_LANDLOCK_CREATE_RULESET: libc::c_long = 444;
    pub const SYS_LANDLOCK_ADD_RULE: libc::c_long = 445;
    pub const SYS_LANDLOCK_RESTRICT_SELF: libc::c_long = 446;

    /// Probe flag: return the supported ABI version instead of a ruleset fd.
    pub const LANDLOCK_CREATE_RULESET_VERSION: u32 = 1 << 0;

    /// Landlock ABI v1 filesystem access rights.
    pub const FS_EXECUTE: u64 = 1 << 0;
    pub const FS_WRITE_FILE: u64 = 1 << 1;
    pub const FS_READ_FILE: u64 = 1 << 2;
    pub const FS_READ_DIR: u64 = 1 << 3;
    pub const FS_REMOVE_DIR: u64 = 1 << 4;
    pub const FS_REMOVE_FILE: u64 = 1 << 5;
    pub const FS_MAKE_CHAR: u64 = 1 << 6;
    pub const FS_MAKE_DIR: u64 = 1 << 7;
    pub const FS_MAKE_REG: u64 = 1 << 8;
    pub const FS_MAKE_SOCK: u64 = 1 << 9;
    pub const FS_MAKE_FIFO: u64 = 1 << 10;
    pub const FS_MAKE_BLOCK: u64 = 1 << 11;
    pub const FS_MAKE_SYM: u64 = 1 << 12;
    /// ABI v2 and v3 rights. Omitting either leaves rename/truncate outside
    /// the handled set and therefore outside the sandbox policy.
    pub const FS_REFER: u64 = 1 << 13;
    pub const FS_TRUNCATE: u64 = 1 << 14;

    pub const FS_READ: u64 = FS_EXECUTE | FS_READ_FILE | FS_READ_DIR;
    pub const FS_ALL_V1: u64 = FS_EXECUTE
        | FS_WRITE_FILE
        | FS_READ_FILE
        | FS_READ_DIR
        | FS_REMOVE_DIR
        | FS_REMOVE_FILE
        | FS_MAKE_CHAR
        | FS_MAKE_DIR
        | FS_MAKE_REG
        | FS_MAKE_SOCK
        | FS_MAKE_FIFO
        | FS_MAKE_BLOCK
        | FS_MAKE_SYM;
    pub const FS_ALL_CURRENT: u64 = FS_ALL_V1 | FS_REFER | FS_TRUNCATE;

    pub fn handled_access_for_abi(abi: u32) -> u64 {
        let mut access = FS_ALL_V1;
        if abi >= 2 {
            access |= FS_REFER;
        }
        if abi >= 3 {
            access |= FS_TRUNCATE;
        }
        access
    }

    /// Access rights that apply to a non-directory path. Landlock rejects a
    /// rule that names directory-only rights (READ_DIR, MAKE_*, REMOVE_DIR)
    /// for a file, so file roots are masked down to these.
    pub const FS_FILE_ONLY: u64 = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE;

    pub const LANDLOCK_RULE_PATH_BENEATH: u32 = 1;

    #[repr(C)]
    pub struct LandlockRulesetAttr {
        pub handled_access_fs: u64,
    }

    #[repr(C)]
    pub struct LandlockPathBeneathAttr {
        pub allowed_access: u64,
        pub parent_fd: i32,
    }
}

/// The mechanism that enforces `network = deny` on this host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkDenyBackend {
    /// `unshare(CLONE_NEWNET)` works directly (root or CAP_SYS_ADMIN): the
    /// child runs in an empty network namespace.
    Netns,
    /// No privileged netns, but a seccomp-BPF filter can refuse the creation
    /// of IPv4/IPv6 sockets. The unprivileged userns route is deliberately not
    /// used: an unmapped user namespace loses the uid that owns the workspace,
    /// and the uid map may only be written by a process in the *parent*
    /// namespace — which a fork+exec spawn cannot arrange from inside the
    /// child.
    Seccomp,
    /// Neither works; `network = deny` cannot be honoured and must refuse.
    Unavailable,
}

/// Probe result for the host's enforcement backends.
#[derive(Debug, Clone)]
pub struct EnforcementProbe {
    pub network: NetworkDenyBackend,
    /// Landlock ABI version, or `None` when the syscall is unavailable.
    pub landlock_abi: Option<u32>,
}

static PROBE: OnceLock<EnforcementProbe> = OnceLock::new();

/// Probe the host once and cache the verdict.
///
/// The network probe forks a child that exercises the real mechanism and
/// exits with the outcome; the child never allocates and never touches stdio,
/// so forking from a multithreaded process is safe here.
pub fn probe() -> &'static EnforcementProbe {
    PROBE.get_or_init(|| EnforcementProbe {
        network: probe_network_backend(),
        landlock_abi: probe_landlock_abi(),
    })
}

/// True when `network = deny` can actually be enforced on this host.
///
/// The probe result is cached; the test-disable overrides are consulted live
/// so a regression test can force the fail-closed path without a race on the
/// cache.
pub fn network_deny_available() -> bool {
    network_deny_backend() != NetworkDenyBackend::Unavailable
}

/// The backend that will enforce `network = deny`, honouring test overrides.
pub fn network_deny_backend() -> NetworkDenyBackend {
    let probe = probe();
    match probe.network {
        NetworkDenyBackend::Netns => {
            if std::env::var_os(DISABLE_NETNS_ENV).is_some() {
                NetworkDenyBackend::Unavailable
            } else {
                NetworkDenyBackend::Netns
            }
        }
        NetworkDenyBackend::Seccomp => {
            if std::env::var_os(DISABLE_SECCOMP_ENV).is_some() {
                NetworkDenyBackend::Unavailable
            } else {
                NetworkDenyBackend::Seccomp
            }
        }
        NetworkDenyBackend::Unavailable => NetworkDenyBackend::Unavailable,
    }
}

/// True when a filesystem allowlist can actually be enforced on this host.
pub fn filesystem_isolation_available() -> bool {
    if std::env::var_os(DISABLE_LANDLOCK_ENV).is_some() {
        return false;
    }
    probe().landlock_abi.is_some()
}

/// Backends this build genuinely applies at launch, for §24.5's capability
/// report. Detected-but-unapplied mechanisms (cgroups, seatbelt presence) are
/// not listed.
pub fn applied_backend_labels() -> Vec<String> {
    // The vector is mutated only by platform-specific branches; on Windows every
    // mutation is compiled out, so keep the allowance local to this truthful probe.
    #[allow(unused_mut)]
    let mut out = Vec::new();
    #[cfg(target_os = "linux")]
    {
        if filesystem_isolation_available() {
            out.push("landlock".to_string());
        }
        match network_deny_backend() {
            NetworkDenyBackend::Netns => out.push("network-namespace".to_string()),
            NetworkDenyBackend::Seccomp => out.push("seccomp".to_string()),
            NetworkDenyBackend::Unavailable => {}
        }
        out.push("rlimit".to_string());
    }
    #[cfg(not(target_os = "linux"))]
    {
        // rlimits are applied on every unix spawn; Windows applies none yet.
        #[cfg(unix)]
        out.push("rlimit".to_string());
    }
    out
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn probe_landlock_abi() -> Option<u32> {
    if std::env::var_os(DISABLE_LANDLOCK_ENV).is_some() {
        return None;
    }
    let abi = unsafe {
        libc::syscall(
            linux::SYS_LANDLOCK_CREATE_RULESET,
            std::ptr::null_mut::<linux::LandlockRulesetAttr>(),
            0usize,
            linux::LANDLOCK_CREATE_RULESET_VERSION,
        )
    };
    if abi < 0 {
        None
    } else {
        Some(abi as u32)
    }
}

#[cfg(not(target_os = "linux"))]
fn probe_landlock_abi() -> Option<u32> {
    None
}

#[cfg(target_os = "linux")]
fn probe_network_backend() -> NetworkDenyBackend {
    // Privileged netns: `unshare(CLONE_NEWNET)` alone, no user namespace.
    if std::env::var_os(DISABLE_NETNS_ENV).is_none() && unshare_probe(0) {
        return NetworkDenyBackend::Netns;
    }
    // Unprivileged fallback: seccomp-BPF. Probed by installing a trivial
    // allow-all filter in a forked child — the exact mechanism enforcement
    // will use, minus the rules.
    if std::env::var_os(DISABLE_SECCOMP_ENV).is_none() && seccomp_probe() {
        return NetworkDenyBackend::Seccomp;
    }
    NetworkDenyBackend::Unavailable
}

#[cfg(not(target_os = "linux"))]
fn probe_network_backend() -> NetworkDenyBackend {
    NetworkDenyBackend::Unavailable
}

/// Fork a child that tries `unshare(CLONE_NEWNET | extra)` and reports via its
/// exit status. The child only makes syscalls; no libc bookkeeping, no stdio.
#[cfg(target_os = "linux")]
fn unshare_probe(extra_flags: libc::c_int) -> bool {
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return false;
    }
    if pid == 0 {
        // Child: single-threaded copy of the process. Async-signal-safe only.
        let rc = unsafe { libc::unshare(libc::CLONE_NEWNET | extra_flags) };
        unsafe { libc::_exit(if rc == 0 { 0 } else { 1 }) };
    }
    wait_child_ok(pid)
}

/// Fork a child that installs a trivial seccomp filter and reports success.
#[cfg(target_os = "linux")]
fn seccomp_probe() -> bool {
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return false;
    }
    if pid == 0 {
        let rc = unsafe { install_seccomp_filter(&seccomp::allow_all_program()) };
        unsafe { libc::_exit(if rc.is_ok() { 0 } else { 1 }) };
    }
    wait_child_ok(pid)
}

#[cfg(target_os = "linux")]
fn wait_child_ok(pid: libc::pid_t) -> bool {
    let mut status: libc::c_int = 0;
    unsafe {
        libc::waitpid(pid, &mut status, 0);
    }
    status == 0
}

// ---------------------------------------------------------------------------
// seccomp-BPF network filter
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod seccomp {
    //! Classic-BPF programs installed with `SECCOMP_SET_MODE_FILTER`.
    //!
    //! The filter is deliberately small and explicit: it inspects the audit
    //! arch first (so an alternate ABI cannot smuggle syscalls past the
    //! number checks), then refuses the creation of IPv4/IPv6 sockets and the
    //! setup of io_uring — the kernel surfaces that can open network paths.
    //! AF_UNIX stays allowed because local tools legitimately use it.

    pub const BPF_LD: u16 = 0x00;
    pub const BPF_JMP: u16 = 0x05;
    pub const BPF_RET: u16 = 0x06;
    pub const BPF_W: u16 = 0x00;
    pub const BPF_ABS: u16 = 0x20;
    pub const BPF_JEQ: u16 = 0x10;
    pub const BPF_JSET: u16 = 0x40;
    pub const BPF_K: u16 = 0x00;

    pub const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
    pub const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
    pub const RET_ERRNO_EACCES: u32 = SECCOMP_RET_ERRNO | 13;

    /// Offsets inside `struct seccomp_data`.
    pub const OFFSET_NR: u32 = 0;
    pub const OFFSET_ARCH: u32 = 4;
    pub const OFFSET_ARG0: u32 = 16;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct SockFilterInsn {
        pub code: u16,
        pub jt: u8,
        pub jf: u8,
        pub k: u32,
    }

    #[repr(C)]
    pub struct SockFprog {
        pub len: u16,
        pub filter: *const SockFilterInsn,
    }

    pub fn insn(code: u16, jt: u8, jf: u8, k: u32) -> SockFilterInsn {
        SockFilterInsn { code, jt, jf, k }
    }

    /// Probe program: allow everything.
    pub fn allow_all_program() -> Vec<SockFilterInsn> {
        vec![insn(BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW)]
    }

    /// The network-deny program for this architecture, or `None` when the
    /// architecture has no audited ABI constants here.
    pub fn network_deny_program() -> Option<Vec<SockFilterInsn>> {
        #[cfg(target_arch = "x86_64")]
        {
            const AUDIT_ARCH_X86_64: u32 = 0xc000_003e;
            const SYS_SOCKET: u32 = 41;
            const SYS_SOCKETPAIR: u32 = 53;
            const SYS_IO_URING_SETUP: u32 = 425;
            return Some(build(
                AUDIT_ARCH_X86_64,
                SYS_SOCKET,
                SYS_SOCKETPAIR,
                SYS_IO_URING_SETUP,
                1 << 30,
            ));
        }
        #[cfg(target_arch = "aarch64")]
        {
            const AUDIT_ARCH_AARCH64: u32 = 0xc000_00b7;
            const SYS_SOCKET: u32 = 198;
            const SYS_SOCKETPAIR: u32 = 199;
            const SYS_IO_URING_SETUP: u32 = 425;
            return Some(build(
                AUDIT_ARCH_AARCH64,
                SYS_SOCKET,
                SYS_SOCKETPAIR,
                SYS_IO_URING_SETUP,
                0,
            ));
        }
        #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
        {
            None
        }
    }

    /// Build the filter. BPF jump offsets are relative to the *next*
    /// instruction, so every target below is spelled out against this layout:
    /// ```text
    ///  [0]  load arch
    ///  [1]  arch == expected ? next : reject          (jf -> [11])
    ///  [2]  load syscall nr
    ///  [3]  nr == socket        ? family check : next (jt -> [7])
    ///  [4]  nr == socketpair    ? family check : next (jt -> [7])
    ///  [5]  nr == io_uring_setup? reject : next       (jt -> [11])
    ///  [6]  allow
    ///  [7]  load arg0 (address family)
    ///  [8]  family == AF_INET   ? reject : next       (jt -> [11])
    ///  [9]  family == AF_INET6  ? reject : allow      (jt -> [11], jf -> [10])
    ///  [10] allow
    ///  [11] reject with EACCES
    /// ```
    fn build(
        audit_arch: u32,
        sys_socket: u32,
        sys_socketpair: u32,
        sys_io_uring: u32,
        alternate_abi_bit: u32,
    ) -> Vec<SockFilterInsn> {
        const AF_INET: u32 = 2;
        const AF_INET6: u32 = 10;
        vec![
            // [0] A = arch
            insn(BPF_LD | BPF_W | BPF_ABS, 0, 0, OFFSET_ARCH),
            // [1] wrong arch (e.g. x32 ABI smuggling) is rejected outright
            insn(BPF_JMP | BPF_JEQ | BPF_K, 0, 10, audit_arch),
            // [2] A = syscall nr
            insn(BPF_LD | BPF_W | BPF_ABS, 0, 0, OFFSET_NR),
            // x32 shares AUDIT_ARCH_X86_64; bit 30 distinguishes its syscall IDs.
            // On architectures without an alternate ABI the mask is zero.
            insn(BPF_JMP | BPF_JSET | BPF_K, 8, 0, alternate_abi_bit),
            // [3] socket -> family check
            insn(BPF_JMP | BPF_JEQ | BPF_K, 3, 0, sys_socket),
            // [4] socketpair -> family check
            insn(BPF_JMP | BPF_JEQ | BPF_K, 2, 0, sys_socketpair),
            // [5] io_uring_setup -> reject
            insn(BPF_JMP | BPF_JEQ | BPF_K, 5, 0, sys_io_uring),
            // [6] everything else is allowed
            insn(BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW),
            // [7] family check: A = arg0
            insn(BPF_LD | BPF_W | BPF_ABS, 0, 0, OFFSET_ARG0),
            // [8] AF_INET -> reject
            insn(BPF_JMP | BPF_JEQ | BPF_K, 2, 0, AF_INET),
            // [9] AF_INET6 -> reject, else allow
            insn(BPF_JMP | BPF_JEQ | BPF_K, 1, 0, AF_INET6),
            // [10] allow
            insn(BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW),
            // [11] deny — never a silent allow
            insn(BPF_RET | BPF_K, 0, 0, RET_ERRNO_EACCES),
        ]
    }
}

/// Install a classic-BPF seccomp filter on the current process.
///
/// # Safety
/// Must run in a forked child before `exec`, or in a single-threaded process.
#[cfg(target_os = "linux")]
unsafe fn install_seccomp_filter(program: &[seccomp::SockFilterInsn]) -> std::io::Result<()> {
    // A filter is only honoured for a process that can never regain privileges.
    if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == -1 {
        return Err(step_error("prctl(PR_SET_NO_NEW_PRIVS)"));
    }
    let prog = seccomp::SockFprog {
        len: program.len() as u16,
        filter: program.as_ptr(),
    };
    const SECCOMP_SET_MODE_FILTER: libc::c_uint = 1;
    let rc = libc::syscall(
        libc::SYS_seccomp,
        SECCOMP_SET_MODE_FILTER,
        0u32,
        &prog as *const seccomp::SockFprog,
    );
    if rc < 0 {
        return Err(step_error("seccomp(SET_MODE_FILTER)"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Enforcement (forked-child context)
// ---------------------------------------------------------------------------

/// Isolate the current process from the network.
///
/// # Safety
/// Must run in a forked child before `exec`, or in a single-threaded process.
#[cfg(target_os = "linux")]
pub unsafe fn apply_network_deny() -> std::io::Result<()> {
    match network_deny_backend() {
        NetworkDenyBackend::Netns => {
            if libc::unshare(libc::CLONE_NEWNET) == -1 {
                return Err(step_error("unshare(CLONE_NEWNET)"));
            }
            Ok(())
        }
        NetworkDenyBackend::Seccomp => {
            let program = seccomp::network_deny_program().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::Unsupported,
                    "no seccomp network filter exists for this architecture",
                )
            })?;
            install_seccomp_filter(&program)
        }
        NetworkDenyBackend::Unavailable => Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "network deny is unavailable on this host",
        )),
    }
}

/// Last OS error annotated with the enforcement step that hit it, so a spawn
/// refusal explains itself instead of showing a bare errno.
#[cfg(target_os = "linux")]
fn step_error(step: &str) -> std::io::Error {
    let raw = std::io::Error::last_os_error();
    std::io::Error::new(raw.kind(), format!("{step}: {raw}"))
}

#[cfg(target_os = "linux")]
unsafe fn open_c(path: &str, flags: libc::c_int) -> std::io::Result<libc::c_int> {
    let c_path = std::ffi::CString::new(path).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "sandbox path contains NUL",
        )
    })?;
    let fd = libc::open(c_path.as_ptr(), flags);
    if fd < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(fd)
    }
}

#[cfg(target_os = "linux")]
fn is_dir_mode(mode: libc::mode_t) -> bool {
    (mode & libc::S_IFMT) == libc::S_IFDIR
}

#[cfg(not(target_os = "linux"))]
pub unsafe fn apply_network_deny() -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "network deny is not enforced on this platform",
    ))
}

/// One Landlock path rule: everything beneath `path` gains `access`.
#[derive(Debug, Clone)]
pub struct FsRule {
    pub path: String,
    /// Missing this rule must abort the spawn (used for writable workspace roots).
    pub required: bool,
    pub access: u64,
}

/// Read+execute access: run binaries and load libraries, nothing else.
#[cfg(target_os = "linux")]
pub const FS_READ_ACCESS: u64 = linux::FS_READ;
/// Everything Landlock ABI v1 can express — the grant for writable roots.
#[cfg(target_os = "linux")]
pub const FS_FULL_ACCESS: u64 = linux::FS_ALL_CURRENT;

#[cfg(not(target_os = "linux"))]
pub const FS_READ_ACCESS: u64 = 0;
#[cfg(not(target_os = "linux"))]
pub const FS_FULL_ACCESS: u64 = 0;

/// Restrict the current process's filesystem access to the given rules.
///
/// Paths that do not exist are skipped: a rule for `/lib64` must not fail a
/// spawn on a distribution that has no `/lib64`. After this call returns, any
/// open outside the listed roots fails with EACCES.
///
/// # Safety
/// Must run in a forked child before `exec`, or in a single-threaded process.
#[cfg(target_os = "linux")]
pub unsafe fn apply_landlock(rules: &[FsRule]) -> std::io::Result<()> {
    let Some(abi) = probe().landlock_abi else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "landlock is unavailable on this host",
        ));
    };

    let attr = linux::LandlockRulesetAttr {
        handled_access_fs: linux::handled_access_for_abi(abi),
    };
    let ruleset_fd = libc::syscall(
        linux::SYS_LANDLOCK_CREATE_RULESET,
        &attr as *const linux::LandlockRulesetAttr,
        std::mem::size_of::<linux::LandlockRulesetAttr>(),
        0u32,
    );
    if ruleset_fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let ruleset_fd = ruleset_fd as libc::c_int;

    for rule in rules {
        let fd = match open_c(&rule.path, libc::O_PATH | libc::O_CLOEXEC) {
            Ok(fd) => fd,
            Err(error) if !rule.required && error.kind() == std::io::ErrorKind::NotFound => {
                // Missing path: skip (see doc comment). A permission error here is
                // equally uninteresting — the rule simply grants nothing.
                continue;
            }
            Err(error) => {
                libc::close(ruleset_fd);
                return Err(std::io::Error::new(
                    error.kind(),
                    format!(
                        "cannot open required Landlock root '{}': {error}",
                        rule.path
                    ),
                ));
            }
        };

        // Landlock rejects a rule whose access bits do not fit the root's
        // type: directory-only rights on a file are EINVAL. Narrow file roots
        // to the file-applicable set before adding.
        let mut access = rule.access & linux::handled_access_for_abi(abi);
        let mut stat: libc::stat = std::mem::zeroed();
        if libc::fstat(fd, &mut stat) == 0 && !is_dir_mode(stat.st_mode) {
            access &= linux::FS_FILE_ONLY;
        }
        if access == 0 {
            libc::close(fd);
            continue;
        }

        let beneath = linux::LandlockPathBeneathAttr {
            allowed_access: access,
            parent_fd: fd,
        };
        let rc = libc::syscall(
            linux::SYS_LANDLOCK_ADD_RULE,
            ruleset_fd,
            linux::LANDLOCK_RULE_PATH_BENEATH,
            &beneath as *const linux::LandlockPathBeneathAttr,
            0u32,
        );
        libc::close(fd);
        if rc < 0 {
            let err = std::io::Error::last_os_error();
            libc::close(ruleset_fd);
            return Err(err);
        }
    }

    // Landlock only applies to a process that can never gain privileges again.
    if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == -1 {
        let err = std::io::Error::last_os_error();
        libc::close(ruleset_fd);
        return Err(err);
    }
    if libc::syscall(linux::SYS_LANDLOCK_RESTRICT_SELF, ruleset_fd, 0u32) < 0 {
        let err = std::io::Error::last_os_error();
        libc::close(ruleset_fd);
        return Err(err);
    }
    libc::close(ruleset_fd);
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub unsafe fn apply_landlock(_rules: &[FsRule]) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "filesystem isolation is not enforced on this platform",
    ))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn probes_report_a_consistent_verdict() {
        let probe = probe();
        // Whatever the host supports, the availability helpers must agree.
        assert_eq!(
            network_deny_available(),
            probe.network != NetworkDenyBackend::Unavailable
        );
        assert_eq!(
            filesystem_isolation_available(),
            probe.landlock_abi.is_some()
        );
    }

    #[test]
    fn applied_backends_never_overclaim() {
        let labels = applied_backend_labels();
        let probe = probe();
        if probe.landlock_abi.is_none() {
            assert!(!labels.contains(&"landlock".to_string()));
        }
        match probe.network {
            NetworkDenyBackend::Netns => {
                assert!(labels.contains(&"network-namespace".to_string()));
            }
            NetworkDenyBackend::Seccomp => {
                assert!(labels.contains(&"seccomp".to_string()));
                assert!(!labels.contains(&"network-namespace".to_string()));
            }
            NetworkDenyBackend::Unavailable => {
                assert!(!labels.contains(&"network-namespace".to_string()));
                assert!(!labels.contains(&"seccomp".to_string()));
            }
        }
    }

    #[test]
    fn network_deny_filter_is_built_for_this_arch() {
        // The enforcement path refuses an architecture with no filter; this
        // host is one of the supported ones, so the program must exist and be
        // non-trivial (it ends in a deny or an allow, never empty).
        let program = seccomp::network_deny_program();
        assert!(program.is_some(), "expected a filter for this architecture");
        assert!(program.unwrap().len() > 4);
    }
}
