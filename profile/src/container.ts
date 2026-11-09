import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { DOCUMENT_FILES, ProfileValidationError, validateDocument, type DocumentName } from "./schema.ts";
import type { CaptureIndex, Manifest, ParameterSet, Profile, TestSignalSet } from "./types.ts";

export const CHECKSUM_FILE = "checksums.sha256";

const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\/-]+$/;

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function documentsOf(profile: Profile): Record<DocumentName, unknown> {
  return {
    manifest: profile.manifest,
    parameters: profile.parameters,
    "test-signals": profile.testSignals,
    captures: profile.captures,
  };
}

/** Validates all documents and cross references (capture files present, parameter indices known). */
export function validateProfile(profile: Profile): void {
  for (const [name, data] of Object.entries(documentsOf(profile)) as [DocumentName, unknown][]) {
    validateDocument(name, data);
  }

  const problems: string[] = [];
  const known = new Set(profile.parameters.parameters.map((p) => p.index));
  const ids = new Set<string>();

  for (const path of profile.files.keys()) {
    if (!SAFE_PATH.test(path)) problems.push(`unsafe file path: ${path}`);
  }
  for (const render of profile.captures.renders) {
    if (ids.has(render.id)) problems.push(`duplicate render id: ${render.id}`);
    ids.add(render.id);
    if (!profile.files.has(render.file)) problems.push(`missing capture file: ${render.file}`);
    for (const p of render.params) {
      if (!known.has(p.index)) problems.push(`render ${render.id} uses unknown parameter index ${p.index}`);
    }
  }

  if (problems.length > 0) throw new ProfileValidationError("profile is inconsistent", problems);
}

/** Serializes a profile into .vcprofile (ZIP) bytes. */
export function encodeProfile(profile: Profile): Uint8Array {
  validateProfile(profile);

  const entries = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(documentsOf(profile)) as [DocumentName, unknown][]) {
    entries.set(DOCUMENT_FILES[name], strToU8(JSON.stringify(data, null, 2) + "\n"));
  }
  for (const [path, data] of profile.files) {
    if (entries.has(path) || path === CHECKSUM_FILE) throw new ProfileValidationError(`reserved file path: ${path}`);
    entries.set(path, data);
  }

  const sorted = [...entries.keys()].sort();
  const checksums = sorted.map((path) => `${sha256Hex(entries.get(path)!)}  ${path}`).join("\n") + "\n";

  const zippable: Zippable = {};
  // manifest first so tools can identify the archive cheaply
  zippable[DOCUMENT_FILES.manifest] = entries.get(DOCUMENT_FILES.manifest)!;
  for (const path of sorted) {
    if (path !== DOCUMENT_FILES.manifest) zippable[path] = entries.get(path)!;
  }
  zippable[CHECKSUM_FILE] = strToU8(checksums);

  return zipSync(zippable, { level: 6 });
}

function parseChecksums(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) throw new ProfileValidationError(`malformed line in ${CHECKSUM_FILE}: ${line}`);
    result.set(match[2]!, match[1]!);
  }
  return result;
}

/** Parses .vcprofile bytes, verifying checksums and schemas. */
export function decodeProfile(bytes: Uint8Array): Profile {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    throw new ProfileValidationError(`not a valid ZIP archive: ${(error as Error).message}`);
  }

  const checksumData = entries[CHECKSUM_FILE];
  if (!checksumData) throw new ProfileValidationError(`missing ${CHECKSUM_FILE}`);
  const checksums = parseChecksums(strFromU8(checksumData));

  const problems: string[] = [];
  for (const [path, data] of Object.entries(entries)) {
    if (path === CHECKSUM_FILE || path.endsWith("/")) continue;
    const expected = checksums.get(path);
    if (!expected) problems.push(`file not listed in ${CHECKSUM_FILE}: ${path}`);
    else if (expected !== sha256Hex(data)) problems.push(`checksum mismatch: ${path}`);
  }
  for (const path of checksums.keys()) {
    if (!(path in entries)) problems.push(`listed file missing: ${path}`);
  }
  if (problems.length > 0) throw new ProfileValidationError("profile integrity check failed", problems);

  const readJson = (name: DocumentName): unknown => {
    const data = entries[DOCUMENT_FILES[name]];
    if (!data) throw new ProfileValidationError(`missing ${DOCUMENT_FILES[name]}`);
    try {
      return JSON.parse(strFromU8(data));
    } catch (error) {
      throw new ProfileValidationError(`${DOCUMENT_FILES[name]}: ${(error as Error).message}`);
    }
  };

  const documentPaths = new Set<string>([...Object.values(DOCUMENT_FILES), CHECKSUM_FILE]);
  const files = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(entries)) {
    if (!documentPaths.has(path) && !path.endsWith("/")) files.set(path, data);
  }

  const profile: Profile = {
    manifest: readJson("manifest") as Manifest,
    parameters: readJson("parameters") as ParameterSet,
    testSignals: readJson("test-signals") as TestSignalSet,
    captures: readJson("captures") as CaptureIndex,
    files,
  };
  validateProfile(profile);
  return profile;
}

export async function writeProfile(path: string, profile: Profile): Promise<void> {
  await writeFile(path, encodeProfile(profile));
}

export async function readProfile(path: string): Promise<Profile> {
  return decodeProfile(await readFile(path));
}
