import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

// Node will not strip TypeScript under node_modules, so the published entry is plain JavaScript.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, "src");
const outDir = join(root, "dist");

async function typescriptFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await typescriptFiles(path)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function rewriteSpecifiers(source) {
  return source.replaceAll(
    /(["'])(\.\.?\/[^"']+?)\.ts\1/g,
    (_match, quote, specifier) => `${quote}${specifier}.js${quote}`,
  );
}

const files = await typescriptFiles(srcDir);
for (const file of files) {
  const text = await readFile(file, "utf8");
  const transpiled = ts.transpileModule(text, {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2023,
      verbatimModuleSyntax: true,
    },
  });
  const output = rewriteSpecifiers(transpiled.outputText);
  if (/from ["'][^"']+\.ts["']/.test(output)) {
    throw new Error(`a TypeScript import survived in ${file}`);
  }
  const dest = join(outDir, relative(srcDir, file).replace(/\.ts$/, ".js"));
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, output);
}
