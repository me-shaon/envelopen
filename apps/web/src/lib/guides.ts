// Guides live in the repository under docs/guides/. The API returns their paths
// relative to the repository root, and the app links to them on GitHub.

export const REPOSITORY_URL = "https://github.com/me-shaon/envelopen";

export function guideUrl(path: string): string {
  return `${REPOSITORY_URL}/blob/main/${path.replace(/^\/+/, "")}`;
}
