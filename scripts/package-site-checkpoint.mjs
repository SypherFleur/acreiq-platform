import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = "docs/checkpoints/audit-fixes/source-manifest.json";
const CHECKPOINT = "docs/checkpoints/site-comparison";
const MANIFEST = `${CHECKPOINT}/source-manifest.json`;
const README = `${CHECKPOINT}/README.md`;
const SCRIPT = "scripts/package-site-checkpoint.mjs";
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const TEMPLATE_PATHS = new Set([".env.example", "backend/.env.example", "frontend/.env.example"]);
const SITE_DIRECTORIES = [
  ["backend", /^site(?:_[a-z0-9]+)*\.py$/],
  ["backend/tests", /^(?:test_|reference_)site(?:_[a-z0-9]+)*\.py$/],
  ["backend/tests/fixtures", /^site(?:_[a-z0-9]+)*\.json$/],
  ["frontend/lib", /^site(?:-[a-z0-9]+)*\.(?:ts|json)$/],
  ["frontend/components", /^(?:Site[A-Za-z0-9]*\.tsx|site(?:-[a-z0-9]+)*\.css)$/],
  ["frontend/tests", /^site(?:-[a-z0-9]+)*\.spec\.ts$/],
  ["frontend/lib/live", /^receipt\.ts$/],
  ["frontend/tests", /^live-receipt\.spec\.ts$/],
];

export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")
    || value.includes(":") || path.posix.isAbsolute(value)
    || value.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Checkpoint paths must be canonical repository-relative paths.");
  }
  return value;
}

export function assertSourcePath(value) {
  const name = safeRelativePath(value);
  const lower = name.toLowerCase();
  const parts = lower.split("/");
  if (parts.some(part => /^(?:\.git|\.acreiq-local|\.venv|venv|node_modules|__pycache__|dist|build|coverage|logs|test-results.*|playwright-report|\.next.*)$/.test(part))
    || parts.some(part => part.startsWith(".env") && !TEMPLATE_PATHS.has(name))
    || /(?:^|\/)(?:credentials?|secrets?|tokens?|private[-_]photos?|account)[^/]*(?:\/|\.)/.test(lower)
    || /\.(?:png|jpe?g|webp|gif|heic|mp[34]|wav|pem|key|p12|pfx|log|zip)$/i.test(name)) {
    throw new Error(`Excluded source path: ${name}`);
  }
  if (!/\.(?:py|ts|tsx|js|mjs|cjs|css|json|md|txt|ya?ml|ps1|ini)$/.test(name)
    && !/(?:^|\/)(?:Dockerfile|\.gitignore|\.dockerignore)$/.test(name)
    && !TEMPLATE_PATHS.has(name)) {
    throw new Error(`Not an approved source format: ${name}`);
  }
  return name;
}

export function assertTemplateContent(relative, text) {
  if (!TEMPLATE_PATHS.has(relative)) return;
  for (const line of text.split(/\r?\n/)) {
    const entry = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!entry || !/(?:api_key|token|secret|credential|private_key|password)/i.test(entry[1])) continue;
    const value = entry[2].replace(/(?:^|\s+)#.*$/, "").trim();
    if (!["", "''", '""'].includes(value)) {
      throw new Error(`Sensitive template configuration must be blank before packaging: ${relative} (${entry[1]}). No value was printed.`);
    }
  }
}

function checkedPath(root, relative, { mayNotExist = false } = {}) {
  safeRelativePath(relative);
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    let info;
    try { info = lstatSync(current); }
    catch (error) {
      if (mayNotExist && error.code === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`Symlinks are not permitted: ${relative}`);
    const resolved = path.relative(root, realpathSync(current));
    if (resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) {
      throw new Error(`Path escapes the repository: ${relative}`);
    }
  }
  return current;
}

function readSource(root, relative) {
  assertSourcePath(relative);
  const file = checkedPath(root, relative);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`Unsupported source file size/type: ${relative}`);
  const data = readFileSync(file);
  const text = data.toString("utf8");
  if (data.includes(0) || !Buffer.from(text, "utf8").equals(data)) throw new Error(`Non-text source refused: ${relative}`);
  assertTemplateContent(relative, text);
  if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(text)
    || /AIza[A-Za-z0-9_-]{35}/.test(text)
    || /ya29\.[A-Za-z0-9_-]{30,}/.test(text)) {
    throw new Error(`Potential credential material detected; packaging stopped at ${relative}. No values were printed.`);
  }
  return data;
}

export function siteAdditions(root = ROOT) {
  const names = [];
  for (const [directory, pattern] of SITE_DIRECTORIES) {
    let entries;
    try { entries = readdirSync(checkedPath(root, directory), { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const entry of entries) {
      if (pattern.test(entry.name)) names.push(assertSourcePath(`${directory}/${entry.name}`));
    }
  }
  return names;
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function makeStoredZip(entries, timestamp = new Date()) {
  if (entries.length > 0xffff) throw new Error("ZIP32 entry limit exceeded.");
  const year = Math.min(2107, Math.max(1980, timestamp.getUTCFullYear()));
  const date = ((year - 1980) << 9) | ((timestamp.getUTCMonth() + 1) << 5) | timestamp.getUTCDate();
  const time = (timestamp.getUTCHours() << 11) | (timestamp.getUTCMinutes() << 5) | (timestamp.getUTCSeconds() >> 1);
  const local = [];
  const central = [];
  const seen = new Set();
  let offset = 0;
  for (const entry of entries) {
    const entryPath = safeRelativePath(entry.path);
    const name = Buffer.from(entryPath, "utf8");
    const data = Buffer.from(entry.data);
    if (seen.has(entryPath.toLowerCase())) throw new Error("Duplicate ZIP entry.");
    seen.add(entryPath.toLowerCase());
    if (name.length > 0xffff || data.length > MAX_FILE_BYTES || offset + data.length > MAX_SOURCE_BYTES) {
      throw new Error("Checkpoint ZIP size limit exceeded.");
    }
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(time, 12);
    directory.writeUInt16LE(date, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export function packageCheckpoint({ root = ROOT, output = ".acreiq-local/phase2/acreiq-site-comparison-source.zip", expectedSourceSha256 = null } = {}) {
  root = realpathSync(root);
  safeRelativePath(output);
  if (!/^\.acreiq-local\/phase2\/[A-Za-z0-9_-]+\.zip$/.test(output)) {
    throw new Error("Archive destination must be a ZIP directly inside .acreiq-local/phase2.");
  }
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const head = git("rev-parse", "HEAD");
  const branch = git("branch", "--show-current");
  const baselineBytes = readSource(root, BASELINE);
  const baseline = JSON.parse(baselineBytes.toString("utf8").replace(/^\uFEFF/, ""));
  if (!Array.isArray(baseline.files) || baseline.files.length !== 98) throw new Error("Expected the reviewed 98-file Phase 1 baseline.");
  const oldFiles = new Map();
  for (const file of baseline.files) {
    assertSourcePath(file.path);
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || oldFiles.has(file.path)) throw new Error("Invalid Phase 1 source manifest.");
    oldFiles.set(file.path, file.sha256);
  }
  const paths = [...new Set([...oldFiles.keys(), ...siteAdditions(root), BASELINE, SCRIPT, README])].sort();
  const entries = paths.map(file => ({ path: file, data: readSource(root, file) }));
  const totalBytes = entries.reduce((total, entry) => total + entry.data.length, 0);
  if (totalBytes > MAX_SOURCE_BYTES) throw new Error("Source size limit exceeded.");
  const tracked = new Set(git("ls-files", "--cached", "-z").split("\0"));
  const changedFromHead = new Set(git("diff", "HEAD", "--name-only", "-z").split("\0"));
  const files = entries.map(entry => {
    const hash = sha256(entry.data);
    const previous = oldFiles.get(entry.path) ?? null;
    return { path: entry.path, bytes: entry.data.length, sha256: hash, baseline_sha256: previous,
      head_status: !tracked.has(entry.path) ? "untracked" : changedFromHead.has(entry.path) ? "modified" : "unchanged",
      status: previous === null ? "added" : previous === hash ? "unchanged" : "modified" };
  });
  const sourceSha256 = sha256(Buffer.from(files.map(file => `${file.path}\0${file.sha256}\n`).join(""), "utf8"));
  if (expectedSourceSha256 !== null && expectedSourceSha256 !== sourceSha256) {
    throw new Error("Current source does not match the supplied tested-source identity; nothing packaged.");
  }
  const capturedAt = new Date();
  const manifest = {
    schema_version: "acreiq-source-checkpoint/1.0.0", captured_at: capturedAt.toISOString(),
    local_head: head, branch, source_sha256: sourceSha256,
    source_identity_method: "sha256 of sorted UTF-8 path + NUL + file SHA256 + LF; manifest excluded to avoid self-reference",
    source_state: "Complete allowlisted integrated working source, including uncommitted files; historical HEAD alone is incomplete.",
    baseline: BASELINE, baseline_sha256: sha256(baselineBytes),
    scope: "Phase 1's 98 explicit source/test/template/document paths plus bounded site source, fixture, tests, the Live receipt regression helper/tests, this packager and checkpoint README. No blanket Git or directory archive.",
    exclusions: ["credentials and non-template .env files", "private photos and media", ".git", "dependencies", "builds", "runtime data and logs", "test results and screenshots"],
    verification: "Packaging does not run tests or attest to passing tests. Consult the checkpoint README for actual verification and tested runtime identity.",
    expected_tested_source_identity_supplied: expectedSourceSha256 !== null,
    counts: { source_files: files.length, source_bytes: totalBytes, unchanged: files.filter(file => file.status === "unchanged").length,
      modified: files.filter(file => file.status === "modified").length, added: files.filter(file => file.status === "added").length },
    phase1_changes: files.filter(file => file.status !== "unchanged").map(file => ({ path: file.path, status: file.status })),
    proposed_commit_scope: "Allowlisted integrated source changes relative to local HEAD, including prior uncommitted work. Review before staging; this script does not stage or commit. Generated manifest/archive metadata are separate from the source list.",
    proposed_commit_contents: files.filter(file => file.head_status !== "unchanged").map(file => ({ path: file.path, status: file.head_status })),
    files,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const zip = makeStoredZip([...entries, { path: MANIFEST, data: manifestBytes }], capturedAt);
  // Detect concurrent source edits before publishing a snapshot assembled from multiple reads.
  for (const file of files) {
    if (sha256(readSource(root, file.path)) !== file.sha256) throw new Error(`Source changed during packaging: ${file.path}`);
  }
  if (git("rev-parse", "HEAD") !== head || git("branch", "--show-current") !== branch
    || JSON.stringify(siteAdditions(root).sort()) !== JSON.stringify(paths.filter(file => SITE_DIRECTORIES.some(([dir, pattern]) => path.posix.dirname(file) === dir && pattern.test(path.posix.basename(file)))).sort())) {
    throw new Error("Source identity changed during packaging; rerun after development stops.");
  }
  const manifestFile = checkedPath(root, MANIFEST, { mayNotExist: true });
  const zipFile = checkedPath(root, output, { mayNotExist: true });
  const infoFile = checkedPath(root, `${CHECKPOINT}/archive-info.json`, { mayNotExist: true });
  for (const destination of [manifestFile, zipFile, infoFile]) {
    try { lstatSync(destination); throw new Error("Checkpoint output already exists; choose a reviewed new checkpoint operation instead of overwriting it."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  mkdirSync(path.dirname(zipFile), { recursive: true });
  mkdirSync(path.dirname(manifestFile), { recursive: true });
  const info = { captured_at: capturedAt.toISOString(), archive: output, archive_sha256: sha256(zip),
    archive_bytes: zip.length, source_sha256: sourceSha256, manifest: MANIFEST, manifest_sha256: sha256(manifestBytes),
    archive_entries: entries.length + 1, local_head: head, branch };
  writeFileSync(zipFile, zip, { flag: "wx" });
  writeFileSync(manifestFile, manifestBytes, { flag: "wx" });
  writeFileSync(infoFile, JSON.stringify(info, null, 2) + "\n", { flag: "wx" });
  return info;
}

function main(args) {
  if (!args.includes("--create")) {
    console.log("No files generated. After final source verification, run: node scripts/package-site-checkpoint.mjs --create [--expected-source-sha256 HASH] [--output .acreiq-local/phase2/NAME.zip]");
    return;
  }
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--create") continue;
    if (!["--output", "--expected-source-sha256"].includes(arg) || !args[index + 1]) throw new Error("Unknown or incomplete checkpoint option.");
    const key = arg === "--output" ? "output" : "expectedSourceSha256";
    if (key in options) throw new Error("Duplicate checkpoint option.");
    options[key] = args[++index];
  }
  if (options.expectedSourceSha256 && !/^[a-f0-9]{64}$/.test(options.expectedSourceSha256)) throw new Error("Expected source identity must be a SHA256 digest.");
  console.log(JSON.stringify(packageCheckpoint(options), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
