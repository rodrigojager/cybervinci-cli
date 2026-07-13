import { describe, expect, test } from "bun:test"
import { blockedUntil, headroom, nearLimit, parseQuotaPayload } from "../src/quota"
import type { Account } from "../src/domain"

function account(quota: Account["quota"]): Account {
  return { id: "a", label: "A", accessToken: "x", refreshToken: "r", expiresAt: Date.now() + 1000, enabled: true, createdAt: 1, updatedAt: 1, health: { successes: 0, failures: 0 }, quota }
}

describe("quota", () => {
  test("normalizes usage payload and second timestamps", () => {
    const value = parseQuotaPayload({ plan_type: "plus", rate_limit: { allowed: true, primary_window: { used_percent: 91, limit_window_seconds: 18000, reset_at: 2_000_000_000 }, secondary_window: { used_percent: 40, reset_after_seconds: 30 } } }, 1000)
    expect(value.planType).toBe("plus")
    expect(value.primary?.resetAt).toBe(2_000_000_000_000)
    expect(value.secondary?.resetAt).toBeGreaterThan(Date.now())
    expect(nearLimit(account(value), 90, 95)).toBe(true)
    expect(headroom(account(value))).toBe(9)
  })

  test("uses the latest blocking reset when both windows are exhausted", () => {
    const now = Date.now()
    const value = account({ allowed: false, limitReached: true, primary: { usedPercent: 100, resetAt: now + 1000 }, secondary: { usedPercent: 100, resetAt: now + 5000 }, fetchedAt: now, source: "usage-endpoint" })
    expect(blockedUntil(value, now)).toBe(now + 5000)
  })

  test("releases an exhausted quota after its recorded reset passes", () => {
    const now = Date.now()
    const resetAt = now - 1000
    const value = account({ allowed: false, limitReached: true, primary: { usedPercent: 100, resetAt }, fetchedAt: now - 60_000, source: "response" })
    expect(blockedUntil(value, now)).toBe(resetAt)
  })

  test("uses a stable fallback deadline when a blocked quota has no reset", () => {
    const now = Date.now()
    const fetchedAt = now - 120_000
    const value = account({ allowed: false, limitReached: true, fetchedAt, source: "usage-endpoint" })
    expect(blockedUntil(value, now)).toBe(fetchedAt + 60_000)
  })
})
