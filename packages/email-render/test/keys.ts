/** Fixed base64 keys of 32 bytes, so the tests are repeatable. */
export function testKey(fill: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
}
