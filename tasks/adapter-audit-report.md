# Adapter Consistency Audit Report

**Branch:** `feature/session-continuity`
**Date:** 2025-03-05
**Scope:** All 5 adapters + config files + hook scripts

---

## 1. Interface Compliance

All 5 adapters implement every required `HookAdapter` method:
- `parsePreToolUseInput`, `parsePostToolUseInput`, `parsePreCompactInput`, `parseSessionStartInput`
- `formatPreToolUseResponse`, `formatPostToolUseResponse`, `formatPreCompactResponse`, `formatSessionStartResponse`
- `getSettingsPath`, `getSessionDir`, `getSessionDBPath`, `getSessionEventsPath`
- `generateHookConfig`, `readSettings`, `writeSettings`
- `validateHooks`, `checkPluginRegistration`, `getInstalledVersion`
- `configureAllHooks`, `backupSettings`, `setHookPermissions`, `updatePluginRegistry`
- `getRoutingInstructionsConfig`, `writeRoutingInstructions`

**Verdict:** PASS — No missing methods.

---

## 2. Findings

### CRITICAL — VSCode Copilot uses `CLAUDE_PROJECT_DIR` for projectDir

**File:** `src/adapters/vscode-copilot/index.ts` (lines 105, 118, 127, 154)

All 4 parse methods use `process.env.CLAUDE_PROJECT_DIR` for `projectDir`. VS Code Copilot does **not** set this env var. It should use its own detection (e.g., `VSCODE_CWD`, workspace folder, or `process.cwd()` fallback).

**Impact:** `projectDir` will always be `undefined` unless the user also has Claude Code installed and running, which breaks session DB path hashing and event file paths.

**Fix:** Add a `getProjectDir()` helper like Gemini CLI does, checking VS Code-specific env vars with `process.cwd()` fallback.

---

### HIGH — OpenCode `sessionStart: true` contradicts documentation

**File:** `src/adapters/opencode/index.ts` (line 80 capability, line 12 comment, line 333 diagnostics)

The adapter sets `sessionStart: true` in capabilities, but:
- The header comment says "SessionStart: broken (#14808, no hook #5409)"
- `validateHooks()` emits a warning: "SessionStart not supported in OpenCode"
- The README confirms SessionStart is not available

The capability flag claims support, the diagnostics say it doesn't work, and the docs confirm it's broken. The flag should be `false`.

**Impact:** Code that checks `adapter.capabilities.sessionStart` before invoking `parseSessionStartInput` will attempt to use a broken path.

---

### HIGH — Config file line count mismatch (62 vs 58 lines)

**Files:**
- `configs/claude-code/CLAUDE.md` — 62 lines
- All other configs — 58 lines each

Claude Code's CLAUDE.md has 4 extra lines containing `ctx` command handlers (`ctx stats`, `ctx doctor`, `ctx upgrade`). These are **missing from all other configs**. If a Gemini/OpenCode/Codex/VSCode user types "ctx stats", the model won't know to call the stats tool.

**Impact:** Missing diagnostic/upgrade UX on 4 out of 5 platforms.

---

### MEDIUM — Tool name prefix inconsistency across configs (intentional but undocumented)

**Pattern observed:**
| Platform | Tool prefix in config | Example |
|---|---|---|
| Claude Code | `ctx_` (short) | `ctx_batch_execute` |
| VS Code Copilot | `ctx_` (short) | `ctx_batch_execute` |
| Gemini CLI | `mcp__context-mode__ctx_` (full) | `mcp__context-mode__ctx_batch_execute` |
| OpenCode | `mcp__context-mode__ctx_` (full) | `mcp__context-mode__ctx_batch_execute` |
| Codex CLI | `mcp__context-mode__ctx_` (full) | `mcp__context-mode__ctx_batch_execute` |

This split appears intentional — Claude Code and VS Code Copilot use the `mcp__plugin_` prefix format at runtime (set by the platform), so configs use short names. Gemini/OpenCode/Codex use `mcp__context-mode__` as the actual tool name. However, the `routing-block.mjs` (hook runtime) uses `mcp__plugin_context-mode_context-mode__` prefix, which differs from both config styles.

**Recommendation:** Add a comment in each config explaining why the prefix differs. Not a bug, but a source of confusion during maintenance.

---

### MEDIUM — Gemini CLI `formatPostToolUseResponse` uses `decision: "deny"` to modify output

**File:** `src/adapters/gemini-cli/index.ts` (line ~207+)

When the PostToolUse response has `updatedOutput`, Gemini CLI returns `{ decision: "deny", reason: updatedOutput }`. This is a semantic mismatch — it's not denying anything, it's replacing output. This is documented in the header comment as the Gemini CLI way, but it's a fragile pattern that could break if Gemini CLI changes deny semantics.

**Impact:** Low risk now (it works), but semantic drift risk in future Gemini CLI updates.

---

### MEDIUM — OpenCode `getSettingsPath()` uses `resolve("opencode.json")` (relative)

**File:** `src/adapters/opencode/index.ts` (line 199)

Uses `resolve("opencode.json")` which resolves relative to `process.cwd()`. Unlike other adapters that use absolute paths (`~/.claude/settings.json`, `~/.gemini/settings.json`), this depends on the working directory at call time.

**Impact:** If the server process CWD differs from the project root, settings path will be wrong.

---

### LOW — Codex adapter returns `undefined` for all format methods

**File:** `src/adapters/codex/index.ts` (lines 86-99)

All four format methods (`formatPreToolUseResponse`, `formatPostToolUseResponse`, `formatPreCompactResponse`, `formatSessionStartResponse`) return `undefined`. This is correct since Codex has no hook support (`paradigm: "mcp-only"`), but the parse methods also throw errors. Consistent but worth noting.

---

### LOW — Gemini CLI `formatPreToolUseResponse` for "ask" decision falls back to deny

**File:** `src/adapters/gemini-cli/index.ts` (~line 172)

Gemini CLI has no native "ask" permission prompt, so it falls back to `decision: "deny"`. VS Code Copilot does the same (`permissionDecision: "deny"`). Both are documented inline. This is correct behavior but should be tracked — if either platform adds native "ask" support, the adapter should be updated.

---

## 3. Session ID Extraction Summary

| Platform | Priority Chain | Correct? |
|---|---|---|
| Claude Code | `transcript_path` UUID > `session_id` > `CLAUDE_SESSION_ID` env > `ppid` | Yes |
| Gemini CLI | `session_id` > `GEMINI_SESSION_ID` env > `ppid` | Yes |
| VS Code Copilot | `sessionId` (camelCase) > `VSCODE_PID` env > `ppid` | Yes |
| OpenCode | `sessionID` (camelCase) > `ppid` | Yes |
| Codex CLI | Throws (no hooks) | Correct for mcp-only |

---

## 4. Config Files Sync

### Hook config files
- `configs/vscode-copilot/hooks.json` — Valid, matches `generateHookConfig()` output
- `configs/gemini-cli/settings.json` — Valid, hook commands use `context-mode hook gemini-cli <type>`
- `configs/opencode/opencode.json` — Valid, plugin array + MCP entry
- Codex CLI — No hook config (correct, mcp-only)

### Routing instruction files
All 5 configs contain the same routing structure:
- BLOCKED commands section (curl/wget, inline HTTP, WebFetch/direct web fetch)
- REDIRECTED tools section (Bash >20 lines, Read for analysis, Grep large results)
- Tool selection hierarchy (GATHER > FOLLOW-UP > PROCESSING)
- Output constraints

**Differences are intentional and platform-appropriate:**
- Tool name prefixes match each platform's MCP naming convention
- Claude Code has `ctx` command handlers; others don't (see HIGH finding above)
- Block/redirect wording varies slightly (e.g., "WebFetch" vs "Direct web fetching") to match each platform's tool vocabulary

---

## 5. Summary Table

| # | Severity | Issue | File |
|---|---|---|---|
| 1 | **CRITICAL** | VSCode Copilot hardcodes `CLAUDE_PROJECT_DIR` for projectDir | `src/adapters/vscode-copilot/index.ts:105,118,127,154` |
| 2 | **HIGH** | OpenCode `sessionStart: true` but feature is broken | `src/adapters/opencode/index.ts:80` |
| 3 | **HIGH** | `ctx stats/doctor/upgrade` commands missing from 4 configs | `configs/{gemini,codex,opencode,vscode-copilot}/*` |
| 4 | MEDIUM | Tool prefix inconsistency undocumented | All config files |
| 5 | MEDIUM | Gemini PostToolUse uses "deny" to modify output | `src/adapters/gemini-cli/index.ts:~207` |
| 6 | MEDIUM | OpenCode `getSettingsPath()` uses relative path | `src/adapters/opencode/index.ts:199` |
| 7 | LOW | Codex format methods all return undefined (correct) | `src/adapters/codex/index.ts:86-99` |
| 8 | LOW | "ask" fallback to deny on Gemini/VSCode (correct) | Multiple |
