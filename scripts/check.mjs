// Zero-dependency pre-flight check. Catches the two failure classes that this
// codebase actually produces, both of which are invisible until runtime:
//
//   1. A typo'd identifier in a large file, which fails only when that exact
//      code path runs — sometimes several user actions deep.
//   2. A manifest or HTML reference to a file that isn't there. Chrome just
//      refuses to load the extension, without clearly naming the culprit.
//
// Deliberately not a linter: no dependencies means nothing to install, nothing
// to keep current, and no lockfile in a repo that otherwise has no build step.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// --strict promotes warnings to failures. Used by the release workflow: things
// that shouldn't block day-to-day pushes must still block a version you intend
// to upload. A CI that is permanently red is a CI nobody reads.
const strict = process.argv.includes("--strict");

const problems = [];
const warnings = [];

function fail(message) {
  problems.push(message);
}

function warn(message) {
  (strict ? problems : warnings).push(message);
}

// --- 1. Every .js parses -----------------------------------------------------
// Some files are ES modules (background, providers, options), some are classic
// scripts (content, popup). Rather than track which is which, accept a file that
// parses as either — we only care about syntax here, not module semantics.

function parses(file, asModule) {
  try {
    const args = asModule ? ["--input-type=module", "--check"] : ["--check"];
    execFileSync("node", args, {
      input: asModule ? readFileSync(file) : undefined,
      stdio: asModule ? ["pipe", "ignore", "pipe"] : ["ignore", "ignore", "pipe"],
      ...(asModule ? {} : { argv0: undefined })
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.stderr || err.message).trim() };
  }
}

function checkSyntax(file) {
  const asModule = parses(file, true);
  if (asModule.ok) return;

  // execFileSync with a file argument, for the classic-script attempt.
  try {
    execFileSync("node", ["--check", file], { stdio: ["ignore", "ignore", "pipe"] });
    return;
  } catch (err) {
    const detail = String(err.stderr || asModule.error).split("\n").slice(0, 4).join("\n");
    fail(`Syntax error in ${relative(root, file)}:\n${detail}`);
  }
}

function walk(dir, onFile) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, onFile);
    else onFile(full);
  }
}

walk(join(root, "src"), (file) => {
  if (file.endsWith(".js") || file.endsWith(".mjs")) checkSyntax(file);
});

// --- 2. Every referenced path exists ----------------------------------------

const manifestPath = join(root, "manifest.json");
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (err) {
  fail(`manifest.json is not valid JSON: ${err.message}`);
}

function requirePath(value, where) {
  if (!value) return;
  if (!existsSync(join(root, value))) {
    fail(`${where} references "${value}", which does not exist.`);
  }
}

if (manifest) {
  requirePath(manifest.background?.service_worker, "manifest.background");
  requirePath(manifest.action?.default_popup, "manifest.action");
  requirePath(manifest.options_page, "manifest.options_page");

  for (const [size, path] of Object.entries(manifest.icons || {})) {
    requirePath(path, `manifest.icons["${size}"]`);
  }

  for (const [i, script] of (manifest.content_scripts || []).entries()) {
    for (const file of script.js || []) requirePath(file, `manifest.content_scripts[${i}].js`);
    for (const file of script.css || []) requirePath(file, `manifest.content_scripts[${i}].css`);
  }

  // A Web Store submission is rejected outright without a 128px icon, and the
  // failure arrives after upload rather than here.
  if (!manifest.icons?.["128"]) {
    warn("manifest.icons is missing a 128px entry, which the Chrome Web Store requires.");
  }
}

// --- 3. Dynamic imports resolve and are web-accessible ----------------------
// The content entry pulls feature modules in via chrome.runtime.getURL(). Those
// paths are strings, so a rename breaks them silently — and if the target isn't
// listed in web_accessible_resources, Chrome blocks the import at runtime with an
// error buried in the page console rather than the extensions page.

const GET_URL = /chrome\.runtime\.getURL\(\s*["']([^"']+)["']\s*\)/g;

function webAccessible(path) {
  for (const entry of manifest?.web_accessible_resources || []) {
    for (const pattern of entry.resources || []) {
      const re = new RegExp(`^${pattern.split("*").map(escapeRe).join(".*")}$`);
      if (re.test(path)) return true;
    }
  }
  return false;
}

function escapeRe(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

walk(join(root, "src"), (file) => {
  if (!file.endsWith(".js")) return;
  const source = readFileSync(file, "utf8");
  for (const [, path] of source.matchAll(GET_URL)) {
    if (!existsSync(join(root, path))) {
      fail(`${relative(root, file)} imports "${path}", which does not exist.`);
    } else if (!webAccessible(path)) {
      fail(
        `${relative(root, file)} imports "${path}", which is not matched by ` +
          `web_accessible_resources. Chrome will block the import at runtime.`
      );
    }
  }
});

// --- 4. Static import specifiers resolve ------------------------------------
// Slices import across directories by relative path. Syntax checking cannot see
// this: a module with a wrong specifier parses perfectly and fails only when the
// browser tries to load it.

const IMPORT_FROM = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["'](\.[^"']+)["']/g;

walk(join(root, "src"), (file) => {
  if (!file.endsWith(".js")) return;
  const source = readFileSync(file, "utf8");
  for (const [, specifier] of source.matchAll(IMPORT_FROM)) {
    const target = join(dirname(file), specifier);
    if (!existsSync(target)) {
      fail(`${relative(root, file)} imports "${specifier}", which does not resolve.`);
    }
  }
});

// --- 5. HTML asset references resolve ---------------------------------------
// popup.html and options.html point at sibling CSS and JS. A renamed file leaves
// a page that loads blank with only a console error to explain it.

const ASSET_REF = /(?:src|href)\s*=\s*["']([^"']+)["']/g;

walk(join(root, "src"), (file) => {
  if (!file.endsWith(".html")) return;
  const html = readFileSync(file, "utf8");
  for (const [, ref] of html.matchAll(ASSET_REF)) {
    if (/^(https?:)?\/\//.test(ref) || ref.startsWith("#") || ref.startsWith("data:")) continue;
    if (!existsSync(join(dirname(file), ref))) {
      fail(`${relative(root, file)} references "${ref}", which does not exist.`);
    }
  }
});

// --- Report ------------------------------------------------------------------

for (const warning of warnings) {
  console.warn(`  ! ${warning}`);
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n`);
  for (const problem of problems) console.error(`  • ${problem}\n`);
  process.exit(1);
}

console.log(
  `All checks passed: syntax, manifest references, HTML assets.` +
    (warnings.length ? ` ${warnings.length} warning(s) above — fatal under --strict.` : "")
);
