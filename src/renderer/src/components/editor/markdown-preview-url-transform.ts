import { defaultUrlTransform } from 'react-markdown'
import { hasExternalEditorUriScheme } from '../../../../shared/external-editor-uri-schemes'

export function markdownPreviewUrlTransform(value: string, key: string): string {
  if ((key === 'href' || key === 'src') && value.toLowerCase().startsWith('file:')) {
    return value
  }
  if (key === 'href' && hasExternalEditorUriScheme(value)) {
    return value
  }

  return defaultUrlTransform(value)
}
