import { describe, expect, it } from "vitest";
import { keepEcosystemPackages } from "../src/registry.mjs";

describe("keepEcosystemPackages", () => {
  it("test_keeps_the_scope_and_the_two_unscoped_names", () => {
    expect(keepEcosystemPackages(["@theokit/sdk", "theokit", "create-theokit"])).toEqual([
      "@theokit/sdk",
      "create-theokit",
      "theokit",
    ]);
  });

  it("test_drops_a_third_party_package_that_merely_mentions_theokit", () => {
    // The query is full text, because the registry search API returns nothing for
    // `scope:theokit`. Anything whose README says "theokit" comes back with it.
    expect(keepEcosystemPackages(["theokit-community-plugin", "awesome-theokit", "@acme/theokit-tools"])).toEqual([]);
  });

  it("test_survives_a_malformed_search_result_without_throwing", () => {
    // A search hit with no name is not worth crashing the whole sweep over.
    expect(keepEcosystemPackages([undefined, null, "@theokit/ui"])).toEqual(["@theokit/ui"]);
  });

  it("test_deduplicates_because_the_unscoped_names_are_appended_unconditionally", () => {
    expect(keepEcosystemPackages(["theokit", "theokit", "create-theokit"])).toEqual(["create-theokit", "theokit"]);
  });
});
