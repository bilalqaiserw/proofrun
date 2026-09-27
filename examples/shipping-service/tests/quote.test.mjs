import test from "node:test";
import assert from "node:assert/strict";
import { quote } from "../shipping.mjs";
test("ordinary orders have a five dollar delivery charge", () => assert.deepEqual(quote(50), {subtotal:50,shipping:5,total:55}));
test("large orders ship free", () => assert.deepEqual(quote(150), {subtotal:150,shipping:0,total:150}));
test("invalid amounts are rejected", () => { for(const n of [0,-1,NaN,10001,"50"]) assert.ok(quote(n).error); });
