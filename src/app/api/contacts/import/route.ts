import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  ensureCustomFields,
  fetchExistingContacts,
  formatPhone,
  batchUpsertCustomValues,
  handleUniqueViolation,
  normalizeKey,
} from '@/lib/contacts/import-utils'
import { parseContactCsv } from '@/lib/contacts/parse-contact-csv'
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

  const { data: accountRow } = await supabase
    .from('accounts')
    .select('default_country_code')
    .eq('id', accountId)
    .maybeSingle()
  const defaultCountryCode = accountRow?.default_country_code ?? '+57'

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

  const customFieldIds = await ensureCustomFields(admin, accountId, userId, customFieldColumns)
  const { byPhone: existingByPhone } = await fetchExistingContacts(admin, accountId)

  const allTagNames = rows.flatMap((r) => r.tagNames)
  let tagIdByKey = new Map<string, string>()
  if (allTagNames.length > 0) {
    ({ tagIdByKey } = await resolveImportTagIds(supabase, {
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
    const phone = formatPhone(row.phone, defaultCountryCode)
    const existingId = existingByPhone.get(normalized)

    if (existingId) {
      updated++
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
      const foundId = await handleUniqueViolation(admin, accountId, normalized)
      if (foundId) {
        updated++
        for (const [col, val] of Object.entries(row.customFields)) {
          const fieldId = customFieldIds.get(col)
          if (fieldId) {
            customValues.push({ contact_id: foundId, custom_field_id: fieldId, value: val })
          }
        }
        if (row.tagNames.length > 0) {
          tagAssignments.push({ contactId: foundId, tagNames: row.tagNames })
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

  await batchUpsertCustomValues(admin, customValues)

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
