import { readFileSync, writeFileSync } from "node:fs";

const bumps = ["patch", "minor", "major"];
const bump = process.argv[2];
if (!bumps.includes(bump)) {
  console.error("usage: node scripts/bump-version.mjs patch|minor|major");
  process.exit(1);
}

const packagePath = "package.json";
const packageText = readFileSync(packagePath, "utf8");
const parsed = JSON.parse(packageText);
const current = parsed.version;
if (typeof current !== "string" || !/^\d+\.\d+\.\d+$/.test(current)) {
  console.error(`unsupported version ${String(current)}`);
  process.exit(1);
}
const [majorText, minorText, patchText] = current.split(".");
const major = Number(majorText);
const minor = Number(minorText);
const patch = Number(patchText);
const next =
  bump === "major"
    ? `${major + 1}.0.0`
    : bump === "minor"
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;
const fromSpec = `poddrill@${current}`;
const toSpec = `poddrill@${next}`;
const versionFiles = ["README.md", ".agents/skills/poddrill/SKILL.md"];
for (const file of versionFiles) {
  const text = readFileSync(file, "utf8");
  const count = text.split(fromSpec).length - 1;
  if (count !== 1) {
    console.error(`${file} contains ${fromSpec} ${count} times`);
    process.exit(1);
  }
  writeFileSync(file, text.replaceAll(fromSpec, toSpec));
}
const versionField = `"version": "${current}"`;
if (!packageText.includes(versionField)) {
  console.error("package.json version field missing");
  process.exit(1);
}
writeFileSync(packagePath, packageText.replace(versionField, `"version": "${next}"`));
process.stdout.write(`${next}\n`);
