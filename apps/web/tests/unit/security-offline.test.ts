import { describe, expect, it } from "vitest";
import { OFFLINE_BOOTSTRAP, OFFLINE_SESSION_KEY } from "@/lib/offline/bootstrap";
import { createContentSecurityPolicy, SECURITY_HEADERS } from "@/lib/security/policy";

describe("frontend security and offline infrastructure", () => {
  it("builds a nonce-based CSP without opening script-src to unsafe-inline", () => {
    const policy = createContentSecurityPolicy("abc123");
    expect(policy).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("keeps the pre-hydration offline bootstrap bounded and independently inspectable", () => {
    expect(OFFLINE_SESSION_KEY).toBe("atodotren:offline");
    expect(OFFLINE_BOOTSTRAP).toContain("manifest.webmanifest?atodotren-connectivity=");
    expect(OFFLINE_BOOTSTRAP).toContain("sessionStorage");
    expect(OFFLINE_BOOTSTRAP).toContain('window.addEventListener("offline"');
    expect(OFFLINE_BOOTSTRAP).not.toContain("eval(");
  });
});
