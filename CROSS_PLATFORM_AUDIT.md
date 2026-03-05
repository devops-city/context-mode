# Cross-Platform Compatibility Audit

**Date**: 2026-03-05
**Branch**: feature/session-continuity
**Scope**: All source files in `src/`, `hooks/`

---

## CRITICAL — Will break on a specific OS

### 1. `sessionstart.mjs:24` — `.pathname` on `new URL()` breaks on Windows

```js
const HOOK_DIR = new URL(".", import.meta.url).pathname;
```

On Windows, `new URL(".", import.meta.url).pathname` returns `/C:/Users/...` (with a leading slash), which is not a valid Windows path. Every other hook file (posttooluse.mjs:17, precompact.mjs:17, pretooluse.mjs:15) correctly uses `dirname(fileURLToPath(import.meta.url))`. This hook does not.

**Impact**: `sessionstart.mjs` will fail to resolve `PKG_SESSION` on Windows, breaking session continuity startup/compact injection entirely.

---

### 2. `cli.ts:462` — `2>/dev/null` POSIX redirect in `execSync` without shell

```js
execSync(`npm install -g "${pluginRoot}" --no-audit --no-fund 2>/dev/null`, {
  stdio: "pipe",
  timeout: 30000,
});
```

`2>/dev/null` is a POSIX shell redirect. Node's `execSync` uses `cmd.exe` on Windows by default, where this syntax is invalid (Windows uses `2>NUL`). Since `stdio: "pipe"` is set, stderr is already captured and discarded, making the redirect redundant but still causing a parse error on Windows `cmd.exe`.

**Impact**: The `upgrade` command will fail on Windows.

---

## HIGH — Likely to cause issues

### 3. `adapters/claude-code/index.ts:557`, `adapters/vscode-copilot/index.ts:564`, `adapters/gemini-cli/index.ts:508` — `chmodSync(path, 0o755)` is a no-op on Windows

```js
chmodSync(scriptPath, 0o755);
```

Windows does not support Unix file permissions. `chmodSync` silently does nothing on Windows. The hook scripts will not be marked executable. This matters if Git Bash or WSL expects the execute bit.

**Impact**: Hook scripts may not execute on Windows via Git Bash if the filesystem doesn't already have execute permission.

---

### 4. `executor.ts:154` — `writeFileSync` with `mode: 0o700` is ineffective on Windows

```js
writeFileSync(fp, code, { encoding: "utf-8", mode: 0o700 });
```

Same as above — Unix file mode flags are ignored on Windows NTFS. Shell scripts written to temp dirs may lack execute permission under strict WSL/Git Bash configurations.

---

### 5. `executor.ts:395` — PATH fallback uses POSIX colon separator

```js
PATH: process.env.PATH ?? (isWin ? "" : "/usr/local/bin:/usr/bin:/bin"),
```

The Windows fallback is an empty string (`""`), meaning if `process.env.PATH` is undefined on Windows, no executables will be found. The POSIX fallback uses `:` separator correctly for Unix. However, `process.env.PATH` being undefined on Windows would be extremely unusual.

**Impact**: Edge case — if MCP server starts with a stripped environment on Windows, all subprocess executions fail silently.

---

### 6. `runtime.ts:90` — `getVersion` splits on `\n` only, not `\r\n`

```js
.split("\n")[0];
```

On Windows, `execSync` output may include `\r\n` line endings. Splitting on `\n` alone leaves a trailing `\r` in the version string (e.g., `"node v20.0.0\r"`). Compare with line 70 which correctly uses `.split(/\r?\n/)`.

**Impact**: Version strings displayed in `doctor` output will have trailing `\r` on Windows, causing cosmetic issues and potential string comparison failures.

---

### 7. `server.ts:53,1482` — Hardcoded `.claude` config directory path

```js
const sessionsDir = join(homedir(), ".claude", "context-mode", "sessions");
const sessionDbPath = join(homedir(), ".claude", "context-mode", "sessions", `${dbHash}.db`);
```

This uses `homedir()` (correct, cross-platform) but assumes the `.claude` directory structure. On Windows, hidden directories starting with `.` are unconventional and may conflict with antivirus/indexing. However, this mirrors Claude Code's own convention so it's consistent.

**Impact**: Not a bug per se, but Windows users may need to manually unhide the directory.

---

## MEDIUM — Edge case concerns

### 8. `executor.ts:438-443` — Linux-only SSL cert path scanning, no macOS coverage

```js
const certPaths = isWin ? [] : [
  "/etc/ssl/certs/ca-certificates.crt",         // Debian/Ubuntu/Alpine
  "/etc/pki/tls/certs/ca-bundle.crt",           // RHEL/CentOS/Fedora
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem", // Fedora alt
];
```

macOS uses `/etc/ssl/cert.pem` or the Keychain system, neither of which is listed. The cert paths only cover Linux distributions. On macOS, `SSL_CERT_FILE` will never be set by this code, potentially causing TLS failures in sandboxed subprocesses that don't inherit the system cert store.

**Impact**: Sandboxed HTTP calls (e.g., `curl` in `execute`) on macOS may fail with TLS errors if the subprocess doesn't inherit the system cert bundle.

---

### 9. `executor.ts:421-424` — Hardcoded `C:\Program Files\Git\usr\bin` path

```js
const gitUsrBin = "C:\\Program Files\\Git\\usr\\bin";
const gitBin = "C:\\Program Files\\Git\\bin";
```

Git may be installed in a non-default location (e.g., `D:\Git`, scoop, chocolatey installs to `C:\ProgramData\chocolatey\lib\git`). The hardcoded path only covers the default installer location.

**Impact**: Windows users with non-default Git installations will not get Git unix tools on PATH in sandboxed subprocesses.

---

### 10. `runtime.ts:59-61` — Hardcoded Windows Git Bash paths

```js
const knownPaths = [
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
];
```

Same issue as #9 — only default installation paths are checked. The `where bash` fallback (line 69) mitigates this but may not work in restricted MCP server environments.

---

### 11. `hooks/session-helpers.mjs:83,96,109` — Hardcoded `.claude` config dir for Claude, `.gemini`, `.vscode` for others

```js
const dir = join(homedir(), opts.configDir, "context-mode", "sessions");
```

Uses `homedir()` correctly. The concern is that `homedir()` on Windows returns `C:\Users\<name>`, and dot-prefixed directories are unconventional. This is consistent with each platform's conventions though.

---

### 12. `executor.ts` — `LANG: "en_US.UTF-8"` forced in sandbox env

```js
LANG: "en_US.UTF-8",
```

This locale may not be installed on all Linux systems (especially minimal Docker containers). Non-English locale systems would have their locale overridden. On Windows, this env var is typically ignored.

**Impact**: Potential encoding issues in sandboxed subprocesses on minimal Linux containers.

---

## LOW — Style/best practice

### 13. `executor.ts:69` — `process.kill(pid, "SIGTERM")` on Windows backgrounded processes

```js
process.kill(pid, "SIGTERM");
```

`SIGTERM` is emulated on Windows but does not reliably kill process trees. The `killTree` function (line 18) correctly uses `taskkill /F /T` for Windows, but the background process cleanup at line 69 does not use `killTree`.

---

### 14. `hooks/*.mjs` — All hooks use `#!/usr/bin/env node` shebang

```
#!/usr/bin/env node
```

This is cross-platform best practice. No issue, but noted for completeness that Windows ignores shebangs entirely and relies on file associations.

---

### 15. `store.ts:765`, `server.ts:931` and throughout — `\n` joins for internal data

```js
const joined = currentContent.join("\n").trim();
```

These are internal data processing joins (SQLite content, search results). Using `\n` is correct here as the data is consumed programmatically, not written to files for external tools.

---

### 16. `executor.ts` — `DYLD_LIBRARY_PATH` passthrough only relevant on macOS

```js
"DYLD_LIBRARY_PATH",
```

This env var is macOS-specific (dynamic library path). Harmless on other platforms but adds noise. Paired with `LD_LIBRARY_PATH` for Linux.

---

## Summary

| Severity | Count | Key Files |
|----------|-------|-----------|
| CRITICAL | 2 | `sessionstart.mjs:24`, `cli.ts:462` |
| HIGH | 5 | adapters `chmodSync`, `executor.ts:154,395`, `runtime.ts:90`, `server.ts:53` |
| MEDIUM | 5 | `executor.ts:421,438`, `runtime.ts:59`, `session-helpers.mjs`, `executor.ts LANG` |
| LOW | 4 | `executor.ts:69`, hooks shebangs, store joins, env passthrough |

**Overall assessment**: The codebase shows significant Windows awareness (`isWin` checks, `taskkill`, MSYS2 handling, `USERPROFILE` fallback, Git Bash resolution). Two critical bugs remain: the `.pathname` usage in `sessionstart.mjs` and the `2>/dev/null` in `cli.ts`. The adapter `chmodSync` calls are harmless no-ops on Windows but may cause issues in edge cases.
