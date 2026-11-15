use super::*;

#[test]
fn catalog_defaults_and_fallback_are_platform_specific() {
    let unix = catalog_for_platform(ShellPlatform::Unix, None, |_| true);
    assert_eq!(unix.configured_id, BASH_ID);
    assert_eq!(
        unix.effective.as_ref().map(|option| option.id.as_str()),
        Some(BASH_ID)
    );
    assert!(!unix.fallback);
    assert_eq!(unix.choices.len(), 1);

    let windows = catalog_for_platform(ShellPlatform::Windows, None, |_| true);
    assert_eq!(windows.configured_id, WINDOWS_POWERSHELL_ID);
    assert_eq!(windows.choices.len(), 4);
    assert_eq!(windows.choices[0].label, "Windows PowerShell");
    assert!(windows.choices[0].is_default);
    assert_eq!(windows.choices[1].id, PWSH_ID);
    assert_eq!(windows.choices[1].label, "PowerShell 7");
    assert_eq!(windows.choices[1].dialect, "powershell");
    assert!(!windows.choices[1].is_default);

    // The fallback follows catalog order, so PowerShell 7 — placed directly
    // after the in-box 5.1 entry — is the first available choice once 5.1 is
    // gone. Both entries keep the `powershell` dialect, so the fallback
    // cannot change the command language a pinned turn runs.
    let fallback =
        catalog_for_platform(ShellPlatform::Windows, Some(WINDOWS_POWERSHELL_ID), |id| {
            id != WINDOWS_POWERSHELL_ID
        });
    assert_eq!(
        fallback.effective.as_ref().map(|option| option.id.as_str()),
        Some(PWSH_ID)
    );
    assert!(fallback.fallback);

    // With both PowerShell entries gone, `cmd` comes next in catalog order.
    let cmd_fallback =
        catalog_for_platform(ShellPlatform::Windows, Some(WINDOWS_POWERSHELL_ID), |id| {
            id == CMD_ID || id == GIT_BASH_ID
        });
    assert_eq!(
        cmd_fallback
            .effective
            .as_ref()
            .map(|option| option.id.as_str()),
        Some(CMD_ID)
    );
    assert!(cmd_fallback.fallback);
}

#[test]
fn unknown_configured_id_normalizes_to_platform_default() {
    let catalog =
        catalog_for_platform(ShellPlatform::Unix, Some("C:\\custom\\shell.exe"), |_| true);
    assert_eq!(catalog.configured_id, BASH_ID);
    assert_eq!(
        catalog.effective.as_ref().map(|option| option.id.as_str()),
        Some(BASH_ID)
    );
}

#[test]
fn scratch_dir_uses_posix_separators_only_for_posix_shells() {
    let scratch = PathBuf::from(r"C:\Users\Lan\AppData\Local\PI Desktop\scratch");

    assert_eq!(
        format_scratch_dir_for_shell(Some("posix"), &scratch).to_string_lossy(),
        "C:/Users/Lan/AppData/Local/PI Desktop/scratch"
    );
    assert_eq!(
        format_scratch_dir_for_shell(Some("powershell"), &scratch).to_string_lossy(),
        scratch.to_string_lossy()
    );
    assert_eq!(
        format_scratch_dir_for_shell(Some("cmd"), &scratch).to_string_lossy(),
        scratch.to_string_lossy()
    );
}

#[test]
fn user_login_path_probes_a_real_path() {
    // On any machine with a login shell the probe yields a non-empty
    // PATH of absolute directories; when no shell can be probed the
    // function must degrade to None rather than panic.
    if let Some(path) = user_login_path() {
        assert!(!path.is_empty(), "probed PATH is non-empty");
        assert!(path.starts_with('/'), "PATH entries stay absolute");
        assert!(path.contains('/'), "PATH looks like directories");
    }
}

#[cfg(unix)]
#[test]
fn packaged_runtime_is_prepended_without_losing_the_user_path() {
    let joined = prepend_path(
        Some(OsStr::new("/deckwise/python/bin")),
        Some(OsStr::new("/usr/local/bin:/usr/bin")),
    )
    .unwrap();
    let entries = env::split_paths(OsStr::new(&joined)).collect::<Vec<_>>();
    assert_eq!(entries[0], PathBuf::from("/deckwise/python/bin"));
    assert_eq!(entries[1], PathBuf::from("/usr/local/bin"));
    assert_eq!(entries[2], PathBuf::from("/usr/bin"));
}

#[cfg(unix)]
#[test]
fn non_executable_file_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let plain = dir.path().join("not-a-shell");
    std::fs::write(&plain, "text").unwrap();
    assert!(!is_executable(&plain));
}

#[test]
fn powershell_7_is_a_distinct_selection_with_the_powershell_contract() {
    // The 5.1 and 7 entries stay separately selectable while sharing one
    // dialect and one non-interactive script.
    assert!(is_known_shell_id(PWSH_ID));
    assert_eq!(dialect_for_id(PWSH_ID), Some("powershell"));
    assert_ne!(PWSH_ID, WINDOWS_POWERSHELL_ID);

    let selected = catalog_for_platform(ShellPlatform::Windows, Some(PWSH_ID), |id| {
        id != WINDOWS_POWERSHELL_ID
    });
    assert_eq!(selected.configured_id, PWSH_ID);
    assert!(!selected.fallback);
    assert_eq!(
        selected.effective.as_ref().map(|option| option.id.as_str()),
        Some(PWSH_ID)
    );

    let pwsh = build_invocation_for_platform(
        ShellPlatform::Windows,
        PWSH_ID,
        PathBuf::from("pwsh.exe"),
        "Write-Output 'hello'",
    )
    .unwrap();
    let legacy = build_invocation_for_platform(
        ShellPlatform::Windows,
        WINDOWS_POWERSHELL_ID,
        PathBuf::from("powershell.exe"),
        "Write-Output 'hello'",
    )
    .unwrap();
    assert_eq!(pwsh.args, legacy.args);
    assert_eq!(pwsh.args[7], "-Command");
    assert!(pwsh.args[8].contains("Write-Output 'hello'"));
}

#[test]
fn unavailable_powershell_7_falls_back_and_reports_it() {
    let catalog = catalog_for_platform(ShellPlatform::Windows, Some(PWSH_ID), |id| id != PWSH_ID);
    assert_eq!(catalog.configured_id, PWSH_ID);
    assert_eq!(
        catalog.effective.as_ref().map(|option| option.id.as_str()),
        Some(WINDOWS_POWERSHELL_ID)
    );
    assert!(catalog.fallback);
}

#[cfg(windows)]
#[test]
fn missing_powershell_7_guidance_names_the_searched_locations() {
    // "was not found" alone leaves the user unable to act; the message has
    // to name both probed locations.
    assert!(PWSH_MISSING_GUIDANCE.contains("pwsh.exe"));
    assert!(PWSH_MISSING_GUIDANCE.contains("ProgramFiles"));
    assert!(PWSH_MISSING_GUIDANCE.contains("PATH"));
}

#[cfg(windows)]
#[test]
fn powershell_7_resolves_only_through_its_own_locations() {
    // Guards the resolver contract without depending on whether this
    // machine has PowerShell 7 installed: either it resolves to a real
    // `pwsh.exe`, or it fails with the guidance that names the locations.
    match resolve_shell(PWSH_ID) {
        Ok(resolved) => assert_eq!(
            resolved
                .program
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_ascii_lowercase),
            Some("pwsh.exe".to_string())
        ),
        Err(message) => assert_eq!(message, PWSH_MISSING_GUIDANCE),
    }
}

#[test]
fn invocation_builder_uses_each_dialect_contract() {
    let powershell = build_invocation_for_platform(
        ShellPlatform::Windows,
        WINDOWS_POWERSHELL_ID,
        PathBuf::from("powershell.exe"),
        "Write-Output 'hello'",
    )
    .unwrap();
    assert_eq!(
        powershell.args[..7],
        [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-InputFormat",
            "Text",
            "-OutputFormat",
            "Text"
        ]
    );
    assert_eq!(powershell.args[7], "-Command");
    let script = &powershell.args[8];
    assert!(script.contains("UTF8Encoding"));
    assert!(script.contains("$LASTEXITCODE"));
    assert!(script.contains("Write-Output 'hello'"));
    // Windows behavior is proven by the PowerShell tests in tools::tests;
    // these guard the script where those tests do not run.
    assert!(script.contains("Out-String -Stream"));
    assert!(script.contains("NativeCommandError"));
    assert!(!script.contains("[string]$_"));

    let cmd = build_invocation_for_platform(
        ShellPlatform::Windows,
        CMD_ID,
        PathBuf::from("cmd.exe"),
        "echo hello",
    )
    .unwrap();
    assert_eq!(
        cmd.args,
        [
            "/D",
            "/Q",
            "/V:OFF",
            "/S",
            "/C",
            "chcp 65001>nul && echo hello"
        ]
    );

    let git_bash = build_invocation_for_platform(
        ShellPlatform::Windows,
        GIT_BASH_ID,
        PathBuf::from("bash.exe"),
        "printf hello",
    )
    .unwrap();
    assert_eq!(
        git_bash.args,
        ["--noprofile", "--norc", "-c", "printf hello"]
    );

    let bash = build_invocation_for_platform(
        ShellPlatform::Unix,
        BASH_ID,
        PathBuf::from("/bin/bash"),
        "printf hello",
    )
    .unwrap();
    assert_eq!(bash.args, ["-lc", "printf hello"]);
}

#[test]
fn invocation_builder_rejects_nul_and_long_windows_commands() {
    let nul = build_invocation_for_platform(
        ShellPlatform::Windows,
        CMD_ID,
        PathBuf::from("cmd.exe"),
        "echo\0bad",
    );
    assert!(nul.is_err());

    let long_command = "x".repeat(MAX_WINDOWS_COMMAND_LINE_UNITS);
    let too_long = build_invocation_for_platform(
        ShellPlatform::Windows,
        CMD_ID,
        PathBuf::from("cmd.exe"),
        &long_command,
    );
    assert!(too_long.is_err());
}

// Win32 FILE_ATTRIBUTE_* / IO_REPARSE_TAG_* values used by the PATH
// executable probe. These tests stay platform-agnostic so Linux CI covers
// the Store alias decision that Path::is_file() gets wrong on Windows.
const FILE_ATTRIBUTE_ARCHIVE: u32 = 0x0000_0020;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
const IO_REPARSE_TAG_APPEXECLINK: u32 = 0x8000_001B;

#[test]
fn windows_exe_attrs_accept_store_appexeclink_alias() {
    // Microsoft Store / MSIX app-execution aliases report ARCHIVE|REPARSE_POINT
    // and size 0. CreateFileW returns ERROR_CANT_ACCESS_FILE (1920), so
    // Path::is_file() / metadata reject them even though CreateProcessW
    // launches them. GetFileAttributesExW succeeds with these bits.
    let attrs = FILE_ATTRIBUTE_ARCHIVE | FILE_ATTRIBUTE_REPARSE_POINT;
    assert_eq!(attrs, 0x420);
    assert!(windows_exe_exists_from_win32_attrs(
        Some(attrs),
        Some(IO_REPARSE_TAG_APPEXECLINK),
    ));
}

#[test]
fn windows_exe_attrs_reject_directory() {
    assert!(!windows_exe_exists_from_win32_attrs(
        Some(FILE_ATTRIBUTE_DIRECTORY),
        None,
    ));
}

#[test]
fn windows_exe_attrs_reject_missing_path() {
    assert!(!windows_exe_exists_from_win32_attrs(None, None));
}

#[test]
fn windows_exe_attrs_accept_normal_file() {
    assert!(windows_exe_exists_from_win32_attrs(
        Some(FILE_ATTRIBUTE_ARCHIVE),
        None,
    ));
}
