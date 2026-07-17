import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { normalizeKey, isUniqueViolation } from '@/lib/contacts/dedupe'

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

  const body = await request.json().catch(() => null)
  if (!body || !Array.isArray(body.contacts)) {
    return NextResponse.json({ error: 'Expected { contacts: [...] }' }, { status: 400 })
  }

  const rows = body.contacts as GymContactRow[]
  if (rows.length === 0) {
    return NextResponse.json({ error: 'No contacts provided' }, { status: 400 })
  }

  const admin = supabaseAdmin()

  // Ensure custom fields exist: "plan_mensualidad" and "fecha_vencimiento"
  const { data: existingFields } = await admin
    .from('custom_fields')
    .select('id, field_name')
    .eq('account_id', accountId)

  const fieldMap = new Map<string, string>()
  for (const f of existingFields ?? []) {
    fieldMap.set(f.field_name, f.id)
  }

  const userId = user.id

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

  const planFieldId = await ensureField('plan_mensualidad')
  const fechaFieldId = await ensureField('fecha_vencimiento')

  // Fetch existing phones to skip duplicates
  const { data: existingContacts } = await admin
    .from('contacts')
    .select('id, phone_normalized')
    .eq('account_id', accountId)

  const existingPhones = new Set(
    (existingContacts ?? [])
      .map((c: { phone_normalized: string | null }) => c.phone_normalized)
      .filter((p): p is string => !!p)
  )

  let imported = 0
  let skipped = 0
  let failed = 0
  const customValues: { contact_id: string; custom_field_id: string; value: string }[] = []

  for (const row of rows) {
    if (!row.phone) {
      failed++
      continue
    }

    const normalized = normalizeKey(row.phone)
    if (existingPhones.has(normalized)) {
      skipped++
      continue
    }

    // Ensure E.164 format
    let phone = row.phone.trim()
    if (!phone.startsWith('+')) {
      // Assume Colombia if no country code
      phone = '+57' + phone.replace(/^0+/, '')
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
      if (isUniqueViolation(error)) {
        skipped++
      } else {
        failed++
      }
      continue
    }

    imported++

    if (row.plan) {
      customValues.push({
        contact_id: contact.id,
        custom_field_id: planFieldId,
        value: row.plan,
      })
    }
    if (row.fecha_vencimiento) {
      customValues.push({
        contact_id: contact.id,
        custom_field_id: fechaFieldId,
        value: row.fecha_vencimiento,
      })
    }
  }

  // Batch insert custom values
  if (customValues.length > 0) {
    const chunkSize = 50
    for (let i = 0; i < customValues.length; i += chunkSize) {
      const chunk = customValues.slice(i, i + chunkSize)
      await admin.from('contact_custom_values').insert(chunk)
    }
  }

  return NextResponse.json({
    imported,
    skipped,
    failed,
    customFields: {
      plan_mensualidad: planFieldId,
      fecha_vencimiento: fechaFieldId,
    },
  })
}
