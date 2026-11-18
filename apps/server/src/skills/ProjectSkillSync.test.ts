import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import { syncProjectSkills } from "./ProjectSkillSync.ts";

const services = NodeServices.layer;
const enabled = { T3_SYNC_PROJECT_SKILLS: "1" } as NodeJS.ProcessEnv;

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempRoot = path.resolve(".t3");
  yield* fs.makeDirectory(tempRoot, { recursive: true });
  const cwd = yield* fs.makeTempDirectoryScoped({ directory: tempRoot, prefix: "skill-sync-" });
  const writeSkill = (name: string, body: string) =>
    Effect.gen(function* () {
      const directory = path.join(cwd, ".agents", "skills", name);
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        path.join(directory, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name}\n---\n\n${body}\n`,
      );
    });
  return { fs, path, cwd, writeSkill };
});

it.live("does nothing unless the sync is explicitly enabled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, path, cwd, writeSkill } = yield* setup;
      yield* writeSkill("review", "Check twice.");
      const disabled = yield* syncProjectSkills({
        cwd,
        driver: "claudeAgent",
        environment: {} as NodeJS.ProcessEnv,
      });
      assert.deepEqual(disabled, { status: "disabled", synced: [], conflicts: [] });
      assert.isFalse(yield* fs.exists(path.join(cwd, ".claude", "skills")));

      const native = yield* syncProjectSkills({
        cwd,
        driver: "antigravity",
        environment: enabled,
      });
      assert.deepEqual(native, { status: "native", synced: [], conflicts: [] });
      assert.isFalse(yield* fs.exists(path.join(cwd, ".claude", "skills")));
    }).pipe(Effect.provide(services)),
  ),
);

it.live("never overwrites or prunes a copy listed only by a v1 manifest", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, path, cwd, writeSkill } = yield* setup;
      yield* writeSkill("review", "Shared version.");
      const target = path.join(cwd, ".claude", "skills", "review");
      const copy = path.join(target, "SKILL.md");
      const manifest = path.join(cwd, ".claude", "skills", ".t3-managed.json");
      yield* fs.makeDirectory(target, { recursive: true });
      yield* fs.writeFileString(copy, "UNVERIFIED COPY\n");
      yield* fs.writeFileString(
        manifest,
        `${JSON.stringify({ version: 1, skills: ["review"] })}\n`,
      );

      const update = yield* syncProjectSkills({
        cwd,
        driver: "claudeAgent",
        environment: enabled,
      });
      assert.deepEqual(update.conflicts, ["review"]);
      assert.equal(yield* fs.readFileString(copy), "UNVERIFIED COPY\n");

      // Keep the v1 manifest in place for the removal pass, so the copy is unverified there too.
      yield* fs.writeFileString(
        manifest,
        `${JSON.stringify({ version: 1, skills: ["review"] })}\n`,
      );
      yield* fs.remove(path.join(cwd, ".agents", "skills", "review"), { recursive: true });
      const removal = yield* syncProjectSkills({
        cwd,
        driver: "claudeAgent",
        environment: enabled,
      });
      assert.equal(removal.status, "no-source");
      assert.equal(yield* fs.readFileString(copy), "UNVERIFIED COPY\n");
    }).pipe(Effect.provide(services)),
  ),
);

it.live("logs conflicting copies raised by a sync", () => {
  const messages: string[] = [];
  const logger = Logger.make(({ message }) => {
    messages.push(Array.isArray(message) ? message.map(String).join(" ") : String(message));
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const { fs, path, cwd, writeSkill } = yield* setup;
      yield* writeSkill("review", "First version.");
      yield* syncProjectSkills({ cwd, driver: "claudeAgent", environment: enabled });
      yield* fs.writeFileString(
        path.join(cwd, ".claude", "skills", "review", "SKILL.md"),
        "LOCAL EDIT\n",
      );
      yield* writeSkill("review", "Second version.");
      yield* syncProjectSkills({
        cwd,
        driver: "claudeAgent",
        environment: enabled,
      });
      assert.isTrue(
        messages.some((message) =>
          message.includes("Project skill sync left conflicting copies untouched."),
        ),
      );
    }).pipe(Effect.provide(services), Effect.withLogger(logger)),
  );
});

it.live("materializes the shared catalog into the provider's project folder", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, path, cwd, writeSkill } = yield* setup;
      yield* writeSkill("review", "Check twice.");
      yield* writeSkill("deploy", "Ship it.");
      const first = yield* syncProjectSkills({ cwd, driver: "claudeAgent", environment: enabled });
      assert.equal(first.status, "synced");
      assert.deepEqual(first.synced, ["deploy", "review"]);
      assert.deepEqual(first.conflicts, []);
      const target = path.join(cwd, ".claude", "skills");
      assert.include(
        yield* fs.readFileString(path.join(target, "review", "SKILL.md")),
        "Check twice.",
      );
      assert.isTrue(yield* fs.exists(path.join(target, ".t3-managed.json")));
      const manifest = JSON.parse(yield* fs.readFileString(path.join(target, ".t3-managed.json")));
      assert.equal(manifest.version, 2);
      assert.deepEqual(
        manifest.skills.map((skill: { readonly name: string }) => skill.name),
        ["deploy", "review"],
      );
      for (const skill of manifest.skills as ReadonlyArray<{ readonly digest: string }>) {
        assert.match(skill.digest, /^[a-f0-9]{64}$/);
      }

      // A rerun over its own output is a no-op, not a conflict.
      const second = yield* syncProjectSkills({ cwd, driver: "claudeAgent", environment: enabled });
      assert.deepEqual(second.synced, ["deploy", "review"]);
      assert.deepEqual(second.conflicts, []);
    }).pipe(Effect.provide(services)),
  ),
);

it.live("leaves a user's own provider skill untouched and reports the conflict", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, path, cwd, writeSkill } = yield* setup;
      yield* writeSkill("review", "Shared review.");
      yield* writeSkill("deploy", "Ship it.");
      const userSkill = path.join(cwd, ".claude", "skills", "review", "SKILL.md");
      yield* fs.makeDirectory(path.dirname(userSkill), { recursive: true });
      yield* fs.writeFileString(userSkill, "MY OWN REVIEW\n");

      const report = yield* syncProjectSkills({
        cwd,
        driver: "claudeAgent",
        environment: enabled,
      });
      assert.deepEqual(report.conflicts, ["review"]);
      assert.deepEqual(report.synced, ["deploy"]);
      assert.equal(yield* fs.readFileString(userSkill), "MY OWN REVIEW\n");
      assert.isTrue(yield* fs.exists(path.join(cwd, ".claude", "skills", "deploy", "SKILL.md")));
    }).pipe(Effect.provide(services)),
  ),
);

it.live("updates a skill it owns and copies files beside SKILL.md", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, path, cwd } = yield* setup;
      const source = path.join(cwd, ".agents", "skills", "review");
      yield* fs.makeDirectory(path.join(source, "references"), { recursive: true });
      yield* fs.writeFileString(
        path.join(source, "SKILL.md"),
        "---\nname: review\n---\n\nFirst version.\n",
      );
      yield* fs.writeFileString(path.join(source, "references", "checklist.md"), "Checklist\n");
      yield* syncProjectSkills({ cwd, driver: "claudeAgent", environment: enabled });

      yield* fs.writeFileString(
        path.join(source, "SKILL.md"),
        "---\nname: review\n---\n\nSecond version.\n",
      );
      const report = yield* syncProjectSkills({
        cwd,
        driver: "claudeAgent",
        environment: enabled,
      });
      assert.deepEqual(report.conflicts, []);
      const target = path.join(cwd, ".claude", "skills", "review");
      assert.include(yield* fs.readFileString(path.join(target, "SKILL.md")), "Second version.");
      assert.equal(
        yield* fs.readFileString(path.join(target, "references", "checklist.md")),
        "Checklist\n",
      );
    }).pipe(Effect.provide(services)),
  ),
);

it.live("preserves an edited tracked copy when its shared skill changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, path, cwd, writeSkill } = yield* setup;
      yield* writeSkill("review", "First version.");
      yield* syncProjectSkills({ cwd, driver: "claudeAgent", environment: enabled });
      const target = path.join(cwd, ".claude", "skills", "review", "SKILL.md");
      const manifestPath = path.join(cwd, ".claude", "skills", ".t3-managed.json");
      const before = JSON.parse(yield* fs.readFileString(manifestPath)).skills;
      yield* fs.writeFileString(target, "LOCAL EDIT\n");
      yield* writeSkill("review", "Second version.");

      const report = yield* syncProjectSkills({
        cwd,
        driver: "claudeAgent",
        environment: enabled,
      });
      assert.deepEqual(report.conflicts, ["review"]);
      assert.deepEqual(report.synced, []);
      assert.equal(yield* fs.readFileString(target), "LOCAL EDIT\n");
      assert.deepEqual(JSON.parse(yield* fs.readFileString(manifestPath)).skills, before);
    }).pipe(Effect.provide(services)),
  ),
);

it.live("preserves an edited tracked copy when its shared skill is removed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, path, cwd, writeSkill } = yield* setup;
      yield* writeSkill("review", "Check twice.");
      yield* syncProjectSkills({ cwd, driver: "claudeAgent", environment: enabled });
      const target = path.join(cwd, ".claude", "skills", "review", "SKILL.md");
      yield* fs.writeFileString(target, "LOCAL EDIT\n");
      yield* fs.remove(path.join(cwd, ".agents", "skills", "review"), { recursive: true });

      const report = yield* syncProjectSkills({
        cwd,
        driver: "claudeAgent",
        environment: enabled,
      });
      assert.equal(report.status, "no-source");
      assert.deepEqual(report.conflicts, ["review"]);
      assert.equal(yield* fs.readFileString(target), "LOCAL EDIT\n");
      assert.deepEqual(
        JSON.parse(
          yield* fs.readFileString(path.join(cwd, ".claude", "skills", ".t3-managed.json")),
        ).skills.map((skill: { readonly name: string }) => skill.name),
        ["review"],
      );
    }).pipe(Effect.provide(services)),
  ),
);

it.live("preserves an edited tracked copy when its shared skill is renamed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, path, cwd, writeSkill } = yield* setup;
      yield* writeSkill("review", "Check twice.");
      yield* syncProjectSkills({ cwd, driver: "claudeAgent", environment: enabled });
      const target = path.join(cwd, ".claude", "skills", "review", "SKILL.md");
      yield* fs.writeFileString(target, "LOCAL EDIT\n");
      const source = path.join(cwd, ".agents", "skills");
      yield* fs.rename(path.join(source, "review"), path.join(source, "inspect"));
      yield* fs.writeFileString(
        path.join(source, "inspect", "SKILL.md"),
        "---\nname: inspect\ndescription: inspect\n---\n\nCheck twice.\n",
      );

      const report = yield* syncProjectSkills({
        cwd,
        driver: "claudeAgent",
        environment: enabled,
      });
      assert.deepEqual(report.conflicts, ["review"]);
      assert.deepEqual(report.synced, ["inspect"]);
      assert.equal(yield* fs.readFileString(target), "LOCAL EDIT\n");
      assert.include(
        yield* fs.readFileString(path.join(cwd, ".claude", "skills", "inspect", "SKILL.md")),
        "Check twice.",
      );
      assert.deepEqual(
        JSON.parse(
          yield* fs.readFileString(path.join(cwd, ".claude", "skills", ".t3-managed.json")),
        ).skills.map((skill: { readonly name: string }) => skill.name),
        ["inspect", "review"],
      );
    }).pipe(Effect.provide(services)),
  ),
);

it.live("removes copies whose shared source skill disappears", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, path, cwd, writeSkill } = yield* setup;
      yield* writeSkill("review", "Check twice.");
      yield* writeSkill("deploy", "Ship it.");
      const target = path.join(cwd, ".claude", "skills");
      const userSkill = path.join(target, "private", "SKILL.md");
      yield* fs.makeDirectory(path.dirname(userSkill), { recursive: true });
      yield* fs.writeFileString(userSkill, "PRIVATE\n");
      yield* syncProjectSkills({ cwd, driver: "claudeAgent", environment: enabled });

      yield* fs.remove(path.join(cwd, ".agents", "skills", "review"), { recursive: true });
      const report = yield* syncProjectSkills({
        cwd,
        driver: "claudeAgent",
        environment: enabled,
      });
      assert.deepEqual(report.synced, ["deploy"]);
      assert.isFalse(yield* fs.exists(path.join(target, "review")));
      assert.isTrue(yield* fs.exists(path.join(target, "deploy", "SKILL.md")));
      assert.equal(yield* fs.readFileString(userSkill), "PRIVATE\n");
      assert.deepEqual(
        JSON.parse(yield* fs.readFileString(path.join(target, ".t3-managed.json"))).skills.map(
          (skill: { readonly name: string }) => skill.name,
        ),
        ["deploy"],
      );

      // Removing the last shared skill still prunes its tracked copy.
      yield* fs.remove(path.join(cwd, ".agents", "skills", "deploy"), { recursive: true });
      yield* syncProjectSkills({ cwd, driver: "claudeAgent", environment: enabled });
      assert.isFalse(yield* fs.exists(path.join(target, "deploy")));
      assert.equal(yield* fs.readFileString(userSkill), "PRIVATE\n");
      assert.deepEqual(
        JSON.parse(yield* fs.readFileString(path.join(target, ".t3-managed.json"))).skills,
        [],
      );
    }).pipe(Effect.provide(services)),
  ),
);

it.live("moves a tracked copy when a shared skill is renamed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, path, cwd, writeSkill } = yield* setup;
      yield* writeSkill("review", "Check twice.");
      yield* syncProjectSkills({ cwd, driver: "claudeAgent", environment: enabled });
      const source = path.join(cwd, ".agents", "skills");
      const target = path.join(cwd, ".claude", "skills");
      yield* fs.rename(path.join(source, "review"), path.join(source, "inspect"));
      yield* fs.writeFileString(
        path.join(source, "inspect", "SKILL.md"),
        "---\nname: inspect\ndescription: inspect\n---\n\nCheck twice.\n",
      );

      const report = yield* syncProjectSkills({
        cwd,
        driver: "claudeAgent",
        environment: enabled,
      });
      assert.deepEqual(report.synced, ["inspect"]);
      assert.deepEqual(report.conflicts, []);
      assert.isFalse(yield* fs.exists(path.join(target, "review")));
      assert.include(
        yield* fs.readFileString(path.join(target, "inspect", "SKILL.md")),
        "Check twice.",
      );
      assert.deepEqual(
        JSON.parse(yield* fs.readFileString(path.join(target, ".t3-managed.json"))).skills.map(
          (skill: { readonly name: string }) => skill.name,
        ),
        ["inspect"],
      );
    }).pipe(Effect.provide(services)),
  ),
);

it.live("syncs OpenCode's own project skill folder too", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, path, cwd, writeSkill } = yield* setup;
      yield* writeSkill("review", "Check twice.");
      const report = yield* syncProjectSkills({
        cwd,
        driver: "opencode",
        environment: enabled,
      });
      assert.equal(report.target, path.join(cwd, ".opencode", "skills"));
      assert.deepEqual(report.synced, ["review"]);
      assert.isTrue(yield* fs.exists(path.join(cwd, ".opencode", "skills", "review", "SKILL.md")));
    }).pipe(Effect.provide(services)),
  ),
);
