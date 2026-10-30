// VS Code (and compatible forks) register these as OS-level deep-link protocols;
// Orca hands them to the OS the same way it does http(s) links.
export const EXTERNAL_EDITOR_URI_SCHEME_NAMES = ['vscode', 'vscode-insiders'] as const

export function hasExternalEditorUriScheme(value: string): boolean {
  const lower = value.toLowerCase()
  return EXTERNAL_EDITOR_URI_SCHEME_NAMES.some((name) => lower.startsWith(`${name}:`))
}

// VS Code's documented file deep link is `vscode://file/<path>[:<line>[:<col>]]`;
// any other authority targets an extension's own URI handler, which issue #31637
// never asked to auto-open.
export function isExternalEditorFileDeepLink(url: URL): boolean {
  return (
    hasExternalEditorUriScheme(url.protocol) &&
    url.hostname === 'file' &&
    url.username === '' &&
    url.password === '' &&
    url.port === ''
  )
}
