# PHANTOM relay (Cloudflare)

Live Session first tries to connect people **directly** (peer-to-peer). Some networks don't allow
that: mobile data, providers that share one public IP between customers (CGNAT), strict office or
school Wi-Fi. For those, PHANTOM falls back to this relay. Both computers connect **out** to it, which
no router or firewall blocks, and it passes the data between them.

It's a blind pipe: everything is already encrypted with the session code (AES-256-GCM) before it
leaves PHANTOM, so the relay never sees the code, file contents or chat.

You deploy it **once**. Your users never see it or set anything up.

> **Already deployed** (26 November 2026) at `wss://phantom-relay.dimitrisdisso.workers.dev`, and
> `package.json` points to it. You only need the steps below to move it to another account.
> After changing `src/index.js`, publish it again with `npx wrangler@4 deploy` from this folder.

## Deploy (about 5 minutes, free)

1. Create a free account at <https://dash.cloudflare.com/sign-up> (no card needed for the Free plan).
2. In a terminal, from the PHANTOM folder:

   ```powershell
   cd relay
   npx wrangler@4 login
   ```

   A browser window opens: log in to Cloudflare and click **Allow**.

3. Deploy:

   ```powershell
   npx wrangler@4 deploy
   ```

   The first time, Cloudflare asks you to pick a `workers.dev` subdomain (any name). When it
   finishes it prints your relay's address, for example:

   ```
   https://phantom-relay.your-name.workers.dev
   ```

4. Check it: open that address in a browser. It should say `PHANTOM relay OK`.

5. Put it in PHANTOM: open `package.json` (in the PHANTOM folder) and set `phantomRelay` to the
   same address with **`wss://`** instead of `https://`:

   ```json
   "phantomRelay": "wss://phantom-relay.your-name.workers.dev",
   ```

6. Give everyone that updated PHANTOM folder (or rebuild the installer). Done: when the direct
   connection fails, PHANTOM uses the relay automatically. The host's Live Session window shows
   `Online … (direct + relay)` when both are available.

Test the deployed relay end to end (optional):

```powershell
node tools/relay-test.js wss://phantom-relay.your-name.workers.dev
```

## Cost

The Workers **Free** plan covers normal use: 100,000 requests per day, and 20 WebSocket messages
count as one request, so about 2 million relayed messages per day. Idle sessions cost nothing:
the relay sleeps between messages, and keep-alive pings are answered without waking it. You only
get billed if you upgrade to a paid plan yourself.

## Run it locally (for development)

```powershell
cd relay
npx wrangler@4 dev --port 8787
```

Then `node tools/relay-test.js ws://127.0.0.1:8787`, or set `PHANTOM_RELAY=ws://127.0.0.1:8787`
before `npm start`.

## How it works

`src/index.js` is a Worker plus one Durable Object per session. A session's room is named by a
32-byte topic that PHANTOM derives from the code (scrypt, separate salt). The relay can't turn the
topic back into the code. One host and up to 16 guests per room. Guests are told immediately if no
session with that code exists.
