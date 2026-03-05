# Architectural Review: context-mode v1.0.0 Release Readiness

**Reviewer**: Software Architect
**Date**: 2026-03-05
**Scope**: Production readiness, error handling, security, data integrity

---

## CRITICAL

### C1. `store.ts:429-435` — Non-transactional dedup delete in `#insertChunks`

The dedup logic deletes all chunks for a label **outside** the transaction that inserts new chunks:

```typescript
// Lines 433-435 — OUTSIDE transaction
this.#stmtDeleteChunksByLabel.run(label);
this.#stmtDeleteChunksTrigramByLabel.run(label);
this.#stmtDeleteSourcesByLabel.run(label);

// Line 449 — INSIDE transaction
const transaction = this.#db.transaction(() => {
  const info = this.#stmtInsertSource.run(label, chunks.length, codeChunks);
  // ...
});
```

If the process crashes between delete (line 433) and insert (line 449), the source's data is permanently lost. The delete should be inside the same transaction as the insert.

**Fix**: Move lines 433-435 inside the transaction block at line 449.

### C2. `session/db.ts:263-292` — `insertEvent` not wrapped in transaction

The `insertEvent` method performs 4 sequential operations (checkDuplicate, getEventCount, evictLowestPriority, insertEvent, updateMetaLastEvent) without a transaction. A concurrent hook call could read stale counts or cause double-eviction.

```
Line 271: checkDuplicate
Line 275: getEventCount
Line 277: evictLowestPriority
Line 281: insertEvent
Line 292: updateMetaLastEvent
```

Since hooks can fire concurrently (PostToolUse for rapid tool calls), this is a real race condition even with WAL mode, which only allows one writer at a time — a second call could read the pre-eviction count.

**Fix**: Wrap the entire method body in `this.db.transaction(() => { ... })()`.

### C3. `server.ts` — No `unhandledRejection` / `uncaughtException` handlers

The MCP server has no global error handlers. An unhandled promise rejection in any async path (tool handler, transport, session indexing) will crash the process with zero diagnostics.

```
unhandledRejection handler: false
uncaughtException handler: false
```

**Fix**: Add handlers in `main()` that log the error to stderr and continue (for rejections) or gracefully shutdown (for exceptions).

---

## HIGH

### H1. `server.ts:1487-1505` — Raw SQL in stats tool bypasses prepared statements

The `ctx_stats` tool creates a raw `better-sqlite3` Database instance and builds queries inline:

```typescript
const sdb = new Database(sessionDbPath, { readonly: true });
const eventTotal = sdb.prepare("SELECT COUNT(*) as cnt FROM session_events").get();
```

While these are read-only and use `prepare()`, they bypass the SessionDB abstraction entirely. If the schema changes, this code silently breaks. More importantly, the `sdb` connection is not closed in a `finally` block — if any query throws, the connection leaks.

**Fix**: Use a `try/finally` to ensure `sdb.close()`, or better, use `SessionDB` directly with a read-only mode.

### H2. `executor.ts:313` — `#buildSafeEnv` passes through sensitive credentials

The env passthrough list includes:

- `AWS_SECRET_ACCESS_KEY`
- `GH_TOKEN` / `GITHUB_TOKEN`
- `NPM_TOKEN` / `NODE_AUTH_TOKEN`

This is intentional (CLI tools need auth) but means user-submitted code has full access to these credentials. Combined with the fact that `execute` runs arbitrary code, any prompt injection that reaches `execute()` can exfiltrate secrets.

**Mitigation**: This is a known design tradeoff. Document it clearly. Consider a `--no-passthrough` mode for sensitive environments.

### H3. `store.ts` — No size limit on indexable content

`ContentStore.index()` accepts arbitrarily large content. A 500MB file passed to `readFileSync(path!, "utf-8")` at line 355 will cause OOM. The chunking logic (line 757) splits into 4KB chunks but the full string is held in memory during processing.

**Fix**: Add a `MAX_INDEXABLE_BYTES` check (e.g., 10MB) before `readFileSync` and before processing `content`.

### H4. `executor.ts:171` — Shell injection in `rustc` compile command

```typescript
execSync(`rustc ${srcPath} -o ${binPath}`, { ... });
```

`srcPath` is derived from `mkdtempSync` output (safe) but the pattern of string-interpolating into shell commands is fragile. If a future change allows user-influenced paths, this becomes exploitable.

**Fix**: Use `execFileSync('rustc', [srcPath, '-o', binPath])` to avoid shell interpretation entirely.

---

## MEDIUM

### M1. `server.ts` — Tool handlers lack consistent try/catch

The MCP SDK may handle errors at the transport level, but unhandled exceptions in tool handlers (e.g., `getStore()` failing because `better-sqlite3` isn't installed) produce opaque errors. The `execute` and `batch_execute` tools have try/catch, but `index`, `search`, `stats`, and `doctor` do not.

**Fix**: Wrap all tool handler bodies in try/catch that returns `{ isError: true, content: [{ type: "text", text: error.message }] }`.

### M2. `session/db.ts:121` — Schema migration uses `DROP TABLE` without backup

```typescript
this.db.exec("DROP TABLE session_events");
```

If a schema migration fires on an existing DB (e.g., `data_hash` column added), all session events are silently destroyed.

**Mitigation**: This is acceptable during pre-1.0 development but should be replaced with `ALTER TABLE ADD COLUMN` migrations for v1.0+.

### M3. `store.ts:66` — `sanitizeQuery` returns `""` for empty input

When all query words are stripped, `sanitizeQuery` returns `""` which is a valid FTS5 query that matches everything. This could return unexpected results for garbage input.

**Fix**: Return a sentinel that matches nothing, or check for empty result before executing the query.

### M4. `executor.ts:228-230` — Background process PID tracking is unreliable

```typescript
if (proc.pid) this.#backgroundedPids.add(proc.pid);
proc.unref();
```

After `unref()`, the process may be reparented. The stored PID could be reused by the OS for a different process before `cleanupBackgrounded()` runs, potentially killing an innocent process.

**Fix**: Use process groups (`detached: true` + `process.kill(-pid)`) for reliable cleanup, or accept the risk and document it.

### M5. `hooks/*.mjs` — Session start hook runs `db.db.exec(DELETE...)` outside transaction

In `sessionstart.mjs` (via the hook code):
```javascript
db.db.exec(`DELETE FROM session_events WHERE session_id NOT IN (SELECT session_id FROM session_meta)`);
```

This raw SQL bypasses the SessionDB API and has no transaction protection.

**Fix**: Add a `deleteOrphanEvents()` method to SessionDB that runs this in a transaction.

---

## LOW

### L1. `routing-block.mjs` — Static content, no injection risk

All exports are static template literals with no dynamic interpolation. Clean.

### L2. `hooks/*.mjs` — All hooks wrapped in top-level try/catch

PostToolUse, PreCompact, SessionStart all have top-level `try { ... } catch { /* silent */ }` — hooks fail silently as designed. The `readStdin()` helper uses event-based reading with proper error handling.

### L3. `db-base.ts` — WAL + timeout properly configured

```typescript
new Database(dbPath, { timeout: 5000 });
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
```

5-second busy timeout and WAL mode are correct for this use case.

### L4. `security.ts` — Glob patterns are sound, deny wins over allow

Chain splitting handles `&&`, `||`, `;`, `|` with quote-awareness. Deny is checked per-segment (prevents bypass). No issues found with `fileGlobToRegex` or `globToRegex`.

### L5. `executor.ts` — Stream byte cap prevents memory exhaustion

The `hardCapBytes` (100MB) stream-level cap at lines 258-276 kills processes that produce unbounded output (e.g., `yes`). Timeout + SIGKILL tree-kill is properly implemented.

---

## Summary

| Severity | Count | Blocking for v1.0? |
|----------|-------|---------------------|
| CRITICAL | 3     | Yes                 |
| HIGH     | 4     | Recommended         |
| MEDIUM   | 5     | No (but advisable)  |
| LOW      | 5     | No                  |

**Verdict**: Fix C1, C2, C3 before release. H1 and H3 are strongly recommended. The rest can ship as known issues with follow-up tickets.
