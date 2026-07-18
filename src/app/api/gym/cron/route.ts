import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sanitizePhoneForMeta, isValidE164, phoneVariants, isRecipientNotAllowedError } from '@/lib/whatsapp/phone-utils'

export const maxDuration = 60

const TEMPLATE_NAME = 'recordatorio_vencimiento'
const TEMPLATE_LANGUAGE = 'es_MX'

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
    return NextResponse.json({ sent: 0, reason: 'no fecha_vencimiento field found' })
  }

  // Find the "plan_mensualidad" custom field across all accounts
  const { data: planFields } = await admin
    .from('custom_fields')
    .select('id, account_id')
    .eq('field_name', 'plan_mensualidad')

  const planFieldByAccount = new Map<string, string>()
  for (const pf of planFields ?? []) {
    planFieldByAccount.set(pf.account_id, pf.id)
  }

  // Calculate tomorrow's date
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = tomorrow.toISOString().slice(0, 10) // YYYY-MM-DD

  let sent = 0
  let skipped = 0
  let failed = 0

  for (const fechaField of fechaFields) {
    const accountId = fechaField.account_id
    const fechaFieldId = fechaField.id
    const planFieldId = planFieldByAccount.get(accountId)

    // Find contacts whose fecha_vencimiento is tomorrow
    const { data: customValues, error: cvErr } = await admin
      .from('contact_custom_values')
      .select('contact_id, value')
      .eq('custom_field_id', fechaFieldId)
      .eq('value', tomorrowStr)

    if (cvErr || !customValues || customValues.length === 0) continue

    // Get WhatsApp config for this account
    const { data: config, error: configErr } = await admin
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configErr || !config) {
      console.error('[gym-cron] no WhatsApp config for account', accountId)
      skipped += customValues.length
      continue
    }

    const accessToken = decrypt(config.access_token)

    // Get plan values for these contacts
    const planByContact = new Map<string, string>()
    if (planFieldId) {
      const contactIds = customValues.map((cv) => cv.contact_id)
      const { data: planValues } = await admin
        .from('contact_custom_values')
        .select('contact_id, value')
        .eq('custom_field_id', planFieldId)
        .in('contact_id', contactIds)

      if (planValues) {
        for (const pv of planValues) {
          planByContact.set(pv.contact_id, pv.value)
        }
      }
    }

    // Fetch contact details
    const contactIds = customValues.map((cv) => cv.contact_id)
    const { data: contacts } = await admin
      .from('contacts')
      .select('id, phone, name, account_id')
      .in('id', contactIds)
      .eq('account_id', accountId)

    if (!contacts) continue

    for (const contact of contacts) {
      const phone = contact.phone
      const sanitized = sanitizePhoneForMeta(phone)
      if (!isValidE164(sanitized)) {
        console.error('[gym-cron] invalid phone', phone)
        failed++
        continue
      }

      const contactName = contact.name || ''
      const planName = planByContact.get(contact.id) || 'tu plan'

      const params = [contactName, planName]

      const variants = phoneVariants(sanitized)
      let sentOk = false
      let lastError: unknown = null

      for (const v of variants) {
        try {
          const result = await sendTemplateMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: v,
            templateName: TEMPLATE_NAME,
            language: TEMPLATE_LANGUAGE,
            params,
          })

          // Store the sent message
          // Find or create conversation
          const { data: conv, error: convSelectErr } = await admin
            .from('conversations')
            .select('id')
            .eq('contact_id', contact.id)
            .eq('account_id', accountId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()

          if (convSelectErr) {
            console.error('[gym-cron] conversation select error:', convSelectErr.message)
          }

          let conversationId = conv?.id

          if (!conversationId) {
            const { data: newConv, error: convErr } = await admin
              .from('conversations')
              .insert({
                account_id: accountId,
                user_id: contact.account_id,
                contact_id: contact.id,
              })
              .select('id')
              .single()
            if (convErr) {
              console.error('[gym-cron] conversation insert error:', convErr.message)
            } else if (newConv) {
              conversationId = newConv.id
            }
          }

          if (conversationId) {
            const { error: msgErr } = await admin.from('messages').insert({
              conversation_id: conversationId,
              sender_type: 'bot',
              content_type: 'template',
              content_text: null,
              template_name: TEMPLATE_NAME,
              message_id: result.messageId,
              status: 'sent',
            })

            if (msgErr) {
              console.error('[gym-cron] message insert error:', msgErr.message)
            }

            const { error: convUpdateErr } = await admin
              .from('conversations')
              .update({
                last_message_text: `[template:${TEMPLATE_NAME}]`,
                last_message_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq('id', conversationId)

            if (convUpdateErr) {
              console.error('[gym-cron] conversation update error:', convUpdateErr.message)
            }
          } else {
            console.error('[gym-cron] no conversationId for contact', contact.id)
          }

          sentOk = true
          sent++
          break
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (!isRecipientNotAllowedError(msg)) {
            lastError = err
            break
          }
          lastError = err
        }
      }

      if (!sentOk) {
        failed++
        console.error('[gym-cron] send failed for', contact.id, lastError)
      }

      // Small delay to avoid rate limiting
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  return NextResponse.json({ sent, skipped, failed, date: tomorrowStr })
}
