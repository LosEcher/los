# WxPusher Callback Security Gate

WxPusher up-call remains disabled unless every gate below is satisfied.

## Enablement Gate

1. Bind `WXPUSHER_CALLBACK_HOST=127.0.0.1`; never expose the Node listener.
2. Put an authenticated reverse proxy in front of the listener. It must
   overwrite `x-los-wxpusher-proxy-secret` with an independent 32-byte secret.
3. Generate `LOS_WXPUSHER_CALLBACK_TOKEN` with at least 32 random bytes:

   ```bash
   openssl rand -hex 32
   ```

4. Configure WxPusher with the complete callback URL:

   ```text
   https://<public-host>/<proxy-prefix>/wxpusher-callback?token=<callback-token>
   ```

5. Proxy and load-balancer access logs must log the path only. Disable query
   logging such as Nginx `$args`, `$request_uri`, full request URLs, and
   equivalent fields in managed load balancers.
6. APM, tracing, error reporting, and request capture must redact or drop the
   `token` query parameter before data leaves the proxy or process.
7. Set `WXPUSHER_APP_ID` and the independent `WXPUSHER_OPERATOR_UIDS`
   allowlist. Do not reuse outbound `WXPUSHER_UIDS` as the operator allowlist.
8. Only after gates 1-7 pass, set `WXPUSHER_UPCALL_ENABLED=1`.

## Rotation Gate

Rotate `LOS_WXPUSHER_CALLBACK_TOKEN` and `WXPUSHER_CALLBACK_PROXY_SECRET`:

- immediately after suspected exposure or accidental query logging;
- when proxy, operator, or observability access changes;
- on the deployment's scheduled credential rotation cadence.

Stop inbound processing during rotation, replace both secrets, update the full
WxPusher callback URL, restart the bot, and verify rejected old-token requests
before re-enabling traffic. Never print either secret while locating config;
search variable names only:

```bash
rg -l '^(LOS_WXPUSHER_CALLBACK_TOKEN|WXPUSHER_CALLBACK_PROXY_SECRET)=' \
  .env ~/.los/config.yaml /etc/los/config.yaml 2>/dev/null
```
