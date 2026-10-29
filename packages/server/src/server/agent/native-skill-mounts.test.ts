import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateNativeSkillMounts, assertNativeSkillCatalog } from "./native-skill-mounts.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-skills-"));
  directories.push(directory);
  await mkdir(path.join(directory, ".claude-plugin"));
  await mkdir(path.join(directory, "skills", "example"), { recursive: true });
  await writeFile(
    path.join(directory, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0" }),
  );
  await writeFile(
    path.join(directory, "skills", "example", "SKILL.md"),
    "---\nname: example\ndescription: fixture\n---\nOnly in the body.",
  );
  return directory;
}

test("validates only enabled skill roots and requires native catalog identity", async () => {
  const directory = await fixture();
  await mkdir(path.join(directory, "disabled-skills", "disabled"), { recursive: true });
  await writeFile(path.join(directory, "disabled-skills", "disabled", "SKILL.md"), "disabled");
  const mounts = await validateNativeSkillMounts([{ directory }]);
  expect(mounts).toHaveLength(1);
  expect(mounts[0]!.skillPaths).toEqual([
    path.join(mounts[0]!.directory, "skills", "example", "SKILL.md"),
  ]);
  expect(() => assertNativeSkillCatalog(mounts, [])).toThrow(/catalog/);
  expect(() =>
    assertNativeSkillCatalog(mounts, [
      { name: "example", path: mounts[0]!.skillPaths[0], enabled: false },
    ]),
  ).toThrow(/catalog/);
  expect(() =>
    assertNativeSkillCatalog(mounts, [{ name: "example", path: mounts[0]!.skillPaths[0] }]),
  ).not.toThrow();
});

test.each(["hooks", "agents", "commands", ".mcp.json", ".lsp.json", "settings.json"])(
  "rejects executable plugin surface %s",
  async (entry) => {
    const directory = await fixture();
    await writeFile(path.join(directory, entry), "{}");
    await expect(validateNativeSkillMounts([{ directory }])).rejects.toThrow(/only skills/);
  },
);

test("rejects manifest capabilities, missing roots, lowercase-only skills and escaped symlinks", async () => {
  const directory = await fixture();
  await writeFile(
    path.join(directory, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "fixture", hooks: {} }),
  );
  await expect(validateNativeSkillMounts([{ directory }])).rejects.toThrow(/manifest/);
  await expect(
    validateNativeSkillMounts([{ directory: path.join(directory, "missing") }]),
  ).rejects.toThrow(/skill mount/i);
  await writeFile(
    path.join(directory, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "fixture" }),
  );
  const source = path.join(directory, "skills", "example", "SKILL.md");
  await rm(source);
  await writeFile(path.join(directory, "skills", "example", "skill.md"), "lowercase");
  await expect(validateNativeSkillMounts([{ directory }])).rejects.toThrow(/SKILL.md/);
  const other = await fixture();
  await rm(path.join(directory, "skills", "example"), { recursive: true });
  await symlink(path.join(other, "skills", "example"), path.join(directory, "skills", "example"));
  await expect(validateNativeSkillMounts([{ directory }])).rejects.toThrow(/outside/);
});
