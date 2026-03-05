import { mkdirSync, writeFileSync } from "fs";
import { dirname, isAbsolute, relative, resolve } from "path";
import { createInvalidParamsError } from "./errors.js";

export function resolveOutputPath(outputFile, { enabled, baseDir }) {
  if (outputFile === undefined || outputFile === null) {
    return null;
  }

  if (!enabled) {
    throw createInvalidParamsError(
      "[CONFIG_ERROR] output_file is disabled. Set ASK_GOOGLE_ALLOW_FILE_OUTPUT=true to enable it."
    );
  }

  const resolvedBaseDir = resolve(baseDir);
  const resolvedPath = resolve(resolvedBaseDir, outputFile);
  const relativePath = relative(resolvedBaseDir, resolvedPath);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw createInvalidParamsError(
      `[CONFIG_ERROR] output_file must stay within ${resolvedBaseDir}`
    );
  }

  return resolvedPath;
}

export function writeResponseToFile(outputPath, text) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, text, "utf-8");
}
