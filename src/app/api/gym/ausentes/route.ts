import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sanitizePhoneForMeta, isValidE164, phoneVariants, isRecipientNotAllowedError } from '@/lib/whatsapp/phone-utils'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import type { TemplateButton } from '@/types'

export const maxDuration = 60

const TEMPLATE_NAME = 'ausente_promo_90k'
const TEMPLATE_LANGUAGE = 'es_MX'
const ABSENT_DAYS = 30

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret')
  if (supplied !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()

  // Find the "fecha_vencimiento" custom field across all accounts
  const { data: fechaFields, error: fieldErr } = await admin
    .from('custom_fields')
    .select('id, account_id')
    .eq('field_name', 'fecha_vencimiento')

  if (fieldErr) return NextResponse.json({ error: fieldErr.message }, { status: 500 })
  if (!fechaFields || fechaFields.length === 0) {
    return NextResponse.json({ sent: 0, skipped: 0, failed: 0, reason: 'no fecha_vencimiento field found' })
  }

  // Calculate cutoff date: today - 30 days in Colombia timezone (UTC-5)
  // Dates are stored as YYYY-MM-DD so string comparison works chronologically
  const colombiaTime = new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' })
  const colombiaDate = new Date(colombiaTime)
  colombiaDate.setDate(colombiaDate.getDate() - ABSENT_DAYS)
  const cutoffStr = colombiaDate.toISOString().slice(0, 10) // YYYY-MM-DD

  let sent = 0
  let skipped = 0
  let failed = 0

  for (const fechaField of fechaFields) {
    const accountId = fechaField.account_id
    const fechaFieldId = fechaField.id

    // Find contacts whose fecha_vencimiento is older than 30 days
    const { data: customValues, error: cvErr } = await admin
      .from('contact_custom_values')
      .select('contact_id, value')
      .eq('custom_field_id', fechaFieldId)
      .lt('value', cutoffStr)
      .like('value', '____-__-__')

    if (cvErr || !customValues || customValues.length === 0) continue

    // Filter to only valid date values (YYYY-MM-DD) to avoid sending to
    // contacts with non-date values like "N/A", empty strings, etc.
    const validDateRegex = /^\d{4}-\d{2}-\d{2}$/
    const datedValues = customValues.filter((cv) => validDateRegex.test(cv.value))
    if (datedValues.length === 0) continue

    // Get WhatsApp config for this account
    const { data: config, error: configErr } = await admin
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configErr || !config) {
      console.error('[gym-ausentes] no WhatsApp config for account', accountId)
      skipped += datedValues.length
      continue
    }

    const accessToken = decrypt(config.access_token)

    // Get the template row (includes button definitions)
    const { data: templateRow } = await admin
      .from('message_templates')
      .select('*')
      .eq('account_id', accountId)
      .eq('name', TEMPLATE_NAME)
      .eq('language', TEMPLATE_LANGUAGE)
      .maybeSingle()

    if (!templateRow) {
      console.error('[gym-ausentes] template not found in DB:', TEMPLATE_NAME, TEMPLATE_LANGUAGE)
      skipped += datedValues.length
      continue
    }

    // Resolve the audit user for this account (used for conversation creation)
    let auditUserId: string
    try {
      auditUserId = await resolveAuditUserId(admin, accountId)
    } catch (err) {
      console.error('[gym-ausentes] cannot resolve audit user for account', accountId, err)
      skipped += datedValues.length
      continue
    }

    const contactIds = datedValues.map((cv) => cv.contact_id)

    // Fetch contact details
    const { data: contacts } = await admin
      .from('contacts')
      .select('id, phone, name, account_id')
      .in('id', contactIds)
      .eq('account_id', accountId)

    if (!contacts) continue

    // Check which contacts already received this template (anti-duplicate)
    const { data: alreadySent } = await admin
      .from('messages')
      .select(`
        conversation_id,
        conversations!inner ( contact_id )
      `)
      .eq('template_name', TEMPLATE_NAME)
      .in('conversations.contact_id', contactIds)

    const alreadySentContacts = new Set<string>()
    for (const m of alreadySent ?? []) {
      const c = m.conversations as unknown as { contact_id: string }
      if (c?.contact_id) alreadySentContacts.add(c.contact_id)
    }

    async function sendToContact(contact: { id: string; phone: string; name: string | null }): Promise<'sent' | 'skipped' | 'failed'> {
      if (alreadySentContacts.has(contact.id)) return 'skipped'

      let phone = contact.phone
      if (!phone.startsWith('+')) {
        if (phone.startsWith('57')) {
          phone = '+' + phone
        } else {
          phone = '+57' + phone
        }
      }

      const sanitized = sanitizePhoneForMeta(phone)
      if (!isValidE164(sanitized)) {
        console.error('[gym-ausentes] invalid phone', phone)
        return 'failed'
      }

      const contactName = contact.name || ''
      const params = [contactName]
      const variants = phoneVariants(sanitized)

      for (const v of variants) {
        try {
          const result = await sendTemplateMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: v,
            templateName: TEMPLATE_NAME,
            language: TEMPLATE_LANGUAGE,
            params,
            template: templateRow,
          })

          const { data: conv } = await admin
            .from('conversations')
            .select('id')
            .eq('contact_id', contact.id)
            .eq('account_id', accountId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()

          let conversationId = conv?.id

          if (!conversationId) {
            const { data: newConv } = await admin
              .from('conversations')
              .insert({
                account_id: accountId,
                user_id: auditUserId,
                contact_id: contact.id,
              })
              .select('id')
              .single()
            if (newConv) conversationId = newConv.id
          }

          if (conversationId) {
            const previewText = templateRow.body_text.replace(/\{\{1\}\}/g, contactName)

            const interactivePayload = templateRow.buttons?.length
              ? {
                  kind: 'buttons' as const,
                  body: previewText,
                  buttons: templateRow.buttons.map((btn: TemplateButton, idx: number) => ({
                    id: `btn_${idx}`,
                    title: btn.text,
                  })),
                }
              : undefined

            const { error: msgErr } = await admin.from('messages').insert({
              conversation_id: conversationId,
              sender_type: 'bot',
              content_type: 'template',
              content_text: previewText,
              template_name: TEMPLATE_NAME,
              interactive_payload: interactivePayload,
              message_id: result.messageId,
              status: 'sent',
            })

            if (msgErr) {
              console.error('[gym-ausentes] message insert error:', msgErr.message)
              continue
            }

            await admin
              .from('conversations')
              .update({
                last_message_text: previewText,
                last_message_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq('id', conversationId)

            return 'sent'
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (!isRecipientNotAllowedError(msg)) break
        }
      }

      return 'failed'
    }

    // Process contacts in parallel batches of 5
    const batchSize = 5
    for (let i = 0; i < contacts.length; i += batchSize) {
      const batch = contacts.slice(i, i + batchSize)
      const results = await Promise.all(batch.map(sendToContact))
      for (const r of results) {
        if (r === 'sent') sent++
        else if (r === 'skipped') skipped++
        else failed++
      }
    }
  }

  return NextResponse.json({ sent, skipped, failed, cutoff: cutoffStr })
}
