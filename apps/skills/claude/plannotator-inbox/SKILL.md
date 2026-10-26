---
name: plannotator-inbox
description: Open the Plannotator Inbox in the browser (starting it if needed) and say its address.
allowed-tools: Bash(plannotator:*)
disable-model-invocation: true
---

# Plannotator Inbox

## Inbox address

!`plannotator inbox --open`

## Your task

The output above is the Plannotator Inbox's address, and the Inbox is now open in the person's browser. Tell them the address in one sentence and stop. Do not begin any work.

If the output is an error instead, tell the person what it says. If it says `Unknown inbox option: --open`, their Plannotator is older than this command: they can update with `plannotator update`, or run `plannotator inbox` in a terminal.
