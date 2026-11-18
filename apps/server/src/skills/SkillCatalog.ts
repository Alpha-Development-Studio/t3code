import type { ServerProviderSkill } from "@t3tools/contracts";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

/**
 * Project skills everyone can use. `.agents/skills` is already the provider-neutral folder
 * Antigravity reads, so a project keeps one copy instead of one per provider.
 */
export const PROJECT_SKILLS_DIRECTORY = ".agents/skills";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const parseBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "on"].includes(normalized)) return true;
  if (["false", "no", "off"].includes(normalized)) return false;
  return undefined;
};

export interface SkillFrontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly userInvocable?: boolean;
  readonly userInvocationOnly?: boolean;
}

/** Returns null when the file has no parseable frontmatter, so the skill is not advertised. */
export function readSkillFrontmatter(contents: string): SkillFrontmatter | null {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  const userInvocable = parseBoolean(record["user-invocable"]);
  const userInvocationOnly = parseBoolean(record["disable-model-invocation"]);
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(userInvocable === false ? { userInvocable: false } : {}),
    ...(userInvocationOnly === true ? { userInvocationOnly: true } : {}),
  };
}

/**
 * Reads `<cwd>/.agents/skills/<name>/SKILL.md`. A malformed skill is skipped rather than
 * guessed at, and names are deduplicated so two folders cannot claim the same token.
 */
export const discoverProjectSkills = Effect.fn("discoverProjectSkills")(function* (
  cwd: string,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(cwd, PROJECT_SKILLS_DIRECTORY);
  const entries = yield* fs
    .readDirectory(root)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const skills = new Map<string, ServerProviderSkill>();
  for (const entry of [...entries].sort()) {
    if (entry.startsWith(".")) continue;
    const skillPath = path.join(root, entry, "SKILL.md");
    const contents = yield* fs
      .readFileString(skillPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) continue;
    const frontmatter = readSkillFrontmatter(contents);
    if (frontmatter === null) continue;
    const name = (frontmatter.name ?? entry).trim();
    if (!name || skills.has(name)) continue;
    skills.set(name, {
      name,
      path: skillPath,
      enabled: true,
      scope: "project",
      ...(frontmatter.description ? { description: frontmatter.description } : {}),
      ...(frontmatter.userInvocationOnly ? { userInvocationOnly: true } : {}),
      ...(frontmatter.userInvocable === false ? { userInvocable: false } : {}),
    });
  }
  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
});

/**
 * One catalog for every provider. A project skill replaces a provider skill of the same name so
 * the composer offers one consistent set regardless of the selected agent.
 */
export function mergeSkillCatalog(
  providerSkills: ReadonlyArray<ServerProviderSkill>,
  projectSkills: ReadonlyArray<ServerProviderSkill>,
): ReadonlyArray<ServerProviderSkill> {
  const merged = new Map<string, ServerProviderSkill>();
  for (const skill of providerSkills) merged.set(skill.name, skill);
  for (const skill of projectSkills) merged.set(skill.name, skill);
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

const MAX_INLINE_SKILL_CHARS = 6_000;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/** Fenced blocks and inline spans, which a skill mention inside must not be expanded from. */
function codeRanges(text: string): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let offset = 0;
  let open: { readonly marker: string; readonly start: number } | undefined;
  for (const line of text.split("\n")) {
    const end = offset + line.length;
    const fence = FENCE_LINE.exec(line);
    if (open === undefined) {
      if (fence) open = { marker: fence[1]!, start: offset };
    } else if (
      fence &&
      fence[1]![0] === open.marker[0] &&
      fence[1]!.length >= open.marker.length &&
      line.trimEnd() === fence[1]
    ) {
      ranges.push({ start: open.start, end });
      open = undefined;
    }
    offset = end + 1;
  }
  if (open !== undefined) ranges.push({ start: open.start, end: text.length });
  let index = 0;
  while (index < text.length) {
    if (ranges.some((range) => index >= range.start && index < range.end)) {
      index++;
      continue;
    }
    if (text[index] !== "`") {
      index++;
      continue;
    }
    let run = 1;
    while (text[index + run] === "`") run++;
    const closing = text.indexOf("`".repeat(run), index + run);
    if (closing < 0) break;
    ranges.push({ start: index, end: closing + run });
    index = closing + run;
  }
  return ranges;
}

const skillBody = (contents: string) => {
  const match = FRONTMATTER_PATTERN.exec(contents);
  return (match === null ? contents : contents.slice(match[0].length)).trim();
};

/**
 * Rewrites `$name` mentions for providers without native support. Code blocks and materialized
 * skills are left untouched so the provider's own dispatch handles those mentions.
 */
export const planSkillMentions = Effect.fn("planSkillMentions")(function* (
  text: string,
  skills: ReadonlyArray<ServerProviderSkill>,
  options: { readonly nativeSkillNames?: ReadonlySet<string> } = {},
) {
  if (skills.length === 0) return text;
  const fs = yield* FileSystem.FileSystem;
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const code = codeRanges(text);
  const mentions = collectComposerInlineTokens(text).filter(
    (token) =>
      token.type === "skill" &&
      !code.some((range) => token.start < range.end && token.end > range.start) &&
      !options.nativeSkillNames?.has(token.value),
  );
  let result = text;
  for (const mention of mentions.toReversed()) {
    const skill = byName.get(mention.value);
    if (skill === undefined) continue;
    const contents = yield* fs
      .readFileString(skill.path)
      .pipe(Effect.orElseSucceed(() => undefined));
    const body = contents === undefined ? "" : skillBody(contents);
    const instruction =
      body !== "" && body.length <= MAX_INLINE_SKILL_CHARS
        ? `[The user invoked the "${skill.name}" skill. Follow these instructions from ${skill.path}:\n\n${body}]`
        : `[The user invoked the "${skill.name}" skill. Read and follow ${skill.path}.]`;
    result = `${result.slice(0, mention.start)}${instruction}${result.slice(mention.end)}`;
  }
  return result;
});
