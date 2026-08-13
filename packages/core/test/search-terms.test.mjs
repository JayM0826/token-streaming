import assert from "node:assert/strict";
import test from "node:test";
import { extractSearchTerms, taskTextIncludesSearchTerms } from "../dist/context/search-terms.js";

test("search terms normalize common English word forms", () => {
  assert.equal(taskTextIncludesSearchTerms("fix authorization", "authorize payment"), true);
  assert.equal(taskTextIncludesSearchTerms("repair inventory reservation", "reserve inventory"), true);
});

test("search terms match Chinese domain words without generic change noise", () => {
  assert.equal(taskTextIncludesSearchTerms("修复退款幂等性", "退款逻辑必须幂等"), true);
  assert.equal(taskTextIncludesSearchTerms("修改用户页面", "修改支付文件"), false);
  assert.equal(extractSearchTerms("修改文件").length, 0);
});
