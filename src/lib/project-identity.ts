/**
 * Workspace identity — the TypeScript half of the normalisation contract.
 *
 * `NORMALIZED_REMOTE_SQL` / `NORMALIZED_WORKSPACE_SQL` in `./db` are the other
 * half: the two partial unique indexes (`uq_bmad_projects_remote`,
 * `uq_bmad_projects_workspace`) are built from them, and `resolveProject`
 * compares this module's output against those same expressions. The halves must
 * produce byte-identical keys — if TS normalised more aggressively than the
 * index, a lookup would miss a row the index considers equal and a second
 * project for the same repo would be inserted.
 *
 * Every step below is the same step, in the same order, as identity-mapping.md
 * and its SQL. Lowercasing runs FIRST in both, which is what makes `.GIT` strip
 * by the same rule as `.git`; lowercasing at the end would run after the strip
 * had already missed it.
 *
 * Workspace paths are case-folded too (D-4): on a case-insensitive filesystem
 * `/Users/X/proj` and `/users/x/proj` are one directory, so they must be one
 * key. `NORMALIZED_WORKSPACE_SQL` lowers the same way — the resolver compares
 * against it, so the two halves stay byte-identical.
 *
 * Credentials are REJECTED, not normalised away (D-5): `normalizeGitRemote`
 * strips userinfo, so a check on its output could never see the token. The
 * check therefore runs on the raw value, before any normalisation —
 * {@link hasRemoteCredentials}.
 *
 * Pure by design — no `pg`, no `next/*` — so the keys can be exercised without
 * a database.
 */
import { homedir } from "node:os";
import path from "node:path";

/**
 * The caller supplied an identity this module refuses to turn into a key.
 * Lives here, not in ./projects, because both normalisers below throw it and
 * this module must stay free of `pg`. ./projects re-exports it, so the API
 * routes keep importing it from there.
 */
export class ProjectIdentityError extends Error {
  constructor(message = "A git remote URL or a workspace path is required") {
    super(message);
    this.name = "ProjectIdentityError";
  }
}

/**
 * PostgreSQL `btrim(x)` with no character set strips spaces (U+0020) and
 * nothing else. `String#trim()` strips a wider set (tabs, newlines, Unicode
 * spaces), so using it here would diverge from the SQL on inputs like
 * `" /a/b\t"`.
 */
function btrimSpaces(value: string): string {
  return value.replace(/^ +/, "").replace(/ +$/, "");
}

/**
 * A raw git remote carries a password in its userinfo (`user:token@host/repo`).
 *
 * Matched on the RAW value, never on `normalizeGitRemote`'s output: that
 * normaliser strips userinfo, so the evidence is already gone by the time a
 * key exists. A bare username (`ssh://git@host/repo`, scp-like
 * `git@host:owner/repo`) is NOT a secret and stays accepted — only a `:` before
 * the `@` marks a password.
 *
 * The scheme is optional so the scp-like form is covered too: a userinfo that
 * reads `user:token` is a credential whichever syntax carries it.
 */
const USERINFO_WITH_PASSWORD =
  /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?[^/@:]*:[^/@]*@/;

/** Scheme prefix of a URL-ish remote, used to keep it while dropping userinfo. */
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * Trim ALL whitespace (tabs, newlines, Unicode spaces), unlike
 * {@link btrimSpaces}.
 *
 * Deliberately different from the SQL-mirroring btrim the identity keys use:
 * that one exists to keep JS byte-identical to PostgreSQL's `btrim` on STORED
 * values, where a stray tab is part of the value. A credential check is not
 * mirroring any index — it is a security rule, and it must agree with the Go
 * client, which uses `strings.TrimSpace`. Trimming spaces only would let
 * `"\thttps://user:token@host/r"` through here while the CLI rejects it, so the
 * two halves would disagree about the same input.
 */
function trimWhitespace(value: string): string {
  return value.trim();
}

/** True when a raw remote value smuggles a password into its userinfo. */
export function hasRemoteCredentials(remote: string): boolean {
  return USERINFO_WITH_PASSWORD.test(trimWhitespace(remote));
}

/**
 * Refuse a remote that carries credentials. Throws the shared
 * {@link ProjectIdentityError}, which both project endpoints already map to
 * 400, so the rule lives in one place instead of once per route.
 */
export function assertRemoteHasNoCredentials(remote: string): void {
  if (!hasRemoteCredentials(remote)) return;
  throw new ProjectIdentityError(
    "gitRemoteUrl must not contain credentials (user:token@host). " +
      "Remove the token and let git use a credential helper or an SSH key instead."
  );
}

/**
 * The display form of a stored remote: identical to the input for every remote
 * without credentials, and with the userinfo removed when an older release
 * stored one.
 *
 * Applied to the RESPONSE, never the column (D-5): legacy rows are not rewritten
 * by boot, so the only thing this module can promise is that the secret is not
 * handed back. Safe for non-URL values — the pattern only fires on a
 * `user:pass@` userinfo, so `git@host:owner/repo`, `host:8080/x` and plain
 * paths pass through untouched.
 *
 * FAILS CLOSED: once a credential is detected, everything up to the LAST `@`
 * of the authority is dropped, keeping only scheme and host. A password may
 * itself contain `@` (`user:p@ss@host/r`), so cutting at the first one would
 * leak the tail; cutting at the last one inside the authority (before the
 * first `/`) cannot. The check and the cut both run on the whitespace-trimmed
 * value — otherwise a `"  https://user:token@host/r"` would be detected but
 * returned verbatim, because the `^`-anchored replace never matches past the
 * leading spaces.
 */
export function redactRemoteCredentials(remote: string): string {
  const trimmed = trimWhitespace(remote);
  if (!hasRemoteCredentials(trimmed)) return remote;

  const scheme = trimmed.match(URL_SCHEME)?.[0] ?? "";
  const rest = trimmed.slice(scheme.length);
  const pathStart = rest.indexOf("/");
  const authority = pathStart === -1 ? rest : rest.slice(0, pathStart);
  const path = pathStart === -1 ? "" : rest.slice(pathStart);
  const lastAt = authority.lastIndexOf("@");
  // Unreachable while hasRemoteCredentials is the same pattern, but if the two
  // ever disagree, drop the whole authority rather than echo it back.
  if (lastAt === -1) return scheme;
  return `${scheme}${authority.slice(lastAt + 1)}${path}`;
}

/**
 * Comparable form of a git remote: `host/owner/repo`, lowercased.
 *
 * Mirrors `NORMALIZED_REMOTE_SQL` step for step:
 *   lower(btrim(x))            → btrimSpaces + toLowerCase
 *   strip trailing "/"         → /\/+$/ (one maximal run, like POSIX)
 *   strip ".git" suffix        → /\.git$/
 *   strip scheme               → ^[A-Za-z][A-Za-z0-9+.-]*://
 *   strip userinfo             → ^[^/@]*@   (git@, ssh://git@)
 *   host:port/path → host/path → ^([^/:]+):[0-9]+(/.*)$
 *   host:path      → host/path → ^([^/:]+):(.*)$   (scp-like)
 *
 * So all four forms from identity-mapping.md — scp-like, https with and
 * without `.git`, and ssh:// with userinfo and a port — collapse to one key.
 * An input with no host (e.g. `""`) yields `""`; the caller decides whether an
 * empty key still counts as an identity.
 *
 * NON-ASCII IS REJECTED, deliberately. JS `toLowerCase()` and PostgreSQL
 * `lower()` are different implementations: on `ΑΣ` JS produces a final sigma
 * (U+03C2) where PG produces U+03C3, and `İ` becomes `i` + a combining dot in
 * JS but plain `i` in PG. `resolveProject` binds this key as `$1` and compares
 * it to the SQL expression over the STORED value, so such a remote can never
 * equal itself — every resolve would insert another project. Real git remotes
 * are ASCII, so a clear rejection beats a silent duplicate.
 */
export function normalizeGitRemote(remote: string): string {
  let key = btrimSpaces(remote).toLowerCase();
  key = key.replace(/\/+$/, "");
  key = key.replace(/\.git$/, "");
  key = key.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "");
  key = key.replace(/^[^/@]*@/, "");
  key = key.replace(/^([^/:]+):[0-9]+(\/.*)$/, "$1$2");
  key = key.replace(/^([^/:]+):(.*)$/, "$1/$2");
  // Anything outside ASCII cannot be lowercased identically by JS and PG, so
  // its key is not comparable and must not be returned (see above).
  if (/[^\x00-\x7F]/.test(key)) {
    throw new ProjectIdentityError("git remote must be ASCII");
  }
  return key;
}

/**
 * Comparable form of a workspace path: absolute, `~` expanded, lowercased, no
 * trailing slash (root stays `/`).
 *
 * `btrim` + lower + the trailing-slash strip + the root rule mirror
 * `NORMALIZED_WORKSPACE_SQL` exactly, which is what the index composes. The
 * `~` expansion and absolutisation are resolver-only steps: they happen before
 * the value is stored, so a stored path never contains `~` and the SQL sees an
 * already-absolute string.
 *
 * LOWERCASING IS UNCONDITIONAL (D-4). On macOS and Windows the filesystem is
 * case-insensitive, so casing two paths differently still names one directory;
 * keying them apart produced two projects for one workspace. The conditional
 * alternative (fold only when the local filesystem says so) was rejected: the
 * client runs on a different machine from the server, so the key would depend
 * on which side happened to resolve it. The accepted cost is that on Linux two
 * genuinely distinct paths differing only by case collapse into one project.
 *
 * Case-folding happens AFTER `path.resolve`, not before: on a case-insensitive
 * filesystem `path.resolve` touches the disk to canonicalise, and folding the
 * input first would change which directory that is on a case-sensitive one.
 *
 * Symlinks are deliberately NOT resolved (no `fs.realpath`): two worktrees
 * symlinked to the same directory stay distinct workspaces, so one cannot be
 * mistaken for the other. A path that does not exist on disk is accepted as-is
 * after normalisation — existence is never checked on this path.
 *
 * `""` returns `""` (matching the SQL for an empty input) so callers can treat
 * an empty key as "no identity" instead of silently resolving to the cwd.
 *
 * RELATIVE PATHS ARE REJECTED. `path.resolve("src")` anchors to the dashboard
 * server's process cwd, and expanding `~` uses the SERVER's home — a CLI
 * sending `src` or `.` would silently key its project to the server's
 * directory, which is never what the caller meant. Only an absolute path or a
 * `~/` path (explicitly the caller's intent to use a home directory) is an
 * identity; `.` and `..` segments are still collapsed lexically, just not
 * anchored.
 *
 * NON-ASCII IS NOT FOLDED, deliberately. `NORMALIZED_WORKSPACE_SQL` uses
 * PostgreSQL `translate()` over A-Z (not `lower()`, which is locale-dependent
 * and disagrees with JS on `İ` and the Greek sigma), and this function folds
 * exactly the same range. A non-ASCII path is therefore accepted and keyed
 * verbatim — it just is not case-folded. That is the only rule both halves can
 * implement identically, and rejecting the path instead would break workspaces
 * whose directory names legitimately contain non-ASCII characters.
 */
export function normalizeWorkspacePath(workspacePath: string): string {
  return asciiLower(workspacePathBase(workspacePath));
}

/**
 * Fold A-Z only, leaving every other code unit untouched.
 *
 * Mirrors the SQL `translate(x, 'ABC…Z', 'abc…z')` byte for byte. `String#toLowerCase`
 * must NOT be used here: it folds Unicode, which the SQL does not, and the two
 * would produce different keys for the same stored path.
 */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * The shared arithmetic behind {@link normalizeWorkspacePath}: `~` expansion,
 * absolutisation, lexically collapsed `.`/`..`, and the trailing-slash rule.
 * Folding is applied by the caller.
 */
function workspacePathBase(workspacePath: string): string {
  const value = btrimSpaces(workspacePath);
  if (value === "") return "";
  let expanded = value;
  if (value === "~" || value.startsWith("~/")) {
    expanded = value === "~" ? homedir() : path.join(homedir(), value.slice(2));
  } else if (!value.startsWith("/")) {
    throw new ProjectIdentityError(
      "workspacePath must be absolute or start with ~/"
    );
  }
  // Lexical only: collapses `.`/`..` without touching the filesystem, so no
  // symlink is followed (that is the deliberate no-realpath rule above).
  const absolute = path.resolve(expanded);
  return /^\/+$/.test(absolute) ? "/" : absolute.replace(/\/+$/, "");
}
