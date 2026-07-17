import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { normalizeKey, isUniqueViolation } from '@/lib/contacts/dedupe'
import {
  parseContactCsv,
  type ParsedContactRow,
} from '@/lib/contacts/parse-contact-csv'
import {
  resolveImportTagIds,
  assignImportedContactTags,
  type ContactTagAssignment,
} from '@/lib/contacts/resolve-import-tags'

export async function POST(request: Request) {
  try {
    await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .single()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json({ error: 'No account linked' }, { status: 403 })
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body.csv !== 'string') {
    return NextResponse.json({ error: 'Expected { csv: string }' }, { status: 400 })
  }

  const { rows, customFieldColumns } = parseContactCsv(body.csv)
  if (rows.length === 0) {
    return NextResponse.json({ error: 'No valid rows found in CSV' }, { status: 400 })
  }

  const admin = supabaseAdmin()
  const userId = user.id
  const canCreateTags = body.canCreateTags ?? false

  // Ensure custom field definitions exist
  const { data: existingFields } = await admin
    .from('custom_fields')
    .select('id, field_name')
    .eq('account_id', accountId)

  const fieldMap = new Map<string, string>()
  for (const f of existingFields ?? []) {
    fieldMap.set(f.field_name, f.id)
  }

  async function ensureField(name: string): Promise<string> {
    const existing = fieldMap.get(name)
    if (existing) return existing
    const { data: created, error } = await admin
      .from('custom_fields')
      .insert({ user_id: userId, account_id: accountId, field_name: name, field_type: 'text' })
      .select('id')
      .single()
    if (error || !created) throw new Error(`Cannot create field ${name}: ${error?.message}`)
    fieldMap.set(name, created.id)
    return created.id
  }

  const customFieldIds = new Map<string, string>()
  for (const col of customFieldColumns) {
    customFieldIds.set(col, await ensureField(col))
  }

  // Fetch existing contacts by phone
  const { data: existingContacts } = await admin
    .from('contacts')
    .select('id, phone_normalized')
    .eq('account_id', accountId)

  const existingByPhone = new Map<string, string>()
  for (const c of (existingContacts ?? []) as { id: string; phone_normalized: string | null }[]) {
    if (c.phone_normalized) existingByPhone.set(c.phone_normalized, c.id)
  }

  // Resolve tags
  const allTagNames = rows.flatMap((r) => r.tagNames)
  let tagIdByKey = new Map<string, string>()
  let skippedNames: string[] = []
  if (allTagNames.length > 0) {
    ({ tagIdByKey, skippedNames } = await resolveImportTagIds(supabase, {
      accountId,
      userId,
      tagNames: allTagNames,
      canCreateTags,
    }))
  }

  let imported = 0
  let updated = 0
  let failed = 0
  let tagsAssigned = 0
  const tagAssignments: ContactTagAssignment[] = []
  const customValues: { contact_id: string; custom_field_id: string; value: string }[] = []

  for (const row of rows) {
    const normalized = normalizeKey(row.phone)
    let phone = row.phone.trim()
    if (!phone.startsWith('+')) {
      phone = '+57' + phone.replace(/^0+/, '')
    }

    const existingId = existingByPhone.get(normalized)

    if (existingId) {
      updated++
      // Update name/email if provided
      if (row.name || row.email) {
        await admin
          .from('contacts')
          .update({
            ...(row.name ? { name: row.name } : {}),
            ...(row.email ? { email: row.email } : {}),
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingId)
      }
      // Upsert custom field values
      for (const [col, val] of Object.entries(row.customFields)) {
        const fieldId = customFieldIds.get(col)
        if (fieldId) {
          customValues.push({ contact_id: existingId, custom_field_id: fieldId, value: val })
        }
      }
      if (row.tagNames.length > 0) {
        tagAssignments.push({ contactId: existingId, tagNames: row.tagNames })
      }
      continue
    }

    // New contact
    const { data: contact, error } = await admin
      .from('contacts')
      .insert({
        user_id: userId,
        account_id: accountId,
        phone,
        name: row.name || null,
        email: row.email || null,
      })
      .select('id')
      .single()

    if (error) {
      if (isUniqueViolation(error)) {
        const { data: found } = await admin
          .from('contacts')
          .select('id')
          .eq('account_id', accountId)
          .eq('phone_normalized', normalized)
          .maybeSingle()
        if (found) {
          updated++
          for (const [col, val] of Object.entries(row.customFields)) {
            const fieldId = customFieldIds.get(col)
            if (fieldId) {
              customValues.push({ contact_id: found.id, custom_field_id: fieldId, value: val })
            }
          }
          if (row.tagNames.length > 0) {
            tagAssignments.push({ contactId: found.id, tagNames: row.tagNames })
          }
        } else {
          failed++
        }
      } else {
        failed++
      }
      continue
    }

    imported++
    for (const [col, val] of Object.entries(row.customFields)) {
      const fieldId = customFieldIds.get(col)
      if (fieldId) {
        customValues.push({ contact_id: contact.id, custom_field_id: fieldId, value: val })
      }
    }
    if (row.tagNames.length > 0) {
      tagAssignments.push({ contactId: contact.id, tagNames: row.tagNames })
    }
  }

  // Batch upsert custom values
  if (customValues.length > 0) {
    const chunkSize = 50
    for (let i = 0; i < customValues.length; i += chunkSize) {
      const chunk = customValues.slice(i, i + chunkSize)
      await admin
        .from('contact_custom_values')
        .upsert(chunk, { onConflict: 'contact_id,custom_field_id' })
    }
  }

  // Assign tags
  try {
    tagsAssigned = await assignImportedContactTags(supabase, tagAssignments, tagIdByKey)
  } catch {
    // tags failure shouldn't mask a successful contact import
  }

  return NextResponse.json({
    imported,
    updated,
    failed,
    tagsAssigned,
    customFields: Object.fromEntries(customFieldIds),
  })
}
