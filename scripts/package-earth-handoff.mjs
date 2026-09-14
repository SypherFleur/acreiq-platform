import { execFileSync } from "node:child_process";
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSourcePath, assertTemplateContent, safeRelativePath, makeStoredZip, sha256,
} from "./package-site-checkpoint.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE = "docs/checkpoints/earth/source-manifest.json";
export const BUILD_ID_PATH = "frontend/.next-earth-handoff/BUILD_ID";
export const DEFAULT_URL = "http://127.0.0.1:3007";
export const OUTPUT_PATHS = Object.freeze({
  archive: ".acreiq-local/earth-handoff/acreiq-earth-handoff-source.zip",
  manifest: "docs/checkpoints/earth-handoff/source-manifest.json",
  info: "docs/checkpoints/earth-handoff/archive-info.json",
});
// Extend this explicit list only after review; never discover source by globbing.
export const HANDOFF_PATHS = Object.freeze([
  "frontend/lib/site-drafts.ts",
  "frontend/components/EarthComparisonSummary.tsx",
  "frontend/tests/site-drafts.spec.ts",
  "frontend/tests/earth-handoff.spec.ts",
  "frontend/tests/site-handoff-integrity.spec.ts",
  "scripts/package-earth-handoff.mjs",
  "frontend/tests/earth-handoff-package.spec.ts",
  "scripts/package-site-checkpoint.mjs",
  "docs/checkpoints/earth-handoff/README.md",
  "docs/BUILD_PROGRESS.md",
  "AGENTS.md",
]);
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;

class CheckpointError extends Error {}
const refuse = message => { throw new CheckpointError(message); };

function containsCredential(text) {
  return /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(text)
    || /AIza[A-Za-z0-9_-]{35}/.test(text)
    || /ya29\.[A-Za-z0-9_-]{30,}/.test(text)
    || /(?:AKIA|ASIA)[A-Z0-9]{16}/.test(text)
    || /(?:gh[pousr]_|github_pat_|sk-(?:proj-|svcacct-)?)[A-Za-z0-9_-]{24,}/.test(text)
    || /["']type["']\s*:\s*["']service_account["']/.test(text)
    || /["']?(?:[A-Za-z0-9_]*_)?(?:api_key|access_token|refresh_token|client_secret|private_key|password)["']?\s*[:=]\s*["'][A-Za-z0-9_+/.=-]{24,}["']/i.test(text);
}

function sourcePath(value) {
  if (typeof value !== "string" || containsCredential(value)) refuse("Invalid or sensitive source path. No value was printed.");
  try { assertSourcePath(value); }
  catch { refuse("Excluded or noncanonical source path. No value was printed."); }
  if (/[\x00-\x1f\x7f<>"|?*]/.test(value)
    || value.split("/").some(part => /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    refuse("Nonportable source path. No value was printed.");
  }
  return value;
}

function checkedPath(root, relative, optional = false) {
  safeRelativePath(relative);
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (optional && error.code === "ENOENT") return path.join(root, ...relative.split("/"));
      if (error.code === "ENOENT") refuse(`Required checkpoint source is missing: ${relative}`);
      refuse(`Cannot inspect checkpoint path: ${relative}. No filesystem detail was printed.`);
    }
    if (stat.isSymbolicLink()) refuse(`Symlinks and junctions are not permitted: ${relative}`);
    const resolved = path.relative(root, realpathSync(current));
    if (resolved === ".." || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) {
      refuse(`Path escapes the repository: ${relative}`);
    }
  }
  return current;
}

// Windows lstat can report dev=0 while fstat returns the volume ID for the same file.
const fileIdentity = stat => process.platform === "win32" ? String(stat.ino) : `${stat.dev}:${stat.ino}`;
const stamp = stat => [fileIdentity(stat), stat.size, stat.mtimeNs, stat.ctimeNs].join(":");

function readChecked(root, relative, { optional = false, maxBytes = MAX_FILE_BYTES } = {}) {
  const filename = checkedPath(root, relative, optional);
  let before;
  try { before = lstatSync(filename, { bigint: true }); }
  catch (error) { if (optional && error.code === "ENOENT") return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes) || before.nlink > 1n) {
    refuse(`Unsupported checkpoint file size/type or hard link: ${relative}`);
  }
  const fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let data;
  try {
    if (stamp(fstatSync(fd, { bigint: true })) !== stamp(before)) refuse(`Source changed while opening: ${relative}`);
    data = readFileSync(fd);
    if (stamp(fstatSync(fd, { bigint: true })) !== stamp(before)) refuse(`Source changed while reading: ${relative}`);
  } finally { closeSync(fd); }
  if (stamp(lstatSync(checkedPath(root, relative), { bigint: true })) !== stamp(before)) {
    refuse(`Source changed while reading: ${relative}`);
  }
  const text = data.toString("utf8");
  if (data.includes(0) || !Buffer.from(text, "utf8").equals(data)) refuse(`Non-text source refused: ${relative}`);
  if (containsCredential(text)) refuse(`Potential credential material detected: ${relative}. No value was printed.`);
  return { data, text, stamp: stamp(before), sha256: sha256(data) };
}

function readSource(root, relative) {
  sourcePath(relative);
  const result = readChecked(root, relative);
  try { assertTemplateContent(relative, result.text); }
  catch { refuse(`Sensitive template configuration must be blank: ${relative}. No value was printed.`); }
  return result;
}

function frontendUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { refuse("Frontend URL must be the reviewed local origin on port 3007 or 3008."); }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !["3007", "3008"].includes(parsed.port)
    || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    refuse("Frontend URL must be the reviewed local origin on port 3007 or 3008, without credentials, path or query.");
  }
  return parsed.origin;
}

function gitIdentity(root) {
  const git = args => execFileSync("git", ["--no-optional-locks", ...args], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const local_head = git(["rev-parse", "--verify", "HEAD"]);
  const branch = git(["branch", "--show-current"]);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(local_head) || /[\x00-\x1f\x7f]/.test(branch) || containsCredential(branch)) {
    refuse("Invalid or sensitive Git identity. No value was printed.");
  }
  return { local_head, branch };
}

function buildIdentity(root) {
  const result = readChecked(root, BUILD_ID_PATH, { optional: true, maxBytes: 256 });
  if (result && !/^[A-Za-z0-9_-]{1,128}$/.test(result.text.trim())) refuse("Invalid build identity. No value was printed.");
  return result ? { build_id: result.text.trim(), sha256: result.sha256, stamp: result.stamp } : null;
}

function capture(root, url) {
  if (lstatSync(root).isSymbolicLink()) refuse("Repository root must not be a symlink or junction.");
  root = realpathSync(root);
  const identity = gitIdentity(root);
  const build = buildIdentity(root);
  const baselineFile = readSource(root, BASELINE);
  let baseline;
  try { baseline = JSON.parse(baselineFile.text.replace(/^\uFEFF/, "")); }
  catch { refuse("Invalid Earth baseline JSON. No content was printed."); }
  if (baseline?.schema_version !== "acreiq-earth-tested-source/1.0.0"
    || !Array.isArray(baseline.files) || baseline.files.length !== 103) {
    refuse("Expected the reviewed 103-file Earth source manifest.");
  }
  const previous = new Map(), unique = new Set();
  for (const file of baseline.files) {
    const relative = sourcePath(file?.path);
    if (!DIGEST.test(file.sha256) || unique.has(relative.toLowerCase())) refuse("Invalid or duplicate Earth source manifest entry.");
    unique.add(relative.toLowerCase());
    previous.set(relative, file.sha256);
  }
  const paths = [...new Set([...previous.keys(), BASELINE, ...HANDOFF_PATHS])].sort();
  if (new Set(paths.map(relative => relative.toLowerCase())).size !== paths.length) refuse("Case-colliding checkpoint paths.");
  const entries = paths.map(relative => ({ path: relative, ...readSource(root, relative) }));
  if (entries.find(entry => entry.path === BASELINE).sha256 !== baselineFile.sha256) refuse("Earth baseline changed during capture.");
  const totalBytes = entries.reduce((sum, entry) => sum + entry.data.length, 0);
  if (totalBytes > MAX_SOURCE_BYTES) refuse("Checkpoint source size limit exceeded.");
  const files = entries.map(entry => ({ path: entry.path, bytes: entry.data.length, sha256: entry.sha256,
    baseline_sha256: previous.get(entry.path) ?? null,
    status: !previous.has(entry.path) ? "added" : previous.get(entry.path) === entry.sha256 ? "unchanged" : "modified" }));
  const sourceSha256 = sha256(Buffer.from(files.map(file => `${file.path}\0${file.sha256}\n`).join(""), "utf8"));
  const manifest = {
    schema_version: "acreiq-earth-handoff-source/1.0.0", captured_at: new Date().toISOString(),
    ...identity, url, build_id: build?.build_id ?? null, build_id_source: build ? BUILD_ID_PATH : null,
    runtime_identity_note: "URL is operator-supplied; BUILD_ID is local metadata only. Neither proves a running or tested build. Port 3008 requires separately approved Maps origin restrictions.",
    source_sha256: sourceSha256,
    source_identity_method: "sha256 of code-unit-sorted UTF-8 path + NUL + file SHA256 + LF; generated manifest excluded to avoid self-reference",
    source_state: "Explicit integrated working source, including uncommitted files; historical HEAD alone is incomplete.",
    baseline: BASELINE, baseline_sha256: baselineFile.sha256,
    scope: "Earth's 103 explicit source/test/template paths plus its manifest and the explicit HANDOFF_PATHS list. No directory scanning or blanket archive.",
    exclusions: ["private configuration and credentials", "private photos and media", ".git", "dependencies", "build output", "runtime data and logs", "test results and screenshots"],
    verification: "This packager does not run providers, builds or tests, and does not stage or commit. Consult README.md for actual verification and limitations.",
    counts: { source_files: files.length, source_bytes: totalBytes,
      unchanged: files.filter(file => file.status === "unchanged").length,
      modified: files.filter(file => file.status === "modified").length,
      added: files.filter(file => file.status === "added").length },
    earth_changes: files.filter(file => file.status !== "unchanged").map(({ path: filePath, status }) => ({ path: filePath, status })),
    files,
  };
  return { root, identity, build, entries, manifest };
}

function verifyCapture(snapshot) {
  // Re-read every allowlisted file; the archive always uses the captured buffers.
  for (const entry of snapshot.entries) {
    const current = readSource(snapshot.root, entry.path);
    if (current.sha256 !== entry.sha256 || current.stamp !== entry.stamp) refuse(`Source changed during packaging: ${entry.path}`);
  }
  if (JSON.stringify(gitIdentity(snapshot.root)) !== JSON.stringify(snapshot.identity)
    || JSON.stringify(buildIdentity(snapshot.root)) !== JSON.stringify(snapshot.build)) {
    refuse("Git or build identity changed during packaging; retry only after development stops.");
  }
}

function sanitized(operation) {
  try { return operation(); }
  catch (error) {
    if (error instanceof CheckpointError) throw error;
    refuse("Checkpoint operation failed while reading or writing local files/Git metadata. No raw diagnostic or private value was printed.");
  }
}

export function inspectCheckpoint({ root = ROOT, url = DEFAULT_URL } = {}) {
  return sanitized(() => {
    const snapshot = capture(root, frontendUrl(url));
    verifyCapture(snapshot);
    const { files: _files, ...report } = snapshot.manifest;
    return { mode: "inspect", files_written: 0, ...report };
  });
}

function requireAbsent(root, relative) {
  const destination = checkedPath(root, relative, true);
  try { lstatSync(destination); }
  catch (error) { if (error.code === "ENOENT") return destination; throw error; }
  refuse(`Checkpoint output already exists; refusing to overwrite: ${relative}`);
}

export function packageCheckpoint({ root = ROOT, url = DEFAULT_URL, expectedSourceSha256 } = {}) {
  return sanitized(() => {
    if (typeof expectedSourceSha256 !== "string" || !DIGEST.test(expectedSourceSha256)) {
      refuse("Creation requires --expected-source-sha256 from a final --inspect review.");
    }
    const snapshot = capture(root, frontendUrl(url));
    root = snapshot.root;
    for (const relative of Object.values(OUTPUT_PATHS)) requireAbsent(root, relative);
    if (snapshot.manifest.source_sha256 !== expectedSourceSha256) refuse("Current source does not match the expected source identity; nothing packaged.");
    const manifest = { ...snapshot.manifest, expected_tested_source_identity_supplied: true };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
    const zip = makeStoredZip([...snapshot.entries, { path: OUTPUT_PATHS.manifest, data: manifestBytes }], new Date(manifest.captured_at));
    const info = { captured_at: manifest.captured_at, archive: OUTPUT_PATHS.archive,
      archive_sha256: sha256(zip), archive_bytes: zip.length, archive_entries: snapshot.entries.length + 1,
      source_sha256: manifest.source_sha256, source_files: snapshot.entries.length,
      manifest: OUTPUT_PATHS.manifest, manifest_sha256: sha256(manifestBytes),
      ...snapshot.identity, url: manifest.url, build_id: manifest.build_id,
      verification: manifest.verification };
    const outputs = [
      [OUTPUT_PATHS.archive, zip], [OUTPUT_PATHS.manifest, manifestBytes],
      [OUTPUT_PATHS.info, Buffer.from(JSON.stringify(info, null, 2) + "\n", "utf8")],
    ];
    for (const [relative] of outputs) {
      mkdirSync(path.dirname(requireAbsent(root, relative)), { recursive: true });
      requireAbsent(root, relative);
    }
    verifyCapture(snapshot);
    const created = [];
    try {
      for (const [relative, data] of outputs) {
        const destination = requireAbsent(root, relative);
        const fd = openSync(destination, "wx");
        try {
          const stat = fstatSync(fd, { bigint: true });
          created.push({ relative, identity: fileIdentity(stat) });
          writeFileSync(fd, data);
        } finally { closeSync(fd); }
      }
      verifyCapture(snapshot);
    } catch (error) {
      // Roll back only files created by this invocation, never pre-existing output.
      for (const entry of created.reverse()) {
        try {
          const filename = checkedPath(root, entry.relative);
          const stat = lstatSync(filename, { bigint: true });
          if (fileIdentity(stat) === entry.identity && !stat.isSymbolicLink()) unlinkSync(filename);
        } catch { /* Leave an uncertain output for manual review, never delete its replacement. */ }
      }
      throw error;
    }
    return info;
  });
}

function main(args) {
  if (!args.length) {
    console.log("No files generated. Inspect: node scripts/package-earth-handoff.mjs --inspect [--url http://127.0.0.1:3007]. After final review: --create --expected-source-sha256 HASH. An approved isolated origin on port 3008 is also supported.");
    return;
  }
  const options = {};
  let mode;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (["--inspect", "--create"].includes(arg)) {
      if (mode) refuse("Choose exactly one checkpoint mode.");
      mode = arg;
    } else {
      const name = { "--url": "url", "--expected-source-sha256": "expectedSourceSha256" }[arg];
      if (!name || !args[index + 1] || args[index + 1].startsWith("--") || name in options) refuse("Unknown, duplicate or incomplete checkpoint option.");
      options[name] = args[++index];
    }
  }
  if (!mode || (mode === "--inspect" && "expectedSourceSha256" in options)) refuse("Use --inspect alone, or --create with the expected source identity.");
  const result = mode === "--inspect" ? inspectCheckpoint(options) : packageCheckpoint(options);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { sanitized(() => main(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
