import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  discoverProjectSkills,
  mergeSkillCatalog,
  planSkillMentions,
  readSkillFrontmatter,
} from "./SkillCatalog.ts";

const services = NodeServices.layer;

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempRoot = path.resolve(".t3");
  yield* fs.makeDirectory(tempRoot, { recursive: true });
  const cwd = yield* fs.makeTempDirectoryScoped({ directory: tempRoot, prefix: "skill-catalog-" });
  const writeSkill = (directory: string, contents: string) =>
    Effect.gen(function* () {
      const skillDirectory = path.join(cwd, ".agents", "skills", directory);
      yield* fs.makeDirectory(skillDirectory, { recursive: true });
      yield* fs.writeFileString(path.join(skillDirectory, "SKILL.md"), contents);
    });
  return { fs, path, cwd, writeSkill };
});

it.live("discovers project skills once from .agents/skills and skips malformed entries", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, path, cwd, writeSkill } = yield* setup;
      yield* writeSkill(
        "review",
        "---\nname: review\ndescription: Review a change\n---\n\nReview it.\n",
      );
      yield* writeSkill(
        "deploy",
        "---\nname: deploy\ndescription: Ship it\ndisable-model-invocation: true\n---\n\nShip it.\n",
      );
      yield* writeSkill("hidden", "---\nname: hidden\nuser-invocable: false\n---\n\nAgent only.\n");
      yield* writeSkill("broken", "no frontmatter here\n");
      yield* fs.writeFileString(path.join(cwd, ".agents", "skills", "stray.txt"), "ignored");

      const skills = yield* discoverProjectSkills(cwd);
      assert.deepEqual(
        skills.map((skill) => skill.name),
        ["deploy", "hidden", "review"],
      );
      assert.deepEqual(skills[0], {
        name: "deploy",
        path: path.join(cwd, ".agents", "skills", "deploy", "SKILL.md"),
        enabled: true,
        scope: "project",
        description: "Ship it",
        userInvocationOnly: true,
      });
      assert.equal(skills[1]?.userInvocable, false);
    }).pipe(Effect.provide(services)),
  ),
);

it.live("lets a project skill replace a provider skill of the same name", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, path, writeSkill } = yield* setup;
      yield* writeSkill("review", "---\nname: review\ndescription: Shared review\n---\n");
      const projectSkills = yield* discoverProjectSkills(cwd);
      const provider = (name: string, path: string): ServerProviderSkill => ({
        name,
        path,
        enabled: true,
        scope: "user",
      });
      const merged = mergeSkillCatalog(
        [provider("review", "/user/skills/review/SKILL.md"), provider("plan", "/user/plan")],
        projectSkills,
      );
      assert.deepEqual(
        merged.map((skill) => [skill.name, skill.path]),
        [
          ["plan", "/user/plan"],
          ["review", path.join(cwd, ".agents", "skills", "review", "SKILL.md")],
        ],
      );
      assert.equal(merged[1]?.scope, "project");
    }).pipe(Effect.provide(services)),
  ),
);

it.live("inlines a mentioned skill but leaves code, prices and native skills alone", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, writeSkill } = yield* setup;
      yield* writeSkill(
        "review",
        "---\nname: review\ndescription: Shared review\n---\n\nCheck the diff twice.\n",
      );
      const [review] = yield* discoverProjectSkills(cwd);
      assert.isDefined(review);
      const text = [
        "Please $review this. Costs $5 or $unknown.",
        "```",
        "$review",
        "```",
        "And `$review` inline.",
      ].join("\n");
      const expanded = yield* planSkillMentions(text, [review!]);
      assert.include(expanded, "Check the diff twice.");
      assert.notInclude(expanded, "Please $review");
      assert.include(expanded, "```\n$review\n```");
      assert.include(expanded, "`$review`");
      assert.include(expanded, "Costs $5 or $unknown.");
      assert.equal(yield* planSkillMentions(text, []), text);
    }).pipe(Effect.provide(services)),
  ),
);

it("parses only the frontmatter it can trust", () => {
  assert.deepEqual(readSkillFrontmatter("---\nname: a\ndescription: b\n---\nbody"), {
    name: "a",
    description: "b",
  });
  assert.isNull(readSkillFrontmatter("body only"));
  assert.isNull(readSkillFrontmatter("---\nname: [x\n---\n"));
  assert.deepEqual(readSkillFrontmatter("---\ndisable-model-invocation: yes\n---\n"), {
    userInvocationOnly: true,
  });
});
