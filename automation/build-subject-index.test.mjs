import assert from "node:assert/strict";
import test from "node:test";
import { canonicalCompanies, canonicalCompany } from "./build-subject-index.mjs";

test("groups BYD subsidiaries and brands under BYD", () => {
  assert.equal(canonicalCompany("比亚迪半导体"), "比亚迪");
  assert.equal(canonicalCompany("海洋网"), "比亚迪");
});

test("does not duplicate a parent when parent and subsidiary share one card", () => {
  assert.deepEqual(canonicalCompanies(["比亚迪", "比亚迪半导体", "海洋网"]), ["比亚迪"]);
});

test("keeps unrelated companies unchanged", () => {
  assert.equal(canonicalCompany("宁德时代"), "宁德时代");
});
