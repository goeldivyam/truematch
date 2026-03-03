/**
 * Vitest setup file — runs before each test file.
 *
 * Sets process.env.HOME to a per-run temp directory so that every module
 * that calls os.homedir() (including identity.ts's TRUEMATCH_DIR constant)
 * uses an isolated, writable, temporary path instead of the real home directory.
 *
 * The temp directory is removed after all tests in the file complete.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const testHome = mkdtempSync(join(tmpdir(), "truematch-test-"));
process.env["HOME"] = testHome;

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});
