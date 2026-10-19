/** POSIX sh single-quoting: each `'` closes the quote, is escaped, and reopens it (`'\''`). */
export function quotePosixShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
