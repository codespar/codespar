import { describe, it, expect } from "vitest";
import { LocalRevocationDenylist } from "../local-denylist.js";

describe("LocalRevocationDenylist", () => {
  it("starts empty", () => {
    const dl = new LocalRevocationDenylist();
    expect(dl.size()).toBe(0);
    expect(dl.has("mnd_x")).toBe(false);
  });

  it("add + has round-trip", () => {
    const dl = new LocalRevocationDenylist();
    dl.add("mnd_a");
    expect(dl.has("mnd_a")).toBe(true);
    expect(dl.size()).toBe(1);
  });

  it("deduplicates repeat adds", () => {
    const dl = new LocalRevocationDenylist();
    dl.add("mnd_a");
    dl.add("mnd_a");
    dl.add("mnd_a");
    expect(dl.size()).toBe(1);
  });

  it("FIFO-evicts the oldest entry past maxSize", () => {
    const dl = new LocalRevocationDenylist({ maxSize: 3 });
    dl.add("mnd_1");
    dl.add("mnd_2");
    dl.add("mnd_3");
    dl.add("mnd_4");
    expect(dl.size()).toBe(3);
    expect(dl.has("mnd_1")).toBe(false);
    expect(dl.has("mnd_4")).toBe(true);
  });
});
