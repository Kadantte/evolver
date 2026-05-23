const path = require('path');
const fs = require('fs');
const os = require('os');

let _cachedRepoRoot = null;

// Resolve the git repository that evolver should treat as its work area.
//
// Precedence:
//   1. EVOLVER_REPO_ROOT (explicit override, always wins)
//   2. Nearest ancestor of process.cwd() that has a .git
//      (user ran evolver from inside their project)
//   3. Nearest ancestor of evolver's own directory that has a .git
//      (local npm install: evolver is inside the project's node_modules)
//   4. evolver's own directory if it has a .git (dev mode fallback)
//   5. Fall back to evolver's own directory.
//
//   CWD is checked first because the user's intent is almost always to
//   evolve the project they're standing in, not evolver itself.  evolver
//   self-evolution happens naturally when CWD *is* the evolver repo.
//
//   To opt out, set EVOLVER_NO_PARENT_GIT=true.  The older
//   EVOLVER_USE_PARENT_GIT=true flag is still honored for forward
//   compatibility but is no longer required.
function getRepoRoot() {
  // Always check EVOLVER_REPO_ROOT first, even when a cached value exists.
  // .env is loaded during index.js bootstrap AFTER this function has
  // already been called at least once (for locating the .env file
  // itself). Caching the pre-dotenv result would permanently shadow any
  // EVOLVER_REPO_ROOT later populated from .env. See #526.
  if (process.env.EVOLVER_REPO_ROOT) {
    _cachedRepoRoot = process.env.EVOLVER_REPO_ROOT;
    return _cachedRepoRoot;
  }

  if (_cachedRepoRoot) return _cachedRepoRoot;

  const ownDir = path.resolve(__dirname, '..', '..');

  const noParent = String(process.env.EVOLVER_NO_PARENT_GIT || '').toLowerCase() === 'true';
  // Older flag kept for backward compatibility. Setting it to 'false'
  // explicitly is treated as an opt-out, mirroring EVOLVER_NO_PARENT_GIT.
  const legacyFlag = process.env.EVOLVER_USE_PARENT_GIT;
  const legacyOptOut = typeof legacyFlag === 'string' && legacyFlag.toLowerCase() === 'false';

  // Both upward walks below must stop at the parent of the nearest
  // `node_modules` ancestor — never escape into whatever `.git` happens
  // to live above it (issue #541). On macOS with Homebrew, the global
  // install lives at `/opt/homebrew/lib/node_modules/@evomap/evolver`
  // and `/opt/homebrew` is itself a git repo; an unbounded walk
  // therefore resolves repoRoot to `/opt/homebrew`, sending
  // workspaceRoot / memoryDir / evolutionDir to a directory that
  // doesn't belong to the user and silently producing evolution
  // proposals for the wrong codebase.
  //
  // Boundary semantics: returns the parent of the nearest `node_modules`
  // ancestor (inclusive — a `.git` at that parent IS still picked up),
  // or null if `dir` is not inside any `node_modules` (dev clone /
  // user project root). Callers stop AFTER checking the boundary path
  // itself.
  //
  // For a local install (`<project>/node_modules/@evomap/evolver`), the
  // parent of node_modules IS the user's project, so the boundary
  // includes `<project>` and `<project>/.git` is still picked up
  // correctly. For a dev clone, the boundary is null and the walk is
  // unbounded as before.
  function _nodeModulesBoundary(dir) {
    const segments = dir.split(path.sep);
    const nmIdx = segments.lastIndexOf('node_modules');
    if (nmIdx <= 0) return null;
    return segments.slice(0, nmIdx).join(path.sep) || path.sep;
  }

  function _walkForGit(start) {
    const stopAt = _nodeModulesBoundary(start);
    let dir = start;
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, '.git'))) {
        if (!process.env.EVOLVER_QUIET_PARENT_GIT) {
          console.log('[evolver] Using host git repository at:', dir);
        }
        return dir;
      }
      if (stopAt !== null && dir === stopAt) break;
      dir = path.dirname(dir);
    }
    return null;
  }

  // Walk upward from process.cwd() — the project the user is standing in.
  // Bounded the same way as the ownDir walk: a user who `cd`s into the
  // global install (e.g. `cd /opt/homebrew/lib/node_modules/@evomap/evolver`
  // to debug) would otherwise hit `/opt/homebrew/.git` here BEFORE the
  // ownDir walk runs, defeating its boundary. The boundary still
  // includes the parent of node_modules, so a user `cd`'d into
  // `<their-project>/node_modules/lodash` still has `<their-project>/.git`
  // picked correctly.
  if (!noParent && !legacyOptOut) {
    const hit = _walkForGit(process.cwd());
    if (hit) {
      _cachedRepoRoot = hit;
      return _cachedRepoRoot;
    }
  }

  // Walk upward from ownDir's parent (local install inside node_modules).
  if (!noParent && !legacyOptOut) {
    const hit = _walkForGit(path.dirname(ownDir));
    if (hit) {
      _cachedRepoRoot = hit;
      return _cachedRepoRoot;
    }
  }

  // Fallback: evolver's own directory (dev mode or isolated install).
  if (fs.existsSync(path.join(ownDir, '.git'))) {
    _cachedRepoRoot = ownDir;
    return _cachedRepoRoot;
  }

  _cachedRepoRoot = ownDir;
  return _cachedRepoRoot;
}

function getWorkspaceRoot() {
  if (process.env.OPENCLAW_WORKSPACE) {
    return process.env.OPENCLAW_WORKSPACE;
  }

  const repoRoot = getRepoRoot();
  const workspaceDir = path.join(repoRoot, 'workspace');
  if (fs.existsSync(workspaceDir)) {
    return workspaceDir;
  }

  return repoRoot;
}

function getLogsDir() {
  return process.env.EVOLVER_LOGS_DIR || path.join(getWorkspaceRoot(), 'logs');
}

function getEvolverLogPath() {
  return path.join(getLogsDir(), 'evolver_loop.log');
}

function getMemoryDir() {
  return process.env.MEMORY_DIR || path.join(getWorkspaceRoot(), 'memory');
}

function getSessionScope() {
  const raw = String(process.env.EVOLVER_SESSION_SCOPE || '').trim();
  if (!raw) return null;
  const safe = raw.replace(/[^a-zA-Z0-9_\-\.]/g, '_').slice(0, 128);
  if (!safe || /^\.{1,2}$/.test(safe) || /\.\./.test(safe)) return null;
  return safe;
}

function getEvolutionDir() {
  const baseDir = process.env.EVOLUTION_DIR || path.join(getMemoryDir(), 'evolution');
  const scope = getSessionScope();
  if (scope) {
    return path.join(baseDir, 'scopes', scope);
  }
  return baseDir;
}

function getGepAssetsDir() {
  const repoRoot = getRepoRoot();
  const baseDir = process.env.GEP_ASSETS_DIR || path.join(repoRoot, 'assets', 'gep');
  const scope = getSessionScope();
  if (scope) {
    return path.join(baseDir, 'scopes', scope);
  }
  return baseDir;
}

function getSkillsDir() {
  return process.env.SKILLS_DIR || path.join(getWorkspaceRoot(), 'skills');
}

// Resolve the OpenClaw `sessions` directory for the agent that actually
// matches the current EVOLVER_SESSION_SCOPE (fixes #371).
//
// Precedence:
//   1. AGENT_SESSIONS_DIR         explicit override
//   2. EVOLVER_SESSION_SCOPE with a `workspace-<agent>` prefix =>
//      ~/.openclaw/agents/<agent>/sessions
//   3. AGENT_NAME (defaults to "main")   pre-#371 behavior
function getAgentSessionsDir() {
  if (process.env.AGENT_SESSIONS_DIR) return process.env.AGENT_SESSIONS_DIR;

  const scope = getSessionScope();
  let agentName = null;
  if (scope) {
    const match = /^workspace-(.+)$/.exec(scope);
    if (match) agentName = match[1];
  }
  if (!agentName) agentName = process.env.AGENT_NAME || 'main';

  const home = process.env.HOME || process.env.USERPROFILE || '';
  return path.join(home, '.openclaw', 'agents', agentName, 'sessions');
}

// Read the first `maxBytes` of a session .jsonl file and extract the `cwd`
// field from its header record (fixes #371, bug 2). The pre-fix matcher
// tailed the file, so it never saw the header. This helper is O(1) on file
// size. Returns null on any read/parse failure.
function readSessionCwdFromHead(sessionFilePath, maxBytes) {
  const cap = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : 800;
  try {
    if (!fs.existsSync(sessionFilePath)) return null;
    const fd = fs.openSync(sessionFilePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const readSize = Math.min(cap, stat.size);
      if (readSize <= 0) return null;
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, 0);
      const newline = buf.indexOf('\n');
      const slice = newline >= 0 ? buf.slice(0, newline) : buf;
      const record = JSON.parse(slice.toString('utf8'));
      if (record && typeof record.cwd === 'string') return record.cwd;
      return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch (_err) {
    return null;
  }
}

function getNarrativePath() {
  return path.join(getEvolutionDir(), 'evolution_narrative.md');
}

function getEvolutionPrinciplesPath() {
  const repoRoot = getRepoRoot();
  const custom = path.join(repoRoot, 'EVOLUTION_PRINCIPLES.md');
  if (fs.existsSync(custom)) return custom;
  return path.join(repoRoot, 'assets', 'gep', 'EVOLUTION_PRINCIPLES.md');
}

function getReflectionLogPath() {
  return path.join(getEvolutionDir(), 'reflection_log.jsonl');
}

// Resolve the evolver INSTALLATION directory (the package containing this file),
// independent of any host git repo or process.cwd().
//
// Use this — never getRepoRoot() — for any operation that mutates evolver's
// own files (force-update, self-PR, integrity rewrites, etc.). getRepoRoot()
// preferentially returns the user's surrounding project so that evolution
// signals are scoped to *their* code; using it for self-mutation will
// overwrite the user's project with evolver's package contents (issue #51).
//
// path.resolve(__dirname, '..', '..') is stable across all install modes:
//   - global npm: /usr/lib/node_modules/@evomap/evolver/src/gep/paths.js
//                 → /usr/lib/node_modules/@evomap/evolver
//   - local install: <project>/node_modules/@evomap/evolver/src/gep/paths.js
//                 → <project>/node_modules/@evomap/evolver
//   - dev clone: /home/user/evolver/src/gep/paths.js → /home/user/evolver
function getEvolverInstallRoot() {
  return path.resolve(__dirname, '..', '..');
}

// Resolve the per-user `~/.evomap` directory, with `EVOLVER_HOME` env var
// override. Lazy (function call, not a module-level `const`) so tests can
// flip `EVOLVER_HOME` per case without monkey-patching `os.homedir`.
//
// Existing call sites used to duplicate `path.join(os.homedir(), '.evomap')`
// across ~9 modules; about two thirds silently ignored `EVOLVER_HOME` (it
// worked for stake bootstrap and claim nudge but not for node-id, device-id,
// feature flags, etc.). #114 consolidates onto this helper so the override
// is uniform and tests don't need to monkey-patch the global homedir
// function (which doesn't compose with `node --test` parallel execution).
function getEvomapDir() {
  return process.env.EVOLVER_HOME || path.join(os.homedir(), '.evomap');
}

// Join sub-segments under `~/.evomap`. Just a convenience wrapper so call
// sites don't have to `path.join(getEvomapDir(), 'mailbox', 'state.json')`
// in two pieces.
function getEvomapPath(...segments) {
  return path.join(getEvomapDir(), ...segments);
}

// Per-workspace random secret used to attest that a memory_graph.jsonl
// entry was written by the same workspace that's now reading it. Stored
// at <workspace>/.evolver/workspace-id with mode 0600 and lazily created
// on first call. Returns null on read/write errors so callers can fall
// back to legacy cwd-tag matching.
//
// Why this exists: when memory_graph.jsonl lives at the user-level path
// (~/.evolver/memory/evolution/memory_graph.jsonl, used by npm-global
// installs), it's shared across every workspace under the same uid. The
// PR #108 cwd-tag layer scopes reads to the current cwd, but `cwd` is a
// plain-text self-report — any process writing the shared file can
// claim a different workspace. workspace-id replaces that self-report
// with a secret that only the legitimate workspace's evolver knows
// (Bugbot PR #108 round-3 Agentic Security Review MEDIUM).
function getWorkspaceId() {
  if (process.env.EVOLVER_WORKSPACE_ID) return String(process.env.EVOLVER_WORKSPACE_ID);
  const dir = path.join(getWorkspaceRoot(), '.evolver');
  const file = path.join(dir, 'workspace-id');

  // Refuse to follow symlinks at either the directory or file level.
  // A malicious repo can pre-place `.evolver` or `.evolver/workspace-id`
  // as a symlink to an attacker-chosen path outside the workspace, and
  // mkdirSync({recursive:true}) / writeFileSync would silently follow
  // it — clobbering the linked file with the secret payload (Bugbot PR
  // #109 round-2 HIGH, Agentic Security Review).
  try {
    const dirStat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (dirStat && dirStat.isSymbolicLink()) return null;
    const fileStat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (fileStat) {
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) return null;
      try {
        const raw = fs.readFileSync(file, 'utf8').trim();
        if (raw && /^[a-f0-9]{32,}$/i.test(raw)) return raw;
      } catch { /* unreadable — fall through to recreate */ }
    }
  } catch { /* fall through to create */ }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const id = require('crypto').randomBytes(16).toString('hex');
    // Atomic create-and-fail-if-exists so we never overwrite an
    // attacker-pre-placed file (TOCTOU between lstat and writeFileSync
    // could otherwise race a symlink in). O_NOFOLLOW also refuses to
    // follow a symlink that appears between the lstat and open. Both
    // flags exist on Linux/macOS; on Windows O_NOFOLLOW is silently
    // ignored, but Windows has no symlink-by-default risk.
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW || 0);
    let fd;
    try {
      fd = fs.openSync(file, flags, 0o600);
    } catch (e) {
      // EEXIST means another process beat us to it — re-read with the
      // same symlink guards as above.
      if (e && e.code === 'EEXIST') {
        const fileStat = fs.lstatSync(file, { throwIfNoEntry: false });
        if (!fileStat || fileStat.isSymbolicLink() || !fileStat.isFile()) return null;
        try {
          const raw = fs.readFileSync(file, 'utf8').trim();
          if (raw && /^[a-f0-9]{32,}$/i.test(raw)) return raw;
        } catch { /* unreadable */ }
        return null;
      }
      // ELOOP / EMLINK from O_NOFOLLOW hitting a symlink — refuse.
      return null;
    }
    try {
      fs.writeSync(fd, id + '\n', 0, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    try { fs.chmodSync(file, 0o600); } catch { /* best-effort */ }
    return id;
  } catch {
    return null;
  }
}

module.exports = {
  getRepoRoot,
  getEvolverInstallRoot,
  getWorkspaceRoot,
  getLogsDir,
  getEvolverLogPath,
  getMemoryDir,
  getEvolutionDir,
  getGepAssetsDir,
  getSkillsDir,
  getSessionScope,
  getAgentSessionsDir,
  getWorkspaceId,
  readSessionCwdFromHead,
  getNarrativePath,
  getEvolutionPrinciplesPath,
  getReflectionLogPath,
  getEvomapDir,
  getEvomapPath,
};
