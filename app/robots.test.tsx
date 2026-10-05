/**
 * @file app/robots.test.tsx
 *
 * Compatibility-contract tests for the `app/robots.js` metadata route.
 *
 * The public contract under test (issue #1224):
 *   - the default export is a zero-arg function returning
 *     `{ rules: { userAgent: "*", allow: "/" }, sitemap }`
 *   - `sitemap` is always an absolute http(s) URL ending in `/sitemap.xml`
 *   - unset / blank / malformed / non-http(s) `NEXT_PUBLIC_SITE_URL` values
 *     all fall back to the localhost default instead of emitting a broken
 *     crawl directive
 *   - the route is deterministic and never throws
 *
 * Env is mutated per test and restored afterwards so the suite is isolated.
 */

if (typeof global.Request === "undefined") {
  (global as any).Request = class Request {};
  (global as any).Response = class Response {};
  (global as any).Headers = class Headers {};
}

const robotsModule = require("./robots");
const robots = robotsModule.default;
const normalizeSiteUrl = robotsModule.normalizeSiteUrl;

/**
 * Focused tests for the robots.txt route state invariants.
 *
 * Covers success, rejection (invalid input), boundary cases, injection
 * attempts, and a regression guard against module-level configuration caching.
 * Each case exercises the invariants documented at the top of `app/robots.js`.
 */

const ORIGINAL_SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

function setSiteUrl(value: string | undefined) {
  if (value === undefined) {
    delete process.env.NEXT_PUBLIC_SITE_URL;
  } else {
    process.env.NEXT_PUBLIC_SITE_URL = value;
  }
}

describe("Robots Route", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    // Silence and capture diagnostics emitted on invalid configuration.
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    setSiteUrl(undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    setSiteUrl(ORIGINAL_SITE_URL);
  });

  // ── Regression: original public behaviour ────────────────────────────────

  it("returns proper robots meta", () => {
    const result = robots();
    expect(result.rules).toBeDefined();
    expect(result.rules.userAgent).toBe("*");
    expect(result.rules.allow).toBe("/");
    // default base URL fallback
    expect(result.sitemap).toContain("http://localhost:3000/sitemap.xml");
  });

  // ── INV-1: shape stability ───────────────────────────────────────────────

  it("returns exactly the { rules, sitemap } shape", () => {
    setSiteUrl("https://example.com");
    const result = robots();
    expect(Object.keys(result).sort()).toEqual(["rules", "sitemap"]);
    expect(Object.keys(result.rules).sort()).toEqual(["allow", "userAgent"]);
  });

  // ── INV-2: crawl policy is independent of configuration ──────────────────

  it.each([
    [undefined],
    ["https://example.com"],
    ["http://localhost:3000/"],
    ["not-a-url"],
    ["javascript:alert(1)"],
  ])("keeps the crawl policy fixed for site URL %p", (value) => {
    setSiteUrl(value as string | undefined);
    const result = robots();
    expect(result.rules).toEqual({ userAgent: "*", allow: "/" });
  });

  // ── INV-3: canonical sitemap for valid inputs ────────────────────────────

  it("appends exactly one sitemap path for a bare default origin", () => {
    const result = robots();
    expect(result.sitemap).toBe("http://localhost:3000/sitemap.xml");
  });

  it("normalizes a trailing slash without producing a double slash", () => {
    setSiteUrl("https://example.com/");
    const result = robots();
    expect(result.sitemap).toBe("https://example.com/sitemap.xml");
    expect(result.sitemap).not.toContain("//sitemap.xml");
  });

  it("collapses repeated trailing slashes", () => {
    setSiteUrl("https://example.com///");
    expect(robots().sitemap).toBe("https://example.com/sitemap.xml");
  });

  it("preserves a non-root base path", () => {
    setSiteUrl("https://example.com/app/");
    expect(robots().sitemap).toBe("https://example.com/app/sitemap.xml");
  });

  it("preserves an explicit port", () => {
    setSiteUrl("http://localhost:3001");
    expect(robots().sitemap).toBe("http://localhost:3001/sitemap.xml");
  });

  it("drops query string and fragment from the sitemap location", () => {
    setSiteUrl("https://example.com/base/?utm=1#section");
    expect(robots().sitemap).toBe("https://example.com/base/sitemap.xml");
  });

  it("drops embedded credentials from the sitemap location", () => {
    setSiteUrl("https://user:secret@example.com");
    const result = robots();
    expect(result.sitemap).toBe("https://example.com/sitemap.xml");
    expect(result.sitemap).not.toContain("secret");
  });

  it("normalizes an uppercase scheme to lowercase", () => {
    setSiteUrl("HTTPS://Example.com/");
    expect(robots().sitemap).toBe("https://example.com/sitemap.xml");
  });

  it.each([
    "http://localhost:3000",
    "https://example.com/",
    "https://example.com/app/",
    "http://localhost:3001",
  ])("always emits an absolute sitemap ending in /sitemap.xml for %p", (value) => {
    setSiteUrl(value);
    const { sitemap } = robots();
    expect(sitemap).toMatch(/^https?:\/\/[^/]+\/.*sitemap\.xml$/);
    expect(sitemap.endsWith("/sitemap.xml")).toBe(true);
  });

  // ── INV-5: rejection / deterministic fallback ────────────────────────────

  it.each([
    ["", "empty string (treated as unset)"],
    ["   ", "whitespace-only (treated as unset)"],
    ["not-a-url", "malformed value"],
    ["also-not-a-url", "malformed value"],
    ["//example.com", "protocol-relative URL"],
    ["http://", "missing host"],
    ["ftp://example.com", "disallowed scheme"],
    ["javascript:alert(1)", "disallowed scheme"],
    ["data:text/html,<script>1</script>", "disallowed scheme"],
    ["file:///etc/passwd", "disallowed scheme"],
  ])("falls back to the default site URL for %p (%s)", (value) => {
    setSiteUrl(value);
    expect(robots().sitemap).toBe("http://localhost:3000/sitemap.xml");
  });

  it.each([[null], [42], [{ href: "https://example.com" }], [["https://example.com"]]])(
    "normalizeSiteUrl tolerates non-string input %p",
    (value) => {
      expect(normalizeSiteUrl(value)).toBe("http://localhost:3000");
    }
  );

  it("never throws for arbitrary configuration values", () => {
    for (const value of [
      "",
      " ",
      "not-a-url",
      "javascript:alert(1)",
      "ftp://example.com",
      "http://",
      "https://example.com/ok",
    ]) {
      setSiteUrl(value);
      expect(() => robots()).not.toThrow();
    }
  });

  // ── INV-4: injection resistance ──────────────────────────────────────────

  it("rejects a newline-laden URL instead of emitting a forged directive", () => {
    setSiteUrl("https://example.com/\nUser-agent: BadBot\nDisallow: /");
    const { sitemap } = robots();
    expect(sitemap).toBe("http://localhost:3000/sitemap.xml");
    expect(sitemap).not.toMatch(/[\r\n]/);
    expect(sitemap).not.toContain("BadBot");
  });

  it("rejects carriage returns and other control characters", () => {
    setSiteUrl("https://example.com/\r\n\t\u0000evil");
    const { sitemap } = robots();
    expect(sitemap).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(sitemap).toBe("http://localhost:3000/sitemap.xml");
  });

  // ── INV-6: read-at-call, deterministic across invocations ────────────────

  it("re-reads configuration on each call (no stale module-level cache)", () => {
    setSiteUrl("https://first.example.com");
    expect(robots().sitemap).toBe("https://first.example.com/sitemap.xml");

    setSiteUrl("https://second.example.com");
    expect(robots().sitemap).toBe("https://second.example.com/sitemap.xml");

    setSiteUrl(undefined);
    expect(robots().sitemap).toBe("http://localhost:3000/sitemap.xml");
  });

  it("is idempotent — repeated calls yield deeply equal results", () => {
    setSiteUrl("https://example.com/");
    expect(robots()).toEqual(robots());
  });

  // ── Immutability: returned state cannot be mutated ───────────────────────

  it("returns a frozen result and frozen rules", () => {
    const result = robots();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.rules)).toBe(true);
  });

  it("ignores attempts to mutate the returned state", () => {
    const result = robots();
    result.rules.userAgent = "BadBot";
    result.sitemap = "https://evil.example.com/sitemap.xml";
    expect(result.rules.userAgent).toBe("*");
    expect(result.sitemap).toBe("http://localhost:3000/sitemap.xml");
  });

  // ── Observability: diagnosable failures ──────────────────────────────────

  it("warns with a [robots] prefix when the configured URL is invalid", () => {
    setSiteUrl("javascript:alert(1)");
    robots();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toMatch(/\[robots\]/);
    expect(message).toMatch(/NEXT_PUBLIC_SITE_URL/);
    expect(message).toMatch(/http:\/\/localhost:3000/);
  });

  it("does not warn when the variable is unset or empty", () => {
    setSiteUrl(undefined);
    robots();
    setSiteUrl("");
    robots();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("escapes control characters in the warning so logs cannot be forged", () => {
    setSiteUrl("javascript:alert(1)\nInjected: 1");
    robots();
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).not.toMatch(/Injected: 1\n/);
    expect(message).not.toMatch(/[\r\n]/);
  it("preserves the exact top-level return shape across calls", () => {
    const a = robots();
    const b = robots();
    expect(a).toEqual(b);
    expect(Object.keys(a).sort()).toEqual(["rules", "sitemap"]);
    expect(Object.keys(a.rules).sort()).toEqual(["allow", "userAgent"]);
  });

  // ── Base-URL resolution: valid inputs ──────────────────────────────────────

  it("uses a configured https origin", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://app.liquifact.io";
    const result = robots();
    expect(result.sitemap).toBe("https://app.liquifact.io/sitemap.xml");
  });

  it("strips a trailing slash so the sitemap never gets a double slash", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://app.liquifact.io/";
    expect(robots().sitemap).toBe("https://app.liquifact.io/sitemap.xml");
  });

  it("trims surrounding whitespace before parsing", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "  https://app.liquifact.io  ";
    expect(robots().sitemap).toBe("https://app.liquifact.io/sitemap.xml");
  });

  it("preserves a non-root path segment in the base URL", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://example.com/app/";
    expect(robots().sitemap).toBe("https://example.com/app/sitemap.xml");
  });

  it("preserves a non-default port", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:4321";
    expect(robots().sitemap).toBe("http://localhost:4321/sitemap.xml");
  });

  // ── Base-URL resolution: adverse inputs fall back safely ───────────────────

  it("falls back to the default when the env var is unset", () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    expect(resolveSiteUrl()).toBe(DEFAULT_SITE_URL);
    expect(robots().sitemap).toBe(`${DEFAULT_SITE_URL}${SITEMAP_PATH}`);
  });

  it("falls back to the default for blank and whitespace-only values", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "";
    expect(resolveSiteUrl()).toBe(DEFAULT_SITE_URL);
    process.env.NEXT_PUBLIC_SITE_URL = "   ";
    expect(resolveSiteUrl()).toBe(DEFAULT_SITE_URL);
  });

  it("falls back to the default for a malformed URL", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "not-a-url";
    expect(resolveSiteUrl()).toBe(DEFAULT_SITE_URL);
    expect(robots().sitemap).toBe(`${DEFAULT_SITE_URL}${SITEMAP_PATH}`);
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>1</script>"],
    ["file:", "file:///etc/passwd"],
    ["ftp:", "ftp://example.com"],
  ])("rejects the %s scheme and falls back to the default", (_label, value) => {
    process.env.NEXT_PUBLIC_SITE_URL = value;
    expect(resolveSiteUrl()).toBe(DEFAULT_SITE_URL);
    expect(robots().sitemap).toBe(`${DEFAULT_SITE_URL}${SITEMAP_PATH}`);
  });

  it("falls back for non-string input (null/undefined/number)", () => {
    expect(resolveSiteUrl(null)).toBe(DEFAULT_SITE_URL);
    expect(resolveSiteUrl(undefined)).toBe(DEFAULT_SITE_URL);
    expect(resolveSiteUrl(42)).toBe(DEFAULT_SITE_URL);
    expect(resolveSiteUrl({})).toBe(DEFAULT_SITE_URL);
  });

  it("is deterministic and never throws for a hostile value", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "h ttp://%%%";
    expect(() => robots()).not.toThrow();
    expect(robots()).toEqual(robots());
  });

  // ── Helper contract ────────────────────────────────────────────────────────

  it("buildSitemapUrl appends the sitemap path to a resolved origin", () => {
    expect(buildSitemapUrl("https://x.example")).toBe("https://x.example/sitemap.xml");
    expect(SITEMAP_PATH).toBe("/sitemap.xml");
  });

  it("every produced sitemap is an absolute http(s) URL ending in /sitemap.xml", () => {
    for (const value of [undefined, "", "bad", "ftp://x.com", "https://x.com/"]) {
      if (value === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
      else process.env.NEXT_PUBLIC_SITE_URL = value;

      const { sitemap } = robots();
      expect(sitemap.endsWith(SITEMAP_PATH)).toBe(true);
      expect(sitemap).toMatch(/^https?:\/\//);
      expect(() => new URL(sitemap)).not.toThrow();
    }
  });

  it("does not mutate the configured env var", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://app.liquifact.io/";
    robots();
    expect(process.env.NEXT_PUBLIC_SITE_URL).toBe("https://app.liquifact.io/");
  });
});
