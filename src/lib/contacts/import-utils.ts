import { normalizeKey, isUniqueViolation } from '@/lib/contacts/dedupe'

export interface CustomFieldEntry {
  id: string
  field_name: string
}

export async function ensureCustomFields(
  admin: ReturnType<typeof import('@/lib/automations/admin-client').supabaseAdmin>,
  accountId: string,
  userId: string,
  fieldNames: string[]
): Promise<Map<string, string>> {
  const { data: existingFields } = await admin
    .from('custom_fields')
    .select('id, field_name')
    .eq('account_id', accountId)

  const fieldMap = new Map<string, string>()
  for (const f of (existingFields ?? []) as CustomFieldEntry[]) {
    fieldMap.set(f.field_name, f.id)
  }

  const customFieldIds = new Map<string, string>()
  for (const name of fieldNames) {
    const existing = fieldMap.get(name)
    if (existing) {
      customFieldIds.set(name, existing)
      continue
    }
    const { data: created, error } = await admin
      .from('custom_fields')
      .insert({ user_id: userId, account_id: accountId, field_name: name, field_type: 'text' })
      .select('id')
      .single()
    if (error || !created) throw new Error(`Cannot create field ${name}: ${error?.message}`)
    fieldMap.set(name, created.id)
    customFieldIds.set(name, created.id)
  }

  return customFieldIds
}

export interface ExistingContactMap {
  byPhone: Map<string, string>
}

export async function fetchExistingContacts(
  admin: ReturnType<typeof import('@/lib/automations/admin-client').supabaseAdmin>,
  accountId: string,
  pageSize = 1000
): Promise<ExistingContactMap> {
  const byPhone = new Map<string, string>()
  let offset = 0

  while (true) {
    const { data, error } = await admin
      .from('contacts')
      .select('id, phone_normalized')
      .eq('account_id', accountId)
      .order('id')
      .range(offset, offset + pageSize - 1)

    if (error || !data) break
    if (data.length === 0) break

    for (const c of data as { id: string; phone_normalized: string | null }[]) {
      if (c.phone_normalized) byPhone.set(c.phone_normalized, c.id)
    }

    if (data.length < pageSize) break
    offset += pageSize
  }

  return { byPhone }
}

export function formatPhone(phone: string, defaultCountryCode: string): string {
  const trimmed = phone.trim()
  if (trimmed.startsWith('+')) return trimmed
  return defaultCountryCode + trimmed.replace(/^0+/, '')
}

export async function batchUpsertCustomValues(
  admin: ReturnType<typeof import('@/lib/automations/admin-client').supabaseAdmin>,
  customValues: { contact_id: string; custom_field_id: string; value: string }[],
  chunkSize = 50
): Promise<void> {
  if (customValues.length === 0) return

  for (let i = 0; i < customValues.length; i += chunkSize) {
    const chunk = customValues.slice(i, i + chunkSize)
    await admin
      .from('contact_custom_values')
      .upsert(chunk, { onConflict: 'contact_id,custom_field_id' })
  }
}

export async function handleUniqueViolation(
  admin: ReturnType<typeof import('@/lib/automations/admin-client').supabaseAdmin>,
  accountId: string,
  normalized: string
): Promise<string | null> {
  const { data: found } = await admin
    .from('contacts')
    .select('id')
    .eq('account_id', accountId)
    .eq('phone_normalized', normalized)
    .maybeSingle()
  return found?.id ?? null
}

export { normalizeKey, isUniqueViolation }
