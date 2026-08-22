# Manual takeover during portal navigation

The secure browser stops before any irreversible or identity-bound step. The user completes it directly.

## Stop points

Never perform, simulate, or bypass:

- login, certificate, password, OTP, CAPTCHA, or any identity verification;
- legal declarations, attestations, waivers, or consent checkboxes;
- final filing, submission, service request, deletion, or withdrawal;
- payment, transfer, refund destination, or bank-account changes;
- executable download, security-software installation, or browser safety overrides.

When the tool returns `requires-user`, or the observed screen reaches one of these points, stop tool use.

## Handoff format

Tell the user, in order:

1. the exact action to take and on which screen;
2. what to verify before confirming: parties, amounts, dates, selected checkboxes, attached documents;
3. what proof to capture afterward: receipt number, confirmation screen, submission timestamp;
4. what to report back so the case state can advance.

## Resuming

- After the user reports completion, take a fresh `secure_computer_observe` before any further action. Never reuse a digest from before the takeover.
- If the user reports a failure or unexpected screen, observe again and explain from the new observation. Do not guess the portal state.
- If the goal is blocked or complete, close the secure browser and summarize the last verified state, the changes made, what remains unverified, and the user's next action.
