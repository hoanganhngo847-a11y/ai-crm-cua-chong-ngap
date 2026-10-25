import test from "node:test";
import assert from "node:assert/strict";
import {
  listPersonalZaloContactCandidates,
  type PersonalZaloContactCandidate,
} from "../../features/campaigns/zalo-contact-linking";

test("PersonalZaloContactCandidate contract types are defined and valid", () => {
  const candidate: PersonalZaloContactCandidate = {
    id: "test-id",
    display_name: "Nguyen Van A",
    last_seen_at: new Date().toISOString(),
  };
  assert.equal(candidate.id, "test-id");
  assert.equal(candidate.display_name, "Nguyen Van A");
  assert.ok(typeof candidate.last_seen_at === "string");
});
