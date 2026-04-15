import { Route, RouteBehaviour, FormField, Validation, PageFunctionality, PageFeature, PageButton, PageDialog } from '../../types/index.js'
import { readFile } from '../../utils/file.js'

export async function extractBehaviours(routes: Route[], _mode: 'fast' | 'deep'): Promise<RouteBehaviour[]> {
  const behaviours: RouteBehaviour[] = []

  const pageRoutes = routes.filter(r => r.type === 'page' && r.file_path)

  for (const route of pageRoutes) {
    const behaviour = await extractRouteBehaviour(route)
    behaviours.push(behaviour)
  }

  return behaviours
}

async function extractRouteBehaviour(route: Route): Promise<RouteBehaviour> {
  const base: RouteBehaviour = {
    route,
    forms: [],
    api_calls: [],
  }

  if (!route.file_path) return base

  let content: string
  try {
    content = await readFile(route.file_path)
  } catch {
    return base
  }

  base.forms = extractForms(content)
  base.api_calls = extractApiCalls(content)
  base.functionality = extractPageFunctionality(content, route.path)

  // Infer expected outcomes from code patterns (no LLM needed)
  base.expected_success = inferExpectedSuccess(content, route.path)
  base.expected_error = inferExpectedError(content)

  return base
}

function inferExpectedSuccess(content: string, route: string): string | undefined {
  if (/navigate\(['"`]\//.test(content)) {
    const navMatch = content.match(/navigate\(['"`]([^'"`]+)/)
    if (navMatch) return `Redirects to ${navMatch[1]}`
  }
  if (/toast\w*\(\s*['"`].*success/i.test(content) || /toast\.success/i.test(content)) return 'Shows success toast'
  if (/onSuccess/.test(content)) return 'Action completed successfully'
  return undefined
}

function inferExpectedError(content: string): string | undefined {
  if (/toast\w*\(\s*['"`].*error/i.test(content) || /toast\.error/i.test(content)) return 'Shows error toast'
  if (/setError|setErrors|formState\.errors/.test(content)) return 'Shows form validation error'
  return undefined
}

/**
 * Extracts the full functional understanding of a page component.
 * Works generically across React, Vue, Svelte, or any JSX/TSX component.
 */
function extractPageFunctionality(content: string, routePath: string): PageFunctionality {
  return {
    features: extractFeatures(content, routePath),
    buttons: extractButtons(content),
    dialogs: extractDialogs(content),
    navigation_flows: extractNavigationFlows(content),
    data_display: extractDataDisplay(content),
    state_vars: extractStateVars(content),
  }
}

function extractFeatures(content: string, routePath: string): PageFeature[] {
  const features: PageFeature[] = []

  // CRUD Create: mutation calls with "create", "add", "new", "post"
  const createPatterns = /use(?:Create|Add|Post|Insert)(\w+)|\.mutate\b|useMutation/g
  for (const m of content.matchAll(createPatterns)) {
    const entity = m[1]?.replace(/([A-Z])/g, ' $1').trim() || 'item'
    if (!features.some(f => f.type === 'crud_create' && f.name.includes(entity.toLowerCase()))) {
      features.push({ name: `Create ${entity}`, type: 'crud_create', description: `Can create a new ${entity.toLowerCase()}` })
    }
  }

  // CRUD Read: query calls
  const readPatterns = /use(?:Get|Fetch|Load|List|All)(\w+)|useQuery/g
  for (const m of content.matchAll(readPatterns)) {
    const entity = m[1]?.replace(/([A-Z])/g, ' $1').trim() || 'data'
    features.push({ name: `View ${entity}`, type: 'crud_read', description: `Displays ${entity.toLowerCase()} data` })
  }

  // CRUD Update: mutation with "update", "edit", "patch", "put"
  for (const m of content.matchAll(/use(?:Update|Edit|Patch|Put)(\w+)/g)) {
    const entity = m[1]?.replace(/([A-Z])/g, ' $1').trim() || 'item'
    features.push({ name: `Update ${entity}`, type: 'crud_update', description: `Can update ${entity.toLowerCase()}` })
  }

  // CRUD Delete: mutation with "delete", "remove"
  for (const m of content.matchAll(/use(?:Delete|Remove)(\w+)/g)) {
    const entity = m[1]?.replace(/([A-Z])/g, ' $1').trim() || 'item'
    features.push({ name: `Delete ${entity}`, type: 'crud_delete', description: `Can delete ${entity.toLowerCase()}` })
  }

  // Search functionality
  if (/search|filter.*input|setSearch|searchTerm|searchQuery/i.test(content)) {
    features.push({ name: 'Search', type: 'search', description: 'Has search/filter input' })
  }

  // Filter / tabs functionality
  if (/statusFilter|setFilter|tab|statusTab|filterBy/i.test(content)) {
    features.push({ name: 'Filter', type: 'filter', description: 'Has filter or tab controls' })
  }

  // Pagination
  if (/pagination|setPage|page\s*\+\s*1|nextPage|prevPage|totalPages/i.test(content)) {
    features.push({ name: 'Pagination', type: 'pagination', description: 'Has pagination controls' })
  }

  // File upload
  if (/type=["']file["']|upload|dropzone|FileInput|onDrop/i.test(content)) {
    features.push({ name: 'File upload', type: 'upload', description: 'Has file upload capability' })
  }

  // Dialog / Modal
  if (/Dialog|Modal|Sheet|Drawer|Popover/i.test(content) && /DialogTrigger|onOpen|setOpen|setDialog/i.test(content)) {
    features.push({ name: 'Dialog interaction', type: 'dialog', description: 'Has dialog/modal interactions' })
  }

  return features
}

function extractButtons(content: string): PageButton[] {
  const buttons: PageButton[] = []
  const seen = new Set<string>()

  // Strategy: find </Button> closing tags, then look at the ~200 chars before
  // to extract the visible text content (last plain text before closing tag)
  const closingTags = [...content.matchAll(/<\/(?:Button|button)\s*>/gi)]

  for (const closeMatch of closingTags) {
    const closeIdx = closeMatch.index!
    // Look at the 300 chars before the closing tag
    const before = content.slice(Math.max(0, closeIdx - 300), closeIdx)

    // Extract plain text: last line(s) of visible text before </Button>
    // Remove JSX tags, JSX expressions, then take the last non-empty line
    const cleaned = before
      .replace(/<[^>]*>/g, '\n')
      .replace(/\{[^}]*\}/g, '\n')
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 1 && s.length < 50)
      .filter(s => !/[()=>{};]|className|onClick|variant|disabled|set\w+\(|const |let /.test(s))

    // Also check for ternary text: {condition ? <Spinner/> : "Add Client"}
    const ternaryMatch = before.match(/\?\s*(?:<[^>]*\/?>)?\s*:\s*['"`]([^'"`]+)['"`]\s*\}?\s*$/)
    const text = ternaryMatch?.[1]?.trim() ?? cleaned[cleaned.length - 1]

    if (!text || text.length < 2 || text.length > 50 || seen.has(text)) continue
    if (/transition|className|rounded|flex|grid|\$/i.test(text)) continue
    seen.add(text)

    // Determine what button does: look at the wider context around this button
    const contextStart = Math.max(0, closeIdx - 300)
    const contextEnd = Math.min(content.length, closeIdx + 20)
    const context = content.slice(contextStart, contextEnd)

    let action: PageButton['action'] = 'unknown'
    if (/type=["']submit["']/i.test(context)) {
      action = 'submits'
    } else if (/DialogTrigger/i.test(context) || /setDialogOpen|setOpen\(true\)/i.test(context)) {
      action = 'opens_dialog'
    } else if (/setIsEditing|toggle|setShow|setMode/i.test(context)) {
      action = 'toggles'
    } else if (/navigate\(|href=/i.test(context)) {
      action = 'navigates'
    }

    buttons.push({ text, action })
  }

  return buttons
}

function extractDialogs(content: string): PageDialog[] {
  const dialogs: PageDialog[] = []

  // Find Dialog/Modal components with their content
  const dialogPattern = /<(?:Dialog|Modal)\b[^>]*>[\s\S]*?<\/(?:Dialog|Modal)>/g

  for (const m of content.matchAll(dialogPattern)) {
    const dialogContent = m[0]

    // Extract trigger text
    const triggerMatch = dialogContent.match(/<(?:DialogTrigger|ModalTrigger)[^>]*>[\s\S]*?(?:<(?:Button|button)[^>]*>(?:\s*(?:<[^>]+>\s*)*)?([^<]+))/i)
    const trigger = triggerMatch?.[1]?.replace(/[{}"'`]/g, '').trim() ?? 'unknown'

    // Extract title
    const titleMatch = dialogContent.match(/<(?:DialogTitle|ModalTitle)[^>]*>([^<]+)/i)
    const title = titleMatch?.[1]?.trim()

    // Extract form fields inside dialog
    const fields = extractFormsFromBlock(dialogContent)

    // Extract submit button text
    const submitMatch = dialogContent.match(/<(?:Button|button)[^>]*type=["']submit["'][^>]*>(?:\s*(?:<[^>]+>\s*)*)?([^<]+)/i)
      ?? dialogContent.match(/<(?:Button|button)[^>]*>(?:\s*(?:<[^>]+>\s*)*)?([^<]*(?:Save|Create|Add|Submit|Confirm|Update|Delete)[^<]*)/i)
    let submit_text = submitMatch?.[1]?.replace(/[{}"'`]/g, '').trim()
    if (submit_text) {
      const ternary = submit_text.match(/\?\s*['"`]?([^'"`]+)['"`]?\s*:\s*['"`]?([^'"`]+)['"`]?/)
      if (ternary) submit_text = ternary[2]?.trim()
    }

    dialogs.push({
      trigger,
      title,
      fields: fields.length > 0 ? fields[0] : [],
      submit_text,
    })
  }

  return dialogs
}

function extractNavigationFlows(content: string): Array<{ trigger: string; destination: string }> {
  const flows: Array<{ trigger: string; destination: string }> = []
  const seen = new Set<string>()

  // <Link to="/path">text</Link> — prefer these (have trigger text)
  for (const m of content.matchAll(/<Link[^>]*to=\{?['"`]([^'"`]+)['"`]}?[^>]*>(?:\s*(?:<[^>]+>\s*)*)?([^<]*)/g)) {
    const dest = m[1]
    const trigger = m[2]?.trim()
    if (trigger && trigger.length > 1 && !seen.has(dest)) {
      seen.add(dest)
      flows.push({ trigger, destination: dest })
    }
  }

  // navigate('/path') — only if not already covered by Link
  for (const m of content.matchAll(/navigate\(\s*(?:['"`]([^'"`]+)['"`]|`([^`]+)`)/g)) {
    const dest = m[1] ?? m[2]
    if (dest && !seen.has(dest) && !dest.includes('${')) {
      seen.add(dest)
      flows.push({ trigger: 'navigation', destination: dest })
    }
  }

  return flows
}

function extractDataDisplay(content: string): string[] {
  const displays: string[] = []

  // Heading texts: <h1>..., <h2>..., <h3>...
  for (const m of content.matchAll(/<h[1-6][^>]*>\s*(?:<[^>]+>)*\s*([^<{]+)/g)) {
    const text = m[1].trim()
    if (text.length > 2 && text.length < 60) displays.push(text)
  }

  // Stat/metric labels: <p ...>text</p> patterns near numbers
  for (const m of content.matchAll(/<p[^>]*>\s*([A-Z][^<]{3,30})\s*<\/p>/g)) {
    const text = m[1].trim()
    if (!text.includes('{') && text.length < 40) displays.push(text)
  }

  // Empty state messages
  for (const m of content.matchAll(/(?:No\s+\w+\s+yet|empty|nothing\s+here|get\s+started)/gi)) {
    displays.push(`empty-state: ${m[0]}`)
  }

  return [...new Set(displays)]
}

function extractStateVars(content: string): string[] {
  const vars: string[] = []

  // useState hooks
  for (const m of content.matchAll(/const\s*\[\s*(\w+)\s*,\s*set(\w+)\s*\]\s*=\s*useState/g)) {
    vars.push(m[1])
  }

  return vars
}

// ─── Form extraction (reused for both top-level and dialog) ───────────

function extractForms(content: string): FormField[][] {
  const forms: FormField[][] = []

  const currentForm: FormField[] = []

  // Build a map of labels: look for <Label>Text</Label> and associate with the next input
  const labelPositions: Array<{ text: string; index: number }> = []
  for (const m of content.matchAll(/<Label[^>]*>([^<]+)<\/Label>/gi)) {
    labelPositions.push({ text: m[1].trim(), index: m.index! + m[0].length })
  }

  function findNearbyLabel(inputIndex: number): string | undefined {
    // Find the closest label that appears BEFORE this input (within 300 chars)
    for (let i = labelPositions.length - 1; i >= 0; i--) {
      const label = labelPositions[i]
      if (label.index < inputIndex && inputIndex - label.index < 300) {
        return label.text
      }
    }
    return undefined
  }

  // Match JSX self-closing tags: <Input ... /> or <input ... />
  for (const input of content.matchAll(/<[Ii]nput\b[\s\S]*?\/>/g)) {
    const field = parseInputTag(input[0])
    if (field) {
      if (!field.label) field.label = findNearbyLabel(input.index!)
      currentForm.push(field)
    }
  }

  // Also match HTML-style: <input ... > (no self-close)
  for (const input of content.matchAll(/<input\b[^]*?(?<!=)>/gi)) {
    const field = parseInputTag(input[0])
    if (field && !currentForm.some(f => f.name === field.name && f.type === field.type)) {
      if (!field.label) field.label = findNearbyLabel(input.index!)
      currentForm.push(field)
    }
  }

  if (currentForm.length > 0) forms.push(currentForm)

  const jsxFields = extractJsxFormFields(content)
  if (jsxFields.length > 0 && currentForm.length === 0) {
    forms.push(jsxFields)
  }

  const zodFields = extractZodValidations(content)
  if (zodFields.length > 0) {
    forms.push(zodFields)
  }

  return forms
}

function extractFormsFromBlock(block: string): FormField[][] {
  const forms: FormField[][] = []
  const fields: FormField[] = []

  // JSX self-closing: <Input ... />
  for (const input of block.matchAll(/<[Ii]nput\b[\s\S]*?\/>/g)) {
    const field = parseInputTag(input[0])
    if (field) fields.push(field)
  }

  // HTML-style: <input ... >
  for (const input of block.matchAll(/<input\b[^]*?(?<!=)>/gi)) {
    const field = parseInputTag(input[0])
    if (field && !fields.some(f => f.name === field.name)) fields.push(field)
  }

  // Textarea fields (also handle JSX self-closing)
  for (const m of block.matchAll(/<[Tt]extarea\b[\s\S]*?(?:\/>|<\/[Tt]extarea>)/g)) {
    const tag = m[0]
    const phMatch = tag.match(/placeholder=['"]([^'"]+)['"]/)
    fields.push({
      name: phMatch?.[1]?.replace(/\s+/g, '_').toLowerCase().slice(0, 20) ?? 'textarea',
      type: 'textarea',
      required: /required/.test(tag),
      validations: [],
      placeholder: phMatch?.[1],
    })
  }

  if (fields.length > 0) forms.push(fields)
  return forms
}

function parseInputTag(tag: string): FormField | null {
  const nameMatch     = tag.match(/name=['"]([^'"]+)['"]/)
  const idMatch       = tag.match(/id=['"]([^'"]+)['"]/)
  const typeMatch     = tag.match(/type=['"]([^'"]+)['"]/)
  const requiredMatch = /required/.test(tag)
  const minMatch      = tag.match(/min(?:Length)?=[{'"]+(\d+)[}'"]*/)
  const maxMatch      = tag.match(/max(?:Length)?=[{'"]+(\d+)[}'"]*/)
  const patternMatch  = tag.match(/pattern=['"]([^'"]+)['"]/)
  const placeholderMatch = tag.match(/placeholder=['"]([^'"]+)['"]/)

  const jsxTypeMatch = !typeMatch ? tag.match(/type=\{[^}]*['"](\w+)['"][^}]*\}/) : null

  const identifier = nameMatch?.[1] ?? idMatch?.[1]
  // Accept fields with placeholder even if they have no name/id/type
  if (!identifier && !typeMatch && !jsxTypeMatch && !placeholderMatch) return null

  const resolvedType = resolveFieldType(
    typeMatch?.[1],
    jsxTypeMatch?.[0],
    identifier,
    placeholderMatch?.[1]
  )

  const validations: Validation[] = []
  if (minMatch)     validations.push({ type: 'minLength', value: parseInt(minMatch[1]) })
  if (maxMatch)     validations.push({ type: 'maxLength', value: parseInt(maxMatch[1]) })
  if (patternMatch) validations.push({ type: 'pattern', value: patternMatch[1] })
  if (resolvedType === 'email') validations.push({ type: 'email' })
  if (resolvedType === 'url')   validations.push({ type: 'url' })

  // Extract label from nearby Label element
  const labelMatch = tag.match(/aria-label=['"]([^'"]+)['"]/)

  const placeholderName = placeholderMatch?.[1]?.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase().slice(0, 30)
  return {
    name: nameMatch?.[1] ?? idMatch?.[1] ?? placeholderName ?? 'unknown',
    type: resolvedType,
    required: requiredMatch,
    validations,
    id: idMatch?.[1],
    placeholder: placeholderMatch?.[1],
    label: labelMatch?.[1],
  }
}

function resolveFieldType(
  quotedType: string | undefined,
  jsxExpr: string | undefined,
  identifier: string | undefined,
  placeholder: string | undefined
): string {
  if (quotedType) return quotedType

  if (jsxExpr) {
    if (/password/i.test(jsxExpr)) return 'password'
    if (/email/i.test(jsxExpr)) return 'email'
    if (/number/i.test(jsxExpr)) return 'number'
  }

  const id = identifier?.toLowerCase() ?? ''
  if (id.includes('password') || id.includes('passwd')) return 'password'
  if (id.includes('email'))    return 'email'
  if (id.includes('phone') || id.includes('tel')) return 'tel'
  if (id.includes('url') || id.includes('website')) return 'url'

  if (placeholder?.includes('@')) return 'email'

  return 'text'
}

function extractJsxFormFields(content: string): FormField[] {
  const fields: FormField[] = []

  const formIndicators = /\bonSubmit\b/.test(content) || /handleSubmit/.test(content)
  if (!formIndicators) return fields

  const idTypePattern = /id=['"](\w+)['"][^>]*type=['"](\w+)['"]|type=['"](\w+)['"][^>]*id=['"](\w+)['"]/g
  const seen = new Set<string>()

  for (const match of content.matchAll(idTypePattern)) {
    const id = match[1] ?? match[4]
    const type = match[2] ?? match[3]
    if (seen.has(id)) continue
    seen.add(id)

    if (['submit', 'button', 'hidden', 'checkbox', 'radio'].includes(type)) continue

    const requiredCheck = new RegExp(`id=['"]${id}['"][^>]*required`)
    const minLengthMatch = content.match(new RegExp(`id=['"]${id}['"][^>]*minLength=[{]?(\\d+)`))

    const validations: Validation[] = []
    if (type === 'email') validations.push({ type: 'email' })
    if (type === 'url') validations.push({ type: 'url' })
    if (minLengthMatch) validations.push({ type: 'minLength', value: parseInt(minLengthMatch[1]) })

    const labelMatch = content.match(new RegExp(`<Label[^>]*htmlFor=['"]${id}['"][^>]*>([^<]+)</Label>`, 'i'))
      ?? content.match(new RegExp(`<label[^>]*htmlFor=['"]${id}['"][^>]*>([^<]+)</label>`, 'i'))
    const placeholderMatch = content.match(new RegExp(`id=['"]${id}['"][^>]*placeholder=['"]([^'"]+)['"]`))
      ?? content.match(new RegExp(`placeholder=['"]([^'"]+)['"][^>]*id=['"]${id}['"]`))

    fields.push({
      name: id,
      type,
      required: requiredCheck.test(content),
      validations,
      id,
      label: labelMatch?.[1]?.trim(),
      placeholder: placeholderMatch?.[1],
    })
  }

  return fields
}

function extractZodValidations(content: string): FormField[] {
  const fields: FormField[] = []

  const zodObjectMatch = content.match(/z\.object\(\{([^}]+)\}\)/)
  if (!zodObjectMatch) return fields

  const body = zodObjectMatch[1]

  const fieldPattern = /(\w+):\s*z\.(string|number|boolean|array)[^,\n]*/g
  const matches = body.matchAll(fieldPattern)

  for (const match of matches) {
    const fieldName = match[1]
    const definition = match[0]
    const validations: Validation[] = []

    if (/\.email\(\)/.test(definition))      validations.push({ type: 'email' })
    if (/\.url\(\)/.test(definition))        validations.push({ type: 'url' })
    const minMatch = definition.match(/\.min\((\d+)\)/)
    const maxMatch = definition.match(/\.max\((\d+)\)/)
    if (minMatch) validations.push({ type: 'minLength', value: parseInt(minMatch[1]) })
    if (maxMatch) validations.push({ type: 'maxLength', value: parseInt(maxMatch[1]) })

    fields.push({
      name: fieldName,
      type: /\.email\(\)/.test(definition) ? 'email' : 'text',
      required: !definition.includes('.optional()'),
      validations,
    })
  }

  return fields
}

function extractApiCalls(content: string): string[] {
  const calls: string[] = []

  const fetchPattern  = /fetch\(['"`]([^'"`]+)['"`][^)]*,?\s*\{[^}]*method:\s*['"](\w+)['"]/g
  const axiosPattern  = /axios\.(get|post|put|delete|patch)\(['"`]([^'"`]+)['"`]/g
  const fetchSimple   = /fetch\(['"`](\/api\/[^'"`]+)['"`]\)/g

  for (const match of content.matchAll(fetchPattern)) {
    calls.push(`${match[2].toUpperCase()} ${match[1]}`)
  }
  for (const match of content.matchAll(axiosPattern)) {
    calls.push(`${match[1].toUpperCase()} ${match[2]}`)
  }
  for (const match of content.matchAll(fetchSimple)) {
    calls.push(`GET ${match[1]}`)
  }

  // Also capture hook-based API calls: useClients, useCreateClient, etc.
  for (const m of content.matchAll(/use(\w+)\(\)/g)) {
    const hookName = m[1]
    if (/^(Create|Update|Delete|Fetch|Get|List|Add|Remove|Post|Put|Patch)/.test(hookName)) {
      calls.push(`HOOK: ${hookName}`)
    }
  }

  return [...new Set(calls)]
}

