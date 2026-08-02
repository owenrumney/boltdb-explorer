const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const pkgPath = path.join(ROOT, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

function parseSemver(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!m) return null;
  return { tag, parts: [Number(m[1]), Number(m[2]), Number(m[3])] };
}

function compareSemverDesc(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] !== b.parts[i]) return b.parts[i] - a.parts[i];
  }
  return 0;
}

function resolveReleaseTag() {
  const refTag = process.env.GITHUB_REF_NAME;
  if (parseSemver(refTag || "")) {
    return refTag;
  }

  try {
    const tags = execSync("git tag --points-at HEAD", {
      cwd: ROOT,
      encoding: "utf-8",
    })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(parseSemver)
      .filter(Boolean)
      .sort(compareSemverDesc);
    if (tags.length > 0) {
      return tags[0].tag;
    }
  } catch {
    // Fall through to package.json version.
  }

  return null;
}

// Sync version from release tag (v1.2.3 → 1.2.3) so package.json never drifts.
const tag = resolveReleaseTag();
if (tag) {
  const version = tag.replace(/^v/, "");
  if (pkg.version !== version) {
    console.log(`Updating package.json version: ${pkg.version} → ${version}`);
    pkg.version = version;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }
} else {
  console.log("No release tag found, using version from package.json.");
}

for (const file of fs.readdirSync(ROOT)) {
  if (file.endsWith(".vsix")) {
    fs.rmSync(path.join(ROOT, file), { force: true });
  }
}

execSync("npx vsce package", {
  cwd: ROOT,
  stdio: "inherit",
});

const vsixFiles = fs.readdirSync(ROOT).filter((file) => file.endsWith(".vsix"));

console.log("\nDone. .vsix files:");
for (const file of vsixFiles) {
  const stat = fs.statSync(path.join(ROOT, file));
  console.log(`  ${file} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
}

if (process.env.VSCODE_PUBLISH_TOKEN) {
  console.log("\nPublishing to VS Code Marketplace...");
  for (const file of vsixFiles) {
    const vsixPath = path.join(ROOT, file);
    console.log(`  ${file}`);
    try {
      execSync(`npx vsce publish --pat ${process.env.VSCODE_PUBLISH_TOKEN} --packagePath ${vsixPath}`, {
        cwd: ROOT,
        stdio: ["ignore", "inherit", "inherit"],
        timeout: 120_000,
      });
    } catch (err) {
      console.error(`  Failed to publish ${file} to VS Code Marketplace: ${err.message}`);
    }
  }
} else {
  console.log("\nSkipping VS Code Marketplace publish (no VSCODE_PUBLISH_TOKEN).");
}

if (process.env.OPVSX_PUBLISH_TOKEN) {
  console.log("\nPublishing to Open VSX...");
  for (const file of vsixFiles) {
    const vsixPath = path.join(ROOT, file);
    console.log(`  ${file}`);
    try {
      execSync(`npx ovsx publish ${vsixPath} -p ${process.env.OPVSX_PUBLISH_TOKEN}`, {
        cwd: ROOT,
        stdio: ["ignore", "inherit", "inherit"],
        timeout: 120_000,
      });
    } catch (err) {
      console.error(`  Failed to publish ${file} to Open VSX: ${err.message}`);
    }
  }
} else {
  console.log("\nSkipping Open VSX publish (no OPVSX_PUBLISH_TOKEN).");
}
