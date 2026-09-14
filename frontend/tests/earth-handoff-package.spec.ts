import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

type Options = { root: string; url?: string; expectedSourceSha256?: string };
type Report = {
  source_sha256: string; local_head: string; branch: string; build_id: string | null; url: string;
  counts: { source_files: number; source_bytes: number; unchanged: number; modified: number; added: number };
  earth_changes: { path: string; status: string }[];
  files_written: number;
};
type Info = { archive_sha256: string; manifest_sha256: string; archive_entries: number; source_sha256: string; build_id: string | null };
type Packager = {
  BASELINE: string; BUILD_ID_PATH: string; HANDOFF_PATHS: readonly string[];
  OUTPUT_PATHS: { archive: string; manifest: string; info: string };
  inspectCheckpoint(options: Options): Report;
  packageCheckpoint(options: Options): Info;
};
type Shared = {
  sha256(data: Buffer): string;
  crc32(data: Buffer): number;
  safeRelativePath(value: string): string;
  assertSourcePath(value: string): string;
  assertTemplateContent(relative: string, value: string): void;
  makeStoredZip(entries: { path: string; data: Buffer }[], date?: Date): Buffer;
};
const REPO = path.resolve(__dirname, "../..");
const SCRIPT = "scripts/package-earth-handoff.mjs";
const SHARED_SCRIPT = "scripts/package-site-checkpoint.mjs";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const owned: string[] = [];
let packager: Packager;
let shared: Shared;
let baselinePaths: string[];

test.beforeAll(async () => {
  // Native import keeps the existing .mjs modules outside Playwright's TS transform.
  const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  packager = await nativeImport(pathToFileURL(path.join(REPO, SCRIPT)).href) as Packager;
  shared = await nativeImport(pathToFileURL(path.join(REPO, SHARED_SCRIPT)).href) as Shared;
  const baseline = JSON.parse(fs.readFileSync(path.join(REPO, packager.BASELINE), "utf8"));
  baselinePaths = baseline.files.map((file: { path: string }) => file.path);
});

test.afterEach(() => {
  for (const directory of owned.splice(0)) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("acreiq-handoff-package-test-")) {
      throw new Error("Refusing cleanup outside an owned temporary fixture.");
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
  }
});

function write(root: string, relative: string, data: string | Buffer) {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, data);
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "acreiq-handoff-package-test-"));
  owned.push(directory);
  const root = path.join(directory, "repo");
  fs.mkdirSync(root);
  // Synthetic read-only Git metadata; no commit, index operation or real checkout is used.
  fs.mkdirSync(path.join(root, ".git/objects"), { recursive: true });
  write(root, ".git/HEAD", "ref: refs/heads/codex/checkpoint-fixture\n");
  write(root, ".git/refs/heads/codex/checkpoint-fixture", HEAD + "\n");
  for (const relative of new Set([...baselinePaths, ...packager.HANDOFF_PATHS])) {
    write(root, relative, relative.endsWith(".env.example") ? "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=\n" : "Synthetic checkpoint test source.\n");
  }
  for (const relative of [SCRIPT, SHARED_SCRIPT]) write(root, relative, fs.readFileSync(path.join(REPO, relative)));
  write(root, packager.BASELINE, JSON.stringify({ schema_version: "acreiq-earth-tested-source/1.0.0",
    files: baselinePaths.map(relative => ({ path: relative, sha256: shared.sha256(fs.readFileSync(path.join(root, relative))) })) }));
  return { root, directory };
}

function noOutputs(root: string) {
  for (const relative of Object.values(packager.OUTPUT_PATHS)) expect(fs.existsSync(path.join(root, relative))).toBe(false);
}

function create(root: string, url?: string) {
  const report = packager.inspectCheckpoint({ root, url });
  return packager.packageCheckpoint({ root, url, expectedSourceSha256: report.source_sha256 });
}

function zipContents(zip: Buffer) {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10), directoryOffset = zip.readUInt32LE(end + 16);
  expect(zip.readUInt32LE(end + 12) + directoryOffset).toBe(end);
  let offset = directoryOffset;
  const contents = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    expect(zip.readUInt16LE(offset + 10)).toBe(0);
    const bytes = zip.readUInt32LE(offset + 24), local = zip.readUInt32LE(offset + 42);
    const nameBytes = zip.readUInt16LE(offset + 28), extra = zip.readUInt16LE(offset + 30), comment = zip.readUInt16LE(offset + 32);
    const name = zip.subarray(offset + 46, offset + 46 + nameBytes).toString("utf8");
    expect(shared.safeRelativePath(name)).toBe(name);
    expect(contents.has(name)).toBe(false);
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    expect(zip.readUInt16LE(local + 8)).toBe(0);
    expect(zip.readUInt32LE(local + 22)).toBe(bytes);
    const localNameLength = zip.readUInt16LE(local + 26), localExtra = zip.readUInt16LE(local + 28);
    expect(zip.subarray(local + 30, local + 30 + localNameLength).toString("utf8")).toBe(name);
    const start = local + 30 + localNameLength + localExtra, data = zip.subarray(start, start + bytes);
    expect(start + bytes).toBeLessThanOrEqual(directoryOffset);
    expect(shared.crc32(data)).toBe(zip.readUInt32LE(offset + 16));
    expect(zip.readUInt32LE(local + 14)).toBe(shared.crc32(data));
    contents.set(name, data);
    offset += 46 + nameBytes + extra + comment;
  }
  expect(offset).toBe(end);
  return contents;
}

test("inspect is read-only and uses the explicit 103-file baseline plus the named additions", () => {
  const { root } = fixture();
  write(root, "frontend/lib/not-allowlisted.ts", "Do not include this unrelated source.\n");
  write(root, "frontend/.env.local", "PRIVATE_RUNTIME_CONFIG=do-not-read\n");
  const report = packager.inspectCheckpoint({ root });
  expect(report.counts).toMatchObject({ source_files: 115, unchanged: 103, modified: 0, added: 12 });
  expect(report).toMatchObject({ local_head: HEAD, branch: "codex/checkpoint-fixture", build_id: null,
    url: "http://127.0.0.1:3007", files_written: 0 });
  expect(report.source_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(report.earth_changes.map(file => file.path).sort()).toEqual([...packager.HANDOFF_PATHS, packager.BASELINE].sort());
  expect(JSON.stringify(report)).not.toContain("do-not-read");
  expect(JSON.stringify(report)).not.toContain("not-allowlisted.ts");
  expect(packager.inspectCheckpoint({ root }).source_sha256).toBe(report.source_sha256);
  noOutputs(root);
});

test("inspect identifies a modified baseline file without printing its content", () => {
  const { root } = fixture();
  const before = packager.inspectCheckpoint({ root });
  write(root, "frontend/lib/earth-sites.ts", "Changed fixture source content.\n");
  const after = packager.inspectCheckpoint({ root });
  expect(after.source_sha256).not.toBe(before.source_sha256);
  expect(after.counts.modified).toBe(1);
  expect(after.earth_changes).toContainEqual({ path: "frontend/lib/earth-sites.ts", status: "modified" });
  expect(JSON.stringify(after)).not.toContain("Changed fixture source content");
  noOutputs(root);
});

test("create emits a valid traceable ZIP from exactly the captured source, never build or private files", () => {
  const { root } = fixture();
  write(root, packager.BUILD_ID_PATH, "handoff-test-build-42\n");
  write(root, "frontend/.next-earth-handoff/server/private.js", "Never archive builds.\n");
  write(root, "backend/.env", "PRIVATE_RUNTIME_CONFIG=do-not-read\n");
  const info = create(root, "http://127.0.0.1:3008/");
  const zip = fs.readFileSync(path.join(root, packager.OUTPUT_PATHS.archive));
  const contents = zipContents(zip);
  const manifestBytes = fs.readFileSync(path.join(root, packager.OUTPUT_PATHS.manifest));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  expect(shared.sha256(zip)).toBe(info.archive_sha256);
  expect(shared.sha256(manifestBytes)).toBe(info.manifest_sha256);
  expect(info.archive_entries).toBe(116);
  expect(contents.size).toBe(116);
  expect(contents.get(packager.OUTPUT_PATHS.manifest)).toEqual(manifestBytes);
  expect(manifest).toMatchObject({ url: "http://127.0.0.1:3008", local_head: HEAD, build_id: "handoff-test-build-42" });
  expect(contents.has(packager.BUILD_ID_PATH)).toBe(false);
  expect(contents.has("backend/.env")).toBe(false);
  expect(contents.has(packager.OUTPUT_PATHS.info)).toBe(false);
  for (const file of manifest.files) {
    expect(contents.get(file.path)).toEqual(fs.readFileSync(path.join(root, file.path)));
    expect(shared.sha256(contents.get(file.path)!)).toBe(file.sha256);
  }
  expect(shared.sha256(Buffer.from(manifest.files.map((file: { path: string; sha256: string }) => `${file.path}\0${file.sha256}\n`).join("")))).toBe(info.source_sha256);
  expect(JSON.parse(fs.readFileSync(path.join(root, packager.OUTPUT_PATHS.info), "utf8"))).toEqual(info);
});

test("creation requires the inspected digest and refuses a changed source without publishing", () => {
  const { root } = fixture();
  expect(() => packager.packageCheckpoint({ root })).toThrow(/requires --expected-source-sha256/);
  expect(() => packager.packageCheckpoint({ root, expectedSourceSha256: "invalid" })).toThrow(/requires/);
  const expectedSourceSha256 = packager.inspectCheckpoint({ root }).source_sha256;
  write(root, "AGENTS.md", "Edited after inspection.\n");
  expect(() => packager.packageCheckpoint({ root, expectedSourceSha256 })).toThrow(/does not match/);
  noOutputs(root);
});

for (const output of ["archive", "manifest", "info"] as const) test(`existing ${output} is never overwritten and no other output is created`, () => {
  const { root } = fixture();
  const expectedSourceSha256 = packager.inspectCheckpoint({ root }).source_sha256;
  write(root, packager.OUTPUT_PATHS[output], "Existing checkpoint must survive.\n");
  expect(() => packager.packageCheckpoint({ root, expectedSourceSha256 })).toThrow(/already exists/);
  expect(fs.readFileSync(path.join(root, packager.OUTPUT_PATHS[output]), "utf8")).toBe("Existing checkpoint must survive.\n");
  for (const key of ["archive", "manifest", "info"] as const) if (key !== output) expect(fs.existsSync(path.join(root, packager.OUTPUT_PATHS[key]))).toBe(false);
});

test("shared canonical paths, source exclusions, blank templates and duplicate ZIP guards are reused", () => {
  for (const invalid of ["../outside.ts", "/outside.ts", "C:/outside.ts", "a\\b.ts", "a//b.ts", "a/./b.ts", "a/../b.ts", "a\0.ts"]) {
    expect(() => shared.safeRelativePath(invalid)).toThrow();
  }
  for (const invalid of ["frontend/.env.local", "backend/.env", "frontend/node_modules/x.js", "frontend/.next-earth-handoff/a.js",
    "private-photos/farm.jpg", "backend/credentials.json", "account.json", "frontend/public/photo.png", ".git/config", ".acreiq-local/run.json"]) {
    expect(() => shared.assertSourcePath(invalid)).toThrow();
  }
  expect(shared.assertSourcePath("frontend/app/api/[...path]/route.ts")).toBe("frontend/app/api/[...path]/route.ts");
  for (const value of ["", "''", '""', " # blank"]) expect(() => shared.assertTemplateContent("frontend/.env.example", `API_KEY=${value}`)).not.toThrow();
  expect(() => shared.assertTemplateContent("frontend/.env.example", "API_KEY=placeholder")).toThrow(/must be blank/);
  expect(() => shared.makeStoredZip([{ path: "a.ts", data: Buffer.from("a") }, { path: "A.ts", data: Buffer.from("b") }])).toThrow(/Duplicate/);
  expect(() => shared.makeStoredZip([{ path: "../a.ts", data: Buffer.from("a") }])).toThrow();
});

test("filled credential templates and recognizable keys in ordinary source are refused without values", () => {
  const cases = [
    ["frontend/.env.example", "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=", "fixture-template-value"],
    ["backend/.env.example", "GEMINI_API_KEY=", "fixture-template-value"],
    ["frontend/lib/earth-sites.ts", "// ", "AI" + "za" + "x".repeat(35)],
    ["frontend/lib/earth-sites.ts", "// ", "ya" + "29." + "x".repeat(35)],
    ["frontend/lib/earth-sites.ts", "// ", "-----BEGIN " + "PRIVATE KEY-----"],
    ["frontend/lib/earth-sites.ts", "// ", "AK" + "IA" + "X".repeat(16)],
    ["frontend/lib/earth-sites.ts", "// ", "gh" + "p_" + "x".repeat(36)],
    ["frontend/lib/earth-sites.ts", "// ", '"api_key": "' + "z".repeat(32) + '"'],
  ];
  for (const [relative, prefix, value] of cases) {
    const { root } = fixture();
    write(root, relative, prefix + value + "\n");
    let message = "";
    try { packager.inspectCheckpoint({ root }); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/credential|template/i);
    expect(message).not.toContain(value);
    noOutputs(root);
  }
});

test("a private file cannot be smuggled into a same-size baseline manifest", () => {
  const { root } = fixture();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, packager.BASELINE), "utf8"));
  manifest.files[0] = { path: "frontend/.env.local", sha256: "a".repeat(64) };
  write(root, packager.BASELINE, JSON.stringify(manifest));
  expect(() => packager.inspectCheckpoint({ root })).toThrow(/Excluded/);
  noOutputs(root);
});

test("malformed baselines and case-colliding paths fail closed", () => {
  for (const kind of ["json", "count", "digest", "duplicate", "escape", "reserved"] as const) {
    const { root } = fixture();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, packager.BASELINE), "utf8"));
    if (kind === "count") manifest.files.pop();
    if (kind === "digest") manifest.files[0].sha256 = "invalid";
    if (kind === "duplicate") manifest.files[1].path = manifest.files[0].path.toUpperCase();
    if (kind === "escape") manifest.files[0].path = "../outside.ts";
    if (kind === "reserved") manifest.files[0].path = "frontend/lib/aux.ts";
    write(root, packager.BASELINE, kind === "json" ? "{private-invalid-json" : JSON.stringify(manifest));
    expect(() => packager.inspectCheckpoint({ root })).toThrow();
    noOutputs(root);
  }
});

test("missing README and non-text source are clear failures, not partial checkpoints", () => {
  const { root } = fixture();
  fs.unlinkSync(path.join(root, "docs/checkpoints/earth-handoff/README.md"));
  expect(() => packager.inspectCheckpoint({ root })).toThrow(/Required checkpoint source is missing.*README/);
  write(root, "docs/checkpoints/earth-handoff/README.md", Buffer.from([0, 255, 1]));
  expect(() => packager.inspectCheckpoint({ root })).toThrow(/Non-text source/);
  noOutputs(root);
});

test("build identity is optional metadata, never a source identity or unfiltered credential channel", () => {
  const { root } = fixture();
  const before = packager.inspectCheckpoint({ root });
  write(root, packager.BUILD_ID_PATH, "fixture-build\n");
  expect(packager.inspectCheckpoint({ root })).toMatchObject({ source_sha256: before.source_sha256, build_id: "fixture-build" });
  const value = "AI" + "za" + "x".repeat(35);
  write(root, packager.BUILD_ID_PATH, value);
  let message = "";
  try { packager.inspectCheckpoint({ root }); } catch (error) { message = (error as Error).message; }
  expect(message).toMatch(/credential/i);
  expect(message).not.toContain(value);
  noOutputs(root);
});

test("only the documented local origins are accepted, never arbitrary URLs or credentials", () => {
  const { root } = fixture();
  for (const url of ["https://127.0.0.1:3007", "http://localhost:3007", "http://127.0.0.1:3004", "http://example.com:3007",
    "http://127.0.0.1:3007/?key=private-url-value", "http://private-url-value@127.0.0.1:3007/", "http://127.0.0.1:3007/earth"]) {
    let message = "";
    try { packager.inspectCheckpoint({ root, url }); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/Frontend URL/);
    expect(message).not.toContain("private-url-value");
  }
  noOutputs(root);
});

test("source and output junctions cannot escape the repository", () => {
  for (const target of ["source", "output"] as const) {
    const { root, directory } = fixture();
    const external = path.join(directory, "external");
    fs.mkdirSync(external);
    if (target === "source") {
      fs.renameSync(path.join(root, "frontend/lib"), path.join(external, "lib"));
      fs.symlinkSync(path.join(external, "lib"), path.join(root, "frontend/lib"), "junction");
      expect(() => packager.inspectCheckpoint({ root })).toThrow(/Symlinks and junctions/);
    } else {
      const expectedSourceSha256 = packager.inspectCheckpoint({ root }).source_sha256;
      fs.symlinkSync(external, path.join(root, ".acreiq-local"), "junction");
      expect(() => packager.packageCheckpoint({ root, expectedSourceSha256 })).toThrow(/Symlinks and junctions/);
    }
    expect(fs.existsSync(path.join(external, "earth-handoff"))).toBe(false);
  }
});

test("re-reading all hashes rejects a source edit during capture before any output is written", () => {
  const { root } = fixture();
  const expectedSourceSha256 = packager.inspectCheckpoint({ root }).source_sha256;
  const trigger = fs.statSync(path.join(root, SHARED_SCRIPT)).ino;
  const original = fs.readFileSync;
  let changed = false;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    const result = original(...args);
    if (!changed && typeof args[0] === "number" && fs.fstatSync(args[0]).ino === trigger) {
      changed = true;
      fs.appendFileSync(path.join(root, "AGENTS.md"), "Concurrent fixture edit.\n");
    }
    return result;
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try { expect(() => packager.packageCheckpoint({ root, expectedSourceSha256 })).toThrow(/Source changed during packaging/); }
  finally { fs.readFileSync = original; syncBuiltinESMExports(); }
  expect(changed).toBe(true);
  noOutputs(root);
});

test("a racing output writer is preserved and only this invocation's partial files roll back", () => {
  const { root } = fixture();
  const expectedSourceSha256 = packager.inspectCheckpoint({ root }).source_sha256;
  const original = fs.writeFileSync;
  let collided = false;
  fs.writeFileSync = ((...args: Parameters<typeof fs.writeFileSync>) => {
    const result = original(...args);
    if (!collided && typeof args[0] === "number") {
      collided = true;
      original(path.join(root, packager.OUTPUT_PATHS.manifest), "Concurrent writer's checkpoint.\n", { flag: "wx" });
    }
    return result;
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try { expect(() => packager.packageCheckpoint({ root, expectedSourceSha256 })).toThrow(/already exists/); }
  finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
  expect(collided).toBe(true);
  expect(fs.readFileSync(path.join(root, packager.OUTPUT_PATHS.manifest), "utf8")).toBe("Concurrent writer's checkpoint.\n");
  expect(fs.existsSync(path.join(root, packager.OUTPUT_PATHS.archive))).toBe(false);
  expect(fs.existsSync(path.join(root, packager.OUTPUT_PATHS.info))).toBe(false);
});

test("CLI supports explicit inspect/create, safe defaults and rejects unsupported modes without writing", () => {
  const { root } = fixture();
  const command = (...args: string[]) => execFileSync(process.execPath, [path.join(root, SCRIPT), ...args], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  expect(command()).toContain("No files generated");
  const report = JSON.parse(command("--inspect", "--url", "http://127.0.0.1:3008"));
  expect(report).toMatchObject({ mode: "inspect", files_written: 0, url: "http://127.0.0.1:3008" });
  for (const args of [["--create"], ["--inspect", "--create"], ["--inspect", "--inspect"], ["--inspect", "--output", "unapproved.zip"],
    ["--inspect", "--url"], ["--inspect", "--url", "http://127.0.0.1:3007", "--url", "http://127.0.0.1:3008"]]) expect(() => command(...args)).toThrow();
  noOutputs(root);
  const info = JSON.parse(command("--create", "--expected-source-sha256", report.source_sha256, "--url", "http://127.0.0.1:3008"));
  expect(info.source_sha256).toBe(report.source_sha256);
  expect(() => command("--create", "--expected-source-sha256", report.source_sha256)).toThrow();
});
