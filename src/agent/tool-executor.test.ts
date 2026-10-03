// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiToolExecutor } from "./tool-executor.ts";

describe("createPiToolExecutor", () => {
  it("reports a bash command that exits non-zero as an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-agent-tools-"));
    const tools = createPiToolExecutor(dir);
    const failed = await tools.run("bash", { command: "echo hi; exit 3" });
    expect(failed.isError).toBe(true);
    const fine = await tools.run("bash", { command: "echo hi" });
    expect(fine.isError).toBeUndefined();
  });

  it("writes and reads files rooted at cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-agent-tools-"));
    const tools = createPiToolExecutor(dir);
    await tools.run("write", { path: "b.txt", content: "x" });
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("x");
    expect((await tools.run("read", { path: "b.txt" })).content).toContain("x");
  });
});
