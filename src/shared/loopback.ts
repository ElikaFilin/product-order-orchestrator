/**
 * Host-header check for the local HTTP servers (A2A agents, dashboard hub). They listen on loopback and have
 * no authentication; refusing other Host names also stops a web page from reaching them through DNS rebinding.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Hostname of a Host header value ("127.0.0.1:41010" -> "127.0.0.1", "[::1]:80" -> "[::1]"). */
export function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  return hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0]!;
}

export function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  return LOOPBACK_HOSTS.has(hostnameOf(hostHeader).toLowerCase());
}
