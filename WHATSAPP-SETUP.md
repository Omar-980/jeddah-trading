# WhatsApp Bot — setup guide

The WhatsApp Bot answers customers on **+220 709 3900**, shows your products, takes orders,
sends payment details and tracks deliveries. When a customer types **PERSON**, the chat moves
to **Admin → Chat** and you reply from there; your reply goes to their WhatsApp.

## 1. Test it first (no Meta account needed)

1. Deploy this version as usual (upload to GitHub → Render redeploys).
2. Open **Admin → WhatsApp Bot**. Use the phone on the left: type `hi` and place an order.
3. Test orders appear in **Orders** with a green **WhatsApp** tag and the note *TEST ORDER*.
   Set them to **Cancelled** afterwards — the stock goes back automatically.

## 2. Connect your real number (one time, ~20 minutes)

You need: your Meta Business account (the one you use for Facebook ads) and the phone with
+220 709 3900.

1. Go to **developers.facebook.com → My Apps → Create app**, choose **Business**, link it to
   your Meta Business account.
2. Add the **WhatsApp** product. In **API Setup → Add phone number**, add +220 709 3900.
   If Meta offers to keep the **WhatsApp Business app** working on the same number
   (coexistence), accept it — your phone keeps receiving the chats too.
3. Copy the **Phone number ID** → paste into Admin → WhatsApp Bot.
4. **Business Settings → Users → System users → Add**, then **Assign assets** (your app, full
   control) and **Generate token** with `whatsapp_business_messaging` and
   `whatsapp_business_management`, expiry **Never**. Paste it as the access token.
5. App **Settings → Basic → App secret** → paste it.
6. **WhatsApp → Configuration → Webhook → Edit**: paste the **Callback URL** and **Verify token**
   shown in the admin page → **Verify and save** → under webhook fields, **Subscribe** to `messages`.
7. Back in admin: **Test connection** (should show your number), tick **Assistant is on**, **Save**.
8. From another phone, send `hi` to +220 709 3900.

Make sure **Settings → Site URL** is `https://shopjeddahtrading.com` so product photos and
tracking links in WhatsApp point to your real site.

## Good to know

- **Cost:** replies to customers who message you first are free on WhatsApp's Cloud API
  (service conversations). Messages you start yourself later (e.g. marketing) use paid templates.
- **24-hour rule:** staff can reply freely for 24 hours after the customer's last message.
  After that WhatsApp blocks free-form replies; the inbox shows a warning if that happens.
- **Taking over:** in WhatsApp Bot, press **Take over** on any customer to answer them
  yourself; **Hand back to bot** (or resolving the chat) gives them back to the assistant.
- **Payment screenshots** sent after an order are attached to that order and sent to Chat.
- Secrets can also be set as Render environment variables instead of in the page:
  `WA_PHONE_NUMBER_ID`, `WA_ACCESS_TOKEN`, `WA_APP_SECRET`.
