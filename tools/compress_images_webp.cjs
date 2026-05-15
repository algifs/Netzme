#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");

let sharp;
try {
  sharp = require("sharp");
} catch (error) {
  sharp = require("/Users/algifari/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp");
}

const IMAGE_EXTENSIONS = new Set([".webp", ".png", ".jpg", ".jpeg"]);

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    out: "_compressed_assets_webp",
    quality: 82,
    effort: 6,
    report: "_compressed_assets_webp_report.csv",
    preserveExtension: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--root" && value) {
      args.root = value;
      index += 1;
    } else if (key === "--out" && value) {
      args.out = value;
      index += 1;
    } else if (key === "--quality" && value) {
      args.quality = Number(value);
      index += 1;
    } else if (key === "--effort" && value) {
      args.effort = Number(value);
      index += 1;
    } else if (key === "--report" && value) {
      args.report = value;
      index += 1;
    } else if (key === "--preserve-extension") {
      args.preserveExtension = true;
    } else if (key === "--help") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Compress image assets to WebP in a mirrored output folder.

Options:
  --root <path>       Folder to scan. Default: current folder
  --out <path>        Output folder. Default: _compressed_assets_webp
  --quality <0-100>   WebP quality. Default: 82
  --effort <0-6>      Encoder effort. Default: 6
  --report <path>     CSV report path. Default: _compressed_assets_webp_report.csv
  --preserve-extension
                      Keep .webp/.png/.jpg extensions instead of converting all to WebP`);
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) {
      return `${value.toFixed(2)} ${unit}`;
    }
    value /= 1024;
  }
  return `${value.toFixed(2)} GB`;
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function walk(directory, outRoot) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (
      entry.name === ".git" ||
      entry.name.startsWith("_compressed_") ||
      isInside(fullPath, outRoot)
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath, outRoot)));
    } else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files;
}

function outputPathFor(source, root, outRoot, preserveExtension) {
  const relative = path.relative(root, source);
  if (preserveExtension) return path.join(outRoot, relative);

  const parsed = path.parse(relative);
  return path.join(outRoot, parsed.dir, `${parsed.name}.webp`);
}

function csvCell(value) {
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

async function writeReport(results, reportPath) {
  const header = "source,output,before_bytes,after_bytes,saved_bytes,status\n";
  const rows = results
    .map((result) =>
      [
        result.source,
        result.output,
        result.before,
        result.after,
        result.before - result.after,
        result.status,
      ]
        .map(csvCell)
        .join(","),
    )
    .join("\n");

  await fs.writeFile(reportPath, `${header}${rows}\n`, "utf8");
}

async function compressOne(source, output, options) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  const before = (await fs.stat(source)).size;
  const temp = `${output}.tmp-${process.pid}-${Date.now()}`;

  try {
    const metadata = await sharp(source, { animated: false }).metadata();
    if ((metadata.pages || 1) > 1) {
      return { source, output, before, after: before, status: "skipped animated" };
    }

    let pipeline = sharp(source, { animated: false });
    const sourceExtension = path.extname(source).toLowerCase();
    const outputExtension = path.extname(output).toLowerCase();

    if (outputExtension === ".webp") {
      pipeline = pipeline.webp({
        quality: options.quality,
        effort: options.effort,
        alphaQuality: 100,
        smartSubsample: true,
      });
    } else if (outputExtension === ".png") {
      pipeline = pipeline.png({
        compressionLevel: 9,
        adaptiveFiltering: true,
        effort: 10,
      });
    } else if (outputExtension === ".jpg" || outputExtension === ".jpeg") {
      pipeline = pipeline.jpeg({
        quality: options.quality,
        mozjpeg: true,
      });
    } else {
      await fs.copyFile(source, output);
      return { source, output, before, after: before, status: "copied unsupported" };
    }

    await pipeline.toFile(temp);

    const after = (await fs.stat(temp)).size;
    if (after < before) {
      await fs.rename(temp, output);
      return { source, output, before, after, status: "compressed" };
    }

    await fs.rm(temp, { force: true });
    if (sourceExtension === outputExtension) {
      await fs.copyFile(source, output);
      return { source, output, before, after: before, status: "kept original" };
    }

    return { source, output, before, after: before, status: "not smaller" };
  } catch (error) {
    await fs.rm(temp, { force: true });
    return { source, output, before, after: before, status: `error: ${error.message}` };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  const outRoot = path.resolve(args.out);
  const reportPath = path.resolve(args.report);

  if (!Number.isFinite(args.quality) || args.quality < 0 || args.quality > 100) {
    throw new Error("--quality must be between 0 and 100");
  }
  if (!Number.isFinite(args.effort) || args.effort < 0 || args.effort > 6) {
    throw new Error("--effort must be between 0 and 6");
  }

  await fs.rm(outRoot, { recursive: true, force: true });
  const sources = (await walk(root, outRoot)).sort();
  const results = [];

  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const output = outputPathFor(source, root, outRoot, args.preserveExtension);
    const result = await compressOne(source, output, args);
    results.push(result);

    const relative = path.relative(root, source);
    console.log(
      `[${String(index + 1).padStart(3, "0")}/${String(sources.length).padStart(3, "0")}] ` +
        `${relative} ${formatBytes(result.before)} -> ${formatBytes(result.after)} (${result.status})`,
    );
  }

  await writeReport(results, reportPath);

  const beforeTotal = results.reduce((total, result) => total + result.before, 0);
  const afterTotal = results.reduce((total, result) => total + result.after, 0);
  const savedTotal = beforeTotal - afterTotal;
  const savedPercent = beforeTotal === 0 ? 0 : (savedTotal / beforeTotal) * 100;
  const countByStatus = results.reduce((counts, result) => {
    counts[result.status] = (counts[result.status] || 0) + 1;
    return counts;
  }, {});

  console.log("");
  console.log(`Files scanned: ${results.length}`);
  for (const [status, count] of Object.entries(countByStatus)) {
    console.log(`${status}: ${count}`);
  }
  console.log(`Before: ${formatBytes(beforeTotal)}`);
  console.log(`After: ${formatBytes(afterTotal)}`);
  console.log(`Saved: ${formatBytes(savedTotal)} (${savedPercent.toFixed(2)}%)`);
  console.log(`Output folder: ${outRoot}`);
  console.log(`Report: ${reportPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
