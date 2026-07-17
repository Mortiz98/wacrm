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

interface GymContactRow {
  phone: string
  name?: string
  email?: string
  plan?: string
  fecha_vencimiento?: string
}

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
  if (!body || !Array.isArray(body.contacts)) {
    return NextResponse.json({ error: 'Expected { contacts: [...] }' }, { status: 400 })
  }

  const rows = body.contacts as GymContactRow[]
  if (rows.length === 0) {
    return NextResponse.json({ error: 'No contacts provided' }, { status: 400 })
  }

  const admin = supabaseAdmin()
  const userId = user.id

  const customFieldIds = await ensureCustomFields(admin, accountId, userId, [
    'plan_mensualidad',
    'fecha_vencimiento',
  ])
  const planFieldId = customFieldIds.get('plan_mensualidad')!
  const fechaFieldId = customFieldIds.get('fecha_vencimiento')!

  const { byPhone: existingContactByPhone } = await fetchExistingContacts(admin, accountId)

  let imported = 0
  let updated = 0
  let failed = 0
  const customValues: { contact_id: string; custom_field_id: string; value: string }[] = []

  for (const row of rows) {
    if (!row.phone) {
      failed++
      continue
    }

    const normalized = normalizeKey(row.phone)
    const phone = formatPhone(row.phone, defaultCountryCode)
    const existingId = existingContactByPhone.get(normalized)

    if (existingId) {
      updated++
      if (row.plan) {
        customValues.push({ contact_id: existingId, custom_field_id: planFieldId, value: row.plan })
      }
      if (row.fecha_vencimiento) {
        customValues.push({ contact_id: existingId, custom_field_id: fechaFieldId, value: row.fecha_vencimiento })
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
        if (row.plan) {
          customValues.push({ contact_id: foundId, custom_field_id: planFieldId, value: row.plan })
        }
        if (row.fecha_vencimiento) {
          customValues.push({ contact_id: foundId, custom_field_id: fechaFieldId, value: row.fecha_vencimiento })
        }
      } else {
        failed++
      }
      continue
    }

    imported++
    if (row.plan) {
      customValues.push({ contact_id: contact.id, custom_field_id: planFieldId, value: row.plan })
    }
    if (row.fecha_vencimiento) {
      customValues.push({ contact_id: contact.id, custom_field_id: fechaFieldId, value: row.fecha_vencimiento })
    }
  }

  await batchUpsertCustomValues(admin, customValues)

  return NextResponse.json({
    imported,
    updated,
    failed,
    customFields: {
      plan_mensualidad: planFieldId,
      fecha_vencimiento: fechaFieldId,
    },
  })
}
