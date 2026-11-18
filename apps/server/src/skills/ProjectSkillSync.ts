// @effect-diagnostics nodeBuiltinImport:off - sha256 over the copied skill tree.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { PROJECT_SKILLS_DIRECTORY } from "./SkillCatalog.ts";

/**
 * Opt-in switch. Materializing writes into the project's own provider folders, so it stays off
 * unless the user asks for it.
 */
export const PROJECT_SKILL_SYNC_ENV = "T3_SYNC_PROJECT_SKILLS";

/** Where each harness looks for project skills that are not the shared `.agents/skills` folder. */
export const PROJECT_SKILL_TARGETS: ReadonlyMap<string, string> = new Map([
  ["claudeAgent", ".claude/skills"],
  ["opencode", ".opencode/skills"],
]);

export const isProjectSkillSyncEnabled = (environment: NodeJS.ProcessEnv): boolean =>
  environment[PROJECT_SKILL_SYNC_ENV] === "1";

const MANIFEST = ".t3-managed.json";

const ManagedSkill = Schema.Struct({
  name: Schema.String,
  digest: Schema.String,
});
const Manifest = Schema.Struct({
  version: Schema.Literal(2),
  skills: Schema.Array(ManagedSkill),
});
const ManifestJson = Schema.fromJsonString(Manifest);
const decodeManifest = Schema.decodeUnknownOption(ManifestJson);
const encodeManifest = Schema.encodeSync(Schema.fromJsonString(Manifest));

export interface ProjectSkillSyncReport {
  readonly status: "disabled" | "native" | "no-source" | "synced";
  readonly target?: string;
  readonly synced: ReadonlyArray<string>;
  readonly conflicts: ReadonlyArray<string>;
}

export interface ProjectSkillSyncInput {
  readonly cwd: string;
  readonly driver: string;
  readonly environment: NodeJS.ProcessEnv;
}

const EMPTY: ProjectSkillSyncReport = { status: "disabled", synced: [], conflicts: [] };

const readManifest = Effect.fnUntraced(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* fs
    .readFileString(path.join(target, MANIFEST))
    .pipe(Effect.orElseSucceed(() => undefined));
  if (contents === undefined) return new Map<string, string>();
  // A hand-edited or older manifest is ignored rather than trusted for destructive writes. Its
  // copies therefore remain unowned and are treated as conflicts instead of being updated.
  return Option.match(decodeManifest(contents), {
    onNone: () => new Map<string, string>(),
    onSome: (manifest) =>
      new Map(
        manifest.skills
          .filter((skill) => skill.name !== "")
          .map((skill) => [skill.name, skill.digest] as const),
      ),
  });
});

const writeManifest = Effect.fnUntraced(function* (
  target: string,
  managed: ReadonlyMap<string, string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const targetExists = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false));
  if (!targetExists && managed.size === 0) return;
  yield* fs.makeDirectory(target, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined));
  const skills = [...managed]
    .map(([name, digest]) => ({ name, digest }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const manifest = encodeManifest({ version: 2 as const, skills });
  yield* fs
    .writeFileString(path.join(target, MANIFEST), `${manifest}\n`)
    .pipe(Effect.orElseSucceed(() => undefined));
});

/** A deterministic digest of every file and directory a copied skill contains. */
const treeDigest = Effect.fnUntraced(function* (
  root: string,
): Effect.fn.Return<string, PlatformError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hash = NodeCrypto.createHash("sha256");
  const visit = Effect.fnUntraced(function* (
    directory: string,
    relative: string,
  ): Effect.fn.Return<void, PlatformError, FileSystem.FileSystem | Path.Path> {
    for (const entry of [...(yield* fs.readDirectory(directory))].sort()) {
      const source = path.join(directory, entry);
      const child = relative === "" ? entry : `${relative}/${entry}`;
      const stat = yield* fs.stat(source);
      if (stat.type === "Directory") {
        hash.update(`D\0${child}\0`);
        yield* visit(source, child);
      } else if (stat.type === "File") {
        const bytes = yield* fs.readFile(source);
        hash.update(`F\0${child}\0${bytes.byteLength}\0`);
        hash.update(bytes);
      }
    }
  });
  yield* visit(root, "");
  return hash.digest("hex");
});

/** Copies a skill folder, including any scripts or references beside SKILL.md. */
const copyTree = Effect.fnUntraced(function* (
  from: string,
  to: string,
): Effect.fn.Return<void, PlatformError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(to, { recursive: true });
  for (const entry of yield* fs.readDirectory(from)) {
    const source = path.join(from, entry);
    const destination = path.join(to, entry);
    const stat = yield* fs.stat(source);
    if (stat.type === "Directory") yield* copyTree(source, destination);
    else if (stat.type === "File") yield* fs.copyFile(source, destination);
  }
});

/** Skills already sitting in the provider's own project folder, so its loader resolves them. */
export const materializedProjectSkillNames = Effect.fn("materializedProjectSkillNames")(
  function* (input: {
    readonly cwd: string;
    readonly driver: string;
  }): Effect.fn.Return<ReadonlySet<string>, never, FileSystem.FileSystem | Path.Path> {
    const relativeTarget = PROJECT_SKILL_TARGETS.get(input.driver);
    if (relativeTarget === undefined) return new Set<string>();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(input.cwd, relativeTarget);
    const entries = yield* fs
      .readDirectory(target)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const names = yield* Effect.filter(entries, (entry) =>
      fs.exists(path.join(target, entry, "SKILL.md")).pipe(Effect.orElseSucceed(() => false)),
    );
    return new Set(names);
  },
);

/**
 * Copies shared skills into the harness folder. Conflicting copies are preserved and reported;
 * tracked copies are updated or removed only while their recorded digest still matches.
 */
const syncProjectSkillsUnlogged = Effect.fn("syncProjectSkills")(function* (
  input: ProjectSkillSyncInput,
): Effect.fn.Return<ProjectSkillSyncReport, never, FileSystem.FileSystem | Path.Path> {
  if (!isProjectSkillSyncEnabled(input.environment)) return EMPTY;
  const relativeTarget = PROJECT_SKILL_TARGETS.get(input.driver);
  if (relativeTarget === undefined) return { status: "native", synced: [], conflicts: [] };
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = path.join(input.cwd, PROJECT_SKILLS_DIRECTORY);
  const target = path.join(input.cwd, relativeTarget);
  const entries = yield* fs.readDirectory(source).pipe(Effect.option);
  if (Option.isNone(entries)) {
    // A missing source means every shared skill was deleted; an unreadable one is not evidence.
    const sourceExists = yield* fs.exists(source).pipe(Effect.orElseSucceed(() => true));
    if (sourceExists) return { status: "no-source", target, synced: [], conflicts: [] };
  }
  const skillDirectories = Option.isNone(entries) ? ([] as ReadonlyArray<string>) : entries.value;
  const skills = yield* Effect.filter(skillDirectories, (entry) =>
    fs.exists(path.join(source, entry, "SKILL.md")).pipe(Effect.orElseSucceed(() => false)),
  );

  const managed = yield* readManifest(target);

  const synced: string[] = [];
  const conflicts: string[] = [];

  for (const name of [...managed.keys()].sort()) {
    if (skills.includes(name)) continue;
    const destination = path.join(target, name);
    const current = yield* treeDigest(destination).pipe(Effect.option);
    if (Option.isNone(current)) {
      const destinationExists = yield* fs
        .exists(destination)
        .pipe(Effect.orElseSucceed(() => true));
      if (destinationExists) {
        conflicts.push(name);
        continue;
      }
      managed.delete(name);
      continue;
    }
    if (current.value !== managed.get(name)) {
      conflicts.push(name);
      continue;
    }
    const removed = yield* fs.remove(destination, { recursive: true, force: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    // Keep a failed entry so a later sync retries instead of forgetting the copy.
    if (removed) managed.delete(name);
    else conflicts.push(name);
  }

  if (skills.length === 0) {
    yield* writeManifest(target, managed);
    return { status: "no-source", target, synced: [], conflicts };
  }

  for (const name of [...skills].sort()) {
    const destination = path.join(target, name);
    const destinationExists = yield* fs.exists(destination).pipe(Effect.orElseSucceed(() => true));
    if (destinationExists) {
      const expected = managed.get(name);
      const current = yield* treeDigest(destination).pipe(Effect.option);
      if (expected === undefined || Option.isNone(current) || current.value !== expected) {
        conflicts.push(name);
        continue;
      }
    }
    const copied = yield* copyTree(path.join(source, name), destination).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!copied) {
      conflicts.push(name);
      continue;
    }
    const digest = yield* treeDigest(destination).pipe(Effect.option);
    if (Option.isNone(digest)) {
      conflicts.push(name);
      continue;
    }
    managed.set(name, digest.value);
    synced.push(name);
  }

  yield* writeManifest(target, managed);
  return { status: "synced", target, synced, conflicts };
});

/** Runs the sync and logs every copy it had to leave untouched for the user to resolve. */
export const syncProjectSkills = (input: ProjectSkillSyncInput) =>
  syncProjectSkillsUnlogged(input).pipe(
    Effect.tap((report) =>
      report.conflicts.length === 0
        ? Effect.void
        : Effect.logWarning("Project skill sync left conflicting copies untouched.", {
            cwd: input.cwd,
            driver: input.driver,
            target: report.target,
            conflicts: report.conflicts,
          }),
    ),
  );
