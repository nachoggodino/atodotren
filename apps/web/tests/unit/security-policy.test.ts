import { describe, expect, it } from "vitest";
import { createContentSecurityPolicy, SECURITY_HEADERS } from "@/lib/security/policy";

describe("frontend security policy", () => {
  it("keeps production CSP nonce-based while limiting inline styles to attributes", () => {
    const production = createContentSecurityPolicy("abc123", false);
    const development = createContentSecurityPolicy("abc123", true);
    expect(production).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(production).toContain("style-src-elem 'self'");
    expect(production).toContain("style-src-attr 'unsafe-inline'");
    expect(production).not.toContain("style-src 'self' 'unsafe-inline'");
    expect(production).toContain("frame-ancestors 'none'");
    expect(production).toContain("object-src 'none'");
    expect(production).not.toContain("'unsafe-eval'");
    expect(production).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(development).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic' 'unsafe-eval'");
    expect(SECURITY_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
  });
});
