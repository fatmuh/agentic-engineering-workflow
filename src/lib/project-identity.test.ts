import { describe, expect, it } from "vitest";
import { normalizeWorkspacePath } from "@/lib/project-identity";

// The SQL half of the contract (NORMALIZED_WORKSPACE_SQL): btrim, strip
// trailing "/", fold A-Z. A key must be a fixed point of it, or the resolver
// could never find the row it just inserted.
function sqlNormalize(stored: string): string {
  const trimmed = stored.trim();
  if (/^\/+$/.test(trimmed)) return "/";
  return trimmed.replace(/\/+$/, "").replace(/[A-Z]/g, (c) => c.toLowerCase());
}

describe("normalizeWorkspacePath", () => {
  it("keeps the POSIX rules", () => {
    expect(normalizeWorkspacePath("/Users/X/proj/")).toBe("/users/x/proj");
    expect(normalizeWorkspacePath("/a/./b/../c")).toBe("/a/c");
    expect(normalizeWorkspacePath("///")).toBe("/");
    expect(normalizeWorkspacePath("")).toBe("");
  });

  // The Windows CLI sends the path the OS calls absolute; rejecting it made
  // awm_project_init impossible on Windows.
  it("accepts Windows drive paths and keys them with forward slashes", () => {
    const key = "c:/users/bimo/code/magang/uji-workflow";
    expect(normalizeWorkspacePath("C:\\Users\\Bimo\\code\\magang\\uji-workflow")).toBe(key);
    expect(normalizeWorkspacePath("c:\\users\\bimo\\code\\magang\\uji-workflow\\")).toBe(key);
    expect(normalizeWorkspacePath("C:/Users/Bimo/code/magang/uji-workflow")).toBe(key);
    expect(normalizeWorkspacePath("C:\\Users\\Bimo\\code\\.\\x\\..\\magang\\uji-workflow")).toBe(key);
    expect(normalizeWorkspacePath("C:\\")).toBe("c:");
    expect(normalizeWorkspacePath("D:\\..\\..\\proj")).toBe("d:/proj");
  });

  it("accepts UNC shares", () => {
    expect(normalizeWorkspacePath("\\\\Server\\Share\\Proj\\")).toBe("//server/share/proj");
  });

  it("produces keys the SQL normalisation leaves unchanged", () => {
    for (const input of ["C:\\Users\\Bimo\\proj", "C:\\", "\\\\srv\\share\\p", "/Users/X/p/", "/"]) {
      const key = normalizeWorkspacePath(input);
      expect(sqlNormalize(key)).toBe(key);
    }
  });

  it("still rejects relative and drive-relative paths", () => {
    for (const input of ["src", ".", "C:proj", "\\\\", "\\proj"]) {
      expect(() => normalizeWorkspacePath(input), input).toThrow(/workspacePath must be absolute/);
    }
  });
});
