import { describe, expect, test } from "bun:test";
import { checkBuildNumber } from "../src/build";
import { type NumberedBuild, aboveTrain, compareBuildNumbers, compareBuildOrder, isCounter, nextBuildNumber } from "../src/buildnumber";

const ios = (number: string, version = "1.0"): NumberedBuild => ({ number, version, platform: "IOS" });

// The app that started this: three real UTC timestamps, then "highest + 1" on top of them.
const history = [
  "202610200522",
  "202610200521",
  "202610200520",
  "202610200519",
  "202610200518",
  "202610200517",
  "202610200516.39",
  "202610200434.28",
  "202610200211",
].map((number) => ios(number));

test("compareBuildNumbers compares numerically, part by part", () => {
  expect(["10", "9", "1.2.10", "1.2.9", "100"].sort(compareBuildNumbers)).toEqual(["1.2.9", "1.2.10", "9", "10", "100"]);
  expect(compareBuildNumbers("3", "3.0")).toBe(0);
});

test("numbers of 100,000 or more aren't counters, and come before them in build order", () => {
  expect(isCounter("99999")).toBe(true);
  expect(isCounter("1.2.3")).toBe(true);
  expect(isCounter("100000")).toBe(false);
  expect(isCounter("202610200516.39")).toBe(false);
  expect(["10", "202610200522", "9", "202610200516.39"].sort(compareBuildOrder)).toEqual(["202610200516.39", "202610200522", "9", "10"]);
});

describe("nextBuildNumber", () => {
  test("counts up from the app's highest counter, across versions and platforms", () => {
    const builds = [ios("12", "1.1"), { number: "13", version: "1.1", platform: "MAC_OS" as const }, ios("11", "1.0.1")];
    expect(nextBuildNumber({ builds, train: [] })).toEqual({ build: "14", numbering: "counter" });
    // A hotfix to an older version keeps counting too.
    expect(nextBuildNumber({ builds, train: [ios("11", "1.0.1")] })).toEqual({ build: "14", numbering: "counter" });
  });

  test("counts tags that claim a number App Store Connect doesn't have yet", () => {
    expect(nextBuildNumber({ builds: [ios("10")], train: [ios("10")], tags: ["10", "11"] }).build).toBe("12");
  });

  test("a version with timestamp-style numbers stays above them, with the floor to warn about", () => {
    expect(nextBuildNumber({ builds: history, train: history })).toEqual({ build: "202610200523", numbering: "legacy", floor: "202610200522" });
  });

  test("the next version starts at the number of uploads so far", () => {
    expect(nextBuildNumber({ builds: history, train: [] })).toEqual({ build: "10", numbering: "counter" });
    // Then counts from there, ignoring the old numbers and their tags.
    const after = [ios("10", "1.0.1"), ...history];
    expect(nextBuildNumber({ builds: after, train: [ios("10", "1.0.1")], tags: ["202610200522", "10"] })).toEqual({ build: "11", numbering: "counter" });
  });

  test("a failed build used up its number", () => {
    // App Store Connect lists failed builds too, so they count.
    expect(nextBuildNumber({ builds: [ios("7")], train: [ios("7")] }).build).toBe("8");
  });

  test("the first upload counts from the project's own build number, if it's a counter", () => {
    expect(nextBuildNumber({ builds: [], train: [], local: "4" }).build).toBe("5");
    expect(nextBuildNumber({ builds: [], train: [], local: "202601010000" }).build).toBe("1");
    expect(nextBuildNumber({ builds: [], train: [] }).build).toBe("1");
  });

  test("a train above the counter that's itself a counter isn't legacy", () => {
    // Older than the 200 builds read for the counter, but in the train.
    expect(nextBuildNumber({ builds: [ios("3")], train: [ios("40")] })).toEqual({ build: "41", numbering: "counter" });
  });

  test("dotted numbers count by their first part", () => {
    expect(nextBuildNumber({ builds: [ios("1.2.3"), ios("4.1")], train: [] }).build).toBe("5");
  });
});

test("a number HEAD already has is only reused above the platform's train", () => {
  // iOS claimed 10 for this commit, but macOS already has a timestamp-style build.
  expect(aboveTrain("10", [{ number: "202610200522", platform: "MAC_OS" }])).toBe(false);
  expect(aboveTrain("10", [ios("9"), ios("4")])).toBe(true);
  expect(aboveTrain("10", [])).toBe(true);
});

test("--build stops a number Apple would reject for length", () => {
  expect(checkBuildNumber("202610200516.39")).toBe("202610200516.39");
  expect(() => checkBuildNumber("2026102005160000.39")).toThrow("Apple takes up to 18");
});
