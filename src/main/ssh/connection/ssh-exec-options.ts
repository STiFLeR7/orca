export type SshExecOptions = {
  wrapCommand?: boolean
  signal?: AbortSignal
}

export function createSshOperationAbortError(): Error & { name: string } {
  const error = new Error('SSH operation was cancelled')
  error.name = 'AbortError'
  return error
}
