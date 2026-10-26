/** Require an explicit HTTP(S) URL; do not guess schemes or accept local files. */
export function parseBrowserUrl(input: string): string | undefined {
  const value = input.trim();
  if (!value) return undefined;
  if (/\s|[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error("URLs cannot contain whitespace or control characters.");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Usage: /browser [https://example.com]");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http:// and https:// URLs are supported.");
  }
  if (url.username || url.password) {
    throw new Error("URLs containing credentials are not supported.");
  }
  return url.href;
}
