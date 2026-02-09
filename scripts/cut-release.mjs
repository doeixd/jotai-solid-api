import { execSync } from "node:child_process";

const allowed = new Set([
  "patch",
  "minor",
  "major",
  "prepatch",
  "preminor",
  "premajor",
  "prerelease",
]);

const releaseType = process.argv[2];

if (!releaseType || !allowed.has(releaseType)) {
  process.stderr.write(
    `Invalid or missing release type. Expected one of: ${Array.from(allowed).join(", ")}\n`,
  );
  process.exit(1);
}

execSync(`npm version ${releaseType} -m "chore(release): %s [skip ci]"`, {
  stdio: "inherit",
});
