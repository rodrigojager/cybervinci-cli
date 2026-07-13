import { expect, test } from "bun:test"
import { logo } from "../src/logo"

test("R and V use the full-height baseline without changing the wordmark width", () => {
  expect(logo.left[3]).toEndWith("█ █")
  expect(logo.right[3]).toStartWith(" █ ")
  expect(logo.left.map((line) => line.length)).toEqual([20, 19, 19, 19])
  expect(logo.right.map((line) => line.length)).toEqual([15, 16, 16, 16])
})
