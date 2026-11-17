import { describe, expect, it } from "vitest";
import { FALLBACK_SLUG, MAX_SLUG_LENGTH, isProjectIdSegment, nextFreeSlug, slugify } from "@/lib/project-slug.mjs";

describe("slugify", () => {
  it("turns a name into a readable URL segment", () => {
    expect(slugify("Uji Workflow")).toBe("uji-workflow");
    expect(slugify("  SIMS — Checkout Flow v2!  ")).toBe("sims-checkout-flow-v2");
    expect(slugify("Café Déjà Vu")).toBe("cafe-deja-vu");
  });

  it("falls back when nothing usable is left", () => {
    expect(slugify("日本語")).toBe(FALLBACK_SLUG);
    expect(slugify("---")).toBe(FALLBACK_SLUG);
  });

  it("is bounded and never ends with a dash after clipping", () => {
    const slug = slugify("word ".repeat(30));
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug.endsWith("-")).toBe(false);
  });

  // An underscore would let a slug look like a project id.
  it("never produces something that reads as a project id", () => {
    expect(isProjectIdSegment(slugify("prj_default"))).toBe(false);
    expect(isProjectIdSegment("prj_7c39c00dc16f43f6")).toBe(true);
  });
});

describe("nextFreeSlug", () => {
  it("keeps the base when free and numbers the rest from 2", () => {
    expect(nextFreeSlug("uji", new Set())).toBe("uji");
    expect(nextFreeSlug("uji", new Set(["uji"]))).toBe("uji-2");
    expect(nextFreeSlug("uji", new Set(["uji", "uji-2", "uji-3"]))).toBe("uji-4");
    expect(nextFreeSlug("uji", new Set(["uji", "uji-3"]))).toBe("uji-2");
  });
});
