import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

describe("extension installation", () => {
  test("publishes a loadable source entry without changing package identity", async () => {
    expect(manifest.name).toBe("omp-claude-bridge");
    expect(manifest.version).toBe("0.8.1");
    expect(manifest.omp.extensions).toEqual(["./src/index.ts"]);
    expect(manifest.files).toContain("src");
    // Exercise the installer-selected entry, rather than a hard-coded import path.
    const entry = await import(new URL(manifest.omp.extensions[0], root).href);
    expect(typeof entry.default).toBe("function");
  });

  test("uses loader-recognized host package scopes", () => {
    const packages = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const name of ["pi-ai", "pi-coding-agent", "pi-tui"]) {
      expect(packages[`@earendil-works/${name}`]).toBeDefined();
      expect(packages[`@oh-my-pi/${name}`]).toBeUndefined();
    }
  });
});
