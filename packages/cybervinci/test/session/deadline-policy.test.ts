import { expect, test } from "bun:test"
import { sessionDeadlinePolicy } from "../../src/session/processor"

test("session cycle deadline is disabled by default", () => {
  expect(sessionDeadlinePolicy({}).cycleMaximumMs).toBeUndefined()
})

test("session cycle deadline remains available as an explicit guard", () => {
  expect(
    sessionDeadlinePolicy({
      CYBERVINCI_SESSION_CYCLE_TIMEOUT_MS: "1200000",
    }).cycleMaximumMs,
  ).toBe(1_200_000)
})

test("invalid session cycle deadlines do not restore the old implicit limit", () => {
  expect(
    ["", "0", "-1", "invalid"].map(
      (value) => sessionDeadlinePolicy({ CYBERVINCI_SESSION_CYCLE_TIMEOUT_MS: value }).cycleMaximumMs,
    ),
  ).toEqual([undefined, undefined, undefined, undefined])
})
