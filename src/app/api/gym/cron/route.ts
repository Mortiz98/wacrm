import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sanitizePhoneForMeta, isValidE164, phoneVariants, isRecipientNotAllowedError } from '@/lib/whatsapp/phone-utils'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'

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

  // Calculate tomorrow's date in Colombia timezone (UTC-5)
  const colombiaTime = new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' })
  const colombiaDate = new Date(colombiaTime)
  colombiaDate.setDate(colombiaDate.getDate() + 1)
  const tomorrowStr = colombiaDate.toISOString().slice(0, 10) // YYYY-MM-DD

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

    // Get the template row (includes button definitions)
    const { data: templateRow } = await admin
      .from('message_templates')
      .select('*')
      .eq('account_id', accountId)
      .eq('name', TEMPLATE_NAME)
      .eq('language', TEMPLATE_LANGUAGE)
      .maybeSingle()

    if (!templateRow) {
      console.error('[gym-cron] template not found in DB:', TEMPLATE_NAME, TEMPLATE_LANGUAGE)
      skipped += customValues.length
      continue
    }

    // Resolve the audit user for this account (used for conversation creation)
    let auditUserId: string
    try {
      auditUserId = await resolveAuditUserId(admin, accountId)
    } catch (err) {
      console.error('[gym-cron] cannot resolve audit user for account', accountId, err)
      skipped += customValues.length
      continue
    }

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
      let phone = contact.phone

      // Ensure phone has country code for Meta API
      if (!phone.startsWith('+')) {
        // If it starts with 57, just add +
        if (phone.startsWith('57')) {
          phone = '+' + phone
        } else {
          // Otherwise assume Colombia (+57)
          phone = '+57' + phone
        }
      }

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
          console.log('[gym-cron] sending template to contact', contact.id, 'phone:', v)
          
          const result = await sendTemplateMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: v,
            templateName: TEMPLATE_NAME,
            language: TEMPLATE_LANGUAGE,
            params,
            template: templateRow,
          })
          
          console.log('[gym-cron] template sent successfully, messageId:', result.messageId)

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
            console.log('[gym-cron] creating conversation for contact', contact.id, contact.phone)
            const { data: newConv, error: convErr } = await admin
              .from('conversations')
              .insert({
                account_id: accountId,
                user_id: auditUserId,
                contact_id: contact.id,
              })
              .select('id')
              .single()
            if (convErr) {
              console.error('[gym-cron] conversation insert error:', convErr.message, convErr.details)
            } else if (newConv) {
              conversationId = newConv.id
              console.log('[gym-cron] created conversation', conversationId)
            }
          } else {
            console.log('[gym-cron] found existing conversation', conversationId)
          }

          if (conversationId) {
            console.log('[gym-cron] inserting message for contact', contact.id, contact.phone)
            
            // Build preview text from template body_text, replacing {{1}} and {{2}}
            const previewText = templateRow.body_text
              .replace(/\{\{1\}\}/g, contactName)
              .replace(/\{\{2\}\}/g, planName)

            // Build interactive payload from template buttons
            const interactivePayload = templateRow.buttons?.length
              ? {
                  kind: 'buttons' as const,
                  body: previewText,
                  buttons: templateRow.buttons.map((btn: any, idx: number) => ({
                    id: `btn_${idx}`,
                    title: btn.text,
                  })),
                }
              : undefined

            try {
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
                console.error('[gym-cron] message insert error:', msgErr.message, msgErr.details)
                // Don't count as sent if we couldn't save to DB
                continue
              }
              
              console.log('[gym-cron] message inserted successfully for contact', contact.id)

              const { error: convUpdateErr } = await admin
                .from('conversations')
                .update({
                  last_message_text: previewText,
                  last_message_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                })
                .eq('id', conversationId)

              if (convUpdateErr) {
                console.error('[gym-cron] conversation update error:', convUpdateErr.message)
              }
              
              // Only count as sent if we successfully saved to DB
              sentOk = true
              sent++
              console.log('[gym-cron] marked as sent for contact', contact.id)
              break
            } catch (dbErr) {
              console.error('[gym-cron] database error for contact', contact.id, dbErr)
              continue
            }
          } else {
            console.error('[gym-cron] no conversationId for contact', contact.id)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error('[gym-cron] Meta API error for contact', contact.id, contact.phone, 'Error:', msg)
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
