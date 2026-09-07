# stoxvault.com — DNS records

The domain is registered at GoDaddy (nameservers `ns27/ns28.domaincontrol.com`) and is already
attached to the Vercel project `stoxvault`. Vercel is waiting on DNS; nothing else is needed on
our side.

Add these two records in **GoDaddy → My Products → stoxvault.com → DNS → Manage Zones**.

| Type | Name | Value | TTL |
|---|---|---|---|
| `A` | `@` | `76.76.21.21` | 600 |
| `CNAME` | `www` | `cname.vercel-dns.com` | 600 |

The apex has to be an `A` record: a CNAME is not allowed on the root of a domain, which is why
`@` gets an IP and only `www` gets a CNAME. Both hosts are already registered with Vercel, so the
certificate is issued automatically once the records resolve.

**Delete anything that conflicts.** GoDaddy ships a parking page, so remove any existing `A @`
record pointing elsewhere and any `CNAME www` pointing at `_domainconnect` or a parked host.
Leave MX and TXT records alone.

Propagation is usually minutes and at most a few hours. Check with:

```bash
nslookup stoxvault.com 8.8.8.8
```

You want `76.76.21.21`. Then confirm the site is actually served:

```bash
curl -sI https://stoxvault.com | head -1
```

## After it resolves

Point the site at the new home and lock the API to it:

```bash
cd server && railway variables --set "CORS_ORIGIN=https://stoxvault.com,https://www.stoxvault.com,https://stoxvault.vercel.app" && railway up
```

The Vercel URL stays working, so nothing breaks during the changeover.

## Alternative: hand the whole domain to Vercel

Instead of the two records, change the GoDaddy nameservers to `ns1.vercel-dns.com` and
`ns2.vercel-dns.com`. Vercel then manages the zone. Only do this if no email or other service
depends on the current GoDaddy DNS, because it moves every record, not just the website.
