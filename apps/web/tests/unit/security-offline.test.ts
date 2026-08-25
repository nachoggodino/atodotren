import { describe, expect, it } from "vitest";
import { OFFLINE_BOOTSTRAP, OFFLINE_SESSION_KEY } from "@/lib/offline/bootstrap";
import { createContentSecurityPolicy, SECURITY_HEADERS } from "@/lib/security/policy";

describe("frontend security and offline infrastructure", () => {
  it("keeps production CSP nonce-based while allowing dev-only evaluation tooling", () => {
    const production = createContentSecurityPolicy("abc123", false);
    const development = createContentSecurityPolicy("abc123", true);
    expect(production).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(production).toContain("frame-ancestors 'none'");
    expect(production).toContain("object-src 'none'");
    expect(production).not.toContain("'unsafe-eval'");
    expect(production).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(development).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic' 'unsafe-eval'");
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
