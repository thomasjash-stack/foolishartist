[README.md](https://github.com/user-attachments/files/32290094/README.md)
# Bright Legal estimates on Cloudflare

One Worker serves both builds of the tool and stores every estimate in a D1 table.

```
/                  public tool, for the website
/internal          fee earner tool, put Cloudflare Access in front of it
/api/estimate      POST endpoint, saves to D1 and hands public ones to Zapier
```

Why a Worker and not Pages: Cloudflare now recommends Workers with static assets for
new projects, and Pages receives only bug fixes. A Worker also lets the site and the
API live in one deployment, which Pages cannot do without bolting a second thing on.

---

## 1. Prerequisites

- brightlegal.co.uk already on the Cloudflare account (it is, if Cloudflare is doing DNS)
- Node 18 or newer on the machine doing the deploy

```bash
cd bright-estimates
npm install --save-dev wrangler
npx wrangler login
```

## 2. Create the database

```bash
npx wrangler d1 create bright-estimates
```

It prints a `database_id`. Paste it into `wrangler.jsonc`, replacing
`PASTE_DATABASE_ID_HERE`. Then create the table:

```bash
npx wrangler d1 execute bright-estimates --remote --file=./schema.sql
```

Check it worked:

```bash
npx wrangler d1 execute bright-estimates --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table';"
```

## 3. Turnstile, so bots cannot spam you

Dashboard, Turnstile, add a widget for `estimates.brightlegal.co.uk`. You get a
**site key** (public, goes in the page) and a **secret key** (stays server side).

```bash
npx wrangler secret put TURNSTILE_SECRET
```

Until the site key is added to the public build the Worker lets requests through,
so nothing breaks while this is being set up.

## 4. Deploy

```bash
npx wrangler deploy
```

First deploy without the `routes` block if the DNS record does not exist yet. You
get a `bright-estimates.<subdomain>.workers.dev` URL to test against. Then add the
`estimates` DNS record, put the `routes` block back, and deploy again.

Check the endpoint is alive:

```bash
curl -X POST https://estimates.brightlegal.co.uk/api/estimate \
  -H 'Content-Type: application/json' \
  -d '{"mode":"internal","reference":"TEST-1","matter":{"type":"Sale"},"figures":{"net":1,"vat":0.2,"total":1.2}}'
```

Then confirm the row landed:

```bash
npx wrangler d1 execute bright-estimates --remote \
  --command "SELECT id, created_at, mode, matter_type, total FROM estimates ORDER BY created_at DESC LIMIT 5;"
```

Delete the test row when you are happy:

```bash
npx wrangler d1 execute bright-estimates --remote \
  --command "DELETE FROM estimates WHERE id = 'TEST-1';"
```

## 5. Lock down /internal

Zero Trust, Access, Applications, Add an application, Self-hosted.

- Application domain: `estimates.brightlegal.co.uk`, path `internal`
- Policy: Allow, with a rule of **Emails ending in** `@brightlegal.co.uk`
  (add `@wplegal.co.uk` if W&P staff need it)
- Identity provider: Microsoft Entra ID if it is connected, otherwise One-time PIN,
  which emails a code and needs no setup

Free for up to 50 users. Test it in a private window: `/internal` should challenge
you, `/` should not.

## 6. Connect Zapier

Create the Zap, trigger **Webhooks by Zapier, Catch Hook**, copy the URL, then:

```bash
npx wrangler secret put ZAPIER_HOOK
npx wrangler deploy
```

The Worker posts to Zapier server to server, so the CORS problem that stops a
browser posting to a catch hook does not arise. The hook URL never appears in
page source.

In the Zap, after the trigger:
1. **Microsoft Outlook, Send Email**, Send From the shared mailbox, To `client.email`
2. A second Send Email to tom.ash@wplegal.co.uk
3. Optionally a SharePoint or Excel step, though D1 is already the record

## 7. Embed in Elementor

Do not paste the HTML into an Elementor widget. Use an HTML widget containing:

```html
<iframe src="https://estimates.brightlegal.co.uk/"
        title="Conveyancing estimate"
        style="width:100%;border:0;min-height:1100px"
        loading="lazy"></iframe>
```

The iframe keeps the theme CSS out of the estimate document, which matters because
the document is laid out to exact A4 measurements.

---

## Reading the data

```bash
# everything this month
npx wrangler d1 execute bright-estimates --remote --command \
  "SELECT created_at, matter_type, first_name, last_name, email, total
   FROM estimates WHERE created_at >= date('now','start of month') ORDER BY created_at DESC;"

# average estimate by matter type
npx wrangler d1 execute bright-estimates --remote --command \
  "SELECT matter_type, COUNT(*) n, ROUND(AVG(total),2) avg_total FROM estimates GROUP BY matter_type;"

# every time a fee earner overrode the scale fee, and why
npx wrangler d1 execute bright-estimates --remote --command \
  "SELECT created_at, fee_earner, matter_ref, scale_fee, override_fee, override_reason
   FROM estimates WHERE override_fee IS NOT NULL ORDER BY created_at DESC;"

# public estimates that never got emailed, worth investigating
npx wrangler d1 execute bright-estimates --remote --command \
  "SELECT id, created_at, email FROM estimates WHERE mode='public' AND emailed_at IS NULL;"
```

Add `--json` to any of these to pipe the output somewhere else.

## Data protection

The table holds client names, email addresses, phone numbers, property addresses
and property values. That is personal data under UK GDPR, so before it goes live:

- agree a retention period and schedule a deletion query, for example
  `DELETE FROM estimates WHERE created_at < date('now','-24 months');`
- add the tool to the firm's record of processing activities
- the website privacy notice needs to cover what happens to a submitted estimate
- the Worker deliberately stores only the visitor's country, never the full IP

## Costs

Workers free tier covers 100,000 requests a day and static assets are unbilled.
D1 free tier covers far more reads and writes than a fee estimate tool will
generate. Access is free to 50 users. Turnstile is free. Expect this to cost
nothing unless volumes get serious.
