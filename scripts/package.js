const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const pkgPath = path.join(ROOT, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

try {
  const tag = execSync("git describe --tags --exact-match", { cwd: ROOT, encoding: "utf-8" }).trim();
  const version = tag.replace(/^v/, "");
  if (/^\d+\.\d+\.\d+$/.test(version) && pkg.version !== version) {
    console.log(`Updating package.json version: ${pkg.version} → ${version}`);
    pkg.version = version;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }
} catch {
  console.log("No exact git tag found, using version from package.json.");
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
