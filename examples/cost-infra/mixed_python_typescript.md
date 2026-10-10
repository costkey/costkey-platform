# Mixed Python and TypeScript handoff

## Explicit handoff (source implemented; release caveat)

Initialize CostKey independently in both services and create the trace at the
boundary owned by each service. Both SDK source trees now expose an explicit
carrier path; verify that the installed versions export it before use.

If an application already has a trusted correlation ID, it may be copied into
both SDK contexts explicitly. That is app-owned correlation, not automatic
propagation, and it must not be forwarded to arbitrary destinations.

```text
TypeScript service                         Python service
-----------------                         -------------
withContext({ traceId: appRequestId }) ->  with_context(traceId=appRequestId)
startTrace(...)                           start_trace(...)
```

Use a non-sensitive identifier and keep the propagation allowlist in the
application protocol. `CostKey.exportContextHeaders()` provides the explicit
TypeScript request attachment. Python provides `costkey.export_context()`; the
receiving service can pass the decoded mapping to `costkey.with_context(...)`.
The SDK does not attach this header to arbitrary application requests.

## Carrier fields and release boundary

```text
SOURCE IMPLEMENTED — verify the package exports before use

carrier = CostKey.exportContext()
trustedRequest.headers = CostKey.exportContextHeaders()
python_context = costkey.with_context(decoded_carrier)
```

The carrier contains only approved trace/group/business fields, never a DSN,
provider credential, prompt, response body, or arbitrary request headers. Do
not treat source presence as a release or acceptance claim; use the exact
installed SDK versions and a trusted transport test.
