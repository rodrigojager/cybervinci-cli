# Provider stream recovery

CyberVinci treats a provider stream that produces no events for five minutes as
stalled. Local tool execution pauses this idle check because the provider is
expected to wait for the tool result.

When the idle watchdog fires, the current provider attempt is invalidated and
interrupted. CyberVinci waits at most two seconds for stream cancellation, then
enters the normal connection retry schedule even if the provider's cancellation
promise never settles. Events arriving late from the abandoned attempt are
ignored. The TUI receives the retry status and countdown through the existing
session status event.

Connection failures and provider-idle failures continue retrying until the
request succeeds or the user interrupts it. Exponential retry delay is capped at
30 seconds unless the provider returns a valid `Retry-After` or
`Retry-After-Ms` value. Unrelated or malformed response headers do not remove
that cap.

Normal TUI prompts use the asynchronous prompt route. That route now persists
the user message before returning HTTP 204 and starts model execution only after
admission. This makes the queued message visible even when the provider is slow
or unavailable.

## Configuration

```text
CYBERVINCI_PROVIDER_IDLE_TIMEOUT_MS=300000
CYBERVINCI_PROVIDER_CANCEL_TIMEOUT_MS=2000
```

`CYBERVINCI_SESSION_CYCLE_TIMEOUT_MS` remains an optional hard upper bound for
an entire cycle. Leave it unset when recovery should continue indefinitely.
Provider-declared retry delays remain authoritative and may exceed 30 seconds.

These changes take effect only in a newly started CyberVinci process. Replacing
an executable on disk does not update an already running process.

## Side-by-side installation

The validated Windows x64 candidate is installed as
`C:\Users\Rodrigo\.cybervinci\bin\cybervinci-next.exe`.

- Command: `cybervinci-next`
- Version: `1.18.26-cybervinci.3`
- SHA-256: `4910827857B2A7D90A88DD60023A2FF73D78506ACAFB6C321CAD20C2C9905283`

The active `cybervinci.exe` and PID 27864 were not replaced, restarted, or
stopped. Consequently, that already running process does not contain this
patch. The default command can be promoted only after the process releases the
executable.
