import { describe, expect, it } from "vitest";
import { truncateMiddle } from "./UserId";

describe("truncateMiddle", () => {
  it("cuts a UUID to its start and end", () => {
    expect(truncateMiddle("3f2a9c1e-7b4d-4c2a-9e1f-5d6a8b0ce81b")).toBe("3f2a9c…e81b");
  });

  it("keeps short ids whole", () => {
    expect(truncateMiddle("team/bob")).toBe("team/bob");
    expect(truncateMiddle("user_12345678")).toBe("user_12345678");
    expect(truncateMiddle("")).toBe("");
  });

  it("cuts an id just past the limit", () => {
    expect(truncateMiddle("user_123456789")).toBe("user_1…6789");
  });

  it("takes the head and tail it is given", () => {
    expect(truncateMiddle("cus_0123456789abcdef", 4, 2)).toBe("cus_…ef");
    expect(truncateMiddle("cus_0123456789abcdef", 12, 4)).toBe("cus_01234567…cdef");
  });

  it("never splits a character outside the basic plane", () => {
    expect(truncateMiddle("😀😀😀😀😀😀😀😀😀😀😀😀😀😀", 2, 2)).toBe("😀😀…😀😀");
  });
});
