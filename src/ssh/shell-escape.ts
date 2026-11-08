/** Quote one token for a POSIX shell using Devbox's escaping rules. */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
