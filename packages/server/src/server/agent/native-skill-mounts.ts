import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { NativeSkillMount } from "@getpaseo/protocol/agent-types";

const manifestSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    version: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();
const forbiddenEntries = new Set([
  "hooks",
  "hooks.json",
  "agents",
  "commands",
  ".mcp.json",
  "mcp.json",
  ".lsp.json",
  "lsp.json",
  "settings.json",
]);

export class NativeSkillMountError extends Error {
  readonly code: "native_skill_mounts_invalid" | "native_skill_mounts_unsupported";
  constructor(message: string, options?: ErrorOptions & { unsupported?: boolean }) {
    super(message, options);
    this.code = options?.unsupported
      ? "native_skill_mounts_unsupported"
      : "native_skill_mounts_invalid";
    this.name = "NativeSkillMountError";
  }
}

export interface ValidatedNativeSkillMount extends NativeSkillMount {
  skillsDirectory: string;
  pluginName: string;
  skillPaths: string[];
}

async function containedPath(root: string, candidate: string): Promise<string> {
  const resolved = await fs.realpath(candidate);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new NativeSkillMountError(`Skill mount path is outside its projection: ${candidate}`);
  }
  return resolved;
}

/** Validate a skill-only projection, never install a native plugin or modify provider homes. */
export async function validateNativeSkillMounts(
  mounts: readonly NativeSkillMount[] | undefined,
): Promise<ValidatedNativeSkillMount[]> {
  if (!mounts?.length) return [];
  const result: ValidatedNativeSkillMount[] = [];
  const directories = new Set<string>();
  const pluginNames = new Set<string>();
  for (const mount of mounts) {
    try {
      if (!path.isAbsolute(mount.directory))
        throw new NativeSkillMountError("Skill mount directory must be absolute");
      const directory = await fs.realpath(mount.directory);
      if (directories.has(directory)) continue;
      const entries = await fs.readdir(directory);
      if (entries.some((entry) => forbiddenEntries.has(entry.toLowerCase()))) {
        throw new NativeSkillMountError(
          `Native skill mounts may contain only skills, not hooks, agents, commands or MCP: ${directory}`,
        );
      }
      const manifestPath = await containedPath(
        directory,
        path.join(directory, ".claude-plugin", "plugin.json"),
      );
      if ((await fs.stat(manifestPath)).size > 16 * 1024)
        throw new NativeSkillMountError("Skill mount manifest is too large");
      const parsed = manifestSchema.safeParse(JSON.parse(await fs.readFile(manifestPath, "utf8")));
      if (!parsed.success)
        throw new NativeSkillMountError(
          `Skill mount manifest must contain only name, version and description: ${directory}`,
        );
      if (pluginNames.has(parsed.data.name))
        throw new NativeSkillMountError(`Duplicate skill mount plugin name: ${parsed.data.name}`);
      const skillsDirectory = await containedPath(directory, path.join(directory, "skills"));
      const children = await fs.readdir(skillsDirectory, { withFileTypes: true });
      const skillPaths: string[] = [];
      for (const child of children) {
        if (child.name.startsWith(".")) continue;
        const candidate = await containedPath(directory, path.join(skillsDirectory, child.name));
        if (!(await fs.stat(candidate)).isDirectory()) continue;
        if (!(await fs.readdir(candidate)).includes("SKILL.md"))
          throw new NativeSkillMountError(`Skill mount requires canonical SKILL.md: ${candidate}`);
        // Both native catalogs recognize canonical SKILL.md. Do not silently accept skill.md.
        const skillPath = await containedPath(directory, path.join(candidate, "SKILL.md"));
        if (!(await fs.stat(skillPath)).isFile())
          throw new NativeSkillMountError(`Skill mount requires a regular SKILL.md: ${candidate}`);
        skillPaths.push(skillPath);
      }
      directories.add(directory);
      pluginNames.add(parsed.data.name);
      result.push({ directory, skillsDirectory, pluginName: parsed.data.name, skillPaths });
    } catch (error) {
      if (error instanceof NativeSkillMountError) throw error;
      throw new NativeSkillMountError(
        `Invalid skill mount ${mount.directory}: expected a readable skill-only projection with skills/*/SKILL.md`,
        { cause: error },
      );
    }
  }
  return result;
}

/** A successful roots/set ACK alone does not prove that the provider discovered the files. */
export function assertNativeSkillCatalog(
  mounts: readonly ValidatedNativeSkillMount[],
  catalog: readonly unknown[],
): void {
  const loaded = new Set(
    catalog.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const skill = entry as Record<string, unknown>;
      return typeof skill.path === "string" && skill.enabled !== false
        ? [path.normalize(skill.path)]
        : [];
    }),
  );
  for (const mount of mounts) {
    for (const skillPath of mount.skillPaths) {
      if (!loaded.has(path.normalize(skillPath)))
        throw new NativeSkillMountError(`Native skill catalog did not load ${skillPath}`);
    }
  }
}
