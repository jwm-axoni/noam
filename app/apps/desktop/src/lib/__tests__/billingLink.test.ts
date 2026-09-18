import { describe, expect, it } from "vitest";
import { parseBillingLink } from "../billingLink";

describe("parseBillingLink", () => {
  it("accepts both foldings, with and without a vault", () => {
    expect(parseBillingLink("noam://billing/upgraded")).toEqual({ orgId: null });
    expect(parseBillingLink("noam:///billing/upgraded/")).toEqual({ orgId: null });
    expect(parseBillingLink("noam://billing/upgraded?org=WmpuI6BO")).toEqual({
      orgId: "WmpuI6BO",
    });
    expect(parseBillingLink("noam:///billing/upgraded?org=abc%2Fdef")).toEqual({
      orgId: "abc/def",
    });
  });

  it("accepts the Staging app's scheme too", () => {
    expect(parseBillingLink("noam-staging://billing/upgraded?org=x")).toEqual({ orgId: "x" });
  });

  it("treats an empty org as absent", () => {
    expect(parseBillingLink("noam://billing/upgraded?org=")).toEqual({ orgId: null });
    expect(parseBillingLink("noam://billing/upgraded?org=%20")).toEqual({ orgId: null });
  });

  it("refuses anything else", () => {
    for (const bad of [
      "noam://billing",
      "noam://billing/canceled",
      "noam://billing/upgraded/extra",
      "noam://upgraded",
      "noam://verified",
      "https://example.com/billing/upgraded",
      "not a url",
      "noam://",
    ]) {
      expect(parseBillingLink(bad)).toBeNull();
    }
  });
});
